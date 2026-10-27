// The countdowns of a match continued on another device, from the scorer's
// live states to the referee (2026-10-27).
//
// A device that continues a match from one whose clock was ahead of its own
// stamps its live states after that device's last one: updated_at on the
// match's live-state clock (serverDataSync liveClockOffset), which is what
// the realtime hub and the viewers order the rows of two devices by. Round 2
// of the stress-test fixes stamped the countdown starts (timeout_started_at,
// set_interval_started_at) on that clock as well, and capped its offset at 10
// minutes. With the previous device an hour ahead (a laptop in the wrong time
// zone) the new device's states went out 50 minutes older than its last one,
// and the viewers dropped every one of them. And a referee that joins or
// reloads during a time-out or the break counts it from its start on its own
// clock: a start the offset ahead showed the full 30 s (3 min), and a
// time-out the referee had seen end came back with 30 s at the next copy,
// its start no longer the relay action's.
//
// Now the offset is followed whole and orders the rows only. The starts are
// on the device's own clock, as the relay actions' are and as the website and
// Point Hub count them, and the referee reads a row's push time on that clock
// (countdownClock liveStatePushedAt). The real scoring screen over the app's
// Dexie database (fake IndexedDB), its cloud live-state writes recorded and
// handed to the real referee screen.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

const api = vi.hoisted(() => ({ upserts: [], referee: false }))
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal()
  const chain = (table) => {
    const q = new Proxy({}, {
      get(_, key) {
        if (key === 'then') {
          // the referee looks up the match's cloud id (its realtime channel)
          const result = api.referee && table === 'matches'
            ? { data: { id: '00000000-0000-4000-8000-000000000001' }, error: null }
            : { data: null, error: null }
          return (res, rej) => Promise.resolve(result).then(res, rej)
        }
        if (key === 'upsert') return (row) => { api.upserts.push({ table, row }); return q }
        return () => q
      }
    })
    return q
  }
  return { ...actual, apiFrom: (table) => chain(table) }
})

// The referee's side: the database's realtime channel, the relay's copies
// and actions. The test delivers them.
const cloud = vi.hoisted(() => ({ onRow: null, onAction: null, fetches: [] }))
vi.mock('../../lib/supabaseClient', () => {
  const channel = {
    on: (_kind, _filter, cb) => { cloud.onRow = cb; return channel },
    subscribe: (cb) => { if (cb) cb('SUBSCRIBED'); return channel }
  }
  return { supabase: { channel: () => channel, removeChannel: () => {} } }
})
vi.mock('../../utils/serverDataSync', async (importOriginal) => ({
  ...(await importOriginal()),
  getMatchData: () => new Promise(res => cloud.fetches.push(res)),
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
vi.mock('../WsDebugOverlay', () => ({ default: () => null }))

import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import Referee from '../Referee'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { elapsedWhenSent, liveStatePushedAt } from '../../utils/countdownClock'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }

let saved
beforeAll(() => {
  saved = {
    WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    width: window.innerWidth, height: window.innerHeight
  }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterAll(() => {
  cleanup()
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

// The previous device's clock was an hour ahead of this one's
const OFFSET_MS = 3600 * 1000

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const liveStates = (type) => api.upserts.filter(u => u.table === 'match_live_state' && u.row.last_event_type === type).map(u => u.row)

async function teams() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
  ]))
  return { home, away }
}

const continuedMatch = ({ home, away }, key) => db.matches.add({
  homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
  seed_key: `match_live_clock_${key}`, externalId: `11111111-2222-4333-8444-55555555556${key}`,
  firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
  // importMatchFromSupabase: the last cloud state was stamped an hour ahead
  liveClockOffsetMs: OFFSET_MS + 1
})

const renderScoreboard = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

// The scoring screen, offline from the relay, its cloud writes recorded
async function onScorer(run) {
  cleanup()
  api.upserts.length = 0
  api.referee = false
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  await Promise.all(db.tables.map(t => t.clear()))
  try {
    return await run()
  } finally {
    cleanup()
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  }
}

// A time-out confirmed in set 1 at 1:0: its live state and when it was pressed
const scoreTimeOut = () => onScorer(async () => {
  const matchId = await continuedMatch(await teams(), 1)
  const t = new Date(Date.now() - 300000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 0, finished: false, startTime: t })
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  await db.events.bulkAdd([
    { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, isInitial: true }, seq: 2, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup, isInitial: true }, seq: 3, ts: t },
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 4, ts: t },
    { matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: 5, ts: t },
    { matchId, setIndex: 1, type: 'point', payload: { team: 'home' }, seq: 6, ts: t }
  ])

  renderScoreboard(matchId)
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
  fireEvent.click(document.querySelector('[data-help-id="scoreboard-timeout-left"]'))
  await waitFor(() => expect(button('Confirm time-out')).toBeTruthy())
  await wait(GHOST_CLICK_MS)
  const pressed = Date.now()
  fireEvent.click(button('Confirm time-out'))
  await waitFor(() => expect(liveStates('timeout').length).toBeGreaterThan(0), { timeout: 10000 })
  return { row: liveStates('timeout').at(-1), pressed }
})

