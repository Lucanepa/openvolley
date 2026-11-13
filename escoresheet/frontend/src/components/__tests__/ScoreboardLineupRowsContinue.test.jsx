// A match continued on another device in the middle of a set (the scoring
// tablet died; restore by game number + PIN or "Take back scoring here").
// The line-up after a substitution, a libero replacement and a side-out
// rotation is a line-up sub-row (N.x) of its entry, written by the
// scoreboard itself. Those rows had no sync job: the server held the
// starting line-ups only, and the device that continued showed the set's
// starting six and served with the wrong player.
//
// Device A: the real scoring screen over the app's real Dexie database (fake
// IndexedDB), driven with taps. What it queues for the cloud becomes the
// server's rows. Device B: a fresh database that continues the match
// (fetchMatchByPin + importMatchFromSupabase) and plays the next rally.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'

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
const SEED = 'match_1799999999999_lineuprows'
const GAME_N = 4711
const PIN = '123456'
const HOME = [1, 2, 3, 4, 5, 6, 7, 10, 11]
const AWAY = [21, 22, 23, 24, 25, 26, 27, 28]
const liberoOf = (n) => (n === 10 ? 'libero1' : n === 11 ? 'libero2' : '')

const findButton = (re, root = document) => [...root.querySelectorAll('button')].find(b => re.test(b.textContent.trim()) && !b.disabled)
const dialog = (re) => [...document.querySelectorAll('[role="dialog"]')].find(d => re.test(d.textContent))
const disc = (team, n) => document.querySelector(`.court-player[data-team="${team}"][data-player-number="${n}"]`)
const onCourt = (team) => [...document.querySelectorAll(`.court-player[data-team="${team}"]`)].map(d => d.getAttribute('data-player-number')).sort()
const mount = (matchId) => render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
const eventsOf = (matchId) => db.events.where('matchId').equals(matchId).toArray()
const lineupRows = (events) => events.filter(e => e.type === 'lineup').sort((a, b) => a.seq - b.seq)
const latest = (events, team) => lineupRows(events).filter(e => e.payload?.team === team && e.setIndex === 1).pop()?.payload
const asText = (lineup) => Object.fromEntries(['I', 'II', 'III', 'IV', 'V', 'VI'].map(p => [p, String(lineup?.[p] ?? '')]))

// Set 1 at 1:0, home (team A) won the first rally and serves
async function setUpDeviceA() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  await db.players.bulkAdd([
    ...HOME.map(n => ({ teamId: home, number: n, name: `H${n} X`, firstName: 'X', lastName: `H${n}`, libero: liberoOf(n) })),
    ...AWAY.map(n => ({ teamId: away, number: n, name: `A${n} X`, firstName: 'X', lastName: `A${n}`, libero: '' }))
  ])
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, bestOf: 5, seed_key: SEED, gamePin: PIN, gameN: GAME_N, gameNumber: String(GAME_N),
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossConfirmed: true,
    homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK
  })
  const t = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const setId = await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 0, finished: false, startTime: t })
  let seq = 1
  // Written before, each one queued as the app queues it
  const queued = [
    { type: 'coin_toss', payload: {} },
    { type: 'lineup', payload: { team: 'home', lineup: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }, isInitial: true } },
    { type: 'lineup', payload: { team: 'away', lineup: { I: '21', II: '22', III: '23', IV: '24', V: '25', VI: '26' }, isInitial: true } },
    { type: 'set_start', payload: {} }
  ]
  for (const e of queued) await queueEventSync(db, await db.events.add({ matchId, setIndex: 1, seq: seq++, ts: t, ...e }))
  await db.events.add({ matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: seq++, ts: t })
  await queueEventSync(db, await db.events.add({ matchId, setIndex: 1, type: 'point', payload: { team: 'home', score: { home: 1, away: 0 } }, seq: seq++, ts: t }))
  return { matchId, setId }
}

// The server's rows: every event insert device A queued (all of them sent)
async function serverRowsFromQueue() {
  const jobs = (await db.sync_queue.toArray()).filter(j => j.resource === 'event' && j.action === 'insert')
  return jobs.map(j => ({
    external_id: j.payload.external_id,
    set_index: j.payload.set_index,
    seq: j.payload.seq,
    type: j.payload.type,
    payload: j.payload.payload,
    ts: j.payload.created_at,
    created_at: j.payload.created_at,
    lineup_left: j.payload.lineup_left ?? null,
    lineup_right: j.payload.lineup_right ?? null,
    serve_team: j.payload.serve_team ?? null,
    serve_player: j.payload.serve_player ?? null,
    state_snapshot: j.payload.state_snapshot ?? null
  })).sort((a, b) => a.seq - b.seq)
}

async function playRally(pointButton, points) {
  await waitFor(() => expect(findButton(/^Start rally$/)).toBeTruthy())
  await settle()
  fireEvent.click(findButton(/^Start rally$/))
  await waitFor(() => expect(findButton(pointButton)).toBeTruthy())
  await wait(GHOST_CLICK_MS + 600)
  fireEvent.click(findButton(pointButton))
  await waitFor(async () => expect((await db.events.toArray()).filter(e => e.type === 'point')).toHaveLength(points))
  await wait(800)
}

async function openPlayerMenu(team, n, item) {
  await waitFor(() => expect(disc(team, n)).toBeTruthy())
  fireEvent.click(disc(team, n))
  await waitFor(() => expect(findButton(item)).toBeTruthy())
  fireEvent.click(findButton(item))
}

const rich = (lineup) => Object.fromEntries(Object.entries(lineup).map(([p, n]) => [p, { number: Number(n) }]))

