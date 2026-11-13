import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { publicOfficials, publicRoster, publicBench, publicMatchInfo, publicLive, buildStats, createPublicApi, createLiveStreams, MATCH_ID_RE } from '../lib/publicApi.js'
import { LIVESCORE_JS } from '../lib/publicEmbed.js'

const NAMES = ['Anna', 'Muster', 'Hans', 'Keller', 'Beispiel', 'Rossi', '1990-01-01', 'CHE', 'secret-pin']
const noNames = (obj) => {
  const s = JSON.stringify(obj)
  for (const n of NAMES) assert.ok(!s.includes(n), `leaked ${n}`)
}

const row = {
  external_id: 'match_1', sport_type: 'indoor', game_n: 12, status: 'live', scheduled_at: new Date('2026-11-14T18:00:00Z'),
  match_info: { league: '2L', hall: 'Hall A', city: 'Zurich', best_of: 5, secret: 'x' },
  officials: [
    { role: '1st referee', firstName: 'Anna', lastName: 'Muster', country: 'CHE', dob: '1990-01-01' },
    { role: '2nd referee', firstName: 'Hans', lastName: 'Keller' },
    { role: 'scorer', firstName: '', lastName: '' },
    { role: 'line judge 1', name: 'Rossi Beispiel' }
  ],
  home_team: { name: 'VBC Home', short_name: 'HOM', color: '#fff' }, away_team: { name: 'VBC Away' },
  players_home: [{ number: 7, first_name: 'Anna', last_name: 'Muster', dob: '1990-01-01', is_captain: true }, { number: 1, libero: 'libero1', firstName: 'Hans' }],
  players_away: [{ number: 3, name: 'Rossi' }],
  bench_home: [{ role: 'Head coach', first_name: 'Hans', last_name: 'Keller' }], bench_away: [],
  connection_pins: { referee: 'secret-pin' }, game_pin: 'secret-pin'
}

describe('public match info: roles and numbers only', () => {
  it('officials are roles, empty slots are left out', () => {
    assert.deepEqual(publicOfficials(row.officials), [{ role: '1st referee' }, { role: '2nd referee' }, { role: 'line judge 1' }])
    assert.deepEqual(publicOfficials({ referee_1: { firstName: 'Anna' } }), [{ role: 'referee 1' }])
    assert.deepEqual(publicOfficials(null), [])
  })
  it('rosters keep number, captain, libero', () => {
    assert.deepEqual(publicRoster(row.players_home), [{ number: 1, captain: false, libero: true }, { number: 7, captain: true, libero: false }])
    assert.deepEqual(publicBench(row.bench_home), [{ role: 'head coach' }])
  })
  it('the whole body has no names, dates of birth or PINs', () => {
    const body = publicMatchInfo(row)
    noNames(body)
    assert.equal(body.id, 'match_1')
    assert.equal(body.venue.city, 'Zurich')
    assert.equal(body.bestOf, 5)
    assert.equal(body.home.name, 'VBC Home')
    assert.ok(!('secret' in body))
  })
})

describe('livescore snapshot', () => {
  const live = publicLive({
    external_id: 'match_1', match_status: 'live', current_set: 2, best_of: 5, sets_won_a: 1, sets_won_b: 0, points_a: 10, points_b: 8,
    team_a_name: 'VBC Home', team_b_name: 'VBC Away', serving_team: 'A', side_a: 'left', timeouts_a: 1, timeouts_b: 0,
    lineup_a: { I: { number: 4, isServing: true, isCaptain: true }, II: { number: 9 } }, lineup_b: { I: 2 },
    subs_a: [{ out: 1, in: 2 }], sanctions_a: [{ player: 5, type: 'warning', ts: 'x' }], set_results: [{ index: 1, pointsA: 25, pointsB: 20, winner: 'A' }],
    timeout_active: true, updated_at: new Date('2026-11-14T18:30:00Z')
  })
  it('maps score, on-court numbers, sanctions', () => {
    assert.deepEqual(live.score, { setsA: 1, setsB: 0, pointsA: 10, pointsB: 8 })
    assert.equal(live.onCourt.A.I.number, 4)
    assert.deepEqual(live.onCourt.B, { I: 2 })
    assert.deepEqual(live.sanctions.A, [{ type: 'warning', number: 5, role: null }])
    assert.equal(live.substitutions.A, 1)
    assert.equal(live.timeout, true)
    assert.deepEqual(live.setResults, [{ set: 1, pointsA: 25, pointsB: 20, winner: 'A' }])
  })
})

