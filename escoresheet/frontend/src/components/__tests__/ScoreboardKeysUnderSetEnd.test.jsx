// Keyboard shortcuts under the open "Set N end" dialog.
//
// With keyboard shortcuts on (Options; off by default) a scorer working by
// rhythm pressed Enter and then A under the "Set 1 end" dialog: the won set
// got a rally start and a 26th point the dialog never showed, and confirming
// stored the set as 25:22 while its point events (local and on the server,
// where the scoresheet is built from them) said 26:22. Q / P stacked a
// time-out request on the dialog (stress test 2026-10-25). The keys left out
// the set-end dialog (and a few others) from the dialogs that hold them.
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
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const events = async () => (await db.events.toArray()).sort((a, b) => a.seq - b.seq)
const ofType = async (type) => (await events()).filter(e => e.type === type)
const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)

// Set 1 at 24:22 (home 24, away 22), a rally in play, team A (home) on the left
async function setUpSetPoint() {
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
  await db.sets.add({ matchId, index: 1, homePoints: 24, awayPoints: 22, finished: false, startTime: t })
  let seq = 1
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  const events = [
    { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, isInitial: true }, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup, isInitial: true }, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t }
  ]
  // the away points first, then the home run (no side-out rotation to follow)
  for (let k = 0; k < 46; k++) {
    events.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
    events.push({ matchId, setIndex: 1, type: 'point', payload: { team: k < 22 ? 'away' : 'home' }, seq: seq++, ts: t })
  }
  events.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
  await db.events.bulkAdd(events)
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const press = (key) => fireEvent.keyDown(window, { key })
const setEndDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(d => /Set 1 end/.test(d.textContent))

describe('Scoreboard: keyboard shortcuts under the Set end dialog', () => {
  it('Enter, A / L and Q / P record nothing while "Set 1 end" is open', async () => {
    setViewport(1280, 800)
    mount(await setUpSetPoint())
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 10000 })
    await settle()
    // the set point, by key
    press('a')
    await waitFor(() => expect(setEndDialog()).toBeTruthy(), { timeout: 10000 })
    const before = (await events()).length
    expect((await db.sets.toArray())[0]).toMatchObject({ homePoints: 25, awayPoints: 22, finished: false })

    // in rhythm: Enter at the next whistle, then A / L at the rally's end
    await settle()
    press('Enter')
    await settle()
    press('a')
    await settle()
    press('l')
    await settle()
    // and the time-out keys
    press('q')
    press('p')
    await wait(300)

    expect((await events()).length).toBe(before)
    expect((await ofType('point')).length).toBe(47)
    expect((await db.sets.toArray())[0]).toMatchObject({ homePoints: 25, awayPoints: 22, finished: false })
    expect(button('Confirm time-out')).toBeFalsy()
    expect(setEndDialog()).toBeTruthy()
  }, 60000)
})
