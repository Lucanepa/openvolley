// The accidental rally start check (options: "Check accidental rally start"):
// with it on, "Start rally" pressed within the set number of seconds of a
// point being awarded asks "Rally started very quickly / Are you sure the
// rally has actually started?" before the rally is started. Found by the
// phone-scorer builders (2026-10-08): the Start rally button handed its click
// event to handleStartRally, whose first parameter means "skip the
// confirmation", so a tap on the button (desktop, tablet, phone) never asked;
// only the Enter key did. The button now asks as the key does; the dialog's
// own "Yes, start rally" still starts the rally without asking again.
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
  localStorage.removeItem('checkAccidentalRallyStart')
  localStorage.removeItem('accidentalRallyStartDuration')
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => {
  setViewport(saved.width, saved.height)
  localStorage.removeItem('checkAccidentalRallyStart')
  localStorage.removeItem('accidentalRallyStartDuration')
  localStorage.removeItem('keybindingsEnabled')
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
const askOpen = () => document.body.textContent.includes('Rally started very quickly')

// Set 1 under way at 1:1, team A (home) on the left, both line-ups entered
async function setUpMatch() {
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

// The screen's Start rally button: the phone view's, or the desktop's
const startButton = (scope) => scope
  ? scope.queryByRole('button', { name: 'Start rally' })
  : button('Start rally')
const pointA = (scope) => scope
  ? scope.queryByRole('button', { name: 'Point A' })
  : button('Point A')

// Start rally (no point just awarded: it starts at once), then Point A
async function playRally(scope) {
  await waitFor(() => expect(startButton(scope)).toBeTruthy(), { timeout: 10000 })
  await settle()
  fireEvent.click(startButton(scope))
  await waitFor(() => expect(pointA(scope)).toBeTruthy(), { timeout: 5000 })
  await settle()
  const points = (await ofType('point')).length
  fireEvent.click(pointA(scope))
  await waitFor(async () => expect((await ofType('point')).length).toBe(points + 1), { timeout: 5000 })
  await waitFor(() => expect(startButton(scope)).toBeTruthy(), { timeout: 5000 })
  await settle()
}

// The check on, the point just awarded: Start rally asks, no rally starts;
// "Yes, start rally" starts it
async function expectAskThenStart(press, scope) {
  const rallies = (await ofType('rally_start')).length
  press()
  await waitFor(() => expect(askOpen()).toBe(true), { timeout: 5000 })
  await settle()
  expect((await ofType('rally_start')).length).toBe(rallies)
  expect(pointA(scope)).toBeFalsy()
  fireEvent.click(button('Yes, start rally'))
  await waitFor(async () => expect((await ofType('rally_start')).length).toBe(rallies + 1), { timeout: 5000 })
  await waitFor(() => expect(askOpen()).toBe(false))
  await waitFor(() => expect(pointA(scope)).toBeTruthy(), { timeout: 5000 })
}

describe('Scoreboard: the accidental rally start check', () => {
  it('desktop: the Start rally button asks when pressed right after a point', async () => {
    localStorage.setItem('checkAccidentalRallyStart', 'true')
    localStorage.setItem('accidentalRallyStartDuration', '60')
    setViewport(1280, 800)
    mount(await setUpMatch())
    await playRally()
    await expectAskThenStart(() => fireEvent.click(startButton()))
  }, 60000)

  it('phone: the Start rally button asks when pressed right after a point', async () => {
    localStorage.setItem('checkAccidentalRallyStart', 'true')
    localStorage.setItem('accidentalRallyStartDuration', '60')
    setViewport(390, 844)
    mount(await setUpMatch())
    await waitFor(() => expect(screen.queryByTestId('phone-scoreboard')).toBeTruthy(), { timeout: 10000 })
    const view = within(screen.getByTestId('phone-scoreboard'))
    await playRally(view)
    await expectAskThenStart(() => fireEvent.click(startButton(view)), view)
  }, 60000)

  it('the Enter key asks too, and Enter on the question starts the rally', async () => {
    localStorage.setItem('keybindingsEnabled', 'true')
    localStorage.setItem('checkAccidentalRallyStart', 'true')
    localStorage.setItem('accidentalRallyStartDuration', '60')
    setViewport(1280, 800)
    mount(await setUpMatch())
    await playRally()
    const rallies = (await ofType('rally_start')).length
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => expect(askOpen()).toBe(true), { timeout: 5000 })
    await settle()
    expect((await ofType('rally_start')).length).toBe(rallies)
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(async () => expect((await ofType('rally_start')).length).toBe(rallies + 1), { timeout: 5000 })
    await waitFor(() => expect(askOpen()).toBe(false))
  }, 60000)

  it('Cancel on the question starts no rally', async () => {
    localStorage.setItem('checkAccidentalRallyStart', 'true')
    localStorage.setItem('accidentalRallyStartDuration', '60')
    setViewport(1280, 800)
    mount(await setUpMatch())
    await playRally()
    const rallies = (await ofType('rally_start')).length
    fireEvent.click(startButton())
    await waitFor(() => expect(askOpen()).toBe(true), { timeout: 5000 })
    await settle()
    fireEvent.click(button('Cancel'))
    await waitFor(() => expect(askOpen()).toBe(false))
    await settle()
    expect((await ofType('rally_start')).length).toBe(rallies)
    expect(startButton()).toBeTruthy()
  }, 60000)

  it('does not ask once the set number of seconds has passed since the point', async () => {
    localStorage.setItem('checkAccidentalRallyStart', 'true')
    localStorage.setItem('accidentalRallyStartDuration', '1')
    setViewport(1280, 800)
    mount(await setUpMatch())
    await playRally()
    await wait(1100)
    const rallies = (await ofType('rally_start')).length
    fireEvent.click(startButton())
    await waitFor(async () => expect((await ofType('rally_start')).length).toBe(rallies + 1), { timeout: 5000 })
    expect(askOpen()).toBe(false)
  }, 60000)

  it('with the check off (the default) the button starts the rally at once', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch())
    await playRally()
    const rallies = (await ofType('rally_start')).length
    fireEvent.click(startButton())
    await waitFor(async () => expect((await ofType('rally_start')).length).toBe(rallies + 1), { timeout: 5000 })
    expect(askOpen()).toBe(false)
  }, 60000)
})
