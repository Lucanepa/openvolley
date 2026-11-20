// The correction board (owner 2026-11-20) on the real scoring screen over the
// app's real Dexie database (fake IndexedDB), at tablet width, network off:
// Match menu -> Corrections opens the board; a staged point is written on
// Save with its correction-log entry; the list and the board switch; Reopen
// set of an earlier set is offered on its tab. The harness is the one of
// ScoreboardLiberoExitReopenSet.test.jsx.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { UiHost } from '../../ui/index.js'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'

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

// The scoring screen's work after a test's last check: a point or a Reopen
// set also pushes the live state (snapshot reads, cloud lookup) and logs the
// change, none of it awaited by the click. It ran on past the test: into the
// next test's emptied database, and after the last test into the worker's
// shutdown (CI 2026-11-20: "Closing rpc while onUserConsoleLog was
// pending"). That work is IndexedDB reads and writes with logs between them,
// so after the unmount each test waits until no IndexedDB transaction is
// open and nothing has been logged for a while: its work is through.
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug']
let consoleSpies = []
const consoleCalls = () => consoleSpies.reduce((n, spy) => n + spy.mock.calls.length, 0)
// IndexedDB transactions opened and not yet complete or aborted (Dexie's,
// on fake-indexeddb's IDBDatabase)
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
  // passed through (the logs still show), only counted
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
  // the board is the default view on a tablet in landscape
  localStorage.removeItem('ov.corrections.view')
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
const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type).sort((a, b) => a.seq - b.seq)
const homeOrAwayLineups = async (team) => (await ofType('lineup')).filter(e => e.payload?.team === team)
const court = (team, n) => document.querySelector(`.court-player[data-team="${team}"][data-player-number="${n}"]`)
// the kit dialogs (confirmDialog: the board's Save) render in UiHost, as in every *-main.jsx
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /><UiHost /></LoggingProvider></AlertProvider></ScaleProvider>)

const LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }

async function addTeams() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) {
    for (let n = 1; n <= 12; n++) {
      players.push({ teamId, number: n, name: `P${n}`, firstName: 'X', ...(n === 12 ? { libero: 'libero1' } : {}), ...(n === 1 ? { isCaptain: true } : {}) })
    }
  }
  await db.players.bulkAdd(players)
  return { home, away }
}


describe('Correction board (Corrections)', () => {
  // set 1 won by home 25:20, set 2 at 2:1 (home served last)
  async function setUp() {
    const { home, away } = await addTeams()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true
    })
    const t = new Date(Date.now() - 90 * 60 * 1000).toISOString()
    let seq = 1
    const ev = [{ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t }]
    const play = (setIndex, homePoints, awayPoints) => {
      for (const team of ['home', 'away']) ev.push({ matchId, setIndex, type: 'lineup', payload: { team, lineup: LINEUP, isInitial: true }, seq: seq++, ts: t })
      ev.push({ matchId, setIndex, type: 'set_start', payload: {}, seq: seq++, ts: t })
      for (const team of [...Array(awayPoints).fill('away'), ...Array(homePoints).fill('home')]) {
        ev.push({ matchId, setIndex, type: 'rally_start', payload: {}, seq: seq++, ts: t })
        ev.push({ matchId, setIndex, type: 'point', payload: { team }, seq: seq++, ts: t })
      }
    }
    await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: t, endTime: t })
    play(1, 25, 20)
    ev.push({ matchId, setIndex: 1, type: 'set_end', payload: { winner: 'home', homePoints: 25, awayPoints: 20 }, seq: seq++, ts: t })
    await db.sets.add({ matchId, index: 2, homePoints: 2, awayPoints: 1, finished: false, startTime: t })
    play(2, 2, 1)
    await db.events.bulkAdd(ev)
    return matchId
  }

  async function openCorrections(matchId) {
    mount(matchId)
    await waitFor(() => expect(document.querySelector('.match-toolbar')).toBeTruthy(), { timeout: 10000 })
    await settle()
    const matchButton = await waitFor(() => {
      const b = document.querySelector('.match-toolbar button[title="Match"]')
      expect(b).toBeTruthy()
      return b
    }, { timeout: 5000 })
    fireEvent.click(matchButton)
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: 'Corrections' })))
  }

  it('opens the board, stages a point and writes it on Save with its log entry', async () => {
    const matchId = await setUp()
    await openCorrections(matchId)
    await waitFor(() => expect(screen.getByTestId('correction-board')).toBeTruthy(), { timeout: 5000 })
    const awaySide = screen.getByTestId('board-team-left').textContent.includes('Away VC') ? 'left' : 'right'
    await settle()
    fireEvent.click(screen.getByTestId(`board-plus-${awaySide}`))
    expect(screen.getByTestId(`board-score-${awaySide}`).textContent).toBe('2')
    // nothing written before Save
    expect((await ofType('point')).filter(e => e.setIndex === 2)).toHaveLength(3)
    await settle()
    fireEvent.click(screen.getByTestId('board-save'))
    await waitFor(() => expect(screen.getByText('Save 1 change?')).toBeTruthy(), { timeout: 3000 })
    await settle()
    fireEvent.click(button('Save'))
    await waitFor(async () => expect((await ofType('point')).filter(e => e.setIndex === 2)).toHaveLength(4), { timeout: 5000 })
    const set2 = (await db.sets.toArray()).find(s => s.index === 2)
    expect(set2).toMatchObject({ homePoints: 2, awayPoints: 2 })
    // away won the serve: its side-out rotation is written with the point
    const awayRotation = (await homeOrAwayLineups('away')).pop()
    expect(awayRotation.payload.lineup.I).toBe('2')
    const match = await db.matches.get(matchId)
    expect(match.manualChanges).toHaveLength(1)
    expect(match.manualChanges[0].action).toBe('addPoint')
    await waitFor(() => expect(screen.queryByTestId('correction-board')).toBeNull(), { timeout: 3000 })
  })

  it('List switches to the cards and is remembered; Board switches back', async () => {
    const matchId = await setUp()
    await openCorrections(matchId)
    await waitFor(() => expect(screen.getByTestId('correction-board')).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(screen.getByTestId('board-show-list'))
    await waitFor(() => expect(screen.getByTestId('corrections-show-board')).toBeTruthy(), { timeout: 3000 })
    expect(screen.queryByTestId('correction-board')).toBeNull()
    expect(localStorage.getItem('ov.corrections.view')).toBe('list')
    await settle()
    fireEvent.click(screen.getByTestId('corrections-show-board'))
    await waitFor(() => expect(screen.getByTestId('correction-board')).toBeTruthy(), { timeout: 3000 })
  })

  it('Reopen set of an earlier set is on its tab', async () => {
    const matchId = await setUp()
    await openCorrections(matchId)
    await waitFor(() => expect(screen.getByTestId('correction-board')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByTestId('board-reopen-set')).toBeNull()
    await settle()
    fireEvent.click(screen.getByRole('radio', { name: 'Set 1' }))
    await settle()
    fireEvent.click(await waitFor(() => screen.getByTestId('board-reopen-set')))
    await waitFor(() => expect(screen.getByText('Reopen set 1? This will delete all subsequent sets and their events.')).toBeTruthy(), { timeout: 3000 })
  })
})
