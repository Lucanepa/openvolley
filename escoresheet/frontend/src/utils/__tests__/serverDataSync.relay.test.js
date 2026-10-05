import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  relayMatchKey,
  relayMatchPayload,
  buildLiveStateMatchData,
  isNewerLiveState,
  newerLiveState,
  applyNewerLiveState,
  isLiveStateNewerThanBundle,
  createLiveStateTracker,
  summarizeRelayTablets,
  applyRelayTablets,
  matchTeamNames,
  fetchRelayConnections,
  setRelayDevice,
  subscribeMessage,
  subscribeToMatchData,
  rememberMatchAccess,
  forgetMatchAccess,
  matchAccessFor,
  matchAccessHeaders,
  validatePinSupabase,
  getMatchData,
  uploadRosterToCloud
} from '../serverDataSync'

const SEED = 'match_1791215210058_yxkc82'

describe('relay key and payload (scorer)', () => {
  it('publishes under the seed key, never the Dexie id every device starts at', () => {
    expect(relayMatchKey({ id: 1, seed_key: SEED })).toBe(SEED)
    // A test match carries seedKey (the relays key by seed_key ?? seedKey too)
    expect(relayMatchKey({ id: 1, seedKey: 'test-match-default' })).toBe('test-match-default')
    // A blank match before Create Match has none: not published
    expect(relayMatchKey({ id: 1 })).toBeNull()
    expect(relayMatchKey({ id: 1, seed_key: '  ' })).toBeNull()
    expect(relayMatchKey(null)).toBeNull()
  })

  it('stamps the sync with the scorer\'s clock (tablets compare live-state pushes with it)', () => {
    expect(relayMatchPayload({ id: 1, seed_key: SEED }, null, { now: 1234 }).match._syncedAt).toBe(1234)
  })

  it('stamps the sync with the live-state order marked before the reads', () => {
    const { match } = relayMatchPayload({ id: 1, seed_key: SEED }, null, { now: 9999, mark: { seq: 7, session: 's1', at: 1234 } })
    expect(match).toMatchObject({ _syncedSeq: 7, _syncSession: 's1', _syncedAt: 1234 })
    // No mark: no order (a stale one in the stored match is not passed on)
    const plain = relayMatchPayload({ id: 1, seed_key: SEED, _syncedSeq: 3, _syncSession: 'old' }, null, { now: 5 }).match
    expect(plain._syncedSeq).toBeUndefined()
    expect(plain._syncSession).toBeUndefined()
    expect(plain._syncedAt).toBe(5)
  })

  it('sends the PINs with the first sync of a socket and when one changes, never otherwise', () => {
    const match = {
      id: 1, seed_key: SEED, status: 'live',
      gamePin: '517102', refereePin: '314159', homeTeamPin: '271828', awayTeamPin: '161803',
      homeTeamUploadPin: '141421', awayTeamUploadPin: '173205',
      game_pin: '517102', connection_pins: { referee: '314159' }
    }
    const first = relayMatchPayload(match, null)
    expect(first.match).toMatchObject({ gamePin: '517102', refereePin: '314159', homeTeamPin: '271828' })
    expect(first.match.game_pin).toBeUndefined()
    expect(first.match.connection_pins).toBeUndefined()

    const again = relayMatchPayload({ ...match, status: 'interval' }, first.pinSignature)
    expect(again.pinSignature).toBe(first.pinSignature)
    expect(again.match.status).toBe('interval')
    for (const k of ['gamePin', 'refereePin', 'homeTeamPin', 'awayTeamPin', 'homeTeamUploadPin', 'awayTeamUploadPin', 'game_pin', 'connection_pins']) {
      expect(again.match).not.toHaveProperty(k)
    }

    // An edited PIN goes out (all PIN fields, so the relay replaces them)
    const changed = relayMatchPayload({ ...match, refereePin: '565656' }, first.pinSignature)
    expect(changed.pinSignature).not.toBe(first.pinSignature)
    expect(changed.match.refereePin).toBe('565656')
    // A cleared PIN is sent as null, not left out (left out = keep the old one)
    const cleared = relayMatchPayload({ ...match, awayTeamPin: '' }, first.pinSignature)
    expect(cleared.match).toHaveProperty('awayTeamPin', null)
  })

  it('takes the game PIN from game_pin when gamePin is missing', () => {
    expect(relayMatchPayload({ id: 1, game_pin: '123456' }).match.gamePin).toBe('123456')
  })
})

