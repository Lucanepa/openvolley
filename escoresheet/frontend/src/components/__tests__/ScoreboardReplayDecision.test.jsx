// The decision change on a replay (owner 23.11.2026: "keep decision change, a
// replay can change to another decision"), rally mode on the tablet screen:
//  - after a replayed rally there is no "Replay pending: ..." line under the
//    time-out / substitution boxes (owner: the whole text goes), and the
//    time-outs stay closed until the next rally is completed (the rule stays);
//  - "Decision change" stays on screen; its dialog offers "Point A" /
//    "Point B" (none chosen), the score now and, on each option, the score
//    and the serve it gives (owner 23.11.2026), before one is chosen;
//  - confirming gives the replayed rally to that team in one action: the
//    replay goes, the point is recorded as the point buttons record it (a
//    side-out rotates), the time-outs open again;
//  - one Undo takes the point back and brings the replay back (the replayed
//    rally's start stays), and the decision change is offered again;
//  - the same for the replay a decision change made ("Replay the rally").
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB). Network is off.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { RALLY_MODE_KEY } from '../../utils/rallyMode'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// As in ScoreboardRallyFlow.test.jsx: under jsdom + fake-indexeddb a scorer
// action can lose Dexie's transaction zone part-way and end with
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
  window.innerWidth = 1280
  window.innerHeight = 800
})
beforeEach(async () => {
  cleanup()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  localStorage.removeItem('displayMode')
  localStorage.removeItem(RALLY_MODE_KEY)
  await Promise.all(db.tables.map(t => t.clear()))
})
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(() => {
  cleanup()
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  window.innerWidth = saved.width
  window.innerHeight = saved.height
})

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const settle = () => wait(GHOST_CLICK_MS + 150)
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const dialog = (re) => [...document.querySelectorAll('[role="dialog"]')].find(d => re.test(d.textContent))
const decisionDialog = () => dialog(/Decision change/)
const radio = (option) => decisionDialog()?.querySelector(`[data-decision-option="${option}"]`)
const confirmButton = () => [...decisionDialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm')
const labels = () => [...decisionDialog().querySelectorAll('[data-decision-label]')].map(l => l.textContent.trim())
// What an option gives, on its card: { score: 'home:away', serve }
const outcomeOf = (option) => {
  const el = screen.getByTestId(`decision-outcome-${option}`)
  return { score: el.querySelector('[data-score]').getAttribute('data-score'), serve: el.getAttribute('data-serve') }
}
const currentScore = () => screen.getByTestId('decision-current').querySelector('[data-score]').getAttribute('data-score')
const events = async () => (await db.events.toArray()).sort((a, b) => a.seq - b.seq)
const ofType = async (type) => (await events()).filter(e => e.type === type)
const lastLineup = async (team) => (await ofType('lineup')).filter(e => e.payload.team === team).at(-1).payload.lineup
const score = async (setId) => { const s = await db.sets.get(setId); return [s.homePoints, s.awayPoints] }
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
const AWAY_LINEUP = { I: '11', II: '12', III: '13', IV: '14', V: '15', VI: '16' }
const INK = 'data:image/png;base64,AAAA'

// Set 1 at 1:1: home served and won the first rally, away won the second (a
// side-out: away rotated and serves). Team A (home) on the left. Both
// line-ups in, everybody signed.
async function matchAtOneAll() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (let n = 1; n <= 8; n++) players.push({ teamId: home, number: n, lastName: `H${n}`, firstName: 'X' })
  for (let n = 11; n <= 18; n++) players.push({ teamId: away, number: n, lastName: `A${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5, seed_key: 'seed-replay-decision-1',
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
    homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK
  })
  const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const setId = await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 1, finished: false, startTime: ts })
  await db.events.bulkAdd([
    { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: LINEUP, isInitial: true }, seq: 2, ts },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: AWAY_LINEUP, isInitial: true }, seq: 3, ts },
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 4, ts },
    { matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: 5, ts },
    { matchId, setIndex: 1, type: 'point', payload: { team: 'home', score: { home: 1, away: 0 } }, seq: 6, ts },
    { matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: 7, ts },
    { matchId, setIndex: 1, type: 'point', payload: { team: 'away', score: { home: 1, away: 1 } }, seq: 8, ts },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: { I: '12', II: '13', III: '14', IV: '15', V: '16', VI: '11' } }, seq: 8.1, ts }
  ])
  return { matchId, setId }
}

async function openDecisionDialog() {
  await waitFor(() => expect(button('Decision change')).toBeTruthy(), { timeout: 5000 })
  await settle()
  fireEvent.click(button('Decision change'))
  await waitFor(() => expect(decisionDialog()).toBeTruthy(), { timeout: 5000 })
}

describe('rally mode: the decision change on a replay', () => {
  it('no "Replay pending" text, Decision change stays: Point A gives the replayed rally to A (side-out), one Undo brings the replay back', async () => {
    const { matchId, setId } = await matchAtOneAll()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    // no replay yet: the time-outs are open
    expect(screen.getByTestId('timeout-tap-hint-left')).toBeTruthy()
    await settle()

    // ---- a rally, replayed ----
    fireEvent.click(button('Start rally'))
    await waitFor(() => expect(button('Replay rally')).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(button('Replay rally'))
    await waitFor(() => expect(dialog(/Replay rally\?/)).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click([...dialog(/Replay rally\?/).querySelectorAll('button')].find(b => b.textContent.trim() === 'Replay rally'))
    await waitFor(async () => expect(await ofType('replay')).toHaveLength(1), { timeout: 5000 })
    const replay = (await ofType('replay'))[0]

    // the time-outs stay closed, with no line saying so
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByTestId('timeout-tap-hint-left')).toBeNull()
    expect(screen.queryByTestId('timeout-tap-hint-right')).toBeNull()
    expect(screen.queryByTestId('request-block-left')).toBeNull()
    expect(screen.queryByTestId('request-block-right')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Replay pending/)

    // ---- Decision change: Point A / Point B, none chosen ----
    await openDecisionDialog()
    expect(screen.getByTestId('decision-last-replay').textContent).toBe('The last rally was replayed')
    const radios = [...decisionDialog().querySelectorAll('[role="radio"]')]
    expect(radios.map(r => r.getAttribute('data-decision-option'))).toEqual(['point_home', 'point_away'])
    expect(labels()).toEqual(['Point A', 'Point B'])
    expect(radios.every(r => r.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(confirmButton().disabled).toBe(true)
    expect(screen.getByTestId('decision-choose')).toBeTruthy()
    // before any choice: the score now, and what each option gives (the
    // team given the rally scores and serves)
    expect(currentScore()).toBe('1:1')
    expect(outcomeOf('point_home')).toEqual({ score: '2:1', serve: 'home' })
    expect(outcomeOf('point_away')).toEqual({ score: '1:2', serve: 'away' })
    expect(screen.getByTestId('decision-outcome-point_away').textContent).toContain('HOM 1 : 2 AWY')
    fireEvent.click(radio('point_away'))
    await waitFor(() => expect(radio('point_away').getAttribute('aria-checked')).toBe('true'), { timeout: 5000 })
    expect(confirmButton().disabled).toBe(false)
    expect(screen.queryByTestId('decision-choose')).toBeNull()
    fireEvent.click(radio('point_home'))
    await waitFor(() => expect(radio('point_home').getAttribute('aria-checked')).toBe('true'), { timeout: 5000 })
    expect(radio('point_away').getAttribute('aria-checked')).toBe('false')
    await settle()
    fireEvent.click(confirmButton())

    // ---- the point took the replay's place, as a point from the buttons ----
    await waitFor(async () => expect(await ofType('point')).toHaveLength(3), { timeout: 5000 })
    await waitFor(() => expect(decisionDialog()).toBeFalsy(), { timeout: 5000 })
    expect(await ofType('replay')).toHaveLength(0)
    const point = (await ofType('point')).at(-1)
    expect(point.payload).toMatchObject({ team: 'home', score: { home: 2, away: 1 } })
    expect(point._replacedReplay).toMatchObject({ id: replay.id, type: 'replay', seq: replay.seq })
    // the replayed rally's start is the point's; no new one
    expect((await ofType('rally_start')).map(e => e.seq)).toEqual([5, 7, replay.seq - 1])
    expect(await score(setId)).toEqual([2, 1])
    // a side-out: home rotated (#2 to serve)
    expect(await lastLineup('home')).toMatchObject({ I: '2', II: '3', VI: '1' })
    // no replay pending: the time-outs are open again, the next rally starts as usual
    await waitFor(() => expect(screen.getByTestId('timeout-tap-hint-left')).toBeTruthy(), { timeout: 5000 })
    expect(button('Start rally')).toBeTruthy()
    // the decision change of that point is the usual one now
    await openDecisionDialog()
    expect([...decisionDialog().querySelectorAll('[role="radio"]')].map(r => r.getAttribute('data-decision-option'))).toEqual(['swap', 'replay'])
    // still "Assign to other team" chosen first; each option shows its outcome
    expect(radio('swap').getAttribute('aria-checked')).toBe('true')
    expect(currentScore()).toBe('2:1')
    expect(outcomeOf('swap')).toEqual({ score: '1:2', serve: 'away' })
    expect(outcomeOf('replay')).toEqual({ score: '1:1', serve: 'away' })
    fireEvent.click(button('Cancel'))
    await waitFor(() => expect(decisionDialog()).toBeFalsy(), { timeout: 5000 })

    // ---- one Undo: the point goes, the replay comes back ----
    await settle()
    fireEvent.click(button('Undo'))
    await waitFor(() => expect(dialog(/undo/i)).toBeTruthy(), { timeout: 5000 })
    fireEvent.click([...dialog(/undo/i).querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes'))
    await waitFor(async () => expect(await ofType('point')).toHaveLength(2), { timeout: 5000 })
    const back = await ofType('replay')
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ id: replay.id, seq: replay.seq, setIndex: 1 })
    expect((await ofType('rally_start')).map(e => e.seq)).toEqual([5, 7, replay.seq - 1])
    await waitFor(async () => expect(await score(setId)).toEqual([1, 1]), { timeout: 5000 })
    expect(await lastLineup('home')).toEqual(LINEUP)
    // the replay pending again, and its decision change
    await waitFor(() => expect(screen.queryByTestId('timeout-tap-hint-left')).toBeNull(), { timeout: 5000 })
    await openDecisionDialog()
    expect([...decisionDialog().querySelectorAll('[role="radio"]')].map(r => r.getAttribute('data-decision-option'))).toEqual(['point_home', 'point_away'])
  }, 90000)

  it('the replay a decision change made ("Replay the rally"): Point B gives it to B, who keeps the serve', async () => {
    const { matchId, setId } = await matchAtOneAll()
    mount(matchId)
    // the last point (B's) replayed by a decision change
    await openDecisionDialog()
    expect(screen.getByText('Replay the rally')).toBeTruthy()
    fireEvent.click(radio('replay'))
    await settle()
    fireEvent.click(confirmButton())
    await waitFor(async () => expect(await ofType('replay')).toHaveLength(1), { timeout: 5000 })
    await waitFor(async () => expect(await score(setId)).toEqual([1, 0]), { timeout: 5000 })
    await waitFor(() => expect(decisionDialog()).toBeFalsy(), { timeout: 5000 })

    // and changed again: the rally to B after all
    await openDecisionDialog()
    expect(screen.getByTestId('decision-last-replay')).toBeTruthy()
    // 1:0 now (B's point taken back); B given the rally: 1:1, B serves
    expect(currentScore()).toBe('1:0')
    expect(outcomeOf('point_away')).toEqual({ score: '1:1', serve: 'away' })
    fireEvent.click(radio('point_away'))
    await waitFor(() => expect(radio('point_away').getAttribute('aria-checked')).toBe('true'), { timeout: 5000 })
    await settle()
    fireEvent.click(confirmButton())
    await waitFor(async () => expect(await ofType('replay')).toHaveLength(0), { timeout: 5000 })
    expect((await ofType('point')).map(p => p.payload.team)).toEqual(['home', 'away'])
    await waitFor(async () => expect(await score(setId)).toEqual([1, 1]), { timeout: 5000 })
    // the rally's own start is the point's (seq 7), none other
    expect((await ofType('rally_start')).map(e => e.seq)).toEqual([5, 7])
    // home served that rally: away rotated again, as for the point it was
    expect(await lastLineup('away')).toMatchObject({ I: '12', VI: '11' })
  }, 90000)
})
