// "Decision change" right after a penalty point (audit LOG-06).
//
// Home wins rally 1 (1:0); away delays twice, a warning and then a penalty
// that gives home the point and the serve (2:0). The referee reverses rally
// 1. The decision change took the PENALTY point as "the last point": swap
// gave it to away (the sanctioned team: 1:1 with away serving) and dropped
// its link to the penalty, replay deleted it and left the delay penalty
// without its point. The decision change works on the rally: while a
// sanction or a penalty point follows it, the button is shown disabled with
// "Undo the sanction first"; Undo takes the penalty back with its point,
// then the warning, and the decision change on rally 1 is offered again.
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
import { compareBySeq } from '../../domain/describe'
import { servingTeamFromLog, scoreFromPointEvents } from '../../domain/rules'

class OfflineSocket { constructor() { this.readyState = 3 } send() {} close() {} addEventListener() {} removeEventListener() {} }
// As in ScoreboardStaleTaps.test.jsx: only the environment's PrematureCommitError is let through
let rejectionListeners = []
const filterRejections = (reason, promise) => {
  if (reason?.name === 'PrematureCommitError') return
  for (const l of rejectionListeners) l(reason, promise)
}
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
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})
beforeEach(async () => {
  cleanup()
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
})
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

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 120))
const buttons = (text) => [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === text && !b.disabled)
const button = (text) => buttons(text)[0]
const dialog = (re) => [...document.querySelectorAll('[role="dialog"]')].find(d => re.test(d.textContent))
const blocked = () => document.querySelector('[data-testid="decision-change-blocked"]')
// a button of the open dialog whose text matches `re`
const dialogButton = (re, text) => [...(dialog(re)?.querySelectorAll('button') || [])].find(b => b.textContent.trim() === text && !b.disabled)
const penaltyPoints = async () => (await ofType('point')).filter(e => e.payload?.penaltySeq != null)
const allEvents = async () => (await db.events.toArray()).sort(compareBySeq)
const ofType = async (type) => (await allEvents()).filter(e => e.type === type)
const sanctions = async () => (await ofType('sanction')).map(e => `${e.payload.team}:${e.payload.type}`)

