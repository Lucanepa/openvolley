// An injured libero (owner decision 22.11.2026): "They may return to play
// later unless a redesignation occurs", as the confirmation says.
//  - as long as no re-designation replaced him, his tile opens his menu with
//    "Able to play again": a libero_recovered event with its remark, undone
//    by Undo, after which he is offered as libero again (also in a later set:
//    on 21.11 his tile did nothing in set 2);
//  - once a re-designation replaced him, he is out for the match: his tile
//    opens nothing, he is never offered again.
// On the real scoring screen over the app's real Dexie database (fake
// IndexedDB), at tablet width. Network is off: no relay socket, no fetch.
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
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type).sort((a, b) => a.seq - b.seq)
const court = (n, team = 'home') => document.querySelector(`.court-player[data-team="${team}"][data-player-number="${n}"]`)
const benchLibero = (n, team = 'home') => document.querySelector(`[data-bench-player="${n}"][data-team="${team}"][data-is-libero="true"]`)
const playerMenu = () => document.querySelector('[data-player-action-menu]')
const liberoMenu = () => document.querySelector('[data-libero-bench-action-menu]')
const dialog = (re) => [...document.querySelectorAll('[role="dialog"]')].find(d => re.test(d.textContent))
const liberoChips = () => [...playerMenu().querySelectorAll('button')].map(b => b.textContent.trim()).filter(text => /\((L1|L2|LR)\)$/.test(text))

