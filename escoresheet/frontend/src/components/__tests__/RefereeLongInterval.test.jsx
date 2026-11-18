// The 10-minute interval after set 2 on a referee tablet (domain/setInterval):
// the cloud path (match_live_state row) reads the data shown now, not the copy
// from when its channel was set up (the coin toss), so a referee that joined
// before the toss and a switch flipped after it both give 10:00; a relay
// set_end's length is never shortened by the row; a switch changed while the
// break runs re-times it (same start, start + new length).
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
const cloud = vi.hoisted(() => ({ onRow: null, onAction: null, onData: null }))
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
    useRealtimeConnection: ({ onAction, onData }) => {
      cloud.onAction = onAction
      cloud.onData = onData
      return { status: real.CONNECTION_STATUS.CONNECTED, activeConnection: 'websocket', error: null, lastUpdate: null, forceReconnect: vi.fn() }
    }
  }
})
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

const { default: Referee } = await import('../../components/Referee')

const base = { sets_won_a: 0, sets_won_b: 0, side_a: 'left', serving_team: 'left', timeout_active: false, team_a_name: 'Home', team_b_name: 'Away', best_of: 5 }
const bundle = ({ liveState, sets, coinToss = true, longInterval = false }) => ({
  // set 2 started (else a tablet shows the break before it: isFirstRallyOf)
  success: true,
  match: {
    id: 'match_seed',
    status: coinToss ? 'live' : 'setup',
    ...(coinToss ? { coinTossTeamA: 'home', firstServe: 'home' } : {}),
    bestOf: 5,
    longIntervalAfterSet2: longInterval
  },
  homeTeam: { name: 'Home', color: '#ef4444' },
  awayTeam: { name: 'Away', color: '#3b82f6' },
  homePlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n })),
  awayPlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n })),
  sets,
  events: sets.some(s => s.index === 2) ? [{ type: 'set_start', setIndex: 1 }, { type: 'set_start', setIndex: 2 }] : [],
  liveState
})
const breakClock = () => {
  const el = [...document.querySelectorAll('div')].find(d => d.children.length === 0 && /^\d{1,2}:\d\d$/.test(d.textContent.trim()))
  return el ? el.textContent.trim() : null
}
const settle = (ms = 300) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
// the relay's answer to every fetch waiting
const answer = async (b) => {
  await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
  await act(async () => { for (const res of relay.fetches.splice(0)) res(b) })
  await settle()
}
const refetch = async (b) => {
  await act(async () => { window.dispatchEvent(new Event('online')) })
  await answer(b)
}

const set1 = [{ index: 1, homePoints: 0, awayPoints: 0, finished: false }]
const setsAfter2 = [
  { index: 1, homePoints: 25, awayPoints: 20, finished: true },
  { index: 2, homePoints: 20, awayPoints: 25, finished: true },
  { index: 3, homePoints: 0, awayPoints: 0, finished: false }
]
const inSet2 = [
  { index: 1, homePoints: 25, awayPoints: 20, finished: true },
  { index: 2, homePoints: 20, awayPoints: 24, finished: false }
]
const setEndRow = (t, extra = {}) => ({
  ...base, match_id: 'x', current_set: 3, sets_won_a: 1, sets_won_b: 1, points_a: 0, points_b: 0,
  match_status: 'in_progress', set_interval_active: true, set_interval_started_at: new Date(t).toISOString(),
  last_event_type: 'set_end', last_event_data: { setIndex: 2, winner: 'away' },
  updated_at: new Date(t).toISOString(), last_event_ts: new Date(t).toISOString(), ...extra
})
const minutesShown = () => Number((breakClock() || 'x:').split(':')[0])

