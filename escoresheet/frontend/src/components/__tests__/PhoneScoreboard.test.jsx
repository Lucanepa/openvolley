// The phone layout of the scoring screen (PhoneScoreboard): at phone width
// (390x844, portrait) the Scoreboard shows it instead of the desktop body,
// and its buttons drive the screen's own handlers and dialogs. Point, time-out,
// substitution and undo are taken through it here, and land in the database
// as the desktop buttons write them. A landscape screen keeps the desktop body.
//
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with taps. Network is off: no relay socket, no fetch.
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

describe('Scoreboard: the phone layout', () => {
  it('a landscape screen keeps the desktop body (no phone layout)', async () => {
    setViewport(1280, 800)
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
    expect(phone()).toBeNull()
    expect(document.querySelector('.rally-controls')).toBeTruthy()
  })

  it('at 390x844 drives point, time-out, substitution and undo through the phone view', async () => {
    setViewport(390, 844)
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    // the desktop body is not there
    expect(document.querySelector('.rally-controls')).toBeNull()
    const view = within(phone())
    await waitFor(() => expect(view.getByTestId('phone-score-left').textContent).toBe('1'))
    expect(view.getByTestId('phone-score-right').textContent).toBe('1')
    // the ball next to the server: B won the last rally (right)
    expect(within(view.getByTestId('phone-court-right')).getByTestId('phone-serve-ball')).toBeTruthy()
    expect(within(view.getByTestId('phone-court-left')).queryByTestId('phone-serve-ball')).toBeNull()
    // the serve pill names the server: B's player in position I
    expect(view.getAllByTestId('phone-server-number')).toHaveLength(1)
    expect(view.getByTestId('phone-server-number').textContent).toBe('#1')
    expect(view.getByTestId('phone-serve-pill').getAttribute('aria-label')).toBe('Serve #1')
    // the last actions: the newest point first, the teams as their letters
    // (a team name pushed the rest of the line out, 2026-10-20)
    expect(view.getByTestId('phone-recent').firstChild.textContent).toBe('Point B · Set 1 · A 1:1 B')
    expect(view.getByTestId('phone-recent').textContent).not.toMatch(/Away VC|Home VC/)
    await settle()

    // ---- rally: Start rally, then the point buttons (as the desktop) ----
    expect(view.queryByRole('button', { name: 'Point A' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Start rally' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Point A' })).toBeTruthy())
    await settle()
    // square, as wide as their column; lower (not narrower) on a short screen (styles.css)
    expect(view.getByRole('button', { name: 'Point A' }).classList.contains('phone-square')).toBe(true)
    // "Point A", no "+1"
    expect(view.getByRole('button', { name: 'Point A' }).textContent).toBe('Point A')
    expect(view.getByRole('button', { name: 'Point B' }).classList.contains('phone-square')).toBe(true)
    fireEvent.click(view.getByRole('button', { name: 'Point A' }))
    await waitFor(async () => expect((await ofType('point')).length).toBe(3))
    const lastPoint = (await ofType('point')).at(-1)
    expect(lastPoint.payload.team).toBe('home')
    await waitFor(() => expect(view.getByTestId('phone-score-left').textContent).toBe('2'))
    // side-out: A rotates, its new server is the player from position II
    await waitFor(() => expect(view.getByTestId('phone-server-number').textContent).toBe('#2'))
    await waitFor(() => expect(view.getByRole('button', { name: 'Start rally' })).toBeTruthy())
    await settle()

    // ---- time-out A: the screen's own request dialog, then its countdown ----
    fireEvent.click(view.getByTestId('phone-timeout-left'))
    await waitFor(() => expect(button('Confirm time-out')).toBeTruthy())
    await settle()
    fireEvent.click(button('Confirm time-out'))
    await waitFor(async () => expect((await ofType('timeout')).length).toBe(1))
    expect((await ofType('timeout'))[0].payload.team).toBe('home')
    await waitFor(() => expect(view.getByTestId('phone-countdown')).toBeTruthy())
    // only the count taken, no "/2"
    expect(count('phone-timeout-left')).toBe('1')
    // as on the desktop, the counters stay open while the time-out runs
    // (a consecutive time-out, a substitution right after it)
    expect(view.getByTestId('phone-timeout-right').disabled).toBe(false)
    expect(view.getByTestId('phone-sub-right').disabled).toBe(false)
    expect(view.getByTestId('phone-action-libero').disabled).toBe(false)
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Stop timeout' }))
    await waitFor(() => expect(view.queryByTestId('phone-countdown')).toBeNull())
    await settle()

    // ---- substitution B: out (on court), in (bench), the screen's confirmation ----
    fireEvent.click(view.getByTestId('phone-sub-right'))
    await waitFor(() => expect(screen.getByTestId('phone-sub-sheet')).toBeTruthy())
    fireEvent.click(screen.getByTestId('phone-sub-out-3'))
    await waitFor(() => expect(screen.getByTestId('phone-sub-in-7')).toBeTruthy())
    fireEvent.click(screen.getByTestId('phone-sub-in-7'))
    await waitFor(() => expect(screen.queryByTestId('phone-sub-sheet')).toBeNull())
    await waitFor(() => expect(button('Yes')).toBeTruthy())
    await settle()
    fireEvent.click(button('Yes'))
    await waitFor(async () => expect((await ofType('substitution')).length).toBe(1))
    const sub = (await ofType('substitution'))[0].payload
    expect(sub.team).toBe('away')
    expect(String(sub.playerOut)).toBe('3')
    expect(String(sub.playerIn)).toBe('7')
    await waitFor(() => expect(count('phone-sub-right')).toBe('1'))
    await settle()

    // ---- undo: the screen's undo confirmation takes the substitution back ----
    fireEvent.click(view.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(button('Yes')).toBeTruthy())
    await settle()
    fireEvent.click(button('Yes'))
    await waitFor(async () => expect((await ofType('substitution')).length).toBe(0))
    await waitFor(() => expect(count('phone-sub-right')).toBe('0'))
  }, 60000)

  // 2026-10-20: the phone court showed the libero in the team colour, like
  // any player (the desktop court's disc paint was never used there); then
  // as a filled disc, which the owner found too heavy: now a plain number in
  // the libero's colour with a small L at its foot
  it("shows the libero on court in its own colour, marked L", async () => {
    setViewport(390, 844)
    const matchId = await setUpMatch()
    const away = (await db.matches.get(matchId)).awayTeamId
    const libero = await db.players.where({ teamId: away, number: 8 }).first()
    await db.players.update(libero.id, { libero: 'libero1' })
    const t = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    await db.events.add({ matchId, setIndex: 1, type: 'libero_entry', payload: { team: 'away', position: 'V', playerOut: 5, liberoIn: 8, liberoType: 'libero1' }, seq: 20, ts: t })
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: { I: '1', II: '2', III: '3', IV: '4', V: '8', VI: '6' }, liberoSubstitution: { position: 'V', liberoNumber: 8, playerNumber: 5, liberoType: 'libero1' } }, seq: 20.1, ts: t })
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    const number = await waitFor(() => within(phone()).getByTestId('phone-libero-right'))
    expect(number.textContent).toBe('8L')
    expect(within(number).getByTestId('phone-mark-libero').textContent).toBe('L')
    // no disc any more
    expect(number.style.background).toBe('')
    // not the team's blue: the libero's own shirt, picked against both teams
    // and the court, shaded where it would not read on the court floor
    const { liberoPair, teamTextPaint, COURT_SURFACE } = await import('../../utils/teamColours')
    const hex = teamTextPaint(liberoPair('#dc2626', '#2563eb').away, COURT_SURFACE).color
    const rgb = `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`
    expect(number.style.color).toBe(rgb)
    expect(within(phone()).queryByTestId('phone-libero-left')).toBeNull()
  }, 60000)

  // The paper sheet's marks on the phone court: the captain's number circled
  // (team captain on court, or the acting game captain), the replaced player's
  // number at a substitute's foot; the counters red at the limit, amber at
  // the 5th substitution
  it('marks the captain and the substitutes, and colours the counters near the limit', async () => {
    setViewport(390, 844)
    const matchId = await setUpMatch()
    const match = await db.matches.get(matchId)
    // home: player 2 is the team captain (on court); away: captain 9 on the bench, 4 acting
    const cap = await db.players.where({ teamId: match.homeTeamId, number: 2 }).first()
    await db.players.update(cap.id, { isCaptain: true })
    const awayCap = await db.players.where({ teamId: match.awayTeamId, number: 9 }).first()
    await db.players.update(awayCap.id, { isCaptain: true })
    await db.matches.update(matchId, { awayCourtCaptain: 4 })
    const t = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    // home: five substitutions (#7 in for #3 among them), two time-outs
    const subs = [[3, 7], [4, 8], [5, 9], [7, 3], [8, 4]]
    let seq = 30
    for (const [out, inn] of subs) {
      await db.events.add({ matchId, setIndex: 1, type: 'substitution', payload: { team: 'home', playerOut: out, playerIn: inn, position: 'III' }, seq: seq++, ts: t })
    }
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { I: '1', II: '2', III: '3', IV: '4', V: '9', VI: '6' }, fromSubstitution: true }, seq: seq++, ts: t })
    for (let i = 0; i < 2; i++) await db.events.add({ matchId, setIndex: 1, type: 'timeout', payload: { team: 'home' }, seq: seq++, ts: t })
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    const left = within(phone()).getByTestId('phone-court-left')
    const right = within(phone()).getByTestId('phone-court-right')
    // the team captain on court: a thin ring in the number's colour, no "C"
    await waitFor(() => expect(within(left).getAllByTestId('phone-mark-captain')).toHaveLength(1))
    const ring = within(left).getByTestId('phone-mark-captain')
    expect(ring.parentElement.firstChild.textContent).toBe('2')
    expect(ring.textContent).toBe('')
    expect(ring.style.borderStyle).toBe('solid')
    expect(ring.style.borderWidth).toBe('2px')
    expect(ring.style.borderColor).toBe(ring.parentElement.style.color)
    expect(ring.style.background).toBe('')
    expect(left.querySelector('[data-court-cell="II"]').getAttribute('aria-label')).toMatch(/captain/)
    // #9 came in for #5 (#3 and #4 came back): only that one is marked
    const replaced = within(left).getAllByTestId('phone-mark-replaced')
    expect(replaced).toHaveLength(1)
    expect(replaced[0].textContent).toBe('5')
    expect(replaced[0].parentElement.firstChild.textContent).toBe('9')
    expect(left.querySelector('[data-court-cell="V"]').getAttribute('aria-label')).toMatch(/in for 5/)
    // the acting game captain of the other team
    expect(within(right).getByTestId('phone-mark-captain').parentElement.firstChild.textContent).toBe('4')
    // counters: only the number; red at 2 time-outs, amber at the 5th substitution
    expect(count('phone-timeout-left')).toBe('2')
    expect(screen.getByTestId('phone-timeout-left').lastChild.dataset.countState).toBe('max')
    expect(count('phone-sub-left')).toBe('5')
    expect(screen.getByTestId('phone-sub-left').lastChild.dataset.countState).toBe('warn')
    expect(screen.getByTestId('phone-timeout-right').lastChild.dataset.countState).toBeUndefined()
  }, 60000)

  // An easy match plays without line-ups when it likes (domain/easyMatch.js)
  it('easy match: the set starts without line-ups, an official match waits for them', async () => {
    setViewport(390, 844)
    const setUp = async (easy) => {
      await Promise.all(db.tables.map(t => t.clear()))
      const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM', color: '#dc2626' })
      const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY', color: '#2563eb' })
      const matchId = await db.matches.add({
        homeTeamId: home, awayTeamId: away, status: 'live', test: easy, ...(easy ? { easy: true } : {}), bestOf: 5,
        firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away'
      })
      const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
      await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
      await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t })
      return matchId
    }
    const startSet = () => within(phone()).getByRole('button', { name: 'Start set' })

    mount(await setUp(true))
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(startSet().disabled).toBe(false))
    expect(within(phone()).getAllByText(/· optional$/).length).toBe(2)
    cleanup()

    mount(await setUp(false))
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(startSet().disabled).toBe(true))
  }, 60000)

  // An easy match has no bench or officials: the sanction goes to the team
  it('easy match: a warning and a penalty for the team, no person picked', async () => {
    setViewport(390, 844)
    const matchId = await setUpMatch()
    await db.matches.update(matchId, { test: true, easy: true })
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
    const view = within(phone())
    await waitFor(() => expect(view.getByTestId('phone-score-left').textContent).toBe('1'))
    await settle()

    fireEvent.click(view.getByTestId('phone-action-sanction'))
    await waitFor(() => expect(screen.getByTestId('phone-team-warning-left')).toBeTruthy())
    expect(screen.getAllByText('Or one player').length).toBe(2)
    fireEvent.click(screen.getByTestId('phone-team-warning-left'))
    await waitFor(() => expect(button('Confirm')).toBeTruthy())
    expect(screen.getByText('The team')).toBeTruthy()
    await settle()
    fireEvent.click(button('Confirm'))
    await waitFor(async () => expect((await ofType('sanction')).length).toBe(1))
    expect((await ofType('sanction'))[0].payload).toMatchObject({ team: 'home', type: 'warning', playerType: 'team' })
    await settle()

    // one formal warning per team: now a penalty, a point for the other team
    fireEvent.click(view.getByTestId('phone-action-sanction'))
    await waitFor(() => expect(screen.getByTestId('phone-team-warning-left').disabled).toBe(true))
    fireEvent.click(screen.getByTestId('phone-team-penalty-left'))
    await waitFor(() => expect(button('Confirm')).toBeTruthy())
    await settle()
    fireEvent.click(button('Confirm'))
    await waitFor(async () => expect((await ofType('sanction')).length).toBe(2))
    expect((await ofType('sanction'))[1].payload).toMatchObject({ team: 'home', type: 'penalty', playerType: 'team' })
    await waitFor(() => expect(view.getByTestId('phone-score-right').textContent).toBe('2'))
  }, 60000)

  it('a phone turned sideways keeps the phone layout, its dialogs and countdown, under a notice', async () => {
    const screenSize = { width: window.screen.width, height: window.screen.height }
    Object.defineProperty(window.screen, 'width', { value: 390, configurable: true })
    Object.defineProperty(window.screen, 'height', { value: 844, configurable: true })
    try {
      setViewport(390, 844)
      const matchId = await setUpMatch()
      mount(matchId)
      await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
      const view = within(phone())
      await waitFor(() => expect(view.getByTestId('phone-score-left').textContent).toBe('1'))
      await settle()
      // a running time-out (the screen's own state)
      fireEvent.click(view.getByTestId('phone-timeout-left'))
      await waitFor(() => expect(button('Confirm time-out')).toBeTruthy())
      await settle()
      fireEvent.click(button('Confirm time-out'))
      await waitFor(() => expect(view.getByTestId('phone-countdown')).toBeTruthy())
      const scoreboardRoot = document.querySelector('.match-record')

      // turned sideways: same screen (not remounted), the notice over it
      setViewport(844, 390)
      fireEvent(window, new Event('resize'))
      await waitFor(() => expect(screen.getByTestId('phone-sideways-notice')).toBeTruthy())
      expect(phone()).toBeTruthy()
      expect(document.querySelector('.match-record')).toBe(scoreboardRoot)
      expect(document.querySelector('.rally-controls')).toBeNull()
      // no "enable tablet mode" banner on a phone
      expect(screen.queryByText(/Small screen detected/)).toBeNull()
      expect(screen.getByTestId('phone-countdown')).toBeTruthy()

      // upright again: the notice goes, the countdown is still running
      setViewport(390, 844)
      fireEvent(window, new Event('resize'))
      await waitFor(() => expect(screen.queryByTestId('phone-sideways-notice')).toBeNull())
      expect(screen.getByTestId('phone-countdown')).toBeTruthy()
      expect(document.querySelector('.match-record')).toBe(scoreboardRoot)
    } finally {
      Object.defineProperty(window.screen, 'width', { value: screenSize.width, configurable: true })
      Object.defineProperty(window.screen, 'height', { value: screenSize.height, configurable: true })
    }
  })

  it('the Phone display mode shows the phone layout on a landscape screen too', async () => {
    setViewport(1280, 800)
    localStorage.setItem('displayMode', 'phone')
    const matchId = await setUpMatch()
    mount(matchId)
    await waitFor(() => expect(phone()).toBeTruthy(), { timeout: 10000 })
  })
})