describe('buildLiveStateMatchData (referee/bench view from match_live_state)', () => {
  const row = {
    id: 'uuid-1', external_id: SEED, game_n: 990202, status: 'live',
    home_team: { name: 'Home VC', short_name: 'HVC', color: '#111111' },
    away_team: { name: 'Away VC', short_name: 'AVC', color: '#222222' },
    players_home: [{ number: 3 }], players_away: [{ number: 6 }]
  }
  const live = (over = {}) => ({
    match_id: 'uuid-1', current_set: 1, team_a_name: 'Home VC', team_b_name: 'Away VC',
    side_a: 'left', points_a: 3, points_b: 1, sets_won_a: 0, sets_won_b: 0,
    serving_team: 'left',
    lineup_a: { I: { number: 4 }, II: { number: 3 }, III: { number: 2 }, IV: { number: 5 }, V: { number: 6 }, VI: { number: 7 } },
    lineup_b: { I: { number: 4 }, II: { number: 3 }, III: { number: 2 }, IV: { number: 5 }, V: { number: 6 }, VI: { number: 7 } },
    updated_at: '2026-10-05T16:02:20.900Z',
    ...over
  })

  it('maps score, server and team names, marked as built from live state', () => {
    const out = buildLiveStateMatchData(row, live(), SEED)
    expect(out.success).toBe(true)
    expect(out.source).toBe('live_state')
    expect(out.match.id).toBe(SEED)
    expect(out.match.homeName).toBe('Home VC')
    expect(out.sets[0]).toMatchObject({ index: 1, homePoints: 3, awayPoints: 1, servingTeam: 'home', serverNumber: 4 })
    expect(out.homePlayers).toEqual([{ number: 3 }])
  })

  it('after a side-out the rotation row puts the receiving team\'s new server in position I', () => {
    // 3:2, B (away, right side) won the rally and rotated: #3 now serves
    const rotated = live({
      points_b: 2, serving_team: 'right', last_event_type: 'rotation',
      lineup_b: { I: { number: 3, isServing: true }, II: { number: 2 }, III: { number: 5 }, IV: { number: 6 }, V: { number: 7 }, VI: { number: 4 } },
      updated_at: '2026-10-05T16:02:20.980Z'
    })
    const out = buildLiveStateMatchData(row, rotated, SEED)
    expect(out.sets[0]).toMatchObject({ homePoints: 3, awayPoints: 2, servingTeam: 'away', serverNumber: 3 })
    const awayLineup = out.events.find((e) => e.type === 'lineup' && e.payload.team === 'away')
    expect(awayLineup.payload.lineup.I.number).toBe(3)
  })

  it('is idempotent on its own output (the referee re-applies pushed rows onto it)', () => {
    const first = buildLiveStateMatchData(row, live(), SEED)
    const again = buildLiveStateMatchData(first.match, live({ points_a: 4 }), SEED)
    expect(again.match.homeName).toBe('Home VC')
    expect(again.match.gameNumber).toBe('990202')
    expect(again.sets[0].homePoints).toBe(4)
  })

  it('orders rows by updated_at', () => {
    expect(isNewerLiveState({ updated_at: '2026-10-05T16:02:21Z' }, null)).toBe(true)
    expect(isNewerLiveState({ updated_at: '2026-10-05T16:02:21Z' }, '2026-10-05T16:02:20Z')).toBe(true)
    expect(isNewerLiveState({ updated_at: '2026-10-05T16:02:19Z' }, '2026-10-05T16:02:20Z')).toBe(false)
    expect(isNewerLiveState({ updated_at: '2026-10-05T16:02:20Z' }, '2026-10-05T16:02:20Z')).toBe(false)
    expect(isNewerLiveState({ updated_at: '2026-10-05T16:02:20Z' }, '2026-10-05T16:02:20Z', { allowEqual: true })).toBe(true)
    expect(isNewerLiveState({}, '2026-10-05T16:02:20Z')).toBe(true)
  })
})

