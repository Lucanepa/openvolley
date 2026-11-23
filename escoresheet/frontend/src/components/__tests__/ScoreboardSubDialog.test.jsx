// The SUB box's substitution dialog (owner 23.11.2026): tap who comes in,
// then who goes out; several pairs, one Confirm, through the substitution
// path every other way takes (setSubstitutionConfirm -> confirmSubstitution).
//  - only legal players: a bench player nobody may be replaced by is not
//    listed, the libero and the player it replaced are not offered, a
//    substituted starter comes back only for his substitute (with the
//    scoreboard's ↑ ↓ box), the court keeps its shape with empty places;
//  - several pairs recorded with one Confirm, each with its line-up row,
//    one request (no "second request" warning), no confirmation dialog;
//    Cancel records nothing; the captain going out: the game captain after;
//  - never past 6: at 5 recorded, one pair and the court locks;
//  - opens while a time-out runs and in the set interval (line-up in), not
//    while a rally is in play (the list of those recorded, as before); a replay
//    pending: no regular substitution, the note and "Injury / exceptional".
// On the real scoring screen over the app's Dexie database (fake
// IndexedDB), at tablet width, network off.
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

// As in ScoreboardSubstitutionLegality.test.jsx: under jsdom + fake-indexeddb
// a scorer action can end with PrematureCommitError (not in Chrome)
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
  window.innerWidth = 1280
  window.innerHeight = 800
})
beforeEach(async () => {
  cleanup()
  localStorage.removeItem('displayMode')
  localStorage.removeItem('manageCaptainOnCourt')
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
const SEED = 'seed-sub-dialog'

// Set 1, home serving and winning every rally (no rotation), line-ups 1-6,
// 12 players a team, #1 the captain, #12 the libero.
//  'substitute' #9 in for #3 (III), L #12 in for #5 at V, a rally since
//  'five'       5 regular substitutions (#7-#11 in for #1-#4, #6), a rally since
//  'replay'     a rally, then a replay pending
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
  ev.push({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: seq++, ts: t })
  for (const team of ['home', 'away']) ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team, lineup, isInitial: true }, seq: seq++, ts: t })
  ev.push({ matchId, setIndex: 1, type: 'set_start', payload: {}, seq: seq++, ts: t })
  rally()
  if (kind === 'substitute') {
    sub('III', 3, 9)
    const at = seq++
    ev.push({ matchId, setIndex: 1, type: 'libero_entry', payload: { team: 'home', position: 'V', playerOut: 5, liberoIn: 12, liberoType: 'libero1' }, seq: at, ts: t })
    lineup = { ...lineup, V: '12' }
    ev.push({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup, liberoSubstitution: { position: 'V', liberoNumber: 12, playerNumber: 5, liberoType: 'libero1' } }, seq: at + 0.1, ts: t })
    rally()
  }
  if (kind === 'five') {
    for (const [pos, out, inn] of [['I', 1, 7], ['II', 2, 8], ['III', 3, 9], ['IV', 4, 10], ['VI', 6, 11]]) sub(pos, out, inn)
    rally()
  }
  if (kind === 'replay') {
    ev.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
    ev.push({ matchId, setIndex: 1, type: 'replay', payload: {}, seq: seq++, ts: t })
  }
  if (kind === 'second') {
    // a substitution in this interruption, then a time-out: a further one is a second request
    sub('I', 1, 7)
    ev.push({ matchId, setIndex: 1, type: 'timeout', payload: { team: 'home' }, seq: seq++, ts: t })
  }
  await db.events.bulkAdd(ev)
  await db.sets.where({ matchId, index: 1 }).modify({ homePoints: ev.filter(e => e.type === 'point').length, awayPoints: 0 })
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const court = (n) => document.querySelector(`.court-player[data-team="home"][data-player-number="${n}"]`)
// home serves first and is team A: on the left in set 1
const subBox = () => document.querySelector('[data-testid="sub-box-left"]')
const dialog = () => document.querySelector('[data-testid="sub-dialog"]')
const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`)
const benchOffered = () => [...dialog().querySelectorAll('[data-testid^="sub-dialog-in-"]')].map(b => b.dataset.testid.replace('sub-dialog-in-', '')).filter(n => /^\d+$/.test(n))
const courtOffered = () => [...dialog().querySelectorAll('[data-testid^="sub-dialog-out-"]')].map(b => b.dataset.testid.replace('sub-dialog-out-', ''))
const confirmModal = () => [...document.querySelectorAll('[role="dialog"]')].find(d => button('Yes', d))

async function openScreen(matchId, courtNumber = 4) {
  mount(matchId)
  await waitFor(() => expect(court(courtNumber)).toBeTruthy(), { timeout: 10000 })
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 10000 })
  await settle()
}

async function openDialog() {
  expect(subBox().hasAttribute('data-tap-hint')).toBe(true)
  fireEvent.click(subBox())
  await waitFor(() => expect(dialog()).toBeTruthy(), { timeout: 3000 })
}

describe('the SUB box dialog: only legal players (owner 23.11.2026)', () => {
  it('in: the legal bench players, the substituted starter with his substitute; out: only whom he may replace, the libero never', async () => {
    const matchId = await setUp('substitute')
    await openScreen(matchId, 9)
    await openDialog()
    expect(byTestId('sub-dialog-step').textContent).toMatch(/Tap who comes in/)
    expect(byTestId('sub-dialog-count').textContent).toBe('1 of 6')
    // #5 (the libero replaced him) and the libero #12 are not offered
    expect(benchOffered()).toEqual(['3', '7', '8', '10', '11'])
    // #3 went out for #9: the scoreboard's ↑ ↓ box with 9, no words
    const three = byTestId('sub-dialog-in-3')
    expect(three.textContent.replace(/\s/g, '')).toBe('3↑↓9')
    expect(byTestId('sub-dialog-in-7').textContent).toBe('7')
    // the court as on the scoreboard (left team: V IV / VI III / I II), the libero shown, nothing to tap yet
    const places = [...byTestId('sub-dialog-court').children].map(el => el.textContent.replace(/\s/g, ''))
    expect(places).toEqual(['12V', '4IV', '6VI', '9III', '1I', '2II'])
    expect(courtOffered()).toEqual([])

    // #3 may come back only for #9
    fireEvent.click(three)
    expect(byTestId('sub-dialog-step').textContent).toMatch(/Tap who goes out for #3/)
    expect(courtOffered()).toEqual(['9'])
    expect(byTestId('sub-dialog-court-12')).toBeFalsy()
    // the others leave empty places: the court keeps its six
    expect(byTestId('sub-dialog-court').children).toHaveLength(6)

    // a bench player who never played: any starter, not the substitute #9, not the libero
    fireEvent.click(byTestId('sub-dialog-in-7'))
    expect(courtOffered().sort()).toEqual(['1', '2', '4', '6'])
    expect(byTestId('sub-dialog-court-12')).toBeFalsy()
  }, 60000)
})

describe('the SUB box dialog: several pairs, one Confirm (owner 23.11.2026)', () => {
  it('two pairs: both recorded with their line-up rows, one request, no confirmation dialog; then the game captain', async () => {
    const matchId = await setUp('substitute')
    await openScreen(matchId, 9)
    await openDialog()
    fireEvent.click(byTestId('sub-dialog-in-7'))
    fireEvent.click(byTestId('sub-dialog-out-1'))
    // back at "who comes in"; #7 and #1 are taken
    expect(byTestId('sub-dialog-step').textContent).toMatch(/Tap who comes in/)
    expect(benchOffered()).not.toContain('7')
    expect(byTestId('sub-dialog-pair-7-1').textContent).toMatch(/#7 in for #1 out/)
    // the captain goes out: the game captain is asked after Confirm
    expect(byTestId('sub-dialog-pair-7-1').querySelector('[data-testid="sub-dialog-captain-note"]')).toBeTruthy()
    fireEvent.click(byTestId('sub-dialog-in-8'))
    expect(courtOffered().sort()).toEqual(['2', '4', '6'])
    fireEvent.click(byTestId('sub-dialog-out-2'))
    expect(byTestId('sub-dialog-count').textContent).toBe('1 of 6 · 2 to confirm')

    fireEvent.click(byTestId('sub-dialog-confirm'))
    await waitFor(() => expect(dialog()).toBeFalsy())
    await waitFor(async () => expect(await ofType('substitution')).toHaveLength(3), { timeout: 8000 })
    const subs = (await ofType('substitution')).slice(1).map(e => e.payload)
    expect(subs.map(p => [p.position, String(p.playerOut), String(p.playerIn), p.isExceptional])).toEqual([['I', '1', '7', false], ['II', '2', '8', false]])
    // each with its line-up row (N.1), the second written on the first's
    const lineups = (await ofType('lineup')).filter(e => e.payload?.team === 'home' && e.payload?.fromSubstitution)
    const last = lineups.at(-1)
    expect(last.payload.lineup).toMatchObject({ I: '7', II: '8', III: '9', V: '12' })
    for (const s of (await ofType('substitution')).slice(1)) {
      expect(lineups.some(l => Math.abs(l.seq - (s.seq + 0.1)) < 1e-6)).toBe(true)
    }
    // no confirmation dialog, no request warning (back to back: one request)
    expect(confirmModal()).toBeFalsy()
    expect(document.querySelector('[data-testid="request-warning"]')).toBeFalsy()
    // both on the court once the screen shows the second write
    await waitFor(() => expect(court(7)).toBeTruthy())
    await waitFor(() => expect(court(8)).toBeTruthy())
    // #1 the captain left: the game captain dialog, once the pairs are in
    await waitFor(() => expect([...document.querySelectorAll('[role=dialog]')].find(d => d.querySelector('[data-testid="game-captain-keep"]'))).toBeTruthy(), { timeout: 5000 })
  }, 60000)

  it('Remove takes a pair back; Cancel records nothing', async () => {
    const matchId = await setUp('substitute')
    await openScreen(matchId, 9)
    await openDialog()
    fireEvent.click(byTestId('sub-dialog-in-7'))
    fireEvent.click(byTestId('sub-dialog-out-4'))
    fireEvent.click(byTestId('sub-dialog-remove-7-4'))
    expect(byTestId('sub-dialog-pairs')).toBeFalsy()
    expect(benchOffered()).toContain('7')
    fireEvent.click(byTestId('sub-dialog-in-8'))
    fireEvent.click(byTestId('sub-dialog-out-6'))
    fireEvent.click(byTestId('sub-dialog-cancel'))
    await waitFor(() => expect(dialog()).toBeFalsy())
    await wait(800)
    expect(await ofType('substitution')).toHaveLength(1)
  }, 60000)

  const twoPairsAfterATimeout = async () => {
    const matchId = await setUp('second')
    await openScreen(matchId, 7)
    await openDialog()
    // #1 went out with no rally since: he cannot come back yet
    expect(benchOffered()).toEqual(['8', '9', '10', '11'])
    fireEvent.click(byTestId('sub-dialog-in-8'))
    fireEvent.click(byTestId('sub-dialog-out-2'))
    fireEvent.click(byTestId('sub-dialog-in-10'))
    fireEvent.click(byTestId('sub-dialog-out-4'))
    fireEvent.click(byTestId('sub-dialog-confirm'))
    // the checks every substitution passes: a second request in this interruption
    await waitFor(() => expect(document.querySelector('[data-testid="request-warning"][data-reason="second_substitution_request"]')).toBeTruthy(), { timeout: 5000 })
    await settle()
  }

  it('a second request: the request warning; "Continue anyway" records both pairs (one request)', async () => {
    await twoPairsAfterATimeout()
    fireEvent.click(document.querySelector('[data-testid="request-warning"] [data-option="continue"]'))
    await waitFor(async () => expect(await ofType('substitution')).toHaveLength(3), { timeout: 8000 })
    const subs = (await ofType('substitution')).slice(1).map(e => [String(e.payload.playerOut), String(e.payload.playerIn)])
    expect(subs).toEqual([['2', '8'], ['4', '10']])
    // asked once: the second pair is part of the same request
    await wait(600)
    expect(document.querySelector('[data-testid="request-warning"]')).toBeFalsy()
  }, 60000)

  it('a second request: Cancel in the warning records none of the pairs', async () => {
    await twoPairsAfterATimeout()
    fireEvent.click(button('Cancel', document.querySelector('[data-testid="request-warning"]').closest('[role="dialog"]')))
    await waitFor(() => expect(document.querySelector('[data-testid="request-warning"]')).toBeFalsy())
    await wait(2500)
    expect(await ofType('substitution')).toHaveLength(1)
    expect(document.querySelector('[data-testid="request-warning"]')).toBeFalsy()
  }, 60000)
})

describe('the SUB box dialog never goes past 6 (owner 23.11.2026)', () => {
  it('5 recorded: one pair, then the bench says 6 of 6 and the court locks; Confirm records the 6th', async () => {
    const matchId = await setUp('five')
    await openScreen(matchId, 7)
    await openDialog()
    expect(byTestId('sub-dialog-count').textContent).toBe('5 of 6')
    // the starters come back only for their substitutes
    expect(benchOffered()).toEqual(['1', '2', '3', '4', '6'])
    fireEvent.click(byTestId('sub-dialog-in-1'))
    expect(courtOffered()).toEqual(['7'])
    fireEvent.click(byTestId('sub-dialog-out-7'))
    expect(byTestId('sub-dialog-count').textContent).toBe('5 of 6 · 1 to confirm')
    expect(byTestId('sub-dialog-in-full').textContent).toBe('6 of 6 with the one below.')
    expect(benchOffered()).toEqual([])
    expect(courtOffered()).toEqual([])
    expect(byTestId('sub-dialog-step')).toBeFalsy()
    fireEvent.click(byTestId('sub-dialog-confirm'))
    await waitFor(async () => expect(await ofType('substitution')).toHaveLength(6), { timeout: 8000 })
    await settle()
    // 6 of 6: the note, nothing to pick, the injury / exceptional button stays
    await openDialog()
    await waitFor(() => expect(byTestId('sub-dialog-full-note')).toBeTruthy())
    expect(byTestId('sub-dialog-in-full').textContent).toBe('No regular substitution left.')
    expect(byTestId('sub-dialog-injury').disabled).toBe(false)
  }, 60000)
})

describe('the SUB box dialog: when it opens (owner 23.11.2026)', () => {
  it('while a time-out runs', async () => {
    const matchId = await setUp('substitute')
    await openScreen(matchId, 9)
    fireEvent.click(document.querySelector('[data-help-id="scoreboard-timeout-left"]'))
    await waitFor(() => expect(button('Confirm')).toBeTruthy())
    fireEvent.click(button('Confirm'))
    await waitFor(() => expect(button('Stop timeout')).toBeTruthy())
    await settle()
    await openDialog()
    expect(benchOffered()).toEqual(['3', '7', '8', '10', '11'])
  }, 60000)

  it('not while a rally is in play: the list of those recorded, as before', async () => {
    const matchId = await setUp('substitute')
    await openScreen(matchId, 9)
    fireEvent.click(button('Start rally'))
    await waitFor(() => expect(button('Start rally')).toBeFalsy(), { timeout: 5000 })
    await settle()
    expect(subBox().hasAttribute('data-tap-hint')).toBe(true) // the list still opens
    fireEvent.click(subBox())
    await waitFor(() => expect([...document.querySelectorAll('[role="dialog"]')].find(d => /Substitution 1/.test(d.textContent))).toBeTruthy())
    expect(dialog()).toBeFalsy()
  }, 60000)

  it('a replay pending: no regular substitution, the note and Injury / exceptional', async () => {
    const matchId = await setUp('replay')
    await openScreen(matchId, 4)
    await openDialog()
    expect(byTestId('sub-dialog-block-note').textContent).toMatch(/Replay pending/)
    expect(benchOffered()).toEqual([])
    expect(byTestId('sub-dialog-confirm').disabled).toBe(true)
    // the injured player: the court menu's injury flow (a legal substitute: the list)
    fireEvent.click(byTestId('sub-dialog-injury'))
    expect(byTestId('sub-dialog-step').textContent).toMatch(/Tap the injured player/)
    fireEvent.click(byTestId('sub-dialog-injury-4'))
    await waitFor(() => expect(dialog()).toBeFalsy())
    await waitFor(() => expect(document.querySelector('[data-substitution-dropdown]')).toBeTruthy(), { timeout: 3000 })
  }, 60000)

  it('in the set interval, once the line-up of the next set is in', async () => {
    const home = await db.teams.add({ name: 'Home VC' })
    const away = await db.teams.add({ name: 'Away VC' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7, 8].flatMap(n => [
      { teamId: home, number: n, name: `H${n}` }, { teamId: away, number: n, name: `A${n}` }
    ]))
    const end1 = new Date(Date.now() - 30000).toISOString()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: true,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true
    })
    await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 15, finished: true, startTime: new Date(Date.now() - 1800000).toISOString(), endTime: end1 })
    await db.sets.add({ matchId, index: 2, homePoints: 0, awayPoints: 0, finished: false })
    const lineup = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 1, ts: end1 },
      { matchId, setIndex: 1, type: 'set_end', payload: {}, seq: 2, ts: end1 },
      { matchId, setIndex: 2, type: 'lineup', payload: { team: 'home', lineup, isInitial: true }, seq: 3, ts: end1 },
      { matchId, setIndex: 2, type: 'lineup', payload: { team: 'away', lineup, isInitial: true }, seq: 4, ts: end1 }
    ])
    mount(matchId)
    await waitFor(() => expect(button('End set interval')).toBeTruthy(), { timeout: 10000 })
    await settle()
    // set 2: home on the right
    const box = await waitFor(() => {
      const b = [document.querySelector('[data-testid="sub-box-left"]'), document.querySelector('[data-testid="sub-box-right"]')].find(x => x?.hasAttribute('data-tap-hint'))
      expect(b).toBeTruthy()
      return b
    })
    fireEvent.click(box)
    await waitFor(() => expect(dialog()).toBeTruthy(), { timeout: 3000 })
    expect(benchOffered()).toEqual(['7', '8'])
    // the interval keeps running
    expect(button('End set interval')).toBeTruthy()
  }, 60000)
})
