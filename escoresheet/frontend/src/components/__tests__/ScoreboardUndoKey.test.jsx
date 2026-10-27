// The undo key (Backspace by default) in normal play.
//
// With keyboard shortcuts on (Options; off by default) Backspace did nothing
// between rallies: the key called the undo question's Yes (handleUndo),
// which does nothing while the question is not open, instead of asking it as
// the Undo button does (found while re-running the keyboard stress scripts,
// 2026-10-26).
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with key presses.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'

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
  localStorage.setItem('keybindingsEnabled', 'true')
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  localStorage.removeItem('keybindingsEnabled')
  setViewport(saved.width, saved.height)
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
const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)

// Set 1 under way at 1:1 (the last point team B's), team A (home) on the left
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
const press = (key) => fireEvent.keyDown(window, { key })
const score = async () => {
  const set = (await db.sets.toArray())[0]
  return [set.homePoints, set.awayPoints]
}
const undoDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(d => /undo/i.test(d.textContent))

describe('Scoreboard: the undo key', () => {
  it('between rallies, Backspace asks the undo question and Enter undoes the last point', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch())
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    press('Backspace')
    await waitFor(() => expect(undoDialog()).toBeTruthy(), { timeout: 5000 })
    await settle()
    press('Enter')
    await waitFor(async () => expect(await score()).toEqual([1, 0]), { timeout: 5000 })
    expect((await ofType('point')).length).toBe(1)
    expect((await ofType('rally_start')).length).toBe(1)
    await waitFor(() => expect(undoDialog()).toBeFalsy(), { timeout: 5000 })
  }, 60000)

  it('during a rally, Backspace asks too and Enter takes the rally start back', async () => {
    setViewport(1280, 800)
    mount(await setUpMatch())
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    press('Enter')
    await waitFor(async () => expect((await ofType('rally_start')).length).toBe(3), { timeout: 5000 })
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 5000 })
    await settle()
    press('Backspace')
    await waitFor(() => expect(undoDialog()).toBeTruthy(), { timeout: 5000 })
    await settle()
    press('Enter')
    await waitFor(async () => expect((await ofType('rally_start')).length).toBe(2), { timeout: 5000 })
    expect(await score()).toEqual([1, 1])
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 5000 })
  }, 60000)
})