describe('tablet status from the relay', () => {
  const connections = {
    totalClients: 9,
    dashboardClients: 3,
    clients: [
      { role: 'referee', team: null, matchId: SEED },
      { role: 'bench', team: 'home', matchId: SEED },
      { role: 'livescore', team: null, matchId: SEED },
      { role: 'referee', team: null, matchId: 'match_other' }
    ],
    matchSubscriptions: { [SEED]: 3 }
  }

  it('counts only this match\'s subscribers, by device', () => {
    expect(summarizeRelayTablets(connections, SEED)).toEqual({ referee: 1, benchHome: 1, benchAway: 0, watchers: 3 })
    expect(summarizeRelayTablets(null, SEED)).toEqual({ referee: 0, benchHome: 0, benchAway: 0, watchers: 0 })
  })

  it('attributes a bench without a team when only one bench is enabled', () => {
    const c = { clients: [{ role: 'bench', team: null, matchId: SEED }] }
    expect(summarizeRelayTablets(c, SEED, { homeTeamConnectionEnabled: false, awayTeamConnectionEnabled: true }).benchAway).toBe(1)
    expect(summarizeRelayTablets(c, SEED, { homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: true })).toMatchObject({ benchHome: 0, benchAway: 0 })
  })

  it('turns the heartbeat summary green for tablets the relay sees', () => {
    const summary = {
      roles: [
        { role: 'referee', status: 'disconnected', color: '#ef4444', ageMs: null },
        { role: 'bench_home', status: 'disconnected', color: '#ef4444', ageMs: null }
      ],
      overallStatus: 'issues', connectedCount: 0, expectedCount: 2
    }
    const merged = applyRelayTablets(summary, summarizeRelayTablets(connections, SEED))
    expect(merged.connectedCount).toBe(2)
    expect(merged.overallStatus).toBe('ok')
    const onlyRef = applyRelayTablets(summary, { referee: 1, benchHome: 0, benchAway: 0 })
    expect(onlyRef.connectedCount).toBe(1)
    expect(onlyRef.overallStatus).toBe('issues')
  })

  it('asks the configured backend, and treats an HTML answer (SPA fallback) as unreachable', async () => {
    const html = vi.fn(async () => ({ ok: true, headers: { get: () => 'text/html' }, json: async () => { throw new Error('html') } }))
    expect(await fetchRelayConnections('match_html_case', { fetchImpl: html })).toBeNull()
    const url = html.mock.calls[0][0]
    expect(url).toContain('/api/server/connections?matchId=match_html_case')
    expect(url.startsWith('http')).toBe(true)

    const json = vi.fn(async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => connections }))
    expect(await fetchRelayConnections('match_json_case', { fetchImpl: json })).toEqual(connections)
    // several pollers share one request
    await fetchRelayConnections('match_json_case', { fetchImpl: json })
    expect(json).toHaveBeenCalledTimes(1)
  })
})

describe('matchTeamNames', () => {
  it('reads every shape the tablets and the scorer see', () => {
    expect(matchTeamNames({ homeName: 'Dexie H', awayName: 'Dexie A' })).toEqual({ home: 'Dexie H', away: 'Dexie A' })
    expect(matchTeamNames({ homeTeam: 'Cloud H', awayTeam: 'Cloud A' })).toEqual({ home: 'Cloud H', away: 'Cloud A' })
    expect(matchTeamNames({ home_team: { name: 'Row H' }, away_team: { name: 'Row A' } })).toEqual({ home: 'Row H', away: 'Row A' })
    expect(matchTeamNames({ homeTeamName: 'List H', awayTeamName: 'List A' })).toEqual({ home: 'List H', away: 'List A' })
    expect(matchTeamNames({}, { homeTeam: { name: 'Bundle H' }, awayTeam: { name: 'Bundle A' } })).toEqual({ home: 'Bundle H', away: 'Bundle A' })
    expect(matchTeamNames(null)).toEqual({ home: null, away: null })
  })
})

