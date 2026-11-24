// The match-winning point (set 4, 25:17, 3:1 in sets) of a test match
// driven by Playwright on the dev server (2026-10-21, twice): the scorer got
// "That was not saved. Check the scoresheet and try again.", the console
// "[action] failed, nothing was saved" with a PrematureCommitError, and Match
// End followed with 3:1: the point had been stored. Dexie raises
// PrematureCommitError only once the transaction's body has ended without an
// error, after its IndexedDB transaction had committed: every write the body
// awaited is stored (in the action's transaction, or, once the body runs on
// outside its transaction zone, in transactions of their own). useScorerActions
// took it for a failure: the false alert, and the action's dialog (Match end:
// the screen's own set-end check opened it from the stored score) and its
// pushes to the tablets and the livescore dropped.
//
// What made that action end outside its transaction there was not found (the
// point's path awaits Dexie only; nine replays of that match did not fail
// again). Here the end of the point's action (its reads of the match row: the
// set end check, the final snapshot) runs outside its transaction, which
// commits before the action ends, as it did there. The real scoring screen
// over the app's Dexie database (fake IndexedDB), driven with taps.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import Dexie from 'dexie'
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

// A PrematureCommitError left unhandled is recorded (the old failure was
// rethrown to the tap); every other unhandled rejection still fails the run
const rejections = []
let rejectionListeners = []
const onRejection = (reason, promise) => {
  if (reason?.name === 'PrematureCommitError') { rejections.push(reason); return }
  for (const listener of rejectionListeners) listener(reason, promise)
}

let saved
beforeAll(() => {
  rejectionListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', onRejection)
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
beforeEach(async () => {
  cleanup()
  rejections.length = 0
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  process.removeListener('unhandledRejection', onRejection)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const button = (text) => [...document.querySelectorAll('button')].find(b => (text instanceof RegExp ? text.test(b.textContent.trim()) : b.textContent.trim() === text) && !b.disabled)
const LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }

// A test match, team A home on the right in set 4 (A won sets 1 and 3, B set 2),
// set 4 at `points` [home, away], its rally idle
async function setUpMatch({ won, points }) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: true, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
  })
  const t = new Date(Date.now() - 90 * 60 * 1000).toISOString()
  for (const [i, w] of won.entries()) {
    await db.sets.add({ matchId, index: i + 1, homePoints: w === 'home' ? 25 : 20, awayPoints: w === 'home' ? 20 : 25, finished: true, startTime: t, endTime: t })
  }
  const index = won.length + 1
  const setId = await db.sets.add({ matchId, index, homePoints: 0, awayPoints: 0, finished: false, startTime: t })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: index, type: 'lineup', payload: { team, lineup: LINEUP, isInitial: true }, seq: seq++, ts: t })
  }
  await db.events.add({ matchId, setIndex: index, type: 'set_start', payload: {}, seq: seq++, ts: t })
  let h = 0, a = 0, k = 0
  const order = [...Array(points[1]).fill('away'), ...Array(points[0]).fill('home')]
  for (const team of order) {
    if (team === 'home') h++; else a++
    const ts = new Date(Date.parse(t) + (++k) * 5000).toISOString()
    await db.events.add({ matchId, setIndex: index, type: 'rally_start', payload: {}, seq: seq++, ts })
    await db.events.add({ matchId, setIndex: index, type: 'point', payload: { team, score: { home: h, away: a } }, seq: seq++, ts })
  }
  await db.sets.update(setId, { homePoints: h, awayPoints: a })
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

// Once the point's event has its state snapshot (`armed`), db.matches.get
// (the set end check's read of the match, then the final snapshot's) runs
// outside the action's transaction
const escape = { on: false, armed: false, calls: 0 }
const armOnSnapshot = function (mods) {
  if (escape.on && mods && 'stateSnapshot' in mods) escape.armed = true
}

describe('The match-winning point', () => {
  it('ended past its transaction\'s commit: no "not saved", its Match end dialog opens, everything is stored', async () => {
    const errors = vi.spyOn(console, 'error')
    const matchId = await setUpMatch({ won: ['home', 'away', 'home'], points: [24, 17] })
    const get = db.matches.get.bind(db.matches)
    vi.spyOn(db.matches, 'get').mockImplementation((...args) => {
      // the action's transaction only (not a live query's)
      if (!escape.armed || Dexie.currentTransaction?.mode !== 'readwrite') return get(...args)
      escape.calls++
      // In Chrome a read outside the action waits for its (read-write, every
      // table) transaction to end, which then commits: here it waits a turn
      return Dexie.ignoreTransaction(() => new Promise(resolve => setTimeout(resolve, 0)).then(() => get(...args)))
    })
    db.events.hook('updating', armOnSnapshot)
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    await settle()
    fireEvent.click(button('Start rally'))
    await waitFor(() => expect(button(/^Point A/)).toBeTruthy())
    await settle()
    escape.on = true
    fireEvent.click(button(/^Point A/))

    // the action's own dialog, with the data
    await waitFor(() => expect(document.body.textContent).toMatch(/won the match/), { timeout: 15000 })
    escape.on = escape.armed = false
    db.events.hook('updating').unsubscribe(armOnSnapshot)
    expect(escape.calls).toBeGreaterThan(0)
    await settle()
    expect(document.body.textContent).not.toMatch(/not saved/)
    expect(errors.mock.calls.filter(c => /\[action\] failed/.test(String(c[0])))).toEqual([])
    expect(rejections.filter(r => r?.name === 'PrematureCommitError')).toEqual([])

    // stored: the score, the point (with its state snapshot)
    const set4 = (await db.sets.toArray()).find(s => s.index === 4)
    expect([set4.homePoints, set4.awayPoints]).toEqual([25, 17])
    const points = (await db.events.toArray()).filter(e => e.type === 'point' && e.setIndex === 4)
    expect(points).toHaveLength(42)
    expect(points.sort((a, b) => a.seq - b.seq).at(-1).stateSnapshot).toBeTruthy()

    // the match end is confirmed as always
    fireEvent.click(button('Confirm'))
    await waitFor(async () => expect((await db.matches.get(matchId)).status).toBe('ended'), { timeout: 15000 })
    expect((await db.events.toArray()).filter(e => e.type === 'set_end' && e.setIndex === 4)).toHaveLength(1)
    errors.mockRestore()
  }, 60000)
})