// A best-of-5 match, team A (home) on the left, home served first. Set 1
// (or the deciding set 5 after 2:2 in sets: `set5`) at the score the
// `points` give, each the team that won that rally; no rally in play. The
// default: set 1 at 1:0, home won rally 1
async function setUpMatch(points = ['home'], { set5 = false } = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const [teamId, base] of [[home, 0], [away, 20]]) for (let n = 1; n <= 8; n++) players.push({ teamId, number: base + n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5, firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away',
    ...(set5 ? { set5FirstServe: 'A', set5LeftTeam: 'A', set5CourtSwitched: false } : {})
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const setIndex = set5 ? 5 : 1
  if (set5) {
    for (const index of [1, 2, 3, 4]) {
      const homeWins = index % 2 === 1
      await db.sets.add({ matchId, index, homePoints: homeWins ? 25 : 20, awayPoints: homeWins ? 20 : 25, finished: true, startTime: t, endTime: t })
    }
  }
  const homePoints = points.filter(p => p === 'home').length
  await db.sets.add({ matchId, index: setIndex, homePoints, awayPoints: points.length - homePoints, finished: false, startTime: t })
  let seq = 1
  const lineup = (base) => ({ I: String(base + 1), II: String(base + 2), III: String(base + 3), IV: String(base + 4), V: String(base + 5), VI: String(base + 6) })
  const rows = [{ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t }]
  if (set5) rows.push({ matchId, setIndex, type: 'set5_coin_toss', payload: {}, seq: seq++, ts: t })
  rows.push(
    { matchId, setIndex, type: 'lineup', payload: { team: 'home', lineup: lineup(0), isInitial: true }, seq: seq++, ts: t },
    { matchId, setIndex, type: 'lineup', payload: { team: 'away', lineup: lineup(20), isInitial: true }, seq: seq++, ts: t },
    { matchId, setIndex, type: 'set_start', payload: {}, seq: seq++, ts: t }
  )
  // each rally a few seconds after the one before (the serve follows the newest point)
  const at = (i) => new Date(Date.parse(t) + (i + 1) * 5000).toISOString()
  const score = { home: 0, away: 0 }
  for (const [i, team] of points.entries()) {
    score[team]++
    rows.push(
      { matchId, setIndex, type: 'rally_start', payload: {}, seq: seq++, ts: at(i) },
      { matchId, setIndex, type: 'point', payload: { team, score: { ...score } }, seq: seq++, ts: at(i) }
    )
  }
  await db.events.bulkAdd(rows)
  return matchId
}
// home and away alternately from 0:0 to `n`:`n`, then the `extra` points
const level = (n, ...extra) => [...Array.from({ length: n }, () => ['home', 'away']).flat(), ...extra]
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

// the right team's (away's) delay button, confirmed with Yes
async function awayDelay(label) {
  const before = (await ofType('sanction')).length
  await waitFor(() => expect(buttons(label).length).toBeGreaterThan(0))
  const list = buttons(label)
  fireEvent.click(list.length > 1 ? list[1] : list[0])
  await waitFor(() => expect(button('Yes')).toBeTruthy())
  await settle()
  fireEvent.click(button('Yes'))
  await waitFor(async () => expect((await ofType('sanction')).length).toBe(before + 1))
  await settle()
}

async function undoOnce() {
  await settle()
  fireEvent.click(document.querySelector('[data-help-id="scoreboard-undo"]'))
  await waitFor(() => expect(dialog(/Confirm undo/)).toBeTruthy(), { timeout: 5000 })
  await settle()
  fireEvent.click([...dialog(/Confirm undo/).querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes'))
  await waitFor(() => expect(dialog(/Confirm undo/)).toBeFalsy(), { timeout: 5000 })
  await settle()
}

describe('Scoreboard: decision change after a penalty point', () => {
  it('is shown, not offered, until the sanction is taken back; then it changes the rally', async () => {
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    await settle()
    // rally 1 is the last event: the decision change is offered
    expect(button('Decision change')).toBeTruthy()

    // away delays twice: the warning, then the penalty (point and serve to home)
    await awayDelay('Delay warning')
    await awayDelay('Delay penalty')
    await waitFor(async () => expect((await ofType('point')).length).toBe(2))
    await settle()
    const penaltyPoint = (await ofType('point')).pop()
    expect(penaltyPoint.payload).toMatchObject({ team: 'home' })
    expect(penaltyPoint.payload.penaltySeq).toBeTruthy()

    // the decision change waits: shown disabled, with why; nothing to tap
    await waitFor(() => expect(blocked()).toBeTruthy())
    expect(blocked().disabled).toBe(true)
    expect(blocked().textContent).toContain('Undo the sanction first')
    expect(button('Decision change')).toBeFalsy()
    expect(await ofType('decision_change')).toEqual([])
    expect(await ofType('replay')).toEqual([])

    // Undo takes the delay penalty back with its point; the warning still waits
    await undoOnce()
    expect(await sanctions()).toEqual(['away:delay_warning'])
    expect((await ofType('point')).length).toBe(1)
    await waitFor(() => expect(blocked()).toBeTruthy())

    // ... and then the warning: the decision change is on rally 1 again
    await undoOnce()
    expect(await sanctions()).toEqual([])
    await waitFor(() => expect(button('Decision change')).toBeTruthy())
    expect(blocked()).toBeFalsy()

    // the referee gives rally 1 to away: 0:1, away serves
    fireEvent.click(button('Decision change'))
    await waitFor(() => expect(document.body.textContent.includes('Replay the rally')).toBe(true))
    await settle()
    fireEvent.click(button('Confirm'))
    await waitFor(async () => expect((await ofType('decision_change')).length).toBe(1))
    await settle()
    const events = await allEvents()
    expect(scoreFromPointEvents(events, 1)).toEqual({ homePoints: 0, awayPoints: 1 })
    expect(servingTeamFromLog(events, 1, await db.matches.get(matchId))).toBe('away')
    const set = await db.sets.where({ matchId, index: 1 }).first()
    expect([set.homePoints, set.awayPoints]).toEqual([0, 1])
  }, 120000)

  // The set-end dialog (and the deciding set's change of courts) opened by
  // a penalty's point: its "Decision change" only said "undo the sanction
  // first" and stayed open, over the screen's Undo, so the scorer had to
  // confirm a set end that should not stand (review of LOG-06). It now asks
  // to take the penalty back with its point (the screen's Undo); cancelled,
  // the dialog comes back.
  it('the set-end dialog after a penalty point: Decision change takes the penalty back with its point', async () => {
    // set 1 at 24:22, home won the last rally (and serves)
    const matchId = await setUpMatch(level(22, 'home', 'home'))
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    await settle()

    // away delays twice: the warning, then the penalty: home's point, 25:22, ends the set
    await awayDelay('Delay warning')
    await awayDelay('Delay penalty')
    await waitFor(() => expect(dialog(/Set 1 end/)).toBeTruthy(), { timeout: 5000 })
    await settle()
    expect((await ofType('point')).length).toBe(47)
    expect((await penaltyPoints()).length).toBe(1)

    // Decision change: the set-end dialog closes and Undo asks for the
    // penalty with its point, saying why
    fireEvent.click(dialogButton(/Set 1 end/, 'Decision change'))
    await waitFor(() => expect(dialog(/Confirm undo/)).toBeTruthy(), { timeout: 5000 })
    expect(dialog(/Set 1 end/)).toBeFalsy()
    expect(dialog(/Confirm undo/).textContent).toContain('undo the sanction first')
    // what goes: the delay penalty, with its point
    expect(dialog(/Confirm undo/).textContent).toMatch(/Delay penalty[^]*\+1 point to/)
    expect(dialog(/Replay the rally/)).toBeFalsy()

    // Cancelled: nothing changes, the set end is asked again
    await settle()
    fireEvent.click(dialogButton(/Confirm undo/, 'Cancel'))
    await waitFor(() => expect(dialog(/Set 1 end/)).toBeTruthy(), { timeout: 5000 })
    expect(dialog(/Confirm undo/)).toBeFalsy()
    expect(await sanctions()).toEqual(['away:delay_warning', 'away:delay_penalty'])
    expect((await ofType('point')).length).toBe(47)
    expect(await ofType('set_end')).toEqual([])
    await settle()

    // again, and Yes: the penalty goes with its point
    fireEvent.click(dialogButton(/Set 1 end/, 'Decision change'))
    await waitFor(() => expect(dialog(/Confirm undo/)).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(dialogButton(/Confirm undo/, 'Yes'))
    await waitFor(() => expect(dialog(/Confirm undo/)).toBeFalsy(), { timeout: 5000 })
    await settle()

    // 24:22, no set end, the warning stays; no penalty without its point,
    // no point of a penalty that is gone
    expect(scoreFromPointEvents(await allEvents(), 1)).toEqual({ homePoints: 24, awayPoints: 22 })
    const set = await db.sets.where({ matchId, index: 1 }).first()
    expect([set.homePoints, set.awayPoints, !!set.finished]).toEqual([24, 22, false])
    expect(await ofType('set_end')).toEqual([])
    expect(await sanctions()).toEqual(['away:delay_warning'])
    expect(await penaltyPoints()).toEqual([])
    expect(dialog(/Set 1 end/)).toBeFalsy()

    // the screen goes on: the warning is taken back, then the rally's
    // decision change is offered
    await waitFor(() => expect(blocked()).toBeTruthy())
    expect(button('Start rally')).toBeTruthy()
    await undoOnce()
    expect(await sanctions()).toEqual([])
    await waitFor(() => expect(button('Decision change')).toBeTruthy())
    expect(dialog(/Set 1 end/)).toBeFalsy()
  }, 120000)

  it('the change of courts after a penalty point at 8: Decision change takes the penalty back with its point', async () => {
    // set 5 at 7:6, home won the last rally (and serves); courts not changed
    const matchId = await setUpMatch(level(6, 'home'), { set5: true })
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    await settle()

    // the penalty's point takes home to 8: the change of courts is asked
    await awayDelay('Delay warning')
    await awayDelay('Delay penalty')
    await waitFor(() => expect(dialog(/Court switch required/)).toBeTruthy(), { timeout: 5000 })
    await settle()

    fireEvent.click(dialogButton(/Court switch required/, 'Decision change'))
    await waitFor(() => expect(dialog(/Confirm undo/)).toBeTruthy(), { timeout: 5000 })
    expect(dialog(/Court switch required/)).toBeFalsy()
    expect(dialog(/Confirm undo/).textContent).toContain('undo the sanction first')
    expect(dialog(/Confirm undo/).textContent).toMatch(/Delay penalty[^]*\+1 point to/)

    // Cancelled: the change of courts is asked again, nothing written
    await settle()
    fireEvent.click(dialogButton(/Confirm undo/, 'Cancel'))
    await waitFor(() => expect(dialog(/Court switch required/)).toBeTruthy(), { timeout: 5000 })
    expect(await sanctions()).toEqual(['away:delay_warning', 'away:delay_penalty'])
    expect(!!(await db.matches.get(matchId)).set5CourtSwitched).toBe(false)
    await settle()

    // again, and Yes: 7:6, no change of courts due
    fireEvent.click(dialogButton(/Court switch required/, 'Decision change'))
    await waitFor(() => expect(dialog(/Confirm undo/)).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(dialogButton(/Confirm undo/, 'Yes'))
    await waitFor(() => expect(dialog(/Confirm undo/)).toBeFalsy(), { timeout: 5000 })
    await settle()
    const set = await db.sets.where({ matchId, index: 5 }).first()
    expect([set.homePoints, set.awayPoints]).toEqual([7, 6])
    expect(await sanctions()).toEqual(['away:delay_warning'])
    expect(await penaltyPoints()).toEqual([])
    expect(!!(await db.matches.get(matchId)).set5CourtSwitched).toBe(false)
    expect(dialog(/Court switch required/)).toBeFalsy()
    await waitFor(() => expect(blocked()).toBeTruthy())
  }, 120000)
})
