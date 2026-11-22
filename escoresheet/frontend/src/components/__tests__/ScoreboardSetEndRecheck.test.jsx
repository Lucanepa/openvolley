// The set-end check ("score says the set is over, its dialog not shown")
// skips while a set end or forfait flow holds the set-creation lock. The 10 s
// heartbeat's re-read ran it again after the flow: the only retry when the
// flow failed with the set won and still open. The heartbeat is rare now
// (perf pass, 22.11.2026), so the check runs again when the flow ends.
//
// The case: home's #4 expelled with the team's 6 substitutions used, Forfait
// (set). The 20 points for away and the 5:25 are written, then the forfait
// event cannot be (storage full). The forfait is said to have failed, and
// the "Set 1 end" dialog comes, as it did within 10 s before.
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

// As in ScoreboardExpulsionCancel.test.jsx: under jsdom + fake-indexeddb a
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

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const buttonStarting = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text) && !b.disabled)
const dialog = (re) => [...document.querySelectorAll('[role="dialog"]')].find(d => re.test(d.textContent))
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type)

// Set 1 at 5:5, no rally in play. Home (team A) has used its 6 substitutions
// (as in ScoreboardExpulsionCancel.test.jsx)
async function setUpSixSubstitutionsUsed() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 12; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 5, awayPoints: 5, finished: false, startTime: t })
  let seq = 1
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  const events = [
    { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, isInitial: true }, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup, isInitial: true }, seq: seq++, ts: t },
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t }
  ]
  for (let k = 0; k < 10; k++) {
    events.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
    events.push({ matchId, setIndex: 1, type: 'point', payload: { team: k < 5 ? 'away' : 'home' }, seq: seq++, ts: t })
  }
  const positions = { 1: 'I', 2: 'II', 3: 'III', 7: 'I', 8: 'II', 9: 'III' }
  const current = { ...lineup }
  const substitute = (out, inn) => {
    const position = positions[out] || positions[inn]
    const at = seq++
    current[position] = String(inn)
    events.push({ matchId, setIndex: 1, type: 'substitution', payload: { team: 'home', position, playerOut: out, playerIn: inn, isExceptional: false, isExpelled: false, isDisqualified: false }, seq: at, ts: t })
    events.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { ...current }, fromSubstitution: true }, seq: at + 0.1, ts: t })
  }
  substitute(1, 7); substitute(2, 8); substitute(3, 9)
  substitute(7, 1); substitute(8, 2); substitute(9, 3)
  await db.events.bulkAdd(events)
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

describe('Scoreboard: the set-end check after a failed set forfait', () => {
  it('shows the set end once the forfait has failed with the set won and open', async () => {
    const matchId = await setUpSixSubstitutionsUsed()
    mount(matchId)
    const expelled = () => document.querySelector('.court-player[data-team="home"][data-player-number="4"]')
    await waitFor(() => expect(expelled()).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })

    // #4: Sanction -> Expulsion -> Confirm
    fireEvent.click(expelled())
    await waitFor(() => expect(button('Sanction')).toBeTruthy(), { timeout: 3000 })
    fireEvent.click(button('Sanction'))
    await waitFor(() => expect(button('Expulsion')).toBeTruthy(), { timeout: 3000 })
    fireEvent.click(button('Expulsion'))
    await waitFor(() => expect(dialog(/Confirm/) && button('Confirm', dialog(/Confirm/))).toBeTruthy(), { timeout: 3000 })
    await wait(GHOST_CLICK_MS)
    fireEvent.click(button('Confirm', dialog(/Confirm/)))
    const noLegal = () => dialog(/No legal substitution/)
    await waitFor(() => expect(noLegal()).toBeTruthy(), { timeout: 5000 })

    // the forfait event finds the storage full, a while after the awarded
    // points and the 5:25 were written (their re-read comes meanwhile, while
    // the forfait holds the lock)
    const realAdd = db.events.add.bind(db.events)
    const add = vi.spyOn(db.events, 'add').mockImplementation((row, ...rest) => {
      if (row?.type === 'forfait') {
        return new Promise((resolve, reject) => setTimeout(() => reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError')), 400))
      }
      return realAdd(row, ...rest)
    })
    try {
      await wait(GHOST_CLICK_MS)
      fireEvent.click(buttonStarting('Forfait (set)', noLegal()))

      await waitFor(() => expect(document.body.textContent).toContain('Forfait could not be completed'), { timeout: 10000 })
      const set1 = (await db.sets.toArray()).find(s => s.index === 1)
      expect([set1.homePoints, set1.awayPoints, !!set1.finished]).toEqual([5, 25, false])
      expect(await ofType('forfait')).toHaveLength(0)
      // nothing is written after the failure: only the check run at the
      // flow's end brings the dialog
      await waitFor(() => expect(dialog(/Set 1 end/)).toBeTruthy(), { timeout: 3000 })
      expect(await ofType('set_end')).toHaveLength(0)
    } finally {
      add.mockRestore()
    }
  }, 60000)
})