describe('end-of-match statistics', () => {
  const ev = (type, set_index, seq, payload) => ({ type, set_index, seq, payload })
  const events = [
    ev('lineup', 1, 1, { team: 'home', lineup: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 } }),
    ev('lineup', 1, 1.1, { team: 'away', lineup: { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 } }),
    ev('point', 1, 2, { team: 'home' }), ev('point', 1, 3, { team: 'home' }), ev('point', 1, 4, { team: 'away' }),
    ev('timeout', 1, 5, { team: 'away' }),
    ev('substitution', 1, 6, { team: 'home', playerOut: 2, playerIn: 8 }),
    ev('lineup', 1, 6.1, { team: 'home', lineup: { I: 1, II: 8 }, fromSubstitution: true }),
    ev('sanction', 1, 7, { team: 'home', type: 'warning', playerType: 'player', playerNumber: 3, firstName: 'Anna' }),
    ev('point', 1, 8, { team: 'home' }),
    ev('set_end', 1, 9, { team: 'home', homePoints: 3, awayPoints: 1 })
  ]
  const st = buildStats({ external_id: 'match_1', status: 'finished', final_score: '1:0', winner: 'home', home_team: { name: 'H' }, away_team: { name: 'A' } }, events,
    [{ index: 1, start_time: '2026-11-14T18:00:00Z', end_time: '2026-11-14T18:25:00Z' }])
  it('counts points, timeouts, subs, sanctions with the score at the time', () => {
    const s = st.sets[0]
    assert.deepEqual(s.points, { home: 3, away: 1 })
    assert.equal(s.winner, 'home')
    assert.equal(s.minutes, 25)
    assert.deepEqual(s.timeouts, [{ team: 'away', at: { home: 2, away: 1 } }])
    assert.deepEqual(s.substitutions[0], { team: 'home', out: 2, in: 8, at: { home: 2, away: 1 }, exceptional: false, expelled: false, disqualified: false })
    assert.deepEqual(s.sanctions, [{ team: 'home', type: 'warning', number: 3, role: 'player', at: { home: 2, away: 1 } }])
    assert.equal(s.longestRun.home, 2)
    assert.deepEqual(s.pointLog.at(-1), [3, 1, 'H'])
    assert.deepEqual(st.totals.home, { points: 3, timeouts: 0, substitutions: 1, sanctions: 1 })
  })
  it('keeps the starting formation, not the one after a substitution', () => {
    assert.deepEqual(st.sets[0].startingLineup.home, { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 })
    assert.deepEqual(st.sets[0].startingLineup.away.VI, 16)
  })
  it('has no names', () => noNames(st))
})

describe('handlers', () => {
  const pool = (rowsBy) => ({ query: async (sql) => ({ rows: rowsBy(sql) }) })
  it('rejects bad ids and unknown matches, never throws', async () => {
    const api = createPublicApi({ pool: pool(() => []) })
    assert.equal((await api.info('a b')).status, 400)
    assert.equal((await api.info('nope')).status, 404)
    assert.equal((await api.live('nope')).status, 404)
    const broken = createPublicApi({ pool: { query: async () => { throw new Error('down') } }, logger: {} })
    assert.equal((await broken.info('x')).status, 503)
  })
  it('stats wait until the match is finished', async () => {
    const api = createPublicApi({ pool: pool(() => [{ ...row, status: 'live', _id: 'u' }]) })
    assert.equal((await api.stats('match_1')).status, 409)
  })
  it('list refuses windows over 62 days and unknown status', async () => {
    const api = createPublicApi({ pool: pool(() => []) })
    assert.equal((await api.list({ from: '2026-01-01', to: '2026-06-01' })).status, 400)
    assert.equal((await api.list({ status: 'bogus' })).status, 400)
    assert.equal((await api.list({})).status, 200)
  })
  it('id pattern', () => {
    assert.ok(MATCH_ID_RE.test('match_100_aaa'))
    assert.ok(!MATCH_ID_RE.test('a/b'))
  })
})

describe('stream + widget', () => {
  it('sends on change only and stops polling with the last client', async () => {
    let n = 0
    const frames = []
    const res = { write: (x) => frames.push(x), on(ev, f) { this.close = f } }
    const s = createLiveStreams({ snapshot: async () => ({ p: n < 2 ? 1 : 2 }), intervalMs: 10 })
    assert.equal(s.attach('m', res), true)
    await new Promise((r) => setTimeout(r, 60))
    n = 5
    await new Promise((r) => setTimeout(r, 60))
    const data = frames.filter((f) => f.startsWith('event: live'))
    assert.equal(data.length, 2)
    res.close()
    assert.deepEqual(s.stats(), { matches: 0, clients: 0 })
  })
  it('the widget is plain syntax and writes text only', () => {
    new Function(LIVESCORE_JS)
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(LIVESCORE_JS))
  })
})