describe('relay subscription (tablets)', () => {
  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    static instances = []
    constructor(url) {
      this.url = url
      this.readyState = FakeWebSocket.CONNECTING
      this.sent = []
      FakeWebSocket.instances.push(this)
    }
    send(text) { this.sent.push(JSON.parse(text)) }
    close() { this.readyState = FakeWebSocket.CLOSED }
    open() {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    }
    receive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  }
  let realWs

  beforeEach(() => {
    vi.useFakeTimers()
    realWs = globalThis.WebSocket
    globalThis.WebSocket = FakeWebSocket
    FakeWebSocket.instances = []
  })
  afterEach(() => {
    globalThis.WebSocket = realWs
    setRelayDevice(null)
    forgetMatchAccess()
    vi.useRealTimers()
  })

  it('subscribes with the PIN and match token of the PIN check, so the relay hands out the bundle', () => {
    setRelayDevice('referee')
    rememberMatchAccess(SEED, { pin: '314159', token: 'v1.payload.sig' })
    expect(subscribeMessage(SEED)).toEqual({ type: 'subscribe-match', matchId: SEED, device: 'referee', pin: '314159', token: 'v1.payload.sig' })
    // Another match: nothing
    expect(subscribeMessage('match_other')).toEqual({ type: 'subscribe-match', matchId: 'match_other', device: 'referee' })
    forgetMatchAccess(SEED)
    expect(subscribeMessage(SEED)).toEqual({ type: 'subscribe-match', matchId: SEED, device: 'referee' })
  })

  it('a summary (no PIN proved) never replaces the bundle; its live state still counts', () => {
    const updates = []
    const unsubscribe = subscribeToMatchData('match_summary', (p) => updates.push(p))
    const ws = FakeWebSocket.instances.at(-1)
    ws.open()
    // Before any bundle: a summary shows nothing
    ws.receive({ type: 'match-full-data', matchId: 'match_summary', access: 'summary', match: { id: 1, status: 'live' }, homePlayers: [], sets: [], events: [] })
    expect(updates).toHaveLength(0)
    ws.receive({ type: 'match-full-data', matchId: 'match_summary', access: 'full', match: { id: 1, status: 'live' }, homePlayers: [{ number: 7 }], sets: [], events: [{ id: 1 }] })
    expect(updates.at(-1).homePlayers).toEqual([{ number: 7 }])
    ws.receive({
      type: 'match-data-update', matchId: 'match_summary', access: 'summary',
      match: { id: 1, status: 'live' }, homePlayers: [], sets: [], events: [],
      liveState: { current_set: 1, points_a: 3, points_b: 1, updated_at: new Date().toISOString() }
    })
    expect(updates.at(-1).homePlayers).toEqual([{ number: 7 }])
    expect(updates.at(-1).events).toEqual([{ id: 1 }])
    expect(updates.at(-1).liveState.points_a).toBe(3)
    unsubscribe()
  })

  it('labels the subscription with the device and team', () => {
    setRelayDevice('bench', 'home')
    expect(subscribeMessage(SEED)).toEqual({ type: 'subscribe-match', matchId: SEED, device: 'bench', team: 'home' })
    setRelayDevice('referee')
    expect(subscribeMessage(SEED)).toEqual({ type: 'subscribe-match', matchId: SEED, device: 'referee' })
    setRelayDevice(null)
    expect(subscribeMessage(7)).toEqual({ type: 'subscribe-match', matchId: '7' })
  })

  it('replaces a socket that stops answering and resubscribes (fresh snapshot after a network drop)', () => {
    setRelayDevice('referee')
    const updates = []
    const unsubscribe = subscribeToMatchData('match_watchdog', (p) => updates.push(p))
    const first = FakeWebSocket.instances.at(-1)
    first.open()
    expect(first.sent[0]).toEqual({ type: 'subscribe-match', matchId: 'match_watchdog', device: 'referee' })
    first.receive({ type: 'match-full-data', matchId: 'match_watchdog', match: { id: 'match_watchdog' }, sets: [] })
    expect(updates).toHaveLength(1)

    // A ping that is answered keeps the socket
    vi.advanceTimersByTime(25000)
    expect(first.sent.at(-1).type).toBe('ping')
    first.receive({ type: 'pong' })
    vi.advanceTimersByTime(10000)
    expect(FakeWebSocket.instances).toHaveLength(1)

    // Silence after a ping (Wi-Fi dropped without a close frame): replaced
    vi.advanceTimersByTime(15000)
    vi.advanceTimersByTime(10000)
    vi.advanceTimersByTime(300)
    expect(FakeWebSocket.instances).toHaveLength(2)
    const second = FakeWebSocket.instances.at(-1)
    second.open()
    expect(second.sent[0]).toMatchObject({ type: 'subscribe-match', matchId: 'match_watchdog' })
    unsubscribe()
  })

  it('reconnects at once when the network comes back', () => {
    const unsubscribe = subscribeToMatchData('match_online', () => {})
    const first = FakeWebSocket.instances.at(-1)
    first.open()
    first.readyState = FakeWebSocket.CLOSED // dropped; its reconnect is still backing off
    window.dispatchEvent(new Event('online'))
    expect(FakeWebSocket.instances).toHaveLength(2)
    unsubscribe()
  })

  it('shows a live-state push newer than the relay copy, and never an older one', () => {
    const updates = []
    const unsubscribe = subscribeToMatchData('match_newest', (p) => updates.push(p))
    const ws = FakeWebSocket.instances.at(-1)
    ws.open()
    const at = (ms) => new Date(Date.UTC(2026, 9, 5, 18, 6, 0) + ms).toISOString()
    const syncedAt = Date.parse(at(0))
    ws.receive({
      type: 'match-full-data', matchId: 'match_newest',
      match: { id: 1, coinTossTeamA: 'away', _syncedAt: syncedAt },
      sets: [{ index: 1, homePoints: 0, awayPoints: 0, finished: false }]
    })
    // Point for team A (= away): pushed before the scorer's sync landed
    ws.receive({ type: 'live-state-update', matchId: 'match_newest', liveState: { current_set: 1, points_a: 1, points_b: 0, updated_at: at(800) } })
    expect(updates.at(-1).sets[0]).toMatchObject({ homePoints: 0, awayPoints: 1 })
    expect(updates.at(-1).liveState.points_a).toBe(1)
    // An older push arriving late changes nothing
    const count = updates.length
    ws.receive({ type: 'live-state-update', matchId: 'match_newest', liveState: { current_set: 1, points_a: 0, points_b: 0, updated_at: at(400) } })
    expect(updates).toHaveLength(count)
    // The scorer's next sync (newer than the push) is shown as it is
    ws.receive({
      type: 'match-data-update', matchId: 'match_newest',
      match: { id: 1, coinTossTeamA: 'away', _syncedAt: Date.parse(at(900)) },
      sets: [{ index: 1, homePoints: 0, awayPoints: 1, finished: false }],
      liveState: { current_set: 1, points_a: 1, points_b: 0, updated_at: at(800) }
    })
    expect(updates.at(-1).sets[0]).toMatchObject({ homePoints: 0, awayPoints: 1 })
    unsubscribe()
  })
})

