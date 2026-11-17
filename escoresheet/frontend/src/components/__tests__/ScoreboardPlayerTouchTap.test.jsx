// One finger tap on a court or bench player opens its menu once, on every
// browser engine (owner's video on the Point Hub board, 17.11.2026: the
// player menu flickered open, shut, open).
//
// A short tap on a player whose touch the scoring screen claimed (hold to
// drag) is clicked by the screen itself at touchend (handleTouchEnd:
// target.click(), detail 0). Chromium, the Android WebView and Safari then
// send no click of their own. WebKitGTK (the desktop app on Linux, the board)
// still sends its compatibility mouse events and a click (detail 1) at the
// place of the touch, 0-2 ms after the touchend: on the menu's full-screen
// backdrop that dismissed the menu just opened; on the player it toggled it.
// That click is dropped as the echo of the tap (pointerPresses:
// trackOwnTapClicks). A desktop mouse click, a click after the echo window
// and the next deliberate tap still count.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, createEvent, waitFor, cleanup } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { scorerRelay } from '../../utils/relayPublisher'
import { resetPresses } from '../../utils/pointerPresses'

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
  resetPresses() // no echo window left over from the last test's taps
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
const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const anyButton = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text))
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type).sort((a, b) => a.seq - b.seq)
const lineupsOf = async (team) => (await ofType('lineup')).filter(e => e.payload?.team === team)
const court = (n, team = 'home') => document.querySelector(`.court-player[data-team="${team}"][data-player-number="${n}"]`)
const benchPlayer = (n, team = 'home') => document.querySelector(`[data-bench-player="${n}"][data-team="${team}"][data-is-libero="false"]`)
const benchLibero = (n, team = 'home') => document.querySelector(`[data-bench-player="${n}"][data-team="${team}"][data-is-libero="true"]`)
const playerMenu = () => document.querySelector('[data-player-action-menu]')
const dropdown = () => document.querySelector('[data-substitution-dropdown]')
const dropdownOptions = () => [...dropdown().querySelectorAll('button')].map(b => b.textContent.replace(/\s/g, '')).filter(text => text.startsWith('#'))
const confirmDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(d => button('Yes', d))
const sanctionYes = () => [...document.querySelectorAll('[role="dialog"] button')].find(b => /^(confirm|yes)/i.test(b.textContent.trim()) && !b.disabled)