// Set 1 ended 30 s ago (its set_end confirmed then), the break runs: the
// live state of a lineup entered in it
const pushInBreak = () => onScorer(async () => {
  const matchId = await continuedMatch(await teams(), 2)
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const end1 = new Date(Date.now() - 30000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: t, endTime: end1 })
  await db.sets.add({ matchId, index: 2, homePoints: 0, awayPoints: 0, finished: false })
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t })
  await db.events.add({ matchId, setIndex: 1, type: 'set_end', payload: { setIndex: 1, winner: 'home' }, seq: 2, ts: end1 })

  renderScoreboard(matchId)
  const open = () => [...document.querySelectorAll('button')].find(b => /^LineupA/.test(b.textContent.trim()))
  await waitFor(() => expect(open()).toBeTruthy(), { timeout: 10000 })
  await wait(GHOST_CLICK_MS + 150)
  fireEvent.click(open())
  await waitFor(() => expect(document.querySelector('[role=dialog]')).toBeTruthy())
  const dialog = () => document.querySelector('[role=dialog]')
  const chip = (text) => [...dialog().querySelectorAll('*')].filter(e => e.textContent.replace(/\s+/g, '') === text).pop()
  for (const n of ['C1', '2', '3', '4', '5', '6']) { fireEvent.click(chip(n)); await wait(30) }
  const pushed = Date.now()
  fireEvent.click([...dialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
  await waitFor(() => expect(liveStates('lineup').length).toBeGreaterThan(0), { timeout: 10000 })
  return { row: liveStates('lineup').at(-1), end1: Date.parse(end1), pushed }
})

// ---- the referee screen ---------------------------------------------------

// The relay's copy of the match, its live state `liveState`
function bundle(liveState, sets = [{ index: 1, homePoints: 1, awayPoints: 0, finished: false }]) {
  return {
    success: true,
    match: { id: 'match_live_clock', status: 'live', coinTossTeamA: 'home', firstServe: 'home', bestOf: 5 },
    homeTeam: { name: 'Home VC', color: '#ef4444' },
    awayTeam: { name: 'Away VC', color: '#3b82f6' },
    homePlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `H${n}` })),
    awayPlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `A${n}` })),
    sets,
    events: [],
    liveState
  }
}
const inBreak = [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 2, homePoints: 0, awayPoints: 0, finished: false }]
// The scorer's state before the time-out
const beforeTimeOut = (row) => ({ ...row, timeout_active: false, timeout_started_at: null, match_status: 'in_progress', last_event_type: 'point' })

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

async function openReferee(first) {
  cloud.fetches = []
  const view = render(<ScaleProvider><AlertProvider><Referee matchId="match_live_clock" onExit={() => {}} isMasterMode={false} /></AlertProvider></ScaleProvider>)
  await waitFor(() => expect(cloud.fetches.length).toBeGreaterThan(0))
  await act(async () => { for (const res of cloud.fetches.splice(0)) res(first) })
  await settle(300)
  return view
}
// The relay copy read again (back online)
async function refetch(copy) {
  await act(async () => { window.dispatchEvent(new Event('online')) })
  await waitFor(() => expect(cloud.fetches.length).toBeGreaterThan(0))
  await act(async () => { for (const res of cloud.fetches.splice(0)) res(copy) })
  await settle(300)
}
// This tablet's wall clock reads `at` (epoch ms) from now on, and runs on
// (its monotonic clock, which the countdowns run on, is left alone)
const realNow = Date.now.bind(Date)
let clock = null
function tabletClockAt(at) {
  clock?.mockRestore()
  const from = realNow()
  clock = vi.spyOn(Date, 'now').mockImplementation(() => at + (realNow() - from))
}

const rows = {}

