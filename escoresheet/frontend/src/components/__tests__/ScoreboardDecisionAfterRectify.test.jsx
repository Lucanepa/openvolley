// "Assign to other team" on the first rally after a going back (audit
// LOG-03). The decision change took the server of the rally from the team of
// the previous point row; after a going back that set the score by hand (a
// point that won no rally and passes no serve) that was the wrong team, so
// the swap rotated the team that had served (FIVB 7.6.1: only the receiving
// team rotates when it wins the rally). It now asks the app's serve rule
// (domain/rules serveBeforePoint).
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with clicks; the going back is written with the app's
// own planner and executor, as the Go back dialog does.
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
import { servingTeamFromLog } from '../../domain/rules'
import { compareBySeq } from '../../domain/describe'
import { planRectification, rectifyMoments } from '../../domain/rectify'
import { applyCorrectionPlan } from '../../services/corrections/applyCorrectionPlan'
import { recomputeMatch } from '../../domain/recompute'

class OfflineSocket { constructor() { this.readyState = 3 } send() {} close() {} addEventListener() {} removeEventListener() {} }
// As in ScoreboardStaleTaps.test.jsx: under jsdom + fake-indexeddb a scorer
// action can lose Dexie's transaction zone part-way and end with
// PrematureCommitError (not in Chrome). Only that error is let through.
const isEnvPrematureCommit = (reason) => reason?.name === 'PrematureCommitError'
let rejectionListeners = []
const filterRejections = (reason, promise) => { if (isEnvPrematureCommit(reason)) return; for (const l of rejectionListeners) l(reason, promise) }
let saved
beforeAll(() => {
  rejectionListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', filterRejections)
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, w: window.innerWidth, h: window.innerHeight }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  window.innerWidth = 1280
  window.innerHeight = 800
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
beforeEach(async () => { cleanup(); await Promise.all(db.tables.map(t => t.clear())) })
afterAll(() => {
  cleanup()
  window.innerWidth = saved.w
  window.innerHeight = saved.h
  process.removeListener('unhandledRejection', filterRejections)
  for (const l of rejectionListeners) process.on('unhandledRejection', l)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const help = (id) => document.querySelector(`[data-help-id="${id}"]`)
const events = async () => (await db.events.toArray()).sort(compareBySeq)
const ofType = async (type) => (await events()).filter(e => e.type === type)
const lineupOf = async (team) => (await events()).filter(e => e.type === 'lineup' && e.setIndex === 1 && e.payload?.team === team).pop()?.payload?.lineup
const HOME_LU = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
const AWAY_LU = { I: '11', II: '12', III: '13', IV: '14', V: '15', VI: '16' }

async function setUp() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const [teamId, base] of [[home, 0], [away, 10]]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: base + n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({ homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5, firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away' })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: t })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: HOME_LU, isInitial: true }, seq: seq++, ts: t })
  await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: AWAY_LU, isInitial: true }, seq: seq++, ts: t })
  await db.events.add({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  return matchId
}
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

// home is on the left in set 1 (team A = home)
async function rally(side) {
  await waitFor(() => expect(button('Start rally')).toBeTruthy())
  fireEvent.click(button('Start rally'))
  await waitFor(() => expect(help('scoreboard-point-left')?.tagName).toBe('BUTTON'))
  await settle()
  const before = (await ofType('point')).length
  fireEvent.click(help(`scoreboard-point-${side}`))
  await waitFor(async () => expect((await ofType('point')).length).toBe(before + 1))
  await settle()
}

async function goBack(matchId, opts) {
  const all = await events()
  const match = await db.matches.get(matchId)
  const moments = rectifyMoments(all, { setIndex: 1 })
  const plan = planRectification(all, { setIndex: 1, moment: moments[0], ...opts }, { match, matchId, liveSetIndex: 1, players: { home: [], away: [] } })
  expect(plan.error).toBeUndefined()
  await applyCorrectionPlan(plan, { matchId, db, mode: 'live' })
  await settle()
}

describe('decision change after a going back', () => {
  it('a point set by hand, then a side-out, then "Assign to other team": the team that served keeps its line-up and the serve', async () => {
    const matchId = await setUp()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    await settle()
    // H, A: 1:1, away serves (it rotated once)
    await rally('left')
    await rally('right')
    const awayServing = await lineupOf('away')
    const match = await db.matches.get(matchId)
    expect(servingTeamFromLog(await events(), 1, match)).toBe('away')

    // Go back, nothing cancelled, the score set by hand to 2:1: a point by
    // hand for home (no rally, no serve). Away still serves
    await goBack(matchId, { cancel: 'home', penaltyTo: null, edits: { score: { home: 2, away: 1 } } })
    expect((await ofType('rectification'))[0].payload.serve).toBe('away')
    expect(servingTeamFromLog(await events(), 1, match)).toBe('away')

    // Home wins the rally away served: a side-out, home rotates (3:1)
    const homeBefore = await lineupOf('home')
    await rally('left')
    expect(await lineupOf('home')).not.toEqual(homeBefore)

    // The referee gives that rally to away, who SERVED it: away does not
    // rotate (7.6.1), home's rotation goes, away keeps serving (2:2)
    await waitFor(() => expect(button('Decision change')).toBeTruthy())
    fireEvent.click(button('Decision change'))
    await waitFor(() => expect(document.body.textContent.includes('Replay the rally')).toBe(true))
    fireEvent.click(button('Confirm'))
    await waitFor(async () => expect((await ofType('decision_change')).length).toBe(1))
    await settle()

    const all = await events()
    const set = (await db.sets.toArray())[0]
    expect([set.homePoints, set.awayPoints]).toEqual([2, 2])
    expect(await lineupOf('away')).toEqual(awayServing)
    expect(await lineupOf('home')).toEqual(homeBefore)
    expect(servingTeamFromLog(all, 1, match)).toBe('away')
    // the rebuild of the corrections finds no rotation to change in this
    // log (it removed away's swap rotation and rewrote one before). It
    // still rewrites the swapped point's stored score (payload.score keeps
    // the score before the swap, as on every decision change): not a row
    // of the rotation
    const rc = recomputeMatch(all, { match, players: { home: [], away: [] } })
    expect(rc.remove).toEqual([])
    const typeOf = (u) => all.find(e => e.id === u.id)?.type
    expect(rc.update.filter(u => typeOf(u) !== 'point')).toEqual([])
    for (const u of rc.update) expect(Object.keys(u.changes.payload || {}).filter(k => k !== 'score' && JSON.stringify(u.changes.payload[k]) !== JSON.stringify(all.find(e => e.id === u.id).payload[k]))).toEqual([])
  }, 120000)
})
