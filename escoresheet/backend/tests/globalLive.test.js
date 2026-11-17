// Tests for lib/globalLive.js (the Global tool's live page for TVs).
//   cd escoresheet/backend && node --test tests/globalLive.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGlobalLive, courtSummary, isLiveCode } from '../lib/globalLive.js'

const CODE = 'ABCD2345'
const live = (over = {}) => ({
  team_a_name: 'Munich IS', team_a_short: 'MIS', team_a_color: '#1d4ed8',
  team_b_name: 'Zurich IS', team_b_short: 'ZIS', team_b_color: '#dc2626',
  sets_won_a: 1, sets_won_b: 0, points_a: 12, points_b: 9, current_set: 2, best_of: 5,
  side_a: 'left', serving_team: 'left', match_status: 'live',
  timeout_active: false, set_interval_active: false,
  lineup_a: { I: 7 }, subs_a: [{ in: 3 }], sanctions_a: [{ type: 'warning' }],
  ...over
})
const entry = (over = {}) => ({
  match: { coinTossTeamA: 'home', hall: 'Hall 1', scheduledAt: '2027-11-05T09:00:00Z', gameN: 3, refereePin: '123456', officials: [{ lastName: 'Ref' }] },
  homeTeam: { name: 'Munich IS' }, awayTeam: { name: 'Zurich IS' },
  homePlayers: [{ firstName: 'Anna', lastName: 'Muster', dob: '2009-01-01' }],
  sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 2, homePoints: 12, awayPoints: 9, finished: false }],
  ...over
})

describe('isLiveCode', () => {
  it('takes 8 characters from the alphabet without look-alikes', () => {
    assert.equal(isLiveCode(CODE), true)
    for (const bad of ['abcd2345', 'ABCD234', 'ABCD23450', 'ABCD234O', 'ABCD2341', null, 12345678, '../../x']) assert.equal(isLiveCode(bad), false, String(bad))
  })
})

describe('courtSummary', () => {
  it('keeps the score summary only, home and away as on the scoresheet', () => {
    const s = courtSummary(live(), entry(), '2027-11-05T09:30:00.000Z')
    assert.deepEqual(s.home, { name: 'Munich IS', short: 'MIS', color: '#1d4ed8' })
    assert.deepEqual(s.away, { name: 'Zurich IS', short: 'ZIS', color: '#dc2626' })
    assert.deepEqual(s.setsWon, { home: 1, away: 0 })
    assert.deepEqual(s.points, { home: 12, away: 9 })
    assert.deepEqual(s.sets, [{ home: 25, away: 20 }])
    assert.equal(s.serving, 'home')
    assert.equal(s.currentSet, 2)
    assert.equal(s.hall, 'Hall 1')
    const text = JSON.stringify(s)
    for (const leak of ['Anna', 'Muster', '2009', '123456', 'Ref', 'lineup', 'warning', '"in"']) assert.equal(text.includes(leak), false, leak)
  })

  it('maps team A back to away when the coin toss gave A to the away team', () => {
    const s = courtSummary(live({ team_a_name: 'Zurich IS', team_b_name: 'Munich IS', points_a: 5, points_b: 8, side_a: 'right', serving_team: 'left' }), entry({ match: { coinTossTeamA: 'away' } }))
    assert.deepEqual(s.points, { home: 8, away: 5 })
    assert.equal(s.home.name, 'Munich IS')
    assert.equal(s.serving, 'home') // left serves, A stands right: B (home) serves
  })

  it('refuses odd values instead of passing them on', () => {
    const s = courtSummary(live({ team_a_color: 'red;background:url(x)', points_a: 'x', best_of: 7, match_status: { a: 1 } }), {})
    assert.equal(s.home.color, null)
    assert.equal(s.points.home, 0)
    assert.equal(s.bestOf, 5)
    assert.equal(s.status, null)
  })
})

describe('createGlobalLive', () => {
  it('lists the courts of a code, nothing for another code', () => {
    const store = createGlobalLive()
    assert.equal(store.update(CODE, 'room-1', live(), entry()), true)
    assert.equal(store.update(CODE, 'room-2', live({ match_status: 'final' }), entry({ match: { hall: 'Hall 2' } })), true)
    const page = store.get(CODE)
    assert.equal(page.courts.length, 2)
    assert.equal(page.courts[0].ended, false) // running first
    assert.equal(page.courts.every(c => !JSON.stringify(c).includes('room-')), true) // no room key out
    assert.equal(store.get('ZZZZ2345'), null)
    assert.equal(store.get('bad'), null)
    assert.equal(store.update('bad', 'room-1', live(), entry()), false)
  })

  it('one court per room: a new state replaces the old one', () => {
    const store = createGlobalLive()
    store.update(CODE, 'room-1', live({ points_a: 1 }), entry())
    store.update(CODE, 'room-1', live({ points_a: 2 }), entry())
    assert.equal(store.get(CODE).courts.length, 1)
    assert.equal(store.get(CODE).courts[0].points.home, 2)
  })

  it('drops ended courts after endedKeepMs and idle ones after idleMs', () => {
    let t = 1_000_000
    const store = createGlobalLive({ idleMs: 10_000, endedKeepMs: 1_000, now: () => t })
    store.update(CODE, 'done', live({ match_status: 'final' }), entry())
    store.update(CODE, 'running', live(), entry())
    t += 2_000
    assert.deepEqual(store.get(CODE).courts.map(c => c.ended), [false])
    t += 20_000
    assert.equal(store.get(CODE), null)
    assert.equal(store.size(), 0)
  })

  it('is bounded: codes and courts per code', () => {
    let t = 0
    const store = createGlobalLive({ maxCodes: 2, maxCourtsPerCode: 2, now: () => ++t })
    assert.equal(store.update('AAAA2345', 'r', live(), entry()), true)
    assert.equal(store.update('BBBB2345', 'r', live(), entry()), true)
    assert.equal(store.update('CCCC2345', 'r', live(), entry()), false)
    store.update('AAAA2345', 'r2', live(), entry())
    store.update('AAAA2345', 'r3', live(), entry())
    assert.equal(store.get('AAAA2345').courts.length, 2)
  })
})
