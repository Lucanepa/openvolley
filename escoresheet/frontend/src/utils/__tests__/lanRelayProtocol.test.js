// @vitest-environment node
/**
 * Contract tests for the LAN relay wire protocol (electron/lanRelayCore.cjs),
 * exercised through every Node relay runtime that uses it — the standalone
 * server (server.js), the Electron in-process relay and the Vite dev plugin —
 * and checked against what the client (serverDataSync.readRelayBundle) reads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import WebSocket from 'ws'
import { createLanRelay } from '../../../lanRelayCore.js'
import { vitePluginApiRoutes } from '../../../vite-plugin-api-routes.js'
import { readRelayBundle } from '../serverDataSync'

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
    homePlayers: [{ id: 11, teamId: 1, number: 7 }],
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

function connect(relay) {
  const ws = fakeSocket()
  relay.addClient(ws, { ip: '192.168.1.50' })
  return ws
}

const msg = (relay, ws, m) => relay.handleMessage(ws, JSON.stringify(m))

describe('lanRelayCore protocol', () => {
  it('fans match-data-update out flat, PIN-free and keyed by String(matchId)', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay)
    const referee = connect(relay)
    msg(relay, referee, { type: 'subscribe-match', matchId: '7' })
    msg(relay, scoreboard, syncMessage())

    const update = referee.last('match-data-update')
    expect(update).toBeTruthy()
    expect(update.matchId).toBe('7')
    expect(update.data).toBeUndefined()
    expect(update.match.id).toBe(7)
    expect(containsPin(referee.raw.join(''))).toBe(false)

    const payload = readRelayBundle(update)
    expect(payload.match.gameNumber).toBe(4242)
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
  })

  it('forwards match-action with the payload the scoreboard sends as `data`', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay)
    const referee = connect(relay)
    msg(relay, scoreboard, syncMessage())
    msg(relay, referee, { type: 'subscribe-match', matchId: '7' })
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
    msg(relay, referee, { type: 'subscribe-match', matchId: '7' })
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

  it('keeps the scoreboard live-state across syncs and forwards it', () => {
    const relay = createLanRelay()
    const scoreboard = connect(relay)
    const ledbox = connect(relay)
    msg(relay, scoreboard, syncMessage())
    msg(relay, ledbox, { type: 'subscribe-match', matchId: '7' })
    msg(relay, scoreboard, { type: 'live-state-update', matchId: 7, liveState: { points_a: 5, points_b: 3 } })
    expect(ledbox.last('live-state-update')).toEqual({ type: 'live-state-update', matchId: '7', liveState: { points_a: 5, points_b: 3 } })
    msg(relay, scoreboard, syncMessage())
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

  it('accepts the legacy nested `data` shape in the client reader', () => {
    const legacy = { type: 'match-data-update', matchId: '7', data: { match: { id: 7 }, sets: [{ id: 1 }] } }
    expect(readRelayBundle(legacy).sets).toHaveLength(1)
    expect(readRelayBundle({ type: 'match-data-update', matchId: '7' })).toBeNull()
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

function openClient(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
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

  referee.send({ type: 'subscribe-match', matchId: '7' })
  const full = await referee.waitFor((m) => m.type === 'match-full-data')
  expect(readRelayBundle(full).match.id).toBe(7)

  scoreboard.send(syncMessage(makeMatch(), { events: [{ id: 1, type: 'point' }] }))
  const update = await referee.waitFor((m) => m.type === 'match-data-update')
  const payload = readRelayBundle(update)
  expect(update.matchId).toBe('7')
  expect(payload.match.id).toBe(7)
  expect(payload.events).toHaveLength(1)
  expect(payload.homeTeam.name).toBe('Home VC')

  scoreboard.send({ type: 'match-action', matchId: 7, action: 'timeout', data: { team: 'home' }, timestamp: Date.now() })
  const action = await referee.waitFor((m) => m.type === 'match-action')
  expect(action.data).toEqual({ team: 'home' })

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
  expect((await validate('000001', 'referee')).status).toBe(404)

  const list = await fetch(`${httpBase}/api/match/list`)
  const listText = await list.text()
  expect(list.status).toBe(200)
  expect(JSON.parse(listText).matches.map((m) => m.id)).toEqual([7])
  expect(containsPin(listText)).toBe(false)

  for (const path of ['/api/match/7', '/api/match/by-game-number?gameNumber=4242', '/api/match/by-game-number?gameNumber=7']) {
    const r = await fetch(httpBase + path)
    const text = await r.text()
    expect(r.status, path).toBe(200)
    expect(containsPin(text), path).toBe(false)
  }
  const conns = await fetch(`${httpBase}/api/server/connections`)
  expect(conns.headers.get('content-type')).toMatch(/json/)
  expect((await conns.json()).matchSubscriptions).toEqual({ '7': 1 })

  // Nothing ever asked a WS client about a PIN, and no PIN reached a subscriber
  for (const c of [scoreboard, referee, attacker]) {
    expect(c.messages.some((m) => m.type === 'pin-validation-request')).toBe(false)
  }
  expect(containsPin(referee.raw.join('')) || containsPin(attacker.raw.join(''))).toBe(false)

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
      const unknown = await fetch(`http://127.0.0.1:${port}/api/nope`)
      expect(unknown.status).toBe(404)
      expect(unknown.headers.get('content-type')).toMatch(/json/)
    } finally {
      child.kill('SIGKILL')
    }
  }, 20000)

  it('Electron in-process relay', async () => {
    const relayServer = require('../../../electron/relayServer.js')
    const [port, wsPort] = [await freePort(), await freePort()]
    await relayServer.start({ port, wsPort })
    try {
      await relayScenario({ httpBase: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${wsPort}` })
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
      wsPort = await freePort()
      plugin = vitePluginApiRoutes({ wsPort })
      let middleware = null
      plugin.configureServer({
        config: { server: { https: false, port: 5173 } },
        middlewares: { use: (_prefix, fn) => { middleware = fn } }
      })
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
    }, 20000)
  })
})
