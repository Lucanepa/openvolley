// Two live rules of the scoring screen, through its real paths (not the
// source text, as scoreboardSweepFixes / scoreboardReopenSetSignatures pin
// them):
//  - the libero leaves by itself when the rotation takes it to the front
//    row (FIVB 19.3.1.2): Point for the receiving team, the libero at V goes
//    to IV, the player it replaced comes back there (a libero_exit, no
//    substitution); in the back row it stays;
//  - Reopen set (Corrections): the set is played on, the later sets and
//    their events go, its set end goes (a finished match is reopened from
//    the match end: MatchEndReopen.test.jsx).
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), at tablet width. Network is off: no relay socket, no fetch.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react'
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
afterAll(() => {
  cleanup()
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
const homeLineups = async () => (await ofType('lineup')).filter(e => e.payload?.team === 'home')
const court = (team, n) => document.querySelector(`.court-player[data-team="${team}"][data-player-number="${n}"]`)
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

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

describe('the libero and the rotation (FIVB 19.3.1.2)', () => {
  // Set 1, away served first and won the first rally (home receives). L #12
  // came in for the home player at `position` (back row).
  async function setUp(position) {
    const { home, away } = await addTeams()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
      firstServe: 'away', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true
    })
    const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 1, finished: false, startTime: t })
    let seq = 1
    const replaced = Number(LINEUP[position])
    const ev = [{ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t }]
    for (const team of ['home', 'away']) ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup: LINEUP, isInitial: true }, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'point', payload: { team: 'away' }, seq: seq++, ts: t })
    const at = seq++
    ev.push({ matchId, setIndex: 1, type: 'libero_entry', payload: { team: 'home', position, playerOut: replaced, liberoIn: 12, liberoType: 'libero1' }, seq: at, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { ...LINEUP, [position]: '12' }, liberoSubstitution: { position, liberoNumber: 12, playerNumber: replaced, liberoType: 'libero1' } }, seq: at + 0.1, ts: t })
    await db.events.bulkAdd(ev)
    return matchId
  }

  async function homeWinsTheRally(matchId) {
    mount(matchId)
    await waitFor(() => expect(court('home', 12)).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    fireEvent.click(button('Start rally'))
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(button('Point A'))
    await waitFor(async () => expect((await ofType('point')).length).toBe(2), { timeout: 5000 })
    // the rotation's line-up row is written with the point
    await waitFor(async () => expect((await homeLineups()).length).toBe(3), { timeout: 5000 })
  }

  it('a side-out takes the libero from V to IV: it leaves, the player it replaced is back at IV', async () => {
    const matchId = await setUp('V')
    await homeWinsTheRally(matchId)
    const exits = await ofType('libero_exit')
    expect(exits).toHaveLength(1)
    expect(exits[0].payload).toMatchObject({ team: 'home', position: 'IV', playerIn: 5, reason: 'rotation_to_front_row' })
    expect(String(exits[0].payload.liberoOut)).toBe('12')
    const last = (await homeLineups()).at(-1).payload
    expect(last.lineup).toEqual({ I: '2', II: '3', III: '4', IV: '5', V: '6', VI: '1' })
    expect(last.liberoSubstitution).toBeNull()
    expect(await ofType('substitution')).toHaveLength(0)
  }, 60000)

  it('in the back row it stays: from VI to V, still in for the player it replaced', async () => {
    const matchId = await setUp('VI')
    await homeWinsTheRally(matchId)
    expect(await ofType('libero_exit')).toHaveLength(0)
    const last = (await homeLineups()).at(-1).payload
    expect(last.lineup).toEqual({ I: '2', II: '3', III: '4', IV: '5', V: '12', VI: '1' })
    expect(last.liberoSubstitution).toMatchObject({ position: 'V', liberoNumber: 12, playerNumber: 6 })
  }, 60000)
})

describe('Reopen set (Corrections)', () => {
  // `finished` sets won by home 25:20 (each with its set end), then the next
  // set at 2:1
  async function setUp({ finished = 1 } = {}) {
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
      // the away points first, then home's: home serves at the end (no rotation is checked here)
      for (const team of [...Array(awayPoints).fill('away'), ...Array(homePoints).fill('home')]) {
        ev.push({ matchId, setIndex, type: 'rally_start', payload: {}, seq: seq++, ts: t })
        ev.push({ matchId, setIndex, type: 'point', payload: { team }, seq: seq++, ts: t })
      }
    }
    for (let i = 1; i <= finished; i++) {
      await db.sets.add({ matchId, index: i, homePoints: 25, awayPoints: 20, finished: true, startTime: t, endTime: t })
      play(i, 25, 20)
      ev.push({ matchId, setIndex: i, type: 'set_end', payload: { winner: 'home', homePoints: 25, awayPoints: 20 }, seq: seq++, ts: t })
    }
    await db.sets.add({ matchId, index: finished + 1, homePoints: 2, awayPoints: 1, finished: false, startTime: t })
    play(finished + 1, 2, 1)
    await db.events.bulkAdd(ev)
    return matchId
  }

  async function reopenSet1(matchId) {
    mount(matchId)
    await waitFor(() => expect(document.querySelector('.match-toolbar')).toBeTruthy(), { timeout: 10000 })
    await settle()
    // the toolbar's "Match" menu
    const matchButton = await waitFor(() => {
      const b = document.querySelector('.match-toolbar button[title="Match"]')
      expect(b).toBeTruthy()
      return b
    }, { timeout: 5000 })
    fireEvent.click(matchButton)
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: 'Corrections' })))
    // the first "Reopen set" of the Corrections panel: set 1's (the dialog
    // below says so)
    const reopenButton = await waitFor(() => {
      const first = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Reopen set')
      expect(first).toBeTruthy()
      return first
    }, { timeout: 5000 })
    await settle()
    fireEvent.click(reopenButton)
    await waitFor(() => expect(screen.getByText('Reopen Set 1? This will delete all subsequent sets and their events.')).toBeTruthy(), { timeout: 3000 })
    await settle()
    fireEvent.click(button('Yes, reopen'))
  }

  it('the set is played on: the later set and its events go, its set end goes, its points stay', async () => {
    const matchId = await setUp({ finished: 1 })
    await reopenSet1(matchId)
    await waitFor(async () => expect((await db.sets.toArray()).map(s => s.index)).toEqual([1]), { timeout: 5000 })
    const set1 = (await db.sets.toArray())[0]
    expect(set1).toMatchObject({ finished: false, endTime: null, homePoints: 25, awayPoints: 20 })
    const events = await db.events.toArray()
    expect(events.filter(e => e.setIndex === 2)).toHaveLength(0)
    expect(events.filter(e => e.type === 'set_end')).toHaveLength(0)
    expect(events.filter(e => e.type === 'point' && e.setIndex === 1)).toHaveLength(45)
  }, 60000)

  it('an earlier set: every later set goes, the finished one too', async () => {
    const matchId = await setUp({ finished: 2 })
    await reopenSet1(matchId)
    await waitFor(async () => expect((await db.sets.toArray()).map(s => s.index)).toEqual([1]), { timeout: 5000 })
    expect((await db.sets.toArray())[0]).toMatchObject({ finished: false, endTime: null })
    const events = await db.events.toArray()
    expect(events.filter(e => e.setIndex > 1)).toHaveLength(0)
    expect(events.filter(e => e.type === 'set_end')).toHaveLength(0)
    expect((await db.matches.get(matchId)).status).toBe('live')
  }, 60000)
})
