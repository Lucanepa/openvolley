/**
 * lib/redactedPeople.js (db/052, data-map F27): the keyed hashes of the
 * register of people erased on request, and the sync's rows without them.
 * The names are made up.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  redactedPeopleKey, nameHash, licenceHash, displayNameHashes, personEntries, isEntry,
  createRedactedMatcher, withholdRedacted, normName, normLicence, MIN_SECRET_LENGTH
} from '../lib/redactedPeople.js'
import { transformGame } from '../lib/vmSync.js'
import { makeGame } from './helpers/fakeVolleyManager.js'

const SECRET = 'r'.repeat(40)
const KEY = redactedPeopleKey(SECRET)
const registerOf = (entries) => ({
  names: new Set(entries.filter((e) => e.kind === 'name').map((e) => e.hash)),
  licences: new Set(entries.filter((e) => e.kind === 'licence').map((e) => e.hash)),
  size: entries.length
})
const matcherFor = (people) => createRedactedMatcher(registerOf(people.flatMap((p) => personEntries(KEY, p))), KEY)

describe('redactedPeople: the keyed hashes', () => {
  it('needs OV_PIN_SECRET of at least 32 characters', () => {
    for (const s of [undefined, null, '', 'x'.repeat(MIN_SECRET_LENGTH - 1)]) {
      assert.throws(() => redactedPeopleKey(s), /OV_PIN_SECRET/)
    }
    assert.equal(redactedPeopleKey('y'.repeat(MIN_SECRET_LENGTH)).length, 32)
  })

  it('a name: the normalised first and last name, keyed; never the name itself', () => {
    const h = nameHash(KEY, 'Anna', 'Muster')
    assert.match(h, /^[0-9a-f]{64}$/)
    assert.equal(nameHash(KEY, '  anna ', 'MUSTER'), h, 'case and spaces')
    assert.equal(nameHash(KEY, 'Ané', 'Muster'), nameHash(KEY, 'Ané', 'Muster'), 'composed and decomposed accents')
    assert.notEqual(nameHash(KEY, 'Muster', 'Anna'), h, 'first and last are told apart')
    assert.notEqual(nameHash(redactedPeopleKey(SECRET + '!'), 'Anna', 'Muster'), h, 'another secret, another hash')
    assert.equal(nameHash(KEY, 'Anna', ''), null)
    assert.equal(h.includes('anna') || h.includes('muster'), false)
  })

  it('a licence: 4 to 7 digits, spaces aside; never equal to a name hash', () => {
    assert.equal(normLicence(' 51 2345 '), '512345')
    assert.equal(normLicence(512345), '512345')
    for (const v of ['123', '12345678', 'SV-1234', null, {}]) assert.equal(normLicence(v), null)
    assert.equal(licenceHash(KEY, '51 2345'), licenceHash(KEY, 512345))
    assert.equal(licenceHash(KEY, '12'), null)
    assert.notEqual(licenceHash(KEY, '512345'), nameHash(KEY, 'licence', '512345'))
  })

  it('a display name stands for every split of its words, in both orders, and only the whole of it', () => {
    const h = nameHash(KEY, 'Anna Maria', 'Muster')
    for (const d of ['Muster Anna Maria', 'Anna Maria Muster', 'Muster, Anna Maria', '  muster   ANNA maria ']) {
      assert.ok(displayNameHashes(KEY, d).includes(h), d)
    }
    assert.equal(displayNameHashes(KEY, 'Muster Anna Maria Jr').includes(h), false)
    assert.deepEqual(displayNameHashes(KEY, ''), [])
    assert.deepEqual(displayNameHashes(KEY, 'Muster'), [])
  })

  it('the entries of one person: the name and each licence number once', () => {
    const e = personEntries(KEY, { first: 'Anna', last: 'Muster', licences: ['512345', '51 2345', 'x', '623456'] })
    assert.deepEqual(e.map((x) => x.kind), ['name', 'licence', 'licence'])
    assert.ok(e.every(isEntry))
    assert.equal(JSON.stringify(e).includes('Muster') || JSON.stringify(e).includes('512345'), false)
    assert.equal(isEntry({ kind: 'name', hash: 'Muster' }), false)
    assert.equal(normName(' Anna  MUSTER '), 'anna muster')
  })
})

describe('redactedPeople: the sync leaves a registered referee empty', () => {
  const rowOf = (item) => transformGame(item, { syncedAt: new Date('2026-10-05T04:00:00Z') })

  it('an empty register needs no key and changes nothing', () => {
    const rows = [rowOf(makeGame(1))]
    const m = createRedactedMatcher({ names: new Set(), licences: new Set(), size: 0 }, null)
    const out = withholdRedacted(rows, m)
    assert.equal(out.rows, rows)
    assert.equal(out.withheld, 0)
    assert.throws(() => createRedactedMatcher(registerOf(personEntries(KEY, { first: 'Anna', last: 'Muster' })), null), /no key/)
  })

  it('by name: the 1st referee goes (names, licence, convocation), the 2nd and the line judge stay', () => {
    const row = rowOf(makeGame(5001, { sv1: '512345', ref2: true, sv2: '623456' }))
    const { rows: [r], withheld } = withholdRedacted([row], matcherFor([{ first: 'Anna', last: 'Muster' }]))
    assert.equal(withheld, 1)
    assert.deepEqual([r.referee_1, r.referee_1_first_name, r.referee_1_last_name, r.referee_1_licence], [null, null, null, null])
    assert.deepEqual([r.referee_2, r.referee_2_first_name, r.referee_2_last_name, r.referee_2_licence], ['Beispiel Ben', 'Ben', 'Beispiel', '623456'])
    assert.equal(r.linesman_1, 'Linie Lea')
    assert.deepEqual(r.convocations, [])
    assert.equal(row.referee_1, 'Muster Anna', 'the input row is not changed')
    assert.equal(r.team_home, row.team_home)
  })

  it('by licence number alone (another spelling of the name), and by display name alone (no convocation)', () => {
    const byLicence = withholdRedacted([rowOf(makeGame(5002, { sv1: '512345' }))], matcherFor([{ first: 'Ana', last: 'Musterr', licences: ['512345'] }]))
    assert.equal(byLicence.withheld, 1)
    assert.equal(byLicence.rows[0].referee_1, null)
    assert.deepEqual(byLicence.rows[0].convocations, [], 'its convocation goes with it')
    // referee 2 is a name only here (activeSecondHeadRefereeName, "Last First")
    const byDisplay = withholdRedacted([rowOf(makeGame(5003))], matcherFor([{ first: 'Ben', last: 'Beispiel' }]))
    assert.equal(byDisplay.withheld, 1)
    assert.equal(byDisplay.rows[0].referee_2, null)
    assert.equal(byDisplay.rows[0].referee_1, 'Muster Anna')
  })

  it('a registered line judge goes; a game without anyone registered is the same object', () => {
    const rows = [rowOf(makeGame(5004)), rowOf(makeGame(5005, { activeFirstLinesmanRefereeName: 'Other Olga' }))]
    const { rows: out, withheld } = withholdRedacted(rows, matcherFor([{ first: 'Lea', last: 'Linie' }]))
    assert.equal(withheld, 1)
    assert.equal(out[0].linesman_1, null)
    assert.equal(out[0].referee_1, 'Muster Anna')
    assert.equal(out[1], rows[1])
  })
})
