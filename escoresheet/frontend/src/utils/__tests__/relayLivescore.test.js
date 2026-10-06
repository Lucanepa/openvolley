import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createRelayLivescoreFeed,
  fetchRelayLivescoreList,
  relayLiveRow,
  relayLivescoreMode,
  relayLivescoreWsUrl,
  setResultsFromSets,
  LIVESCORE_LIVE_FIELDS
} from '../relayLivescore'
import { liveScoreboard, listedGames } from '../livescoreModel'
import { setBackendOverride } from '../backendConfig'

const PIN = '987654'
const DOB = '2001-04-17'

// A live state as the scorer pushes it (Scoreboard.jsx liveStateData)
function liveState(overrides = {}) {
  return {
    match_id: 'cloud-uuid',
    current_set: 2,
    team_a_name: 'Home VC',
    team_a_short: 'HOM',
    team_a_color: '#e2001a',
    team_b_name: 'Away VC',
    team_b_short: 'AWA',
    team_b_color: '#1d4ed8',
    best_of: 5,
    sets_won_a: 1,
    sets_won_b: 0,
    points_a: 7,
    points_b: 5,
    side_a: 'right',
    lineup_a: { I: { number: 7, isServing: true } },
    lineup_b: { I: { number: 9 } },
    timeouts_a: 1,
    timeouts_b: 0,
    subs_a: [{ playerIn: 4, playerOut: 7 }],
    sanctions_a: null,
    serving_team: 'right',
    last_event_type: 'point',
    last_event_data: { team: 'home' },
    last_event_ts: '2026-10-06T18:00:05.000Z',
    timeout_active: false,
    set_interval_active: false,
    match_status: 'in_progress',
    scorer_attention_trigger: 3,
    game_n: '4242',
    league: '2L',
    gender: 'men',
    updated_at: '2026-10-06T18:00:05.000Z',
    sport_type: 'indoor',
    _seq: 10,
    _session: 's1',
    ...overrides
  }
}

// What a relay sends a subscriber without a PIN (relaySummaryBundle)
function summary(type, matchId, extra = {}) {
  return {
    type,
    matchId,
    access: 'summary',
    match: { id: 1, status: 'live', seed_key: matchId, coinTossTeamA: 'home', test: false },
    homeTeam: { name: 'Home VC', color: '#e2001a' },
    awayTeam: { name: 'Away VC' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ id: 1, index: 1, homePoints: 25, awayPoints: 21, finished: true }, { id: 2, index: 2, homePoints: 5, awayPoints: 7, finished: false }],
    events: [],
    ...extra
  }
}

function fakeSocket() {
  const s = {
    readyState: 0,
    sent: [],
    send(text) { s.sent.push(JSON.parse(text)) },
    close: vi.fn(() => { s.readyState = 3 }),
    open() { s.readyState = 1; s.onopen?.() },
    receive(msg) { s.onmessage?.({ data: JSON.stringify(msg) }) },
    drop() { s.readyState = 3; s.onclose?.({ code: 1006 }) }
  }
  return s
}

describe('relayLivescoreMode', () => {
  it('reads the relay when the page or the chosen server is on this machine / the LAN', () => {
    expect(relayLivescoreMode({ servedFromLocalServer: true, origin: 'http://192.168.1.20:5173' })).toBe(true)
    expect(relayLivescoreMode({ servedFromLocalServer: true, origin: 'http://10.42.0.1:5173' })).toBe(true) // laptop hotspot
    expect(relayLivescoreMode({ servedFromLocalServer: true, origin: 'http://192.168.44.1:5173' })).toBe(true) // Bluetooth PAN
    expect(relayLivescoreMode({ servedFromLocalServer: true, origin: 'http://localhost:5173' })).toBe(true) // the desktop window
    expect(relayLivescoreMode({ override: 'http://192.168.1.20:5173' })).toBe(true) // Android app
  })

  it('keeps the cloud everywhere else', () => {
    expect(relayLivescoreMode({ servedFromLocalServer: false, origin: 'https://livescore.openvolley.app' })).toBe(false)
    expect(relayLivescoreMode({ servedFromLocalServer: true, origin: 'https://scores.myclub.ch' })).toBe(false)
    expect(relayLivescoreMode({ servedFromLocalServer: true, origin: 'http://192.168.1.20:5173', override: 'https://backend.openvolley.app' })).toBe(false)
    expect(relayLivescoreMode({})).toBe(false)
  })
})

