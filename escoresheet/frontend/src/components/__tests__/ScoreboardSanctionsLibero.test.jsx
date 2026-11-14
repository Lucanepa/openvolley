// Sanctions, forced substitutions and libero entries follow the FIVB rules on
// every path of the scoring screen:
//  - a libero expelled from the court disc is no longer offered, and the
//    other libero may replace at once (19.3.2.2, 21.3.2);
//  - an expulsion with one legal substitute has no plain Cancel: the
//    substitution list (with "Cancel sanction") comes back, and no rally
//    starts while the expelled player is on court;
//  - an expulsion of an earlier set does not make a later substitution
//    forced; an injury substitution is stored as one (isInjury);
//  - the exceptional substitution of an expelled bench player whom the libero
//    replaced is in the remarks;
//  - a team official does not get the same sanction twice;
//  - one libero entry for the court menu, the bench libero's "Replace" and the
//    libero dialog: the game captain is asked for, the chosen libero enters,
//    touch drag works on both sides.
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), at tablet width. Network is off: no relay socket, no fetch.
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
beforeAll(() => {
  rejectionListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', filterRejections)
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, width: window.innerWidth, height: window.innerHeight, elementFromPoint: document.elementFromPoint }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(scorerRelay, 'listen').mockImplementation(() => () => {})
  vi.spyOn(scorerRelay, 'send').mockImplementation(() => true)
  window.innerWidth = 1280
  window.innerHeight = 800
})
beforeEach(async () => {
  cleanup()
  localStorage.removeItem('displayMode')
  document.elementFromPoint = saved.elementFromPoint
  await Promise.all(db.tables.map(t => t.clear()))
})
afterAll(() => {
  cleanup()
  window.innerWidth = saved.width
  window.innerHeight = saved.height
  document.elementFromPoint = saved.elementFromPoint
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
const anyButton = (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text))
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type).sort((a, b) => a.seq - b.seq)
const lineupsOf = async (team) => (await ofType('lineup')).filter(e => e.payload?.team === team)
const court = (n, team = 'home') => document.querySelector(`.court-player[data-team="${team}"][data-player-number="${n}"]`)
const benchPlayer = (n, team = 'home') => document.querySelector(`[data-bench-player="${n}"][data-team="${team}"][data-is-libero="false"]`)
const benchLibero = (n, team = 'home') => document.querySelector(`[data-bench-player="${n}"][data-team="${team}"][data-is-libero="true"]`)
const playerMenu = () => document.querySelector('[data-player-action-menu]')
const dropdown = () => document.querySelector('[data-substitution-dropdown]')
const dropdownOptions = () => [...dropdown().querySelectorAll('button')].map(b => b.textContent.replace(/\s/g, '')).filter(text => text.startsWith('#'))
const confirmDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(d => button('Yes', d))
const sanctionYes = () => [...document.querySelectorAll('[role="dialog"] button')].find(b => /^(confirm|yes)/i.test(b.textContent.trim()) && !b.disabled)