describe('referee: 10-minute interval after set 2', () => {
  beforeEach(() => {
    cleanup()
    sessionStorage.clear()
    localStorage.clear()
    relay.fetches = []
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
  })

  async function joinBeforeTossThenPlayToSet2End ({ onAtToss, onLater }) {
    render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
    // joined before the coin toss: set 1 only, no toss
    await answer(bundle({ liveState: { ...base, current_set: 1, updated_at: new Date(Date.now() - 60000).toISOString() }, sets: set1, coinToss: false, longInterval: onAtToss }))
    // the toss: the channel effect runs again (its data: set 1, switch as now)
    await refetch(bundle({ liveState: { ...base, current_set: 1, points_a: 0, points_b: 0, match_status: 'in_progress', updated_at: new Date(Date.now() - 50000).toISOString() }, sets: set1, longInterval: onAtToss }))
    // set 2 nearly over (the switch maybe flipped since)
    await refetch(bundle({ liveState: { ...base, current_set: 2, sets_won_a: 1, points_a: 20, points_b: 24, match_status: 'in_progress', updated_at: new Date(Date.now() - 10000).toISOString() }, sets: inSet2, longInterval: onLater }))
    // set 2 ends: only the database row (a cloud-only referee)
    const t = Date.now()
    await act(async () => { cloud.onRow?.({ new: setEndRow(t) }) })
    await settle(400)
    return t
  }

  it('a referee that joined before the toss, switch on: 10:00 after set 2 from the cloud row', async () => {
    await joinBeforeTossThenPlayToSet2End({ onAtToss: true, onLater: true })
    expect(breakClock()).toMatch(/^(10:00|9:5\d)$/)
  })

  it('a switch flipped on after the toss reaches the referee (10:00, not 3:00)', async () => {
    await joinBeforeTossThenPlayToSet2End({ onAtToss: false, onLater: true })
    expect(breakClock()).toMatch(/^(10:00|9:5\d)$/)
  })

  it('switch off: 3:00 after set 2 from the cloud row', async () => {
    await joinBeforeTossThenPlayToSet2End({ onAtToss: false, onLater: false })
    expect(breakClock()).toMatch(/^(3:00|2:5\d)$/)
  })

  it("the cloud row never shortens the relay set_end's 10 minutes (the copy of the match is older)", async () => {
    render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
    await answer(bundle({ liveState: { ...base, current_set: 2, sets_won_a: 1, points_a: 20, points_b: 24, match_status: 'in_progress', updated_at: new Date(Date.now() - 10000).toISOString() }, sets: inSet2, longInterval: false }))
    // the scorer switched it on just before; the relay set_end says 600
    const t = Date.now()
    await act(async () => { cloud.onAction('set_end', { setIndex: 2, winner: 'away', homePoints: 20, awayPoints: 25, countdown: 600, startTimestamp: t, homeSetsWon: 1, awaySetsWon: 1 }, { sentAt: t }) })
    await settle()
    expect(minutesShown()).toBeGreaterThanOrEqual(9)
    // the database row with a start 5 s apart (its own clock): still 10 minutes
    await act(async () => { cloud.onRow?.({ new: setEndRow(t - 5000) }) })
    await settle(400)
    expect(minutesShown()).toBeGreaterThanOrEqual(9)
  })

  it('a switch changed while the break after set 2 runs re-times it, both ways', async () => {
    render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
    await answer(bundle({ liveState: { ...base, current_set: 2, sets_won_a: 1, points_a: 20, points_b: 24, match_status: 'in_progress', updated_at: new Date(Date.now() - 10000).toISOString() }, sets: inSet2, longInterval: false }))
    const t = Date.now()
    await act(async () => { cloud.onAction('set_end', { setIndex: 2, winner: 'away', homePoints: 20, awayPoints: 25, countdown: 180, startTimestamp: t, homeSetsWon: 1, awaySetsWon: 1 }, { sentAt: t }) })
    await settle()
    expect(breakClock()).toMatch(/^(3:00|2:5\d)$/)
    // Edit match info on the scorer: on -> the match row brings it
    const breakRow = setEndRow(t)
    await refetch(bundle({ liveState: breakRow, sets: setsAfter2, longInterval: true }))
    await settle(300)
    expect(breakClock()).toMatch(/^(10:00|9:5\d)$/)
    // and off again: back to 3 minutes from the same start
    await refetch(bundle({ liveState: breakRow, sets: setsAfter2, longInterval: false }))
    await settle(300)
    expect(breakClock()).toMatch(/^(3:00|2:5\d)$/)
  })
})