describe('relayLiveRow', () => {
  it('is a match_live_state row of the public fields the livescore shows', () => {
    const row = relayLiveRow('seed-1', { liveState: liveState(), ...summary('match-full-data', 'seed-1') })
    expect(row.match_id).toBe('seed-1')
    expect(row.matches).toEqual({ set_results: [{ set: 1, home: 25, away: 21 }], coin_toss: { team_a: 'home' }, home_team: { name: 'Home VC' } })
    expect(row.test).toBe(false)
    for (const k of Object.keys(row)) expect([...LIVESCORE_LIVE_FIELDS, 'match_id', 'matches', 'test']).toContain(k)
    // Lineups, substitutions, event payloads and the scorer's attention flag stay out
    for (const k of ['lineup_a', 'lineup_b', 'subs_a', 'sanctions_a', 'last_event_data', 'scorer_attention_trigger']) expect(row).not.toHaveProperty(k)
    // The model reads it like a cloud row: Team A (home) plays right
    const view = liveScoreboard(row)
    expect(view).toMatchObject({ leftName: 'Away VC', rightName: 'Home VC', leftScore: 5, rightScore: 7, leftSets: 0, rightSets: 1, servingTeam: 'right' })
    expect(view.setResults).toEqual([{ set: 1, left: 21, right: 25 }])
    expect(listedGames([row])).toHaveLength(1)
  })

  it('keeps nothing else even when a message carries more', () => {
    const leaky = summary('match-full-data', 'seed-1', {
      match: { id: 1, status: 'live', gamePin: PIN, refereePin: '314159' },
      homePlayers: [{ number: 7, lastName: 'Player', dob: DOB }]
    })
    const text = JSON.stringify(relayLiveRow('seed-1', { liveState: liveState({ gamePin: PIN, dob: DOB }), ...leaky }))
    expect(text).not.toContain(PIN)
    expect(text).not.toContain('314159')
    expect(text).not.toContain(DOB)
    expect(text).not.toContain('Player')
  })

  it('has no row before the first live state, nor for beach', () => {
    expect(relayLiveRow('seed-1', summary('match-full-data', 'seed-1'))).toBeNull()
    expect(relayLiveRow('seed-1', { liveState: liveState({ sport_type: 'beach' }) })).toBeNull()
  })

  it('marks a rehearsal match and takes the home team from the list when the summary has none', () => {
    const row = relayLiveRow('t', { liveState: liveState(), match: {}, listed: { homeTeam: 'Listed Home', test: true } })
    expect(row.test).toBe(true)
    expect(row.matches.home_team).toEqual({ name: 'Listed Home' })
  })
})

describe('setResultsFromSets', () => {
  it('turns finished sets into set results, in order', () => {
    expect(setResultsFromSets([
      { index: 3, home_points: 15, away_points: 13, finished: true },
      { index: 1, homePoints: 25, awayPoints: 20, finished: true },
      { index: 2, homePoints: 3, awayPoints: 1 }
    ])).toEqual([{ set: 1, home: 25, away: 20 }, { set: 3, home: 15, away: 13 }])
    expect(setResultsFromSets(null)).toEqual([])
  })
})

describe('fetchRelayLivescoreList', () => {
  it('asks the relay and never throws', async () => {
    const ok = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, matches: [{ id: 'a' }] }) }))
    await expect(fetchRelayLivescoreList('http://r/api/match/list?finished=1', ok)).resolves.toEqual({ success: true, matches: [{ id: 'a' }] })
    expect(ok).toHaveBeenCalledWith('http://r/api/match/list?finished=1', expect.anything())
    await expect(fetchRelayLivescoreList('http://r/x', async () => ({ ok: false, status: 404 }))).resolves.toMatchObject({ success: false, error: 'HTTP 404' })
    await expect(fetchRelayLivescoreList('http://r/x', async () => { throw new Error('down') })).resolves.toMatchObject({ success: false, error: 'down' })
    await expect(fetchRelayLivescoreList(null, ok)).resolves.toMatchObject({ success: false })
  })
})

