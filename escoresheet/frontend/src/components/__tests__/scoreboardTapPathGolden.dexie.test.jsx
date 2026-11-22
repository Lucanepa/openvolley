// The tap path of the scoring screen, recorded: what a scorer action writes
// and sends must not change when its reads are made cheaper (perf pass
// 2026-11, "tap-path-reads"). Each case below scores on the real scoring
// screen over the app's Dexie database (fake IndexedDB) and dumps
//  - the events (in write order: id, type, seq, setIndex, payload, stateSnapshot),
//  - the sets,
//  - the sync_queue jobs (in write order, ids and ts left out),
//  - the live-state rows written to the cloud (apiFrom mocked) and
//  - the messages sent on the relay socket (a recording socket, no network),
// with times, uuids and epoch numbers replaced by placeholders. The dump is
// compared with __golden__/scoreboardTapPath.json, recorded on the code from
// before that pass (1fa05852a). OV_TAP_GOLDEN_WRITE=1 records it again.
//
// A read counter (every Dexie Collection.toArray) also pins how many reads
// of the events table each action makes inside its transaction: those lie
// between the tap and the painted score.
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'

const upserts = vi.hoisted(() => [])
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal()
  const result = { data: null, error: null }
  const chain = (table) => {
    const q = new Proxy({}, {
      get(_, key) {
        if (key === 'then') return (res, rej) => Promise.resolve(result).then(res, rej)
        if (key === 'upsert') return (row) => { upserts.push({ table, row }); return q }
        return () => q
      }
    })
    return q
  }
  return { ...actual, apiFrom: (table) => chain(table) }
})

import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { setExtId } from '../../utils/syncIds'
import { scorerLiveOrder } from '../../utils/relayPublisher'

const GOLDEN = resolve(__dirname, '__golden__/scoreboardTapPath.json')
const WRITE = !!process.env.OV_TAP_GOLDEN_WRITE
const golden = !WRITE && existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {}
const recorded = {}

// The relay: opens at once, records what is sent (no network)
const relaySent = []
class RecordingSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  constructor(url) {
    this.url = url
    this.readyState = 0
    setTimeout(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.({})
    }, 0)
  }
  send(text) {
    let message
    try { message = JSON.parse(text) } catch { message = text }
    relaySent.push(message)
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    setTimeout(() => this.onclose?.({}), 0)
  }
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

