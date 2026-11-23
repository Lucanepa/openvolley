// The scoring screen's DOM, frozen for a performance pass (2026-11-22): the
// renders get cheaper (memoized log scans, the set interval's countdown
// ticking in its own leaf, the post-match signature pad mounted only while
// open), and what they draw must stay exactly the same. Each fixture is the
// real Scoreboard over the app's Dexie database (fake IndexedDB) at a fixed
// time (Date and the monotonic clock stand still), its DOM written out with
// the inline styles left out (the paint pass changes those on purpose) and
// compared with the golden recorded on the unchanged screen.
//  - set 4 under way: regular substitutions (one back, one free to come
//    back, one waiting for a point), an expulsion and its substitution (and
//    one in set 3), an exceptional (injury) substitution, a disqualification,
//    warnings, a penalty, a coach's warning, a delay warning, liberos on
//    court and an injured one, time-outs, results of sets 1-3
//  - a replay pending (time-outs and substitutions closed)
//  - a set interval running, and the one before the deciding set (its setup)
//  - the phone layout: set 4 and the set interval
// Network is off: no relay socket, no fetch.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { scorerRelay } from '../../utils/relayPublisher'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// As in ScoreboardInterruptionFlows.test.jsx: under jsdom + fake-indexeddb a
// write can lose Dexie's transaction zone and end with PrematureCommitError
// (not in Chrome). Only that error is let through.
const isEnvPrematureCommit = (reason) => reason?.name === 'PrematureCommitError'
let rejectionListeners = []
const filterRejections = (reason, promise) => {
  if (isEnvPrematureCommit(reason)) return
  for (const listener of rejectionListeners) listener(reason, promise)
}

// A Saturday evening in the hall; the monotonic clock as long after the page
// load. Both stand still for the whole test.
const NOW = new Date('2026-11-21T19:30:00+01:00').getTime()
const PERF_NOW = 3600000
const MIN = 60 * 1000

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
  localStorage.removeItem('displayMode')
  await Promise.all(db.tables.map(t => t.clear()))
  // the timers stay real (Dexie, the waits); only the clocks stand still
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  vi.spyOn(performance, 'now').mockReturnValue(PERF_NOW)
})
afterEach(() => {
  cleanup()
  vi.mocked(performance.now).mockRestore()
  vi.useRealTimers()
  window.innerWidth = saved.width
  window.innerHeight = saved.height
})
afterAll(() => {
  process.removeListener('unhandledRejection', filterRejections)
  for (const listener of rejectionListeners) process.on('unhandledRejection', listener)
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const iso = (ms) => new Date(ms).toISOString()

/**
 * The page as text, one node a line: tags with their attributes (sorted; no
 * style), text trimmed. Comments and empty text are left out.
 */
function domText(root) {
  const lines = []
  const walk = (node, depth) => {
    const pad = '  '.repeat(depth)
    if (node.nodeType === 3) {
      // A date is written in the machine's default locale (the toolbar clock:
      // 21/11/2026 here, 11/21/2026 on the CI runners): only its place counts
      const text = node.textContent.replace(/\s+/g, ' ').trim().replace(/\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g, '<date>')
      if (text) lines.push(`${pad}"${text}"`)
      return
    }
    if (node.nodeType !== 1) return
    const attrs = [...node.attributes]
      .filter(a => a.name !== 'style')
      .map(a => `${a.name}="${a.value}"`)
      .sort()
    lines.push(`${pad}<${node.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`)
    for (const child of node.childNodes) walk(child, depth + 1)
  }
  for (const child of root.childNodes) walk(child, 0)
  return lines.join('\n') + '\n'
}

/** The DOM once it no longer changes (two reads half a second apart). */
async function settledDom() {
  await wait(1200)
  let before = domText(document.body)
  for (let i = 0; i < 10; i++) {
    await wait(500)
    const after = domText(document.body)
    if (after === before) return after
    before = after
  }
  throw new Error('the scoring screen kept changing')
}

const LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }

async function addTeams() {
  const home = await db.teams.add({ name: 'VBC Musterau', shortName: 'MUS', color: '#dc2626' })
  const away = await db.teams.add({ name: 'VC Beispielstadt', shortName: 'BSP', color: '#2563eb' })
  const rows = []
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14]) {
    rows.push({ teamId: home, number: n, firstName: `Hanna${n}`, lastName: `Home${n}`, ...(n === 12 ? { libero: 'libero1' } : n === 11 ? { libero: 'libero2' } : {}), ...(n === 1 ? { isCaptain: true } : {}) })
    rows.push({ teamId: away, number: n, firstName: `Anna${n}`, lastName: `Away${n}`, ...(n === 14 ? { libero: 'libero1' } : {}), ...(n === 2 ? { isCaptain: true } : {}) })
  }
  await db.players.bulkAdd(rows)
  return { home, away }
}

