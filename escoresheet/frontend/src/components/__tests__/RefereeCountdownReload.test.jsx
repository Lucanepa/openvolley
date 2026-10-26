import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor, cleanup } from '@testing-library/react'

// A referee that reloads, or joins, during a time-out or the break between
// sets (stress test 2026-10-26). The scorer sends nothing while a countdown
// runs, and the referee started its countdowns only from pushes and relay
// actions: the live state it loaded said a time-out or the break ran, and the
// referee showed no countdown at all until it ended. It now shows the time
// left: this tab's own countdown from before its reload, else this tablet's
// clock against the scorer's start.

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
vi.mock('../WsDebugOverlay', () => ({ default: () => null }))

const relay = vi.hoisted(() => ({ fetches: [] }))
vi.mock('../../utils/serverDataSync', async (importOriginal) => ({
  ...(await importOriginal()),
  getMatchData: () => new Promise(res => relay.fetches.push(res)),
  subscribeToMatchData: () => () => {},
  listAvailableMatches: async () => ({ success: true, matches: [] }),
  getWebSocketStatus: () => 'connected',
  forceReconnect: vi.fn()
}))
// The relay's actions: the test delivers them (onAction)
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

const { default: Referee } = await import('../Referee')

// set 1 at 3:2, a rally to play
const liveRow = (scorerNow, extra = {}) => ({
  updated_at: new Date(scorerNow).toISOString(), current_set: 1, points_a: 3, points_b: 2, sets_won_a: 0, sets_won_b: 0,
  match_status: 'live', set_interval_active: false, timeout_active: false, side_a: 'left', serving_team: 'left', ...extra
})
// The relay's copy, its live state `liveState`
function bundle(liveState = liveRow(Date.now()), { sets = [{ index: 1, homePoints: 3, awayPoints: 2, finished: false }] } = {}) {
  return {
    success: true,
    match: { id: 'match_seed', status: 'live', coinTossTeamA: 'home', firstServe: 'home', bestOf: 5 },
    homeTeam: { name: 'Home', color: '#ef4444' },
    awayTeam: { name: 'Away', color: '#3b82f6' },
    homePlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `H${n}` })),
    awayPlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `A${n}` })),
    sets,
    events: [],
    liveState
  }
}
// A time-out started at `start` (the scorer's clock), pushed at its start
const timeoutRow = (start) => liveRow(start, {
  timeout_active: true, timeout_started_at: new Date(start).toISOString(),
  last_event_type: 'timeout', last_event_team: 'left', last_event_data: { duration: 30 }
})

// The time-out countdown the referee shows (TIMEOUT 30"), null without one
const countdown = () => {
  const el = [...document.querySelectorAll('div')].find(d => d.children.length === 0 && /^\d+"$/.test(d.textContent.trim()))
  return el ? Number(el.textContent.trim().slice(0, -1)) : null
}
// The break's countdown (2:20), null without one
const breakClock = () => {
  const el = [...document.querySelectorAll('div')].find(d => d.children.length === 0 && /^\d:\d\d$/.test(d.textContent.trim()))
  return el ? el.textContent.trim() : null
}
const settle = (ms = 400) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

// Open the referee on the relay copy `first` (a reload is another open)
async function openReferee(first) {
  relay.fetches = []
  const view = render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
  await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
  await act(async () => { for (const res of relay.fetches.splice(0)) res(first) })
  await settle(300)
  return view
}
// The relay copy read again (back online)
async function refetch(copy) {
  await act(async () => { window.dispatchEvent(new Event('online')) })
  await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
  await act(async () => { for (const res of relay.fetches.splice(0)) res(copy) })
  await settle(300)
}

describe('Referee: a reload or a join during a time-out or the break', () => {
  beforeEach(() => {
    cleanup()
    sessionStorage.clear()
    relay.fetches = []
    cloud.onRow = null
    cloud.onAction = null
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
  })

  it('joins 12 s into a time-out: 18 left, from this tablet\'s clock', async () => {
    await openReferee(bundle(timeoutRow(Date.now() - 12000)))
    expect(countdown()).toBe(18)
    await settle(1100)
    expect(countdown()).toBe(17)
  })

  it('reloads during a time-out: its own countdown goes on, also with its clock 2 minutes slow', async () => {
    const start = Date.now() + 120000 // the scorer's clock
    const first = await openReferee(bundle(liveRow(start - 30000)))
    expect(countdown()).toBeNull()
    await act(async () => { cloud.onAction('timeout', { team: 'home', countdown: 30, startTimestamp: start }, { sentAt: start + 80 }) })
    await settle(2300)
    expect(countdown()).toBe(28)
    first.unmount()
    // the reload: the relay's copy has the push from the time-out's start
    await openReferee(bundle(timeoutRow(start)))
    expect(countdown()).toBe(28)
  })

  it('a time-out this tablet saw end does not come back with an older copy', async () => {
    const start = Date.now()
    await openReferee(bundle(liveRow(start - 30000)))
    await act(async () => { cloud.onAction('timeout', { team: 'home', countdown: 30, startTimestamp: start }, { sentAt: start + 80 }) })
    await settle(1200)
    expect(countdown()).toBe(29)
    await act(async () => { cloud.onAction('end_timeout', {}, { sentAt: Date.now() }) })
    await settle(200)
    expect(countdown()).toBeNull()
    await refetch(bundle(timeoutRow(start)))
    expect(countdown()).toBeNull()
  })

  it('a time-out over by now opens nothing', async () => {
    await openReferee(bundle(timeoutRow(Date.now() - 45000)))
    expect(countdown()).toBeNull()
  })

  it('joins 40 s into the break: 2:20 left', async () => {
    const started = Date.now() - 40000
    const row = liveRow(started, {
      current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1, sets_won_b: 0,
      set_interval_active: true, set_interval_started_at: new Date(started).toISOString(),
      last_event_type: 'set_end', last_event_data: { setIndex: 1, winner: 'home' }
    })
    await openReferee(bundle(row, { sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 2, homePoints: 0, awayPoints: 0, finished: false }] }))
    expect(breakClock()).toBe('2:20')
  })
})
