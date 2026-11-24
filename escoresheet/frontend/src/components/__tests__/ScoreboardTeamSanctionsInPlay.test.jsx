// The team sanctions (Improper request, Delay warning, Delay penalty) are
// refused while the rally is in play (handleTeamSanction, handleImproperRequest,
// handleDelayWarning, handleDelayPenalty), so every button for them on screen
// is disabled then: none looks tappable and does nothing. OpenBeach found its
// team panel's buttons live during the rally (2026-10-08); OpenVolley's team
// panel of the old smartphone mode is not rendered (dead code), and the
// layouts that are (desktop side columns, phone grid and sheet) are checked
// here.
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
const events = async () => (await db.events.toArray()).sort((a, b) => a.seq - b.seq)
const ofType = async (type) => (await events()).filter(e => e.type === type)
const all = (text, root = document) => [...root.querySelectorAll('button')].filter(b => b.textContent.trim() === text)
// The desktop's buttons by their text; the phone view's by their name
const button = (text, root) => root
  ? within(root).queryAllByRole('button', { name: text }).find(b => !b.disabled)
  : all(text).find(b => !b.disabled)

// Set 1 under way at 1:1, team A (home) on the left, both line-ups entered
// (matchFields: e.g. both teams' delay warning given, so Delay penalty shows)
async function setUpMatch(matchFields = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', ...matchFields
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

async function startRally(root) {
  await waitFor(() => expect(button('Start rally', root)).toBeTruthy())
  await settle()
  fireEvent.click(button('Start rally', root))
  await waitFor(() => expect(button('Point A', root)).toBeTruthy())
  await settle()
}
async function pointA(root) {
  const points = (await ofType('point')).length
  fireEvent.click(button('Point A', root))
  await waitFor(async () => expect((await ofType('point')).length).toBe(points + 1))
  // and on screen: the rally over
  await waitFor(() => expect(button('Start rally', root)).toBeTruthy())
  await settle()
}

describe('Scoreboard: the team sanctions while the rally is in play', () => {
  it('desktop: every Improper request and Delay warning button is disabled during the rally, enabled after it', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch())
    await startRally()
    for (const text of ['Improper request', 'Delay warning']) {
      expect(all(text).length).toBeGreaterThanOrEqual(2)
      expect(all(text).every(b => b.disabled)).toBe(true)
    }
    // a tap on one does nothing: no confirmation asked, no sanction written
    fireEvent.click(all('Delay warning')[0])
    await settle()
    expect(document.querySelector('[data-testid="sanction-confirm"]')).toBeNull()
    expect(await ofType('sanction')).toHaveLength(0)

    await pointA()
    for (const text of ['Improper request', 'Delay warning']) {
      expect(all(text).every(b => !b.disabled)).toBe(true)
    }
  }, 60000)

  it('desktop: every Delay penalty button (a delay warning given) is disabled during the rally, enabled after it', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch({ sanctions: { delayWarningHome: true, delayWarningAway: true } }))
    await startRally()
    expect(all('Delay warning')).toHaveLength(0)
    expect(all('Delay penalty').length).toBeGreaterThanOrEqual(2)
    expect(all('Delay penalty').every(b => b.disabled)).toBe(true)

    await pointA()
    expect(all('Delay penalty').every(b => !b.disabled)).toBe(true)
  }, 60000)

  it('phone: the Sanction entry is disabled during the rally, and opens the team sanctions after it', async () => {
    setViewport(390, 844)
    mount(await setUpMatch())
    await waitFor(() => expect(screen.queryByTestId('phone-scoreboard')).toBeTruthy())
    const phone = screen.getByTestId('phone-scoreboard')
    const view = within(phone)
    await startRally(phone)
    expect(view.getByRole('button', { name: 'Sanction' })).toBeDisabled()
    expect(all('Delay warning')).toHaveLength(0)

    await pointA(phone)
    expect(view.getByRole('button', { name: 'Sanction' })).toBeEnabled()
    fireEvent.click(view.getByRole('button', { name: 'Sanction' }))
    await waitFor(() => expect(all('Delay warning').length).toBe(2))
    expect(all('Delay warning').every(b => !b.disabled)).toBe(true)
  }, 60000)
})
