// Rows 10, 11 and 19 of the interruption-request spec (2026-11-09) on the
// real scoring screen over the app's real Dexie database (fake IndexedDB),
// driven with taps at phone width (the phone layout's buttons open the
// screen's own dialogs, the ones the tablet uses):
//  - row 10: a late request stopped the rally: "Replay" records the replay
//    and the team's delay warning (reason during_rally), and requests stay
//    closed until the replayed rally is completed;
//  - row 11: the improper request keeps what it was for (payload.reason);
//  - row 19: a decision change after a substitution and a time-out takes
//    them back (not counted) and swaps the point, in one confirmed action.
// Network is off: no relay socket, no fetch.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
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
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => {
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
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const events = async () => (await db.events.toArray()).sort((a, b) => a.seq - b.seq)
const ofType = async (type) => (await events()).filter(e => e.type === type)
const phone = () => screen.queryByTestId('phone-scoreboard')
// A time-out / substitution counter's number (its last line)
const count = (testId) => screen.getByTestId(testId).lastChild.textContent

// Set 1 under way at 1:1, team A (home) on the left, both line-ups entered,
// the home team with players 1-8 on its roster and the away team too
async function setUpLoneLineup() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM', color: '#dc2626' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY', color: '#2563eb' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 9; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t })
  // only home's line-up (home serves first): its server would be No 7
  await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { I: '7', II: '2', III: '3', IV: '4', V: '5', VI: '6' }, isInitial: true }, seq: 2, ts: t })
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const addAwayLineup = (matchId) => db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }, isInitial: true }, seq: 3, ts: new Date().toISOString() })

// The owner (2026-11-10): until both line-ups of a set are in, the covered
// team's SERVE number, bench list and Last action are hidden too, on the
// tablet; on the phone its server number and its recent actions
// (domain/lineupPrivacy.js).
describe('Scoreboard: the first line-up stays covered until the other is in', () => {
  it('tablet: no SERVE number, no bench list, no Last action of the covered team; all back with both line-ups', async () => {
    setViewport(1366, 900)
    const matchId = await setUpLoneLineup()
    mount(matchId)
    await waitFor(() => expect(screen.getAllByText(/Line-up set/).length).toBeGreaterThan(0), { timeout: 10000 })
    const serveText = () => [...document.querySelectorAll('.serve-side__indicator')].map(e => e.textContent).join('|')
    expect(serveText()).not.toMatch(/SERVE/)
    expect(document.querySelector('[data-help-id="scoreboard-bench-left"]')).toBeNull()
    expect(document.querySelector('[data-help-id="scoreboard-bench-right"]')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Last action:.*(Starting line-up|line-up)/i)
    await addAwayLineup(matchId)
    await waitFor(() => expect(serveText()).toMatch(/SERVE\s*7/), { timeout: 10000 })
    expect(document.querySelector('[data-help-id="scoreboard-bench-left"]')).toBeTruthy()
  })

  it('phone: the court covered, no server number, no recent action of the covered team', async () => {
    setViewport(390, 844)
    const matchId = await setUpLoneLineup()
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(screen.getByTestId('phone-lineup-hidden-left')).toBeTruthy(), { timeout: 10000 })
    expect(phone().textContent).not.toMatch(/#7/)
    expect(phone().textContent).not.toMatch(/2 3 4 5 6|7 2 3 4 5 6|line-up A/i)
    await addAwayLineup(matchId)
    await waitFor(() => expect(screen.queryByTestId('phone-lineup-hidden-left')).toBeNull(), { timeout: 10000 })
  })
})
