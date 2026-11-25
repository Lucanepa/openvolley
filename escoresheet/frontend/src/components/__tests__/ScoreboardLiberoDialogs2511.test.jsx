// The libero dialogs after the tester feedback of 24.11.2026 (owner 25.11.2026),
// on the real scoring screen:
//  1. the title says what happens ("Libero OUT", "Libero IN?"), no sentence;
//     IN (green, up arrow) first, then OUT (red, down arrow)
//  2. the rotation to the front row stays a notice with OK
//  3. the re-entry question: Confirm / Not now
//  4. "Not now" keeps it away for that team at the next rotations
//  6. the libero menu says why "Libero out" waits: "After finished rally"
// (harness of ScoreboardLiberoMenus.test.jsx)
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

// Start rally, then Point A (home, left) or Point B (away)
async function rally(winner) {
  await tap(button('Start rally'))
  const accidental = await waitFor(() => {
    const el = button('Yes, start rally') || button(winner === 'home' ? 'Point A' : 'Point B')
    if (!el) throw new Error('no point button yet')
    return el
  }, { timeout: 5000 })
  if (accidental.textContent.trim() === 'Yes, start rally') await tap(accidental)
  await waitFor(() => expect(button(winner === 'home' ? 'Point A' : 'Point B')).toBeTruthy(), { timeout: 5000 })
  await tap(button(winner === 'home' ? 'Point A' : 'Point B'))
  await settle()
}

const testIdText = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent.trim()
const boxesOrder = () => [...document.querySelectorAll('[data-testid^="libero-move-"]')].filter(e => /libero-move-(in|out)$/.test(e.dataset.testid)).map(e => e.dataset.testid)

describe('libero dialogs (tester feedback 24.11.2026)', () => {
  it('6: right after an entry, the libero menu says why Libero out waits; after a rally it does not', async () => {
    const { matchId } = await setUp({ before: (add) => { add.liberoIn(11, 'libero1') } })
    await openScreen(matchId, 11)
    await openCourtMenu(11)
    const out = [...playerMenu().querySelectorAll('button')].find(b => b.textContent.trim() === 'Libero out')
    expect(out?.disabled).toBe(true)
    expect(testIdText('libero-after-rally')).toBe('After finished rally')
  })

  it('6: once a rally is finished, no reason line (Libero out is open)', async () => {
    const { matchId } = await setUp({ before: (add) => { add.liberoIn(11, 'libero1'); add.rally() } })
    await openScreen(matchId, 11)
    await openCourtMenu(11)
    expect(button('Libero out', playerMenu())).toBeTruthy()
    expect(document.querySelector('[data-testid="libero-after-rally"]')).toBeNull()
  })

  it('1-4: rotation notice "Libero OUT" (OK, IN first), re-entry "Libero IN?" with Not now, then quiet at the next rotation', async () => {
    // L1 #11 in for #5 at V, a rally: home serves (I = #1)
    const { matchId } = await setUp({ before: (add) => { add.liberoIn(11, 'libero1'); add.rally() } })
    await openScreen(matchId, 11)
    // side-out to away, side-out back: home rotates, V -> IV: the libero goes out
    await rally('away')
    await rally('home')
    await waitFor(() => expect(testIdText('libero-rotation-title')).toBe('Libero OUT'), { timeout: 8000 })
    expect(document.body.textContent).not.toContain('Libero rotated to position IV')
    expect(boxesOrder()).toEqual(['libero-move-in', 'libero-move-out'])
    const inBox = document.querySelector('[data-testid="libero-move-in"]')
    const outBox = document.querySelector('[data-testid="libero-move-out"]')
    expect(inBox.textContent).toContain('↑')
    expect(inBox.textContent).toContain('#5')
    expect(outBox.textContent).toContain('↓')
    expect(outBox.textContent).toContain('#11')
    expect(button('Confirm')).toBeFalsy()
    await tap(button('OK'))
    // away wins: home receives, its libero may come back for the player at I
    await rally('away')
    await waitFor(() => expect(testIdText('libero-reentry-title')).toBe('Libero IN?'), { timeout: 8000 })
    expect(document.body.textContent).not.toContain('Sub libero in position I?')
    expect(boxesOrder()).toEqual(['libero-move-in', 'libero-move-out'])
    expect(button('Confirm')).toBeTruthy()
    await tap(button('Not now'))
    await waitFor(() => expect(document.querySelector('[data-testid="libero-reentry-title"]')).toBeNull())
    // 4: the libero brought in by hand, rotated out again, and the next chance
    // to bring it back: not asked again this set (it asked after every such exit)
    await rally('home')
    const atV = document.querySelector('.court-player[data-team="home"][data-court-position="V"]')
    expect(atV).toBeTruthy()
    fireEvent.click(atV)
    await waitFor(() => expect(playerMenu()).toBeTruthy(), { timeout: 3000 })
    await tap(button('Libero', playerMenu()))
    await waitFor(() => expect(liberoChips().length).toBeGreaterThan(0))
    await tap([...playerMenu().querySelectorAll('button')].find(b => /^11\s*\(L1\)$/.test(b.textContent.trim())))
    await waitFor(() => expect(court(11)).toBeTruthy(), { timeout: 5000 })
    await rally('away')
    await rally('home')
    await waitFor(() => expect(testIdText('libero-rotation-title')).toBe('Libero OUT'), { timeout: 8000 })
    await tap(button('OK'))
    await rally('away')
    await wait(800)
    expect(document.querySelector('[data-testid="libero-reentry-title"]')).toBeNull()
  }, 60000)
})