// Every Collection.toArray: its table, its index, and whether it ran inside a
// scorer action (runAction: one readwrite transaction over every table).
// OV_TAP_DEBUG=1 prints where each events read came from.
const DEBUG = !!process.env.OV_TAP_DEBUG
const reads = []
const installReadCounter = () => {
  const proto = Object.getPrototypeOf(db.events.toCollection())
  const toArray = proto.toArray
  vi.spyOn(proto, 'toArray').mockImplementation(function (...args) {
    const trans = Dexie.currentTransaction
    reads.push({
      table: this._ctx?.table?.name,
      index: this._ctx?.index ?? null,
      inAction: !!trans && trans.mode === 'readwrite' && trans.storeNames.length === db.tables.length,
      ...(DEBUG ? {
        trans: trans ? `${trans.mode}:${trans.storeNames.length}` : 'none',
        where: (new Error().stack || '').split('\n').filter(l => /Scoreboard\.jsx|useScorerActions|eventSync/.test(l)).slice(0, 3).map(l => l.replace(/.*\//, '').replace(/\)$/, '')).join(' < ')
      } : {})
    })
    return toArray.apply(this, args)
  })
}
// The reads a table had inside scorer actions since `from`; for the events:
// the whole match (index matchId) and one set ([matchId+setIndex])
const actionReadsSince = (from, table) => {
  const own = reads.slice(from).filter(r => r.inAction && r.table === table)
  if (DEBUG) for (const r of own) process.stderr.write(`  ${table} read ${r.index} ${r.trans} ${r.where}\n`)
  return own
}
const eventReadsSince = (from) => {
  const own = actionReadsSince(from, 'events')
  return {
    match: own.filter(r => r.index === 'matchId').length,
    set: own.filter(r => r.index === '[matchId+setIndex]').length
  }
}

let saved
beforeAll(() => {
  rejectionListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', filterRejections)
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, width: window.innerWidth, height: window.innerHeight }
  globalThis.WebSocket = RecordingSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  window.innerWidth = 1280
  window.innerHeight = 800
})
beforeEach(async () => {
  cleanup()
  localStorage.setItem('ov.corrections.view', 'list')
  localStorage.removeItem('displayMode')
  localStorage.removeItem('keybindingsEnabled')
  // a new database: the ids (and so the cloud ids) start at 1 in every case
  db.close()
  await db.delete()
  await db.open()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  installReadCounter()
  upserts.length = 0
  relaySent.length = 0
  reads.length = 0
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.removeItem('keybindingsEnabled')
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
  if (WRITE) {
    mkdirSync(dirname(GOLDEN), { recursive: true })
    const all = { ...(existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {}), ...recorded }
    const ordered = Object.fromEntries(Object.keys(all).sort().map(k => [k, all[k]]))
    writeFileSync(GOLDEN, JSON.stringify(ordered, null, 1) + '\n')
  }
})

// ---- the dump ----

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Written by the clock, not by the action (P1 of the pass changes the
// heartbeat): left out
const CLOCK_KEYS = new Set(['updatedAt', 'updated_at', '_timestamp', 'timestamp', 'lastHeartbeat', 'heartbeat'])
// The scorer's live-state order (relayPublisher scorerLiveOrder) counts for
// the whole test file: its numbers are kept relative to the case's start
const ORDER_KEYS = new Set(['_seq', '_syncedSeq'])
let orderBase = 0
function norm(value) {
  if (Array.isArray(value)) return value.map(norm)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (CLOCK_KEYS.has(k)) continue
      out[k] = ORDER_KEYS.has(k) && typeof v === 'number' ? v - orderBase : norm(v)
    }
    return out
  }
  if (typeof value === 'string' && ISO_TIME.test(value)) return '<time>'
  if (typeof value === 'string' && UUID.test(value)) return '<uuid>'
  if (typeof value === 'number' && value > 1e12 && value < 1e13) return '<ms>'
  return value
}

async function dump() {
  const events = (await db.events.toArray()).map(e => ({
    id: e.id, type: e.type, seq: e.seq, setIndex: e.setIndex, payload: e.payload, stateSnapshot: e.stateSnapshot ?? null
  }))
  const sets = (await db.sets.toArray()).map(({ updatedAt, ...s }) => s)
  const syncQueue = (await db.sync_queue.toArray()).map(({ id, ts, ...j }) => j)
  const liveState = upserts.filter(u => u.table === 'match_live_state').map(u => u.row)
  const relay = relaySent.filter(m => m?.type !== 'ping')
  return norm({ events, sets, syncQueue, liveState, relay })
}

// The events reads of an action inside its transaction (printed when recording)
function expectReads(name, got, want) {
  if (WRITE) {
    process.stderr.write(`[tap-path reads] ${name}: ${JSON.stringify(got)}\n`)
    return
  }
  expect(got, name).toEqual(want)
}

// The case's dump against the recorded one (both the values and their
// JSON text: the same keys in the same order)
async function expectGolden(name) {
  const got = await dump()
  // OV_TAP_RECEIVED=<file>: what this run dumped, to compare by hand
  if (process.env.OV_TAP_RECEIVED) {
    const file = process.env.OV_TAP_RECEIVED
    const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    writeFileSync(file, JSON.stringify({ ...all, [name]: got }, null, 1) + '\n')
  }
  if (WRITE) {
    recorded[name] = got
    return
  }
  expect(golden[name], `no golden dump "${name}" (OV_TAP_GOLDEN_WRITE=1 records it)`).toBeTruthy()
  expect(got).toEqual(golden[name])
  expect(JSON.stringify(got)).toBe(JSON.stringify(golden[name]))
}

// ---- driving the screen ----

