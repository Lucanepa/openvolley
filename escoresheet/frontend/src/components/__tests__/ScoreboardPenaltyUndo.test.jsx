// One Undo after a penalty takes back the penalty and its point.
//
// A misconduct penalty (or a delay penalty) was written as a sanction and
// then the opponent's point, two actions to Undo, which takes back the newest
// one only: the score and serve went back, the red card stayed on the
// scoresheet, locally and on the server, without its point, and counted in
// the team's sanction ladder (stress test 2026-10-25). The point now names
// its penalty (payload.penaltySeq) and Undo takes both back.
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with clicks.
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
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  setViewport(saved.width, saved.height)
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const dialog = (re) => [...document.querySelectorAll('[role="dialog"]')].find(d => re.test(d.textContent))

const sanctions = async () => (await db.events.toArray()).filter(e => e.type === 'sanction').map(e => `${e.payload.team}:${e.payload.type}`)
const points = async () => (await db.events.toArray()).filter(e => e.type === 'point').length
const rallyStarts = async () => (await db.events.toArray()).filter(e => e.type === 'rally_start').length
const score = async (matchId) => {
  const set = await db.sets.where({ matchId, index: 1 }).first()
  return `${set.homePoints}:${set.awayPoints}`
}

// Set 1 at 2:1 (home 2, away 1), no rally in play, team A (home) on the left;
// away already has a delay warning, so its next delay is a penalty
async function setUpMatch() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away',
    sanctions: { delayWarningAway: true }
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 2, awayPoints: 1, finished: false, startTime: t })
  let seq = 1
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  const events = [
    { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, isInitial: true }, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup, isInitial: true }, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'sanction', payload: { team: 'away', type: 'delay_warning' }, seq: seq++, ts: t }
  ]
  // away's point first, then home's two (no side-out rotation to follow)
  for (const team of ['away', 'home', 'home']) {
    events.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
    events.push({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: t })
  }
  await db.events.bulkAdd(events)
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

async function confirmIn(re, label) {
  await waitFor(() => expect(dialog(re) && button(label, dialog(re))).toBeTruthy(), { timeout: 5000 })
  await wait(GHOST_CLICK_MS)
  fireEvent.click(button(label, dialog(re)))
}

async function undoOnce() {
  await wait(GHOST_CLICK_MS)
  fireEvent.click(document.querySelector('[data-help-id="scoreboard-undo"]'))
  await confirmIn(/Confirm undo/, 'Yes')
  await waitFor(() => expect(dialog(/Confirm undo/)).toBeFalsy(), { timeout: 5000 })
  await wait(500)
}

describe('Scoreboard: Undo after a penalty', () => {
  it('a player penalty: one Undo takes back the penalty and its point', async () => {
    setViewport(1280, 800)
    const matchId = await setUpMatch()
    mount(matchId)
    const player = () => document.querySelector('.court-player[data-team="home"][data-player-number="2"]')
    await waitFor(() => expect(player() && button('Start rally')).toBeTruthy(), { timeout: 10000 })

    fireEvent.click(player())
    await waitFor(() => expect(button('Sanction')).toBeTruthy(), { timeout: 3000 })
    fireEvent.click(button('Sanction'))
    await waitFor(() => expect(button('Penalty')).toBeTruthy(), { timeout: 3000 })
    fireEvent.click(button('Penalty'))
    await confirmIn(/Confirm/, 'Confirm')
    await waitFor(async () => expect(await score(matchId)).toBe('2:2'), { timeout: 5000 })
    expect(await sanctions()).toEqual(['away:delay_warning', 'home:penalty'])
    const starts = await rallyStarts()

    await undoOnce()
    expect(await score(matchId)).toBe('2:1')
    expect(await sanctions()).toEqual(['away:delay_warning'])
    expect(await points()).toBe(3)
    // the penalty point won no rally: the rallies before it stay
    expect(await rallyStarts()).toBe(starts)
  }, 60000)

  it('a delay penalty: one Undo takes back the delay penalty and its point', async () => {
    setViewport(1280, 800)
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(button('Delay penalty')).toBeTruthy(), { timeout: 5000 })

    fireEvent.click(button('Delay penalty'))
    await confirmIn(/Record a delay penalty/, 'Yes')
    await waitFor(async () => expect(await score(matchId)).toBe('3:1'), { timeout: 5000 })
    expect(await sanctions()).toEqual(['away:delay_warning', 'away:delay_penalty'])
    const starts = await rallyStarts()

    await undoOnce()
    expect(await score(matchId)).toBe('2:1')
    expect(await sanctions()).toEqual(['away:delay_warning'])
    expect(await rallyStarts()).toBe(starts)
  }, 60000)
})
