// Taps on a scoring screen that has not caught up yet (a slow tablet).
//
// Found driving the app in Chrome with the CPU throttled 6x on a busy machine
// (2026-10-08): a point or a rally start took seconds to show, and a second
// tap on the button still on screen was recorded as well. A scorer action
// drops a second tap only until its data is on screen OR the live query has
// not delivered it for COMMIT_FLUSH_MAX_WAIT_MS (useActionLiveQuery): then
// the action lets go, while the screen still shows the old buttons. The
// second tap on "Point A" gave a second point for the same rally (a point with
// no rally_start before it), the second tap on "Start rally" a second
// rally_start. A point is now written only while its rally is in play in the
// database, a rally start only while none is: one point and one rally start
// per rally whatever the screen shows.
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with taps; the live query's results are held back to
// keep the screen behind the database, as a busy tablet's main thread does.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen, within } from '@testing-library/react'

// The screen's live query (hooks/useActionLiveQuery) reads through dexie's
// liveQuery: while `held`, its results wait (in order) to be delivered
const held = vi.hoisted(() => ({ on: false, queue: [] }))
vi.mock('dexie', async (importOriginal) => {
  const mod = await importOriginal()
  const liveQuery = (querier) => {
    const inner = mod.liveQuery(querier)
    return {
      subscribe(observer) {
        const deliver = (v) => { if (held.on) held.queue.push(() => observer.next(v)); else observer.next(v) }
        return inner.subscribe({ next: deliver, error: (e) => observer.error?.(e) })
      }
    }
  }
  return { ...mod, liveQuery }
})

import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { COMMIT_FLUSH_MAX_WAIT_MS } from '../../hooks/useActionLiveQuery'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// As in ScoreboardSet5CourtSwitch.test.jsx: under jsdom + fake-indexeddb a
// scorer action can lose Dexie's transaction zone part-way and end with
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
  held.on = false
  held.queue = []
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => {
  release()
  setViewport(saved.width, saved.height)
})
afterAll(() => {
  cleanup()
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
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
function release() {
  held.on = false
  const queue = held.queue
  held.queue = []
  for (const deliver of queue) deliver()
}

// Set 1 under way at 1:1 (`started`: else not started yet), team A (home)
// on the left, both line-ups entered
async function setUpMatch({ started = true } = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: started ? 1 : 0, awayPoints: started ? 1 : 0, finished: false, startTime: started ? t : null })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  }
  if (!started) return matchId
  await db.events.add({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  const at = (i) => new Date(Date.parse(t) + (i + 1) * 5000).toISOString()
  for (const [i, team] of ['home', 'away'].entries()) {
    await db.events.add({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: at(i) })
    await db.events.add({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: at(i) })
  }
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

// The screen behind the database: `tap` is written, the action has let go
// of its key (no live query result for COMMIT_FLUSH_MAX_WAIT_MS), the screen
// still shows what it showed before the tap
async function tapWhileScreenBehind(el, type, count, { staysOnScreen = true } = {}) {
  held.on = true
  fireEvent.click(el)
  await waitFor(async () => expect((await ofType(type)).length).toBe(count + 1), { timeout: 5000 })
  await wait(COMMIT_FLUSH_MAX_WAIT_MS + 300)
  if (staysOnScreen) expect(el.isConnected).toBe(true)
}

describe('Scoreboard: a tap on a screen that has not caught up', () => {
  it('desktop: a second tap on Start rally starts no second rally', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch())
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    const start = button('Start rally')
    const rallies = (await ofType('rally_start')).length
    await tapWhileScreenBehind(start, 'rally_start', rallies)
    fireEvent.click(start)
    await wait(500)
    release()
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 5000 })
    await settle()
    expect((await ofType('rally_start')).length).toBe(rallies + 1)
  }, 60000)

  it('a second tap on Start set starts the set once', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch({ started: false }))
    await waitFor(() => expect(button('Start set')).toBeTruthy(), { timeout: 10000 })
    await settle()
    const startSet = button('Start set')
    fireEvent.click(startSet)
    await waitFor(() => expect(button('Confirm')).toBeTruthy(), { timeout: 5000 })
    await settle()
    // the set start is written, the dialog closed, the screen still says Start set
    await tapWhileScreenBehind(button('Confirm'), 'set_start', 0, { staysOnScreen: false })
    expect(startSet.isConnected).toBe(true)
    fireEvent.click(startSet)
    await wait(1000)
    // a second set start dialog, if one opened, confirmed as the first
    if (button('Confirm')) {
      await settle()
      fireEvent.click(button('Confirm'))
      await wait(1000)
    }
    release()
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 5000 })
    await settle()
    expect((await ofType('set_start')).length).toBe(1)
    expect((await ofType('rally_start')).length).toBe(1)
  }, 60000)

  it('desktop: a second tap on a point button gives no second point for the rally', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch())
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    fireEvent.click(button('Start rally'))
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 5000 })
    await settle()
    const pointA = button('Point A')
    const pointB = button('Point B')
    const points = (await ofType('point')).length
    await tapWhileScreenBehind(pointA, 'point', points)
    fireEvent.click(pointA)
    await wait(500)
    fireEvent.click(pointB)
    await wait(500)
    release()
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 5000 })
    await settle()
    const after = await ofType('point')
    expect(after.length).toBe(points + 1)
    expect(after[after.length - 1].payload.team).toBe('home')
    const set = (await db.sets.toArray())[0]
    expect([set.homePoints, set.awayPoints]).toEqual([2, 1])
  }, 60000)

  it('phone: a second tap on a point button gives no second point for the rally', async () => {
    setViewport(390, 844)
    mount(await setUpMatch())
    await waitFor(() => expect(screen.queryByTestId('phone-scoreboard')).toBeTruthy(), { timeout: 10000 })
    const view = within(screen.getByTestId('phone-scoreboard'))
    await waitFor(() => expect(view.queryByRole('button', { name: 'Start rally' })).toBeTruthy(), { timeout: 10000 })
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Start rally' }))
    await waitFor(() => expect(view.queryByRole('button', { name: 'Point A' })).toBeTruthy(), { timeout: 5000 })
    await settle()
    const pointA = view.getByRole('button', { name: 'Point A' })
    const points = (await ofType('point')).length
    await tapWhileScreenBehind(pointA, 'point', points)
    fireEvent.click(pointA)
    await wait(500)
    release()
    await waitFor(() => expect(view.queryByRole('button', { name: 'Start rally' })).toBeTruthy(), { timeout: 5000 })
    await settle()
    expect((await ofType('point')).length).toBe(points + 1)
  }, 60000)

  it('the rally after it is scored as usual', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch())
    for (const [tapPoint, team] of [['Point B', 'away'], ['Point A', 'home']]) {
      await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
      await settle()
      const rallies = (await ofType('rally_start')).length
      fireEvent.click(button('Start rally'))
      await waitFor(async () => expect((await ofType('rally_start')).length).toBe(rallies + 1), { timeout: 5000 })
      await waitFor(() => expect(button(tapPoint)).toBeTruthy(), { timeout: 5000 })
      await settle()
      const points = (await ofType('point')).length
      fireEvent.click(button(tapPoint))
      await waitFor(async () => expect((await ofType('point')).length).toBe(points + 1), { timeout: 5000 })
      const last = (await ofType('point')).pop()
      expect(last.payload.team).toBe(team)
    }
  }, 60000)
})