/** Events in seq order, all at `ts`; a lineup sub-event 0.1 after its event. */
function eventLog(matchId, ts) {
  let seq = 1
  const ev = []
  const log = {
    setIndex: 1,
    ts,
    event(type, payload = {}, extra = {}) {
      const at = seq++
      ev.push({ matchId, setIndex: this.setIndex, type, payload, seq: at, ts: this.ts, ...extra })
      return at
    },
    sub(at, payload) { ev.push({ matchId, setIndex: this.setIndex, type: 'lineup', payload, seq: at + 0.1, ts: this.ts }) },
    rally(team) {
      this.event('rally_start')
      this.event('point', { team })
    },
    startSet(index, lineups = { home: LINEUP, away: LINEUP }) {
      this.setIndex = index
      for (const team of ['home', 'away']) this.event('lineup', { team, lineup: lineups[team], isInitial: true })
      this.event('set_start')
    },
    endSet(index, team, homePoints, awayPoints, ts = this.ts) {
      ev.push({ matchId, setIndex: index, type: 'set_end', payload: { team, setIndex: index, homePoints, awayPoints }, seq: seq++, ts })
    },
    points(setIndex) {
      const p = ev.filter(e => e.type === 'point' && e.setIndex === setIndex)
      return { homePoints: p.filter(e => e.payload.team === 'home').length, awayPoints: p.filter(e => e.payload.team === 'away').length }
    },
    events: ev
  }
  return log
}

async function addMatch(teams, extra = {}) {
  return db.matches.add({
    homeTeamId: teams.home, awayTeamId: teams.away, status: 'live', test: false, bestOf: 5,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
    bench_home: [{ role: 'Coach', firstName: 'Cora', lastName: 'Coach' }, { role: 'Assistant Coach 1', firstName: 'Ada', lastName: 'Assist' }],
    bench_away: [{ role: 'Coach', firstName: 'Cleo', lastName: 'Trainer' }],
    ...extra
  })
}

// A finished set: a few rallies, the team's time-outs and substitutions (for
// the results' S and T), then its end
function playedSet(log, index, { winner, homePoints, awayPoints, extras = () => {} }) {
  log.startSet(index)
  log.rally('home')
  log.rally('away')
  extras(log)
  log.rally(winner)
  log.endSet(index, winner, homePoints, awayPoints)
}

