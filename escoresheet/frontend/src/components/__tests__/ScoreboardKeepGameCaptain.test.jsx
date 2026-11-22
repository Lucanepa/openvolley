// "Keep as game captain" (owner 2026-11-22): a switch in the game-captain
// dialog. While it is on, the player last chosen is designated without the
// dialog whenever the app would ask (the team captain off court, no acting
// game captain among the six, FIVB 5.1.2) and he is on court; the dialog
// comes back only when he is not, or once the switch is off. The owner's
// case: a libero team captain, who leaves the court at almost every rotation.
//
// On the real scoring screen over the app's Dexie database (fake IndexedDB),
// at tablet width, through its real paths: the libero (the home team
// captain, #12) leaves by itself when the rotation takes it from V to the
// front row (FIVB 19.3.1.2), a game captain is then needed.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { keepFieldsFromEvents } from '../../domain/gameCaptainKeep'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// As in ScoreboardLiberoExitReopenSet.test.jsx: under jsdom + fake-indexeddb
// a scorer action can end with PrematureCommitError (not in Chrome); only
// that error is let through. Each test waits until the screen's work is
// through (no open IndexedDB transaction, no new log line for a while).
const isEnvPrematureCommit = (reason) => reason?.name === 'PrematureCommitError'
let rejectionListeners = []
const filterRejections = (reason, promise) => {
  if (isEnvPrematureCommit(reason)) return
  for (const listener of rejectionListeners) listener(reason, promise)
}
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug']
let consoleSpies = []
const consoleCalls = () => consoleSpies.reduce((n, spy) => n + spy.mock.calls.length, 0)
let openTransactions = 0
const realTransaction = IDBDatabase.prototype.transaction
function countedTransaction(...args) {
  const tx = realTransaction.apply(this, args)
  openTransactions++
  let open = true
  const close = () => { if (open) { open = false; openTransactions-- } }
  tx.addEventListener('complete', close)
  tx.addEventListener('abort', close)
  return tx
}
async function untilQuiet({ quietMs = 750, maxMs = 20000 } = {}) {
  const start = Date.now()
  let seen = consoleCalls()
  let since = Date.now()
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 50))
    const now = consoleCalls()
    if (now !== seen || openTransactions > 0) { seen = now; since = Date.now() } else if (Date.now() - since >= quietMs) return
  }
  throw new Error(`the scoring screen was still at work after ${maxMs} ms (${openTransactions} open transactions)`)
}

let saved
beforeAll(() => {
  consoleSpies = CONSOLE_METHODS.map((m) => vi.spyOn(console, m))
  IDBDatabase.prototype.transaction = countedTransaction
  rejectionListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', filterRejections)
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, width: window.innerWidth, height: window.innerHeight }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  window.innerWidth = 1280
  window.innerHeight = 800
})
beforeEach(async () => {
  cleanup()
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(async () => {
  cleanup()
  await untilQuiet()
})
afterAll(() => {
  cleanup()
  IDBDatabase.prototype.transaction = realTransaction
  window.innerWidth = saved.width
  window.innerHeight = saved.height
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type).sort((a, b) => a.seq - b.seq)
const designations = () => ofType('court_captain_designation')
const court = (team, n) => document.querySelector(`.court-player[data-team="${team}"][data-player-number="${n}"]`)
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const captainDialog = () => [...document.querySelectorAll('[role=dialog]')].find(d => d.querySelector('[data-testid="game-captain-keep"]')) || null
const keepSwitch = () => captainDialog()?.querySelector('[data-testid="game-captain-keep-switch"]') || null
const chip = () => document.querySelector('[data-game-captain-chip]')

const LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }

// Home: #12 is the libero AND the team captain; away: #1 captain. Set 1,
// away served first and won the first rally (home receives); the libero came
// in for #5 at V. `match`: the game-captain fields as stored.
async function setUp(match = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const [teamId, captain] of [[home, 12], [away, 1]]) {
    for (let n = 1; n <= 12; n++) {
      players.push({ teamId, number: n, name: `P${n}`, firstName: 'X', ...(n === 12 ? { libero: 'libero1' } : {}), ...(n === captain ? { isCaptain: true } : {}) })
    }
  }
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'away', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
    ...match
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 1, finished: false, startTime: t })
  let seq = 1
  const ev = [{ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t }]
  for (const team of ['home', 'away']) ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup: LINEUP, isInitial: true }, seq: seq++, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'point', payload: { team: 'away' }, seq: seq++, ts: t })
  const at = seq++
  ev.push({ matchId, setIndex: 1, type: 'libero_entry', payload: { team: 'home', position: 'V', playerOut: 5, liberoIn: 12, liberoType: 'libero1' }, seq: at, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { ...LINEUP, V: '12' }, liberoSubstitution: { position: 'V', liberoNumber: 12, playerNumber: 5, liberoType: 'libero1' } }, seq: at + 0.1, ts: t })
  await db.events.bulkAdd(ev)
  return matchId
}

