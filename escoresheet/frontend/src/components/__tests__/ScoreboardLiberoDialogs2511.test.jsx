// The libero dialogs after the tester feedback of 24.11.2026 (owner 25.11.2026),
// on the real scoring screen:
//  1. the title says what happens ("Libero OUT", "Libero IN?"), no sentence;
//     IN (green, up arrow) first, then OUT (red, down arrow)
//  2. the rotation to the front row stays a notice with OK
//  3. the re-entry question: Confirm / Not now
//  4. "Not now" keeps it away for that team at the next rotations
//  6. the libero menu says why "Libero out" waits: "After finished rally"
// 10. a drop the rules refuse says why; the player menu shows the refused
//     numbers greyed out, a tap says why
// 11. Undo takes back the whole rally: with a rally in play, its start and
//     the point before it go with one Undo
//  5. both teams' libero at once: one dialog, a card per team, each answered on its own
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
async function setUp({ home = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], liberos = { 11: 'libero1', 12: 'libero2' }, awayLiberos = {}, before = () => {} } = {}) {
  const homeId = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const awayId = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const rows = []
  for (const [teamId, numbers] of [[homeId, home], [awayId, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]]) {
    for (const n of numbers) rows.push({ teamId, number: n, name: `P${n}`, lastName: `P${n}`, firstName: 'X', ...((teamId === homeId ? liberos : awayLiberos)[n] ? { libero: (teamId === homeId ? liberos : awayLiberos)[n] } : {}), ...(n === 1 ? { isCaptain: true } : {}) })
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

describe('10: refused substitutions say why (tester feedback 24.11.2026)', () => {
  it('the player the libero replaced is greyed out among the numbers; a tap says why, nothing is recorded', async () => {
    const { matchId } = await setUp({ before: (add) => { add.liberoIn(11, 'libero1'); add.rally() } })
    await openScreen(matchId, 11)
    await openCourtMenu(2)
    await tap(button('Substitution', playerMenu()))
    await waitFor(() => expect(playerMenu().querySelector('[data-refused-sub="5"]')).toBeTruthy())
    const chips = [...playerMenu().querySelectorAll('button')].filter(b => /^\d+$/.test(b.textContent.trim()))
    expect(chips.map(b => b.textContent.trim())).toEqual(['5', '7', '8', '9', '10'])
    await tap(playerMenu().querySelector('[data-refused-sub="5"]'))
    await waitFor(() => expect(document.body.textContent).toContain('#5: the libero is on court for him, he comes back only for the libero'), { timeout: 3000 })
    expect(await ofType('substitution')).toHaveLength(0)
  }, 30000)

  it('a libero dragged onto a front-row player: the drop says why', async () => {
    const { matchId } = await setUp()
    await openScreen(matchId, 2)
    const store = {}
    const dt = { setData: (k, v) => { store[k] = v }, getData: (k) => store[k], setDragImage: () => {}, effectAllowed: 'all', dropEffect: 'none', types: [] }
    fireEvent.dragStart(benchLibero(11), { dataTransfer: dt })
    await wait(200)
    expect(fireEvent.dragOver(court(2), { dataTransfer: dt })).toBe(false) // accepted, so that it can say why
    fireEvent.drop(court(2), { dataTransfer: dt })
    await waitFor(() => expect(document.body.textContent).toContain('Liberos can only enter back-row positions (I, V, VI)'), { timeout: 3000 })
    expect(await ofType('libero_entry')).toHaveLength(0)
  }, 30000)
})

describe('11: Undo takes back the whole rally (owner 25.11.2026)', () => {
  it('with a rally in play, one Undo takes back its start and the point before it; the dialog names the point', async () => {
    const { matchId } = await setUp() // one rally played: 1:0 for home
    await openScreen(matchId)
    await tap(button('Start rally'))
    const next = await waitFor(() => {
      const el = button('Yes, start rally') || button('Point A')
      if (!el) throw new Error('not in play yet')
      return el
    }, { timeout: 5000 })
    if (next.textContent.trim() === 'Yes, start rally') await tap(next)
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 5000 })
    await tap(button('Undo'))
    await waitFor(() => expect(button('Yes')).toBeTruthy(), { timeout: 5000 })
    const confirm = dialog(/undo/i)
    expect(confirm?.textContent).toMatch(/Point/)
    expect(confirm?.textContent).not.toMatch(/Rally start/i)
    await tap(button('Yes'))
    await waitFor(async () => expect(await ofType('point')).toHaveLength(0), { timeout: 10000 })
    expect(await ofType('rally_start')).toHaveLength(0)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 5000 })
  }, 30000)

  it('a time-out between the point and the rally start: Undo takes the rally start only', async () => {
    const { matchId } = await setUp({ before: (add) => { add.event('timeout', { team: 'away' }) } })
    await openScreen(matchId)
    await tap(button('Start rally'))
    const next = await waitFor(() => {
      const el = button('Yes, start rally') || button('Point A')
      if (!el) throw new Error('not in play yet')
      return el
    }, { timeout: 5000 })
    if (next.textContent.trim() === 'Yes, start rally') await tap(next)
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 5000 })
    await tap(button('Undo'))
    await waitFor(() => expect(button('Yes')).toBeTruthy(), { timeout: 5000 })
    await tap(button('Yes'))
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    expect(await ofType('point')).toHaveLength(1)
    expect(await ofType('timeout')).toHaveLength(1)
  }, 30000)
})

describe('5: both teams have a libero action at once (tester feedback 24.11.2026)', () => {
  // home: L1 #11 in for #5 at V; away: its libero #11 went out at a rotation
  // earlier. Away wins (side-out), home wins back: home rotates (its libero to
  // IV: out) and away, now receiving, may bring its libero back
  const both = (add) => {
    add.liberoIn(11, 'libero1')
    add.rally()
    add.event('libero_exit', { team: 'away', position: 'IV', liberoOut: 11, liberoType: 'libero1', playerIn: 4, reason: 'rotation_to_front_row' })
  }

  it('one dialog with both cards; either side first, the other stays', async () => {
    const { matchId } = await setUp({ awayLiberos: { 11: 'libero1' }, before: both })
    await openScreen(matchId, 11)
    await rally('away')
    await rally('home')
    await waitFor(() => expect(document.querySelector('[data-testid="libero-both"]')).toBeTruthy(), { timeout: 8000 })
    const rotation = document.querySelector('[data-testid="libero-both-rotation"]')
    const reentry = document.querySelector('[data-testid="libero-both-reentry"]')
    expect(rotation.textContent).toContain('Libero OUT')
    expect(reentry.textContent).toContain('Libero IN?')
    // court order: home (A) on the left, so its card comes first
    const cards = [...document.querySelectorAll('[data-testid^="libero-both-"]')].map(e => e.dataset.testid)
    expect(cards).toEqual(['libero-both-rotation', 'libero-both-reentry'])
    // away answers first (not blocked by home's notice)
    await tap(button('Not now', reentry))
    await waitFor(() => expect(document.querySelector('[data-testid="libero-both"]')).toBeNull())
    // home's notice is still there, as its own dialog
    expect(testIdText('libero-rotation-title')).toBe('Libero OUT')
    await tap(button('OK'))
    await waitFor(() => expect(document.querySelector('[data-testid="libero-rotation-title"]')).toBeNull())
  }, 60000)
})
