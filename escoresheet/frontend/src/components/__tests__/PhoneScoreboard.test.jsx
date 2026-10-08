// The phone layout of the scoring screen (PhoneScoreboard): at phone width
// (390x844, portrait) the Scoreboard shows it instead of the desktop body,
// and its buttons drive the screen's own handlers and dialogs. Point, time-out,
// substitution and undo are taken through it here, and land in the database
// as the desktop buttons write them. A landscape screen keeps the desktop body.
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with taps. Network is off: no relay socket, no fetch.
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

// Set 1 under way at 1:1, team A (home) on the left, both line-ups entered,
// the home team with players 1-8 on its roster and the away team too
async function setUpMatch() {
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
  await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 1, finished: false, startTime: t })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  }
  await db.events.add({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  const at = (i) => new Date(Date.parse(t) + (i + 1) * 5000).toISOString()
  for (const [i, team] of ['home', 'away'].entries()) {
    await db.events.add({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: at(i) })
    await db.events.add({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: at(i) })
  }
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

describe('Scoreboard: the phone layout', () => {
  it('a landscape screen keeps the desktop body (no phone layout)', async () => {
    setViewport(1280, 800)
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    expect(phone()).toBeNull()
    expect(document.querySelector('.rally-controls')).toBeTruthy()
  })

  it('at 390x844 drives point, time-out, substitution and undo through the phone view', async () => {
    setViewport(390, 844)
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    // the desktop body is not there
    expect(document.querySelector('.rally-controls')).toBeNull()
    const view = within(phone())
    await waitFor(() => expect(view.getByTestId('phone-score-left').textContent).toBe('1'))
    expect(view.getByTestId('phone-score-right').textContent).toBe('1')
    // the ball next to the server: B won the last rally (right)
    expect(within(view.getByTestId('phone-court-right')).getByTestId('phone-serve-ball')).toBeTruthy()
    expect(within(view.getByTestId('phone-court-left')).queryByTestId('phone-serve-ball')).toBeNull()
    // the last actions: the newest point first
    expect(view.getByTestId('phone-recent').textContent).toMatch(/Away VC/)
    await settle()

    // ---- rally: Start rally, then the point buttons (as the desktop) ----
    expect(view.queryByRole('button', { name: 'Point A' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Start rally' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Point A' })).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Point A' }))
    await waitFor(async () => expect((await ofType('point')).length).toBe(3))
    const lastPoint = (await ofType('point')).at(-1)
    expect(lastPoint.payload.team).toBe('home')
    await waitFor(() => expect(view.getByTestId('phone-score-left').textContent).toBe('2'))
    await waitFor(() => expect(view.getByRole('button', { name: 'Start rally' })).toBeTruthy())
    await settle()

    // ---- time-out A: the screen's own request dialog, then its countdown ----
    fireEvent.click(view.getByTestId('phone-timeout-left'))
    await waitFor(() => expect(button('Confirm time-out')).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(button('Confirm time-out'))
    await waitFor(async () => expect((await ofType('timeout')).length).toBe(1))
    expect((await ofType('timeout'))[0].payload.team).toBe('home')
    await waitFor(() => expect(view.getByTestId('phone-countdown')).toBeTruthy(), { timeout: 5000 })
    expect(view.getByTestId('phone-timeout-left').textContent).toMatch('1/2')
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Stop timeout' }))
    await waitFor(() => expect(view.queryByTestId('phone-countdown')).toBeNull(), { timeout: 5000 })
    await settle()

    // ---- substitution B: out (on court), in (bench), the screen's confirmation ----
    fireEvent.click(view.getByTestId('phone-sub-right'))
    await waitFor(() => expect(screen.getByTestId('phone-sub-sheet')).toBeTruthy())
    fireEvent.click(screen.getByTestId('phone-sub-out-3'))
    await waitFor(() => expect(screen.getByTestId('phone-sub-in-7')).toBeTruthy())
    fireEvent.click(screen.getByTestId('phone-sub-in-7'))
    await waitFor(() => expect(screen.queryByTestId('phone-sub-sheet')).toBeNull())
    await waitFor(() => expect(button('Yes')).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(button('Yes'))
    await waitFor(async () => expect((await ofType('substitution')).length).toBe(1))
    const sub = (await ofType('substitution'))[0].payload
    expect(sub.team).toBe('away')
    expect(String(sub.playerOut)).toBe('3')
    expect(String(sub.playerIn)).toBe('7')
    await waitFor(() => expect(view.getByTestId('phone-sub-right').textContent).toMatch('1/6'))
    await settle()

    // ---- undo: the screen's undo confirmation takes the substitution back ----
    fireEvent.click(view.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(button('Yes')).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(button('Yes'))
    await waitFor(async () => expect((await ofType('substitution')).length).toBe(0))
    await waitFor(() => expect(view.getByTestId('phone-sub-right').textContent).toMatch('0/6'))
  }, 60000)

  it('a phone turned sideways keeps the phone layout, its dialogs and countdown, under a notice', async () => {
    const screenSize = { width: window.screen.width, height: window.screen.height }
    Object.defineProperty(window.screen, 'width', { value: 390, configurable: true })
    Object.defineProperty(window.screen, 'height', { value: 844, configurable: true })
    try {
      setViewport(390, 844)
      const matchId = await setUpMatch()
      mount(matchId)
      await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
      const view = within(phone())
      await waitFor(() => expect(view.getByTestId('phone-score-left').textContent).toBe('1'))
      await settle()
      // a running time-out (the screen's own state)
      fireEvent.click(view.getByTestId('phone-timeout-left'))
      await waitFor(() => expect(button('Confirm time-out')).toBeTruthy(), { timeout: 5000 })
      await settle()
      fireEvent.click(button('Confirm time-out'))
      await waitFor(() => expect(view.getByTestId('phone-countdown')).toBeTruthy(), { timeout: 5000 })
      const scoreboardRoot = document.querySelector('.match-record')

      // turned sideways: same screen (not remounted), the notice over it
      setViewport(844, 390)
      fireEvent(window, new Event('resize'))
      await waitFor(() => expect(screen.getByTestId('phone-sideways-notice')).toBeTruthy())
      expect(phone()).toBeTruthy()
      expect(document.querySelector('.match-record')).toBe(scoreboardRoot)
      expect(document.querySelector('.rally-controls')).toBeNull()
      // no "enable tablet mode" banner on a phone
      expect(screen.queryByText(/Small screen detected/)).toBeNull()
      expect(screen.getByTestId('phone-countdown')).toBeTruthy()

      // upright again: the notice goes, the countdown is still running
      setViewport(390, 844)
      fireEvent(window, new Event('resize'))
      await waitFor(() => expect(screen.queryByTestId('phone-sideways-notice')).toBeNull())
      expect(screen.getByTestId('phone-countdown')).toBeTruthy()
      expect(document.querySelector('.match-record')).toBe(scoreboardRoot)
    } finally {
      Object.defineProperty(window.screen, 'width', { value: screenSize.width, configurable: true })
      Object.defineProperty(window.screen, 'height', { value: screenSize.height, configurable: true })
    }
  }, 30000)

  it('the Phone display mode shows the phone layout on a landscape screen too', async () => {
    setViewport(1280, 800)
    localStorage.setItem('displayMode', 'phone')
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
  })
})
