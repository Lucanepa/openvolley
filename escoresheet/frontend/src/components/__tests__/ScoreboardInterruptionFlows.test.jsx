// Rows 10, 11 and 19 of the interruption-request spec (2026-11-09) on the
// real scoring screen over the app's real Dexie database (fake IndexedDB),
// driven with taps at phone width (the phone layout's buttons open the
// screen's own dialogs, the ones the tablet uses):
//  - row 10: a late request stopped the rally: "Replay" records the replay
//    and the team's delay warning (reason during_rally), and requests stay
//    closed until the replayed rally is completed;
//  - row 11: the improper request keeps what it was for (payload.reason);
//  - row 19: a decision change after a substitution and a time-out takes
//    them back (not counted) and swaps the point, in one confirmed action.
// Network is off: no relay socket, no fetch.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen, within } from '@testing-library/react'
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

// As in ScoreboardSet5CourtSwitch.test.jsx: under jsdom + fake-indexeddb a
// scorer action can lose Dexie's transaction zone part-way and end with
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
afterEach(() => {
  setViewport(saved.width, saved.height)
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
const events = async () => (await db.events.toArray()).sort((a, b) => a.seq - b.seq)
const ofType = async (type) => (await events()).filter(e => e.type === type)
const phone = () => screen.queryByTestId('phone-scoreboard')
// A time-out / substitution counter's number (its last line)
const count = (testId) => screen.getByTestId(testId).lastChild.textContent

// Set 1 under way at 1:1, team A (home) on the left, both line-ups entered,
// the home team with players 1-8 on its roster and the away team too
async function setUpMatch() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM', color: '#dc2626' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY', color: '#2563eb' })
  const players = []
  for (const teamId of [home, away]) for (let n = 1; n <= 9; n++) players.push({ teamId, number: n, name: `P${n}`, firstName: 'X' })
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 1, finished: false, startTime: t })
  let seq = 1
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  for (const team of ['home', 'away']) {
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
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


describe('Scoreboard: interruption requests on the screen (rows 10, 11, 19)', () => {
  it('row 10: a late request by B stopped the rally: replay + delay warning, requests closed until the rally is completed', async () => {
    setViewport(390, 844)
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    const view = within(phone())
    await waitFor(() => expect(view.getByRole('button', { name: 'Start rally' })).toBeTruthy())
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Start rally' }))
    await waitFor(() => expect(view.getByTestId('phone-action-replay').disabled).toBe(false))
    await settle()
    fireEvent.click(view.getByTestId('phone-action-replay'))
    // the Replay dialog: the plain replay, and one late-request option per team
    const lateB = await waitFor(() => screen.getByTestId('late-request-away'))
    expect(screen.getByTestId('late-request-home')).toBeTruthy()
    expect(lateB.textContent).toContain('Replay because of a late request by B (Away VC): delay sanction')
    expect(lateB.textContent).toContain('Recorded: delay warning.')
    await settle()
    fireEvent.click(lateB)
    await waitFor(async () => expect((await ofType('sanction')).length).toBe(1))
    const all = await events()
    const replay = all.filter(e => e.type === 'replay')
    expect(replay).toHaveLength(1)
    const sanction = (await ofType('sanction'))[0]
    expect(sanction.payload).toMatchObject({ team: 'away', type: 'delay_warning', reason: 'during_rally' })
    expect(sanction.seq).toBeGreaterThan(replay[0].seq)
    // no point was given
    expect(await ofType('point')).toHaveLength(2)
    // requests closed for both teams (row 7), with the reason under them
    await waitFor(() => expect(view.getByTestId('phone-timeout-left').disabled).toBe(true))
    expect(view.getByTestId('phone-timeout-right').disabled).toBe(true)
    expect(view.getByTestId('phone-sub-right').disabled).toBe(true)
    expect(view.getByTestId('phone-request-block').textContent).toMatch(/^Replay pending/)
  }, 60000)

  it('row 10: B already has a delay warning: its late request is a delay penalty, no replay, point and service to A', async () => {
    setViewport(390, 844)
    const matchId = await setUpMatch()
    // B's delay warning, earlier in the set (before both points)
    await db.events.add({ matchId, setIndex: 1, type: 'sanction', payload: { team: 'away', type: 'delay_warning' }, seq: 5.5, ts: new Date(Date.now() - 25 * 60 * 1000).toISOString() })
    await db.matches.update(matchId, { sanctions: { delayWarningAway: true } })
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    const view = within(phone())
    await waitFor(() => expect(view.getByRole('button', { name: 'Start rally' })).toBeTruthy())
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Start rally' }))
    await waitFor(() => expect(view.getByTestId('phone-action-replay').disabled).toBe(false))
    await settle()
    fireEvent.click(view.getByTestId('phone-action-replay'))
    const lateB = await waitFor(() => screen.getByTestId('late-request-away'))
    expect(lateB.textContent).toContain('Late request by B (Away VC): delay penalty, no replay')
    expect(lateB.textContent).toContain('Recorded: delay penalty – point and service to A (Home VC).')
    // A has no delay yet: a warning and the replay
    expect(screen.getByTestId('late-request-home').textContent).toContain('Replay because of a late request by A (Home VC)')
    await settle()
    fireEvent.click(lateB)
    await waitFor(async () => expect((await ofType('point')).length).toBe(3))
    expect(await ofType('replay')).toHaveLength(0)
    const penalty = (await ofType('sanction')).at(-1)
    expect(penalty.payload).toMatchObject({ team: 'away', type: 'delay_penalty', reason: 'during_rally' })
    const point = (await ofType('point')).at(-1)
    expect(point.payload).toMatchObject({ team: 'home', penaltySeq: penalty.seq })
    await waitFor(() => expect(view.getByTestId('phone-score-left').textContent).toBe('2'))
    // the penalty point is the completed rally: requests are open
    await waitFor(() => expect(view.getByTestId('phone-timeout-right').disabled).toBe(false))
    expect(view.queryByTestId('phone-request-block')).toBeNull()
  }, 60000)

  it('row 11: the improper request keeps what it was for; untouched it is "other"', async () => {
    setViewport(390, 844)
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    const view = within(phone())
    await waitFor(() => expect(view.getByTestId('phone-action-sanction').disabled).toBe(false))
    await settle()
    fireEvent.click(view.getByTestId('phone-action-sanction'))
    await waitFor(() => expect(button('Improper request')).toBeTruthy())
    fireEvent.click(button('Improper request'))
    const picker = await waitFor(() => screen.getByTestId('improper-reason'))
    // optional: "Other" is chosen
    expect(within(picker).getByRole('radio', { name: 'Other' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(picker).getByRole('radio', { name: 'Requested by the wrong person' }))
    await waitFor(() => expect(within(screen.getByTestId('improper-reason')).getByRole('radio', { name: 'Requested by the wrong person' }).getAttribute('aria-checked')).toBe('true'))
    await settle()
    fireEvent.click(button('Yes'))
    await waitFor(async () => expect((await ofType('sanction')).length).toBe(1))
    expect((await ofType('sanction'))[0].payload).toMatchObject({ team: 'home', type: 'improper_request', reason: 'wrong_person' })
  }, 60000)

  it('row 19: a decision change after a substitution and a time-out takes them back and swaps the point', async () => {
    setViewport(390, 844)
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    const view = within(phone())
    await waitFor(() => expect(view.getByTestId('phone-score-right').textContent).toBe('1'))
    // the last event is B's point: the plain decision change
    expect(view.getByTestId('phone-action-decision').disabled).toBe(false)
    await settle()

    // ---- substitution B (#3 out, #7 in) ----
    fireEvent.click(view.getByTestId('phone-sub-right'))
    await waitFor(() => expect(screen.getByTestId('phone-sub-out-3')).toBeTruthy())
    fireEvent.click(screen.getByTestId('phone-sub-out-3'))
    await waitFor(() => expect(screen.getByTestId('phone-sub-in-7')).toBeTruthy())
    fireEvent.click(screen.getByTestId('phone-sub-in-7'))
    await waitFor(() => expect(button('Yes')).toBeTruthy())
    await settle()
    fireEvent.click(button('Yes'))
    await waitFor(async () => expect((await ofType('substitution')).length).toBe(1))
    await settle()

    // ---- time-out A ----
    fireEvent.click(view.getByTestId('phone-timeout-left'))
    await waitFor(() => expect(button('Confirm time-out')).toBeTruthy())
    await settle()
    fireEvent.click(button('Confirm time-out'))
    await waitFor(async () => expect((await ofType('timeout')).length).toBe(1))
    await waitFor(() => expect(view.getByRole('button', { name: 'Stop timeout' })).toBeTruthy())
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Stop timeout' }))
    await waitFor(() => expect(view.queryByTestId('phone-countdown')).toBeNull())
    await settle()

    // ---- the decision change is still offered, and says what it takes back ----
    await waitFor(() => expect(view.getByTestId('phone-action-decision').disabled).toBe(false))
    fireEvent.click(view.getByTestId('phone-action-decision'))
    const takeBack = await waitFor(() => screen.getByTestId('decision-take-back'))
    const items = [...takeBack.querySelectorAll('li')].map(li => li.textContent)
    expect(items).toEqual(['Substitution B: #7 in for #3', 'Time-out A'])
    await settle()
    fireEvent.click(button('Confirm'))
    await waitFor(async () => expect((await ofType('decision_change')).length).toBe(1))
    // the substitution and the time-out are gone: not counted
    expect(await ofType('substitution')).toHaveLength(0)
    expect(await ofType('timeout')).toHaveLength(0)
    await waitFor(() => expect(count('phone-sub-right')).toBe('0'))
    expect(count('phone-timeout-left')).toBe('0')
    // the point went to A: 2:0
    const points = await ofType('point')
    expect(points.at(-1).payload.team).toBe('home')
    await waitFor(() => expect(view.getByTestId('phone-score-left').textContent).toBe('2'))
    expect(view.getByTestId('phone-score-right').textContent).toBe('0')
    // B's line-up is the one before the substitution: #3 back, #7 not on court
    const awayLineups = (await ofType('lineup')).filter(e => e.payload.team === 'away')
    const lastAway = awayLineups.at(-1).payload.lineup
    expect(Object.values(lastAway).map(String)).toContain('3')
    expect(Object.values(lastAway).map(String)).not.toContain('7')
    // A served that rally (it won the one before): the point keeps its server, no rotation
    await waitFor(() => expect(within(view.getByTestId('phone-court-left')).getByTestId('phone-serve-ball')).toBeTruthy())
    expect(view.getByTestId('phone-server-number').textContent).toBe('#1')
  }, 90000)
})
