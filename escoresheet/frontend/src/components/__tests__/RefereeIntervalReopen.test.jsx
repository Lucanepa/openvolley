import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'

// The break before set 5 on the referee. The set 5 setup's confirmation ends
// it (end_interval over the relay, a row with set_interval_active false in
// the database); its undo brings it back (a 'set_end' action over the relay,
// a row in the break in the database). The referee kept "dismissed" from
// end_interval for good: only the relay's 'set_end' opened the countdown
// again, so on the database alone (the relay gone, or never there) the
// countdown stayed closed after the undo, and a referee on the database
// alone never closed it at the confirmation either.

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

const NOW = Date.now()
const at = (ms) => new Date(NOW + ms).toISOString()
// set 4 ended 30 s ago, 2:2 in sets: the break before set 5
const SET_END_AT = at(-30000)
const row = (ms, extra = {}) => ({
  updated_at: at(ms), current_set: 5, points_a: 0, points_b: 0, sets_won_a: 2, sets_won_b: 2,
  match_status: 'interval', set_interval_active: true, set_interval_started_at: SET_END_AT,
  side_a: 'left', serving_team: 'left', ...extra
})

function bundle(liveState) {
  const finished = (index, homePoints, awayPoints) => ({ index, homePoints, awayPoints, finished: true })
  return {
    success: true,
    match: { id: 'match_seed', status: 'live', coinTossTeamA: 'home', firstServe: 'home', bestOf: 5 },
    homeTeam: { name: 'Home', color: '#ef4444' },
    awayTeam: { name: 'Away', color: '#3b82f6' },
    homePlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `H${n}` })),
    awayPlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `A${n}` })),
    sets: [finished(1, 25, 20), finished(2, 20, 25), finished(3, 25, 23), finished(4, 22, 25), { index: 5, homePoints: 0, awayPoints: 0, finished: false }],
    events: [],
    liveState
  }
}

const countdownShown = () => screen.queryByText('INTERVAL') !== null
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 200)) })

async function openInBreak() {
  render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
  await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
  await act(async () => { for (const res of relay.fetches) res(bundle(row(0, { last_event_type: 'set_end' }))) })
  await settle()
  await waitFor(() => expect(cloud.onRow).toBeTypeOf('function'))
  await act(async () => { cloud.onRow({ new: row(100, { last_event_type: 'set_end' }) }) })
  await settle()
  await waitFor(() => expect(countdownShown()).toBe(true))
}

describe('Referee: the break before set 5, its setup confirmed and undone', () => {
  beforeEach(() => {
    relay.fetches = []
    cloud.onRow = null
    cloud.onAction = null
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
  })

  it('ended over the relay, undone with the relay gone: the database row opens it again', async () => {
    await openInBreak()
    // the confirmation: end_interval over the relay, then its row
    await act(async () => { cloud.onAction('end_interval', {}) })
    await act(async () => { cloud.onRow({ new: row(1000, { set_interval_active: false, match_status: 'live', last_event_type: 'manual_set5_setup' }) }) })
    await settle()
    expect(countdownShown()).toBe(false)

    // the undo: only its database row arrives (no 'set_end' over the relay)
    await act(async () => { cloud.onRow({ new: row(2000, { last_event_type: 'undo' }) }) })
    await settle()
    expect(countdownShown()).toBe(true)
  })

  it('on the database alone: the confirmation closes it, the undo opens it, a late older row changes nothing', async () => {
    await openInBreak()
    await act(async () => { cloud.onRow({ new: row(1000, { set_interval_active: false, match_status: 'live', last_event_type: 'manual_set5_setup' }) }) })
    await settle()
    expect(countdownShown()).toBe(false)
    // a row from before the confirmation, arriving late
    await act(async () => { cloud.onRow({ new: row(500, { last_event_type: 'manual_set5_setup' }) }) })
    await settle()
    expect(countdownShown()).toBe(false)

    await act(async () => { cloud.onRow({ new: row(2000, { last_event_type: 'undo' }) }) })
    await settle()
    expect(countdownShown()).toBe(true)
  })

  it('over the relay: end_interval closes it, the undo\'s set_end opens it again', async () => {
    await openInBreak()
    await act(async () => { cloud.onAction('end_interval', {}) })
    await settle()
    expect(countdownShown()).toBe(false)
    await act(async () => {
      cloud.onAction('set_end', { setIndex: 4, winner: 'away', homePoints: 22, awayPoints: 25, countdown: 180, startTimestamp: Date.parse(SET_END_AT), homeSetsWon: 2, awaySetsWon: 2 })
    })
    await settle()
    expect(countdownShown()).toBe(true)
  })
})
