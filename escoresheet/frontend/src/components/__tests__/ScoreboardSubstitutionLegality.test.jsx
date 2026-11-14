// Every substitution the scorer records passes the same legality rule
// (domain/interruptionRequests substitutionIllegalReason, FIVB 15.5-15.8,
// 19.3.1.3), whichever screen asks for it:
//  - an injured or expelled starter who already went out and came back can
//    no longer be substituted regularly: the exceptional substitution (15.7,
//    15.8), not his old substitute as one of the 6;
//  - a bench player dropped with the mouse on the court libero is no
//    substitution of the libero;
//  - the exceptional substitution does not offer the player the libero on
//    court replaced;
//  - a bench request card's pair goes through the court tap's checks: a
//    libero or a starter with a completed cycle does not go off.
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), at tablet width. Network is off: no relay socket, no fetch;
// the relay's listener is captured to hand over bench requests.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { scorerRelay } from '../../utils/relayPublisher'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// As in ScoreboardInterruptionFlows.test.jsx: under jsdom + fake-indexeddb a
// scorer action can lose Dexie's transaction zone part-way and end with
// PrematureCommitError (not in Chrome). Only that error is let through.
const isEnvPrematureCommit = (reason) => reason?.name === 'PrematureCommitError'
let rejectionListeners = []
const filterRejections = (reason, promise) => {
  if (isEnvPrematureCommit(reason)) return
  for (const listener of rejectionListeners) listener(reason, promise)
}