describe('a match continued from a device whose clock was an hour ahead', () => {
  beforeAll(async () => {
    rows.timeOut = await scoreTimeOut()
    rows.break = await pushInBreak()
  }, 120000)

  beforeEach(() => {
    cleanup()
    sessionStorage.clear()
    api.referee = true
    cloud.onRow = null
    cloud.onAction = null
    cloud.fetches = []
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
  })
  afterEach(() => {
    cleanup()
    clock?.mockRestore()
    clock = null
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: saved.width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: saved.height })
  })

  it('the scorer\'s states come after the cloud\'s last one: the offset is followed whole', () => {
    const { row, pressed } = rows.timeOut
    expect(Date.parse(row.updated_at)).toBeGreaterThanOrEqual(pressed + OFFSET_MS)
    const { row: inBreakRow, pushed } = rows.break
    expect(Date.parse(inBreakRow.updated_at)).toBeGreaterThanOrEqual(pushed + OFFSET_MS)
  })

  it('the scorer\'s countdown starts are on its own clock, the referee reads its pushes on that clock', () => {
    const { row, pressed } = rows.timeOut
    expect(row.timeout_active).toBe(true)
    // the time-out's start: this device's own clock (the relay action's, the
    // website's and Point Hub's)
    expect(Math.abs(Date.parse(row.timeout_started_at) - pressed)).toBeLessThan(2000)
    // the referee reads the push as the time-out's start
    expect(elapsedWhenSent(row.timeout_started_at, liveStatePushedAt(row), 30000)).toBeLessThan(2000)

    const { row: inBreakRow, end1 } = rows.break
    expect(inBreakRow.set_interval_active).toBe(true)
    // the break's start: the set end, on this device's own clock
    expect(Math.abs(Date.parse(inBreakRow.set_interval_started_at) - end1)).toBeLessThan(1000)
    // the referee reads the push 30 s into the break: about 2:30 left
    const elapsed = elapsedWhenSent(inBreakRow.set_interval_started_at, liveStatePushedAt(inBreakRow), 180000)
    expect(elapsed).toBeGreaterThanOrEqual(29000)
    expect(elapsed).toBeLessThan(45000)
  })

  it('a referee on the database gets the time-out\'s push: 30, counting down', async () => {
    const { row } = rows.timeOut
    await openReferee(bundle(beforeTimeOut(row)))
    await waitFor(() => expect(cloud.onRow).toBeTypeOf('function'))
    expect(countdown()).toBeNull()
    // as pushed (this tablet's clock is the scorer's own then)
    tabletClockAt(Date.parse(row.last_event_ts))
    await act(async () => { cloud.onRow({ new: row }) })
    await settle()
    expect(countdown()).toBeGreaterThanOrEqual(29)
    await settle(1200)
    expect(countdown()).toBeLessThanOrEqual(29)
    expect(countdown()).toBeGreaterThanOrEqual(27)
  })

  it('a referee joining 12 s into the time-out: 18 left, not 30', async () => {
    const { row, pressed } = rows.timeOut
    // this tablet keeps the time the scorer's own clock does
    tabletClockAt(pressed + 12000)
    await openReferee(bundle(row))
    expect(countdown()).toBeGreaterThanOrEqual(17)
    expect(countdown()).toBeLessThanOrEqual(18)
  })

  it('a referee reloading during the time-out goes on with its own countdown', async () => {
    const { row, pressed } = rows.timeOut
    tabletClockAt(pressed + 100)
    const first = await openReferee(bundle(beforeTimeOut(row)))
    expect(countdown()).toBeNull()
    // the relay's action: the start on the scorer's own clock
    await act(async () => { cloud.onAction('timeout', { team: 'home', countdown: 30, startTimestamp: pressed }, { sentAt: pressed + 80 }) })
    await settle(2300)
    expect(countdown()).toBe(28)
    first.unmount()
    // the reload: the relay's copy has the time-out's push
    await openReferee(bundle(row))
    expect(countdown()).toBe(28)
  })

  it('a time-out the referee saw end is not opened again by the next copy, nor by a row of it', async () => {
    const { row, pressed } = rows.timeOut
    tabletClockAt(pressed + 100)
    await openReferee(bundle(beforeTimeOut(row)))
    await waitFor(() => expect(cloud.onRow).toBeTypeOf('function'))
    await act(async () => { cloud.onAction('timeout', { team: 'home', countdown: 30, startTimestamp: pressed }, { sentAt: pressed + 80 }) })
    await settle(1200)
    expect(countdown()).toBe(29)
    await act(async () => { cloud.onAction('end_timeout', {}, { sentAt: Date.now() }) })
    await settle(200)
    expect(countdown()).toBeNull()
    // the relay's next copy still has the time-out's push
    await refetch(bundle(row))
    expect(countdown()).toBeNull()
    // and the database's (a late copy of it, the alarm's update of the row)
    await act(async () => { cloud.onRow({ new: { ...row } }) })
    await settle()
    expect(countdown()).toBeNull()
  })

  it('a referee joining 40 s into the break: 2:20 left, not 3:00', async () => {
    const { row, end1 } = rows.break
    tabletClockAt(end1 + 40000)
    await openReferee(bundle(row, inBreak))
    expect(['2:20', '2:19']).toContain(breakClock())
  })
})
