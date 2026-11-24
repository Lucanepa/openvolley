// The device clock set back mid-set: serve and rotation follow the points.
//
// The scoring screen took "the last point" (who serves) and "the current
// line-up" (what a side-out rotates) as the events with the latest wall-clock
// time. Set the clock back (an NTP correction when the hall Wi-Fi comes back,
// the scorer fixing the time in Settings) and every event recorded after the
// change looked older than the last one before it: the serve badge stayed on
// the team that scored last before the change, side-outs rotated a stale
// line-up or none, for the rest of the set, and the tablets and livescore
// got the same (stress test 2026-10-25, clocks set back 1 and 10 minutes).
// The order is now the order the events were recorded in (seq).
//
// On the real scoring screen (phone layout: its serve pill names the
// serving side) over the app's real Dexie database (fake IndexedDB); only
// the page's Date is moved, as an OS clock change does.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen, within } from '@testing-library/react'

import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// As in ScoreboardStaleTaps.test.jsx: under jsdom + fake-indexeddb a scorer
// action can lose Dexie's transaction zone part-way and end with
// PrematureCommitError (not in Chrome). Only that error is let through.
const isEnvPrematureCommit = (reason) => reason?.name === 'PrematureCommitError'
let rejectionListeners = []
const filterRejections = (reason, promise) => {
  if (isEnvPrematureCommit(reason)) return
  for (const listener of rejectionListeners) listener(reason, promise)
}

let saved
const setViewport = (width, height) => {
  window.innerWidth = width
  window.innerHeight = height
}
beforeAll(() => {
  rejectionListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', filterRejections)
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, width: window.innerWidth, height: window.innerHeight }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
beforeEach(async () => {
  cleanup()
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => {
  vi.useRealTimers()
})
afterAll(() => {
  cleanup()
  setViewport(saved.width, saved.height)
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const events = async () => (await db.events.toArray()).sort((a, b) => a.seq - b.seq)
const ofType = async (type) => (await events()).filter(e => e.type === type)
const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)

// Set 1 at 1:1 (home scored, then away: away serves), recorded in the last
// minute; both teams in their starting line-up I..VI = 1..6
async function setUpMatch(now) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
  })
  const at = (s) => new Date(now - 60000 + s * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 1, finished: false, startTime: at(0) })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: at(0) })
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: at(1) })
  }
  await db.events.add({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: at(2) })
  for (const [i, team] of ['home', 'away'].entries()) {
    await db.events.add({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: at(10 + i * 20) })
    await db.events.add({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: at(20 + i * 20) })
  }
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const phone = () => within(screen.getByTestId('phone-scoreboard'))
const tap = (name) => fireEvent.click(phone().getByRole('button', { name }))
// the side whose score card carries the serve pill
function servingSide() {
  let el = screen.queryByTestId('phone-serve-pill')
  while (el && el !== document.body) {
    if (el.querySelector('[data-testid="phone-score-left"]')) return 'left'
    if (el.querySelector('[data-testid="phone-score-right"]')) return 'right'
    el = el.parentElement
  }
  return null
}
// a team's line-up now: its last lineup event in recording order
async function lineupOf(team) {
  const lineups = (await events()).filter(e => e.type === 'lineup' && e.payload?.team === team)
  return lineups[lineups.length - 1].payload.lineup.I
}

async function playRally(pointButton, points) {
  await waitFor(() => expect(phone().queryByRole('button', { name: 'Start rally' })).toBeTruthy(), { timeout: 10000 })
  await settle()
  tap('Start rally')
  await waitFor(() => expect(phone().queryByRole('button', { name: pointButton })).toBeTruthy(), { timeout: 10000 })
  await settle()
  tap(pointButton)
  await waitFor(async () => expect((await ofType('point')).length).toBe(points), { timeout: 10000 })
  await waitFor(() => expect(phone().queryByRole('button', { name: 'Start rally' })).toBeTruthy(), { timeout: 10000 })
}

describe('Scoreboard: the device clock set back mid-set', () => {
  it('serve and rotation follow the points, not the clock', async () => {
    setViewport(390, 844)
    const now = Date.now()
    vi.useFakeTimers({ toFake: ['Date'], now, shouldAdvanceTime: true })
    mount(await setUpMatch(now))
    await waitFor(() => expect(screen.queryByTestId('phone-scoreboard')).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(servingSide()).toBe('right'))

    // the clock goes back ten minutes
    vi.setSystemTime(now - 10 * 60 * 1000)

    // home (left) wins the rally: side-out, home serves, rotated once
    await playRally('Point A', 3)
    await waitFor(() => expect(servingSide()).toBe('left'))
    expect(await lineupOf('home')).toBe('2')
    expect(await lineupOf('away')).toBe('1')

    // away (right) wins it back: side-out, away rotates
    await playRally('Point B', 4)
    await waitFor(() => expect(servingSide()).toBe('right'))
    expect(await lineupOf('away')).toBe('2')
    expect(await lineupOf('home')).toBe('2')

    // home again: rotated a second time, from its rotated line-up
    await playRally('Point A', 5)
    await waitFor(() => expect(servingSide()).toBe('left'))
    expect(await lineupOf('home')).toBe('3')
    expect(await lineupOf('away')).toBe('2')

    // home keeps the serve: no rotation
    await playRally('Point A', 6)
    await waitFor(() => expect(servingSide()).toBe('left'))
    expect(await lineupOf('home')).toBe('3')
  }, 90000)
})
