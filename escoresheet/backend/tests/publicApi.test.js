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

describe('real status words', () => {
  it('a final / ended match is finished in the API, and A / B know which team is home', () => {
    assert.equal(publicMatchInfo({ ...row, status: 'final' }).status, 'finished')
    const l = publicLive({ external_id: 'm', match_status: 'ended', home_team: { name: 'VBC Home' }, team_a_name: 'VBC Away', team_b_name: 'VBC Home' })
    assert.equal(l.status, 'finished')
    assert.equal(l.homeIs, 'B')
    assert.equal(publicLive({ external_id: 'm', team_a_name: 'X', team_b_name: 'Y', home_team: { name: 'X' } }).homeIs, 'A')
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
  it('maps score, sets and time-outs (line-ups and sanctions need the PIN)', () => {
    assert.deepEqual(live.score, { setsA: 1, setsB: 0, pointsA: 10, pointsB: 8 })
    assert.equal(live.teams.A.timeouts, 1)
    assert.equal(live.serving, 'A')
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
    assert.deepEqual(s.substitutions[0], { team: 'home', at: { home: 2, away: 1 } })
    assert.deepEqual(s.sanctions, [{ team: 'home', type: 'warning', at: { home: 2, away: 1 } }])
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

// Review of the public API (rollout audit): the live projection rule, the
// statistics of a finished match, the stream limits and the query cost.
describe('review: same rule as the anonymous live projection', () => {
  const liveRow = {
    external_id: 'match_1', match_status: 'live', points_a: 3, points_b: 2, team_a_name: 'VBC Home', team_b_name: 'VBC Away',
    lineup_a: { I: { number: 4, isServing: true } }, lineup_b: { I: 2 },
    subs_a: [{ out: 1, in: 2 }], sanctions_a: [{ player: 5, type: 'expulsion' }], sanctions_b: [{ role: 'coach', type: 'warning' }],
    last_event_data: { player: 5 }, scorer_attention_trigger: 'x'
  }
  it('no line-ups, substitutions or sanctions without the match PIN (LIVE_STATE_PRIVATE_COLUMNS)', () => {
    const live = publicLive(liveRow)
    for (const k of ['onCourt', 'substitutions', 'sanctions', 'lastEvent']) assert.ok(!(k in live), `${k} is public`)
    const s = JSON.stringify(live)
    assert.ok(!s.includes('expulsion') && !s.includes('coach'), s)
    assert.equal(live.score.pointsA, 3)
    assert.equal(live.teams.A.name, 'VBC Home')
  })
})

describe('review: statistics carry no disciplinary or health detail by shirt number', () => {
  const ev = (type, seq, payload) => ({ type, set_index: 1, seq, payload })
  const st = buildStats({ external_id: 'm', status: 'finished', home_team: { name: 'H' }, away_team: { name: 'A' } }, [
    ev('point', 1, { team: 'home' }),
    ev('sanction', 2, { team: 'home', type: 'expulsion', playerType: 'player', playerNumber: 7 }),
    ev('substitution', 3, { team: 'home', playerOut: 7, playerIn: 9, isExpelled: true }),
    ev('substitution', 4, { team: 'away', playerOut: 3, playerIn: 4, isExceptional: true }),
    ev('sanction', 5, { team: 'away', type: 'warning', role: 'coach' })
  ], [])
  const s = st.sets[0]
  it('a sanction says team, type and score, not who', () => {
    assert.deepEqual(s.sanctions, [
      { team: 'home', type: 'expulsion', at: { home: 1, away: 0 } },
      { team: 'away', type: 'warning', at: { home: 1, away: 0 } }
    ])
  })
  it('a substitution says team and score, not who or why (injury, expulsion)', () => {
    assert.deepEqual(s.substitutions, [{ team: 'home', at: { home: 1, away: 0 } }, { team: 'away', at: { home: 1, away: 0 } }])
    assert.equal(st.totals.home.substitutions, 1)
  })
})

describe('review: query cost', () => {
  it('the list does not read rosters or benches', async () => {
    const seen = []
    const api = createPublicApi({ pool: { query: async (sql) => { seen.push(sql); return { rows: [] } } } })
    await api.list({})
    assert.ok(!/players_|bench_/.test(seen[0]), seen[0])
  })
  it('statistics of a finished open match are rebuilt (corrections and late events write events only)', async () => {
    let events = 0
    const fin = { ...row, status: 'finished', final_score: '3:0', _id: 'u', updated_at: new Date('2026-11-14T20:00:00Z'), closed_at: null }
    const api = createPublicApi({
      pool: {
        query: async (sql) => {
          if (/FROM public\.events/.test(sql)) { events++; return { rows: [] } }
          if (/FROM public\.sets/.test(sql)) return { rows: [] }
          return { rows: [fin] }
        }
      }
    })
    const r = await api.stats('match_1')
    assert.equal(r.status, 200)
    assert.equal(r.headers['Cache-Control'], 'public, max-age=30')
    assert.equal((await api.stats('match_1')).status, 200)
    assert.equal(events, 2)
  })
  it('statistics of an unchanged closed match are built once', async () => {
    let events = 0
    const fin = { ...row, status: 'finished', final_score: '3:0', _id: 'u', updated_at: new Date('2026-11-14T20:00:00Z'), closed_at: new Date('2026-11-14T20:05:00Z') }
    let m = fin
    const api = createPublicApi({
      pool: {
        query: async (sql) => {
          if (/FROM public\.events/.test(sql)) { events++; return { rows: [] } }
          if (/FROM public\.sets/.test(sql)) return { rows: [] }
          return { rows: [m] }
        }
      }
    })
    assert.equal((await api.stats('match_1')).status, 200)
    assert.equal((await api.stats('match_1')).status, 200)
    assert.equal(events, 1)
    m = { ...fin, updated_at: new Date('2026-11-14T21:00:00Z') } // admin change after the close
    assert.equal((await api.stats('match_1')).status, 200)
    assert.equal(events, 2)
  })
})

describe('review: stream limits', () => {
  const fakeRes = () => {
    const r = { frames: [], writableLength: 0, destroyed: false, handlers: {} }
    r.write = (x) => { r.frames.push(x); return true }
    r.on = (ev, f) => { r.handlers[ev] = f }
    r.destroy = () => { r.destroyed = true; r.handlers.close?.() }
    return r
  }
  it('one address cannot take every stream', () => {
    const s = createLiveStreams({ snapshot: async () => ({ p: 1 }), intervalMs: 1000, maxPerKey: 2 })
    assert.equal(s.attach('m', fakeRes(), { key: 'ip1' }), true)
    assert.equal(s.attach('m2', fakeRes(), { key: 'ip1' }), true)
    assert.equal(s.canAttach('m3', 'ip1'), false)
    assert.equal(s.attach('m3', fakeRes(), { key: 'ip1' }), false)
    assert.equal(s.canAttach('m3', 'ip2'), true)
    s.closeAll()
  })
  it('a closed stream gives its address slot back', () => {
    const s = createLiveStreams({ snapshot: async () => ({ p: 1 }), intervalMs: 1000, maxPerKey: 1 })
    const r = fakeRes()
    assert.equal(s.attach('m', r, { key: 'ip1' }), true)
    r.handlers.close()
    assert.equal(s.canAttach('m', 'ip1'), true)
    s.closeAll()
  })
  it('the number of polled matches is capped (one database poll each)', () => {
    const s = createLiveStreams({ snapshot: async () => ({ p: 1 }), intervalMs: 1000, maxMatches: 2 })
    assert.equal(s.attach('a', fakeRes(), { key: '1' }), true)
    assert.equal(s.attach('b', fakeRes(), { key: '2' }), true)
    assert.equal(s.canAttach('c', '3'), false)
    assert.equal(s.canAttach('a', '3'), true) // an already polled match costs nothing more
    s.closeAll()
  })
  it('uses the snapshot it was given (no second query per new viewer)', async () => {
    let calls = 0
    const s = createLiveStreams({ snapshot: async () => { calls++; return { p: 1 } }, intervalMs: 1000 })
    const r = fakeRes()
    s.attach('m', r, { key: 'k', first: { p: 1 } })
    await new Promise((res) => setTimeout(res, 20))
    assert.equal(calls, 0)
    assert.equal(r.frames.filter((f) => f.startsWith('event: live')).length, 1)
    s.closeAll()
  })
  it('a viewer that does not read is dropped, not buffered without end', async () => {
    let n = 0
    const s = createLiveStreams({ snapshot: async () => ({ p: n++ }), intervalMs: 10, maxBuffered: 1000 })
    const slow = fakeRes()
    slow.write = (x) => { slow.writableLength += x.length; return false }
    s.attach('m', slow, { key: 'k' })
    slow.writableLength = 5000
    await new Promise((res) => setTimeout(res, 50))
    assert.equal(slow.destroyed, true)
    assert.deepEqual(s.stats(), { matches: 0, clients: 0 })
  })
  it('a finished match is polled rarely', async () => {
    let calls = 0
    const s = createLiveStreams({ snapshot: async () => { calls++; return { status: 'finished' } }, intervalMs: 5, finishedEvery: 1000 })
    s.attach('m', fakeRes(), { key: 'k', first: { status: 'finished' } })
    await new Promise((res) => setTimeout(res, 80))
    assert.ok(calls <= 1, `polled ${calls} times`)
    s.closeAll()
  })
})

// The widget said "Upcoming" for a match being played: it looked for status
// 'live', while /live answers what the scorer writes (in_progress, interval,
// timeout; ended / final / approved at the end).
describe('the <ov-livescore> widget reads the API\'s statuses', () => {
  const widget = () => {
    const make = (tag) => ({ tag, className: '', textContent: '', children: [], appendChild(c) { this.children.push(c); return c } })
    let Live = null
    const g = {
      customElements: { get: () => undefined, define: (_n, c) => { Live = c } },
      document: { createElement: make, currentScript: null },
      HTMLElement: function () {},
      window: {}
    }
    new Function('customElements', 'document', 'HTMLElement', 'window', LIVESCORE_JS)(g.customElements, g.document, g.HTMLElement, g.window)
    return (status) => {
      const box = make('div')
      Live.prototype._draw.call({ _box: box }, { status, currentSet: 2, serving: 'A', teams: { A: { name: 'A' }, B: { name: 'B' } }, score: { setsA: 1, setsB: 0, pointsA: 3, pointsB: 2 }, setResults: [] })
      return box.children[0].children[0].textContent
    }
  }
  it('a match in play is LIVE', () => {
    const label = widget()
    for (const s of ['in_progress', 'live', 'interval', 'timeout']) assert.equal(label(s), 'LIVE', s)
  })
  it('a finished match is Final, one not started Upcoming', () => {
    const label = widget()
    for (const s of ['ended', 'final', 'approved', 'finished']) assert.equal(label(s), 'Final', s)
    for (const s of ['setup', 'scheduled', 'pre_match', 'not_started', null]) assert.equal(label(s), 'Upcoming', String(s))
  })
})