describe('relayLivescoreWsUrl', () => {
  const setLocation = (url) => {
    const u = new URL(url)
    Object.defineProperty(window, 'location', {
      value: { hostname: u.hostname, protocol: u.protocol, port: u.port, origin: u.origin, host: u.host, search: '' },
      writable: true,
      configurable: true
    })
  }
  const original = window.location
  beforeEach(() => {
    localStorage.clear()
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_BACKEND_URL', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true })
  })

  it('asks the page\'s relay for its WebSocket port', async () => {
    setLocation('http://192.168.1.20:5180/livescore')
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ wsPort: 8090 }) }))
    await expect(relayLivescoreWsUrl({ fetchImpl })).resolves.toBe('ws://192.168.1.20:8090')
    expect(fetchImpl).toHaveBeenCalledWith('http://192.168.1.20:5180/api/server/status')
    // No answer: the default WS port
    await expect(relayLivescoreWsUrl({ fetchImpl: async () => { throw new Error('x') } })).resolves.toBe('ws://192.168.1.20:8080')
  })

  it('asks a chosen LAN server for its port once (a ?server= link on another port)', async () => {
    setLocation('http://localhost:5191/livescore')
    setBackendOverride('http://192.168.1.20:5191')
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ wsPort: 8191 }) }))
    await expect(relayLivescoreWsUrl({ fetchImpl })).resolves.toBe('ws://192.168.1.20:8191')
    await expect(relayLivescoreWsUrl({ fetchImpl })).resolves.toBe('ws://192.168.1.20:8191')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('http://192.168.1.20:5191/api/server/status', expect.anything())
  })

  it('uses the chosen server of the Android app', async () => {
    setLocation('https://localhost/livescore/index.html')
    window.Capacitor = { isNativePlatform: () => true }
    try {
      setBackendOverride('http://192.168.1.20:5173')
      // The relay does not answer: the desktop default 5173 -> 8080
      const fetchImpl = vi.fn(async () => { throw new Error('offline') })
      await expect(relayLivescoreWsUrl({ fetchImpl })).resolves.toBe('ws://192.168.1.20:8080')
      expect(fetchImpl).toHaveBeenCalledWith('http://192.168.1.20:5173/api/server/status', expect.anything())
    } finally {
      delete window.Capacitor
    }
  })
})

