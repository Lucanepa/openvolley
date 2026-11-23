// The libero menus and the re-designation on the real scoring screen (audit
// round 3; owner decisions 23.11.2026).
//  - LOG-13: a libero on court is not declared unable (Swiss exam Q11): his
//    court menu offers "Injury / illness" only.
// Over the app's real Dexie database (fake IndexedDB), at tablet width.
// Network is off: no relay socket, no fetch.
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
import { scorerRelay } from '../../utils/relayPublisher'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// As in ScoreboardInterruptionFlows.test.jsx: under jsdom + fake-indexeddb a
// scorer action can lose Dexie's transaction zone part-way and end with
// PrematureCommitError (not in Chrome). Only that error is let through.
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
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, width: window.innerWidth, height: window.innerHeight, elementFromPoint: document.elementFromPoint }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(scorerRelay, 'listen').mockImplementation(() => () => {})
  vi.spyOn(scorerRelay, 'send').mockImplementation(() => true)
  window.innerWidth = 1280
  window.innerHeight = 800
})
beforeEach(async () => {
  cleanup()
  localStorage.removeItem('displayMode')
  document.elementFromPoint = saved.elementFromPoint
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  window.innerWidth = saved.width
  window.innerHeight = saved.height
  document.elementFromPoint = saved.elementFromPoint
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const settle = () => wait(GHOST_CLICK_MS + 150)
const buttons = (root = document) => [...root.querySelectorAll('button')].filter(b => !b.disabled)
const button = (text, root = document) => buttons(root).find(b => b.textContent.trim() === text)
const buttonStarting = (text, root = document) => buttons(root).find(b => b.textContent.trim().startsWith(text))
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type).sort((a, b) => a.seq - b.seq)
const court = (n, team = 'home') => document.querySelector(`.court-player[data-team="${team}"][data-player-number="${n}"]`)
const benchLibero = (n, team = 'home') => document.querySelector(`[data-bench-player="${n}"][data-team="${team}"][data-is-libero="true"]`)
const playerMenu = () => document.querySelector('[data-player-action-menu]')
const liberoMenu = () => document.querySelector('[data-libero-bench-action-menu]')
const dialog = (re) => [...document.querySelectorAll('[role="dialog"]')].find(d => re.test(d.textContent))
const liberoChips = () => [...playerMenu().querySelectorAll('button')].map(b => b.textContent.trim()).filter(text => /\((L1|L2|LR)\)$/.test(text))
const tap = async (el) => { expect(el).toBeTruthy(); await settle(); fireEvent.click(el) }

// Set 1 under way, home serving and winning every rally, line-ups 1-6.
// `home`: the home team's numbers, `liberos`: their libero marks.
// `before(add)` adds events after the first rally.
async function setUp({ home = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], liberos = { 11: 'libero1', 12: 'libero2' }, before = () => {} } = {}) {
  const homeId = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const awayId = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const rows = []
  for (const [teamId, numbers] of [[homeId, home], [awayId, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]]) {
    for (const n of numbers) rows.push({ teamId, number: n, name: `P${n}`, lastName: `P${n}`, firstName: 'X', ...(teamId === homeId && liberos[n] ? { libero: liberos[n] } : {}), ...(n === 1 ? { isCaptain: true } : {}) })
  }
  await db.players.bulkAdd(rows)
  const matchId = await db.matches.add({
    homeTeamId: homeId, awayTeamId: awayId, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true
  })
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  let seq = 1
  const ev = []
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  const add = {
    rally() {
      ev.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
      ev.push({ matchId, setIndex: 1, type: 'point', payload: { team: 'home' }, seq: seq++, ts: t })
    },
    event(type, payload) { ev.push({ matchId, setIndex: 1, type, payload, seq: seq++, ts: t }) },
    // the libero in for the player at V, as writeLiberoEntry records it
    liberoIn(liberoIn, liberoType, position = 'V') {
      const s = seq++
      ev.push({ matchId, setIndex: 1, type: 'libero_entry', payload: { team: 'home', position, playerOut: Number(lineup[position]), liberoIn, liberoType }, seq: s, ts: t })
      ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { ...lineup, [position]: String(liberoIn) }, liberoSubstitution: { position, liberoNumber: liberoIn, playerNumber: Number(lineup[position]), liberoType } }, seq: s + 0.1, ts: t })
    }
  }
  ev.push({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: t })
  for (const team of ['home', 'away']) ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  add.rally()
  before(add)
  await db.events.bulkAdd(ev)
  const points = ev.filter(e => e.type === 'point').length
  await db.sets.where({ matchId, index: 1 }).modify({ homePoints: points, awayPoints: 0 })
  return { matchId, homeId }
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

async function openScreen(matchId, onCourt = 5) {
  mount(matchId)
  await waitFor(() => expect(court(onCourt)).toBeTruthy(), { timeout: 10000 })
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
  await settle()
}

async function openCourtMenu(n) {
  fireEvent.click(court(n))
  await waitFor(() => expect(playerMenu()).toBeTruthy(), { timeout: 3000 })
}

async function closeMenu() {
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(playerMenu()).toBeFalsy())
}

describe('LOG-13: a libero on court cannot be declared unable (Swiss exam Q11)', () => {
  it('his court menu offers "Injury / illness" under "Unable to play", not "Declared unable"', async () => {
    const { matchId } = await setUp({ before: (add) => { add.liberoIn(12, 'libero2'); add.rally() } })
    await openScreen(matchId, 12)
    await openCourtMenu(12)
    expect(button('Libero out', playerMenu())).toBeTruthy()
    await tap(button('Unable to play', playerMenu()))
    await waitFor(() => expect(button('Injury / illness', playerMenu())).toBeTruthy())
    expect(buttonStarting('Declared', playerMenu())).toBeFalsy()
    await closeMenu()
    // the bench libero's menu still offers the declaration
    fireEvent.click(benchLibero(11))
    await waitFor(() => expect(liberoMenu()).toBeTruthy(), { timeout: 3000 })
    await tap(button('Unable to play', liberoMenu()))
    await waitFor(() => expect(button('Declared unable', liberoMenu())).toBeTruthy())
  }, 60000)
})