let saved
let relayListeners = []
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
  // the scoreboard's relay listener (bench requests); nothing is sent
  vi.spyOn(scorerRelay, 'listen').mockImplementation((fn) => {
    relayListeners.push(fn)
    return () => { relayListeners = relayListeners.filter(f => f !== fn) }
  })
  vi.spyOn(scorerRelay, 'send').mockImplementation(() => true)
  window.innerWidth = 1280
  window.innerHeight = 800
})
beforeEach(async () => {
  cleanup()
  relayListeners = []
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
const settle = () => wait(GHOST_CLICK_MS + 150)
const button = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type).sort((a, b) => a.seq - b.seq)
const homeLineups = async () => (await ofType('lineup')).filter(e => e.payload?.team === 'home')
const SEED = 'seed-substitution-legality'

// Set 1, home serving and winning every rally (no rotation), line-ups 1-6,
// 12 players a team, #12 the libero.
//  'cycle'   #3 out for #9 (III), a rally, #9 out and #3 back, a rally:
//            #3's cycle is complete
//  'libero'  L #12 in for #5 at V, a rally since
//  'six'     6 regular substitutions used (#7 in for #1 and back), then L #12
//            in for #5 at V, a rally since
//  'substitute' #9 in for #3 (III), L #12 in for #5 at V, a rally since
async function setUp(kind) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const players = []
  for (const teamId of [home, away]) {
    for (let n = 1; n <= 12; n++) {
      players.push({ teamId, number: n, name: `P${n}`, firstName: 'X', ...(n === 12 ? { libero: 'libero1' } : {}), ...(n === 1 ? { isCaptain: true } : {}) })
    }
  }
  await db.players.bulkAdd(players)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5, seed_key: SEED,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true
  })
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: t })
  let seq = 1
  let lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  const ev = []
  const rally = () => {
    ev.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'point', payload: { team: 'home' }, seq: seq++, ts: t })
  }
  const sub = (position, playerOut, playerIn) => {
    const at = seq++
    ev.push({ matchId, setIndex: 1, type: 'substitution', payload: { team: 'home', position, playerOut, playerIn: String(playerIn), isExceptional: false, isExpelled: false, isDisqualified: false }, seq: at, ts: t })
    lineup = { ...lineup, [position]: String(playerIn) }
    ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, fromSubstitution: true }, seq: at + 0.1, ts: t })
  }
  const liberoIn = () => {
    const at = seq++
    ev.push({ matchId, setIndex: 1, type: 'libero_entry', payload: { team: 'home', position: 'V', playerOut: 5, liberoIn: 12, liberoType: 'libero1' }, seq: at, ts: t })
    lineup = { ...lineup, V: '12' }
    ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, liberoSubstitution: { position: 'V', liberoNumber: 12, playerNumber: 5, liberoType: 'libero1' } }, seq: at + 0.1, ts: t })
  }
  ev.push({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  for (const team of ['home', 'away']) ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  rally()
  if (kind === 'cycle') {
    sub('III', 3, 9)
    rally()
    sub('III', 9, 3)
    rally()
  }
  if (kind === 'libero') {
    liberoIn()
    rally()
  }
  if (kind === 'substitute') {
    sub('III', 3, 9)
    liberoIn()
    rally()
  }
  if (kind === 'six') {
    for (const [pos, out, inn] of [['I', 1, 7], ['II', 2, 8], ['III', 3, 9], ['IV', 4, 10], ['VI', 6, 11]]) sub(pos, out, inn)
    rally()
    sub('I', 7, 1)
    liberoIn()
    rally()
  }
  await db.events.bulkAdd(ev)
  await db.sets.where({ matchId, index: 1 }).modify({ homePoints: ev.filter(e => e.type === 'point').length, awayPoints: 0 })
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const court = (n) => document.querySelector(`.court-player[data-team="home"][data-player-number="${n}"]`)
const bench = (n) => document.querySelector(`[data-bench-player="${n}"][data-team="home"][data-is-libero="false"]`)
const playerMenu = () => document.querySelector('[data-player-action-menu]')
const menuItems = () => [...playerMenu().querySelectorAll('button')].map(b => b.textContent.trim())
const dropdown = () => document.querySelector('[data-substitution-dropdown]')
// the players offered (not "Cancel sanction")
const dropdownOptions = () => [...dropdown().querySelectorAll('button')].map(b => b.textContent.replace(/\s/g, '')).filter(text => text.startsWith('#'))
const confirmDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(d => button('Yes', d))
const exceptionalChoice = () => [...document.querySelectorAll('button')].find(b => /^Exceptional substitution/i.test(b.textContent.trim()))

async function openScreen(matchId, courtNumber) {
  mount(matchId)
  await waitFor(() => expect(court(courtNumber)).toBeTruthy(), { timeout: 10000 })
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
  await settle()
}

async function confirmYes(count) {
  await waitFor(() => expect(confirmDialog()).toBeTruthy(), { timeout: 3000 })
  await settle()
  fireEvent.click(button('Yes', confirmDialog()))
  await waitFor(async () => expect(await ofType('substitution')).toHaveLength(count), { timeout: 5000 })
  return (await ofType('substitution')).at(-1).payload
}

// The exceptional substitution's list, from "No legal substitution" (15.7)
async function openExceptionalList() {
  await waitFor(() => expect(exceptionalChoice()).toBeTruthy(), { timeout: 3000 })
  // no regular substitution was proposed on the way
  expect(confirmDialog()).toBeFalsy()
  await settle()
  fireEvent.click(exceptionalChoice())
  await waitFor(() => expect(dropdown()).toBeTruthy(), { timeout: 3000 })
  return dropdownOptions()
}

describe('the court player\'s menu (FIVB 15.6.2, 19.3.1.3)', () => {
  it('a substitute goes out only for the starter he replaced; the others are "Not allowed" with why', async () => {
    const matchId = await setUp('substitute')
    await openScreen(matchId, 9)
    fireEvent.click(court(9))
    await waitFor(() => expect(playerMenu()).toBeTruthy())
    fireEvent.click(screen.getByTestId('menu-illegal-toggle'))
    await waitFor(() => expect(screen.getByTestId('menu-illegal-5')).toBeTruthy())
    const why = (n) => screen.getByTestId(`menu-illegal-${n}`).textContent.replace(/\s+/g, ' ').trim()
    expect([7, 8, 10, 11].map(why)).toEqual(['7 · Wrong partner', '8 · Wrong partner', '10 · Wrong partner', '11 · Wrong partner'])
    // #5 is off the court for the libero, not a substitute (FIVB 15.7)
    expect(why(5)).toBe('5 · Libero in for him')
    fireEvent.click(screen.getByTestId('menu-illegal-5'))
    const warning = await waitFor(() => screen.getByTestId('request-warning'))
    expect(warning.getAttribute('data-reason')).toBe('illegal_substitution')
    expect(warning.textContent).toContain('#5 cannot come in for #9: the libero is on court for him')
    expect(await ofType('substitution')).toHaveLength(1)
  }, 60000)

  it('the starter back for his substitute is recorded, one of the 6', async () => {
    const matchId = await setUp('substitute')
    await openScreen(matchId, 9)
    fireEvent.click(court(9))
    await waitFor(() => expect(playerMenu()).toBeTruthy())
    // one legal substitute: the confirmation straight away
    fireEvent.click(button('Substitution', playerMenu()))
    const written = await confirmYes(2)
    expect(String(written.playerOut)).toBe('9')
    expect(String(written.playerIn)).toBe('3')
    expect(written.isExceptional).toBe(false)
    expect((await homeLineups()).at(-1).payload.lineup).toMatchObject({ III: '3', V: '12' })
  }, 60000)
})

describe('injury or expulsion of a starter whose cycle is complete (FIVB 15.6.2, 15.7, 15.8)', () => {
  it('Injury: no regular substitution, the exceptional one (any bench player but the libero), counted beyond the 6', async () => {
    const matchId = await setUp('cycle')
    await openScreen(matchId, 3)
    fireEvent.click(court(3))
    await waitFor(() => expect(playerMenu()).toBeTruthy())
    // the court menu offers no Substitution for him (as before)
    expect(menuItems()).toEqual(['Sanction', 'Injury'])
    fireEvent.click(button('Injury', playerMenu()))

    // #9 came in and went out for #3: he may come in exceptionally, not as
    // a regular substitution for #3
    expect(await openExceptionalList()).toEqual(['#7', '#8', '#9', '#10', '#11'])
    fireEvent.click([...dropdown().querySelectorAll('button')].find(b => b.textContent.replace(/\s/g, '') === '#10'))
    const written = await confirmYes(3)
    expect(String(written.playerOut)).toBe('3')
    expect(String(written.playerIn)).toBe('10')
    expect(written.isExceptional).toBe(true)
  }, 60000)

  it('Expulsion: the same, flagged expelled and exceptional', async () => {
    const matchId = await setUp('cycle')
    await openScreen(matchId, 3)
    fireEvent.click(court(3))
    await waitFor(() => expect(playerMenu()).toBeTruthy())
    fireEvent.click(button('Sanction', playerMenu()))
    await waitFor(() => expect([...playerMenu().querySelectorAll('button')].some(b => /expul/i.test(b.textContent))).toBe(true))
    fireEvent.click([...playerMenu().querySelectorAll('button')].find(b => /expul/i.test(b.textContent)))
    await settle()
    const sanctionYes = [...document.querySelectorAll('[role="dialog"] button')].find(b => /^(confirm|yes)/i.test(b.textContent.trim()) && !b.disabled)
    fireEvent.click(sanctionYes)
    await waitFor(async () => expect(await ofType('sanction')).toHaveLength(1), { timeout: 5000 })

    expect(await openExceptionalList()).toEqual(['#7', '#8', '#9', '#10', '#11'])
    fireEvent.click([...dropdown().querySelectorAll('button')].find(b => b.textContent.replace(/\s/g, '') === '#9'))
    const written = await confirmYes(3)
    expect(String(written.playerOut)).toBe('3')
    expect(String(written.playerIn)).toBe('9')
    expect(written).toMatchObject({ isExpelled: true, isExceptional: true })
  }, 60000)
})

describe('mouse drag and drop on the court libero (FIVB 19.3.1.3)', () => {
  const dataTransfer = () => {
    const store = {}
    return { setData: (k, v) => { store[k] = v }, getData: (k) => store[k], setDragImage: () => {}, effectAllowed: 'all', dropEffect: 'none', types: [] }
  }
  const drag = async (benchNumber, courtNumber) => {
    const dt = dataTransfer()
    fireEvent.dragStart(bench(benchNumber), { dataTransfer: dt })
    await wait(200)
    const accepted = !fireEvent.dragOver(court(courtNumber), { dataTransfer: dt })
    fireEvent.drop(court(courtNumber), { dataTransfer: dt })
    return accepted
  }

  it('a bench player other than the one the libero replaced: the disc refuses the drop, nothing is recorded', async () => {
    const matchId = await setUp('libero')
    await openScreen(matchId, 12)
    expect(await drag(9, 12)).toBe(false)
    await settle()
    expect(confirmDialog()).toBeFalsy()
    expect(await ofType('substitution')).toHaveLength(0)
    expect((await homeLineups()).at(-1).payload.lineup.V).toBe('12')
  }, 60000)

  it('the player the libero replaced, dropped on it, still takes the libero out (no substitution)', async () => {
    const matchId = await setUp('libero')
    await openScreen(matchId, 12)
    expect(await drag(5, 12)).toBe(true)
    // the libero replacement's own confirmation
    await waitFor(() => expect(button('Confirm')).toBeTruthy(), { timeout: 3000 })
    expect(confirmDialog()).toBeFalsy()
    await settle()
    fireEvent.click(button('Confirm'))
    await waitFor(async () => expect(await ofType('libero_exit')).toHaveLength(1), { timeout: 5000 })
    expect((await ofType('libero_exit'))[0].payload).toMatchObject({ team: 'home', liberoOut: 12 })
    expect((await homeLineups()).at(-1).payload.lineup.V).toBe('5')
    expect(await ofType('substitution')).toHaveLength(0)
  }, 60000)

  it('a legal drop on a court player still opens the substitution: #9 in for #4', async () => {
    const matchId = await setUp('libero')
    await openScreen(matchId, 4)
    expect(await drag(9, 4)).toBe(true)
    const written = await confirmYes(1)
    expect(String(written.playerOut)).toBe('4')
    expect(String(written.playerIn)).toBe('9')
    expect(written.isExceptional).toBe(false)
  }, 60000)
})

describe('the exceptional substitution and the libero on court (FIVB 15.7)', () => {
  it('does not offer the player the libero replaced', async () => {
    const matchId = await setUp('six')
    await openScreen(matchId, 8)
    fireEvent.click(court(8))
    await waitFor(() => expect(playerMenu()).toBeTruthy())
    fireEvent.click(button('Injury', playerMenu()))
    // #5 is replaced by L #12 at V; #7 played out but may come in exceptionally
    expect(await openExceptionalList()).toEqual(['#2', '#3', '#4', '#6', '#7'])
    fireEvent.click([...dropdown().querySelectorAll('button')].find(b => b.textContent.replace(/\s/g, '') === '#7'))
    const written = await confirmYes(7)
    expect(String(written.playerOut)).toBe('8')
    expect(String(written.playerIn)).toBe('7')
    expect(written.isExceptional).toBe(true)
    const last = (await homeLineups()).at(-1).payload
    expect(last.lineup.V).toBe('12')
    expect(last.liberoSubstitution).toMatchObject({ liberoNumber: 12, playerNumber: 5 })
  }, 60000)
})

describe('a bench request card goes through the court tap\'s checks (FIVB 15.6.2, 16.1.3, 19.3.1.3)', () => {
  const sendBenchPair = async (kind, pair) => {
    await waitFor(() => expect(relayListeners.length).toBeGreaterThan(0), { timeout: 5000 })
    for (const fn of relayListeners) fn({ type: 'bench-request', matchId: SEED, team: 'home', status: 'pending', at: Date.now(), request: { id: `br-test-${kind}`, kind: 'substitution', setIndex: 1, pairs: [pair] } })
    await waitFor(() => expect(document.querySelector('[data-bench-pair-accept="0"]')).toBeTruthy(), { timeout: 3000 })
    await settle()
    fireEvent.click(document.querySelector('[data-bench-pair-accept="0"]'))
    return waitFor(() => screen.getByTestId('request-warning'), { timeout: 3000 })
  }

  it('the libero on court does not go off by a substitution: the illegal-substitution warning, nothing recorded', async () => {
    const matchId = await setUp('libero')
    await openScreen(matchId, 12)
    const warning = await sendBenchPair('libero', { out: 12, in: 9 })
    expect(warning.getAttribute('data-reason')).toBe('illegal_substitution')
    expect(warning.textContent).toContain('#9 cannot come in for #12')
    expect(confirmDialog()).toBeFalsy()
    expect(await ofType('substitution')).toHaveLength(0)
  }, 60000)

  it('a starter whose cycle is complete does not go off for his old substitute', async () => {
    const matchId = await setUp('cycle')
    await openScreen(matchId, 3)
    const warning = await sendBenchPair('cycle', { out: 3, in: 9 })
    expect(warning.getAttribute('data-reason')).toBe('illegal_substitution')
    expect(warning.textContent).toContain('#9 cannot come in for #3')
    expect(await ofType('substitution')).toHaveLength(2)
  }, 60000)

  it('a legal pair is still recorded through the card: #9 in for #4', async () => {
    const matchId = await setUp('libero')
    await openScreen(matchId, 4)
    await waitFor(() => expect(relayListeners.length).toBeGreaterThan(0), { timeout: 5000 })
    for (const fn of relayListeners) fn({ type: 'bench-request', matchId: SEED, team: 'home', status: 'pending', at: Date.now(), request: { id: 'br-test-legal', kind: 'substitution', setIndex: 1, pairs: [{ out: 4, in: 9 }] } })
    await waitFor(() => expect(document.querySelector('[data-bench-pair-accept="0"]')).toBeTruthy(), { timeout: 3000 })
    await settle()
    fireEvent.click(document.querySelector('[data-bench-pair-accept="0"]'))
    const written = await confirmYes(1)
    expect(String(written.playerOut)).toBe('4')
    expect(String(written.playerIn)).toBe('9')
  }, 60000)
})