describe('createRelayLivescoreFeed', () => {
  let sockets
  let timers
  let lists
  let changes
  let feed

  const flush = () => new Promise((r) => setTimeout(r, 0))
  function make(opts = {}) {
    sockets = []
    timers = []
    changes = []
    lists = []
    feed = createRelayLivescoreFeed({
      listMatches: vi.fn(async () => lists.shift() || { success: true, matches: [{ id: 'seed-1', homeTeam: 'Home VC', status: 'live' }] }),
      getWsUrl: async () => 'ws://192.168.1.20:8080',
      onChange: (rows) => changes.push(rows),
      createSocket: (url) => { const s = fakeSocket(); s.url = url; sockets.push(s); return s },
      setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t },
      clearTimer: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1) },
      ...opts
    })
    return feed
  }
  const last = () => changes[changes.length - 1]

  it('subscribes to every listed match without a PIN and follows its score', async () => {
    const onLive = vi.fn()
    make({ onLive })
    feed.start()
    await flush()
    const ws = sockets[0]
    expect(ws.url).toBe('ws://192.168.1.20:8080')
    ws.open()
    expect(onLive).toHaveBeenLastCalledWith(true)
    const subs = ws.sent.filter((m) => m.type === 'subscribe-match')
    expect(subs[0]).toEqual({ type: 'subscribe-match', matchId: 'seed-1', device: 'livescore' })
    for (const m of ws.sent) expect(m).not.toHaveProperty('pin')

    ws.receive(summary('match-full-data', 'seed-1', { liveState: liveState() }))
    expect(last()).toHaveLength(1)
    expect(last()[0]).toMatchObject({ match_id: 'seed-1', points_a: 7, points_b: 5 })

    ws.receive({ type: 'live-state-update', matchId: 'seed-1', liveState: liveState({ points_a: 8, _seq: 11 }) })
    expect(last()[0].points_a).toBe(8)
    // An older push of the same scorer session is not applied over it
    const count = changes.length
    ws.receive({ type: 'live-state-update', matchId: 'seed-1', liveState: liveState({ points_a: 6, _seq: 9 }) })
    expect(changes).toHaveLength(count)
    expect(feed.rows()[0].points_a).toBe(8)
    // Another match's frames are ignored
    ws.receive({ type: 'live-state-update', matchId: 'other', liveState: liveState({ points_a: 1, _seq: 99 }) })
    expect(feed.rows()).toHaveLength(1)

    // A match-data-update brings the finished sets
    ws.receive(summary('match-data-update', 'seed-1', { sets: [{ index: 1, homePoints: 25, awayPoints: 21, finished: true }, { index: 2, homePoints: 25, awayPoints: 23, finished: true }] }))
    expect(last()[0].matches.set_results).toEqual([{ set: 1, home: 25, away: 21 }, { set: 2, home: 25, away: 23 }])
    expect(last()[0].points_a).toBe(8) // the live state stays

    ws.receive({ type: 'match-deleted', matchId: 'seed-1' })
    expect(last()).toEqual([])
    feed.stop()
    expect(onLive).toHaveBeenLastCalledWith(false)
  })

  it('keeps the last set on screen when the match ends (set_end frame before match_end)', async () => {
    make()
    feed.start()
    await flush()
    const ws = sockets[0]
    ws.open()
    ws.receive(summary('match-full-data', 'seed-1', { liveState: liveState({ side_a: 'left', points_a: 24, points_b: 20, _seq: 20 }) }))
    // The set_end push: already 'ended', with the next set's sides and 0:0
    ws.receive({ type: 'live-state-update', matchId: 'seed-1', liveState: liveState({ match_status: 'ended', last_event_type: 'set_end', side_a: 'right', points_a: 0, points_b: 0, _seq: 21 }) })
    expect(last()[0]).toMatchObject({ match_status: 'ended', side_a: 'left', points_a: 24, points_b: 20 })
    ws.receive({ type: 'live-state-update', matchId: 'seed-1', liveState: liveState({ match_status: 'ended', last_event_type: 'match_end', side_a: 'left', points_a: 25, points_b: 20, _seq: 22 }) })
    expect(last()[0]).toMatchObject({ side_a: 'left', points_a: 25 })
    feed.stop()
  })

  it('polls the list, follows new matches and resubscribes after a reconnect', async () => {
    const onList = vi.fn()
    make({ onList })
    feed.start()
    await flush()
    const ws = sockets[0]
    ws.open()
    await flush()
    expect(onList).toHaveBeenCalledWith({ ok: true })
    // The poll timer brings a second match
    lists.push({ success: true, matches: [{ id: 'seed-1' }, { id: 7 }] })
    const poll = timers.find((t) => t.ms === 10000)
    timers.splice(timers.indexOf(poll), 1)
    poll.fn()
    await flush()
    expect(ws.sent.filter((m) => m.type === 'subscribe-match').map((m) => m.matchId)).toContain('7')

    // The relay drops: a reconnect after the backoff, every match again
    ws.drop()
    expect(feed.live).toBe(false)
    const retry = timers.find((t) => t.ms === 5000)
    expect(retry).toBeTruthy()
    timers.splice(timers.indexOf(retry), 1)
    await retry.fn()
    const again = sockets[1]
    again.open()
    expect(again.sent.filter((m) => m.type === 'subscribe-match').map((m) => m.matchId)).toEqual(['seed-1', '7'])
    for (const m of again.sent) expect(m).not.toHaveProperty('pin')

    // A failed list is reported, the followed matches stay
    lists.push({ success: false, matches: [], error: 'HTTP 502' })
    await expect(feed.refresh()).resolves.toEqual({ ok: false, error: 'HTTP 502' })
    expect(onList).toHaveBeenLastCalledWith({ ok: false, error: 'HTTP 502' })
    feed.stop()
    expect(again.close).toHaveBeenCalled()
  })

  it('replaces a socket that stops answering pings', async () => {
    make({ pingMs: 1000, pongTimeoutMs: 500 })
    feed.start()
    await flush()
    const ws = sockets[0]
    ws.open()
    const ping = timers.find((t) => t.ms === 1000)
    timers.splice(timers.indexOf(ping), 1)
    await new Promise((r) => setTimeout(r, 5)) // the ping goes out after the last message
    ping.fn()
    expect(ws.sent.some((m) => m.type === 'ping')).toBe(true)
    const pong = timers.find((t) => t.ms === 500)
    timers.splice(timers.indexOf(pong), 1)
    pong.fn() // no message since the ping
    expect(feed.live).toBe(false)
    const retry = timers.find((t) => t.ms === 0)
    await retry.fn()
    expect(sockets).toHaveLength(2)
    feed.stop()
  })
})
