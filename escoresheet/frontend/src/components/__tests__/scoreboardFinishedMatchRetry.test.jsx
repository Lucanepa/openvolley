// A match that is over, opened on the scoring screen (its last set end was
// confirmed, Match End never showed: the app was killed). The screen shows
// the full-screen 'Loading...' (no button) and asks App for Match End
// (onFinishSet). A failed try (a write refused: storage full, the database
// reopening) used to be tried again by the 10 s heartbeat's re-read and by
// every App render (a new finishSet). Both are gone (perf pass, 22.11.2026),
// so the screen tries again itself every FINISHED_MATCH_RETRY_MS, one call
// at a time, and stops when it goes away.
//
// The real scoring screen over the app's Dexie database (fake IndexedDB).
// Only the timers and Date are fake; fake IndexedDB and React's scheduler
// run on setImmediate, which stays real.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useCallback, useState } from 'react'

import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard, { FINISHED_MATCH_RETRY_MS } from '../Scoreboard'

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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date('2026-11-22T10:00:00') })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
afterAll(() => {
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

// Best of 5, home won sets 1 to 3: no set left to play
async function seedFinishedMatch() {
  const home = await db.teams.add({ name: 'Home' })
  const away = await db.teams.add({ name: 'Away' })
  const matchId = await db.matches.add({ homeTeamId: home, awayTeamId: away, status: 'live', test: true, bestOf: 5, seed_key: 'match_over_1' })
  const t = '2026-11-22T09:00:00.000Z'
  for (const index of [1, 2, 3]) {
    await db.sets.add({ matchId, index, homePoints: 25, awayPoints: 20, finished: true, startTime: t, endTime: t })
  }
  return matchId
}

// App's part: Match End replaces the scoring screen once finishSet is done
function Host({ matchId, finishSet }) {
  const [ended, setEnded] = useState(false)
  const onFinishSet = useCallback(async (set) => {
    await finishSet(set)
    setEnded(true)
  }, [finishSet])
  return ended
    ? <div data-testid="match-end">Match End</div>
    : <Scoreboard matchId={matchId} onFinishSet={onFinishSet} />
}

const mount = (matchId, finishSet) => render(<ScaleProvider><AlertProvider><LoggingProvider><Host matchId={matchId} finishSet={finishSet} /></LoggingProvider></AlertProvider></ScaleProvider>)
const matchEnd = () => document.querySelector('[data-testid="match-end"]')
const loading = () => [...document.querySelectorAll('div')].some((d) => d.textContent === 'Loading...')

// finishSet as App's: it writes the match row first (the scoring screen
// re-reads and its effect runs again meanwhile), then works for a second.
// `failures`: how many calls reject.
function makeFinishSet(matchId, failures) {
  const stats = { calls: [], inFlight: 0, maxInFlight: 0 }
  const finishSet = vi.fn(async (set) => {
    stats.calls.push({ at: Date.now(), setIndex: set?.index })
    stats.inFlight++
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
    try {
      await db.matches.update(matchId, { status: 'ended', updatedAt: new Date().toISOString() })
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (stats.calls.length <= failures) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    } finally {
      stats.inFlight--
    }
  })
  return { finishSet, stats }
}

describe('a match over, opened on the scoring screen', () => {
  it('opens Match End at once when App\'s first try works', async () => {
    const matchId = await seedFinishedMatch()
    const { finishSet, stats } = makeFinishSet(matchId, 0)
    mount(matchId, finishSet)
    await until(() => !!matchEnd(), { ms: 5000 })
    expect(stats.calls).toHaveLength(1)
    expect(stats.calls[0].setIndex).toBe(3)
  })

  it('a failed try: tried again after FINISHED_MATCH_RETRY_MS, never two calls at a time; Match End opens', async () => {
    const matchId = await seedFinishedMatch()
    const { finishSet, stats } = makeFinishSet(matchId, 1)
    mount(matchId, finishSet)
    await until(() => stats.calls.length >= 1, { ms: 5000 })
    const first = stats.calls[0].at
    // the failure: still 'Loading...', and not asked again right away, even
    // though the match row changed meanwhile (a new `data`)
    await advance(3000)
    expect(stats.calls).toHaveLength(1)
    expect(matchEnd()).toBeNull()
    expect(loading()).toBe(true)
    await until(() => !!matchEnd(), { ms: FINISHED_MATCH_RETRY_MS + 3000 })
    expect(stats.calls).toHaveLength(2)
    // the retry came about 10 s after the failure (1 s into the first call)
    const gap = stats.calls[1].at - first
    expect(gap).toBeGreaterThanOrEqual(FINISHED_MATCH_RETRY_MS)
    expect(gap).toBeLessThanOrEqual(FINISHED_MATCH_RETRY_MS + 2000)
    expect(stats.maxInFlight).toBe(1)
  })

  it('keeps trying every FINISHED_MATCH_RETRY_MS while it fails, one call at a time', async () => {
    const matchId = await seedFinishedMatch()
    const { finishSet, stats } = makeFinishSet(matchId, 3)
    mount(matchId, finishSet)
    await until(() => !!matchEnd(), { ms: 4 * (FINISHED_MATCH_RETRY_MS + 2000) })
    expect(stats.calls).toHaveLength(4)
    expect(stats.maxInFlight).toBe(1)
  })

  it('stops trying once the screen is gone', async () => {
    const matchId = await seedFinishedMatch()
    const { finishSet, stats } = makeFinishSet(matchId, 5)
    const view = mount(matchId, finishSet)
    await until(() => stats.calls.length >= 1, { ms: 5000 })
    await advance(2000)
    view.unmount()
    await advance(3 * FINISHED_MATCH_RETRY_MS, 1000)
    expect(stats.calls).toHaveLength(1)
  })
})