describe('Scoreboard: a match continued on another device keeps the line-up of the set in progress', () => {
  it('substitution, libero entry, libero exchange and side-outs: the other device has the same line-ups and server', async () => {
    // ---------------- device A ----------------
    const { matchId, setId } = await setUpDeviceA()
    const viewA = mount(matchId)
    await waitFor(() => expect(disc('home', 3)).toBeTruthy(), { timeout: 15000 })
    await waitFor(() => expect(findButton(/^Start rally$/)).toBeTruthy(), { timeout: 15000 })
    await settle()

    // substitution home #3 -> #7 (the one substitute: straight to its confirmation)
    await openPlayerMenu('home', 3, /^Substitution$/)
    await waitFor(() => expect(dialog(/OUT/) && findButton(/^Yes$/, dialog(/OUT/))).toBeTruthy())
    await settle()
    fireEvent.click(findButton(/^Yes$/, dialog(/OUT/)))
    await waitFor(() => expect(disc('home', 7)).toBeTruthy())
    await settle()

    // libero #10 in for #6 (back row, VI)
    await openPlayerMenu('home', 6, /^Libero$/)
    await waitFor(() => expect(findButton(/^10 \(L1\)$/)).toBeTruthy())
    fireEvent.click(findButton(/^10 \(L1\)$/))
    await waitFor(() => expect(disc('home', 10)).toBeTruthy())
    await settle()

    // side-out: away wins on home's serve and rotates; then home wins it back and rotates
    await playRally(/^Point B/, 2)
    await playRally(/^Point A/, 3)

    // libero exchange: #11 in for #10
    await openPlayerMenu('home', 10, /^Exchange libero$/)
    await waitFor(() => expect(disc('home', 11)).toBeTruthy())
    await settle()

    // side-out again: away rotates and serves
    await playRally(/^Point B/, 4)

    const eventsA = await eventsOf(matchId)
    const homeA = latest(eventsA, 'home')
    const awayA = latest(eventsA, 'away')
    expect(asText(homeA.lineup)).toEqual({ I: '2', II: '7', III: '4', IV: '5', V: '11', VI: '1' })
    expect(asText(awayA.lineup)).toEqual({ I: '23', II: '24', III: '25', IV: '26', V: '21', VI: '22' })
    const courtA = { home: onCourt('home'), away: onCourt('away') }

    // every line-up row of device A went to the sync queue
    const rows = await serverRowsFromQueue()
    const subRowsA = lineupRows(eventsA).filter(e => !Number.isInteger(e.seq))
    expect(subRowsA.length).toBe(6) // substitution, libero entry, 3 rotations, exchange
    expect(rows.filter(r => r.type === 'lineup').map(r => r.external_id))
      .toEqual(lineupRows(eventsA).map(e => `${SEED}:e:${e.id}`))
    viewA.unmount()
    cleanup()
    await wait(300)

    // ---------------- the server's answer ----------------
    byPin.result = {
      data: {
        match: {
          id: '22222222-2222-4222-8222-222222222222', external_id: SEED, game_n: GAME_N, status: 'live', test: false, sport_type: 'indoor',
          home_team: { name: 'Home VC', short_name: 'HOM' }, away_team: { name: 'Away VC', short_name: 'AWY' },
          players_home: HOME.map(n => ({ number: n, first_name: 'X', last_name: `H${n}`, libero: liberoOf(n) })),
          players_away: AWAY.map(n => ({ number: n, first_name: 'X', last_name: `A${n}`, libero: '' })),
          coin_toss: { team_a: 'home', team_b: 'away', confirmed: true, first_serve: 'home' },
          signatures: { home_coach: INK, home_captain: INK, away_coach: INK, away_captain: INK },
          match_info: { best_of: 5 }, created_at: new Date(Date.now() - 3600e3).toISOString()
        },
        sets: [{ external_id: `${SEED}:s:${setId}`, index: 1, home_points: 2, away_points: 2, finished: false, start_time: new Date(Date.now() - 30 * 60e3).toISOString() }],
        events: rows,
        liveState: { current_set: 1, points_a: 2, points_b: 2, lineup_a: rich(homeA.lineup), lineup_b: rich(awayA.lineup), updated_at: new Date().toISOString() }
      },
      error: null
    }

    // ---------------- device B (fresh) ----------------
    await Promise.all(db.tables.map(t => t.clear()))
    const newId = await importMatchFromSupabase(await fetchMatchByPin(PIN, GAME_N))
    const eventsB = await eventsOf(newId)
    // the same line-up rows, under the same ids (nothing rebuilt: the server had them)
    expect(lineupRows(eventsB).map(e => [e.id, e.seq])).toEqual(lineupRows(eventsA).map(e => [e.id, e.seq]))
    expect(asText(latest(eventsB, 'home').lineup)).toEqual(asText(homeA.lineup))
    expect(latest(eventsB, 'home').liberoSubstitution).toMatchObject({ position: 'V', liberoNumber: 11 })
    expect(asText(latest(eventsB, 'away').lineup)).toEqual(asText(awayA.lineup))

    mount(newId)
    await waitFor(() => expect(onCourt('home').length).toBe(6), { timeout: 15000 })
    await waitFor(() => expect(findButton(/^Start rally$/)).toBeTruthy(), { timeout: 15000 })
    await wait(500)
    expect({ home: onCourt('home'), away: onCourt('away') }).toEqual(courtA)

    // the next rally: away served it (#23 at I after its rotation)
    await settle()
    await playRally(/^Point B/, 5)
    const jobsB = (await db.sync_queue.toArray()).filter(j => j.resource === 'event' && j.payload?.type === 'point')
    const lastJob = jobsB.sort((a, b) => b.payload.seq - a.payload.seq)[0]
    expect(lastJob.payload.serve_team).toBe('away')
    expect(lastJob.payload.serve_player).toBe(23)
  }, 120000)
})