// Set 1 (or set 2 with { set: 2 }), home serving and winning every rally,
// line-ups 1-6 for both teams. `players`: the shirt numbers of each team;
// `liberos`: number -> libero1 / libero2; `captain`: the team captain.
// `before(add)` adds events after the line-ups and the first rally.
async function setUp({ players = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12], liberos = { 12: 'libero1' }, captain = 1, set = 1, match = {}, before = () => {} } = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const rows = []
  for (const teamId of [home, away]) {
    for (const n of players) {
      rows.push({ teamId, number: n, name: `P${n}`, firstName: 'X', ...(liberos[n] ? { libero: liberos[n] } : {}), ...(n === captain ? { isCaptain: true } : {}) })
    }
  }
  await db.players.bulkAdd(rows)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true, ...match
  })
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  let seq = 1
  const ev = []
  const lineups = { home: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }, away: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' } }
  const add = {
    setIndex: 1,
    rally() {
      ev.push({ matchId, setIndex: this.setIndex, type: 'rally_start', payload: {}, seq: seq++, ts: t })
      ev.push({ matchId, setIndex: this.setIndex, type: 'point', payload: { team: 'home' }, seq: seq++, ts: t })
    },
    event(type, payload) {
      ev.push({ matchId, setIndex: this.setIndex, type, payload, seq: seq++, ts: t })
    },
    sub(position, playerOut, playerIn, flags = {}, team = 'home') {
      const at = seq++
      ev.push({ matchId, setIndex: this.setIndex, type: 'substitution', payload: { team, position, playerOut, playerIn: String(playerIn), isExceptional: false, isExpelled: false, isDisqualified: false, ...flags }, seq: at, ts: t })
      lineups[team] = { ...lineups[team], [position]: String(playerIn) }
      ev.push({ matchId, setIndex: this.setIndex, type: 'lineup', payload: { team, lineup: lineups[team], fromSubstitution: true }, seq: at + 0.1, ts: t })
    },
    liberoIn(position, playerOut, libero, team = 'home') {
      const at = seq++
      ev.push({ matchId, setIndex: this.setIndex, type: 'libero_entry', payload: { team, position, playerOut, liberoIn: libero, liberoType: liberos[libero] }, seq: at, ts: t })
      lineups[team] = { ...lineups[team], [position]: String(libero) }
      ev.push({ matchId, setIndex: this.setIndex, type: 'lineup', payload: { team, lineup: lineups[team], liberoSubstitution: { position, liberoNumber: libero, playerNumber: playerOut, liberoType: liberos[libero] } }, seq: at + 0.1, ts: t })
    },
    startSet(index) {
      this.setIndex = index
      lineups.home = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
      lineups.away = { ...lineups.home }
      for (const team of ['home', 'away']) ev.push({ matchId, setIndex: index, type: 'lineup', payload: { team, lineup: lineups[team], isInitial: true }, seq: seq++, ts: t })
      ev.push({ matchId, setIndex: index, type: 'set_start', payload: {}, seq: seq++, ts: t })
      this.rally()
    }
  }
  ev.push({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  if (set === 2) {
    // set 1 played: what `before` adds is in set 1, then set 2 starts
    await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 10, finished: true, startTime: t, endTime: t })
    add.startSet(1)
    before(add)
    ev.push({ matchId, setIndex: 1, type: 'set_end', payload: { team: 'home', setIndex: 1, homePoints: 25, awayPoints: 10 }, seq: seq++, ts: t })
    await db.sets.add({ matchId, index: 2, homePoints: 1, awayPoints: 0, finished: false, startTime: t })
    add.startSet(2)
  } else {
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: t })
    add.startSet(1)
    before(add)
  }
  await db.events.bulkAdd(ev)
  const points = ev.filter(e => e.type === 'point' && e.setIndex === set).length
  await db.sets.where({ matchId, index: set }).modify({ homePoints: points, awayPoints: 0 })
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)

async function openScreen(matchId, courtNumber) {
  mount(matchId)
  await waitFor(() => expect(court(courtNumber)).toBeTruthy(), { timeout: 10000 })
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
  await settle()
}

async function openMenu(n) {
  fireEvent.click(court(n))
  await waitFor(() => expect(playerMenu()).toBeTruthy(), { timeout: 3000 })
}

// Court disc -> Sanction -> Expulsion -> Confirm
async function expelFromCourt(n, count = 1) {
  await openMenu(n)
  fireEvent.click(button('Sanction', playerMenu()))
  await waitFor(() => expect([...playerMenu().querySelectorAll('button')].some(b => /expul/i.test(b.textContent))).toBe(true))
  fireEvent.click([...playerMenu().querySelectorAll('button')].find(b => /expul/i.test(b.textContent)))
  await settle()
  fireEvent.click(sanctionYes())
  await waitFor(async () => expect(await ofType('sanction')).toHaveLength(count), { timeout: 5000 })
  await settle()
}

const liberoChips = () => [...playerMenu().querySelectorAll('button')].map(b => b.textContent.trim()).filter(text => /\((L1|L2|LR)\)$/.test(text))

