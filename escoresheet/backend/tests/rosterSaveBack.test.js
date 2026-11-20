// lib/rosterSaveBack.js without a database: the people of a match row, which
// schedule team each side is, the merge into a saved team, and the waiting
// (coalescing) per match. The runs against Postgres: rosterSaveBack.pg.test.js.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRosterSaveBack, licenceOf, mapSides, matchPerson, mergeMatchRoster, SAVE_BACK_MAX_WAIT_MS, SAVE_BACK_QUIET_MS } from '../lib/rosterSaveBack.js'
import { validateRoster } from '../lib/savedTeams.js'

const id = () => randomUUID()
const sq = (number, last, extra = {}) => ({ id: id(), number, first_name: 'Anna', last_name: last, license_number: null, is_libero: false, is_captain: false, active: true, ...extra })
const mp = (number, last, extra = {}) => ({ number, first_name: 'Anna', last_name: last, license_number: null, ...extra })

describe('licenceOf / matchPerson', () => {
  it('a licence is digits (spaces aside), never a date', () => {
    assert.equal(licenceOf('123456'), '123456')
    assert.equal(licenceOf(' 12 34 56 '), '123456')
    assert.equal(licenceOf(123456), '123456')
    for (const v of ['14.03.2008', '2008-03-14', '1.1.1900', 'SV 123', '', null, undefined, {}]) assert.equal(licenceOf(v), null, String(v))
    assert.equal(licenceOf('12345678901234'), '1234567890')
  })

  it('a row of the sheet: the value beside the name is the licence; an empty row is nobody', () => {
    assert.deepEqual(matchPerson({ number: '7', first_name: ' Anna ', last_name: 'Muster', dob: '123456', libero: '', is_captain: true }),
      { number: 7, first_name: 'Anna', last_name: 'Muster', license_number: '123456' })
    // a date of birth the scorer typed stays on the sheet
    assert.equal(matchPerson({ number: 3, first_name: 'A', last_name: 'B', dob: '14.03.2008' }).license_number, null)
    // an older match's own licence field
    assert.equal(matchPerson({ number: 3, last_name: 'B', licence: '4567' }).license_number, '4567')
    assert.equal(matchPerson({ number: 3, first_name: '', last_name: '' }), null)
    assert.equal(matchPerson(null), null)
    // only a first name: it is the name
    assert.deepEqual(matchPerson({ number: 3, first_name: 'Solo' }), { number: 3, first_name: '', last_name: 'Solo', license_number: null })
    assert.equal(matchPerson({ number: 100, last_name: 'B' }).number, null)
    assert.deepEqual(matchPerson({ last_name: 'x'.repeat(81) }), { invalid: true })
  })

  it('an official needs a role of the saved teams', () => {
    assert.deepEqual(matchPerson({ role: 'Coach', first_name: 'Carla', last_name: 'Coach', dob: '4321' }, { staff: true }),
      { role: 'Coach', first_name: 'Carla', last_name: 'Coach', license_number: '4321' })
    assert.deepEqual(matchPerson({ role: 'Mascot', last_name: 'X' }, { staff: true }), { invalid: true })
    assert.equal(matchPerson({ role: 'Coach', first_name: '', last_name: '' }, { staff: true }), null)
  })
})

describe('mapSides', () => {
  const schedule = { home: 'VBC Musterdorf H1', away: 'VBC Beispiel H2' }
  it('the names as the schedule has them, also swapped', () => {
    assert.deepEqual(mapSides({ home: 'VBC Musterdorf H1', away: 'VBC Beispiel H2' }, schedule), schedule)
    assert.deepEqual(mapSides({ home: 'vbc beispiel  h2', away: 'VBC MUSTERDORF H1' }, schedule), { home: 'VBC Beispiel H2', away: 'VBC Musterdorf H1' })
  })
  it('a shortened name, accents aside', () => {
    assert.deepEqual(mapSides({ home: 'Musterdorf H1', away: 'Beispiel H2' }, schedule), schedule)
    assert.deepEqual(mapSides({ home: 'VBC Müsterdorf H1', away: 'Other' }, schedule), { home: 'VBC Musterdorf H1', away: null })
  })
  it('a side no name points to is nobody; a tie is nobody', () => {
    assert.deepEqual(mapSides({ home: 'Home', away: 'Guests' }, schedule), { home: null, away: null })
    assert.deepEqual(mapSides({ home: 'VBC Musterdorf H1', away: 'VBC Musterdorf H1' }, schedule), { home: null, away: null })
    assert.deepEqual(mapSides({ home: 'A', away: 'B' }, { home: 'X', away: '' }), { home: null, away: null })
  })
})

