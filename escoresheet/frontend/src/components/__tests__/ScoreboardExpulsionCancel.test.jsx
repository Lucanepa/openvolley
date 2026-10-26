// Cancel on "No legal substitution available" after an expulsion.
//
// The expulsion is written before the app looks for a substitute. With the
// team's 6 substitutions used, it asks Exceptional substitution / Forfait /
// "Cancel (correct the sanction or injury first)". That Cancel only closed
// the dialog: the expulsion stayed in the scoresheet (and on the server), the
// expelled player stayed on court and rallies went on, Expulsion greyed out
// for that player (stress test 2026-10-25). It now takes the sanction back,
// as the substitution list's "Cancel sanction" does.
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
const sanctions = async () => (await db.events.toArray()).filter(e => e.type === 'sanction')

// Set 1 at 5:5, no rally in play. Home (team A) has used its 6 substitutions:
// #7, #8, #9 came in for #1, #2, #3 and went back out, so the court is #1-#6
// again and #10-#12 can only come in exceptionally.
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
  const positions = { 1: 'I', 2: 'II', 3: 'III' }
  const current = { ...lineup }
  const substitute = (out, inn) => {
    const position = positions[out] || positions[inn]
    const at = seq++
    current[position] = String(inn)
    events.push({ matchId, setIndex: 1, type: 'substitution', payload: { team: 'home', position, playerOut: out, playerIn: inn, isExceptional: false, isExpelled: false, isDisqualified: false }, seq: at, ts: t })
    events.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { ...current }, fromSubstitution: true }, seq: at + 0.1, ts: t })
  }
  positions[7] = 'I'; positions[8] = 'II'; positions[9] = 'III'
  substitute(1, 7); substitute(2, 8); substitute(3, 9)
  substitute(7, 1); substitute(8, 2); substitute(9, 3)
  await db.events.bulkAdd(events)
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

describe('Scoreboard: Cancel on "No legal substitution available"', () => {
  it('takes back the expulsion it was opened for', async () => {
    setViewport(1280, 800)
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

    // written, and no legal substitution: the choice
    const noLegal = () => dialog(/No legal substitution/)
    await waitFor(() => expect(noLegal()).toBeTruthy(), { timeout: 5000 })
    expect((await sanctions()).map(e => `${e.payload.team}:#${e.payload.playerNumber}:${e.payload.type}`)).toEqual(['home:#4:expulsion'])

    await wait(GHOST_CLICK_MS)
    fireEvent.click(button('Cancel (correct the sanction or injury first)', noLegal()))
    await waitFor(() => expect(noLegal()).toBeFalsy(), { timeout: 3000 })
    await waitFor(async () => expect(await sanctions()).toHaveLength(0), { timeout: 3000 })

    // the scorer can give the right sanction now: Expulsion is offered again
    await wait(300)
    fireEvent.click(expelled())
    await waitFor(() => expect(button('Sanction')).toBeTruthy(), { timeout: 3000 })
    fireEvent.click(button('Sanction'))
    await waitFor(() => expect(button('Expulsion')).toBeTruthy(), { timeout: 3000 })
  }, 60000)
})
