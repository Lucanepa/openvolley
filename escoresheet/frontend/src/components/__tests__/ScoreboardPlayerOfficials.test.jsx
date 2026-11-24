// A player who is also a bench official (a playing coach, owner 2026-11-22,
// domain/playerOfficials) on the scoring screen:
//  - while he is on court, the official's chip is greyed (not tappable,
//    "On court as #3"); a substitution brings him back on court as the player;
//  - while he is on the bench, his number on the bench row is greyed: its
//    menu offers the substitution only, his sanctions go to the official's
//    chip; the team captain's circled number carries no "C" beside it (owner
//    23.11.2026: "if the number is circled, no need to write C"), another
//    role keeps its tag; also while the libero is in his place (owner 2026-11-22: "coach
//    is not on court, so it is a coach not a player"), and the libero out
//    makes him the player again; sent off as the coach then, #7 is
//    substituted for the libero's return (FIVB Casebook);
//  - the sanctions count for the person: a penalty as #7, then the coach gets
//    no penalty, his expulsion records #7 (plays) and keeps #7 off the court;
//  - the scorer's choice ("Plays as", plays: number / false) beats the
//    automatic link;
//  - the phone's sanction picker greys the same chips.
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB). Network is off: no relay socket, no fetch.
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

// As in ScoreboardSanctionsLibero.test.jsx: under jsdom + fake-indexeddb a
// scorer action can lose Dexie's transaction zone part-way and end with
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
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(scorerRelay, 'listen').mockImplementation(() => () => {})
  vi.spyOn(scorerRelay, 'send').mockImplementation(() => true)
})
beforeEach(async () => {
  cleanup()
  window.innerWidth = 1280
  window.innerHeight = 800
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
const court = (n, team = 'home') => document.querySelector(`.court-player[data-team="${team}"][data-player-number="${n}"]`)
const benchPlayer = (n, team = 'home') => document.querySelector(`[data-bench-player="${n}"][data-team="${team}"][data-is-libero="false"]`)
const official = (role) => document.querySelector(`[data-bench-official="${role}"]`)
const sanctionMenu = () => document.querySelector('[data-sanction-dropdown]')
const benchMenu = () => document.querySelector('[data-bench-player-action-menu]')
const sanctionYes = () => [...document.querySelectorAll('[role="dialog"] button')].find(b => /^(confirm|yes)/i.test(b.textContent.trim()) && !b.disabled)

// Erik Fischer, licence 100544: #7 of the home team and its coach
const ROSTER = [
  [1, 'Luca', 'Keller', '100211'], [2, 'Jonas', 'Hofmann', '100396'], [3, 'Noah', 'Schmid', '100433'],
  [4, 'Felix', 'Graf', '100470'], [5, 'David', 'Brunner', '100507'], [6, 'Ben', 'Wenger', '100581'],
  [7, 'Erik', 'Fischer', '100544'], [8, 'Lukas', 'Bachmann', '100618'], [9, 'Alex', 'Baumann', '100655'],
  [12, 'Mauro', 'Huber', '100729']
]
const COACH = { role: 'Coach', firstName: 'Erik', lastName: 'Fischer', dob: '100544' }

// Set 1, home serving and winning every rally, line-ups 1-6 for both teams.
// `before(add)` adds events after the line-ups and the first rally.
async function setUp({ bench = [COACH], roster = ROSTER, before = () => {} } = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const rows = []
  for (const teamId of [home, away]) {
    for (const [n, firstName, lastName, dob] of roster) {
      rows.push({ teamId, number: n, name: `${lastName} ${firstName}`, firstName, lastName: teamId === home ? lastName : `${lastName}-A`, dob: teamId === home ? dob : `9${dob}`, ...(n === 1 ? { isCaptain: true } : {}), ...(n === 12 ? { libero: 'libero1' } : {}) })
    }
  }
  await db.players.bulkAdd(rows)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
    bench_home: bench
  })
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  let seq = 1
  const ev = []
  const lineups = { home: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }, away: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' } }
  const add = {
    rally() {
      ev.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
      ev.push({ matchId, setIndex: 1, type: 'point', payload: { team: 'home' }, seq: seq++, ts: t })
    },
    event(type, payload) {
      ev.push({ matchId, setIndex: 1, type, payload, seq: seq++, ts: t })
    },
    liberoIn(position, playerOut, libero = 12, team = 'home') {
      const at = seq++
      ev.push({ matchId, setIndex: 1, type: 'libero_entry', payload: { team, position, playerOut, liberoIn: libero, liberoType: 'libero1' }, seq: at, ts: t })
      lineups[team] = { ...lineups[team], [position]: String(libero) }
      ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup: lineups[team], liberoSubstitution: { position, liberoNumber: libero, playerNumber: playerOut, liberoType: 'libero1' } }, seq: at + 0.1, ts: t })
    },
    sub(position, playerOut, playerIn, team = 'home') {
      const at = seq++
      ev.push({ matchId, setIndex: 1, type: 'substitution', payload: { team, position, playerOut, playerIn: String(playerIn), isExceptional: false, isExpelled: false, isDisqualified: false }, seq: at, ts: t })
      lineups[team] = { ...lineups[team], [position]: String(playerIn) }
      ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup: lineups[team], fromSubstitution: true }, seq: at + 0.1, ts: t })
    }
  }
  ev.push({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: t })
  for (const team of ['home', 'away']) ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup: lineups[team], isInitial: true }, seq: seq++, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  add.rally()
  before(add)
  await db.events.bulkAdd(ev)
  const points = ev.filter(e => e.type === 'point').length
  await db.sets.where({ matchId, index: 1 }).modify({ homePoints: points, awayPoints: 0 })
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