describe('a libero expelled from the court disc (FIVB 19.3.2.2, 21.3.2)', () => {
  it('is not offered again, and the other libero may replace at once', async () => {
    const matchId = await setUp({ players: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12], liberos: { 12: 'libero1', 11: 'libero2' }, before: (add) => { add.liberoIn('V', 5, 12); add.rally() } })
    await openScreen(matchId, 12)
    await expelFromCourt(12)

    // #5 is back at V; the libero is unable AFTER its exit
    await waitFor(async () => expect((await lineupsOf('home')).at(-1).payload.lineup.V).toBe('5'), { timeout: 5000 })
    await waitFor(async () => expect(await ofType('libero_unable')).toHaveLength(1), { timeout: 5000 })
    const exit = (await ofType('libero_exit')).at(-1)
    const unable = (await ofType('libero_unable')).at(-1)
    expect([String(exit.payload.liberoOut), String(exit.payload.playerIn)]).toEqual(['12', '5'])
    expect(unable.payload.reason).toBe('expulsion')
    // the number as the court disc gives it (a string): matched as a string
    expect(String(unable.payload.liberoNumber)).toBe('12')
    expect(unable.seq).toBeGreaterThan(exit.seq)

    // no rally since: #6 can still be replaced by the other libero, not by #12
    // (the screen's data catches up with the action's last write first)
    await waitFor(async () => {
      if (playerMenu()) fireEvent.click(court(6))
      await settle()
      await openMenu(6)
      expect(button('Libero', playerMenu())).toBeTruthy()
    }, { timeout: 8000 })
    fireEvent.click(button('Libero', playerMenu()))
    await waitFor(() => expect(liberoChips().length).toBeGreaterThan(0))
    expect(liberoChips()).toEqual(['11 (L2)'])
    fireEvent.click(button('11 (L2)', playerMenu()))
    await waitFor(async () => expect(await ofType('libero_entry')).toHaveLength(2), { timeout: 5000 })
    expect((await ofType('libero_entry')).at(-1).payload).toMatchObject({ team: 'home', position: 'VI', playerOut: '6', liberoIn: 11 })
    expect((await lineupsOf('home')).at(-1).payload.lineup).toMatchObject({ V: '5', VI: '11' })
  }, 60000)
})

describe('an expulsion with one legal substitute (FIVB 15.8, 21.3.2)', () => {
  it('Cancel goes back to the list; no rally with the player on court; "Cancel sanction" takes it back', async () => {
    // seven players and a libero: #7 is the only legal substitute
    const matchId = await setUp({ players: [1, 2, 3, 4, 5, 6, 7, 12] })
    await openScreen(matchId, 4)
    await expelFromCourt(4)
    await waitFor(() => expect(confirmDialog()).toBeTruthy(), { timeout: 3000 })
    await settle()
    fireEvent.click(button('Cancel', confirmDialog()))

    // the substitution list with "Cancel sanction", not the court
    await waitFor(() => expect(dropdown()).toBeTruthy(), { timeout: 3000 })
    expect(dropdownOptions()).toEqual(['#7'])
    expect(anyButton('Cancel sanction', dropdown())).toBeTruthy()
    expect(await ofType('sanction')).toHaveLength(1)

    // a rally is refused while #4 is on court
    const rallies = (await ofType('rally_start')).length
    fireEvent.click(button('Start rally'))
    await settle()
    expect(await ofType('rally_start')).toHaveLength(rallies)

    // Cancel sanction: the expulsion is taken back, as one action
    fireEvent.click(anyButton('Cancel sanction', dropdown()))
    await waitFor(async () => expect(await ofType('sanction')).toHaveLength(0), { timeout: 5000 })
    await waitFor(() => expect(dropdown()).toBeFalsy())
    expect(court(4)).toBeTruthy()
    expect(await ofType('substitution')).toHaveLength(0)
    // and the rally may start again
    await settle()
    fireEvent.click(button('Start rally'))
    await waitFor(async () => expect(await ofType('rally_start')).toHaveLength(rallies + 1), { timeout: 5000 })
  }, 60000)

  it('Yes still records the substitution, flagged expelled', async () => {
    const matchId = await setUp({ players: [1, 2, 3, 4, 5, 6, 7, 12] })
    await openScreen(matchId, 4)
    await expelFromCourt(4)
    await waitFor(() => expect(confirmDialog()).toBeTruthy(), { timeout: 3000 })
    await settle()
    fireEvent.click(button('Yes', confirmDialog()))
    await waitFor(async () => expect(await ofType('substitution')).toHaveLength(1), { timeout: 5000 })
    expect((await ofType('substitution'))[0].payload).toMatchObject({ playerOut: '4', playerIn: 7, isExpelled: true })
    expect(await ofType('sanction')).toHaveLength(1)
  }, 60000)
})

