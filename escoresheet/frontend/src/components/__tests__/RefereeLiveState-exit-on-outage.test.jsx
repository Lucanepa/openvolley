// During a network or relay outage every refetch of the referee fails
// (getMatchData answers { success: false }). The referee keeps the match and
// its PIN (onExit clears them in RefereeApp); it leaves only when the relay
// and the database both say the match is gone (notFound).
import { describe, it, expect, vi } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en', changeLanguage: () => {} } })
}))
vi.mock('../../i18n', () => ({ default: { language: 'en', changeLanguage: () => {} } }))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../../hooks/useSyncQueue', () => ({
  useSyncQueue: () => ({ syncStatus: 'idle', retryErrors: vi.fn() }),
  useSyncQueueStats: () => ({})
}))
vi.mock('../../lib/supabaseClient', () => ({ supabase: null }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }
    return q
  }
}))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (v) => v * 10, scaleFactor: 1 }) }))
vi.mock('../../components/WsDebugOverlay', () => ({ default: () => null }))
const relay = vi.hoisted(() => ({ fetches: [] }))
vi.mock('../../utils/serverDataSync', async (importOriginal) => ({
  ...(await importOriginal()),
  getMatchData: () => new Promise(res => relay.fetches.push(res)),
  subscribeToMatchData: () => () => {},
  listAvailableMatches: async () => ({ success: true, matches: [] }),
  getWebSocketStatus: () => 'connected',
  forceReconnect: vi.fn()
}))
vi.mock('../../hooks/useRealtimeConnection', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    useRealtimeConnection: () => ({ status: real.CONNECTION_STATUS.CONNECTED, activeConnection: 'websocket', error: null, lastUpdate: null, forceReconnect: vi.fn() })
  }
})
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

const { default: Referee } = await import('../../components/Referee')

const good = {
  success: true,
  match: { id: 'match_seed', status: 'live', coinTossTeamA: 'home', firstServe: 'home', bestOf: 5 },
  homeTeam: { name: 'Home' }, awayTeam: { name: 'Away' },
  homePlayers: [], awayPlayers: [],
  sets: [{ index: 1, homePoints: 12, awayPoints: 10, finished: false }],
  events: []
}

describe('referee during an outage', () => {
  it('keeps the match through failed refreshes, leaves on a positive not-found', async () => {
    const onExit = vi.fn()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
    render(<Referee matchId="match_seed" onExit={onExit} isMasterMode={false} />)
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
    await act(async () => { for (const res of relay.fetches.splice(0)) res(good) })
    // the hall uplink drops: three refreshes (here: 'online' events; Refresh taps and wake-ups call the same fetch)
    for (let i = 0; i < 3; i++) {
      await act(async () => { window.dispatchEvent(new Event('online')) })
      await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
      await act(async () => { for (const res of relay.fetches.splice(0)) res({ success: false, error: 'Failed to fetch' }) })
    }
    expect(onExit).not.toHaveBeenCalled()
    for (let i = 0; i < 3; i++) {
      await act(async () => { window.dispatchEvent(new Event('online')) })
      await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
      await act(async () => { for (const res of relay.fetches.splice(0)) res({ success: false, error: 'Match not found', notFound: true }) })
    }
    expect(onExit).toHaveBeenCalled()
  })

  it('goes back to the PIN page when the relay falls back to the summary after a full bundle', async () => {
    const onExit = vi.fn()
    render(<Referee matchId="match_seed" onExit={onExit} isMasterMode={false} />)
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
    await act(async () => { for (const res of relay.fetches.splice(0)) res({ ...good, access: 'full' }) })
    expect(onExit).not.toHaveBeenCalled()
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
    await act(async () => { for (const res of relay.fetches.splice(0)) res({ ...good, access: 'summary', homePlayers: [], awayPlayers: [], events: [] }) })
    expect(onExit).toHaveBeenCalledWith('access_lost')
  })
})