async function openScreen(matchId) {
  mount(matchId)
  await waitFor(() => expect(court(1)).toBeTruthy(), { timeout: 10000 })
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
  await settle()
}

describe('a playing coach on court: the coach\'s chip is greyed', () => {
  it('C is greyed and not tappable ("On court as #3"), #3 takes his sanctions', async () => {
    // the coach is #3, on court (same licence)
    const matchId = await setUp({ bench: [{ role: 'Coach', firstName: 'Noah', lastName: 'Schmid', dob: '100433' }] })
    await openScreen(matchId)
    const chip = official('Coach')
    expect(chip.getAttribute('data-plays-as')).toBe('3')
    expect(chip.getAttribute('data-on-court-as')).toBe('3')
    expect(chip.getAttribute('aria-disabled')).toBe('true')
    expect(chip.getAttribute('title')).toContain('On court as #3')
    expect(chip.querySelector('[data-plays-as-tag]').textContent.trim()).toBe('#3')
    fireEvent.click(chip)
    await wait(300)
    expect(sanctionMenu()).toBeFalsy()
    // no bench number of his is greyed: he is on court
    expect(document.querySelector('[data-as-official]')).toBeFalsy()
  }, 60000)

  it('substituted in, he is the player again: his chip greys', async () => {
    const matchId = await setUp({ before: (add) => { add.sub('III', 3, 7); add.rally() } })
    await openScreen(matchId)
    await waitFor(() => expect(court(7)).toBeTruthy())
    expect(official('Coach').getAttribute('data-on-court-as')).toBe('7')
    expect(benchPlayer(7)).toBeFalsy()
  }, 60000)
})