describe('an expulsion of an earlier set (FIVB 21.3.2)', () => {
  it('does not force the injury substitution in the next set; the injury is stored as one', async () => {
    // set 1: #4 expelled and replaced by #7; set 2: #4 starts again
    const matchId = await setUp({
      set: 2,
      before: (add) => {
        add.event('sanction', { team: 'home', type: 'expulsion', playerType: 'player', playerNumber: '4', position: 'IV' })
        add.sub('IV', '4', 7, { isExpelled: true })
      }
    })
    await openScreen(matchId, 4)
    await openMenu(4)
    fireEvent.click(button('Injury', playerMenu()))
    await waitFor(() => expect(dropdown()).toBeTruthy(), { timeout: 3000 })
    // a normal list: no "Cancel sanction" for the set-1 expulsion
    expect(anyButton('Cancel sanction', dropdown())).toBeFalsy()
    fireEvent.click([...dropdown().querySelectorAll('button')].find(b => b.textContent.replace(/\s/g, '') === '#8'))
    await waitFor(() => expect(confirmDialog()).toBeTruthy(), { timeout: 3000 })
    await settle()
    fireEvent.click(button('Yes', confirmDialog()))
    await waitFor(async () => expect((await ofType('substitution')).filter(e => e.setIndex === 2)).toHaveLength(1), { timeout: 5000 })
    const written = (await ofType('substitution')).find(e => e.setIndex === 2).payload
    expect(written).toMatchObject({ playerOut: '4', playerIn: 8, isExpelled: false, isInjury: true })
    // the set-1 expulsion is still on the record
    expect((await ofType('sanction')).map(e => [e.setIndex, e.payload.type])).toEqual([[1, 'expulsion']])
  }, 60000)
})

describe('an expelled bench player whom the libero replaced (FIVB 15.8, Casebook)', () => {
  it('the exceptional substitution is written in the remarks, with the event', async () => {
    // 6 regular substitutions used (#7 in for #1 and back, #8-#10 and #2 in), L #12 in for #5 at V
    const matchId = await setUp({
      players: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      before: (add) => {
        for (const [pos, out, inn] of [['I', 1, 7], ['II', 2, 8], ['III', 3, 9], ['IV', 4, 10], ['VI', 6, 11]]) add.sub(pos, out, inn)
        add.rally()
        add.sub('I', 7, 1)
        add.liberoIn('V', 5, 12)
        add.rally()
      }
    })
    await openScreen(matchId, 12)
    fireEvent.click(benchPlayer(5))
    const benchMenu = () => document.querySelector('[data-bench-player-action-menu]')
    await waitFor(() => expect(benchMenu()).toBeTruthy(), { timeout: 3000 })
    fireEvent.click(button('Sanction', benchMenu()))
    await waitFor(() => expect(button('Expulsion', benchMenu())).toBeTruthy())
    fireEvent.click(button('Expulsion', benchMenu()))
    await settle()
    fireEvent.click(sanctionYes())
    await waitFor(async () => expect(await ofType('sanction')).toHaveLength(1), { timeout: 5000 })
    // "Exceptional substitution required": the bench players who may come in
    const required = await waitFor(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].find(x => /exceptional/i.test(x.textContent))
      expect(d).toBeTruthy()
      return d
    }, { timeout: 3000 })
    await settle()
    const pick = [...required.querySelectorAll('button')].find(b => /7/.test(b.textContent))
    fireEvent.click(pick)
    await waitFor(async () => expect(await ofType('substitution')).toHaveLength(7), { timeout: 5000 })
    const written = (await ofType('substitution')).at(-1).payload
    expect(written).toMatchObject({ isExceptional: true, isLiberoReplacementSub: true })
    expect(String(written.playerOut)).toBe('5')
    expect(written.autoRemark).toMatch(/#5 exceptionally substituted by #7/)
    await waitFor(async () => expect((await db.matches.get(matchId)).remarks || '').toContain(written.autoRemark), { timeout: 5000 })
  }, 60000)
})

