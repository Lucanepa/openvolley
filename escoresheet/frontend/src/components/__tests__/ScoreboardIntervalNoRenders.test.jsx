// The set interval's countdown ticks in its own leaf (CountdownSeconds), as
// the time-out's does (performance pass, 2026-11-22). It was Scoreboard
// state: each second of the 3 minutes (10 after set 2) rendered the whole
// scoring screen, while the scorer enters the next line-ups. Now a running
// interval adds no render of the screen; its digits still count down, it
// still ends by itself at 0, and "End set interval" still ends it.
// The real scoring screen over the app's Dexie database (fake IndexedDB);
// the monotonic clock the countdown runs on stands still and is moved on by
// hand (10 s in 1.5 s). Network is off: no relay socket, no fetch.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'

// coveredLineupTeams runs once in each render of the Scoreboard (and in no
// other component): its calls count the screen's renders
const renders = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../domain/lineupPrivacy', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    coveredLineupTeams: (...args) => {
      renders.count++
      return actual.coveredLineupTeams(...args)
    }
  }
})

import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { scorerRelay } from '../../utils/relayPublisher'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

const isEnvPrematureCommit = (reason) => reason?.name === 'PrematureCommitError'
let rejectionListeners = []
const filterRejections = (reason, promise) => {
  if (isEnvPrematureCommit(reason)) return
  for (const listener of rejectionListeners) listener(reason, promise)
}

// performance.now as the countdown reads it: standing still, plus what the
// test moved it on by
const PERF_START = 3600000
const mono = { extra: 0 }
let saved
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
  vi.spyOn(scorerRelay, 'listen').mockImplementation(() => () => {})
  vi.spyOn(scorerRelay, 'send').mockImplementation(() => true)
  window.innerWidth = 1280
  window.innerHeight = 800
})
beforeEach(async () => {
  cleanup()
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
  mono.extra = 0
  vi.spyOn(performance, 'now').mockImplementation(() => PERF_START + mono.extra)
})
afterEach(() => {
  cleanup()
  vi.mocked(performance.now).mockRestore()
})
afterAll(() => {
  window.innerWidth = saved.width
  window.innerHeight = saved.height
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
// the interval's digits in the rally box (49 px), in seconds
const shownSeconds = () => {
  const el = [...document.querySelectorAll('.rally-controls div')]
    .find(e => e.style.fontSize === '49px' && /^\d+(:\d\d)?$/.test(e.textContent.trim()))
  if (!el) return null
  const [a, b] = el.textContent.trim().split(':')
  return b === undefined ? Number(a) : Number(a) * 60 + Number(b)
}
// its bar: as wide as the part of the interval left
const barWidth = () => {
  const digits = [...document.querySelectorAll('.rally-controls div')].find(e => e.style.fontSize === '49px')
  return digits?.nextElementSibling?.firstElementChild?.style.width ?? null
}

/** Set 1 over (`endedAgo` ms ago) and set 2 to come, or set 1 at 3:2. */
async function setUpMatch({ interval }) {
  const home = await db.teams.add({ name: 'Home' })
  const away = await db.teams.add({ name: 'Away' })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}` },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}` }
  ]))
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: true, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  let seq = 1
  const ev = [{ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t }]
  for (const team of ['home', 'away']) ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  for (const team of ['home', 'home', 'away', 'home', 'away']) {
    ev.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: t })
  }
  if (interval) {
    // set 1 ended 30 s ago: 2:30 of the interval are left
    const end1 = new Date(Date.now() - 30000).toISOString()
    ev.push({ matchId, setIndex: 1, type: 'set_end', payload: { team: 'home', setIndex: 1, homePoints: 25, awayPoints: 18 }, seq: seq++, ts: end1 })
    await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 18, finished: true, startTime: t, endTime: end1 })
    await db.sets.add({ matchId, index: 2, homePoints: 0, awayPoints: 0, finished: false })
  } else {
    await db.sets.add({ matchId, index: 1, homePoints: 3, awayPoints: 2, finished: false, startTime: t })
  }
  await db.events.bulkAdd(ev)
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

/** The Scoreboard's renders while the monotonic clock moves on 10 s (in 1.5 s). */
async function rendersOverTenSeconds() {
  await wait(800) // the screen's start-up work done
  renders.count = 0
  for (let i = 0; i < 10; i++) {
    mono.extra += 1000
    await wait(150)
  }
  return renders.count
}

describe('Scoreboard: the set interval countdown renders only its digits', () => {
  it('a running interval adds no render of the screen; the digits and the bar still count down', async () => {
    // the screen's own renders in a set (its toolbar clock), over the same time
    const idleMatch = await setUpMatch({ interval: false })
    mount(idleMatch)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    const idle = await rendersOverTenSeconds()
    cleanup()
    await Promise.all(db.tables.map(t => t.clear()))

    const matchId = await setUpMatch({ interval: true })
    mount(matchId)
    await waitFor(() => expect(button('End set interval')).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(shownSeconds()).toBeGreaterThan(0))
    await wait(300)
    const before = shownSeconds()
    expect(before).toBeLessThanOrEqual(150)
    expect(before).toBeGreaterThanOrEqual(145)
    const during = await rendersOverTenSeconds()
    // as many as in a set (the countdown in Scoreboard state rendered the
    // screen once a second: 10 more)
    expect(during).toBeLessThanOrEqual(idle + 1)
    const after = shownSeconds()
    expect(after).toBe(before - 10)
    expect(parseFloat(barWidth())).toBeCloseTo((after / 180) * 100, 3)
    expect(button('End set interval')).toBeTruthy()
  }, 60000)

  it('ends by itself when its clock runs out', async () => {
    const matchId = await setUpMatch({ interval: true })
    mount(matchId)
    await waitFor(() => expect(button('End set interval')).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(shownSeconds()).toBeGreaterThan(0))
    await wait(300)
    mono.extra += (shownSeconds() - 1) * 1000
    await waitFor(() => expect(shownSeconds()).toBe(1))
    expect(button('End set interval')).toBeTruthy()
    mono.extra += 1000
    await waitFor(() => expect(button('End set interval')).toBeFalsy(), { timeout: 3000 })
    expect(shownSeconds()).toBeNull()
    // and stays ended
    mono.extra += 2000
    await wait(400)
    expect(button('End set interval')).toBeFalsy()
  }, 60000)

  it('"End set interval" still ends it', async () => {
    const matchId = await setUpMatch({ interval: true })
    mount(matchId)
    await waitFor(() => expect(button('End set interval')).toBeTruthy(), { timeout: 10000 })
    await wait(GHOST_CLICK_MS)
    fireEvent.click(button('End set interval'))
    await waitFor(() => expect(button('End set interval')).toBeFalsy())
    expect(shownSeconds()).toBeNull()
    // and stays ended (the clock does not bring it back)
    mono.extra += 2000
    await wait(400)
    expect(button('End set interval')).toBeFalsy()
  }, 60000)
})
