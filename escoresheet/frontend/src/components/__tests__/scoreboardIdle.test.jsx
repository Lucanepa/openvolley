// The scoring screen sitting idle (perf pass, 22.11.2026). On the hall's
// tablet (Galaxy Tab A7 Lite) it rendered all of itself once a second for
// the toolbar clock, and every 10 s its heartbeat rewrote the match, which
// re-read every event here, re-ran App's match queries and, with the Android
// in-app view open, made the scoresheet in it read the match again. Now:
// - nothing renders the screen while nobody touches it (the clock ticks in
//   its own leaf),
// - the heartbeat writes on open, every 5 minutes, when the app comes back
//   and when the in-app view closes, never under the view,
// - the relay refusal banner goes after 45 s on its own timer,
// - a skipped "next set" creation is still tried again (the 10 s re-read
//   was its only retry).
//
// The real scoring screen over the app's Dexie database (fake IndexedDB).
// Only the timers and Date are fake; fake IndexedDB and React's scheduler
// run on setImmediate, which stays real.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

const renders = vi.hoisted(() => ({ scoreboard: 0 }))
vi.mock('../../diagnostics/commits', async (importOriginal) => ({
  ...(await importOriginal()),
  // one call per render of the Scoreboard function itself (a child's own
  // state change, the clock's, does not call it)
  useDiagCommits: (id) => { if (id === 'scoreboard') renders.scoreboard++ }
}))

import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { scorerRelay } from '../../utils/relayPublisher'
import { openAppWindow, currentInAppView } from '../../utils/openAppWindow'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

const realImmediate = globalThis.setImmediate
const turn = () => new Promise((resolve) => realImmediate(resolve))
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await turn() }
/** Moves the fake clock by `ms` in steps, letting IndexedDB and React run between them. */
async function advance(ms, step = 250) {
  for (let done = 0; done < ms; done += step) {
    await act(async () => { vi.advanceTimersByTime(Math.min(step, ms - done)) })
    await settle(8)
  }
}
async function until(check, { ms = 20000, step = 50 } = {}) {
  for (let waited = 0; waited <= ms; waited += step) {
    if (check()) return
    await advance(step, step)
  }
  throw new Error('timed out waiting')
}