// Set 1 (or set 2 with { set: 2 }), home serving and winning every rally,
// line-ups 1-6 for both teams. `players`: the shirt numbers of each team;
// `liberos`: number -> libero1 / libero2; `captain`: the team captain.
// `before(add)` adds events after the line-ups and the first rally.
async function setUp({ players = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12], liberos = { 12: 'libero1' }, captain = 1, set = 1, match = {}, before = () => {} } = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const rows = []
  for (const teamId of [home, away]) {
    for (const n of players) {
      rows.push({ teamId, number: n, name: `P${n}`, firstName: 'X', ...(liberos[n] ? { libero: liberos[n] } : {}), ...(n === captain ? { isCaptain: true } : {}) })
    }
  }
  await db.players.bulkAdd(rows)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true, ...match
  })
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  let seq = 1
  const ev = []
  const lineups = { home: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }, away: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' } }
  const add = {
    setIndex: 1,
    rally() {
      ev.push({ matchId, setIndex: this.setIndex, type: 'rally_start', payload: {}, seq: seq++, ts: t })
      ev.push({ matchId, setIndex: this.setIndex, type: 'point', payload: { team: 'home' }, seq: seq++, ts: t })
    },
    event(type, payload) {
      ev.push({ matchId, setIndex: this.setIndex, type, payload, seq: seq++, ts: t })
    },
    sub(position, playerOut, playerIn, flags = {}, team = 'home') {
      const at = seq++
      ev.push({ matchId, setIndex: this.setIndex, type: 'substitution', payload: { team, position, playerOut, playerIn: String(playerIn), isExceptional: false, isExpelled: false, isDisqualified: false, ...flags }, seq: at, ts: t })
      lineups[team] = { ...lineups[team], [position]: String(playerIn) }
      ev.push({ matchId, setIndex: this.setIndex, type: 'lineup', payload: { team, lineup: lineups[team], fromSubstitution: true }, seq: at + 0.1, ts: t })
    },
    liberoIn(position, playerOut, libero, team = 'home') {
      const at = seq++
      ev.push({ matchId, setIndex: this.setIndex, type: 'libero_entry', payload: { team, position, playerOut, liberoIn: libero, liberoType: liberos[libero] }, seq: at, ts: t })
      lineups[team] = { ...lineups[team], [position]: String(libero) }
      ev.push({ matchId, setIndex: this.setIndex, type: 'lineup', payload: { team, lineup: lineups[team], liberoSubstitution: { position, liberoNumber: libero, playerNumber: playerOut, liberoType: liberos[libero] } }, seq: at + 0.1, ts: t })
    },
    startSet(index) {
      this.setIndex = index
      lineups.home = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
      lineups.away = { ...lineups.home }
      for (const team of ['home', 'away']) ev.push({ matchId, setIndex: index, type: 'lineup', payload: { team, lineup: lineups[team], isInitial: true }, seq: seq++, ts: t })
      ev.push({ matchId, setIndex: index, type: 'set_start', payload: {}, seq: seq++, ts: t })
      this.rally()
    }
  }
  ev.push({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  if (set === 2) {
    // set 1 played: what `before` adds is in set 1, then set 2 starts
    await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 10, finished: true, startTime: t, endTime: t })
    add.startSet(1)
    before(add)
    ev.push({ matchId, setIndex: 1, type: 'set_end', payload: { team: 'home', setIndex: 1, homePoints: 25, awayPoints: 10 }, seq: seq++, ts: t })
    await db.sets.add({ matchId, index: 2, homePoints: 1, awayPoints: 0, finished: false, startTime: t })
    add.startSet(2)
  } else {
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: t })
    add.startSet(1)
    before(add)
  }
  await db.events.bulkAdd(ev)
  const points = ev.filter(e => e.type === 'point' && e.setIndex === set).length
  await db.sets.where({ matchId, index: set }).modify({ homePoints: points, awayPoints: 0 })
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

async function openScreen(matchId, courtNumber) {
  mount(matchId)
  await waitFor(() => expect(court(courtNumber)).toBeTruthy(), { timeout: 10000 })
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
  await settle()
}

async function openMenu(n) {
  fireEvent.click(court(n))
  await waitFor(() => expect(playerMenu()).toBeTruthy(), { timeout: 3000 })
}

// Court disc -> Sanction -> Expulsion -> Confirm
async function expelFromCourt(n, count = 1) {
  await openMenu(n)
  fireEvent.click(button('Sanction', playerMenu()))
  await waitFor(() => expect([...playerMenu().querySelectorAll('button')].some(b => /expul/i.test(b.textContent))).toBe(true))
  fireEvent.click([...playerMenu().querySelectorAll('button')].find(b => /expul/i.test(b.textContent)))
  await settle()
  fireEvent.click(sanctionYes())
  await waitFor(async () => expect(await ofType('sanction')).toHaveLength(count), { timeout: 5000 })
  await settle()
}


const X = 300
const Y = 400
const backdrop = (menu) => menu.closest('.modal-wrapper-roll-down')?.previousElementSibling
const benchMenu = () => document.querySelector('[data-bench-player-action-menu]')

// A short tap: touchstart, touchend 80 ms later (the screen clicks the
// player). Returns the touchend's time (performance.now())
async function touchTap(el) {
  fireEvent.touchStart(el, { touches: [{ clientX: X, clientY: Y }] })
  await wait(80)
  const t = performance.now()
  fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientX: X, clientY: Y }] })
  return t
}

