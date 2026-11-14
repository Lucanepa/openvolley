// A match continued on another device (the scoring tablet failed; restore
// by game number + PIN, "Take back scoring here"). What the scorer changed
// during the match must be on the server, or the device that continues has
// the old state:
//  - a decision change (the point given to the other team): the set row kept
//    the old score and the device that continued scored on from it;
//  - a libero re-designation: the libero marks stayed on the scoring device,
//    so the next one had no usable libero and asked for a re-designation
//    again (and the starting line-up dialog opened mid-set on the scoring
//    device when the new libero had started the set);
//  - bench officials edited in "Edit roster" during the match (and a double
//    tap on its Save added a new player twice).
// The import (importMatchFromSupabase) also brings the officials and the
// bench into the app's shape, both coin toss serves, leaves the pending
// roster of a started match out and applies a re-designation an older app
// never sent with the roster.
//
// Device A: the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with taps. What it queues for the cloud becomes the
// server's copy. Device B: a fresh database that continues the match
// (fetchMatchByPin + importMatchFromSupabase). Invented names only.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react'

const byPin = vi.hoisted(() => ({ result: null }))
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    apiMatchRestoreByPin: vi.fn(async () => byPin.result),
    apiMatchScorer: vi.fn(async () => ({ data: null, error: { status: 0, network: true } }))
  }
})

import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'
import { GHOST_CLICK_MS } from '../../hooks/useConfirmAction'
import { queueEventSync } from '../../utils/eventSync'
import { fetchMatchByPin, importMatchFromSupabase } from '../../utils/backupManager'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// As in ScoreboardLineupRowsContinue.test.jsx: under jsdom + fake-indexeddb a
// scorer action can lose Dexie's transaction zone part-way and end with
// PrematureCommitError (not in Chrome). Only that error is let through.
const isEnvPrematureCommit = (reason) => reason?.name === 'PrematureCommitError'
let rejectionListeners = []
const filterRejections = (reason, promise) => {
  if (isEnvPrematureCommit(reason)) return
  for (const listener of rejectionListeners) listener(reason, promise)
}

let saved
beforeAll(async () => {
  rejectionListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', filterRejections)
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, width: window.innerWidth, height: window.innerHeight }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  window.innerWidth = 1280
  window.innerHeight = 800
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  localStorage.removeItem('displayMode')
  await db.open()
})
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(t => t.clear()))
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
  vi.restoreAllMocks()
})

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const settle = () => wait(GHOST_CLICK_MS + 150)
const INK = 'data:image/png;base64,AAAA'
const GAME_N = 4713
const PIN = '123456'
const AWAY = [21, 22, 23, 24, 25, 26, 27, 28]

const findButton = (re, root = document) => [...root.querySelectorAll('button')].find(b => re.test(b.textContent.trim()) && !b.disabled)
const dialog = (re) => [...document.querySelectorAll('[role="dialog"]')].find(d => re.test(d.textContent))
const disc = (team, n) => document.querySelector(`.court-player[data-team="${team}"][data-player-number="${n}"]`)
const lineupInputs = () => [...document.querySelectorAll('input')].filter(i => /Player at position/.test(i.getAttribute('aria-label') || ''))
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const playersOf = async (teamId) => db.players.where('teamId').equals(teamId).toArray()
const mark = (players, n) => players.find(p => Number(p.number) === n)?.libero