let saved
let relayUser = null
const isHeartbeat = (call) => {
  const keys = Object.keys(call[1] || {})
  return keys.length === 1 && keys[0] === 'updatedAt'
}

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
  await Promise.all(db.tables.map((t) => t.clear()))
  relayUser = null
  vi.spyOn(scorerRelay, 'attach').mockImplementation((url, user) => { relayUser = user; return () => {} })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date('2026-11-22T10:00:00') })
  renders.scoreboard = 0
})
afterEach(() => {
  cleanup()
  currentInAppView()?.close()
  vi.useRealTimers()
  vi.mocked(scorerRelay.attach).mockRestore()
})
afterAll(() => {
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

async function seedMatch({ withSet = true } = {}) {
  const home = await db.teams.add({ name: 'Home' })
  const away = await db.teams.add({ name: 'Away' })
  const matchId = await db.matches.add({ homeTeamId: home, awayTeamId: away, status: 'live', test: true, seed_key: 'match_idle_1' })
  if (withSet) await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
  return matchId
}

function mount(matchId) {
  return render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
}

describe('Scoreboard idle', () => {
  it('does not render while nobody touches it; only the clock ticks', async () => {
    const matchId = await seedMatch()
    mount(matchId)
    await until(() => !!document.querySelector('.toolbar-clock'))
    // let the opening work (first reads, the first heartbeat) finish
    await advance(3000)
    const clock = document.querySelector('.toolbar-clock')
    const before = renders.scoreboard
    const shown = clock.textContent
    await advance(20000, 500)
    expect(renders.scoreboard - before).toBe(0)
    // the clock kept time by itself
    expect(document.querySelector('.toolbar-clock').textContent).not.toBe(shown)
    expect(document.querySelector('.toolbar-clock').textContent).toMatch(/ 10:00:2\d$/)
  })

  it('writes the heartbeat on open and then every 5 minutes, not every 10 s', async () => {
    const update = vi.spyOn(db.matches, 'update')
    const matchId = await seedMatch()
    mount(matchId)
    await until(() => !!document.querySelector('.toolbar-clock'))
    const beats = () => update.mock.calls.filter((c) => c[0] === matchId && isHeartbeat(c)).length
    expect(beats()).toBe(1)
    await advance(60000, 1000)
    expect(beats()).toBe(1)
    await advance(4 * 60000, 5000)
    expect(beats()).toBe(2)
    // written at the 5-minute mark
    const stored = await db.matches.get(matchId)
    expect(Date.now() - new Date(stored.updatedAt).getTime()).toBeLessThan(10000)
    // the app back in front (Android resume, tab shown): once more
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(beats()).toBe(3)
    delete document.visibilityState
    update.mockRestore()
  })

  it('writes no heartbeat under the in-app view, one when it closes; the clock stops there too', async () => {
    const update = vi.spyOn(db.matches, 'update')
    const matchId = await seedMatch()
    mount(matchId)
    await until(() => !!document.querySelector('.toolbar-clock'))
    const beats = () => update.mock.calls.filter((c) => c[0] === matchId && isHeartbeat(c)).length
    expect(beats()).toBe(1)

    act(() => { openAppWindow('/scoresheet/?matchId=7', { win: window, platform: 'capacitor' }) })
    const covered = document.querySelector('.toolbar-clock').textContent
    await advance(6 * 60000, 5000)
    expect(beats()).toBe(1)
    expect(document.querySelector('.toolbar-clock').textContent).toBe(covered)
    // the app coming back while the view is still open: nothing either
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(beats()).toBe(1)
    delete document.visibilityState

    act(() => { currentInAppView().close() })
    await settle()
    expect(beats()).toBe(2)
    // the clock shows the time again at once
    expect(document.querySelector('.toolbar-clock').textContent).not.toBe(covered)
    update.mockRestore()
  })

  it('shows the relay refusal for 45 s, from the last refusal', async () => {
    const matchId = await seedMatch()
    mount(matchId)
    await until(() => !!document.querySelector('.toolbar-clock'))
    await until(() => !!relayUser)
    const banner = () => [...document.querySelectorAll('[role="alert"]')].find((el) => el.textContent.includes('Referee/bench link'))
    expect(banner()).toBeUndefined()
    act(() => { relayUser.onMessage({ type: 'error', code: 'not-match-owner', message: 'held elsewhere' }) })
    await settle()
    expect(banner()).toBeTruthy()
    await advance(30000, 1000)
    expect(banner()).toBeTruthy()
    // refused again: 45 s from now
    act(() => { relayUser.onMessage({ type: 'error', code: 'not-match-owner', message: 'held elsewhere' }) })
    await settle()
    await advance(30000, 1000)
    expect(banner()).toBeTruthy()
    await advance(15000, 500)
    expect(banner()).toBeUndefined()
  })

  it('tries again to create the next set when the tries on open failed (no heartbeat re-read needed)', async () => {
    const matchId = await seedMatch({ withSet: false })
    const add = db.sets.add.bind(db.sets)
    // every try in the first 3 s fails (the one on open, and one after the
    // re-read the opening heartbeat causes)
    const failUntil = Date.now() + 3000
    let failures = 0
    const spy = vi.spyOn(db.sets, 'add').mockImplementation((row) => {
      if (Date.now() < failUntil) { failures++; return Promise.reject(new Error('busy (test)')) }
      return add(row)
    })
    mount(matchId)
    await until(() => failures >= 1)
    await advance(4000)
    expect(await db.sets.where('matchId').equals(matchId).count()).toBe(0)
    expect(document.querySelector('.toolbar-clock')).toBeNull()
    await advance(10000, 500)
    await until(() => !!document.querySelector('.toolbar-clock'))
    const sets = await db.sets.where('matchId').equals(matchId).toArray()
    expect(sets.map((s) => [s.index, s.finished])).toEqual([[1, false]])
    spy.mockRestore()
  })
})