// Sets 1-3 played (2:1), set 4 under way at 14:12 with everything the bench
// chips, the court discs, the liberos and the results tables show
async function setFourUnderWay() {
  const teams = await addTeams()
  const matchId = await addMatch(teams)
  const start = NOW - 95 * MIN
  const log = eventLog(matchId, iso(start))
  log.event('coin_toss')
  const setRows = []
  playedSet(log, 1, {
    winner: 'home', homePoints: 25, awayPoints: 20,
    extras: (l) => {
      l.event('timeout', { team: 'away' })
      l.sub(l.event('substitution', { team: 'home', position: 'II', playerOut: 2, playerIn: 8, isExceptional: false }), { team: 'home', lineup: { ...LINEUP, II: '8' }, fromSubstitution: true })
      l.event('sanction', { team: 'home', type: 'warning', playerType: 'player', playerNumber: 4, position: 'IV' })
    }
  })
  setRows.push({ index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: iso(start), endTime: iso(start + 25 * MIN) })
  log.ts = iso(start + 28 * MIN)
  playedSet(log, 2, {
    winner: 'away', homePoints: 22, awayPoints: 25,
    extras: (l) => {
      l.event('timeout', { team: 'home' })
      l.event('timeout', { team: 'home' })
      l.event('sanction', { team: 'home', type: 'warning', playerType: 'official', role: 'Coach' })
      l.event('libero_unable', { team: 'home', liberoNumber: 11, liberoType: 'libero2', reason: 'injury', autoRemark: 'Set 2, 18:40, A 1:1, Libero #11 becomes unable to play' })
      l.event('sanction', { team: 'away', type: 'penalty', playerType: 'player', playerNumber: 9, position: 'II' })
      // a bench player disqualified (out for the match)
      l.event('sanction', { team: 'away', type: 'disqualification', playerType: 'player', playerNumber: '8' })
    }
  })
  setRows.push({ index: 2, homePoints: 22, awayPoints: 25, finished: true, startTime: iso(start + 28 * MIN), endTime: iso(start + 52 * MIN) })
  log.ts = iso(start + 55 * MIN)
  playedSet(log, 3, {
    winner: 'home', homePoints: 25, awayPoints: 23,
    extras: (l) => {
      l.event('sanction', { team: 'away', type: 'delay_warning' })
      l.sub(l.event('substitution', { team: 'away', position: 'IV', playerOut: 4, playerIn: 10, isExceptional: false }), { team: 'away', lineup: { ...LINEUP, IV: '10' }, fromSubstitution: true })
      // home #4 expelled in set 3, #14 in for him (#4 plays again in set 4)
      l.event('sanction', { team: 'home', type: 'expulsion', playerType: 'player', playerNumber: 4, position: 'IV' })
      l.sub(l.event('substitution', { team: 'home', position: 'IV', playerOut: 4, playerIn: 14, isExpelled: true, isExceptional: false }), { team: 'home', lineup: { ...LINEUP, IV: '14' }, fromSubstitution: true })
    }
  })
  setRows.push({ index: 3, homePoints: 25, awayPoints: 23, finished: true, startTime: iso(start + 55 * MIN), endTime: iso(start + 80 * MIN) })

  // set 4
  log.ts = iso(start + 83 * MIN)
  log.startSet(4)
  for (const team of ['home', 'home', 'away', 'home']) log.rally(team)
  // home: #9 in for #5 (V), the libero #12 in for #6 (VI)
  let home = { ...LINEUP, V: '9' }
  log.sub(log.event('substitution', { team: 'home', position: 'V', playerOut: 5, playerIn: 9, isExceptional: false }), { team: 'home', lineup: home, fromSubstitution: true })
  home = { ...home, VI: '12' }
  log.sub(log.event('libero_entry', { team: 'home', position: 'VI', playerOut: 6, liberoIn: 12, liberoType: 'libero1' }), { team: 'home', lineup: home, liberoSubstitution: { position: 'VI', liberoNumber: 12, playerNumber: 6, liberoType: 'libero1' } })
  for (const team of ['away', 'away', 'home', 'away', 'home']) log.rally(team)
  // #5 back for #9 (the pair's cycle done)
  home = { ...home, V: '5' }
  log.sub(log.event('substitution', { team: 'home', position: 'V', playerOut: 9, playerIn: 5, isExceptional: false }), { team: 'home', lineup: home, fromSubstitution: true })
  log.event('timeout', { team: 'away' })
  for (const team of ['home', 'away', 'home']) log.rally(team)
  // away: the libero #14 in for #5 (V); #4 injured, replaced exceptionally by #7
  let away = { ...LINEUP, V: '14' }
  log.sub(log.event('libero_entry', { team: 'away', position: 'V', playerOut: 5, liberoIn: 14, liberoType: 'libero1' }), { team: 'away', lineup: away, liberoSubstitution: { position: 'V', liberoNumber: 14, playerNumber: 5, liberoType: 'libero1' } })
  away = { ...away, IV: '7' }
  log.sub(log.event('substitution', { team: 'away', position: 'IV', playerOut: 4, playerIn: 7, isInjury: true, isExceptional: true, autoRemark: 'Set 4, 19:20, A 7:6, #4 replaced due to injury' }), { team: 'away', lineup: away, fromSubstitution: true })
  for (const team of ['away', 'home', 'away', 'home', 'away']) log.rally(team)
  // home: #3 expelled, #10 in for him (legal); a warning for #2
  log.event('sanction', { team: 'home', type: 'expulsion', playerType: 'player', playerNumber: 3, position: 'III' })
  home = { ...home, III: '10' }
  log.sub(log.event('substitution', { team: 'home', position: 'III', playerOut: 3, playerIn: 10, isExpelled: true, isExceptional: false }), { team: 'home', lineup: home, fromSubstitution: true })
  log.event('sanction', { team: 'away', type: 'warning', playerType: 'player', playerNumber: 2, position: 'II' })
  for (const team of ['home', 'away', 'home', 'away', 'home']) log.rally(team)
  // home: #8 in for #2 (II), no rally since: #2 waits for a point
  log.event('timeout', { team: 'home' })
  for (const team of ['away', 'home', 'away']) log.rally(team)
  home = { ...home, II: '8' }
  log.sub(log.event('substitution', { team: 'home', position: 'II', playerOut: 2, playerIn: 8, isExceptional: false }), { team: 'home', lineup: home, fromSubstitution: true })
  log.rally('home')
  // away: #3 out for #11 (III) with no rally since: #3 waits for a point
  away = { ...away, III: '11' }
  log.sub(log.event('substitution', { team: 'away', position: 'III', playerOut: 3, playerIn: 11, isExceptional: false }), { team: 'away', lineup: away, fromSubstitution: true })
  const score = log.points(4)
  setRows.push({ index: 4, ...score, finished: false, startTime: iso(start + 83 * MIN) })
  for (const row of setRows) await db.sets.add({ matchId, ...row })
  await db.events.bulkAdd(log.events)
  return { matchId, score }
}