// WebKitGTK on a busy main thread (bench, 17.11.2026): the compatibility
// sequence ARRIVES after the touchend, but stamped with the earlier hardware
// time, `before` ms BEFORE the touchend (79 ms with the thread blocked
// 100 ms, ~330 ms at 400 ms)
function stampedCompatibilityClick(el, timeStamp) {
  const at = { clientX: X, clientY: Y }
  const send = (kind, init) => {
    const ev = createEvent[kind](el, { ...at, button: 0, ...init })
    Object.defineProperty(ev, 'timeStamp', { value: timeStamp })
    fireEvent(el, ev)
  }
  send('pointerDown', { pointerType: 'mouse', pointerId: 1 })
  send('mouseDown', { detail: 1 })
  send('pointerUp', { pointerType: 'mouse', pointerId: 1 })
  send('mouseUp', { detail: 1 })
  send('click', { detail: 1 })
}

// WebKitGTK's compatibility sequence after the touchend, on whatever is at
// the place of the touch now
function compatibilityClick(el) {
  const at = { clientX: X, clientY: Y }
  fireEvent.pointerDown(el, { ...at, pointerType: 'mouse', pointerId: 1, button: 0 })
  fireEvent.mouseDown(el, { ...at, button: 0, detail: 1 })
  fireEvent.pointerUp(el, { ...at, pointerType: 'mouse', pointerId: 1, button: 0 })
  fireEvent.mouseUp(el, { ...at, button: 0, detail: 1 })
  fireEvent.click(el, { ...at, button: 0, detail: 1 })
}