// Device A in set 1 at 1:0 (home, team A, won the first rally and serves):
// rosters, signatures and the events queued so far, as the app queues them
async function setUpDeviceA({ seed, home = [1, 2, 3, 4, 5, 6, 7, 8], liberos = {}, bench = [], extraEvents = [] }) {
  const homeId = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const awayId = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  await db.players.bulkAdd([
    ...home.map(n => ({ teamId: homeId, number: n, name: `H${n} X`, firstName: 'X', lastName: `H${n}`, libero: liberos[n] || '' })),
    ...AWAY.map(n => ({ teamId: awayId, number: n, name: `A${n} X`, firstName: 'X', lastName: `A${n}`, libero: '' }))
  ])
  const matchId = await db.matches.add({
    homeTeamId: homeId, awayTeamId: awayId, status: 'live', test: false, bestOf: 5, seed_key: seed, gamePin: PIN, gameN: GAME_N, gameNumber: String(GAME_N),
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false, coinTossConfirmed: true,
    homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK,
    bench_home: bench, bench_away: []
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const setId = await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 0, finished: false, startTime: t })
  let seq = 1
  const add = async (e) => queueEventSync(db, await db.events.add({ matchId, setIndex: 1, seq: seq++, ts: t, ...e }))
  await add({ type: 'coin_toss', payload: {} })
  await add({ type: 'lineup', payload: { team: 'home', lineup: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }, isInitial: true } })
  await add({ type: 'lineup', payload: { team: 'away', lineup: { I: '21', II: '22', III: '23', IV: '24', V: '25', VI: '26' }, isInitial: true } })
  await add({ type: 'set_start', payload: {} })
  await db.events.add({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
  await add({ type: 'point', payload: { team: 'home', score: { home: 1, away: 0 } } })
  for (const e of extraEvents) {
    const base = seq++
    await queueEventSync(db, await db.events.add({ matchId, setIndex: 1, seq: base, ts: t, type: e.type, payload: e.payload }))
    // its line-up sub-row (N.1), as the scoreboard writes and queues it
    if (e.lineup) await queueEventSync(db, await db.events.add({ matchId, setIndex: 1, seq: base + 0.1, ts: t, type: 'lineup', payload: e.lineup }))
  }
  return { matchId, setId, homeId, awayId }
}

// The cloud row as Match setup and the coin toss sent it before the first serve
const cloudMatch = ({ seed, home, liberos = {}, bench = [] }) => ({
  id: '44444444-4444-4444-8444-444444444444', external_id: seed, game_n: GAME_N, status: 'live', test: false, sport_type: 'indoor',
  home_team: { name: 'Home VC', short_name: 'HOM' }, away_team: { name: 'Away VC', short_name: 'AWY' },
  players_home: home.map(n => ({ number: n, first_name: 'X', last_name: `H${n}`, libero: liberos[n] || '' })),
  players_away: AWAY.map(n => ({ number: n, first_name: 'X', last_name: `A${n}`, libero: '' })),
  bench_home: bench, bench_away: [],
  coin_toss: { team_a: 'home', team_b: 'away', serve_a: true, confirmed: true, first_serve: 'home' },
  signatures: { home_coach: INK, home_captain: INK, away_coach: INK, away_captain: INK },
  match_info: { best_of: 5 }, created_at: new Date(Date.now() - 3600e3).toISOString()
})

// The server's copy once every job device A queued has run, in order: event
// inserts (edits applied, voids removed), the set rows' scores and the
// match columns (a JSON array replaces the stored one)
async function serverAfterQueue({ match, sets }) {
  const jobs = (await db.sync_queue.toArray()).sort((a, b) => a.id - b.id)
  const events = new Map()
  const outSets = sets.map(s => ({ ...s }))
  const outMatch = { ...match }
  for (const j of jobs) {
    const p = j.payload || {}
    if (j.resource === 'event' && j.action === 'insert') {
      events.set(p.external_id, { external_id: p.external_id, set_index: p.set_index, seq: p.seq, type: p.type, payload: p.payload, ts: p.created_at, created_at: p.created_at })
    } else if (j.resource === 'event' && j.action === 'edit' && events.has(p.external_id) && p.after) {
      const row = events.get(p.external_id)
      events.set(p.external_id, { ...row, ...(p.after.type ? { type: p.after.type } : {}), ...(p.after.payload ? { payload: p.after.payload } : {}) })
    } else if (j.resource === 'event' && j.action === 'void') {
      events.delete(p.external_id)
    } else if (j.resource === 'set' && j.action === 'update') {
      const row = outSets.find(s => s.external_id === p.external_id)
      if (row && p.home_points !== undefined) row.home_points = p.home_points
      if (row && p.away_points !== undefined) row.away_points = p.away_points
    } else if (j.resource === 'match' && j.action === 'update') {
      const { id, ...columns } = p
      Object.assign(outMatch, columns)
    }
  }
  return { data: { match: outMatch, sets: outSets, events: [...events.values()].sort((a, b) => a.seq - b.seq), liveState: null }, error: null }
}

const setRow = (seed, setId) => ({ external_id: `${seed}:s:${setId}`, index: 1, home_points: 1, away_points: 0, finished: false, start_time: new Date(Date.now() - 30 * 60e3).toISOString() })

// Device B: a fresh database continues the match from the server's copy
async function continueOnDeviceB(answer) {
  byPin.result = answer
  await Promise.all(db.tables.map(t => t.clear()))
  return importMatchFromSupabase(await fetchMatchByPin(PIN, GAME_N))
}

const queuedMatchUpdates = async () => (await db.sync_queue.toArray())
  .filter(j => j.resource === 'match' && j.action === 'update')
  .sort((a, b) => a.id - b.id)
  .map(j => j.payload)

describe('Scoreboard: what the scorer changes during the match reaches the device that continues it', () => {
  it('decision change: the swapped set score and the decision go to the server; the other device has the same score', async () => {
    const seed = 'match_1799999999999_contdecision'
    const { matchId, setId } = await setUpDeviceA({ seed })
    const viewA = mount(matchId)
    await waitFor(() => expect(findButton(/^Decision change$/)).toBeTruthy(), { timeout: 15000 })
    await settle()
    fireEvent.click(findButton(/^Decision change$/))
    await waitFor(() => expect(dialog(/Decision change/) && findButton(/^Confirm$/, dialog(/Decision change/))).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(findButton(/^Confirm$/, dialog(/Decision change/)))
    await waitFor(async () => expect((await db.events.toArray()).some(e => e.type === 'decision_change')).toBe(true), { timeout: 5000 })
    await wait(800)

    const setA = await db.sets.get(setId)
    expect([setA.homePoints, setA.awayPoints]).toEqual([0, 1])
    const jobs = await db.sync_queue.toArray()
    const setJobs = jobs.filter(j => j.resource === 'set' && j.action === 'update' && j.payload.external_id === `${seed}:s:${setId}`)
    expect(setJobs.map(j => [j.payload.home_points, j.payload.away_points])).toEqual([[0, 1]])
    const decision = (await db.events.toArray()).find(e => e.type === 'decision_change')
    const insert = jobs.find(j => j.resource === 'event' && j.action === 'insert' && j.payload.type === 'decision_change')
    expect(insert?.payload).toMatchObject({ external_id: `${seed}:e:${decision.id}`, seq: decision.seq, payload: { reason: 'point_swap', fromTeam: 'home', toTeam: 'away' } })
    // the undo record (local ids) is the device's own bookkeeping: no edit job for it
    expect(jobs.filter(j => j.resource === 'event' && j.action === 'edit' && j.payload.type === 'decision_change')).toHaveLength(0)
    viewA.unmount()
    cleanup()
    await wait(300)

    const home = [1, 2, 3, 4, 5, 6, 7, 8]
    const answer = await serverAfterQueue({ match: cloudMatch({ seed, home }), sets: [setRow(seed, setId)] })
    const newId = await continueOnDeviceB(answer)
    const setB = (await db.sets.where('matchId').equals(newId).toArray())[0]
    expect([setB.homePoints, setB.awayPoints]).toEqual([0, 1])
    const eventsB = await db.events.where('matchId').equals(newId).toArray()
    expect(eventsB.filter(e => e.type === 'point').map(e => e.payload.team)).toEqual(['away'])
    expect(eventsB.some(e => e.type === 'decision_change')).toBe(true)
  }, 120000)

  it('libero re-designation: the marks reach the server and its undo too; no starting line-up dialog in the middle of the set', async () => {
    const seed = 'match_1799999999999_contredesig'
    // #10 the only home libero, declared unable; starter #1 was replaced by #7
    const home = [1, 2, 3, 4, 5, 6, 7, 8, 10]
    const { matchId, setId, homeId } = await setUpDeviceA({
      seed,
      home,
      liberos: { 10: 'libero1' },
      extraEvents: [
        { type: 'substitution', payload: { team: 'home', position: 'I', playerOut: 1, playerIn: 7 }, lineup: { team: 'home', lineup: { I: '7', II: '2', III: '3', IV: '4', V: '5', VI: '6' }, fromSubstitution: true } },
        { type: 'libero_unable', payload: { team: 'home', liberoNumber: 10, liberoType: 'libero1', reason: 'declared' } }
      ]
    })
    const viewA = mount(matchId)
    await waitFor(() => expect(findButton(/^Start rally$/)).toBeTruthy(), { timeout: 15000 })
    await waitFor(() => expect(findButton(/^Redesignate libero$/)).toBeTruthy(), { timeout: 15000 })
    await settle()
    fireEvent.click(findButton(/^Redesignate libero$/))
    // the starter who left the court is a candidate
    await waitFor(() => expect(findButton(/^#1 /)).toBeTruthy(), { timeout: 5000 })
    await settle()
    fireEvent.click(findButton(/^#1 /))
    await waitFor(async () => expect(mark(await playersOf(homeId), 1)).toBe('redesignated'), { timeout: 5000 })
    await wait(1500)

    // #1 started the set, but the set is under way: no starting line-up to enter again
    expect(lineupInputs()).toHaveLength(0)
    expect(mark(await playersOf(homeId), 10)).toBe('unable')
    let rosters = (await queuedMatchUpdates()).filter(u => u.players_home)
    expect(rosters).toHaveLength(1)
    expect(mark(rosters[0].players_home, 1)).toBe('redesignated')
    expect(mark(rosters[0].players_home, 10)).toBe('unable')
    // the server's copy as it is now, for device B below
    const answer = await serverAfterQueue({ match: cloudMatch({ seed, home, liberos: { 10: 'libero1' } }), sets: [setRow(seed, setId)] })

    // Undo puts the marks back, on the server too
    await waitFor(() => expect(findButton(/^Undo/)).toBeTruthy(), { timeout: 10000 })
    await settle()
    fireEvent.click(findButton(/^Undo/))
    await waitFor(() => expect(findButton(/^Yes/)).toBeTruthy())
    fireEvent.click(findButton(/^Yes/))
    await waitFor(async () => expect(mark(await playersOf(homeId), 1)).toBe(''), { timeout: 5000 })
    await wait(800)
    expect(mark(await playersOf(homeId), 10)).toBe('libero1')
    rosters = (await queuedMatchUpdates()).filter(u => u.players_home)
    expect(rosters).toHaveLength(2)
    expect(mark(rosters[1].players_home, 1)).toBe('')
    expect(mark(rosters[1].players_home, 10)).toBe('libero1')
    viewA.unmount()
    cleanup()
    await wait(300)

    // device B continues after the re-designation: #1 is the team's libero
    const newId = await continueOnDeviceB(answer)
    const m = await db.matches.get(newId)
    const playersB = await playersOf(m.homeTeamId)
    expect(mark(playersB, 1)).toBe('redesignated')
    expect(mark(playersB, 10)).toBe('unable')
    mount(newId)
    await waitFor(() => expect(findButton(/^Start rally$/)).toBeTruthy(), { timeout: 15000 })
    await wait(500)
    expect(findButton(/^Redesignate libero$/)).toBeFalsy()
    expect(lineupInputs()).toHaveLength(0)

    // ...and can take it back there: the event names device A's player ids,
    // the marks are found by the team's shirt numbers
    await settle()
    fireEvent.click(findButton(/^Undo/))
    await waitFor(() => expect(findButton(/^Yes/)).toBeTruthy())
    fireEvent.click(findButton(/^Yes/))
    await waitFor(async () => expect(mark(await playersOf(m.homeTeamId), 1)).toBe(''), { timeout: 5000 })
    expect(mark(await playersOf(m.homeTeamId), 10)).toBe('libero1')
    expect((await db.players.toArray()).filter(p => p.libero === 'redesignated' || p.libero === 'unable')).toHaveLength(0)
    await wait(500)
    rosters = (await queuedMatchUpdates()).filter(u => u.players_home)
    expect(mark(rosters[rosters.length - 1].players_home, 10)).toBe('libero1')
  }, 120000)

  it('Edit roster during the match: the bench officials reach the server; a double tap on Save adds the new player once', async () => {
    const seed = 'match_1799999999999_contbench'
    const home = [1, 2, 3, 4, 5, 6, 7, 8]
    const bench = [{ role: 'Coach', firstName: 'X', lastName: 'Coachone', dob: '' }]
    const { matchId, setId, homeId } = await setUpDeviceA({ seed, home, bench })
    const viewA = mount(matchId)
    await waitFor(() => expect(disc('home', 3)).toBeTruthy(), { timeout: 15000 })
    await waitFor(() => expect(findButton(/^Start rally$/)).toBeTruthy(), { timeout: 15000 })
    await settle()

    const matchButton = findButton(/^Match$/) || [...document.querySelectorAll('button')].find(b => /^Match$/.test(b.getAttribute('aria-label') || b.title || ''))
    fireEvent.click(matchButton)
    const editItem = () => [...document.querySelectorAll('button,[role="menuitem"]')].find(b => /Edit home roster/.test(b.textContent))
    await waitFor(() => expect(editItem()).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(editItem())
    await waitFor(() => expect(dialog(/Reopen roster/) && findButton(/^Reopen$/, dialog(/Reopen roster/))).toBeTruthy(), { timeout: 5000 })
    fireEvent.click(findButton(/^Reopen$/, dialog(/Reopen roster/)))
    await waitFor(() => expect([...document.querySelectorAll('input')].some(i => i.value === 'Coachone')).toBe(true), { timeout: 5000 })
    fireEvent.change([...document.querySelectorAll('input')].find(i => i.value === 'Coachone'), { target: { value: 'Coachtwo' } })
    fireEvent.click(findButton(/^\+ Add player$/))
    await wait(100)
    const numbers = screen.getAllByLabelText('Player number')
    fireEvent.change(numbers[numbers.length - 1], { target: { value: '12' } })
    await wait(200)

    // the tablet registers Save twice
    const save = findButton(/^Save changes$/)
    fireEvent.click(save)
    fireEvent.click(save)
    await wait(80)
    fireEvent.click(save)
    await waitFor(async () => expect((await db.matches.get(matchId))?.bench_home?.[0]?.lastName).toBe('Coachtwo'), { timeout: 5000 })
    await waitFor(() => expect(findButton(/^Save changes$/)).toBeFalsy(), { timeout: 5000 })
    await wait(1000)

    expect((await playersOf(homeId)).filter(p => Number(p.number) === 12)).toHaveLength(1)
    const local = await db.matches.get(matchId)
    expect(String(local.remarks || '').split('\n').filter(l => /Roster change after coin toss/.test(l))).toHaveLength(1)
    const updates = await queuedMatchUpdates()
    const benchUpdates = updates.filter(u => u.bench_home)
    expect(benchUpdates).toHaveLength(1)
    expect(benchUpdates[0].bench_home).toEqual([{ role: 'Coach', first_name: 'X', last_name: 'Coachtwo', dob: null }])
    const rosters = updates.filter(u => u.players_home)
    expect(rosters).toHaveLength(1)
    expect(rosters[0].players_home.filter(p => Number(p.number) === 12)).toHaveLength(1)
    viewA.unmount()
    cleanup()
    await wait(300)

    const answer = await serverAfterQueue({
      match: cloudMatch({ seed, home, bench: [{ role: 'Coach', first_name: 'X', last_name: 'Coachone', dob: null }] }),
      sets: [setRow(seed, setId)]
    })
    const newId = await continueOnDeviceB(answer)
    const m = await db.matches.get(newId)
    expect(m.bench_home).toEqual([{ role: 'Coach', firstName: 'X', lastName: 'Coachtwo', dob: null }])
    expect((await playersOf(m.homeTeamId)).filter(p => Number(p.number) === 12)).toHaveLength(1)
  }, 120000)
})

describe('importMatchFromSupabase: the continuing device has the scoring device\'s match', () => {
  const seed = 'match_1799999999999_contimport'
  const row = (over = {}) => ({
    ...cloudMatch({ seed, home: [1, 2, 3, 4, 5, 6, 7, 8, 10], liberos: { 10: 'libero1' } }),
    // B (home) served first: Team A (away) did not
    coin_toss: { team_a: 'away', team_b: 'home', serve_a: false, confirmed: true, first_serve: 'home' },
    officials: [
      { role: '1st referee', first_name: 'Rita', last_name: 'Example', country: 'CHE', dob: '1980-03-15', email: 'rita@example.org' },
      { role: 'scorer', firstName: 'Sina', lastName: 'Sample', country: 'CHE', dob: '02.04.1990' },
      { role: 'line judge 1', name: 'Lou Line' }
    ],
    bench_home: [{ role: 'Coach', first_name: 'Cora', last_name: 'Coach', dob: '15.05.1975' }],
    bench_away: [{ role: 'Assistant coach 1', firstName: 'Ari', lastName: 'Assist', dob: '' }],
    connections: { referee_enabled: true, pending_home_roster: { players: [{ number: 9, firstName: 'Uma', lastName: 'Upload' }] } },
    ...over
  })
  const importRow = (match, events = []) => importMatchFromSupabase({ match, sets: [], events })

  it('officials and bench in the app shape, Team A and B with both serves, no pending roster of a started match', async () => {
    const m = await db.matches.get(await importRow(row()))
    expect(m.officials).toEqual([
      { role: '1st referee', firstName: 'Rita', lastName: 'Example', country: 'CHE', dob: '15.03.1980', email: 'rita@example.org' },
      { role: 'scorer', firstName: 'Sina', lastName: 'Sample', country: 'CHE', dob: '02.04.1990' },
      { role: 'line judge 1', name: 'Lou Line' }
    ])
    expect(m.bench_home).toEqual([{ role: 'Coach', firstName: 'Cora', lastName: 'Coach', dob: '15.05.1975' }])
    expect(m.bench_away).toEqual([{ role: 'Assistant coach 1', firstName: 'Ari', lastName: 'Assist', dob: '' }])
    expect({ a: m.coinTossTeamA, b: m.coinTossTeamB, serveA: m.coinTossServeA, serveB: m.coinTossServeB, first: m.firstServe })
      .toEqual({ a: 'away', b: 'home', serveA: false, serveB: true, first: 'home' })
    expect(m.pendingHomeRoster ?? null).toBeNull()
    expect(m.pendingAwayRoster ?? null).toBeNull()
  })

  it('a match still in setup keeps the roster waiting for Accept', async () => {
    const m = await db.matches.get(await importRow(row({ status: 'setup' })))
    expect(m.pendingHomeRoster).toEqual({ players: [{ number: 9, firstName: 'Uma', lastName: 'Upload' }] })
  })

  it('a re-designation the cloud roster lacks (sent by an older app) is applied; a roster that has it stays as it is', async () => {
    const event = (seq, unable, next) => ({
      external_id: `${seed}:e:${seq}`, set_index: 1, seq, type: 'libero_redesignation', ts: new Date().toISOString(),
      payload: { team: 'home', unableLiberoNumber: unable, unableLiberoType: 'libero1', newLiberoNumber: next, reason: 'declared' }
    })
    const unable = { external_id: `${seed}:e:20`, set_index: 1, seq: 20, type: 'libero_unable', ts: new Date().toISOString(), payload: { team: 'home', liberoNumber: 10, liberoType: 'libero1', reason: 'declared' } }
    // the old roster: #10 L1, #8 none; #10 unable, then #8 re-designated
    let m = await db.matches.get(await importRow(row(), [unable, event(21, 10, 8)]))
    let players = await playersOf(m.homeTeamId)
    expect(mark(players, 10)).toBe('unable')
    expect(mark(players, 8)).toBe('redesignated')
    // and the other team untouched
    expect((await playersOf(m.awayTeamId)).every(p => p.libero === '')).toBe(true)

    // a roster sent with the change (and edited after it) is not overwritten
    await Promise.all(db.tables.map(t => t.clear()))
    const sent = row()
    sent.players_home = sent.players_home.map(p => (p.number === 10 ? { ...p, libero: 'unable' } : p.number === 8 ? { ...p, libero: 'libero2' } : p))
    m = await db.matches.get(await importRow(sent, [unable, event(21, 10, 8)]))
    players = await playersOf(m.homeTeamId)
    expect(mark(players, 10)).toBe('unable')
    expect(mark(players, 8)).toBe('libero2')
  })
})