describe('mergeMatchRoster', () => {
  const body = (m) => validateRoster({ players: m.players, staff: m.staff })

  it('the match\'s number wins: the player gets it, the one who had it loses it', () => {
    const squad = { players: [sq(7, 'Muster', { license_number: '111111' }), sq(9, 'Beispiel', { license_number: '222222' })], staff: [] }
    const m = mergeMatchRoster(squad, { players: [mp(9, 'Muster', { license_number: '111111' })], staff: [] })
    assert.equal(m.changed, true)
    assert.deepEqual(m.players.map((p) => [p.last_name, p.number]), [['Muster', 9], ['Beispiel', null]])
    assert.equal(m.counts.numbers, 1)
    assert.equal(m.counts.cleared, 1)
    assert.equal(body(m).error, undefined)
    // the ids stay: nobody is replaced
    assert.deepEqual(m.players.map((p) => p.id), squad.players.map((p) => p.id))
  })

  it('by name (accents, case, swapped first and last name) when the licence says nothing; the licence is filled in', () => {
    const squad = { players: [sq(4, 'Müller', { first_name: 'Léa' })], staff: [] }
    const m = mergeMatchRoster(squad, { players: [{ number: 5, first_name: 'MULLER', last_name: 'lea', license_number: '333333' }], staff: [] })
    assert.equal(m.players.length, 1)
    assert.equal(m.players[0].number, 5)
    assert.equal(m.players[0].license_number, '333333')
    assert.equal(m.players[0].first_name, 'Léa', 'the saved team\'s name stays')
    assert.equal(m.counts.licences, 1)
    assert.deepEqual(m.club, [{ list: 'players', sv_number: '333333', last_name: 'lea', first_name: 'MULLER' }])
  })

  it('another licence with the same name: the saved team\'s stays, counted, nothing to the club', () => {
    const squad = { players: [sq(4, 'Muster', { license_number: '111111' })], staff: [] }
    const m = mergeMatchRoster(squad, { players: [mp(6, 'Muster', { license_number: '999999' })], staff: [] })
    assert.equal(m.players.length, 1)
    assert.equal(m.players[0].license_number, '111111')
    assert.equal(m.players[0].number, 6)
    assert.equal(m.counts.conflicts, 1)
    assert.deepEqual(m.club, [])
  })

  it('new people are added without captain or libero; nobody is removed; flags stay', () => {
    const squad = { players: [sq(1, 'Captain', { is_captain: true }), sq(2, 'Libero', { is_libero: true }), sq(3, 'Away')], staff: [{ id: id(), role: 'Coach', first_name: 'C', last_name: 'Old', license_number: null }] }
    const m = mergeMatchRoster(squad, {
      players: [mp(1, 'Captain'), mp(2, 'Libero'), mp(12, 'New', { license_number: '444444' })],
      staff: [{ role: 'Assistant Coach 1', first_name: 'A', last_name: 'Assist', license_number: '5555' }, { role: 'Medic', first_name: 'M', last_name: 'Medic', license_number: '6666' }]
    })
    assert.deepEqual(m.players.map((p) => [p.last_name, p.number, p.is_captain, p.is_libero, p.active]),
      [['Captain', 1, true, false, true], ['Libero', 2, false, true, true], ['Away', 3, false, false, true], ['New', 12, false, false, true]])
    assert.deepEqual(m.staff.map((s) => [s.role, s.last_name]), [['Coach', 'Old'], ['Assistant Coach 1', 'Assist'], ['Medic', 'Medic']])
    assert.equal(m.counts.added, 3)
    // the medic is no coach: the club's coaches list gets the assistant only
    assert.deepEqual(m.club.map((c) => [c.list, c.sv_number]), [['players', '444444'], ['coaches', '5555']])
    assert.equal(body(m).error, undefined)
  })

  const st = (role, last, extra = {}) => ({ id: id(), role, first_name: 'Carla', last_name: last, license_number: null, ...extra })
  const ms = (role, last, extra = {}) => ({ role, first_name: 'Carla', last_name: last, license_number: null, ...extra })
  const roles = (m) => m.staff.map((s) => [s.last_name, s.role])

  it('the latest match: an official takes the match\'s role; the licence is filled in', () => {
    const squad = { players: [], staff: [st('Coach', 'Coach')] }
    const m = mergeMatchRoster(squad, { players: [], staff: [ms('Assistant Coach 1', 'Coach', { license_number: '7777' })] })
    assert.deepEqual(m.staff.map((s) => [s.role, s.license_number]), [['Assistant Coach 1', '7777']])
    assert.equal(m.staff[0].id, squad.staff[0].id, 'the same person, the same id')
    assert.equal(m.counts.roles, 1)
    assert.equal(m.changed, true)
    assert.equal(body(m).error, undefined)
  })

  it('an older match changes no role; its new official comes with the match\'s', () => {
    const squad = { players: [], staff: [st('Coach', 'Coach'), st('Assistant Coach 1', 'Assist')] }
    const m = mergeMatchRoster(squad, { players: [], staff: [ms('Coach', 'Assist'), ms('Medic', 'Medic')] }, { latest: false })
    assert.deepEqual(roles(m), [['Coach', 'Coach'], ['Assist', 'Assistant Coach 1'], ['Medic', 'Medic']])
    assert.equal(m.counts.roles, 0)
    assert.equal(m.counts.moved, 0)
  })

  it('the coach misses a game, the assistant stands in: the two swap; the next match swaps them back', () => {
    const squad = { players: [], staff: [st('Coach', 'Head'), st('Assistant Coach 1', 'Assist'), st('Medic', 'Medic')] }
    const m = mergeMatchRoster(squad, { players: [], staff: [ms('Coach', 'Assist'), ms('Medic', 'Medic')] })
    assert.deepEqual(roles(m), [['Head', 'Assistant Coach 1'], ['Assist', 'Coach'], ['Medic', 'Medic']])
    assert.deepEqual([m.counts.roles, m.counts.moved], [1, 1])
    assert.equal(body(m).error, undefined)
    const back = mergeMatchRoster({ players: [], staff: m.staff }, { players: [], staff: [ms('Coach', 'Head'), ms('Assistant Coach 1', 'Assist')] })
    assert.deepEqual(roles(back), [['Head', 'Coach'], ['Assist', 'Assistant Coach 1'], ['Medic', 'Medic']])
    assert.deepEqual([back.counts.roles, back.counts.moved], [2, 0])
  })

  it('a chain of moves: the one not on the match takes the role left over at its end', () => {
    const squad = { players: [], staff: [st('Coach', 'Head'), st('Assistant Coach 1', 'One'), st('Assistant Coach 2', 'Two'), st('Physiotherapist', 'Physio')] }
    const m = mergeMatchRoster(squad, { players: [], staff: [ms('Coach', 'One'), ms('Assistant Coach 1', 'Two')] })
    assert.deepEqual(roles(m), [['Head', 'Assistant Coach 2'], ['One', 'Coach'], ['Two', 'Assistant Coach 1'], ['Physio', 'Physiotherapist']])
    assert.deepEqual([m.counts.roles, m.counts.moved], [2, 1])
    // each role once, as before
    assert.equal(new Set(m.staff.map((s) => s.role)).size, m.staff.length)
  })

  it('a new official takes a role: the saved team\'s holder keeps it (nothing left over), never another role', () => {
    const squad = { players: [], staff: [st('Coach', 'Head'), st('Medic', 'Medic')] }
    const m = mergeMatchRoster(squad, { players: [], staff: [ms('Coach', 'Newcoach'), ms('Medic', 'Medic')] })
    assert.deepEqual(roles(m), [['Head', 'Coach'], ['Medic', 'Medic'], ['Newcoach', 'Coach']])
    assert.deepEqual([m.counts.added, m.counts.roles, m.counts.moved], [1, 0, 0])
    assert.equal(body(m).error, undefined, 'a saved team may name a role twice')
  })

  it('the role left over is taken already: the official keeps theirs', () => {
    // Head (Coach) is not on the match; Assist (AC1) is Coach now and a new official AC1
    const squad = { players: [], staff: [st('Coach', 'Head'), st('Assistant Coach 1', 'Assist')] }
    const m = mergeMatchRoster(squad, { players: [], staff: [ms('Coach', 'Assist'), ms('Assistant Coach 1', 'Newassist')] })
    assert.deepEqual(roles(m), [['Head', 'Coach'], ['Assist', 'Coach'], ['Newassist', 'Assistant Coach 1']])
    assert.deepEqual([m.counts.roles, m.counts.moved], [1, 0])
  })

  it('a role the match names twice: the first official takes it, the second keeps theirs', () => {
    const squad = { players: [], staff: [st('Assistant Coach 1', 'One'), st('Assistant Coach 2', 'Two')] }
    const m = mergeMatchRoster(squad, { players: [], staff: [ms('Coach', 'One'), ms('Coach', 'Two')] })
    assert.deepEqual(roles(m), [['One', 'Coach'], ['Two', 'Assistant Coach 2']])
  })

  it('the same roles as the saved team: nothing changes', () => {
    const squad = { players: [], staff: [st('Coach', 'Head', { license_number: '7001' }), st('Medic', 'Medic', { license_number: '7002' })] }
    const m = mergeMatchRoster(squad, { players: [], staff: [ms('Coach', 'Head', { license_number: '7001' })] })
    assert.equal(m.changed, false)
    assert.deepEqual(roles(m), [['Head', 'Coach'], ['Medic', 'Medic']])
  })

  it('nothing new: nothing changes', () => {
    const squad = { players: [sq(7, 'Muster', { license_number: '111111' })], staff: [] }
    const m = mergeMatchRoster(squad, { players: [mp(7, 'Muster', { license_number: '111111' })], staff: [] })
    assert.equal(m.changed, false)
  })

  it('an older match (not the latest): adds people and fills an empty number nobody has; changes no number', () => {
    const squad = { players: [sq(7, 'Muster'), sq(null, 'Empty'), sq(5, 'Holder')], staff: [] }
    const m = mergeMatchRoster(squad, { players: [mp(9, 'Muster'), mp(8, 'Empty'), mp(5, 'Late'), mp(6, 'Other')], staff: [] }, { latest: false })
    assert.deepEqual(m.players.map((p) => [p.last_name, p.number]), [['Muster', 7], ['Empty', 8], ['Holder', 5], ['Late', null], ['Other', 6]])
  })

  it('a player set inactive plays again: active (the latest match), the number of the match', () => {
    const squad = { players: [sq(4, 'Gone', { active: false }), sq(4, 'Here')], staff: [] }
    const m = mergeMatchRoster(squad, { players: [mp(11, 'Gone')], staff: [] })
    assert.deepEqual(m.players.map((p) => [p.last_name, p.number, p.active]), [['Gone', 11, true], ['Here', 4, true]])
    // no number in the match and the old one taken: none
    const m2 = mergeMatchRoster(squad, { players: [mp(null, 'Gone')], staff: [] })
    assert.deepEqual(m2.players.map((p) => [p.last_name, p.number, p.active]), [['Gone', null, true], ['Here', 4, true]])
    assert.equal(body(m2).error, undefined)
    // not when that makes a second captain
    const m3 = mergeMatchRoster({ players: [sq(4, 'Gone', { active: false, is_captain: true }), sq(5, 'Cap', { is_captain: true })], staff: [] }, { players: [mp(4, 'Gone')], staff: [] })
    assert.equal(m3.players[0].active, false)
    assert.equal(body(m3).error, undefined)
  })

  it('skips: the other gender, twice in the roster, an invalid person, more than 40 players or 10 officials', () => {
    const squad = { players: Array.from({ length: 39 }, (_, i) => sq(null, `P${i}`)), staff: Array.from({ length: 10 }, (_, i) => ({ id: id(), role: 'Medic', first_name: '', last_name: `M${i}`, license_number: null })) }
    const m = mergeMatchRoster(squad, {
      players: [mp(1, 'Wrong', { license_number: '121212' }), mp(2, 'New'), mp(3, 'New'), { invalid: true }, mp(4, 'Full')],
      staff: [{ role: 'Coach', first_name: 'C', last_name: 'Eleventh', license_number: null }]
    }, { wrong: new Set([0]) })
    assert.equal(m.players.length, 40)
    assert.equal(m.players[39].last_name, 'New')
    assert.equal(m.staff.length, 10)
    assert.equal(m.counts.skipped, 5)
    assert.equal(m.counts.added, 1)
    assert.equal(body(m).error, undefined)
  })

  it('a person without a licence goes to the saved team, not to the club', () => {
    const m = mergeMatchRoster({ players: [], staff: [] }, { players: [mp(3, 'Nolicence')], staff: [{ role: 'Coach', first_name: 'C', last_name: 'C', license_number: null }] })
    assert.equal(m.players.length, 1)
    assert.equal(m.staff.length, 1)
    assert.deepEqual(m.club, [])
  })

  it('two players of the match with one number: no two players of the saved team have it', () => {
    const m = mergeMatchRoster({ players: [], staff: [] }, { players: [mp(3, 'One'), mp(3, 'Two')], staff: [] })
    assert.deepEqual(m.players.map((p) => p.number), [null, 3])
    assert.equal(body(m).error, undefined)
  })
})