describe('a playing coach on the bench: his number is greyed', () => {
  it('#7 offers the substitution only; C takes the sanction, one person for the escalation', async () => {
    // a penalty as #7 earlier (when he played), then he went off
    const matchId = await setUp({
      before: (add) => {
        add.sub('III', 3, 7); add.rally()
        add.event('sanction', { team: 'home', type: 'penalty', playerType: 'player', playerNumber: 7, position: 'III' })
        add.rally()
        add.sub('III', 7, 3); add.rally()
      }
    })
    await openScreen(matchId)
    const chip = benchPlayer(7)
    expect(chip.getAttribute('data-as-official')).toBe('Coach')
    expect(chip.getAttribute('title')).toBe('On the bench as C')
    expect(chip.querySelector('[data-as-official-tag]').textContent.trim()).toBe('C')
    expect(official('Coach').getAttribute('data-on-court-as')).toBeNull()

    // his number's menu: no sanction, no injury, the hint
    fireEvent.click(chip)
    await waitFor(() => expect(benchMenu()).toBeTruthy(), { timeout: 3000 })
    expect(benchMenu().querySelector('[data-bench-as-official-hint]').textContent).toBe('On the bench as C. Sanctions go to C.')
    expect([...benchMenu().querySelectorAll('button')].some(b => /^Sanction/.test(b.textContent.trim()))).toBe(false)
    expect([...benchMenu().querySelectorAll('button')].some(b => /Injury/.test(b.textContent))).toBe(false)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(benchMenu()).toBeFalsy())
    await settle()

    // the coach's menu: his penalty as #7 counts, no second one
    fireEvent.click(official('Coach'))
    await waitFor(() => expect(sanctionMenu()).toBeTruthy(), { timeout: 3000 })
    const item = (re) => [...sanctionMenu().querySelectorAll('button')].find(b => re.test(b.textContent.trim()))
    expect(item(/^Penalty/).disabled).toBe(true)
    expect(item(/^Expulsion/).disabled).toBe(false)

    // the expulsion as the coach records #7, and keeps #7 off the court
    fireEvent.click(item(/^Expulsion/))
    await settle()
    fireEvent.click(sanctionYes())
    await waitFor(async () => expect(await ofType('sanction')).toHaveLength(2), { timeout: 5000 })
    expect((await ofType('sanction'))[1].payload).toMatchObject({ team: 'home', type: 'expulsion', playerType: 'official', role: 'Coach', plays: 7 })
    await waitFor(() => expect(official('Coach').querySelector('[data-person-out="expelled"]')).toBeTruthy())
    await waitFor(() => expect([...benchPlayer(7).querySelectorAll('span')].some(s => s.textContent.trim() === '✕')).toBe(true))
  }, 60000)

  it('the team captain is the coach: his number is circled and greyed, with no "C" beside it (owner 23.11.2026)', async () => {
    // #1, the team captain, is the coach (same licence); #7 came in for him
    const matchId = await setUp({
      bench: [{ role: 'Coach', firstName: 'Luca', lastName: 'Keller', dob: '100211' }],
      before: (add) => { add.sub('I', 1, 7); add.rally() }
    })
    mount(matchId)
    await waitFor(() => expect(court(7)).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(benchPlayer(1)).toBeTruthy())
    const chip = benchPlayer(1)
    expect(chip.getAttribute('data-as-official')).toBe('Coach')
    expect(chip.querySelector('[data-testid="bench-captain-ring"]')).toBeTruthy()
    expect(chip.querySelector('[data-as-official-tag]')).toBeNull()
    // the role is still named for hover and in his menu
    expect(chip.getAttribute('title')).toBe('On the bench as C')
  }, 60000)

  it('the team captain is the assistant coach: his circled number keeps "AC1"', async () => {
    const matchId = await setUp({
      bench: [{ role: 'Assistant Coach 1', firstName: 'Luca', lastName: 'Keller', dob: '100211' }],
      before: (add) => { add.sub('I', 1, 7); add.rally() }
    })
    mount(matchId)
    await waitFor(() => expect(court(7)).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(benchPlayer(1)).toBeTruthy())
    const chip = benchPlayer(1)
    expect(chip.getAttribute('data-as-official')).toBe('Assistant Coach 1')
    expect(chip.querySelector('[data-testid="bench-captain-ring"]')).toBeTruthy()
    expect(chip.querySelector('[data-as-official-tag]').textContent.trim()).toBe('AC1')
  }, 60000)

  it('the scorer\'s choice: plays false undoes the automatic link, plays 8 links another', async () => {
    const matchId = await setUp({
      bench: [{ ...COACH, plays: false }, { role: 'Assistant Coach 1', firstName: 'Jan', lastName: 'Widmer', dob: '100174', plays: 8 }]
    })
    await openScreen(matchId)
    expect(official('Coach').getAttribute('data-plays-as')).toBeNull()
    expect(benchPlayer(7).getAttribute('data-as-official')).toBeNull()
    expect(official('Assistant Coach 1').getAttribute('data-plays-as')).toBe('8')
    expect(benchPlayer(8).getAttribute('data-as-official')).toBe('Assistant Coach 1')
  }, 60000)
})

