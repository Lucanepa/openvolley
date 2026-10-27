import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'

// The referee's time-out countdown on a tablet whose clock is off (stress
// test 2026-10-25, cloud and venue relay): it was 30 - (the tablet's own
// Date.now() - the scorer's Date.now() at the start), so a tablet 2 minutes
// slow showed 150 and counted down from there, one 2 minutes fast showed no
// countdown at all. It now counts 30 down on the tablet's own clock from how
// long the time-out had run when the scorer sent it (the scorer's two
// readings: the start and the send time).

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
function bundle() {
  return {
    success: true,
    match: { id: 'match_seed', status: 'live', coinTossTeamA: 'home', firstServe: 'home', bestOf: 5 },
    homeTeam: { name: 'Home', color: '#ef4444' },
    awayTeam: { name: 'Away', color: '#3b82f6' },
    homePlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `H${n}` })),
    awayPlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `A${n}` })),
    sets: [{ index: 1, homePoints: 3, awayPoints: 2, finished: false }],
    events: [],
    liveState: liveRow(Date.now())
  }
}

// The countdown the referee shows (TIMEOUT 30"), null without one
const countdown = () => {
  const el = [...document.querySelectorAll('div')].find(d => d.children.length === 0 && /^\d+"$/.test(d.textContent.trim()))
  return el ? Number(el.textContent.trim().slice(0, -1)) : null
}
const settle = (ms = 400) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

async function openReferee() {
  render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
  await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
  await act(async () => { for (const res of relay.fetches) res(bundle()) })
  await settle(200)
  await waitFor(() => expect(cloud.onRow).toBeTypeOf('function'))
  expect(countdown()).toBeNull()
}

// The break's countdown (2:20), null without one
const breakClock = () => {
  const el = [...document.querySelectorAll('div')].find(d => d.children.length === 0 && /^\d:\d\d$/.test(d.textContent.trim()))
  return el ? el.textContent.trim() : null
}

// The scorer's clock, `skewMs` ahead of this tablet's (negative: behind)
const scorerClock = (skewMs) => Date.now() + skewMs
const iso = (ms) => new Date(ms).toISOString()
const HOUR = 3600 * 1000

describe('Referee: the time-out countdown with the tablet\'s clock off', () => {
  beforeEach(() => {
    relay.fetches = []
    cloud.onRow = null
    cloud.onAction = null
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
  })

  it('a tablet 2 minutes slow (relay action): 30, not 150', async () => {
    await openReferee()
    const start = scorerClock(120000)
    await act(async () => { cloud.onAction('timeout', { team: 'home', countdown: 30, startTimestamp: start }, { sentAt: start + 80 }) })
    await settle()
    expect(countdown()).toBe(30)
    await settle(1200)
    expect(countdown()).toBe(29)
  })

  it('a tablet 2 minutes fast (relay action): the countdown shows and runs', async () => {
    await openReferee()
    const start = scorerClock(-120000)
    await act(async () => { cloud.onAction('timeout', { team: 'home', countdown: 30, startTimestamp: start }, { sentAt: start + 80 }) })
    await settle(2500)
    expect(countdown()).toBe(28)
  })

  it('the database row: from how long the time-out had run when the scorer pushed it', async () => {
    await openReferee()
    // started 5 s before the push on the scorer's clock, which is 2 minutes ahead
    const pushedAt = scorerClock(120000)
    await act(async () => {
      cloud.onRow({ new: liveRow(pushedAt, { timeout_active: true, timeout_started_at: new Date(pushedAt - 5000).toISOString(), last_event_type: 'timeout', last_event_team: 'left', last_event_data: { duration: 30 } }) })
    })
    await settle()
    expect(countdown()).toBe(25)
  })

  // 2026-10-27: a device that continued a match from one whose clock was an
  // hour ahead stamps its rows' updated_at an hour ahead of its own clock (the
  // live-state clock, which only orders the rows: serverDataSync
  // liveClockOffset) and its countdown starts on its own clock, which the
  // website and Point Hub count from. Counted from updated_at, its time-out
  // read 0 from the first second and its break 0:00. The push's own reading
  // on the starts' clock is last_event_ts.
  it('the database row of a scorer whose live-state clock runs an hour ahead: 30, not 0', async () => {
    await openReferee()
    const start = scorerClock(0)
    await act(async () => {
      cloud.onRow({
        new: liveRow(start + 80 + HOUR, {
          timeout_active: true, timeout_started_at: iso(start), last_event_ts: iso(start + 80),
          last_event_type: 'timeout', last_event_team: 'left', last_event_data: { duration: 30 }
        })
      })
    })
    await settle()
    expect(countdown()).toBe(30)
    await settle(1200)
    expect(countdown()).toBe(29)
  })

  it('the same scorer\'s push 40 s into the break: 2:20 left, not 0:00', async () => {
    await openReferee()
    const pushedAt = scorerClock(0)
    await act(async () => {
      cloud.onRow({
        new: liveRow(pushedAt + HOUR, {
          current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1, sets_won_b: 0, match_status: 'interval',
          set_interval_active: true, set_interval_started_at: iso(pushedAt - 40000), last_event_ts: iso(pushedAt),
          last_event_type: 'lineup', last_event_team: 'home', last_event_data: { setIndex: 1, winner: 'home' }
        })
      })
    })
    await settle()
    expect(breakClock()).toBe('2:20')
  })
})
