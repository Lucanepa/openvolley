// Checked in OpenVolley for the beach finding OB-18 (laptop run 2026-10-08:
// at the end of set 1 the beach interval countdown showed "21" for one frame,
// then "1:00": the interval was first detected from the set's end time,
// rounded down to the minute). The real set end, on the real scoring screen
// over the app's Dexie database (fake IndexedDB), the clock stopped 39 s
// past the minute: the interval shows its full 3 minutes from its first frame.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// Under jsdom + fake-indexeddb a scorer action of this screen can lose
// Dexie's transaction zone part-way and end with PrematureCommitError (see
// ScoreboardSet5CourtSwitch.test.jsx: this test environment, not the app).
// Only that error is let through; the screen is checked as the scorer sees it.
const isEnvPrematureCommit = (reason) => reason?.name === 'PrematureCommitError'
let rejectionListeners = []
const filterRejections = (reason, promise) => {
  if (isEnvPrematureCommit(reason)) return
  for (const listener of rejectionListeners) listener(reason, promise)
}

let saved
beforeAll(() => {
  rejectionListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', filterRejections)
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterAll(() => {
  vi.useRealTimers()
  cleanup()
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
// the interval countdown in the rally box (49 px digits)
const countdownText = () => [...document.querySelectorAll('.rally-controls div')]
  .filter(e => e.style.fontSize === '49px' && /^\d+(:\d\d)?$/.test(e.textContent.trim()))
  .map(e => e.textContent.trim())

describe('Scoreboard: the interval after the set end', () => {
  it('shows the full interval from its first frame', async () => {
    const now = new Date()
    now.setSeconds(39, 0)
    vi.useFakeTimers({ toFake: ['Date'], now })

    const home = await db.teams.add({ name: 'Home' })
    const away = await db.teams.add({ name: 'Away' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
      { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
    ]))
    const t = new Date(now.getTime() - 1500000).toISOString()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: true, bestOf: 5,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
    })
    await db.sets.add({ matchId, index: 1, homePoints: 24, awayPoints: 20, finished: false, startTime: t })
    const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
    let seq = 1
    const events = [
      { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, isInitial: true }, seq: seq++, ts: t },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup, isInitial: true }, seq: seq++, ts: t },
      { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t }
    ]
    // the away points first, then the home run (no side-out rotation to follow)
    for (let k = 0; k < 44; k++) {
      events.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
      events.push({ matchId, setIndex: 1, type: 'point', payload: { team: k < 20 ? 'away' : 'home' }, seq: seq++, ts: t })
    }
    await db.events.bulkAdd(events)

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 8000 })
    fireEvent.click(button('Start rally'))
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(button('Point A'))
    await waitFor(() => expect(button('Confirm')).toBeTruthy(), { timeout: 5000 })

    // every countdown text the screen shows
    const seen = []
    const observer = new MutationObserver(() => {
      for (const text of countdownText()) if (seen.at(-1) !== text) seen.push(text)
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    fireEvent.click(button('Confirm'))
    await waitFor(() => expect(countdownText().length).toBeGreaterThan(0), { timeout: 10000 })
    await new Promise(r => setTimeout(r, 500))
    observer.disconnect()
    vi.useRealTimers()

    expect((await db.sets.where({ matchId, index: 1 }).first()).finished).toBe(true)
    // the clock stands still here: only the full interval
    expect(seen).toEqual(['3:00'])
    cleanup()
  }, 30000)
})
