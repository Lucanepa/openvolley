// The live state the referee, the bench and the livescore read when a set
// ends: its side_a is the side team A plays on in the set the live state
// shows, by the scorer's own rule (domain/rules getSideAForSet, the one the
// scorer's court draws). It was worked out by the NEXT set's number: at the
// end of the match (no next set) the teams showed swapped, and the interval
// before set 5 showed team A on the left (odd set) while the scorer's court
// keeps the sides set 4 ended on (A on the right) until the set 5 coin toss.
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), its cloud live-state write recorded. No relay socket.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'

const upserts = vi.hoisted(() => [])
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal()
  const result = { data: null, error: null }
  const chain = (table) => {
    const q = new Proxy({}, {
      get(_, key) {
        if (key === 'then') return (res, rej) => Promise.resolve(result).then(res, rej)
        if (key === 'upsert') return (row) => { upserts.push({ table, row }); return q }
        return () => q
      }
    })
    return q
  }
  return { ...actual, apiFrom: (table) => chain(table) }
})

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

// See ScoreboardSet5CourtSwitch.test.jsx: under jsdom + fake-indexeddb an
// action can lose Dexie's transaction zone part-way (PrematureCommitError);
// only that error is let through.
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
  upserts.length = 0
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
// Team A (home) on the left: the left team column comes first
const teamAOnLeft = () => {
  const text = document.body.textContent
  return text.indexOf('A-HOM') < text.indexOf('B-AWA')
}

// A best-of-5 match, team A home. `won` the finished sets' winners, the
// current set (the next index) at `points` [home, away].
async function setUpMatch(won, points, { match: extra = {}, lineups = {} } = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    seed_key: 'match_live_sides_test', externalId: '11111111-2222-4333-8444-555555555555',
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
    ...extra
  })
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  for (const [i, winner] of won.entries()) {
    const homeWins = winner === 'home'
    await db.sets.add({ matchId, index: i + 1, homePoints: homeWins ? 25 : 20, awayPoints: homeWins ? 20 : 25, finished: true, startTime: t, endTime: t })
  }
  const index = won.length + 1
  await db.sets.add({ matchId, index, homePoints: points[0], awayPoints: points[1], finished: false, startTime: t })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  if (index === 5) await db.events.add({ matchId, setIndex: 5, type: 'set5_coin_toss', payload: {}, seq: seq++, ts: t })
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: index, type: 'lineup', payload: { team, lineup: lineups[team] || lineup, isInitial: true }, seq: seq++, ts: t })
  }
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

const setEndState = () => upserts
  .filter(u => u.table === 'match_live_state' && u.row.last_event_type === 'set_end')
  .at(-1)?.row

// `label` scores the set's last point and the set end is confirmed: the
// live state the set end pushes
async function endSet(label) {
  // the set's start (its first rally starts with it)
  await waitFor(() => expect(button('Start set')).toBeTruthy(), { timeout: 10000 })
  await settle()
  fireEvent.click(button('Start set'))
  await waitFor(() => expect(button('Confirm')).toBeTruthy(), { timeout: 5000 })
  fireEvent.click(button('Confirm'))
  // the first rally is under way: the point buttons
  await waitFor(() => expect(button(label)).toBeTruthy(), { timeout: 10000 })
  await settle()
  fireEvent.click(button(label))
  await waitFor(() => expect(document.body.textContent).toMatch(/Set \d end|Match end/), { timeout: 8000 })
  await settle()
  await waitFor(() => expect(button('Confirm')).toBeTruthy(), { timeout: 5000 })
  fireEvent.click(button('Confirm'))
  await waitFor(() => expect(setEndState()).toBeTruthy(), { timeout: 15000 })
  return setEndState()
}

describe('Scoreboard: the set end\'s live state has the scorer\'s sides', () => {
  it('the match ends 3:0 in set 3 (team A on the left): side_a stays left, not set 4\'s right', async () => {
    const matchId = await setUpMatch(['home', 'home'], [24, 20])
    mount(matchId)
    const state = await endSet('Point A')
    expect(state.current_set).toBe(3)
    expect(state.side_a).toBe('left')
  }, 90000)

  it('set 4 ends 2:2: the interval shows set 5 with team A on the right, where set 4 ended, as the scorer\'s court', async () => {
    const matchId = await setUpMatch(['home', 'away', 'home'], [20, 24])
    mount(matchId)
    const state = await endSet('Point B')
    expect(state.current_set).toBe(5)
    expect(state.side_a).toBe('right')
    // the scorer's court for set 5 before its coin toss: team A on the right
    await waitFor(async () => expect((await db.matches.get(matchId)).set5LeftTeam).toBe('B'), { timeout: 8000 })
    await waitFor(() => expect(teamAOnLeft()).toBe(false), { timeout: 8000 })
  }, 90000)
})

// The synced event rows (sync_queue) carry the lineups by court side
// (lineup_left / lineup_right). In set 5 the side was guessed by the set
// number (A left) before the change of courts, and from the coin toss
// unflipped after it.
describe('Scoreboard: the synced event\'s lineup_left is the scorer\'s left team', () => {
  const AWAY_LINEUP = { I: '6', II: '5', III: '4', IV: '3', V: '2', VI: '1' }
  const lastPointRow = async () => (await db.sync_queue.toArray())
    .filter(q => q.resource === 'event' && q.payload?.type === 'point')
    .at(-1)?.payload

  async function scorePoint() {
    if (await waitFor(() => { if (!button('Start set') && !button('Start rally')) throw new Error('not ready') }, { timeout: 10000 }).then(() => !!button('Start set'))) {
      await settle()
      fireEvent.click(button('Start set'))
      await waitFor(() => expect(button('Confirm')).toBeTruthy(), { timeout: 5000 })
      fireEvent.click(button('Confirm'))
    } else {
      await settle()
      fireEvent.click(button('Start rally'))
    }
    await waitFor(() => expect(button('Point A')).toBeTruthy(), { timeout: 10000 })
    await settle()
    fireEvent.click(button('Point A'))
    await waitFor(async () => expect(await lastPointRow()).toBeTruthy(), { timeout: 10000 })
    return lastPointRow()
  }

  it('set 5 with B on the left (its coin toss): lineup_left is B\'s (away), as on the scorer\'s court', async () => {
    const matchId = await setUpMatch(['home', 'away', 'home', 'away'], [3, 2], {
      match: { set5LeftTeam: 'B', set5FirstServe: 'A', set5CourtSwitched: false },
      lineups: { away: AWAY_LINEUP }
    })
    mount(matchId)
    const row = await scorePoint()
    expect(teamAOnLeft()).toBe(false)
    expect(row.lineup_left.I.number).toBe(6)
    expect(row.lineup_right.I.number).toBe(1)
  }, 90000)

  it('set 5 after the change of courts at 8 (A left by its coin toss): lineup_left is B\'s', async () => {
    const matchId = await setUpMatch(['home', 'away', 'home', 'away'], [8, 5], {
      match: { set5LeftTeam: 'A', set5FirstServe: 'A', set5CourtSwitched: true },
      lineups: { away: AWAY_LINEUP }
    })
    mount(matchId)
    const row = await scorePoint()
    expect(teamAOnLeft()).toBe(false)
    expect(row.lineup_left.I.number).toBe(6)
  }, 90000)
})
