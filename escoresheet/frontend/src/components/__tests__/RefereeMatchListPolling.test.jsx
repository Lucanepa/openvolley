import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'

// The referee's connection chips ("server connected") come from
// GET /api/match/list, on mount and every 60 s. The check was a useCallback on
// data.match, and every relay bundle (two per rally) builds a new match
// object: the effect ran again on every bundle and called the list each time.
// On the cloud that list holds every published match (about 140 KB at a
// national peak) and it spends the venue's shared relay-read budget.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en', changeLanguage: () => {} } })
}))
vi.mock('../../i18n', () => ({ default: { language: 'en', changeLanguage: () => {} } }))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../../hooks/useSyncQueue', () => ({
  useSyncQueue: () => ({ syncStatus: 'idle', retryErrors: vi.fn() }),
  useSyncQueueStats: () => ({})
}))
vi.mock('../../lib/supabaseClient', () => {
  const channel = { on: () => channel, subscribe: (cb) => { if (cb) cb('SUBSCRIBED'); return channel } }
  return { supabase: { channel: () => channel, removeChannel: () => {} } }
})
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }
    return q
  }
}))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (v) => v * 10, scaleFactor: 1 }) }))
vi.mock('../WsDebugOverlay', () => ({ default: () => null }))

const relay = vi.hoisted(() => ({ fetches: [], listCalls: 0, onData: null }))
vi.mock('../../utils/serverDataSync', async (importOriginal) => ({
  ...(await importOriginal()),
  getMatchData: () => new Promise(res => relay.fetches.push(res)),
  subscribeToMatchData: () => () => {},
  listAvailableMatches: async () => { relay.listCalls++; return { success: true, matches: [] } },
  getWebSocketStatus: () => 'connected',
  forceReconnect: vi.fn()
}))
vi.mock('../../hooks/useRealtimeConnection', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    useRealtimeConnection: ({ onData }) => {
      relay.onData = onData
      return { status: real.CONNECTION_STATUS.CONNECTED, activeConnection: 'websocket', error: null, lastUpdate: null, forceReconnect: vi.fn() }
    }
  }
})

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

const { default: Referee } = await import('../Referee')

// A relay bundle as the scorer sends it: freshly parsed, so every object is new
function bundle(homePoints, status = 'live') {
  return {
    success: true,
    match: { id: 'match_seed', status, coinTossTeamA: 'home', firstServe: 'home', bestOf: 5 },
    homeTeam: { name: 'Home', color: '#ef4444' },
    awayTeam: { name: 'Away', color: '#3b82f6' },
    homePlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `H${n}` })),
    awayPlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `A${n}` })),
    sets: [{ index: 1, homePoints, awayPoints: 0, finished: false }],
    events: []
  }
}

// Past the referee's 150 ms bundle debounce
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 250)) })

describe('Referee: the match-list check does not follow the relay bundles', () => {
  beforeEach(() => {
    relay.fetches = []
    relay.listCalls = 0
    relay.onData = null
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
  })

  it('a stream of bundles calls GET /api/match/list no more than the mount did', async () => {
    render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
    await act(async () => { for (const res of relay.fetches) res(bundle(0)) })
    await settle()
    await waitFor(() => expect(relay.onData).toBeTypeOf('function'))
    const afterMount = relay.listCalls
    expect(afterMount).toBeGreaterThan(0)

    // ten rallies: a bundle each, every one with a new match object
    for (let p = 1; p <= 10; p++) {
      await act(async () => { relay.onData(bundle(p)) })
      await settle()
    }
    expect(relay.listCalls).toBe(afterMount)
  })

  it('the match chip still follows the match status', async () => {
    render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
    await act(async () => { for (const res of relay.fetches) res(bundle(0)) })
    await settle()
    await waitFor(() => expect(relay.onData).toBeTypeOf('function'))
    const afterMount = relay.listCalls
    // the status changes: the chips are worked out again (one more check)
    await act(async () => { relay.onData(bundle(25, 'final')) })
    await settle()
    expect(relay.listCalls).toBe(afterMount + 1)
  })
})