// Set 1 (or set 2), home serving and winning every rally, line-ups 1-6,
// liberos #12 (L1) and #11 (L2). `before(add)` adds events after the first rally.
async function setUp({ set = 1, liberos = { 12: 'libero1', 11: 'libero2' }, before = () => {} } = {}) {
  const players = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  const rows = []
  for (const teamId of [home, away]) {
    for (const n of players) rows.push({ teamId, number: n, name: `P${n}`, firstName: 'X', ...(liberos[n] ? { libero: liberos[n] } : {}), ...(n === 1 ? { isCaptain: true } : {}) })
  }
  await db.players.bulkAdd(rows)
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true
  })
  const t = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  let seq = 1
  const ev = []
  const add = {
    setIndex: 1,
    rally() {
      ev.push({ matchId, setIndex: this.setIndex, type: 'rally_start', payload: {}, seq: seq++, ts: t })
      ev.push({ matchId, setIndex: this.setIndex, type: 'point', payload: { team: 'home' }, seq: seq++, ts: t })
    },
    event(type, payload) { ev.push({ matchId, setIndex: this.setIndex, type, payload, seq: seq++, ts: t }) },
    startSet(index) {
      this.setIndex = index
      for (const team of ['home', 'away']) ev.push({ matchId, setIndex: index, type: 'lineup', payload: { team, lineup: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }, isInitial: true }, seq: seq++, ts: t })
      ev.push({ matchId, setIndex: index, type: 'set_start', payload: {}, seq: seq++, ts: t })
      this.rally()
    }
  }
  ev.push({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  if (set === 2) {
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

async function openScreen(matchId) {
  mount(matchId)
  await waitFor(() => expect(court(5)).toBeTruthy(), { timeout: 10000 })
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
  await settle()
}

// the libero picks a back-row player is offered (#5 at V)
async function liberoChipsFor5() {
  fireEvent.click(court(5))
  await waitFor(() => expect(playerMenu()).toBeTruthy(), { timeout: 3000 })
  const libero = button('Libero', playerMenu())
  if (libero) fireEvent.click(libero)
  await wait(100)
  const chips = liberoChips()
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(playerMenu()).toBeFalsy())
  return chips
}

const injured12 = { team: 'home', liberoNumber: 12, liberoType: 'libero1', reason: 'injury', autoRemark: 'Set 1, 20:00, A 1:0, Libero #12 becomes unable to play' }

describe('an injured libero no re-designation replaced may play again (owner 22.11.2026)', () => {
  it('set 2: his tile opens "Able to play again"; recorded with its remark; offered again; Undo takes it back', async () => {
    const matchId = await setUp({ set: 2, before: (add) => add.event('libero_unable', injured12) })
    await openScreen(matchId)
    await waitFor(() => expect(benchLibero(12)?.getAttribute('data-libero-state')).toBe('injured'))
    // only L2 while he is injured
    expect(await liberoChipsFor5()).toEqual(['11 (L2)'])

    fireEvent.click(benchLibero(12))
    await waitFor(() => expect(liberoMenu()).toBeTruthy(), { timeout: 3000 })
    // no "Replace" or "Unable to play" for him until he is back
    expect(button('Replace', liberoMenu())).toBeFalsy()
    expect(liberoMenu().textContent).not.toContain('Unable to play')
    fireEvent.click(button('Able to play again', liberoMenu()))
    await waitFor(async () => expect(await ofType('libero_recovered')).toHaveLength(1), { timeout: 5000 })
    const [back] = await ofType('libero_recovered')
    expect(back.payload).toMatchObject({ team: 'home', liberoNumber: 12, liberoType: 'libero1' })
    expect(back.setIndex).toBe(2)
    expect(back.payload.autoRemark).toMatch(/^Set 2, \d{2}:\d{2}, A 1:0, Libero #12 able to play again$/)
    await waitFor(async () => expect((await db.matches.get(matchId)).remarks || '').toContain(back.payload.autoRemark), { timeout: 5000 })
    await waitFor(() => expect(benchLibero(12)?.getAttribute('data-libero-state')).toBe(null))
    await settle()
    expect((await liberoChipsFor5()).sort()).toEqual(['11 (L2)', '12 (L1)'])

    // Undo: injured again, the remark gone
    await settle()
    fireEvent.click(document.querySelector('[data-help-id="scoreboard-undo"]'))
    await waitFor(() => expect(dialog(/Confirm undo/) && button('Yes', dialog(/Confirm undo/))).toBeTruthy(), { timeout: 5000 })
    await wait(GHOST_CLICK_MS)
    fireEvent.click(button('Yes', dialog(/Confirm undo/)))
    await waitFor(async () => expect(await ofType('libero_recovered')).toHaveLength(0), { timeout: 5000 })
    await waitFor(async () => expect((await db.matches.get(matchId)).remarks || '').not.toContain('able to play again'), { timeout: 5000 })
    await waitFor(() => expect(benchLibero(12)?.getAttribute('data-libero-state')).toBe('injured'))
  }, 60000)

  it('a libero declared unable (not injured) stays out: his tile opens nothing', async () => {
    const matchId = await setUp({ before: (add) => add.event('libero_unable', { ...injured12, reason: 'declared' }) })
    await openScreen(matchId)
    await waitFor(() => expect(benchLibero(12)?.getAttribute('data-libero-state')).toBe('unable'))
    fireEvent.click(benchLibero(12))
    await wait(300)
    expect(liberoMenu()).toBeFalsy()
  }, 60000)

  // owner 22.11.2026: "Once declared or becoming unable and re-designated: can't continue playing"
  it('declared unable once, a later "able to play again" (a correction, an older record) does not bring him back', async () => {
    const matchId = await setUp({
      set: 2,
      before: (add) => {
        add.event('libero_unable', { ...injured12, reason: 'declared' })
        add.event('libero_recovered', { team: 'home', liberoNumber: 12, liberoType: 'libero1' })
      }
    })
    await openScreen(matchId)
    await waitFor(() => expect(benchLibero(12)?.getAttribute('data-libero-state')).toBe('unable'))
    fireEvent.click(benchLibero(12))
    await wait(300)
    expect(liberoMenu()).toBeFalsy()
    expect(button('Able to play again')).toBeFalsy()
    expect(await liberoChipsFor5()).toEqual(['11 (L2)'])
  }, 60000)
})

describe('an injured libero a re-designation replaced is out for the match (owner 22.11.2026)', () => {
  it('his tile opens nothing, he is never offered, the re-designated libero is', async () => {
    // one libero, injured; #9 re-designated in his place (the roster marks him 'unable')
    const matchId = await setUp({
      set: 2,
      liberos: { 12: 'libero1' },
      before: (add) => {
        add.event('libero_unable', injured12)
        add.event('libero_redesignation', { team: 'home', unableLiberoNumber: 12, unableLiberoType: 'libero1', newLiberoNumber: 9, reason: 'injury' })
      }
    })
    const homeTeamId = (await db.matches.get(matchId)).homeTeamId
    const rows = await db.players.where('teamId').equals(homeTeamId).toArray()
    await db.players.update(rows.find(p => p.number === 12).id, { libero: 'unable' })
    await db.players.update(rows.find(p => p.number === 9).id, { libero: 'redesignated' })
    await openScreen(matchId)
    await waitFor(() => expect(benchLibero(12)?.getAttribute('data-libero-state')).toBe('unable'))
    fireEvent.click(benchLibero(12))
    await wait(300)
    expect(liberoMenu()).toBeFalsy()
    expect(await liberoChipsFor5()).toEqual(['9 (LR)'])
  }, 60000)
})