const settle = () => new Promise(r => setTimeout(r, GHOST_CLICK_MS + 150))
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const findButton = (re) => [...document.querySelectorAll('button')].find(b => re.test(b.textContent.trim()) && !b.disabled)
const ofType = async (type) => (await db.events.toArray()).filter(e => e.type === type)
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const INK = 'data:image/png;base64,AAAA'
const HOME_LINEUP = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
const AWAY_LINEUP = { I: '11', II: '12', III: '13', IV: '14', V: '15', VI: '16' }
// The action's writes have landed and its effects (live state, relay) ran
const quiet = () => wait(1500)
// Only what the case's own taps send (not the mount's first sync)
const startRecording = () => {
  upserts.length = 0
  relaySent.length = 0
  orderBase = scorerLiveOrder.current()
  return reads.length
}

// Home 1-8 (captain 4), away 11-18 (captain 14; 18 a libero when asked)
async function teams({ awayLibero = false } = {}) {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM', color: '#dc2626' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY', color: '#2563eb' })
  const players = []
  for (let n = 1; n <= 8; n++) players.push({ teamId: home, number: n, lastName: `H${n}`, firstName: 'X', isCaptain: n === 4 })
  for (let n = 11; n <= 18; n++) {
    players.push({ teamId: away, number: n, lastName: `A${n}`, firstName: 'X', isCaptain: n === 14, ...(awayLibero && n === 18 ? { libero: 'libero1' } : {}) })
  }
  await db.players.bulkAdd(players)
  return { home, away }
}

// An official match (cloud jobs, live state), signed, home serving first
async function officialMatch(seed, { awayLibero = false, extra = {} } = {}) {
  const t = await teams({ awayLibero })
  return db.matches.add({
    homeTeamId: t.home, awayTeamId: t.away, status: 'live', test: false, bestOf: 5,
    seed_key: seed, externalId: '11111111-2222-4333-8444-' + String(seed.length).padStart(12, '0'),
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
    homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK,
    ...extra
  })
}

// Set 1 at 1:0, home's point last (home serves), both line-ups in
async function set1At1to0(matchId, { awayLineupRows = null } = {}) {
  const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 0, finished: false, startTime: ts })
  await db.events.bulkAdd([
    { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: HOME_LINEUP, isInitial: true }, seq: 2, ts },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: AWAY_LINEUP, isInitial: true }, seq: 3, ts },
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 4, ts },
    { matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: 5, ts },
    { matchId, setIndex: 1, type: 'point', payload: { team: 'home', score: { home: 1, away: 0 } }, seq: 6, ts },
    ...(awayLineupRows ? awayLineupRows(ts) : [])
  ])
}

// Set 1 won 25:20 by home (its rows in), set 2 at `score` with both line-ups
// in, home serving (its point last) unless it is 0:0
async function inSet2(matchId, { score = { home: 1, away: 0 }, lineups = ['home', 'away'], started = true } = {}) {
  const t1 = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const t1e = new Date(Date.now() - 35 * 60 * 1000).toISOString()
  const t2 = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.sets.add({ matchId, index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: t1, endTime: t1e })
  const rows = [
    { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: t1 },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: HOME_LINEUP, isInitial: true }, seq: 2, ts: t1 },
    { matchId, setIndex: 1, type: 'lineup', payload: { team: 'away', lineup: AWAY_LINEUP, isInitial: true }, seq: 3, ts: t1 },
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 4, ts: t1 }
  ]
  let seq = 5
  let h = 0
  let a = 0
  // 25:20, the rotations left out (the reads, not the rules, are under test)
  for (let i = 0; i < 45; i++) {
    const team = i < 40 && i % 2 === 1 ? 'away' : 'home'
    if (team === 'home') h++
    else a++
    rows.push({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t1 })
    rows.push({ matchId, setIndex: 1, type: 'point', payload: { team, score: { home: h, away: a } }, seq: seq++, ts: t1 })
  }
  rows.push({ matchId, setIndex: 1, type: 'set_end', payload: { team: 'home', teamLabel: 'A', setIndex: 1, homePoints: 25, awayPoints: 20, startTime: t1, endTime: t1e }, seq: seq++, ts: t1e })
  await db.sets.add({ matchId, index: 2, homePoints: score.home, awayPoints: score.away, finished: false, startTime: started ? t2 : null })
  for (const team of lineups) {
    rows.push({ matchId, setIndex: 2, type: 'lineup', payload: { team, lineup: team === 'home' ? HOME_LINEUP : AWAY_LINEUP, isInitial: true }, seq: seq++, ts: t2 })
  }
  if (started) {
    rows.push({ matchId, setIndex: 2, type: 'set_start', payload: {}, seq: seq++, ts: t2 })
    let sh = 0
    let sa = 0
    while (sh < score.home || sa < score.away) {
      // home's points last: home serves
      const team = sa < score.away ? 'away' : 'home'
      if (team === 'home') sh++
      else sa++
      rows.push({ matchId, setIndex: 2, type: 'rally_start', payload: {}, seq: seq++, ts: t2 })
      rows.push({ matchId, setIndex: 2, type: 'point', payload: { team, score: { home: sh, away: sa } }, seq: seq++, ts: t2 })
    }
  }
  await db.events.bulkAdd(rows)
  return (await db.sets.where('matchId').equals(matchId).toArray()).find(s => s.index === 2)
}