async function mountAndWait(matchId, onCourt = 12) {
  mount(matchId)
  await waitFor(() => expect(court('home', onCourt)).toBeTruthy(), { timeout: 10000 })
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
  await settle()
}

// One rally won by `team` (Point A = home, Point B = away)
async function rally(team) {
  const before = (await ofType('point')).length
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
  await settle()
  fireEvent.click(button('Start rally'))
  const label = team === 'home' ? 'Point A' : 'Point B'
  await waitFor(() => expect(button(label)).toBeTruthy(), { timeout: 5000 })
  await settle()
  fireEvent.click(button(label))
  await waitFor(async () => expect((await ofType('point')).length).toBe(before + 1), { timeout: 5000 })
}

// Home wins the rally: the rotation takes the libero (team captain) from V
// to IV, he leaves, #5 is back; the game captain is checked 300 ms later
async function liberoCaptainLeaves() {
  const exits = (await ofType('libero_exit')).length
  await rally('home')
  await waitFor(async () => expect((await ofType('libero_exit')).length).toBe(exits + 1), { timeout: 5000 })
  await sleep(900)
}

describe('Keep as game captain: the libero team captain leaves the court', () => {
  it('switch on, the kept player on court: designated without the dialog, as a chosen one', async () => {
    const matchId = await setUp({ homeKeepCourtCaptain: true, homeRememberedCourtCaptain: 3, homeCourtCaptain: null })
    await mountAndWait(matchId)
    // the Game captain button stays, quiet, with the kept player
    await waitFor(() => expect(chip()?.dataset.gameCaptainChip).toBe('kept'))
    expect(chip().textContent).toContain('#3')

    await liberoCaptainLeaves()
    await waitFor(async () => expect(await designations()).toHaveLength(1), { timeout: 5000 })
    const [d] = await designations()
    expect(d.payload).toMatchObject({ team: 'home', playerNumber: 3, previousCourtCaptain: null, keep: true, auto: true })
    const match = await db.matches.get(matchId)
    expect(match.homeCourtCaptain).toBe(3)
    expect(match.homeKeepCourtCaptain).toBe(true)
    await sleep(300)
    expect(captainDialog()).toBeNull()
  }, 60000)

  it('Undo takes the automatic designation back, and does not ask again by itself', async () => {
    const matchId = await setUp({ homeKeepCourtCaptain: true, homeRememberedCourtCaptain: 3, homeCourtCaptain: null })
    await mountAndWait(matchId)
    await liberoCaptainLeaves()
    await waitFor(async () => expect(await designations()).toHaveLength(1), { timeout: 5000 })
    await settle()

    fireEvent.click(document.querySelector('[data-help-id="scoreboard-undo"]'))
    const undoDialog = await waitFor(() => {
      const d = [...document.querySelectorAll('[role=dialog]')].find(x => /undo/i.test(x.textContent))
      expect(d).toBeTruthy()
      return d
    })
    expect(undoDialog.textContent).toMatch(/#3/)
    const yes = [...undoDialog.querySelectorAll('button')].find(b => /^(Yes|Undo|Confirm)$/.test(b.textContent.trim()))
    fireEvent.click(yes)
    await waitFor(async () => expect(await designations()).toHaveLength(0), { timeout: 5000 })
    const match = await db.matches.get(matchId)
    expect(match.homeCourtCaptain ?? null).toBeNull()
    // the setting is not part of the undone action
    expect(match.homeKeepCourtCaptain).toBe(true)
    expect(match.homeRememberedCourtCaptain).toBe(3)
    // the libero exit stays; a game captain is needed: the button asks, no dialog pops up
    expect(await ofType('libero_exit')).toHaveLength(1)
    await sleep(900)
    expect(captainDialog()).toBeNull()
    await waitFor(() => expect(chip()?.dataset.gameCaptainChip).toBe('needed'))
  }, 60000)

  it('the kept player off court: the dialog asks, the switch shown on', async () => {
    const matchId = await setUp({ homeKeepCourtCaptain: true, homeRememberedCourtCaptain: 9, homeCourtCaptain: null })
    await mountAndWait(matchId)
    await liberoCaptainLeaves()
    await waitFor(() => expect(captainDialog()).toBeTruthy(), { timeout: 5000 })
    expect(keepSwitch().getAttribute('aria-checked')).toBe('true')
    // nobody proposed: #9 is not on court
    expect([...captainDialog().querySelectorAll('button')].some(b => /Last/.test(b.textContent))).toBe(false)
    expect(await designations()).toHaveLength(0)
  }, 60000)

  it('switch off: asked as before; turned on in the dialog, it is stored with the designation', async () => {
    const matchId = await setUp({ homeRememberedCourtCaptain: 3, homeCourtCaptain: null })
    await mountAndWait(matchId)
    await liberoCaptainLeaves()
    await waitFor(() => expect(captainDialog()).toBeTruthy(), { timeout: 5000 })
    expect(keepSwitch().getAttribute('aria-checked')).toBe('false')
    // the last game captain is proposed (one tap), as before
    const proposed = [...captainDialog().querySelectorAll('button')].find(b => b.textContent.replace(/\s+/g, '') === '3Last')
    expect(proposed).toBeTruthy()

    fireEvent.click(keepSwitch())
    await waitFor(() => expect(keepSwitch().getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(proposed)
    await waitFor(async () => expect(await designations()).toHaveLength(1), { timeout: 5000 })
    const [d] = await designations()
    expect(d.payload).toMatchObject({ team: 'home', playerNumber: '3', keep: true, previousKeepCourtCaptain: false })
    expect(d.payload.auto).toBeUndefined()
    const match = await db.matches.get(matchId)
    expect(match.homeKeepCourtCaptain).toBe(true)
    expect(String(match.homeCourtCaptain)).toBe('3')
  }, 60000)

  it('turned off from the Game captain button: the next exit asks again', async () => {
    const matchId = await setUp({ homeKeepCourtCaptain: true, homeRememberedCourtCaptain: 3, homeCourtCaptain: null })
    await mountAndWait(matchId)
    await waitFor(() => expect(chip()?.dataset.gameCaptainChip).toBe('kept'))
    fireEvent.click(chip())
    await waitFor(() => expect(captainDialog()).toBeTruthy())
    // nobody to choose while the team captain is on court: the switch alone
    expect(captainDialog().textContent).toContain('Captain #12 is on court')
    expect(keepSwitch().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(keepSwitch())
    await waitFor(async () => expect((await db.matches.get(matchId)).homeKeepCourtCaptain).toBe(false))
    fireEvent.click(button('Close', captainDialog()))
    await waitFor(() => expect(captainDialog()).toBeNull())
    await waitFor(() => expect(chip()).toBeNull())
    await settle()

    await liberoCaptainLeaves()
    await waitFor(() => expect(captainDialog()).toBeTruthy(), { timeout: 5000 })
    expect(keepSwitch().getAttribute('aria-checked')).toBe('false')
    expect(await designations()).toHaveLength(0)
  }, 60000)

  it('the libero captain going out and in again: asked once', async () => {
    const matchId = await setUp({ homeCourtCaptain: null })
    await mountAndWait(matchId)

    // 1st exit: asked; #6 chosen with the switch on
    await liberoCaptainLeaves()
    await waitFor(() => expect(captainDialog()).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(keepSwitch())
    await waitFor(() => expect(keepSwitch().getAttribute('aria-checked')).toBe('true'))
    fireEvent.click([...captainDialog().querySelectorAll('button')].find(b => b.textContent.trim() === '6'))
    await waitFor(async () => expect(await designations()).toHaveLength(1), { timeout: 5000 })
    await waitFor(() => expect(captainDialog()).toBeNull())
    await settle()

    // a completed rally (side out to the away team: home does not rotate),
    // then the libero (team captain) comes in for #6 at V: the role ends
    // (#6 is the game captain he replaces)
    await rally('away')
    fireEvent.click(court('home', 6))
    const liberoItem = await waitFor(() => { const b = button('Libero'); expect(b).toBeTruthy(); return b })
    fireEvent.click(liberoItem)
    const l1 = await waitFor(() => {
      const b = [...document.querySelectorAll('button')].find(x => /^12\s*\(?L1\)?$/.test(x.textContent.trim()) && !x.disabled)
      expect(b).toBeTruthy()
      return b
    })
    fireEvent.click(l1)
    // a confirmation, when the app asks for one
    await sleep(300)
    const confirm = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Confirm')
    if (confirm) fireEvent.click(confirm)
    await waitFor(async () => expect((await ofType('libero_entry')).length).toBe(2), { timeout: 5000 })
    await waitFor(async () => expect((await db.matches.get(matchId)).homeCourtCaptain ?? null).toBeNull(), { timeout: 5000 })
    await settle()

    // home wins the serve back: the libero rotates from V to IV and leaves
    // again; #6 is back, designated without the dialog
    await liberoCaptainLeaves()
    await waitFor(async () => expect(await designations()).toHaveLength(2), { timeout: 5000 })
    const [, second] = await designations()
    expect(second.payload).toMatchObject({ team: 'home', auto: true, keep: true })
    expect(String(second.payload.playerNumber)).toBe('6')
    await sleep(300)
    expect(captainDialog()).toBeNull()
  }, 90000)

  it('a reload keeps the switch and the kept player', async () => {
    const matchId = await setUp({ homeRememberedCourtCaptain: 3, homeCourtCaptain: null })
    await mountAndWait(matchId)
    await liberoCaptainLeaves()
    await waitFor(() => expect(captainDialog()).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(keepSwitch())
    await waitFor(() => expect(keepSwitch().getAttribute('aria-checked')).toBe('true'))
    fireEvent.click([...captainDialog().querySelectorAll('button')].find(b => b.textContent.replace(/\s+/g, '') === '3Last'))
    await waitFor(async () => expect(await designations()).toHaveLength(1), { timeout: 5000 })
    await untilQuiet()

    // the screen again, from the database alone
    cleanup()
    await mountAndWait(matchId, 5)
    await waitFor(() => expect(chip()?.dataset.gameCaptainChip).toBe('kept'))
    expect(chip().textContent).toContain('#3')
    fireEvent.click(chip())
    await waitFor(() => expect(captainDialog()).toBeTruthy())
    expect(captainDialog().textContent).toContain('#3 is game captain')
    expect(keepSwitch().getAttribute('aria-checked')).toBe('true')

    // turned off there: the designation says so too, for a device that
    // continues the match from the server's copy (keepFieldsFromEvents)
    fireEvent.click(keepSwitch())
    await waitFor(async () => expect((await db.matches.get(matchId)).homeKeepCourtCaptain).toBe(false))
    await waitFor(async () => expect((await designations())[0].payload.keep).toBe(false))
    expect(keepFieldsFromEvents(await db.events.toArray())).toMatchObject({ homeKeepCourtCaptain: false, homeRememberedCourtCaptain: '3' })
  }, 60000)
})

// Owner 22.11: a game captain's role ends with the set (FIVB 5.1.2). The next
// set designates again: with "Keep as game captain" on and the kept player
// in the starting six, a new designation event of that set without a
// question; with it off, the dialog asks as usual (and proposes the last
// one). Undo in the new set does not bring the old set's game captain back;
// Reopen set does.
describe('Keep as game captain: the set end ends the role', () => {
  const SIX = { I: '2', II: '3', III: '4', IV: '5', V: '6', VI: '7' }
  // home captain #1 is not in the six; #3 is the acting game captain; set 1
  // at 24:20, the next home point ends it
  async function setUpSetPoint({ keep }) {
    const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
    const players = []
    for (const teamId of [home, away]) {
      for (let n = 1; n <= 12; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X', ...(n === 1 ? { isCaptain: true } : {}) })
    }
    await db.players.bulkAdd(players)
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
      homeCourtCaptain: 3, homeRememberedCourtCaptain: 3, homeKeepCourtCaptain: keep
    })
    const t = new Date(Date.now() - 40 * 60 * 1000).toISOString()
    await db.sets.add({ matchId, index: 1, homePoints: 24, awayPoints: 20, finished: false, startTime: t })
    let seq = 1
    const ev = [{ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t }]
    ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: SIX, isInitial: true }, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: LINEUP, isInitial: true }, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'court_captain_designation', payload: { team: 'home', playerNumber: 3, previousCourtCaptain: null, keep, fromLineup: true }, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
    for (const team of [...Array(20).fill('away'), ...Array(24).fill('home')]) {
      ev.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
      ev.push({ matchId, setIndex: 1, type: 'point', payload: { team }, seq: seq++, ts: t })
    }
    await db.events.bulkAdd(ev)
    return matchId
  }

  async function homeWinsSet1(matchId) {
    mount(matchId)
    await waitFor(() => expect(court('home', 3)).toBeTruthy(), { timeout: 10000 })
    await rally('home')
    const setEnd = await waitFor(() => {
      const d = [...document.querySelectorAll('[role=dialog]')].find(x => /Set 1 end/.test(x.textContent))
      expect(d).toBeTruthy()
      return d
    }, { timeout: 10000 })
    await settle()
    fireEvent.click([...setEnd.querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await waitFor(async () => expect((await ofType('set_end'))).toHaveLength(1), { timeout: 10000 })
    await waitFor(async () => expect((await db.sets.toArray()).some(s => s.index === 2)).toBe(true), { timeout: 10000 })
    await untilQuiet()
  }

  // The set 2 line-up of home: set 1's starting six ("Last set's line-up")
  async function homeLineupSet2() {
    const interval = await waitFor(() => { const b = button('End set interval'); expect(b).toBeTruthy(); return b }, { timeout: 10000 }).catch(() => null)
    if (interval) { fireEvent.click(interval); await settle() }
    const open = await waitFor(() => {
      const b = [...document.querySelectorAll('button')].find(x => /^Line-?up\s*A/.test(x.textContent.trim()))
      expect(b).toBeTruthy()
      return b
    }, { timeout: 10000 })
    fireEvent.click(open)
    const copy = await waitFor(() => { const b = document.querySelector('[data-testid="lineup-copy"] [data-copy-set="1"]'); expect(b).toBeTruthy(); return b }, { timeout: 10000 })
    fireEvent.click(copy)
    await waitFor(() => expect(document.querySelector('.lineup-gcapt')).toBeTruthy())
  }
  const lineupDialog = () => [...document.querySelectorAll('[role=dialog]')].find(d => d.querySelector('.lineup-gcapt')) || null

  it('switch on: the set end clears the role; the kept player in the six is designated for set 2; Undo does not bring set 1\'s back', async () => {
    const matchId = await setUpSetPoint({ keep: true })
    await homeWinsSet1(matchId)
    let match = await db.matches.get(matchId)
    expect(match.homeCourtCaptain ?? null).toBeNull()
    expect(match.homeRememberedCourtCaptain).toBe(3)
    expect(match.homeKeepCourtCaptain).toBe(true)
    const [setEnd] = await ofType('set_end')
    expect(setEnd.payload.previousCourtCaptains).toEqual({ home: 3 })

    await homeLineupSet2()
    expect(lineupDialog().querySelector('[aria-label="Game captain: player 3"]').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click([...lineupDialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await waitFor(async () => expect(await designations()).toHaveLength(2), { timeout: 5000 })
    const set2 = (await designations()).find(d => d.setIndex === 2)
    expect(set2.payload).toMatchObject({ team: 'home', playerNumber: 3, fromLineup: true, keep: true, previousCourtCaptain: null })
    await waitFor(async () => expect((await db.matches.get(matchId)).homeCourtCaptain).toBe(3))
    await sleep(600)
    expect(captainDialog()).toBeNull()
    await untilQuiet()

    // Undo in set 2: the designation goes, set 1's game captain stays gone
    fireEvent.click(document.querySelector('[data-help-id="scoreboard-undo"]'))
    const undoDialog = await waitFor(() => {
      const d = [...document.querySelectorAll('[role=dialog]')].find(x => /undo/i.test(x.textContent))
      expect(d).toBeTruthy()
      return d
    })
    fireEvent.click([...undoDialog.querySelectorAll('button')].find(b => /^(Yes|Undo|Confirm)$/.test(b.textContent.trim())))
    await waitFor(async () => expect((await designations()).filter(d => d.setIndex === 2)).toHaveLength(0), { timeout: 5000 })
    match = await db.matches.get(matchId)
    expect(match.homeCourtCaptain ?? null).toBeNull()
    expect(match.homeRememberedCourtCaptain).toBe(3)
  }, 90000)

  it('switch off: set 1\'s game captain no longer counts; the dialog asks after the line-up, the last one proposed', async () => {
    const matchId = await setUpSetPoint({ keep: false })
    await homeWinsSet1(matchId)
    await homeLineupSet2()
    // nothing chosen: None
    expect(lineupDialog().querySelector('.lineup-gcapt__choice--none').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click([...lineupDialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await waitFor(() => expect(captainDialog()).toBeTruthy(), { timeout: 5000 })
    expect(keepSwitch().getAttribute('aria-checked')).toBe('false')
    const proposed = [...captainDialog().querySelectorAll('button')].find(b => b.textContent.replace(/\s+/g, '') === '3Last')
    expect(proposed).toBeTruthy()
    fireEvent.click(proposed)
    await waitFor(async () => expect((await designations()).filter(d => d.setIndex === 2)).toHaveLength(1), { timeout: 5000 })
  }, 90000)

  it('Reopen set 1: set 2 goes, set 1\'s game captain acts again', async () => {
    localStorage.setItem('ov.corrections.view', 'list')
    const matchId = await setUpSetPoint({ keep: true })
    await homeWinsSet1(matchId)
    await homeLineupSet2()
    fireEvent.click([...lineupDialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await waitFor(async () => expect(await designations()).toHaveLength(2), { timeout: 5000 })
    await untilQuiet()

    const matchButton = await waitFor(() => { const b = document.querySelector('.match-toolbar button[title="Match"]'); expect(b).toBeTruthy(); return b }, { timeout: 5000 })
    fireEvent.click(matchButton)
    const corrections = await waitFor(() => { const b = [...document.querySelectorAll('[role=menuitem]')].find(x => x.textContent.trim() === 'Corrections'); expect(b).toBeTruthy(); return b })
    fireEvent.click(corrections)
    const reopen = await waitFor(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Reopen set'); expect(b).toBeTruthy(); return b }, { timeout: 5000 })
    await settle()
    fireEvent.click(reopen)
    const yes = await waitFor(() => { const b = button('Yes, reopen'); expect(b).toBeTruthy(); return b }, { timeout: 3000 })
    await settle()
    fireEvent.click(yes)
    await waitFor(async () => expect((await db.sets.toArray()).map(x => x.index)).toEqual([1]), { timeout: 5000 })
    expect(await ofType('set_end')).toHaveLength(0)
    expect((await designations()).map(d => d.setIndex)).toEqual([1])
    await waitFor(async () => expect((await db.matches.get(matchId)).homeCourtCaptain).toBe(3))
    localStorage.removeItem('ov.corrections.view')
  }, 90000)
})