describe('the libero in his place: he is off court, the coach (owner 2026-11-22)', () => {
  // the coach is #5 (same licence), in position V: the libero replaces him
  const COACH5 = { role: 'Coach', firstName: 'David', lastName: 'Brunner', dob: '100507' }

  it('C is active and #5 greyed with "C"; the libero out makes him the player again', async () => {
    const matchId = await setUp({ bench: [COACH5], before: (add) => { add.liberoIn('V', 5); add.rally() } })
    await openScreen(matchId)
    await waitFor(() => expect(court(12)).toBeTruthy())
    expect(official('Coach').getAttribute('data-plays-as')).toBe('5')
    expect(official('Coach').getAttribute('data-on-court-as')).toBeNull()
    expect(official('Coach').getAttribute('aria-disabled')).toBeNull()
    expect(benchPlayer(5).getAttribute('data-as-official')).toBe('Coach')
    expect(benchPlayer(5).querySelector('[data-as-official-tag]').textContent.trim()).toBe('C')
    // his number's menu: no sanction, no injury
    fireEvent.click(benchPlayer(5))
    await waitFor(() => expect(benchMenu()).toBeTruthy(), { timeout: 3000 })
    expect([...benchMenu().querySelectorAll('button')].some(b => /^Sanction/.test(b.textContent.trim()))).toBe(false)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(benchMenu()).toBeFalsy())
    await settle()

    // libero out: #5 back on court, the coach's chip greys
    fireEvent.click(court(12))
    await waitFor(() => expect(document.querySelector('[data-player-action-menu]')).toBeTruthy(), { timeout: 3000 })
    const menuButton = (re) => [...document.querySelector('[data-player-action-menu]').querySelectorAll('button')].find(b => re.test(b.textContent.trim()) && !b.disabled)
    if (!menuButton(/^Libero out$/)) fireEvent.click(menuButton(/^Libero/))
    await waitFor(() => expect(menuButton(/^Libero out$/)).toBeTruthy(), { timeout: 3000 })
    fireEvent.click(menuButton(/^Libero out$/))
    await settle()
    const yes = sanctionYes()
    if (yes) fireEvent.click(yes)
    await waitFor(async () => expect(await ofType('libero_exit')).toHaveLength(1), { timeout: 5000 })
    await waitFor(() => expect(court(5)).toBeTruthy())
    await waitFor(() => expect(official('Coach').getAttribute('data-on-court-as')).toBe('5'))
    expect(benchPlayer(5)).toBeFalsy()
  }, 60000)

  it('the coach expelled while the libero is in his place: #5 is substituted, the libero stays', async () => {
    const matchId = await setUp({ bench: [COACH5], before: (add) => { add.liberoIn('V', 5); add.rally() } })
    await openScreen(matchId)
    fireEvent.click(official('Coach'))
    await waitFor(() => expect(sanctionMenu()).toBeTruthy(), { timeout: 3000 })
    fireEvent.click([...sanctionMenu().querySelectorAll('button')].find(b => /^Expulsion/.test(b.textContent.trim())))
    await settle()
    fireEvent.click(sanctionYes())
    await waitFor(async () => expect(await ofType('sanction')).toHaveLength(1), { timeout: 5000 })
    expect((await ofType('sanction'))[0].payload).toMatchObject({ type: 'expulsion', playerType: 'official', role: 'Coach', plays: 5 })
    // the substitution the Casebook asks for: #5 out, the libero stays on court
    await waitFor(() => expect([...document.querySelectorAll('[role="dialog"]')].some(d => /#5/.test(d.textContent) && /expelled/i.test(d.textContent))).toBe(true), { timeout: 5000 })
    expect([...document.querySelectorAll('[role="dialog"]')].some(d => /Libero.*#12.*remains on court/i.test(d.textContent))).toBe(true)
  }, 60000)
})

describe('the phone\'s sanction picker greys the same chips', () => {
  it('C greyed while #3 is on court, #7 greyed while he is on the bench as AC1', async () => {
    window.innerWidth = 390
    window.innerHeight = 844
    const matchId = await setUp({
      bench: [
        { role: 'Coach', firstName: 'Noah', lastName: 'Schmid', dob: '100433' },
        { role: 'Assistant Coach 1', firstName: 'Erik', lastName: 'Fischer', dob: '100544' }
      ]
    })
    mount(matchId)
    await waitFor(() => expect(screen.queryByTestId('phone-scoreboard')).toBeTruthy(), { timeout: 10000 })
    await settle()
    fireEvent.click(screen.getByTestId('phone-action-sanction'))
    await waitFor(() => expect(screen.getByTestId('phone-sanction-official-left-C')).toBeTruthy())
    expect(screen.getByTestId('phone-sanction-official-left-C').disabled).toBe(true)
    expect(screen.getByTestId('phone-sanction-official-left-AC1').disabled).toBe(false)
    expect(screen.getByTestId('phone-sanction-bench-left-7').disabled).toBe(true)
    expect(screen.getByTestId('phone-sanction-bench-left-8').disabled).toBe(false)
    expect(screen.getByTestId('phone-person-roles-left').textContent).toContain('C · On court as #3')
    expect(screen.getByTestId('phone-person-roles-left').textContent).toContain('#7 · On the bench as AC1')
  }, 60000)
})