// Set 1 at 3:2, the last rally replayed: nothing can be requested
async function replayPending() {
  const teams = await addTeams()
  const matchId = await addMatch(teams)
  const log = eventLog(matchId, iso(NOW - 12 * MIN))
  log.event('coin_toss')
  log.startSet(1)
  for (const team of ['home', 'away', 'home', 'home', 'away']) log.rally(team)
  log.event('rally_start')
  log.event('replay')
  await db.sets.add({ matchId, index: 1, ...log.points(1), finished: false, startTime: iso(NOW - 12 * MIN) })
  await db.events.bulkAdd(log.events)
  return matchId
}

// The set before `nextIndex` ended 30 s ago: the interval runs (2:30 left)
async function intervalRunning(nextIndex = 2) {
  const teams = await addTeams()
  const matchId = await addMatch(teams)
  const start = NOW - 30 * MIN * nextIndex
  const log = eventLog(matchId, iso(start))
  log.event('coin_toss')
  for (let i = 1; i < nextIndex; i++) {
    const winner = i % 2 === 1 ? 'home' : 'away'
    const end = i === nextIndex - 1 ? NOW - 30 * 1000 : start + i * 28 * MIN
    log.ts = iso(start + (i - 1) * 28 * MIN)
    log.startSet(i)
    log.rally('home')
    log.event('timeout', { team: winner === 'home' ? 'away' : 'home' })
    log.rally(winner)
    const points = winner === 'home' ? [25, 18] : [19, 25]
    log.endSet(i, winner, points[0], points[1], iso(end))
    await db.sets.add({ matchId, index: i, homePoints: points[0], awayPoints: points[1], finished: true, startTime: iso(start + (i - 1) * 28 * MIN), endTime: iso(end) })
  }
  await db.sets.add({ matchId, index: nextIndex, homePoints: 0, awayPoints: 0, finished: false })
  await db.events.bulkAdd(log.events)
  return matchId
}

const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const court = (team, n) => document.querySelector(`.court-player[data-team="${team}"][data-player-number="${n}"]`)

const golden = (name) => `./__golden__/scoreboardRender.${name}.txt`

describe('the scoring screen draws the same (golden DOM, fixed time)', () => {
  it('set 4 under way: substitutions, an expulsion, an exceptional substitution, sanctions, liberos', async () => {
    window.innerWidth = 1280
    window.innerHeight = 800
    const { matchId } = await setFourUnderWay()
    mount(matchId)
    await waitFor(() => expect(court('home', 12)).toBeTruthy())
    await waitFor(() => expect(button('Start rally')).toBeTruthy())
    await expect(await settledDom()).toMatchFileSnapshot(golden('set4'))
  }, 60000)

  it('a replay pending: time-outs and substitutions closed', async () => {
    window.innerWidth = 1280
    window.innerHeight = 800
    const matchId = await replayPending()
    mount(matchId)
    await waitFor(() => expect(court('home', 5)).toBeTruthy())
    await waitFor(() => expect(button('Start rally')).toBeTruthy())
    await expect(await settledDom()).toMatchFileSnapshot(golden('replay'))
  }, 60000)

  it('the set interval running', async () => {
    window.innerWidth = 1280
    window.innerHeight = 800
    const matchId = await intervalRunning(2)
    mount(matchId)
    await waitFor(() => expect(button('End set interval')).toBeTruthy())
    await expect(await settledDom()).toMatchFileSnapshot(golden('interval'))
  }, 60000)

  it('the interval before the deciding set: its setup and countdown', async () => {
    window.innerWidth = 1280
    window.innerHeight = 800
    const matchId = await intervalRunning(5)
    mount(matchId)
    await waitFor(() => expect(button('Confirm set 5 setup')).toBeTruthy())
    await expect(await settledDom()).toMatchFileSnapshot(golden('set5setup'))
  }, 60000)

  it('phone layout: set 4 under way', async () => {
    window.innerWidth = 390
    window.innerHeight = 844
    const { matchId } = await setFourUnderWay()
    mount(matchId)
    await waitFor(() => expect(document.querySelector('[data-testid="phone-scoreboard"]')).toBeTruthy())
    await waitFor(() => expect(button('Start rally')).toBeTruthy())
    await expect(await settledDom()).toMatchFileSnapshot(golden('phone-set4'))
  }, 60000)

  it('phone layout: the set interval running', async () => {
    window.innerWidth = 390
    window.innerHeight = 844
    const matchId = await intervalRunning(2)
    mount(matchId)
    await waitFor(() => expect(document.querySelector('[data-testid="phone-countdown"]')).toBeTruthy())
    await expect(await settledDom()).toMatchFileSnapshot(golden('phone-interval'))
  }, 60000)
})