async function startRally() {
  await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
  await wait(GHOST_CLICK_MS + 600)
  const from = startRecording()
  fireEvent.click(button('Start rally'))
  await waitFor(async () => expect((await ofType('rally_start')).length).toBeGreaterThan(0), { timeout: 5000 })
  await waitFor(() => expect(findButton(/^Point [AB]/)).toBeTruthy(), { timeout: 5000 })
  await quiet()
  return eventReadsSince(from)
}

async function point(label, pointsAfter) {
  await wait(GHOST_CLICK_MS + 600)
  const from = startRecording()
  fireEvent.click(findButton(new RegExp(`^Point ${label}`)))
  await waitFor(async () => expect(await ofType('point')).toHaveLength(pointsAfter), { timeout: 8000 })
  await quiet()
  return { ...eventReadsSince(from), queueValues: actionReadsSince(from, 'sync_queue').length }
}

describe('the tap path, recorded', () => {
  it('a point without a side-out (the serving team scores)', async () => {
    const matchId = await officialMatch('seed-golden-no-sideout')
    await set1At1to0(matchId)
    mount(matchId)
    const rally = await startRally()
    // readRallyStatus + the first-rally check
    expectReads('rallyStart', rally, { match: 2, set: 0 })
    await expectGolden('rallyStart')
    const reads = await point('A', 2)
    // readRallyStatus, the serve before the point, the point's snapshot, the
    // action's final snapshot; the queued jobs (queueSetScoreSync)
    expectReads('pointNoSideOut', reads, { match: 4, set: 0, queueValues: 1 })
    await expectGolden('pointNoSideOut')
  }, 90000)

  it('a side-out point: the rotation, the server, its cloud job', async () => {
    const matchId = await officialMatch('seed-golden-sideout')
    await set1At1to0(matchId)
    mount(matchId)
    await startRally()
    const reads = await point('B', 2)
    // + writeSideOutRows' own read of the line-ups
    expectReads('pointSideOut', reads, { match: 5, set: 0, queueValues: 1 })
    await expectGolden('pointSideOut')
  }, 90000)

  it('a side-out that takes the libero to the front row: his automatic exit', async () => {
    const matchId = await officialMatch('seed-golden-libero', { awayLibero: true })
    // away's libero 18 in for 15 at V: the rotation takes him to IV
    await set1At1to0(matchId, {
      awayLineupRows: (ts) => [
        { matchId, setIndex: 1, type: 'libero_entry', payload: { team: 'away', position: 'V', playerOut: 15, liberoIn: 18, liberoType: 'libero1' }, seq: 7, ts },
        {
          matchId, setIndex: 1, type: 'lineup', seq: 7.1, ts,
          payload: {
            team: 'away',
            lineup: { ...AWAY_LINEUP, V: '18' },
            liberoSubstitution: { position: 'V', liberoNumber: 18, playerNumber: 15, liberoType: 'libero1' }
          }
        }
      ]
    })
    mount(matchId)
    await startRally()
    const reads = await point('B', 2)
    // + the libero branch's read, the libero_exit's own snapshot. Fewer here:
    // under jsdom the action loses its transaction zone after the libero
    // exit (see isEnvPrematureCommit), and the rest reads outside it
    expectReads('pointSideOutLiberoExit', reads, { match: 5, set: 0, queueValues: 0 })
    expect(await ofType('libero_exit')).toHaveLength(1)
    await expectGolden('pointSideOutLiberoExit')
  }, 90000)

  it('penalty points owed from before the line-ups: each awarded as a point, with its rotation', async () => {
    const matchId = await officialMatch('seed-golden-owed')
    const ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false, startTime: null })
    // a penalty to each team before away's line-up was in: away's point
    // first (a side-out: away rotates), then home's (home rotates)
    await db.events.bulkAdd([
      { matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts },
      { matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: HOME_LINEUP, isInitial: true }, seq: 2, ts },
      { matchId, setIndex: 1, type: 'sanction', payload: { team: 'home', type: 'delay_penalty' }, seq: 3, ts },
      { matchId, setIndex: 1, type: 'sanction', payload: { team: 'away', type: 'delay_penalty' }, seq: 4, ts }
    ])
    mount(matchId)
    const open = () => [...document.querySelectorAll('button')].find(b => /^Line-?up\s*B/.test(b.textContent.trim()) && !b.disabled)
    await waitFor(() => expect(open()).toBeTruthy(), { timeout: 15000 })
    await settle()
    fireEvent.click(open())
    await waitFor(() => expect(document.querySelector('[role=dialog]')).toBeTruthy())
    const dialog = () => document.querySelector('[role=dialog]')
    const chip = (text) => [...dialog().querySelectorAll('*')].filter(e => e.textContent.replace(/\s+/g, '') === text).pop()
    for (const n of ['11', '12', '13', 'C14', '15', '16']) {
      fireEvent.click(chip(n))
      await wait(30)
    }
    const from = startRecording()
    fireEvent.click([...dialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await waitFor(async () => expect(await ofType('point')).toHaveLength(2), { timeout: 10000 })
    await quiet()
    const own = eventReadsSince(from)
    // the line-up save's reads, then per point: the serve before it, a
    // side-out's line-ups, its snapshot; the final snapshot
    expectReads('owedPenaltyPoints', own, { match: 8, set: 0 })
    await expectGolden('owedPenaltyPoints')
  }, 90000)

  it('the first rally of a set: the line-up gate, then the start time and the first rally', async () => {
    localStorage.setItem('keybindingsEnabled', 'true')
    const matchId = await officialMatch('seed-golden-first-rally')
    await inSet2(matchId, { score: { home: 0, away: 0 }, lineups: ['home'], started: false })
    mount(matchId)
    await waitFor(() => expect([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Start set')).toBeTruthy(), { timeout: 15000 })
    await settle()
    // Enter (keyboard scoring) without away's line-up: refused, nothing written
    let from = startRecording()
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => expect(document.body.textContent).toMatch(/Enter both starting line-ups first/), { timeout: 5000 })
    await quiet()
    // the rally status read, the first-rally / line-up read
    expectReads('firstRallyGate', eventReadsSince(from), { match: 2, set: 0 })
    await expectGolden('firstRallyGate')

    // away's line-up in (as the line-up dialog writes it): Start set asks the
    // set's start time, then starts the first rally
    const t2 = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const maxSeq = Math.max(...(await db.events.toArray()).map(e => e.seq || 0))
    await db.events.add({ matchId, setIndex: 2, type: 'lineup', payload: { team: 'away', lineup: AWAY_LINEUP, isInitial: true }, seq: Math.floor(maxSeq) + 1, ts: t2 })
    await waitFor(() => expect(button('Start set')).toBeTruthy(), { timeout: 10000 })
    await settle()
    from = startRecording()
    fireEvent.click(button('Start set'))
    await waitFor(() => expect(document.body.textContent).toMatch(/Set 2 start time/), { timeout: 8000 })
    expectReads('firstRallyStartSet', eventReadsSince(from), { match: 2, set: 0 })
    await settle()
    fireEvent.click(findButton(/^Confirm$/))
    await waitFor(async () => expect((await ofType('rally_start')).filter(e => e.setIndex === 2)).toHaveLength(1), { timeout: 8000 })
    await quiet()
    await expectGolden('firstRallyStarted')
  }, 90000)

  it('a time-out: the request, then its confirmation', async () => {
    const matchId = await officialMatch('seed-golden-timeout')
    await set1At1to0(matchId)
    mount(matchId)
    await waitFor(() => expect(button('Start rally')).toBeTruthy(), { timeout: 15000 })
    await settle()
    startRecording()
    fireEvent.click(document.querySelector('[data-help-id="scoreboard-timeout-left"]'))
    await waitFor(() => expect(button('Confirm')).toBeTruthy(), { timeout: 8000 })
    await settle()
    const from = startRecording()
    fireEvent.click(button('Confirm'))
    await waitFor(async () => expect(await ofType('timeout')).toHaveLength(1), { timeout: 8000 })
    await quiet()
    // confirmTimeout's rally check, the time-out's snapshot, the final snapshot
    expectReads('timeoutConfirm', eventReadsSince(from), { match: 3, set: 0 })
    await expectGolden('timeout')
  }, 90000)

  it('offline with a long queue: one score job per set stays queued', async () => {
    const seed = 'seed-golden-offline'
    const matchId = await officialMatch(seed)
    const set2 = await inSet2(matchId, { score: { home: 3, away: 2 } })
    const set1 = (await db.sets.where('matchId').equals(matchId).toArray()).find(s => s.index === 1)
    const now = Date.now()
    const snapshot = { currentSetIndex: 2, pointsA: 3, pointsB: 2, lineup: HOME_LINEUP, filler: 'x'.repeat(40) }
    const jobs = []
    for (let i = 0; i < 50; i++) {
      jobs.push({ resource: 'event', action: 'insert', payload: { external_id: `${seed}:e:${9000 + i}`, match_id: seed, type: 'point', seq: 100 + i, state_snapshot: snapshot }, ts: now - 50000 + i, status: 'queued' })
    }
    const score = (set, home, away) => ({ external_id: setExtId(seed, set.id), home_points: home, away_points: away })
    // older score-only jobs of set 2: dropped by the next point
    jobs.push({ resource: 'set', action: 'update', payload: score(set2, 2, 2), ts: now - 4000, status: 'queued' })
    jobs.push({ resource: 'set', action: 'update', payload: score(set2, 3, 2), ts: now - 3000, status: 'queued' })
    // kept: another set's, one already sent, one in error, one that is not score-only
    jobs.push({ resource: 'set', action: 'update', payload: score(set1, 25, 20), ts: now - 9000, status: 'queued' })
    for (let i = 0; i < 20; i++) jobs.push({ resource: 'set', action: 'update', payload: score(set2, 1, i % 3), ts: now - 20000 + i, status: 'sent' })
    jobs.push({ resource: 'set', action: 'update', payload: score(set2, 3, 1), ts: now - 5000, status: 'error' })
    jobs.push({ resource: 'set', action: 'update', payload: { ...score(set2, 0, 0), start_time: new Date(now - 30 * 60 * 1000).toISOString() }, ts: now - 6000, status: 'queued' })
    await db.sync_queue.bulkAdd(jobs)
    mount(matchId)
    await startRally()
    const reads = await point('A', 45 + 5 + 1)
    // the queued jobs read with their values (each event job's snapshot)
    expectReads('offlineQueue', reads, { match: 4, set: 0, queueValues: 1 })
    const queued = (await db.sync_queue.toArray()).filter(j => j.resource === 'set' && j.status === 'queued')
    expect(queued.map(j => [j.payload.home_points, j.payload.away_points, 'start_time' in j.payload])).toEqual([[25, 20, false], [0, 0, true], [4, 2, false]])
    await expectGolden('offlineQueue')
  }, 90000)
})