describe('match access after the PIN step', () => {
  let realFetch
  beforeEach(() => { realFetch = globalThis.fetch })
  afterEach(() => {
    globalThis.fetch = realFetch
    forgetMatchAccess()
  })
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } })

  it('a successful cloud PIN check remembers the PIN and the match token', async () => {
    globalThis.fetch = vi.fn(async () => json({ success: true, token: 'v1.tok.sig', match: { id: SEED, gameNumber: 12 } }))
    const r = await validatePinSupabase('314159', 'referee')
    expect(r).toMatchObject({ success: true, token: 'v1.tok.sig' })
    expect(matchAccessFor(SEED)).toEqual({ pin: '314159', token: 'v1.tok.sig' })
    expect(matchAccessHeaders(SEED)).toEqual({ 'X-OV-Match-Token': 'v1.tok.sig', 'X-OV-Match-Pin': '314159' })
    // A failed one remembers nothing
    forgetMatchAccess()
    globalThis.fetch = vi.fn(async () => json({ success: false, error: 'Invalid PIN code' }, 404))
    await validatePinSupabase('000000', 'referee')
    expect(matchAccessFor(SEED)).toBeNull()
  })

  it('getMatchData sends the access headers; a summary after the PIN step falls back to the API with the token', async () => {
    rememberMatchAccess(SEED, { pin: '314159', token: 'v1.tok.sig' })
    const calls = []
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/api/match/')) return json({ success: true, access: 'summary', match: { id: 1 }, homePlayers: [], sets: [], events: [] })
      return json({ data: null, error: null })
    })
    await getMatchData(SEED)
    expect(calls[0].init.headers['X-OV-Match-Pin']).toBe('314159')
    expect(calls[0].init.headers['X-OV-Match-Token']).toBe('v1.tok.sig')
    const dbCall = calls.find((c) => c.url.endsWith('/api/db'))
    expect(dbCall).toBeTruthy()
    expect(dbCall.init.headers['X-OV-Match-Token']).toBe('v1.tok.sig')
  })

  it('before the PIN step the summary is the answer (match link: game number only)', async () => {
    globalThis.fetch = vi.fn(async () => json({ success: true, access: 'summary', match: { id: 1, gameNumber: 12 }, homePlayers: [], sets: [], events: [] }))
    const r = await getMatchData('match_nolink')
    expect(r).toMatchObject({ success: true, access: 'summary' })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('uploadRosterToCloud sends the upload PIN, roster and signatures to the PIN-authorised endpoint', async () => {
    const fetchImpl = vi.fn(async () => json({ success: true }))
    const r = await uploadRosterToCloud(SEED, 'home', ' 975310 ', { players: [{ number: 1 }], bench: [], coachSignature: 'sig-c', captainSignature: null, timestamp: 't' }, { fetchImpl })
    expect(r.success).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/match\/upload-roster$/)
    expect(init.headers.Authorization).toBeUndefined()
    expect(JSON.parse(init.body)).toEqual({
      matchExternalId: SEED, team: 'home', pin: '975310',
      roster: { players: [{ number: 1 }], bench: [], timestamp: 't' }, coachSignature: 'sig-c', captainSignature: null
    })
    const refused = await uploadRosterToCloud(SEED, 'home', '000000', { players: [] }, { fetchImpl: vi.fn(async () => json({ success: false, error: 'Invalid upload PIN' }, 403)) })
    expect(refused).toEqual({ success: false, status: 403, error: 'Invalid upload PIN' })
  })
})

