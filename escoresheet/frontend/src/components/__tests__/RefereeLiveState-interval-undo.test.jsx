// The scorer undoes the point that ended set 1 (the set is reopened, 24:23).
// The referee closes the break countdown it started from the set_end action:
// the undo's live state row says there is no break.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor, cleanup } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en', changeLanguage: () => {} } })
}))
vi.mock('../../i18n', () => ({ default: { language: 'en', changeLanguage: () => {} } }))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../../hooks/useSyncQueue', () => ({
  useSyncQueue: () => ({ syncStatus: 'idle', retryErrors: vi.fn() }),
  useSyncQueueStats: () => ({})
}))
const cloud = vi.hoisted(() => ({ onRow: null, onAction: null }))
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
    useRealtimeConnection: ({ onAction }) => {
      cloud.onAction = onAction
      return { status: real.CONNECTION_STATUS.CONNECTED, activeConnection: 'websocket', error: null, lastUpdate: null, forceReconnect: vi.fn() }
    }
  }
})
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

const { default: Referee } = await import('../../components/Referee')

const base = { current_set: 1, sets_won_a: 0, sets_won_b: 0, side_a: 'left', serving_team: 'left', timeout_active: false, team_a_name: 'Home', team_b_name: 'Away' }
const bundle = (liveState, sets) => ({
  success: true,
  match: { id: 'match_seed', status: 'live', coinTossTeamA: 'home', firstServe: 'home', bestOf: 5 },
  homeTeam: { name: 'Home', color: '#ef4444' },
  awayTeam: { name: 'Away', color: '#3b82f6' },
  homePlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n })),
  awayPlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n })),
  sets,
  events: [],
  liveState
})
const breakClock = () => {
  const el = [...document.querySelectorAll('div')].find(d => d.children.length === 0 && /^\d:\d\d$/.test(d.textContent.trim()))
  return el ? el.textContent.trim() : null
}
const settle = (ms = 300) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

describe('referee after the scorer undid a set end', () => {
  beforeEach(() => {
    cleanup()
    sessionStorage.clear()
    relay.fetches = []
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
  })

  it('closes the INTERVAL countdown when the scorer undoes the set end', async () => {
    const t0 = Date.now()
    render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
    // 24:23 in set 1
    await act(async () => { for (const res of relay.fetches.splice(0)) res(bundle({ ...base, updated_at: new Date(t0).toISOString(), points_a: 24, points_b: 23, match_status: 'in_progress', set_interval_active: false, last_event_type: 'point' }, [{ index: 1, homePoints: 24, awayPoints: 23, finished: false }])) })
    await settle()
    // 25:23: the set ends, the break starts (relay action)
    await act(async () => { cloud.onAction('set_end', { setIndex: 1, winner: 'home', homePoints: 25, awayPoints: 23, countdown: 180, startTimestamp: Date.now(), homeSetsWon: 1, awaySetsWon: 0 }, { sentAt: Date.now() }) })
    await settle()
    expect(breakClock()).toMatch(/^[23]:\d\d$/)
    // The scorer undoes the set end: set 1 open again at 24:23; the undo's live state says no break
    const undo = bundle({ ...base, updated_at: new Date(t0 + 5000).toISOString(), points_a: 24, points_b: 23, match_status: 'in_progress', set_interval_active: false, last_event_type: 'undo' }, [{ index: 1, homePoints: 24, awayPoints: 23, finished: false }])
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
    await act(async () => { for (const res of relay.fetches.splice(0)) res(undo) })
    // and the database row of that undo (cloud referee)
    await act(async () => { cloud.onRow?.({ new: { ...undo.liveState, match_id: 'x' } }) })
    await settle(1200)
    const shown = breakClock()
    expect(shown).toBe(null)
  })
})
