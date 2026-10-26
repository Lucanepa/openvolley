// The countdowns the referee reads from the live state of a match continued
// on another device. The referee counts a time-out or the break on from the
// difference of the row's start (timeout_started_at, set_interval_started_at)
// and its push time (updated_at), both the scorer's (utils/countdownClock).
// A device that continued a match from one whose clock was ahead stamps
// updated_at on the match's live-state clock (serverDataSync liveClockOffset),
// but stamped the starts on its own: the difference grew by the offset, and
// the referee's 30 s time-out and 3 min break showed 0 from their first second
// (the stress-test fixes of the countdowns and of the hand-over, together).
// The real scoring screen over the app's Dexie database (fake IndexedDB), its
// cloud live-state writes recorded.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'

const upserts = vi.hoisted(() => [])
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal()
  const result = { data: null, error: null }
  const chain = (table) => {
    const q = new Proxy({}, {
      get(_, key) {
        if (key === 'then') return (res, rej) => Promise.resolve(result).then(res, rej)
        if (key === 'upsert') return (row) => { upserts.push({ table, row }); return q }
        return () => q
      }
    })
    return q
  }
  return { ...actual, apiFrom: (table) => chain(table) }
})

import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { elapsedWhenSent } from '../../utils/countdownClock'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

let saved
beforeAll(() => {
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
beforeEach(async () => {
  cleanup()
  upserts.length = 0
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

// This device's clock is 3 minutes behind the one that scored the match before
const OFFSET_MS = 180000

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const liveStates = (type) => upserts.filter(u => u.table === 'match_live_state' && u.row.last_event_type === type).map(u => u.row)

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
  // importMatchFromSupabase: the last cloud state was stamped 3 min ahead
  liveClockOffsetMs: OFFSET_MS
})

const renderScoreboard = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

describe('Scoreboard: countdown starts on the live-state clock of a continued match', () => {
  it('a time-out: its start and the push time are read on one clock', async () => {
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
    const state = liveStates('timeout').at(-1)
    expect(state.timeout_active).toBe(true)
    // ordered after the previous device's states (the hand-over fix)
    expect(Date.parse(state.updated_at)).toBeGreaterThanOrEqual(pressed + OFFSET_MS - 1000)
    // the referee's countdown starts at 30, not at 0
    expect(elapsedWhenSent(state.timeout_started_at, state.updated_at, 30000)).toBeLessThan(2000)
    cleanup()
  }, 60000)

  it('the break between sets: a push during it says how long it has run', async () => {
    const matchId = await continuedMatch(await teams(), 2)
    const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    // set 1 ended 30 s ago (its set_end confirmed then): the interval runs
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
    fireEvent.click([...dialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))

    await waitFor(() => expect(liveStates('lineup').length).toBeGreaterThan(0), { timeout: 10000 })
    const state = liveStates('lineup').at(-1)
    expect(state.set_interval_active).toBe(true)
    // the referee's break has about 2:30 left, not 0
    const elapsed = elapsedWhenSent(state.set_interval_started_at, state.updated_at, 180000)
    expect(elapsed).toBeGreaterThanOrEqual(29000)
    expect(elapsed).toBeLessThan(45000)
    cleanup()
  }, 60000)
})
