// @vitest-environment node
/**
 * Sign on phone on the Node LAN relays (lanRelayCore createLanRelay,
 * docs/qr-signing-spec.md 4.5, 8.2): who may start a session (the relay host,
 * or the game PIN of a match the relay holds), the body caps, the timer
 * lifecycle that must never keep `vite build` alive (B3), and the same HTTP
 * scenario through every runtime: server.js, the Electron relay, the Vite
 * plugin and (OV_TAURI_RELAY_BIN) the Rust relay.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createLanRelay } from '../../../lanRelayCore.js'
import { vitePluginApiRoutes } from '../../../vite-plugin-api-routes.js'
import { signHttpScenario, signPageCheck } from '../../../electron/__fixtures__/signHttpScenario.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(here, '../../..')
const require = createRequire(import.meta.url)
const HAS_SIGN_PAGE = existsSync(resolve(FRONTEND_DIR, 'dist', 'sign', 'index.html'))

const CTX = { home: 'A', away: 'B' }
const INK = { pad: { w: 4000, h: 2000 }, strokes: [[0, 1000, 300, 1000]] }

/** One request straight into handleApiRequest (no network). */
function call(relay, path, body, { headers = {}, addr = '127.0.0.1', raw = null } = {}) {
  const text = raw !== null ? raw : JSON.stringify(body)
  const req = Readable.from([Buffer.from(text)])
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json', ...headers }
  req.socket = { remoteAddress: addr }
  return new Promise((resolveCall) => {
    const res = new EventEmitter()
    res.headersSent = false
    res.writableEnded = false
    res.writeHead = (status, h) => { res.status = status; res.headers = h; res.headersSent = true }
    res.end = (out) => {
      res.writableEnded = true
      resolveCall({ status: res.status, headers: res.headers, json: JSON.parse(out) })
      res.emit('close')
    }
    expect(relay.handleApiRequest(req, res, path)).toBe(true)
  })
}

function fakeSocket() {
  return { readyState: 1, sent: [], send(t) { this.sent.push(JSON.parse(t)) } }
}

/** A scorer's socket that synced match `seed` with game PIN `pin`. */
function syncMatch(relay, seed, pin) {
  const ws = fakeSocket()
  relay.addClient(ws, { ip: '127.0.0.1' })
  relay.handleMessage(ws, JSON.stringify({
    type: 'sync-match-data',
    matchId: 1,
    match: { id: 1, seed_key: seed, status: 'live', gamePin: pin, refereePin: '314159', refereeConnectionEnabled: true },
    homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, homePlayers: [], awayPlayers: [], sets: [], events: [],
  }))
  expect(relay.hasMatch(seed)).toBe(true)
}

const relays = []
function newRelay(options) {
  const r = createLanRelay({ log: { log() {}, error() {} }, ...options })
  relays.push(r)
  return r
}
afterEach(() => { while (relays.length) relays.pop().close() })