describe('one finger tap on a player: one menu action (WebKitGTK compatibility click)', () => {
  it('court player: the compatibility click on the backdrop does not shut the menu the tap opened', async () => {
    const matchId = await setUp()
    await openScreen(matchId, 2)
    await touchTap(court(2))
    const menu = playerMenu()
    expect(menu).toBeTruthy()
    const bd = backdrop(menu)
    expect(bd).toBeTruthy()
    compatibilityClick(bd)
    await wait(300)
    expect(playerMenu()).toBeTruthy()
    // a deliberate tap on the backdrop afterwards still closes it
    await wait(900)
    fireEvent.pointerDown(backdrop(playerMenu()), { clientX: 5, clientY: 5, pointerType: 'mouse' })
    fireEvent.pointerUp(backdrop(playerMenu()), { clientX: 5, clientY: 5, pointerType: 'mouse' })
    fireEvent.click(backdrop(playerMenu()), { clientX: 5, clientY: 5, detail: 1 })
    await waitFor(() => expect(playerMenu()).toBeFalsy())
  }, 60000)

  it('court player: the compatibility click on the player itself does not toggle the menu shut', async () => {
    const matchId = await setUp()
    await openScreen(matchId, 2)
    await touchTap(court(2))
    expect(playerMenu()).toBeTruthy()
    compatibilityClick(court(2))
    await wait(300)
    expect(playerMenu()).toBeTruthy()
  }, 60000)

  for (const [before, blocked] of [[80, 100], [330, 400]]) {
    it(`busy main thread: the compatibility click stamped ${before} ms BEFORE the touchend, on the backdrop, does not shut the menu`, async () => {
      const matchId = await setUp()
      await openScreen(matchId, 2)
      const touchEndT = await touchTap(court(2))
      expect(playerMenu()).toBeTruthy()
      await wait(blocked) // the thread was busy: the sequence arrives late
      stampedCompatibilityClick(backdrop(playerMenu()), touchEndT - before)
      await wait(300)
      expect(playerMenu()).toBeTruthy()
    }, 60000)

    it(`busy main thread: the compatibility click stamped ${before} ms BEFORE the touchend, on the player, does not toggle the menu shut`, async () => {
      const matchId = await setUp()
      await openScreen(matchId, 2)
      const touchEndT = await touchTap(court(2))
      expect(playerMenu()).toBeTruthy()
      await wait(blocked)
      stampedCompatibilityClick(court(2), touchEndT - before)
      await wait(300)
      expect(playerMenu()).toBeTruthy()
    }, 60000)
  }

  it('busy main thread, bench player: the early-stamped compatibility click on the backdrop is dropped', async () => {
    const matchId = await setUp()
    await openScreen(matchId, 2)
    const touchEndT = await touchTap(benchPlayer(7))
    await waitFor(() => expect(benchMenu()).toBeTruthy())
    await wait(400)
    stampedCompatibilityClick(backdrop(benchMenu()), touchEndT - 330)
    await wait(300)
    expect(benchMenu()).toBeTruthy()
  }, 60000)

  it('a deliberate second tap right after the first one still closes the menu (its touchstart ends the echo wait)', async () => {
    const matchId = await setUp()
    await openScreen(matchId, 2)
    await touchTap(court(2))
    expect(playerMenu()).toBeTruthy()
    const bd = backdrop(playerMenu())
    await wait(150)
    // the second finger tap lands on the backdrop; WebKitGTK sends its
    // compatibility sequence there (no own click: the touch is not on a player)
    fireEvent.touchStart(bd, { touches: [{ clientX: X, clientY: Y }] })
    fireEvent.pointerDown(bd, { clientX: X, clientY: Y, pointerType: 'touch', pointerId: 2 })
    fireEvent.pointerUp(bd, { clientX: X, clientY: Y, pointerType: 'touch', pointerId: 2 })
    fireEvent.touchEnd(bd, { touches: [], changedTouches: [{ clientX: X, clientY: Y }] })
    compatibilityClick(bd)
    await waitFor(() => expect(playerMenu()).toBeFalsy())
  }, 60000)

  it('Chromium / Android / Safari (no compatibility click): the tap opens the menu, the next tap closes it', async () => {
    const matchId = await setUp()
    await openScreen(matchId, 3)
    await touchTap(court(3))
    expect(playerMenu()).toBeTruthy()
    await wait(150)
    // the next deliberate tap on the same player, soon after: it counts
    await touchTap(court(3))
    await waitFor(() => expect(playerMenu()).toBeFalsy())
  }, 60000)

  it('a desktop mouse click (no touch) opens the menu, and a click after the echo window is a click', async () => {
    const matchId = await setUp()
    await openScreen(matchId, 4)
    fireEvent.click(court(4), { clientX: X, clientY: Y, detail: 1 })
    await waitFor(() => expect(playerMenu()).toBeTruthy())
    fireEvent.click(court(4), { clientX: X, clientY: Y, detail: 1 })
    await waitFor(() => expect(playerMenu()).toBeFalsy())
    await touchTap(court(4))
    expect(playerMenu()).toBeTruthy()
    await wait(1100)
    fireEvent.click(court(4), { clientX: X, clientY: Y, detail: 1 })
    await waitFor(() => expect(playerMenu()).toBeFalsy())
  }, 60000)

  it('bench player: one tap, one menu, the compatibility click is dropped', async () => {
    const matchId = await setUp()
    await openScreen(matchId, 2)
    await touchTap(benchPlayer(7))
    await waitFor(() => expect(benchMenu()).toBeTruthy())
    // on the menu's backdrop (what lies under the finger once it is open)
    compatibilityClick(backdrop(benchMenu()))
    await wait(300)
    expect(benchMenu()).toBeTruthy()
  }, 60000)

  it('touch drag of a bench player onto the court still substitutes (no click on release)', async () => {
    const matchId = await setUp()
    await openScreen(matchId, 2)
    const chip = benchPlayer(7)
    const target = court(2)
    fireEvent.touchStart(chip, { touches: [{ clientX: 10, clientY: 10 }] })
    await wait(1800)
    fireEvent.touchMove(chip, { touches: [{ clientX: 50, clientY: 50 }] })
    await wait(100)
    document.elementFromPoint = () => target
    fireEvent.touchEnd(chip, { touches: [], changedTouches: [{ clientX: 50, clientY: 50 }] })
    await waitFor(() => expect(button('Confirm') || button('Yes')).toBeTruthy(), { timeout: 3000 })
    expect(benchMenu()).toBeFalsy()
    expect(playerMenu()).toBeFalsy()
  }, 60000)
})
