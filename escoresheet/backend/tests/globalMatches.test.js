// Tests for lib/globalMatches.js (the Global tool's opt-in cloud copy, db/046):
// the pure parts, and the HTTP routes on a server without a database.
//   cd escoresheet/backend && node --test tests/globalMatches.test.js
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { keyHash, pinHash, organizerHash, newShareToken, sanitizeSummary, decodePdf, isGlobalKey, isPin, isOrganizerCode, isShareToken, createGlobalMatches } from '../lib/globalMatches.js'
import { bootServer } from './helpers/e2eServer.js'

const KEY = 'k'.repeat(22)

describe('hashes and checks', () => {
  it('hashes key, PIN (salted with the key) and organizer code apart', () => {
    assert.match(keyHash(KEY), /^[0-9a-f]{64}$/)
    assert.notEqual(keyHash(KEY), keyHash('j'.repeat(22)))
    assert.notEqual(pinHash(KEY, '1234'), pinHash('j'.repeat(22), '1234'))
    assert.notEqual(pinHash(KEY, '1234'), pinHash(KEY, '1235'))
    assert.notEqual(organizerHash('ABCDEFGHJK'), keyHash('ABCDEFGHJK'))
  })
  it('validates key, PIN, organizer code and share token', () => {
    assert.equal(isGlobalKey(KEY), true)
    for (const k of ['short', 'x'.repeat(65), 'a b'.repeat(10), null]) assert.equal(isGlobalKey(k), false)
    for (const p of ['1234', '12345678']) assert.equal(isPin(p), true)
    for (const p of ['123', '123456789', '12a4', 1234, null]) assert.equal(isPin(p), false)
    assert.equal(isOrganizerCode('ABCDEFGHJK'), true)
    for (const c of ['ABCDEFGHJ', 'ABCDEFGHJKL', 'ABCDEFGHIK', 'abcdefghjk', 'ABCDEFGH0K']) assert.equal(isOrganizerCode(c), false)
    const t = newShareToken()
    assert.equal(t.length, 22)
    assert.equal(isShareToken(t), true)
    assert.equal(isShareToken('x'.repeat(21)), false)
  })
})

describe('sanitizeSummary', () => {
  it('keeps the listed fields only, bounded', () => {
    const s = sanitizeSummary({
      home: { name: ' Munich IS ', short: 'MUNICH-INTERNATIONAL', color: '#1d4ed8', players: ['Anna'] },
      away: { name: 'x'.repeat(200), color: 'red' },
      setsWon: { home: '2', away: -1 },
      sets: [{ home: 25, away: 20, events: [1] }, null, { home: 'a', away: 1000 }, {}, {}, {}, {}],
      status: 'hacked', hall: 'Hall 1', league: 'U18', scheduledAt: '2027-05-05T09:00:00Z', gameNumber: 12, officials: [{ lastName: 'Ref' }]
    })
    assert.deepEqual(s.home, { name: 'Munich IS', short: 'MUNICH-INTER', color: '#1d4ed8' })
    assert.equal(s.away.name.length, 80)
    assert.equal(s.away.color, null)
    assert.deepEqual(s.setsWon, { home: 2, away: 0 })
    assert.equal(s.sets.length, 5)
    assert.deepEqual(s.sets[0], { home: 25, away: 20 })
    assert.deepEqual(s.sets[1], { home: 0, away: 999 })
    assert.equal(s.status, 'scheduled')
    assert.equal(s.gameNumber, '12')
    assert.equal(JSON.stringify(s).includes('Anna'), false)
    assert.equal(JSON.stringify(s).includes('Ref'), false)
    assert.equal(sanitizeSummary(null).status, 'scheduled')
    assert.equal(sanitizeSummary({ status: 'final' }).status, 'final')
  })
})

describe('decodePdf', () => {
  it('takes a PDF, refuses anything else or too large', () => {
    assert.equal(decodePdf(undefined), null)
    assert.equal(decodePdf(null), null)
    assert.ok(Buffer.isBuffer(decodePdf(Buffer.from('%PDF-1.7 x').toString('base64'))))
    assert.equal(decodePdf(Buffer.from('<html>').toString('base64')), false)
    assert.equal(decodePdf('not base64!'), false)
    assert.equal(decodePdf(Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(3 * 1024 * 1024)]).toString('base64')), false)
  })
})

describe('createGlobalMatches input checks (no query for a bad request)', () => {
  const pool = { query: async () => { throw new Error('no query expected') } }
  const gm = createGlobalMatches({ pool })
  it('answers 400 / 404 before touching the database', async () => {
    assert.equal((await gm.save('bad', '1234', { bundle: {} })).status, 400)
    assert.equal((await gm.save(KEY, '12', { bundle: {} })).status, 400)
    assert.equal((await gm.save(KEY, '1234', { bundle: [] })).status, 400)
    assert.equal((await gm.save(KEY, '1234', { bundle: {}, organizer: 'nope' })).status, 400)
    assert.equal((await gm.save(KEY, '1234', { bundle: {}, pdf: 'aGVsbG8=' })).status, 400)
    assert.equal((await gm.load(KEY, 'x')).status, 400)
    assert.equal((await gm.shared('short')).status, 404)
    assert.equal(await gm.sharedPdf('short'), null)
    assert.equal((await gm.organizerList('bad')).status, 404)
    assert.equal(await gm.organizerPdf('ABCDEFGHJK', 'not-a-uuid'), null)
  })
  it('a match over 3 MB is refused', async () => {
    assert.equal((await gm.save(KEY, '1234', { bundle: { big: 'x'.repeat(3 * 1024 * 1024 + 1) } })).status, 413)
  })
})

describe('Global cloud routes without a database', () => {
  let srv
  before(async () => { srv = await bootServer({}, ['--local']) })
  after(async () => { await srv?.stop() })
  it('answer 503 OV_NO_CLOUD; the read routes allow any origin', async () => {
    const post = await fetch(`${srv.base}/api/global/cloud/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: KEY, pin: '1234', bundle: {} }), signal: AbortSignal.timeout(5000) })
    assert.equal(post.status, 503)
    assert.equal((await post.json()).error.code, 'OV_NO_CLOUD')
    const get = await fetch(`${srv.base}/api/global/shared/${'a'.repeat(22)}`, { signal: AbortSignal.timeout(5000) })
    assert.equal(get.status, 503)
    assert.equal(get.headers.get('access-control-allow-origin'), '*')
    const org = await fetch(`${srv.base}/api/global/organizer/ABCDEFGHJK`, { signal: AbortSignal.timeout(5000) })
    assert.equal(org.status, 503)
    const wrong = await fetch(`${srv.base}/api/global/cloud/save`, { signal: AbortSignal.timeout(5000) })
    assert.equal(wrong.status, 405)
  })
})
