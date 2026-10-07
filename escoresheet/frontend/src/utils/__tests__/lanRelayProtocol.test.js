// @vitest-environment node
/**
 * Contract tests for the LAN relay wire protocol (electron/lanRelayCore.cjs),
 * exercised through every Node relay runtime that uses it — the standalone
 * server (server.js), the Electron in-process relay and the Vite dev plugin —
 * and checked against what the client (serverDataSync.readRelayBundle) reads.
 * Each runtime (and the Tauri relay with OV_TAURI_RELAY_BIN) also runs the
 * venue contract shared with the backend's --local relay: several beach
 * courts on one relay (backend/tests/helpers/beachVenueContract.js).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import WebSocket from 'ws'
import { createLanRelay, createLocalAddressCheck, createMainInstanceGate, MAX_OWNED_PER_IP, OTHER_COURT_COOKIE } from '../../../lanRelayCore.js'
import { vitePluginApiRoutes } from '../../../vite-plugin-api-routes.js'
import { readRelayBundle } from '../serverDataSync'
import { runBeachVenueContract } from '../../../../backend/tests/helpers/beachVenueContract.js'

const here = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(here, '../../..')
const require = createRequire(import.meta.url)

const PINS = {
  refereePin: '314159',
  homeTeamPin: '271828',
  awayTeamPin: '161803',
  homeTeamUploadPin: '141421',
  awayTeamUploadPin: '173205',
  gamePin: '987654'
}

// Personal data the scorer's Dexie bundle carries and no relay hands out
// (subscribing needs no PIN and the room key is public).
const PERSONAL = {
  playerDob: '2001-04-17',
  benchDob: '1975-08-09',
  officialDob: '1982-11-23',
  country: 'NZL',
  signature: 'data:image/png;base64,SIGNATUREBYTES'
}
const containsPersonal = (text) => Object.values(PERSONAL).some((v) => text.includes(v)) ||
  /"officials"|"signatures"|ignature"|"pendingHomeRoster"|"manualChanges"/.test(text)

// GET /api/match/list: the keys of every row, on every relay (sorted)
const LIST_ROW_KEYS = [
  'awayTeam', 'awayTeamConnectionEnabled', 'dateTime', 'gameNumber', 'homeTeam', 'homeTeamConnectionEnabled',
  'id', 'refereeConnectionEnabled', 'scheduledAt', 'sportType', 'status', 'test'
]

function makeMatch(overrides = {}) {
  return {
    id: 7,
    gameNumber: 4242,
    status: 'live',
    scheduledAt: '2026-10-05T18:00:00.000Z',
    refereeConnectionEnabled: true,
    homeTeamConnectionEnabled: true,
    awayTeamConnectionEnabled: false,
    homeTeamId: 1,
    awayTeamId: 2,
    officials: [{ role: '1st referee', firstName: 'Ann', lastName: 'Ref', country: PERSONAL.country, dob: PERSONAL.officialDob }],
    bench_home: [{ role: 'Coach', firstName: 'Cora', lastName: 'Coach', dob: PERSONAL.benchDob }],
    homeCoachSignature: PERSONAL.signature,
    signatures: { home_captain: PERSONAL.signature },
    pendingHomeRoster: { players: [{ number: 3, dob: PERSONAL.playerDob }] },
    manualChanges: [{ field: 'score', by: 'scorer' }],
    ...PINS,
    ...overrides
  }
}

function syncMessage(match = makeMatch(), extra = {}) {
  return {
    type: 'sync-match-data',
    matchId: match.id, // Dexie ids are numbers; the relay must key rooms by String()
    match,
    homeTeam: { id: 1, name: 'Home VC' },
    awayTeam: { id: 2, name: 'Away VC' },
    homePlayers: [{ id: 11, teamId: 1, number: 7, lastName: 'Player', dob: PERSONAL.playerDob, country: PERSONAL.country }],
    awayPlayers: [{ id: 21, teamId: 2, number: 9 }],
    sets: [{ id: 1, matchId: 7, index: 1, homePoints: 3, awayPoints: 1 }],
    events: [],
    _timestamp: Date.now(),
    ...extra
  }
}

const containsPin = (text) => Object.values(PINS).some((pin) => text.includes(pin))

// ---------------------------------------------------------------------------
// Unit: the shared core with fake sockets
// ---------------------------------------------------------------------------

function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    raw: [],
    send(text) {
      this.raw.push(text)
      this.sent.push(JSON.parse(text))
    },
    last(type) {
      return [...this.sent].reverse().find((m) => m.type === type)
    }
  }
}

function connect(relay, ip = '192.168.1.50') {
  const ws = fakeSocket()
  relay.addClient(ws, { ip })
  return ws
}

// What the LedBox bridge (point-hub src/relaySubscriber.js) reads
const bridgeLiveState = (m) => m.liveState ?? m.data?.liveState

const msg = (relay, ws, m) => relay.handleMessage(ws, JSON.stringify(m))

describe('lanRelayCore protocol', () => {
  it('fans match-data-update out flat, PIN-free and keyed by String(matchId)', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay)
    const referee = connect(relay)
    msg(relay, referee, { type: 'subscribe-match', matchId: '7', pin: PINS.refereePin })
    msg(relay, scoreboard, syncMessage())

    const update = referee.last('match-data-update')
    expect(update.access).toBe('full')
    expect(update).toBeTruthy()
    expect(update.matchId).toBe('7')
    expect(update.data).toBeUndefined()
    expect(update.match.id).toBe(7)
    expect(containsPin(referee.raw.join(''))).toBe(false)
    expect(containsPersonal(referee.raw.join(''))).toBe(false)

    const payload = readRelayBundle(update)
    expect(payload.match.gameNumber).toBe(4242)
    // What the tablets render stays: roster numbers/names, bench roles
    expect(payload.homePlayers[0]).toMatchObject({ number: 7, lastName: 'Player' })
    expect(payload.match.bench_home[0]).toMatchObject({ role: 'Coach', lastName: 'Coach' })
    expect(payload.homeTeam.name).toBe('Home VC')
    expect(payload.sets).toHaveLength(1)
  })

  it('sends a PIN-free match-full-data snapshot on subscribe', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay)
    msg(relay, scoreboard, syncMessage())
    const late = connect(relay)
    msg(relay, late, { type: 'subscribe-match', matchId: 7 })
    const full = late.last('match-full-data')
    expect(full.matchId).toBe('7')
    expect(readRelayBundle(full).match.status).toBe('live')
    expect(containsPin(late.raw.join(''))).toBe(false)
    expect(containsPersonal(late.raw.join(''))).toBe(false)
  })

  it('forwards match-action with the payload the scoreboard sends as `data`', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay)
    const referee = connect(relay)
    msg(relay, scoreboard, syncMessage())
    msg(relay, referee, { type: 'subscribe-match', matchId: '7', pin: PINS.refereePin })
    msg(relay, scoreboard, { type: 'match-action', matchId: 7, action: 'timeout', data: { team: 'home', countdown: 30 }, timestamp: 1 })
    const action = referee.last('match-action')
    expect(action).toMatchObject({ matchId: '7', action: 'timeout', data: { team: 'home', countdown: 30 } })
  })

  it('only a socket that proved the game PIN may write, act or delete', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay)
    const referee = connect(relay)
    const attacker = connect(relay)
    msg(relay, scoreboard, syncMessage())
    msg(relay, referee, { type: 'subscribe-match', matchId: '7', pin: PINS.refereePin })
    referee.sent.length = 0

    // Overwrite with a different (or missing) game PIN
    msg(relay, attacker, syncMessage(makeMatch({ gamePin: '000000', status: 'scheduled' })))
    expect(attacker.last('error').code).toBe('not-match-owner')
    msg(relay, attacker, syncMessage(makeMatch({ gamePin: undefined })))
    expect(attacker.sent.filter((m) => m.type === 'error')).toHaveLength(2)

    // Destructive / injected messages without proof
    msg(relay, attacker, { type: 'clear-all-matches' })
    expect(attacker.last('error').code).toBe('not-scoreboard')
    msg(relay, attacker, { type: 'delete-match', matchId: 7 })
    msg(relay, attacker, { type: 'match-action', matchId: 7, action: 'timeout', data: { team: 'away' } })
    msg(relay, attacker, { type: 'live-state-update', matchId: 7, liveState: { points_a: 99 } })
    expect(referee.sent).toHaveLength(0)
    expect(relay.hasMatch(7)).toBe(true)

    // The real scoreboard keeps working (it carries the same game PIN)
    msg(relay, scoreboard, syncMessage(makeMatch({ status: 'live' }), { events: [{ id: 1 }] }))
    expect(readRelayBundle(referee.last('match-data-update')).events).toHaveLength(1)
  })

  it('hands the bundle and match actions only to a socket that proved a PIN of the match', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay, '192.168.1.10')
    const viewer = connect(relay, '192.168.1.30')
    const bench = connect(relay, '192.168.1.31')
    const early = connect(relay, '192.168.1.32')
    // Subscribed before the scorer synced: the PIN is checked when the match arrives
    msg(relay, early, { type: 'subscribe-match', matchId: '7', pin: PINS.refereePin })
    msg(relay, scoreboard, syncMessage(makeMatch(), { events: [{ id: 1, type: 'point' }] }))
    expect(early.last('match-data-update').access).toBe('full')
    expect(early.last('match-data-update').homePlayers).toHaveLength(1)

    // No PIN (Livescore, LedBox bridge, anyone who knows the room key): the summary
    msg(relay, viewer, { type: 'subscribe-match', matchId: '7' })
    const summary = viewer.last('match-full-data')
    expect(summary.access).toBe('summary')
    expect(summary.homePlayers).toEqual([])
    expect(summary.awayPlayers).toEqual([])
    expect(summary.events).toEqual([])
    expect(summary.match).toMatchObject({ id: 7, status: 'live', gameNumber: 4242 })
    expect(summary.match.bench_home).toBeUndefined()
    expect(summary.homeTeam).toEqual({ name: 'Home VC' })
    expect(summary.sets).toEqual([{ id: 1, index: 1, homePoints: 3, awayPoints: 1 }])
    expect(containsPin(viewer.raw.join(''))).toBe(false)

    // The home bench PIN (bench connection on) is a PIN of the match too
    msg(relay, bench, { type: 'subscribe-match', matchId: '7', pin: PINS.homeTeamPin })
    expect(bench.last('match-full-data').access).toBe('full')

    // Actions go to the PIN holders only; the live state goes to everyone
    msg(relay, scoreboard, { type: 'match-action', matchId: 7, action: 'substitution', data: { playerOut: 7 } })
    expect(bench.last('match-action')).toBeTruthy()
    expect(viewer.last('match-action')).toBeUndefined()
    msg(relay, scoreboard, { type: 'live-state-update', matchId: 7, liveState: { points_a: 4 } })
    expect(viewer.last('live-state-update').liveState).toEqual({ points_a: 4 })
    msg(relay, scoreboard, syncMessage())
    expect(viewer.last('match-data-update')).toMatchObject({ access: 'summary', liveState: { points_a: 4 }, data: { liveState: { points_a: 4 } } })
    expect(bench.last('match-data-update').access).toBe('full')

    // The away bench PIN grants nothing while that connection is off
    const away = connect(relay, '192.168.1.33')
    msg(relay, away, { type: 'subscribe-match', matchId: '7', pin: PINS.awayTeamPin })
    expect(away.last('error').code).toBe('pin-invalid')
    expect(away.last('match-full-data').access).toBe('summary')
  })

  it('stops PIN guessing on subscribe-match without revealing a hit', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay, '192.168.1.10')
    msg(relay, scoreboard, syncMessage())
    const guesser = connect(relay, '192.168.1.66')
    for (let i = 0; i < 5; i++) {
      msg(relay, guesser, { type: 'subscribe-match', matchId: '7', pin: String(200000 + i) })
      expect(guesser.last('error').code).toBe('pin-invalid')
    }
    guesser.sent.length = 0
    msg(relay, guesser, { type: 'subscribe-match', matchId: '7', pin: PINS.refereePin })
    expect(guesser.last('error').code).toBe('rate-limited')
    expect(guesser.last('match-full-data').access).toBe('summary')
    // ...also from another socket of the same device
    const again = connect(relay, '192.168.1.66')
    msg(relay, again, { type: 'subscribe-match', matchId: '7', pin: PINS.refereePin })
    expect(again.last('error').code).toBe('rate-limited')
    // A PIN offered before the match existed and found wrong later is dropped (checked once)
    const relay2 = createLanRelay()
    const early = connect(relay2, '192.168.1.70')
    msg(relay2, early, { type: 'subscribe-match', matchId: '7', pin: '999999' })
    msg(relay2, connect(relay2, '192.168.1.10'), syncMessage())
    expect(early.last('match-data-update').access).toBe('summary')
  })

  it('GET /api/match/:id: the summary, and the bundle with a PIN of the match', async () => {
    const relay = createLanRelay()
    msg(relay, connect(relay), syncMessage(makeMatch(), { events: [{ id: 1 }] }))
    const anon = await relay.getMatch('7')
    expect(anon.body).toMatchObject({ success: true, access: 'summary', homePlayers: [], events: [] })
    const wrong = await relay.getMatch('7', { pin: '000000', ip: '192.168.1.80' })
    expect(wrong.body.access).toBe('summary')
    const full = await relay.getMatch('7', { pin: PINS.refereePin, ip: '192.168.1.81' })
    expect(full.body).toMatchObject({ success: true, access: 'full' })
    expect(full.body.homePlayers[0]).toMatchObject({ number: 7 })
    expect(full.body.events).toHaveLength(1)
    expect(containsPin(JSON.stringify(full.body)) || containsPersonal(JSON.stringify(full.body))).toBe(false)
    for (let i = 0; i < 5; i++) await relay.getMatch('7', { pin: '000000', ip: '192.168.1.82' })
    expect((await relay.getMatch('7', { pin: PINS.refereePin, ip: '192.168.1.82' })).status).toBe(429)
  })

  it('lets another scorer reuse a finished match id after 60 s, an unfinished one only after 10 min', () => {
    // Dexie ids restart at 1 on every device: a second scorer must not be locked out forever.
    const cases = [
      { opts: {}, status: 'final', allowed: false }, // owner left just now
      { opts: { orphanTakeoverMs: 0 }, status: 'final', allowed: true },
      { opts: { orphanTakeoverMs: 0 }, status: 'live', allowed: false }, // a sleeping scorer keeps its match
      { opts: { orphanTakeoverMs: 0, staleTakeoverMs: 0 }, status: 'live', allowed: true }
    ]
    for (const { opts, status, allowed } of cases) {
      const relay = createLanRelay(opts)
      const deviceA = connect(relay, '192.168.1.10')
      const deviceB = connect(relay, '192.168.1.11')
      msg(relay, deviceA, syncMessage(makeMatch({ id: 1, gamePin: '111111', status })))
      // Owner still connected: never displaced
      msg(relay, deviceB, syncMessage(makeMatch({ id: 1, gamePin: '222222' })))
      expect(deviceB.last('error').code).toBe('not-match-owner')
      relay.removeClient(deviceA)
      deviceB.sent.length = 0
      msg(relay, deviceB, syncMessage(makeMatch({ id: 1, gamePin: '222222' })))
      expect(deviceB.sent.some((m) => m.type === 'error'), JSON.stringify({ opts, status })).toBe(!allowed)
    }
  })

  it('lets the displaced game PIN reclaim an unfinished match once, without the old live-state', () => {
    const relay = createLanRelay({ orphanTakeoverMs: 0, staleTakeoverMs: 0 })
    const scorer = connect(relay, '192.168.1.10')
    const intruder = connect(relay, '192.168.1.66')
    const referee = connect(relay, '192.168.1.20')
    msg(relay, scorer, syncMessage(makeMatch({ id: 1, gamePin: '111111' })))
    msg(relay, referee, { type: 'subscribe-match', matchId: '1' })
    msg(relay, scorer, { type: 'live-state-update', matchId: 1, liveState: { sets_won_a: 2, match_status: 'live' } })
    relay.removeClient(scorer) // tablet asleep

    msg(relay, intruder, syncMessage(makeMatch({ id: 1, gamePin: '666666' })))
    expect(intruder.last('error')).toBeUndefined()
    // The takeover must not inherit the previous match's live-state
    expect(referee.last('match-data-update').liveState).toBeUndefined()

    // The scorer wakes up on a new socket: its own game PIN takes the match back
    const scorer2 = connect(relay, '192.168.1.10')
    msg(relay, scorer2, syncMessage(makeMatch({ id: 1, gamePin: '111111' })))
    expect(scorer2.last('error')).toBeUndefined()
    referee.sent.length = 0
    msg(relay, intruder, { type: 'match-action', matchId: 1, action: 'timeout', data: {} })
    expect(intruder.last('error').code).toBe('not-match-owner')
    expect(referee.sent).toHaveLength(0)
    // ...and only once: the intruder cannot flip it back while the scorer is connected
    msg(relay, intruder, syncMessage(makeMatch({ id: 1, gamePin: '666666' })))
    expect(intruder.last('error').code).toBe('not-match-owner')
  })

  it('does not hand a finished match back to its old PIN after a legitimate reuse', () => {
    const relay = createLanRelay({ orphanTakeoverMs: 0 })
    const morning = connect(relay, '192.168.1.10')
    const afternoon = connect(relay, '192.168.1.11')
    msg(relay, morning, syncMessage(makeMatch({ id: 1, gamePin: '111111', status: 'final' })))
    relay.removeClient(morning)
    msg(relay, afternoon, syncMessage(makeMatch({ id: 1, gamePin: '222222', status: 'live' })))
    const morningAgain = connect(relay, '192.168.1.10')
    msg(relay, morningAgain, syncMessage(makeMatch({ id: 1, gamePin: '111111', status: 'final' })))
    expect(morningAgain.last('error').code).toBe('not-match-owner')
  })

  it('stops game-PIN guessing after a few failures, without revealing a hit', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay, '192.168.1.10')
    const guesser = connect(relay, '192.168.1.66')
    msg(relay, scoreboard, syncMessage())
    for (let i = 0; i < 5; i++) msg(relay, guesser, syncMessage(makeMatch({ gamePin: String(100000 + i) })))
    expect(guesser.sent.filter((m) => m.code === 'not-match-owner')).toHaveLength(5)
    // The right PIN is now refused exactly like a wrong one
    msg(relay, guesser, syncMessage(makeMatch({ gamePin: PINS.gamePin })))
    expect(guesser.last('error').code).toBe('rate-limited')
    // A fresh socket from the same IP is limited too
    const again = connect(relay, '192.168.1.66')
    msg(relay, again, syncMessage(makeMatch({ gamePin: PINS.gamePin })))
    expect(again.last('error').code).toBe('rate-limited')
    // The proven scoreboard is unaffected
    msg(relay, scoreboard, syncMessage())
    expect(scoreboard.last('error')).toBeUndefined()
  })

  it('limits how many match ids one LAN device can hold (loopback exempt)', () => {
    // A venue: a court tablet keeps the matches it scored on one connection
    expect(MAX_OWNED_PER_IP).toBe(8)
    const relay = createLanRelay()
    const squatter = connect(relay, '192.168.1.66')
    for (let id = 1; id <= MAX_OWNED_PER_IP; id++) msg(relay, squatter, syncMessage(makeMatch({ id, gamePin: '000000' })))
    expect(squatter.last('error')).toBeUndefined()
    msg(relay, squatter, syncMessage(makeMatch({ id: MAX_OWNED_PER_IP + 1, gamePin: '000000' })))
    expect(squatter.last('error').code).toBe('too-many-matches')
    expect(relay.hasMatch(MAX_OWNED_PER_IP + 1)).toBe(false)
    // Releasing its finished matches frees the room for the next ones
    msg(relay, squatter, { type: 'clear-all-matches', keepMatchId: 1 })
    msg(relay, squatter, syncMessage(makeMatch({ id: MAX_OWNED_PER_IP + 1, gamePin: '000000' })))
    expect(relay.hasMatch(MAX_OWNED_PER_IP + 1)).toBe(true)
    const desktop = connect(relay, '::ffff:127.0.0.1')
    for (let id = 21; id <= 32; id++) msg(relay, desktop, syncMessage(makeMatch({ id, gamePin: '000000' })))
    expect(desktop.last('error')).toBeUndefined()
  })

  it('clear-all-matches removes only the matches the sender proved', () => {
    const relay = createLanRelay()
    const courtA = connect(relay)
    const courtB = connect(relay)
    const watcher = connect(relay)
    msg(relay, courtA, syncMessage(makeMatch({ id: 1, gamePin: '111111' })))
    msg(relay, courtA, syncMessage(makeMatch({ id: 2, gamePin: '222222' })))
    msg(relay, courtB, syncMessage(makeMatch({ id: 3, gamePin: '333333' })))
    msg(relay, watcher, { type: 'subscribe-match', matchId: '1' })

    msg(relay, courtA, { type: 'clear-all-matches', keepMatchId: '2' })
    expect(relay.hasMatch(1)).toBe(false)
    expect(relay.hasMatch(2)).toBe(true)
    expect(relay.hasMatch(3)).toBe(true)
    // Subscribers are told before their room is dropped
    expect(watcher.last('match-deleted')).toEqual({ type: 'match-deleted', matchId: '1' })
  })

  it('validates PINs from its own store, never asking or telling WS clients', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay)
    const bystander = connect(relay)
    msg(relay, scoreboard, syncMessage())
    scoreboard.sent.length = 0

    const ok = relay.validatePin({ pin: PINS.refereePin, type: 'referee' })
    expect(ok.status).toBe(200)
    expect(ok.body.match.id).toBe(7)
    expect(containsPin(JSON.stringify(ok.body))).toBe(false)

    expect(relay.validatePin({ pin: PINS.awayTeamPin, type: 'awayTeam' }).status).toBe(404) // connection disabled
    expect(relay.validatePin({ pin: '123456', type: 'referee' }).status).toBe(404)
    expect(scoreboard.sent).toHaveLength(0)
    expect(bystander.sent.filter((m) => m.type === 'pin-validation-request')).toHaveLength(0)

    // A forged answer from any client changes nothing
    msg(relay, bystander, { type: 'pin-validation-response', requestId: 'x', success: true, match: { id: 99 }, fullData: { match: { id: 99 } } })
    expect(relay.hasMatch(99)).toBe(false)
  })

  it('keeps the scoreboard live-state across syncs and forwards it (also as data.liveState for the LedBox bridge)', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay)
    const ledbox = connect(relay)
    msg(relay, scoreboard, syncMessage())
    msg(relay, ledbox, { type: 'subscribe-match', matchId: '7' })
    expect(ledbox.last('match-full-data').data).toBeUndefined() // nothing to mirror yet
    msg(relay, scoreboard, { type: 'live-state-update', matchId: 7, liveState: { points_a: 5, points_b: 3 } })
    expect(ledbox.last('live-state-update')).toEqual({ type: 'live-state-update', matchId: '7', liveState: { points_a: 5, points_b: 3 } })
    msg(relay, scoreboard, syncMessage())
    const update = ledbox.last('match-data-update')
    expect(update.liveState).toEqual({ points_a: 5, points_b: 3 })
    expect(update.data).toEqual({ liveState: { points_a: 5, points_b: 3 } })
    expect(readRelayBundle(update).match.id).toBe(7) // flat bundle still wins in the app reader

    // A bridge that (re)subscribes mid-match gets the live-state immediately
    const restarted = connect(relay)
    msg(relay, restarted, { type: 'subscribe-match', matchId: '7' })
    expect(bridgeLiveState(restarted.last('match-full-data'))).toEqual({ points_a: 5, points_b: 3 })

    // The scorer reconnecting with the same game PIN keeps it
    relay.removeClient(scoreboard)
    const reconnected = connect(relay)
    msg(relay, reconnected, syncMessage())
    expect(ledbox.last('match-data-update').liveState).toEqual({ points_a: 5, points_b: 3 })
  })

  it('asks only proven scoreboards for missing data and only accepts their answer', async () => {
    const relay = createLanRelay({ requestTimeoutMs: 200 })
    const scoreboard = connect(relay)
    const bystander = connect(relay)
    msg(relay, scoreboard, syncMessage(makeMatch({ id: 5, gamePin: '555555' })))

    const pending = relay.getMatch('8')
    const request = scoreboard.last('match-data-request')
    expect(request).toBeTruthy()
    expect(bystander.last('match-data-request')).toBeUndefined()

    // Forged answer from a non-scoreboard is ignored
    msg(relay, bystander, { type: 'match-data-response', requestId: request.requestId, matchId: '8', success: true, data: { match: makeMatch({ id: 8 }) } })
    // Real answer (App.jsx sends `matchData`, Scoreboard.jsx sends `data`)
    msg(relay, scoreboard, { type: 'match-data-response', requestId: request.requestId, matchId: 8, success: true, matchData: { match: makeMatch({ id: 8, gamePin: '888888' }) } })
    const result = await pending
    expect(result.status).toBe(200)
    expect(result.body.match.id).toBe(8)
    expect(containsPin(JSON.stringify(result.body))).toBe(false)
  })

  it('keys the room by the seed_key, so tablets that know the seed key get the scorer\'s data and scorers never share Dexie id 1', () => {
    const relay = createLanRelay()
    const courtA = connect(relay)
    const courtB = connect(relay, '192.168.1.51')
    const referee = connect(relay, '192.168.1.60')
    const seedA = 'match_1791215210058_aaaaaa'
    const seedB = 'match_1791215210059_bbbbbb'
    msg(relay, referee, { type: 'subscribe-match', matchId: seedA, device: 'referee', pin: PINS.refereePin })
    // Both scorers' first match is Dexie id 1
    msg(relay, courtA, syncMessage(makeMatch({ id: 1, seed_key: seedA, gamePin: '111111' })))
    msg(relay, courtB, syncMessage(makeMatch({ id: 1, seed_key: seedB, gamePin: '222222' })))
    expect(courtB.last('error')).toBeUndefined()
    expect(relay.hasMatch(seedA)).toBe(true)
    expect(relay.hasMatch(seedB)).toBe(true)
    expect(relay.hasMatch(1)).toBe(false)

    const update = referee.last('match-data-update')
    expect(update.matchId).toBe(seedA)
    expect(update.match.seed_key).toBe(seedA)

    // Later messages may still use the Dexie id: it is an alias on that socket
    msg(relay, courtA, { type: 'live-state-update', matchId: 1, liveState: { points_a: 2 } })
    expect(referee.last('live-state-update')).toEqual({ type: 'live-state-update', matchId: seedA, liveState: { points_a: 2 } })
    msg(relay, courtA, { type: 'match-action', matchId: 1, action: 'timeout', data: { team: 'home' } })
    expect(referee.last('match-action').matchId).toBe(seedA)
    // ...but only on the socket that synced it: court B's alias 1 is its own match
    msg(relay, courtB, { type: 'live-state-update', matchId: 1, liveState: { points_a: 9 } })
    expect(referee.last('live-state-update').liveState).toEqual({ points_a: 2 })

    // PIN check and match list hand out the seed key
    expect(relay.validatePin({ pin: PINS.refereePin, type: 'referee' }).body.match.id).toBe(seedA)
    // Tablet status: the subscriber is labelled by its device
    const conns = relay.getConnections(seedA)
    expect(conns.referees).toBe(1)
    expect(conns.clients[0]).toMatchObject({ role: 'referee', matchId: seedA })

    msg(relay, courtA, { type: 'clear-all-matches', keepMatchId: '1' })
    expect(relay.hasMatch(seedA)).toBe(true)
    msg(relay, courtA, { type: 'delete-match', matchId: 1 })
    expect(relay.hasMatch(seedA)).toBe(false)
    expect(relay.hasMatch(seedB)).toBe(true)
  })

  it('keeps the stored PINs when the proven scoreboard leaves them out (PINs are sent only when they change)', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay)
    const other = connect(relay, '192.168.1.51')
    const seed = 'match_1791215210058_cccccc'
    msg(relay, scoreboard, syncMessage(makeMatch({ seed_key: seed })))
    const { refereePin, homeTeamPin, awayTeamPin, homeTeamUploadPin, awayTeamUploadPin, gamePin, ...noPins } = makeMatch({ seed_key: seed })
    msg(relay, scoreboard, syncMessage({ ...noPins, status: 'live' }))
    expect(scoreboard.last('error')).toBeUndefined()
    expect(relay.validatePin({ pin: PINS.refereePin, type: 'referee' }).status).toBe(200)
    expect(relay.validatePin({ pin: PINS.homeTeamPin, type: 'homeTeam' }).status).toBe(200)

    // A changed PIN replaces the stored one
    msg(relay, scoreboard, syncMessage({ ...noPins, refereePin: '565656' }))
    expect(relay.validatePin({ pin: PINS.refereePin, type: 'referee' }).status).toBe(404)
    expect(relay.validatePin({ pin: '565656', type: 'referee' }).status).toBe(200)

    // A socket that never proved the match cannot leave the game PIN out: it
    // is asked for it
    msg(relay, other, syncMessage({ ...noPins }))
    expect(other.last('error').code).toBe('pins-required')
    // ...and the game PIN is still required from a new socket
    msg(relay, other, syncMessage(makeMatch({ seed_key: seed })))
    expect(other.sent.filter((m) => m.type === 'error')).toHaveLength(1)
  })

  it('a scorer\'s PIN-less syncs are no failed claims: asked for the PINs, never rate limited', () => {
    const relay = createLanRelay()
    const seed = 'match_1791215210058_ffffff'
    const full = makeMatch({ id: 1, seed_key: seed })
    const { refereePin, homeTeamPin, awayTeamPin, homeTeamUploadPin, awayTeamUploadPin, gamePin, ...noPins } = full
    const first = connect(relay, '192.168.1.10')
    msg(relay, first, syncMessage(full))
    expect(first.last('error')).toBeUndefined()

    // The same device on a new socket (reconnect) leaves the PINs out, more
    // often than the failure limit: asked for them every time, nothing counted
    const second = connect(relay, '192.168.1.10')
    for (let i = 0; i < 8; i++) msg(relay, second, syncMessage({ ...noPins }))
    expect(second.sent.filter((m) => m.type === 'error').map((m) => m.code)).toEqual(Array(8).fill('pins-required'))
    // With its PINs (what the scorer resends) it proves the match at once
    msg(relay, second, syncMessage(full))
    expect(second.sent.filter((m) => m.type === 'error')).toHaveLength(8)
    // A claim with a null game PIN is no guess either
    const third = connect(relay, '192.168.1.10')
    for (let i = 0; i < 6; i++) msg(relay, third, syncMessage({ ...noPins, gamePin: null }))
    expect(third.last('error').code).toBe('not-match-owner')
    msg(relay, third, syncMessage(full))
    expect(third.sent.filter((m) => m.type === 'error')).toHaveLength(6)
  })

  it('GET /api/match/<Dexie id> opens no second, frozen room (rooms exist only under the seed key)', async () => {
    const relay = createLanRelay({ requestTimeoutMs: 200 })
    const scoreboard = connect(relay)
    const seed = 'match_1791215210058_dddddd'
    const match = makeMatch({ id: 1, seed_key: seed, gamePin: '111111' })
    msg(relay, scoreboard, syncMessage(match))
    expect(relay.hasMatch(seed)).toBe(true)

    // An old tablet / LedBox bridge with MATCH_ID=1 asks by the Dexie id. Even a
    // scoreboard that answers it (an older build) does not create room '1'.
    const pending = relay.getMatch('1')
    const request = scoreboard.last('match-data-request')
    expect(request.matchId).toBe('1')
    msg(relay, scoreboard, { type: 'match-data-response', requestId: request.requestId, matchId: '1', success: true, data: { match } })
    const result = await pending
    expect(result.status).toBe(404)
    expect(relay.hasMatch('1')).toBe(false)

    // Asked by the seed key it is served from the store
    const bySeed = await relay.getMatch(seed)
    expect(bySeed.status).toBe(200)
    expect(bySeed.body.match.seed_key).toBe(seed)
  })

  it('asks for the PINs instead of recreating a lost match without them', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay)
    const thief = connect(relay, '192.168.1.66')
    const seed = 'match_1791215210058_eeeeee'
    msg(relay, scoreboard, syncMessage(makeMatch({ id: 1, seed_key: seed })))
    const { refereePin, homeTeamPin, awayTeamPin, homeTeamUploadPin, awayTeamUploadPin, gamePin, ...noPins } = makeMatch({ id: 1, seed_key: seed })
    // The relay loses the match while the scorer's socket stays open
    msg(relay, scoreboard, { type: 'delete-match', matchId: seed })
    expect(relay.hasMatch(seed)).toBe(false)

    // Its next sync leaves the PINs out, as usual: refused, not a PIN-less room
    msg(relay, scoreboard, syncMessage(noPins))
    expect(scoreboard.last('error')).toMatchObject({ code: 'pins-required', matchId: seed })
    expect(relay.hasMatch(seed)).toBe(false)

    // With the PINs (what the scorer resends) the room is back, PIN-protected
    msg(relay, scoreboard, syncMessage(makeMatch({ id: 1, seed_key: seed })))
    expect(relay.hasMatch(seed)).toBe(true)
    expect(relay.validatePin({ pin: PINS.refereePin, type: 'referee' }).status).toBe(200)
    msg(relay, thief, syncMessage({ ...noPins, gamePin: '000000' }))
    expect(thief.last('error').code).toBe('not-match-owner')

    // A client that never sends PIN fields (old build, test match) still works
    const legacy = connect(relay, '192.168.1.70')
    msg(relay, legacy, syncMessage({ id: 3, status: 'live' }))
    expect(legacy.last('error')).toBeUndefined()
    expect(relay.hasMatch(3)).toBe(true)
  })

  it('lists every scheduled/live match a scorer publishes, with or without the referee connection, public fields only', () => {
    const relay = createLanRelay()
    const scorerA = connect(relay, '192.168.1.10')
    const scorerB = connect(relay, '192.168.1.11')
    const scorerC = connect(relay, '192.168.1.12')
    const scorerD = connect(relay, '192.168.1.13')
    // Referee connection off (the default for a new match)
    msg(relay, scorerA, syncMessage(makeMatch({ id: 1, seed_key: 'seed-a', gamePin: '111111', status: 'scheduled', refereeConnectionEnabled: false, scheduledAt: '2026-10-05T17:00:00.000Z' })))
    msg(relay, scorerB, syncMessage(makeMatch({ id: 1, seed_key: 'seed-b', gamePin: '222222', status: 'live', scheduledAt: '2026-10-05T19:00:00.000Z' })))
    // A rehearsal match (no game PIN) and a finished one
    msg(relay, scorerC, syncMessage({ id: 1, seedKey: 'test-seed', test: true, status: 'live', refereePin: PINS.refereePin }))
    msg(relay, scorerD, syncMessage(makeMatch({ id: 1, seed_key: 'seed-d', gamePin: '444444', status: 'final' })))

    const res = relay.listMatches()
    expect(res.status).toBe(200)
    const { matches } = res.body
    // All published, open matches; newest first, one without a date last
    expect(matches.map((m) => m.id)).toEqual(['seed-b', 'seed-a', 'test-seed'])
    expect(matches[1]).toEqual({
      id: 'seed-a',
      gameNumber: 4242,
      homeTeam: 'Home VC',
      awayTeam: 'Away VC',
      scheduledAt: '2026-10-05T17:00:00.000Z',
      dateTime: expect.any(String),
      status: 'scheduled',
      sportType: 'indoor',
      test: false,
      refereeConnectionEnabled: false,
      homeTeamConnectionEnabled: true,
      awayTeamConnectionEnabled: false
    })
    expect(matches[2]).toMatchObject({ test: true, status: 'live' })
    for (const row of matches) expect(Object.keys(row).sort()).toEqual(LIST_ROW_KEYS)
    const text = JSON.stringify(res.body)
    expect(containsPin(text)).toBe(false)
    expect(containsPersonal(text)).toBe(false)
    expect(text).not.toMatch(/Player|Coach|"lastName"/)
  })

  // The livescore on the hall Wi-Fi / Bluetooth (utils/relayLivescore): the
  // list with ?finished=1, then subscribe-match without a PIN per match.
  it('gives a livescore viewer (no PIN) finished matches on request and only the public summary', () => {
    const relay = createLanRelay()
    const scorerA = connect(relay, '192.168.1.10')
    const scorerB = connect(relay, '192.168.1.11')
    msg(relay, scorerA, syncMessage(makeMatch({ id: 1, seed_key: 'seed-live', gamePin: '111111', status: 'live' })))
    msg(relay, scorerB, syncMessage(makeMatch({ id: 1, seed_key: 'seed-ended', gamePin: '222222', status: 'ended' })))
    expect(relay.listMatches().body.matches.map((m) => m.id)).toEqual(['seed-live'])
    const all = relay.listMatches({ includeFinished: true }).body.matches
    expect(all.map((m) => m.id).sort()).toEqual(['seed-ended', 'seed-live'])
    expect(all.find((m) => m.id === 'seed-ended').status).toBe('ended')
    for (const row of all) expect(Object.keys(row).sort()).toEqual(LIST_ROW_KEYS)

    const viewer = connect(relay, '192.168.1.60')
    msg(relay, viewer, { type: 'subscribe-match', matchId: 'seed-live', device: 'livescore' })
    msg(relay, scorerA, { type: 'live-state-update', matchId: 1, liveState: { points_a: 5, points_b: 3, serving_team: 'left', timeouts_a: 1 } })
    msg(relay, scorerA, { type: 'match-action', matchId: 1, action: 'timeout', data: { team: 'home' } })
    msg(relay, scorerA, syncMessage(makeMatch({ id: 1, seed_key: 'seed-live', gamePin: '111111', status: 'live' })))

    const summary = viewer.last('match-full-data')
    expect(summary.access).toBe('summary')
    expect(summary.homePlayers).toEqual([])
    expect(summary.events).toEqual([])
    expect(summary.sets).toEqual([{ id: 1, index: 1, homePoints: 3, awayPoints: 1 }])
    expect(viewer.last('live-state-update').liveState).toEqual({ points_a: 5, points_b: 3, serving_team: 'left', timeouts_a: 1 })
    const update = viewer.last('match-data-update')
    expect(update.access).toBe('summary')
    expect(update.liveState).toEqual({ points_a: 5, points_b: 3, serving_team: 'left', timeouts_a: 1 })
    expect(viewer.last('match-action')).toBeUndefined()
    const text = viewer.raw.join('\n')
    expect(containsPin(text)).toBe(false)
    expect(containsPersonal(text)).toBe(false)
    expect(text).not.toMatch(/"lastName"|"dob"|"bench_home"|"officials"/)
  })

  it('lists a match whose scorer left only while it would still hold it (10 min)', () => {
    for (const { opts, listed } of [{ opts: {}, listed: true }, { opts: { staleTakeoverMs: 0 }, listed: false }]) {
      const relay = createLanRelay(opts)
      const scorer = connect(relay, '192.168.1.10')
      msg(relay, scorer, syncMessage(makeMatch({ seed_key: 'seed-x' })))
      expect(relay.listMatches().body.matches).toHaveLength(1)
      relay.removeClient(scorer)
      expect(relay.listMatches().body.matches.length, JSON.stringify(opts)).toBe(listed ? 1 : 0)
      // Back again: listed again
      const again = connect(relay, '192.168.1.10')
      msg(relay, again, syncMessage(makeMatch({ seed_key: 'seed-x' })))
      expect(relay.listMatches().body.matches).toHaveLength(1)
    }
  })

  it('openbeach: its players are the home / away players, its PINs never go out, its bench PINs grant the match', () => {
    const relay = createLanRelay()
    const scorer = connect(relay, '192.168.1.10')
    const beachPins = { gamePin: '259730', refereePin: '360841', team1Pin: '471952', team2Pin: '582063', team1UploadPin: '693174', team2UploadPin: '704285', team1TeamPin: '471953', matchPin: '815396' }
    msg(relay, scorer, {
      type: 'sync-match-data',
      matchId: 1,
      match: { id: 1, seed_key: 'beach-2', status: 'live', refereeConnectionEnabled: true, team1TeamConnectionEnabled: true, team2TeamConnectionEnabled: false, ...beachPins },
      team1Team: { name: 'Keller / Huber' },
      team2Team: { name: 'Weber / Frei' },
      team1Players: [{ number: 1, lastName: 'Keller', dob: PERSONAL.playerDob }],
      team2Players: [{ number: 1, lastName: 'Weber' }]
    })
    expect(scorer.last('error')).toBeUndefined()
    const leaks = (text) => Object.values(beachPins).some((p) => text.includes(p)) || /Pin"/.test(text) || text.includes(PERSONAL.playerDob)
    const join = (pin) => {
      const ws = connect(relay, '192.168.1.20')
      msg(relay, ws, { type: 'subscribe-match', matchId: 'beach-2', pin })
      return ws
    }
    const referee = join(beachPins.refereePin)
    const full = referee.last('match-full-data')
    expect(full.access).toBe('full')
    expect(full.homePlayers.map((p) => p.lastName)).toEqual(['Keller'])
    expect(full.awayPlayers.map((p) => p.lastName)).toEqual(['Weber'])
    expect(full.sportType).toBeUndefined() // the relay's own note stays in
    expect(leaks(referee.raw.join(''))).toBe(false)
    expect(join(beachPins.team1Pin).last('match-full-data').access).toBe('full')
    for (const pin of [beachPins.team2Pin, beachPins.team1UploadPin, beachPins.matchPin]) {
      expect(join(pin).last('error').code, pin).toBe('pin-invalid')
    }
    // validate-pin: beach finds it (and names the sport), indoor does not
    const ok = relay.validatePin({ pin: beachPins.refereePin, type: 'referee', sport: 'beach' })
    expect(ok.status).toBe(200)
    expect(ok.body.match).toMatchObject({ id: 'beach-2', sportType: 'beach' })
    expect(leaks(JSON.stringify(ok.body))).toBe(false)
    expect(relay.validatePin({ pin: beachPins.refereePin, type: 'referee' }).status).toBe(404)
    expect(relay.validatePin({ pin: beachPins.refereePin, type: 'referee', sport: 'snow' }).status).toBe(400)
    // A periodic sync without its teams keeps the sport
    msg(relay, scorer, { type: 'sync-match-data', matchId: 1, match: { id: 1, seed_key: 'beach-2', status: 'live', refereeConnectionEnabled: true }, team1: { name: 'Keller / Huber' } })
    expect(relay.validatePin({ pin: beachPins.refereePin, type: 'referee', sport: 'beach' }).status).toBe(200)
    // An indoor match is never found by a beach PIN check
    const indoor = connect(relay, '192.168.1.11')
    msg(relay, indoor, syncMessage())
    expect(relay.validatePin({ pin: PINS.refereePin, type: 'referee', sport: 'beach' }).status).toBe(404)
    expect(relay.validatePin({ pin: PINS.refereePin, type: 'referee', sport: 'indoor' }).status).toBe(200)
  })

  it('takes openbeach\'s team1Team / team2Team as the home / away team', () => {
    const relay = createLanRelay()
    const scorer = connect(relay, '192.168.1.10')
    const viewer = connect(relay, '192.168.1.20')
    const beach = { ...syncMessage(makeMatch({ seed_key: 'beach-1' })), homeTeam: undefined, awayTeam: undefined }
    msg(relay, scorer, { ...beach, team1Team: { id: 1, name: 'Muster / Meier', color: '#e2001a' }, team2Team: { id: 2, name: 'Rossi / Bianchi' } })
    // Its row names the sport: openbeach lists only its own matches
    expect(relay.listMatches().body.matches[0]).toMatchObject({ homeTeam: 'Muster / Meier', awayTeam: 'Rossi / Bianchi', sportType: 'beach' })
    msg(relay, viewer, { type: 'subscribe-match', matchId: 'beach-1' })
    const summary = viewer.last('match-full-data')
    expect(summary.access).toBe('summary')
    expect(summary.homeTeam).toEqual({ name: 'Muster / Meier', color: '#e2001a' })
    expect(summary.awayTeam).toEqual({ name: 'Rossi / Bianchi' })
    // Its periodic sync names them team1 / team2
    msg(relay, scorer, { ...beach, team1: { name: 'Muster / Meier' }, team2: { name: 'Keller / Huber' } })
    expect(relay.listMatches().body.matches[0].awayTeam).toBe('Keller / Huber')
    // The same scorer's sync without team1Team keeps the court a beach one
    expect(relay.listMatches().body.matches[0].sportType).toBe('beach')
  })

  it('accepts the legacy nested `data` shape in the client reader', () => {
    const legacy = { type: 'match-data-update', matchId: '7', data: { match: { id: 7 }, sets: [{ id: 1 }] } }
    expect(readRelayBundle(legacy).sets).toHaveLength(1)
    expect(readRelayBundle({ type: 'match-data-update', matchId: '7' })).toBeNull()
  })
})

describe('main-instance lock (shared by every relay)', () => {
  const interfaces = () => ({ lo: [{ address: '127.0.0.1' }], wlan0: [{ address: '192.168.1.5' }] })

  it('treats loopback and the host\'s own LAN IP as local, other devices as remote', () => {
    const isLocal = createLocalAddressCheck(interfaces)
    expect(isLocal('::1')).toBe(true)
    expect(isLocal('::ffff:127.0.0.1')).toBe(true)
    expect(isLocal('192.168.1.5')).toBe(true) // the scoretable calls the relay on its LAN IP
    expect(isLocal('::ffff:192.168.1.5')).toBe(true)
    expect(isLocal('192.168.1.50')).toBe(false)
    expect(isLocal(undefined)).toBe(false)
  })

  it('only the relay host can take or release the lock, so no LAN device can lock anyone out', () => {
    const gate = createMainInstanceGate({ isLocal: createLocalAddressCheck(interfaces) })
    expect(gate.register('tablet', '192.168.1.50').status).toBe(403)
    expect(gate.mainInstanceId).toBeNull()
    expect(gate.register('desk', '192.168.1.5')).toMatchObject({ status: 200, body: { success: true, instanceId: 'desk' } })
    expect(gate.blocksMainPage('192.168.1.50', undefined)).toBe(true)
    expect(gate.blocksMainPage('192.168.1.50', 'desk')).toBe(false)
    expect(gate.blocksMainPage('127.0.0.1', undefined)).toBe(false)
    // A LAN device cannot release it (even knowing the id from /api/server/status)
    expect(gate.unregister('desk', '192.168.1.50').status).toBe(403)
    // The host re-registers after a reload with a new id, and can release it
    expect(gate.register('desk-2', '127.0.0.1').status).toBe(200)
    expect(gate.unregister(undefined, '::1').status).toBe(200)
    expect(gate.mainInstanceId).toBeNull()
  })

  it('locks the "/" page only: a LAN browser opts in to score another court', () => {
    const gate = createMainInstanceGate({ isLocal: createLocalAddressCheck(interfaces) })
    gate.register('desk', '127.0.0.1')
    const request = (url, headers = {}) => {
      const req = { url, headers, socket: { remoteAddress: '192.168.1.50' } }
      const res = { status: null, headers: null, body: '', writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b || '' } }
      return { handled: gate.handleMainPage(req, res, url.split('?')[0]), res }
    }
    const locked = request('/')
    expect(locked.handled).toBe(true)
    expect(locked.res.status).toBe(403)
    expect(locked.res.body).toContain('/?court=other')
    const optIn = request('/?court=other')
    expect(optIn.res.status).toBe(302)
    expect(optIn.res.headers.Location).toBe('/')
    expect(optIn.res.headers['Set-Cookie']).toMatch(new RegExp(`^${OTHER_COURT_COOKIE}=1;`))
    // With the cookie: served (reloads included); other pages were never locked
    expect(request('/', { cookie: `theme=light; ${OTHER_COURT_COOKIE}=1` }).handled).toBe(false)
    expect(request('/index.html', { cookie: `${OTHER_COURT_COOKIE}=1` }).handled).toBe(false)
    expect(request('/', { cookie: `${OTHER_COURT_COOKIE}=10` }).res.status).toBe(403)
    expect(request('/referee').handled).toBe(false)
    expect(gate.blocksMainPage('192.168.1.50', undefined, `${OTHER_COURT_COOKIE}=1`)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration: the same scenario against each real relay runtime
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer()
    srv.unref()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

function openClient(url, wsOptions) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, wsOptions)
    const client = { ws, messages: [], raw: [] }
    client.waitFor = (pred, timeoutMs = 3000) => new Promise((ok, fail) => {
      const found = client.messages.find(pred)
      if (found) return ok(found)
      const timer = setTimeout(() => fail(new Error('timed out waiting for message')), timeoutMs)
      const check = () => {
        const m = client.messages.find(pred)
        if (m) {
          clearTimeout(timer)
          ws.off('message', check)
          ok(m)
        }
      }
      ws.on('message', check)
    })
    client.send = (m) => ws.send(JSON.stringify(m))
    ws.on('message', (data) => {
      client.raw.push(data.toString())
      client.messages.push(JSON.parse(data.toString()))
    })
    ws.once('open', () => client.waitFor((m) => m.type === 'connected').then(() => res(client), rej))
    ws.once('error', rej)
  })
}

async function waitForHttp(url, timeoutMs = 10000) {
  const start = Date.now()
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`server at ${url} did not start`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function relayScenario({ httpBase, wsUrl }) {
  const scoreboard = await openClient(wsUrl)
  const referee = await openClient(wsUrl)
  const attacker = await openClient(wsUrl)

  scoreboard.send(syncMessage())
  scoreboard.send({ type: 'ping' })
  await scoreboard.waitFor((m) => m.type === 'pong') // sync processed (same socket, in order)

  referee.send({ type: 'subscribe-match', matchId: '7', pin: PINS.refereePin })
  const full = await referee.waitFor((m) => m.type === 'match-full-data')
  expect(full.access).toBe('full')
  expect(readRelayBundle(full).match.id).toBe(7)
  // Without a PIN: the public summary, and no match actions
  const viewer = await openClient(wsUrl)
  viewer.send({ type: 'subscribe-match', matchId: '7' })
  const summary = await viewer.waitFor((m) => m.type === 'match-full-data')
  expect(summary.access).toBe('summary')
  expect(summary.homePlayers).toEqual([])
  expect(summary.match.status).toBe('live')

  scoreboard.send(syncMessage(makeMatch(), { events: [{ id: 1, type: 'point' }] }))
  const update = await referee.waitFor((m) => m.type === 'match-data-update')
  const payload = readRelayBundle(update)
  expect(update.matchId).toBe('7')
  expect(payload.match.id).toBe(7)
  expect(payload.events).toHaveLength(1)
  expect(payload.homeTeam.name).toBe('Home VC')

  expect((await viewer.waitFor((m) => m.type === 'match-data-update')).events).toEqual([])

  scoreboard.send({ type: 'match-action', matchId: 7, action: 'timeout', data: { team: 'home' }, timestamp: Date.now() })
  const action = await referee.waitFor((m) => m.type === 'match-action')
  expect(action.data).toEqual({ team: 'home' })
  viewer.send({ type: 'ping' })
  await viewer.waitFor((m) => m.type === 'pong')
  expect(viewer.messages.some((m) => m.type === 'match-action')).toBe(false)
  viewer.ws.close()

  // Live-state: pushed live, and a LedBox bridge that (re)subscribes mid-match
  // reads it from match-full-data the way point-hub does (msg.data.liveState)
  const liveState = { points_a: 12, points_b: 10, side_a: 'left' }
  scoreboard.send({ type: 'live-state-update', matchId: 7, liveState })
  expect((await referee.waitFor((m) => m.type === 'live-state-update')).liveState).toEqual(liveState)
  const bridge = await openClient(wsUrl)
  bridge.send({ type: 'subscribe-match', matchId: '7' })
  const bridgeFull = await bridge.waitFor((m) => m.type === 'match-full-data')
  expect(bridgeFull.data).toEqual({ liveState })
  expect(readRelayBundle(bridgeFull).liveState).toEqual(liveState)
  expect(containsPin(bridge.raw.join(''))).toBe(false)
  bridge.ws.close()

  // Unproven sockets cannot destroy or overwrite the match
  attacker.send({ type: 'clear-all-matches' })
  await attacker.waitFor((m) => m.type === 'error' && m.code === 'not-scoreboard')
  attacker.send({ type: 'delete-match', matchId: '7' })
  attacker.send(syncMessage(makeMatch({ gamePin: '000000' })))
  await attacker.waitFor((m) => m.type === 'error' && m.code === 'not-match-owner')

  // HTTP endpoints: PINs never come back
  const validate = (pin, type) => fetch(`${httpBase}/api/match/validate-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, type })
  })
  const ok = await validate(PINS.refereePin, 'referee')
  expect(ok.status).toBe(200)
  const okText = await ok.text()
  expect(JSON.parse(okText).match.id).toBe(7)
  expect(containsPin(okText)).toBe(false)
  expect(containsPersonal(okText)).toBe(false)
  expect((await validate('000001', 'referee')).status).toBe(404)

  // The match list (display devices, e.g. the LedBox bridge) shows every
  // published match, also one with the referee connection off, newest first
  const second = await openClient(wsUrl)
  second.send(syncMessage(makeMatch({ id: 1, seed_key: 'seed-off', gamePin: '555555', status: 'scheduled', refereeConnectionEnabled: false, scheduledAt: '2026-10-04T18:00:00.000Z' })))
  second.send({ type: 'ping' })
  await second.waitFor((m) => m.type === 'pong')
  const list = await fetch(`${httpBase}/api/match/list`)
  const listText = await list.text()
  expect(list.status).toBe(200)
  const listed = JSON.parse(listText).matches
  expect(listed.map((m) => m.id)).toEqual([7, 'seed-off'])
  expect(listed[1]).toMatchObject({
    homeTeam: 'Home VC', awayTeam: 'Away VC', status: 'scheduled', sportType: 'indoor', test: false,
    refereeConnectionEnabled: false, homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: false
  })
  // One row shape on every relay (dateTime: a display string, or null where
  // the relay has no time zone data and the client formats scheduledAt)
  for (const row of listed) {
    expect(Object.keys(row).sort()).toEqual(LIST_ROW_KEYS)
    expect(row.dateTime === null || typeof row.dateTime === 'string').toBe(true)
  }
  expect(containsPin(listText)).toBe(false)
  expect(containsPersonal(listText)).toBe(false)
  // A finished match: only with ?finished=1 (the livescore), same row shape
  second.send(syncMessage(makeMatch({ id: 2, seed_key: 'seed-done', gamePin: '666666', status: 'ended', scheduledAt: '2026-10-03T18:00:00.000Z' })))
  second.send({ type: 'ping' })
  await second.waitFor((m) => m.type === 'pong')
  expect((await (await fetch(`${httpBase}/api/match/list`)).json()).matches.map((m) => m.id)).toEqual([7, 'seed-off'])
  const withFinished = await fetch(`${httpBase}/api/match/list?finished=1`)
  const withFinishedText = await withFinished.text()
  const finishedRows = JSON.parse(withFinishedText).matches
  expect(finishedRows.map((m) => m.id)).toEqual([7, 'seed-off', 'seed-done'])
  expect(finishedRows[2].status).toBe('ended')
  for (const row of finishedRows) expect(Object.keys(row).sort()).toEqual(LIST_ROW_KEYS)
  expect(containsPin(withFinishedText)).toBe(false)
  expect(containsPersonal(withFinishedText)).toBe(false)
  second.send({ type: 'delete-match', matchId: 'seed-done' })
  second.send({ type: 'delete-match', matchId: 'seed-off' })
  second.ws.close()

  for (const path of ['/api/match/7', '/api/match/by-game-number?gameNumber=4242', '/api/match/by-game-number?gameNumber=7']) {
    const r = await fetch(httpBase + path)
    const text = await r.text()
    expect(r.status, path).toBe(200)
    expect(containsPin(text), path).toBe(false)
    expect(containsPersonal(text), path).toBe(false)
  }
  // GET /api/match/:id: summary without a PIN, the bundle with one (header)
  const anonMatch = await (await fetch(`${httpBase}/api/match/7`)).json()
  expect(anonMatch).toMatchObject({ success: true, access: 'summary', homePlayers: [], events: [] })
  const pinned = await fetch(`${httpBase}/api/match/7`, { headers: { 'X-OV-Match-Pin': PINS.refereePin } })
  const pinnedText = await pinned.text()
  expect(JSON.parse(pinnedText)).toMatchObject({ success: true, access: 'full' })
  expect(JSON.parse(pinnedText).homePlayers[0]).toMatchObject({ number: 7 })
  expect(containsPin(pinnedText) || containsPersonal(pinnedText)).toBe(false)
  const conns = await fetch(`${httpBase}/api/server/connections`)
  expect(conns.headers.get('content-type')).toMatch(/json/)
  expect((await conns.json()).matchSubscriptions).toEqual({ '7': 1 })

  // Main-instance lock: the scoretable on this machine can take it (POST, as
  // MatchSetup sends it) and release it
  const register = await fetch(`${httpBase}/api/server/register-main`, { method: 'POST', headers: { 'X-Instance-ID': 'contract-test' } })
  expect(register.status).toBe(200)
  expect((await (await fetch(`${httpBase}/api/server/status`)).json()).hasMainInstance).toBe(true)
  const unregister = await fetch(`${httpBase}/api/server/unregister-main`, { method: 'POST', headers: { 'X-Instance-ID': 'contract-test' } })
  expect(unregister.status).toBe(200)

  // Nothing ever asked a WS client about a PIN, and no PIN reached a subscriber
  for (const c of [scoreboard, referee, attacker]) {
    expect(c.messages.some((m) => m.type === 'pin-validation-request')).toBe(false)
  }
  expect(containsPin(referee.raw.join('')) || containsPin(attacker.raw.join(''))).toBe(false)
  expect(containsPersonal(referee.raw.join('')) || containsPersonal(attacker.raw.join(''))).toBe(false)

  // The real scoreboard can delete; subscribers are told
  scoreboard.send({ type: 'delete-match', matchId: 7 })
  await referee.waitFor((m) => m.type === 'match-deleted' && m.matchId === '7')

  for (const c of [scoreboard, referee, attacker]) c.ws.close()
}

describe('relay runtimes speak the shared protocol', () => {
  it('standalone server.js', async () => {
    const [port, wsPort] = [await freePort(), await freePort()]
    const child = spawn(process.execPath, ['server.js'], {
      cwd: FRONTEND_DIR,
      env: { ...process.env, PORT: String(port), WS_PORT: String(wsPort), HTTPS: 'false', NODE_ENV: 'test' },
      stdio: 'ignore'
    })
    try {
      await waitForHttp(`http://127.0.0.1:${port}/api/server/status`)
      await relayScenario({ httpBase: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${wsPort}` })
      await runBeachVenueContract({ httpBase: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${wsPort}`, openClient, tag: 'server-js' })
      const unknown = await fetch(`http://127.0.0.1:${port}/api/nope`)
      expect(unknown.status).toBe(404)
      expect(unknown.headers.get('content-type')).toMatch(/json/)
    } finally {
      child.kill('SIGKILL')
    }
  }, 20000)

  // With HTTPS on, browsers need wss:// while LAN tools (LedBox bridge:
  // ws://127.0.0.1:8080) speak plain ws:// — both on the same WS port.
  const opensslOk = spawnSync('openssl', ['version']).status === 0
  it.skipIf(!opensslOk)('standalone server.js with HTTPS serves wss:// and ws:// on the WS port', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'ov-relay-cert-'))
    const cert = resolve(dir, 'cert.pem')
    const key = resolve(dir, 'key.pem')
    spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'])
    const [port, wsPort] = [await freePort(), await freePort()]
    const child = spawn(process.execPath, ['server.js'], {
      cwd: FRONTEND_DIR,
      env: { ...process.env, PORT: String(port), WS_PORT: String(wsPort), HTTPS: 'true', SSL_CERT_PATH: cert, SSL_KEY_PATH: key, NODE_ENV: 'test' },
      stdio: 'ignore'
    })
    const clients = []
    try {
      const start = Date.now()
      for (;;) {
        try {
          clients.push(await openClient(`ws://127.0.0.1:${wsPort}`))
          break
        } catch {
          if (Date.now() - start > 10000) throw new Error('server.js (HTTPS) did not start')
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      const secure = await openClient(`wss://127.0.0.1:${wsPort}`, { rejectUnauthorized: false })
      clients.push(secure)
      const [plain] = clients
      secure.send(syncMessage())
      secure.send({ type: 'live-state-update', matchId: 7, liveState: { points_a: 1 } })
      secure.send({ type: 'ping' })
      await secure.waitFor((m) => m.type === 'pong')
      plain.send({ type: 'subscribe-match', matchId: '7' })
      const full = await plain.waitFor((m) => m.type === 'match-full-data')
      expect(full.data).toEqual({ liveState: { points_a: 1 } })
      expect(containsPin(plain.raw.join(''))).toBe(false)
    } finally {
      for (const c of clients) c.ws.close()
      child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)

  it('Electron in-process relay', async () => {
    const relayServer = require('../../../electron/relayServer.js')
    const [port, wsPort] = [await freePort(), await freePort()]
    await relayServer.start({ port, wsPort })
    try {
      await relayScenario({ httpBase: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${wsPort}` })
      await runBeachVenueContract({ httpBase: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${wsPort}`, openClient, tag: 'electron' })
    } finally {
      await relayServer.stop()
    }
  }, 20000)

  // The Rust port can't run in plain CI without building Tauri; point this at a
  // built binary to check it too:
  //   OV_TAURI_RELAY_BIN=src-tauri/target/debug/openvolley-escoresheet npx vitest run lanRelayProtocol
  it.skipIf(!process.env.OV_TAURI_RELAY_BIN)('Tauri Rust relay (OV_TAURI_RELAY_BIN)', async () => {
    const [port, wsPort] = [await freePort(), await freePort()]
    const child = spawn(process.env.OV_TAURI_RELAY_BIN, ['--server-only'], {
      env: { ...process.env, OPENVOLLEY_HTTP_PORT: String(port), OPENVOLLEY_WS_PORT: String(wsPort) },
      stdio: 'ignore'
    })
    try {
      await waitForHttp(`http://127.0.0.1:${port}/api/health`)
      await relayScenario({ httpBase: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${wsPort}` })
      await runBeachVenueContract({ httpBase: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${wsPort}`, openClient, tag: 'tauri' })
      const unknown = await fetch(`http://127.0.0.1:${port}/api/nope`)
      expect(unknown.status).toBe(404)
    } finally {
      child.kill('SIGKILL')
    }
  }, 30000)

  describe('Vite dev plugin', () => {
    let plugin
    let httpServer
    let httpBase
    let wsPort

    beforeAll(async () => {
      // Port 0: the system picks a free port as the server binds it. A port
      // from freePort() was free when looked up, but another worker could bind
      // it before the plugin did (EADDRINUSE, then ECONNREFUSED here).
      plugin = vitePluginApiRoutes({ wsPort: 0 })
      let middleware = null
      plugin.configureServer({
        config: { server: { https: false, port: 5173 } },
        middlewares: { use: (_prefix, fn) => { middleware = fn } }
      })
      wsPort = plugin.boundWsPort()
      expect(wsPort).toBeGreaterThan(0)
      // Mimic connect's `.use('/api', fn)` prefix stripping
      httpServer = createHttpServer((req, res) => {
        if (!req.url.startsWith('/api/')) {
          res.writeHead(404)
          return res.end()
        }
        req.url = req.url.slice('/api'.length)
        middleware(req, res, () => {
          res.writeHead(404)
          res.end()
        })
      })
      await new Promise((r) => httpServer.listen(0, '127.0.0.1', r))
      httpBase = `http://127.0.0.1:${httpServer.address().port}`
    })

    afterAll(async () => {
      plugin?.closeBundle()
      await new Promise((r) => httpServer.close(r))
    })

    it('serves the same protocol', async () => {
      await relayScenario({ httpBase, wsUrl: `ws://127.0.0.1:${wsPort}` })
      await runBeachVenueContract({ httpBase, wsUrl: `ws://127.0.0.1:${wsPort}`, openClient, tag: 'vite' })
    }, 20000)
  })
})