describe('createRosterSaveBack: waiting per match', () => {
  // a fake clock and timers: each test drives them
  function fakeTimers () {
    let t = 0
    let seq = 0
    const timers = new Map()
    return {
      clock: () => new Date(t),
      setTimer: (fn, ms) => { const h = { id: ++seq, at: t + ms, fn, unref () {} }; timers.set(h.id, h); return h },
      clearTimer: (h) => { if (h) timers.delete(h.id) },
      async advance (ms) {
        t += ms
        for (const h of [...timers.values()].sort((a, b) => a.at - b.at)) {
          if (h.at <= t && timers.has(h.id)) { timers.delete(h.id); h.fn() }
        }
        await new Promise((r) => setImmediate(r))
      }
    }
  }
  const row = (extra = {}) => ({ table: 'matches', eventType: 'UPDATE', row: { id: MATCH, test: false, game_n: 4711, status: 'live', ...extra } })
  const MATCH = randomUUID()

  function saveBackWith (timers, runs) {
    // a pool whose match read records the run (the match is gone: nothing else is read)
    const pool = { query: async (sql, params) => { runs.push(params[0]); return { rows: [] } } }
    return createRosterSaveBack({ pool, teams: {}, savedTeams: {}, audit: async () => {}, logger: { warn () {}, error () {} }, ...timers })
  }

  it('one run after the match has been quiet for a minute, however often it was written', async () => {
    const timers = fakeTimers()
    const runs = []
    const sb = saveBackWith(timers, runs)
    sb.note([row()])
    await timers.advance(SAVE_BACK_QUIET_MS - 1000)
    sb.note([row()])
    await timers.advance(SAVE_BACK_QUIET_MS - 1000)
    sb.note([row(), row()])
    assert.deepEqual(runs, [])
    assert.deepEqual(sb.pending(), [MATCH])
    await timers.advance(SAVE_BACK_QUIET_MS)
    assert.deepEqual(runs, [MATCH])
    assert.deepEqual(sb.pending(), [])
  })

  it('a match written all the time: a run at the latest after SAVE_BACK_MAX_WAIT_MS', async () => {
    const timers = fakeTimers()
    const runs = []
    const sb = saveBackWith(timers, runs)
    for (let waited = 0; waited < SAVE_BACK_MAX_WAIT_MS; waited += 30 * 1000) {
      sb.note([row()])
      await timers.advance(30 * 1000)
    }
    assert.deepEqual(runs, [MATCH])
  })

  it('no run for a test, a match without a game number, a beach match, before the coin toss, other tables', async () => {
    const timers = fakeTimers()
    const runs = []
    const sb = saveBackWith(timers, runs)
    sb.note([row({ test: true }), row({ game_n: null }), row({ game_n: 0 }), row({ sport_type: 'beach' }), row({ status: 'setup' }),
      { table: 'events', eventType: 'INSERT', row: { id: MATCH } }, { table: 'matches', eventType: 'DELETE', row: { id: MATCH } }, null])
    sb.note('nonsense')
    assert.deepEqual(sb.pending(), [])
    await timers.advance(SAVE_BACK_MAX_WAIT_MS)
    assert.deepEqual(runs, [])
  })

  it('run(): a test match, game 0 or a match before its coin toss is never touched', async () => {
    const rows = {
      test: { id: MATCH, test: true, game_n: 4711, status: 'live' },
      zero: { id: MATCH, test: false, game_n: 0, status: 'live' },
      beach: { id: MATCH, test: false, game_n: 4711, status: 'live', sport_type: 'beach' },
      exempt: { id: MATCH, test: false, game_n: 4711, status: 'live', exempt: true },
      setup: { id: MATCH, test: false, game_n: 4711, status: 'setup' }
    }
    for (const [k, m] of Object.entries(rows)) {
      const reads = []
      const pool = { query: async (sql) => { reads.push(sql); return { rows: reads.length === 1 ? [m] : [] } }, connect: async () => { throw new Error('no transaction may start') } }
      const sb = createRosterSaveBack({ pool, teams: {}, savedTeams: {}, audit: async () => { throw new Error('no audit') } })
      const r = await sb.run(MATCH)
      assert.equal(r.skipped, k === 'setup' ? 'no_coin_toss' : 'not_official', k)
      assert.equal(reads.length, 1, `${k}: only the match is read`)
    }
  })
})