describe('Sign on phone on the LAN relay core', () => {
  it('the relay host itself may start a session', async () => {
    const relay = newRelay({ isLocal: () => true })
    const r = await call(relay, '/api/sign/start', { slot: 'scorer', context: CTX }, { addr: '192.168.1.10' })
    expect(r.status).toBe(201)
    expect(r.headers['Cache-Control']).toBe('no-store')
  })

  it('by default only loopback counts as the relay host', async () => {
    const relay = newRelay()
    expect((await call(relay, '/api/sign/start', { slot: 'scorer', context: CTX }, { addr: '::ffff:127.0.0.1' })).status).toBe(201)
    expect((await call(relay, '/api/sign/start', { slot: 'scorer', context: CTX }, { addr: '192.168.1.66' })).json.code).toBe('OV_SIGN_FORBIDDEN')
  })

  it('another device needs the game PIN of a match the relay holds', async () => {
    const relay = newRelay({ isLocal: () => false })
    syncMatch(relay, 'seed-1', '987654')
    const start = (headers, matchKey = 'seed-1') => call(relay, '/api/sign/start', { slot: 'captain-a', matchKey, context: CTX }, { headers, addr: '192.168.1.66' })

    expect((await start({})).json.code).toBe('OV_SIGN_FORBIDDEN')
    // The referee PIN proves nothing here: only the game PIN starts a session
    expect((await start({ 'x-ov-match-pin': '314159' })).json.code).toBe('OV_SIGN_PIN_INVALID')
    // A match the relay does not hold: forbidden, not counted
    expect((await start({ 'x-ov-match-pin': '987654' }, 'other')).json.code).toBe('OV_SIGN_FORBIDDEN')
    const ok = await start({ 'x-ov-match-pin': ' 987654 ' })
    expect(ok.status).toBe(201)
    // The session works like any other
    const open = await call(relay, '/api/sign/open', { k: ok.json.token }, { addr: '192.168.1.77' })
    expect(open.json).toMatchObject({ ok: true, state: 'opened', slot: 'captain-a' })
  })

  it('wrong game PINs are counted per IP and then refused without comparing', async () => {
    const relay = newRelay({ isLocal: () => false })
    syncMatch(relay, 'seed-1', '987654')
    const start = (pin) => call(relay, '/api/sign/start', { slot: 'captain-a', matchKey: 'seed-1', context: CTX }, { headers: { 'x-ov-match-pin': pin }, addr: '192.168.1.66' })
    for (let i = 0; i < 5; i++) expect((await start(String(100000 + i))).json.code).toBe('OV_SIGN_PIN_INVALID')
    const blocked = await start('987654')
    expect(blocked.status).toBe(429)
    expect(blocked.json.code).toBe('OV_SIGN_RATE_LIMITED')
    expect(blocked.headers['Retry-After']).toBe('60')
    // The same counter as GET /api/match/:id with a wrong PIN
    expect((await relay.getMatch('seed-1', { pin: '987654', ip: '192.168.1.66' })).status).toBe(429)
  })

  it('a dual-stack address shares one wrong-PIN budget with GET /api/match/:id', async () => {
    // A server listening on '::' sees IPv4 callers as '::ffff:a.b.c.d'; the
    // budget must not split between that spelling and the stripped one
    const relay = newRelay({ isLocal: () => false })
    syncMatch(relay, 'seed-1', '987654')
    const addr = '::ffff:192.168.1.67'
    for (let i = 0; i < 3; i++) expect((await relay.getMatch('seed-1', { pin: String(200000 + i), ip: addr })).status).toBe(200)
    const start = (pin) => call(relay, '/api/sign/start', { slot: 'captain-a', matchKey: 'seed-1', context: CTX }, { headers: { 'x-ov-match-pin': pin }, addr })
    for (let i = 0; i < 2; i++) expect((await start(String(100000 + i))).json.code).toBe('OV_SIGN_PIN_INVALID')
    expect((await start('987654')).status).toBe(429)
  })

  it('a test match without a game PIN cannot be proven by anyone else', async () => {
    const relay = newRelay({ isLocal: () => false })
    syncMatch(relay, 'test-1', null)
    const r = await call(relay, '/api/sign/start', { slot: 'scorer', matchKey: 'test-1', context: CTX }, { headers: { 'x-ov-match-pin': '000000' }, addr: '192.168.1.66' })
    expect(r.json.code).toBe('OV_SIGN_FORBIDDEN')
  })

  it('caps the bodies and wants JSON', async () => {
    const relay = newRelay()
    const big = await call(relay, '/api/sign/start', null, { raw: JSON.stringify({ slot: 'ref1', context: { ...CTX, name: 'x'.repeat(4100) } }) })
    expect(big.status).toBe(413)
    expect(big.json.code).toBe('OV_SIGN_TOO_LARGE')
    expect(big.headers.Connection).toBe('close')
    const started = await call(relay, '/api/sign/start', { slot: 'ref1', context: CTX })
    const okSize = JSON.stringify({ k: started.json.token, pad: INK.pad, strokes: [Array.from({ length: 2000 }, (_, i) => (i % 2 ? 1000 : i))] })
    expect(okSize.length).toBeLessThan(65536)
    expect((await call(relay, '/api/sign/submit', null, { raw: okSize })).status).not.toBe(413)
    const tooBig = JSON.stringify({ k: started.json.token, pad: INK.pad, strokes: [Array.from({ length: 30000 }, () => 1000)] })
    expect((await call(relay, '/api/sign/submit', null, { raw: tooBig })).status).toBe(413)
    expect((await call(relay, '/api/sign/open', { k: started.json.token }, { headers: { 'content-type': 'text/plain' } })).json.code).toBe('OV_SIGN_BAD_REQUEST')
    expect((await call(relay, '/api/sign/open', null, { raw: 'nope' })).json.code).toBe('OV_SIGN_BAD_REQUEST')
  })

  it('without the sign module every call answers unavailable', async () => {
    const core = require('../../../electron/lanRelayCore.cjs')
    const relay = core.createLanRelay({ log: { log() {}, error() {} } })
    relays.push(relay)
    const r = await call(relay, '/api/sign/start', { slot: 'ref1', context: CTX })
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('OV_SIGN_UNAVAILABLE')
  })

  it('makes no sign timer before the first request and leaves no timer after close() (vite build must exit)', async () => {
    // Timers that keep the process alive (unref'd ones are not listed)
    const timeouts = () => process.getActiveResourcesInfo().filter((t) => t === 'Timeout').length
    const before = timeouts()
    const relay = createLanRelay({ log: { log() {}, error() {} } })
    expect(relay.signStats()).toBeNull()
    expect(timeouts()).toBe(before)
    const started = await call(relay, '/api/sign/start', { slot: 'ref1', context: CTX })
    expect(relay.signStats()).toMatchObject({ sessions: 1, sweeper: true })
    expect(timeouts()).toBe(before) // the sweeper is unref'd
    // A held wait keeps the process up while its request is open; close() answers it
    const held = call(relay, '/api/sign/wait', { watch: started.json.watch, known: 'pending' })
    await new Promise((r) => setImmediate(r))
    expect(relay.signStats().waiters).toBe(1)
    expect(timeouts()).toBe(before + 1)
    relay.close()
    expect((await held).json.code).toBe('OV_SIGN_UNAVAILABLE')
    expect(relay.signStats()).toBeNull()
    expect(timeouts()).toBe(before)
  })

  it('a wait whose scoring device went away is dropped', async () => {
    const relay = newRelay()
    const started = await call(relay, '/api/sign/start', { slot: 'ref1', context: CTX })
    const req = Readable.from([Buffer.from(JSON.stringify({ watch: started.json.watch, known: 'pending' }))])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json' }
    req.socket = { remoteAddress: '127.0.0.1' }
    const res = new EventEmitter()
    res.headersSent = false
    res.writableEnded = false
    let wrote = false
    res.writeHead = () => { wrote = true }
    res.end = () => {}
    relay.handleApiRequest(req, res, '/api/sign/wait')
    await new Promise((r) => setTimeout(r, 20))
    expect(relay.signStats().waiters).toBe(1)
    res.emit('close')
    await new Promise((r) => setImmediate(r))
    expect(relay.signStats().waiters).toBe(0)
    expect(wrote).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Runtimes
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

async function waitForHttp(url, timeoutMs = 10000) {
  const start = Date.now()
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`server at ${url} did not start`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('every Node relay runtime and the Rust relay speak Sign on phone', () => {
  it('standalone server.js', async () => {
    const [port, wsPort] = [await freePort(), await freePort()]
    const child = spawn(process.execPath, ['server.js'], {
      cwd: FRONTEND_DIR,
      env: { ...process.env, PORT: String(port), WS_PORT: String(wsPort), HTTPS: 'false', NODE_ENV: 'test' },
      stdio: 'ignore',
    })
    try {
      await waitForHttp(`http://127.0.0.1:${port}/api/server/status`)
      expect(await signHttpScenario({ httpBase: `http://127.0.0.1:${port}` })).toEqual([])
      if (HAS_SIGN_PAGE) expect(await signPageCheck({ httpBase: `http://127.0.0.1:${port}` })).toEqual([])
    } finally {
      child.kill('SIGKILL')
    }
  }, 30000)

  it('Electron in-process relay', async () => {
    const relayServer = require('../../../electron/relayServer.js')
    const [port, wsPort] = [await freePort(), await freePort()]
    await relayServer.start({ port, wsPort })
    try {
      expect(await signHttpScenario({ httpBase: `http://127.0.0.1:${port}` })).toEqual([])
      if (HAS_SIGN_PAGE) expect(await signPageCheck({ httpBase: `http://127.0.0.1:${port}` })).toEqual([])
    } finally {
      await relayServer.stop()
    }
  }, 30000)

  it('Vite dev plugin', async () => {
    // Port 0: bound at once on a port the system picks (a freePort() port can
    // be taken by another worker before the plugin binds it)
    const plugin = vitePluginApiRoutes({ wsPort: 0 })
    let middleware = null
    plugin.configureServer({
      config: { server: { https: false, port: 5173 } },
      middlewares: { use: (prefix, fn) => { if (prefix === '/api') middleware = fn } },
    })
    expect(plugin.boundWsPort()).toBeGreaterThan(0)
    const httpServer = createHttpServer((req, res) => {
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
    try {
      expect(await signHttpScenario({ httpBase: `http://127.0.0.1:${httpServer.address().port}` })).toEqual([])
    } finally {
      plugin.closeBundle()
      await new Promise((r) => httpServer.close(r))
    }
  }, 30000)

  // The Rust port needs a built binary (its dist/ embedded):
  //   OV_TAURI_RELAY_BIN=<target>/debug/openvolley-escoresheet npx vitest run lanRelaySign
  it.skipIf(!process.env.OV_TAURI_RELAY_BIN)('Tauri Rust relay (OV_TAURI_RELAY_BIN)', async () => {
    const [port, wsPort] = [await freePort(), await freePort()]
    const child = spawn(process.env.OV_TAURI_RELAY_BIN, ['--server-only'], {
      env: { ...process.env, OPENVOLLEY_HTTP_PORT: String(port), OPENVOLLEY_WS_PORT: String(wsPort) },
      stdio: 'ignore',
    })
    try {
      await waitForHttp(`http://127.0.0.1:${port}/api/health`)
      expect(await signHttpScenario({ httpBase: `http://127.0.0.1:${port}` })).toEqual([])
      expect(await signPageCheck({ httpBase: `http://127.0.0.1:${port}` })).toEqual([])
    } finally {
      child.kill('SIGKILL')
    }
  }, 60000)
})