describe('newest live state wins over an older relay copy (referee / bench)', () => {
  const T0 = Date.UTC(2026, 9, 5, 18, 6, 0)
  const iso = (ms) => new Date(T0 + ms).toISOString()
  const bundle = (over = {}) => ({
    success: true,
    match: { id: 1, coinTossTeamA: 'home', _syncedAt: T0 },
    sets: [
      { index: 1, homePoints: 25, awayPoints: 20, finished: true },
      { index: 2, homePoints: 3, awayPoints: 4, finished: false }
    ],
    ...over
  })

  it('takes the newer live state, unless the incoming one is older', () => {
    const a = { updated_at: iso(1000) }
    const b = { updated_at: iso(2000) }
    expect(newerLiveState(a, b)).toBe(b)
    expect(newerLiveState(b, a)).toBe(b)
    expect(newerLiveState(null, a)).toBe(a)
    expect(newerLiveState(a, null)).toBe(a)
    expect(newerLiveState(a, { points_a: 1 })).toEqual({ points_a: 1 }) // no timestamp: newer
  })

  it('puts a newer live state\'s points on the set it names (team A/B mapped to home/away)', () => {
    const live = { current_set: 2, points_a: 5, points_b: 4, updated_at: iso(500) }
    const out = applyNewerLiveState(bundle(), live)
    expect(out.sets[1]).toMatchObject({ index: 2, homePoints: 5, awayPoints: 4 })
    expect(out.sets[0]).toMatchObject({ homePoints: 25, awayPoints: 20 })
    expect(out.liveState).toBe(live)
    const awayIsA = applyNewerLiveState(bundle({ match: { id: 1, coinTossTeamA: 'away', _syncedAt: T0 } }), live)
    expect(awayIsA.sets[1]).toMatchObject({ homePoints: 4, awayPoints: 5 })
  })

  it('leaves the relay copy alone when it is newer, from an older scorer, or the set is over', () => {
    const b = bundle()
    expect(applyNewerLiveState(b, { current_set: 2, points_a: 9, points_b: 9, updated_at: iso(-500) })).toBe(b)
    const noStamp = bundle({ match: { id: 1, coinTossTeamA: 'home' } })
    expect(applyNewerLiveState(noStamp, { current_set: 2, points_a: 9, points_b: 9, updated_at: iso(500) })).toBe(noStamp)
    // Set 1 is finished: its result is the relay's
    expect(applyNewerLiveState(b, { current_set: 1, points_a: 0, points_b: 0, updated_at: iso(500) }).sets[0]).toMatchObject({ homePoints: 25 })
    // The bundle's own live state by default
    expect(applyNewerLiveState(bundle({ liveState: { current_set: 2, points_a: 4, points_b: 4, updated_at: iso(1) } })).sets[1]).toMatchObject({ homePoints: 4, awayPoints: 4 })
  })
})

