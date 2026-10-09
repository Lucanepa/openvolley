// "Swap A/B" (Manual adjustments -> Teams) corrects the coin toss only
// (owner's decision, 2026-10-09, as OpenBeach): it changes which team is A
// and which is B, nothing moves on the court, the same team serves first.
// A set without a saved side takes it from the set number (A left in odd
// sets): the swap flipped only the saved sides, so in such a set the new A
// was put on the left, i.e. the teams changed courts; in set 5 every earlier
// set's side moved the same way, and with no toss side saved set 5 itself.
//
// The swap is made on the real Manual adjustments page, then the real
// scoring screen is mounted on the same Dexie database (fake IndexedDB):
// the team on its left is the one that was there before.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react'

vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal()
  const result = { data: null, error: null }
  const chain = () => {
    const q = new Proxy({}, {
      get(_, key) {
        if (key === 'then') return (res, rej) => Promise.resolve(result).then(res, rej)
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
import ManualAdjustments from '../ManualAdjustments'
import { getSideAForSet, getFirstServeForSet } from '../../domain/rules'
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

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text) && !b.disabled)

// The scoring screen's team columns: "A-HOM" / "B-AWA" (letter, short name)
const homeOnLeftOnScreen = () => {
  const text = document.body.textContent
  const home = text.search(/[AB]-HOM/)
  const away = text.search(/[AB]-AWA/)
  if (home < 0 || away < 0) throw new Error('team columns not shown yet')
  return home < away
}

// The team the court has on the left in a set, as the match row says
const leftTeam = (m, set) => {
  const a = m.coinTossTeamA || 'home'
  return getSideAForSet(set, m) === 'left' ? a : (a === 'home' ? 'away' : 'home')
}
const SETS = [1, 2, 3, 4, 5]

// A best-of-5 match, team A home, home serving first. `won` the finished
// sets' winners, the current set (the next index) at `points` [home, away].
async function setUpMatch(won, points, extra = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWA' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, homeName: 'Home VC', awayName: 'Away VC', homeShortName: 'HOM', awayShortName: 'AWA',
    status: 'live', test: false, bestOf: 5, seed_key: 'match_swap_keeps_sides',
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
    await db.events.add({ matchId, setIndex: index, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  }
  // the current set's points as rallies (home and away in turn, then the
  // rest), so an undo recounts the score from them
  if (points[0] + points[1] > 0) {
    await db.events.add({ matchId, setIndex: index, type: 'set_start', payload: {}, seq: seq++, ts: t })
    const level = Math.min(points[0], points[1])
    const rallies = [
      ...Array.from({ length: level }, () => ['home', 'away']).flat(),
      ...Array(points[0] - level).fill('home'),
      ...Array(points[1] - level).fill('away')
    ]
    const at = (i) => new Date(Date.parse(t) + (i + 1) * 5000).toISOString()
    for (const [i, team] of rallies.entries()) {
      await db.events.add({ matchId, setIndex: index, type: 'rally_start', payload: {}, seq: seq++, ts: at(i) })
      await db.events.add({ matchId, setIndex: index, type: 'point', payload: { team }, seq: seq++, ts: at(i) })
    }
  }
  return matchId
}

// "Swap A/B" on the Manual adjustments page's Teams tab, saved
async function swapAB(matchId) {
  render(<AlertProvider><ManualAdjustments matchId={matchId} onClose={() => {}} onSave={() => {}} /></AlertProvider>)
  const teamsTab = await screen.findByRole('radio', { name: 'Teams' }, { timeout: 10000 }).catch(() => screen.findByRole('button', { name: 'Teams' }))
  fireEvent.click(teamsTab)
  await waitFor(() => expect(button('Swap A/B')).toBeTruthy(), { timeout: 10000 })
  const before = (await db.matches.get(matchId)).coinTossTeamA
  fireEvent.click(button('Swap A/B'))
  await waitFor(() => expect(button('Save changes')).toBeTruthy())
  fireEvent.click(button('Save changes'))
  await waitFor(async () => expect((await db.matches.get(matchId)).coinTossTeamA).not.toBe(before), { timeout: 10000 })
  cleanup()
}

const mountScoreboard = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

// The swap on a match in the given state: every set keeps its left team and
// its first server, A and B are the other teams, and the scoring screen
// shows the team that was on the left there still (now with the other letter)
async function expectSwapKeepsSides(matchId, { currentSet, homeLeftNow }) {
  const before = await db.matches.get(matchId)
  expect(leftTeam(before, currentSet) === 'home').toBe(homeLeftNow)

  await swapAB(matchId)

  const after = await db.matches.get(matchId)
  expect(after.coinTossTeamA).toBe('away')
  expect(after.coinTossTeamB).toBe('home')
  for (const set of SETS) {
    expect(leftTeam(after, set), `left team in set ${set}`).toBe(leftTeam(before, set))
    expect(getFirstServeForSet(set, after), `first server in set ${set}`).toBe(getFirstServeForSet(set, before))
  }
  expect(!!after.set5CourtSwitched).toBe(!!before.set5CourtSwitched)

  mountScoreboard(matchId)
  await waitFor(() => expect(homeOnLeftOnScreen()).toBe(homeLeftNow), { timeout: 20000 })
  // the letters follow the swap: home is B now
  expect(document.body.textContent).toMatch(/B-HOM/)
  expect(document.body.textContent).toMatch(/A-AWA/)
}

describe('Swap A/B moves no team (Manual adjustments, then the scoring screen)', () => {
  it('set 1, no saved side: home (A) on the left stays on the left as B', async () => {
    const matchId = await setUpMatch([], [3, 2])
    await expectSwapKeepsSides(matchId, { currentSet: 1, homeLeftNow: true })
  }, 90000)

  it('set 2, no saved side: away (B) on the left stays on the left as A', async () => {
    const matchId = await setUpMatch(['home'], [3, 2])
    await expectSwapKeepsSides(matchId, { currentSet: 2, homeLeftNow: false })
  }, 90000)

  it('set 5 before the change of courts at 8 (toss: B, away, on the left)', async () => {
    const matchId = await setUpMatch(['home', 'away', 'home', 'away'], [3, 2], { set5LeftTeam: 'B', set5FirstServe: 'A', set5CourtSwitched: false })
    await expectSwapKeepsSides(matchId, { currentSet: 5, homeLeftNow: false })
  }, 90000)

  it('set 5 after the change of courts at 8 (toss: A, home, on the left; changed: away left)', async () => {
    const matchId = await setUpMatch(['home', 'away', 'home', 'away'], [8, 5], { set5LeftTeam: 'A', set5FirstServe: 'A', set5CourtSwitched: true })
    await expectSwapKeepsSides(matchId, { currentSet: 5, homeLeftNow: false })
  }, 90000)

  it('set 5 with no toss side saved (an older match), after the change at 8: its side written, nothing moves', async () => {
    const matchId = await setUpMatch(['home', 'away', 'home', 'away'], [8, 5], { set5CourtSwitched: true })
    await expectSwapKeepsSides(matchId, { currentSet: 5, homeLeftNow: true })
    expect((await db.matches.get(matchId)).set5LeftTeam).toBe('A')
  }, 90000)
})

// Undo of an event logged before the swap: its snapshot names the teams the
// old way round (its teamAKey). The undo restores the score by that
// snapshot's Team A and leaves the sides alone: nothing moves, the point
// leaves the team it was given to.
describe('Undo after Swap A/B of an event logged before it', () => {
  const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
  const events = async () => (await db.events.toArray()).sort((a, b) => a.seq - b.seq)
  const pointsOf = async (index) => {
    const s = (await db.sets.toArray()).find(r => r.index === index)
    return [s.homePoints, s.awayPoints]
  }
  async function scorePoint(label) {
    await waitFor(() => expect(button('Start set') || button('Start rally')).toBeTruthy(), { timeout: 10000 })
    await settle()
    if (button('Start set')) {
      fireEvent.click(button('Start set'))
      await waitFor(() => expect(button('Confirm')).toBeTruthy())
      fireEvent.click(button('Confirm'))
    } else {
      fireEvent.click(button('Start rally'))
    }
    await waitFor(() => expect(button(label)).toBeTruthy(), { timeout: 10000 })
    await settle()
    const before = (await events()).filter(e => e.type === 'point').length
    fireEvent.click(button(label))
    await waitFor(async () => expect((await events()).filter(e => e.type === 'point').length).toBe(before + 1))
    await settle()
  }
  async function undoLast() {
    await waitFor(() => expect(button('Undo')).toBeTruthy(), { timeout: 10000 })
    await settle()
    const before = (await events()).length
    fireEvent.click(button('Undo'))
    await waitFor(() => expect(button('Yes')).toBeTruthy())
    fireEvent.click(button('Yes'))
    await waitFor(async () => expect((await events()).length).toBeLessThan(before))
    await settle()
  }

  it('set 2, no saved side: the point home scored before the swap is taken from home, away stays on the left', async () => {
    const matchId = await setUpMatch(['home'], [0, 0])
    mountScoreboard(matchId)
    await scorePoint('Point A') // home (A)
    expect(await pointsOf(2)).toEqual([1, 0])
    cleanup()

    await swapAB(matchId)
    mountScoreboard(matchId)
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(false), { timeout: 20000 })
    await undoLast()
    expect(await pointsOf(2)).toEqual([0, 0])
    const m = await db.matches.get(matchId)
    expect(m.coinTossTeamA).toBe('away')
    expect(leftTeam(m, 2)).toBe('away')
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(false))
    expect(document.body.textContent).toMatch(/B-HOM/)
    cleanup()
  }, 120000)

  it('set 5 after the change of courts at 8: undo of a point made before the swap keeps the courts changed and each team on its side', async () => {
    // set 4 ended with home (A) on the right: the toss put home (A) on the left
    const matchId = await setUpMatch(['home', 'away', 'home', 'away'], [8, 6], { set5LeftTeam: 'A', set5FirstServe: 'A', set5CourtSwitched: true })
    mountScoreboard(matchId)
    await scorePoint('Point B') // away (B), 8:7
    expect(await pointsOf(5)).toEqual([8, 7])
    cleanup()

    await swapAB(matchId)
    mountScoreboard(matchId)
    // after the change of courts: away on the left
    await waitFor(() => expect(homeOnLeftOnScreen()).toBe(false), { timeout: 20000 })
    await undoLast()
    expect(await pointsOf(5)).toEqual([8, 6])
    const m = await db.matches.get(matchId)
    expect(m.set5CourtSwitched).toBe(true)
    expect(leftTeam(m, 5)).toBe('away')
    await settle()
    expect(button('Switch courts')).toBeFalsy()
    expect(homeOnLeftOnScreen()).toBe(false)
    cleanup()
  }, 120000)
})