describe('a team official gets no sanction twice (FIVB 21.4.2)', () => {
  it('the coach with a penalty: no second penalty; expulsion is still offered', async () => {
    const matchId = await setUp({
      match: { bench_home: [{ role: 'Coach', firstName: 'Alex', lastName: 'Trainer' }] },
      before: (add) => add.event('sanction', { team: 'home', type: 'penalty', playerType: 'official', role: 'Coach' })
    })
    await openScreen(matchId, 4)
    const chip = [...document.querySelectorAll('span')].find(s => s.textContent.trim() === 'Trainer Alex')
    expect(chip).toBeTruthy()
    fireEvent.click(chip.parentElement.parentElement)
    const menu = () => document.querySelector('[data-sanction-dropdown]')
    await waitFor(() => expect(menu()).toBeTruthy(), { timeout: 3000 })
    const penalty = [...menu().querySelectorAll('button')].find(b => /^Penalty/.test(b.textContent.trim()))
    expect(penalty.disabled).toBe(true)
    expect([...menu().querySelectorAll('button')].find(b => /^Expulsion/.test(b.textContent.trim())).disabled).toBe(false)
  }, 60000)
})

describe('one libero entry for every path (FIVB 19.3.2, 5.2)', () => {
  it('the court menu asks for a game captain when the captain goes off for the libero', async () => {
    const matchId = await setUp({ captain: 6 })
    await openScreen(matchId, 6)
    await openMenu(6)
    fireEvent.click(button('Libero', playerMenu()))
    await waitFor(() => expect(liberoChips()).toEqual(['12 (L1)']))
    fireEvent.click(button('12 (L1)', playerMenu()))
    await waitFor(async () => expect(await ofType('libero_entry')).toHaveLength(1), { timeout: 5000 })
    await waitFor(() => expect([...document.querySelectorAll('[role="dialog"]')].some(d => /Game captain/.test(d.textContent))).toBe(true), { timeout: 3000 })
  }, 60000)

  it('the bench libero\'s "Replace" enters that libero at once (no second list)', async () => {
    const matchId = await setUp({ players: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12], liberos: { 12: 'libero1', 11: 'libero2' } })
    await openScreen(matchId, 5)
    fireEvent.click(benchLibero(11))
    const menu = () => document.querySelector('[data-libero-bench-action-menu]')
    await waitFor(() => expect(menu()).toBeTruthy(), { timeout: 3000 })
    fireEvent.click(button('Replace', menu()))
    await waitFor(() => expect(button('5', menu())).toBeTruthy())
    fireEvent.click(button('5', menu()))
    await waitFor(async () => expect(await ofType('libero_entry')).toHaveLength(1), { timeout: 5000 })
    expect((await ofType('libero_entry'))[0].payload).toMatchObject({ team: 'home', position: 'V', playerOut: '5', liberoIn: 11, liberoType: 'libero2' })
    const last = (await lineupsOf('home')).at(-1)
    expect(last.payload.lineup.V).toBe('11')
    expect(last.seq).toBe((await ofType('libero_entry'))[0].seq + 0.1)
    await settle()
    expect(document.querySelector('[data-libero-dropdown]')).toBeFalsy()
    expect(menu()).toBeFalsy()
  }, 60000)

  it('touch drag of the right-hand team\'s bench libero onto a back-row player opens the libero dialog', async () => {
    const matchId = await setUp()
    await openScreen(matchId, 5)
    // away plays on the right in set 1
    const chip = benchLibero(12, 'away')
    expect(chip).toBeTruthy()
    const target = court(5, 'away')
    fireEvent.touchStart(chip, { touches: [{ clientX: 10, clientY: 10 }] })
    await wait(1800)
    fireEvent.touchMove(chip, { touches: [{ clientX: 50, clientY: 50 }] })
    await wait(100)
    document.elementFromPoint = () => target
    fireEvent.touchEnd(chip, { touches: [] })
    await waitFor(() => expect(button('Confirm')).toBeTruthy(), { timeout: 3000 })
    await settle()
    fireEvent.click(button('Confirm'))
    await waitFor(async () => expect(await ofType('libero_entry')).toHaveLength(1), { timeout: 5000 })
    expect((await ofType('libero_entry'))[0].payload).toMatchObject({ team: 'away', position: 'V', liberoIn: 12 })
    expect((await lineupsOf('away')).at(-1).payload.lineup.V).toBe('12')
  }, 60000)
})
