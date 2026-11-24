// The four rows of players on the court (left / right team, front / back)
// carry the same markup: which player it is (data-court-position, data-team,
// data-player-number), the flash of a player just substituted in
// (recently-substituted) and the touch drag of a substitution (touchAction,
// the touch handlers). The right team's front row had none of it: a script
// (or a test) could not find its players, a player just substituted in there
// had no recently-substituted class, and on a tablet a substitution could not
// be dragged from it.
//
// The real scoring screen over the app's Dexie database (fake IndexedDB).
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

// As in ScoreboardSet5CourtSwitch.test.jsx: only the environment's
// PrematureCommitError is let through
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
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
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
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }

// Set 1 under way at 1:1, home (A) on the left, both line-ups entered,
// players 1-8 on each team
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
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup: LINEUP, isInitial: true }, seq: seq++, ts: t })
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
const courtRow = (side, row) => document.querySelector(`.court-side-${side} .court-row-${row}`)

describe('The four court rows carry the same markup', () => {
  it('every player on the court says who it is, and can be dragged by touch while the rally is idle', async () => {
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    await waitFor(() => expect(document.querySelectorAll('.court-player[data-team]')).toHaveLength(12))

    for (const [side, team] of [['left', 'home'], ['right', 'away']]) {
      for (const row of ['front', 'back']) {
        const players = [...courtRow(side, row).querySelectorAll('.court-player')]
        expect(players, `${side} ${row}`).toHaveLength(3)
        for (const el of players) {
          expect(el.dataset.team, `${side} ${row}`).toBe(team)
          expect(LINEUP[el.dataset.courtPosition], `${side} ${row} ${el.dataset.courtPosition}`).toBe(el.dataset.playerNumber)
          // the touch drag of a substitution
          expect(el.style.touchAction, `${side} ${row} ${el.dataset.courtPosition}`).toBe('none')
        }
      }
    }
    // the right team's front row: positions IV, III, II
    expect([...courtRow('right', 'front').querySelectorAll('.court-player')].map(el => el.dataset.courtPosition).sort()).toEqual(['II', 'III', 'IV'])
  })

  it('a player substituted in on the right team\'s front row flashes as recently substituted', async () => {
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    const playerII = () => document.querySelector('.court-player[data-team="away"][data-court-position="II"]')
    await waitFor(() => expect(playerII()).toBeTruthy())
    expect(courtRow('right', 'front').contains(playerII())).toBe(true)
    await settle()

    fireEvent.click(playerII())
    await waitFor(() => expect(button('Substitution')).toBeTruthy())
    fireEvent.click(button('Substitution'))
    await waitFor(() => expect(button('7')).toBeTruthy())
    fireEvent.click(button('7'))
    await waitFor(() => expect(button('Yes')).toBeTruthy())
    await settle()
    fireEvent.click(button('Yes'))

    await waitFor(async () => expect((await db.events.toArray()).some(e => e.type === 'substitution')).toBe(true))
    await waitFor(() => expect(document.querySelector('.court-player[data-team="away"][data-player-number="7"]')).toBeTruthy())
    const playerIn = document.querySelector('.court-player[data-team="away"][data-player-number="7"]')
    expect(playerIn.dataset.courtPosition).toBe('II')
    expect(courtRow('right', 'front').contains(playerIn)).toBe(true)
    expect(playerIn.classList.contains('recently-substituted')).toBe(true)
  })
})
