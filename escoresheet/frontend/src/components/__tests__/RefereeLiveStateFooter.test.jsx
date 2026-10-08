import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'

// The referee following through the cloud: a point's first news is the
// match_live_state row. Its score waits for the scorer's bundle (tracker.hold,
// one update with the server and the rotation), and so does its "Last
// action". The refetch the row starts brings that bundle within the hold and
// cancels it. OpenBeach lost the footer there (a1d44a5): its bundle path never
// set the last action. Here the bundle path reads the last action from what it
// loads (lastEventFromMatchData); this pins that it shows with the bundle.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en', changeLanguage: () => {} } })
}))
vi.mock('../../i18n', () => ({ default: { language: 'en', changeLanguage: () => {} } }))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../../hooks/useSyncQueue', () => ({
  useSyncQueue: () => ({ syncStatus: 'idle', retryErrors: vi.fn() }),
  useSyncQueueStats: () => ({})
}))

// The database's realtime channel: the test delivers its rows
const cloud = vi.hoisted(() => ({ onRow: null }))
vi.mock('../../lib/supabaseClient', () => {
  const channel = {
    on: (_kind, _filter, cb) => { cloud.onRow = cb; return channel },
    subscribe: (cb) => { if (cb) cb('SUBSCRIBED'); return channel }
  }
  return { supabase: { channel: () => channel, removeChannel: () => {} } }
})
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: '00000000-0000-4000-8000-000000000001' }, error: null }) }
    return q
  }
}))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (v) => v * 10, scaleFactor: 1 }) }))
vi.mock('../WsDebugOverlay', () => ({ default: () => null }))

// Each refetch resolves when the test says so; the tracker is the real one
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
    useRealtimeConnection: () => ({
      status: real.CONNECTION_STATUS.CONNECTED,
      activeConnection: 'websocket',
      error: null,
      lastUpdate: null,
      forceReconnect: vi.fn()
    })
  }
})

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

const { default: Referee } = await import('../Referee')

const NOW = Date.now()
const at = (ms) => new Date(NOW + ms).toISOString()
const live = (ms, a, b, extra = {}) => ({ updated_at: at(ms), current_set: 1, points_a: a, points_b: b, match_status: 'live', ...extra })

function bundle(homePoints, awayPoints, liveState) {
  return {
    success: true,
    match: { id: 'match_seed', status: 'live', coinTossTeamA: 'home', firstServe: 'home' },
    homeTeam: { name: 'Home', color: '#ef4444' },
    awayTeam: { name: 'Away', color: '#3b82f6' },
    homePlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `H${n}` })),
    awayPlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `A${n}` })),
    sets: [{ index: 1, homePoints, awayPoints, finished: false }],
    events: [],
    liveState
  }
}

// The big score: the two digits around the ':' of the score row
function shownScore() {
  const box = document.querySelector('[data-score]')
  if (!box) return null
  const [left, , right] = box.children
  return `${left.textContent}:${right.textContent}`
}

const footerPoint = () => screen.queryByText('refereeDashboard.events.point', { exact: false })

// Data updates are applied at most every 150 ms (anti-flicker debounce)
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 200)) })

describe('Referee: a database-row point reaches the footer', () => {
  beforeEach(() => {
    relay.fetches = []
    cloud.onRow = null
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
  })

  it('the last action shows with the bundle that ends the hold', async () => {
    render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
    await act(async () => { for (const res of relay.fetches) res(bundle(10, 8, live(0, 10, 8))) })
    await settle()
    await waitFor(() => expect(cloud.onRow).toBeTypeOf('function'))
    await waitFor(() => expect(shownScore()).toBe('10:8'))
    expect(footerPoint()).toBeNull()

    // The point arrives as the database row: score and footer wait together
    const before = relay.fetches.length
    const row = live(1000, 11, 8, { last_event_type: 'point', last_event_team: 'home' })
    await act(async () => { cloud.onRow({ new: row }) })
    expect(shownScore()).toBe('10:8')
    expect(footerPoint()).toBeNull()

    // The refetch the row started brings the scorer's bundle within the hold
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(before))
    await act(async () => { relay.fetches[relay.fetches.length - 1](bundle(11, 8, row)) })
    await settle()
    expect(shownScore()).toBe('11:8')
    expect(footerPoint()).not.toBeNull()

    // ... and stays once the hold would have run out
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })
    expect(footerPoint()).not.toBeNull()
  })
})
