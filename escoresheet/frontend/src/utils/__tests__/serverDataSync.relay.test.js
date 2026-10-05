import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  relayMatchKey,
  relayMatchPayload,
  buildLiveStateMatchData,
  isNewerLiveState,
  summarizeRelayTablets,
  applyRelayTablets,
  matchTeamNames,
  fetchRelayConnections,
  setRelayDevice,
  subscribeMessage,
  subscribeToMatchData
} from '../serverDataSync'

const SEED = 'match_1791215210058_yxkc82'

describe('relay key and payload (scorer)', () => {
  it('publishes under the seed key, not the Dexie id every device starts at', () => {
    expect(relayMatchKey({ id: 1, seed_key: SEED }, 1)).toBe(SEED)
    expect(relayMatchKey({ id: 1 }, 1)).toBe('1') // test match without a seed key
    expect(relayMatchKey(null, 7)).toBe('7')
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
    vi.useRealTimers()
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
})