describe('live-state order: sequence numbers, not the scorer\'s wall clock', () => {
  const T0 = Date.UTC(2026, 9, 5, 18, 6, 0)
  const iso = (ms) => new Date(T0 + ms).toISOString()
  const live = (seq, ms, points, session = 'S') => ({ current_set: 1, points_a: points, points_b: 0, updated_at: iso(ms), _seq: seq, _session: session })
  const bundle = (syncedSeq, syncedAtMs, points, extra = {}) => ({
    success: true,
    match: { id: 1, coinTossTeamA: 'home', _syncedSeq: syncedSeq, _syncSession: 'S', _syncedAt: T0 + syncedAtMs },
    sets: [{ index: 1, homePoints: points, awayPoints: 0, finished: false }],
    ...extra
  })

  it('orders one session by sequence even when the clock stepped back', () => {
    const beforeStep = live(10, 60000, 10) // clock ahead
    const afterStep = live(11, 1000, 11) // clock stepped back by NTP
    expect(newerLiveState(beforeStep, afterStep)).toBe(afterStep)
    expect(newerLiveState(afterStep, beforeStep)).toBe(afterStep)
    // Another session (a reload): by updated_at
    const other = live(1, 2000, 12, 'T')
    expect(newerLiveState(beforeStep, other)).toBe(beforeStep)
    // A database row (no order): by updated_at
    expect(newerLiveState(beforeStep, { ...afterStep, _seq: undefined, _session: undefined })).toBe(beforeStep)
  })

  it('a bundle read after a live state outranks it, whatever the clocks say', () => {
    // Live state 10 stamped before the step, bundle marked at seq 11 after it
    expect(isLiveStateNewerThanBundle(live(10, 60000, 10), bundle(11, 2000, 12))).toBe(false)
    expect(applyNewerLiveState(bundle(11, 2000, 12), live(10, 60000, 10)).sets[0].homePoints).toBe(12)
    // Live state 12 computed after that bundle was read: its score wins
    expect(isLiveStateNewerThanBundle(live(12, 2500, 13), bundle(11, 3000, 12))).toBe(true)
    expect(applyNewerLiveState(bundle(11, 3000, 12), live(12, 2500, 13)).sets[0].homePoints).toBe(13)
    // Equal: the live state was numbered before the reads began, the bundle has it
    expect(isLiveStateNewerThanBundle(live(11, 9000, 13), bundle(11, 0, 12))).toBe(false)
  })

  it('the tablet drops a state kept from before a clock step once a later bundle arrives', () => {
    const tracker = createLiveStateTracker()
    // Before the step: push 10 at T+60 s
    expect(tracker.bundle(bundle(9, 59000, 9, { liveState: live(10, 60000, 10) })).sets[0].homePoints).toBe(10)
    // After the step: the scorer's next sync (mark 12) with points 12, its stored live state 11
    const shown = tracker.bundle(bundle(12, 3000, 12, { liveState: live(11, 2000, 11) }))
    expect(shown.sets[0].homePoints).toBe(12)
    // Later bundles never get the old score written over them again
    expect(tracker.bundle(bundle(13, 4000, 13)).sets[0].homePoints).toBe(13)
    // Covered by that bundle: nothing kept that could roll a score back
    expect(tracker.newest).toBeNull()
  })

  it('a database row newer than the relay copy is shown over it', () => {
    const tracker = createLiveStateTracker()
    tracker.bundle({ success: true, match: { id: 1, coinTossTeamA: 'home', _syncedAt: T0 }, sets: [{ index: 1, homePoints: 3, awayPoints: 0, finished: false }] })
    expect(tracker.liveState({ current_set: 1, points_a: 4, points_b: 0, updated_at: iso(100) })).toBe(true)
    expect(tracker.bundle(tracker.lastBundle).sets[0].homePoints).toBe(4)
    // An older row changes nothing
    expect(tracker.liveState({ current_set: 1, points_a: 2, points_b: 0, updated_at: iso(50) })).toBe(false)
    // Results built from a live-state row pass through
    const fromRow = { success: true, source: 'live_state', sets: [] }
    expect(tracker.bundle(fromRow)).toBe(fromRow)
  })
})
