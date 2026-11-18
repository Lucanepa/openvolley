// @vitest-environment node
/**
 * Pair a phone on the Node LAN relays (lanRelayCore createLanRelay,
 * docs/phone-keyboard-spec.md): who may start a pairing (the relay host, or
 * the game PIN of a match the relay holds, as /api/sign/start), the body
 * caps, the timer lifecycle that must never keep `vite build` alive, and the
 * shared HTTP scenario through every runtime: server.js, the Vite plugin and
 * (OV_TAURI_RELAY_BIN) the Rust relay.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createLanRelay } from '../../../lanRelayCore.js'
import { vitePluginApiRoutes } from '../../../vite-plugin-api-routes.js'
import { pairHttpScenario, pairPageCheck } from '../../../electron/__fixtures__/pairHttpScenario.mjs'
import { TAURI_RELAY_BIN, startTauriRelay } from './tauriRelay.js'

const here = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(here, '../../..')
const HAS_PAIR_PAGE = existsSync(resolve(FRONTEND_DIR, 'dist', 'pair', 'index.html'))
const CTX = { home: 'A', away: 'B' }

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

function syncMatch(relay, seed, pin) {
  const ws = fakeSocket()
  relay.addClient(ws, { ip: '192.168.1.20' })
  relay.handleMessage(ws, JSON.stringify({
    type: 'sync-match-data',
    matchId: seed,
    match: { id: 1, seed_key: seed, status: 'live', gamePin: pin },
    homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, homePlayers: [], awayPlayers: [], sets: [], events: [],
  }))
  return ws
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)) })
  })
}

async function waitForHttp(url, timeoutMs = 10000) {
  const start = Date.now()
  for (;;) {
    try { if ((await fetch(url)).ok) return } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`server at ${url} did not start`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('lanRelayCore: Pair a phone', () => {
  it('the relay host starts without a PIN; another device needs the game PIN of a match the relay holds', async () => {
    const relay = createLanRelay({ log: { log() {}, error() {}, warn() {} } })
    try {
      expect((await call(relay, '/api/pair/start', { context: CTX })).status).toBe(201)
      const remote = (pin, matchKey = 'm-1') => call(relay, '/api/pair/start', { matchKey, context: CTX }, { addr: '192.168.1.20', headers: pin ? { 'x-ov-match-pin': pin } : {} })
      expect((await remote(null)).json.code).toBe('OV_PAIR_FORBIDDEN')
      syncMatch(relay, 'm-1', '424242')
      expect((await remote('424242', 'm-other')).json.code).toBe('OV_PAIR_FORBIDDEN')
      const wrong = await remote('000000')
      expect(wrong.status).toBe(403)
      expect(wrong.json.code).toBe('OV_PAIR_PIN_INVALID')
      const ok = await remote('424242')
      expect(ok.status).toBe(201)
      expect(ok.headers['Cache-Control']).toBe('no-store')
      // the phone: any address, the token only
      const joined = await call(relay, '/api/pair/join', { k: ok.json.token }, { addr: '192.168.1.77' })
      expect(joined.json.state).toBe('paired')
    } finally {
      relay.close()
    }
  })

  it('body caps: 4 KB on start, 64 KB on focus and input', async () => {
    const relay = createLanRelay({ log: { log() {}, error() {}, warn() {} } })
    try {
      expect((await call(relay, '/api/pair/start', { context: { ...CTX, when: 'x'.repeat(5000) } })).json.code).toBe('OV_PAIR_TOO_LARGE')
      const s = (await call(relay, '/api/pair/start', { context: CTX })).json
      expect((await call(relay, '/api/pair/focus', { watch: s.watch, field: { id: 'f', text: 'x'.repeat(30000) } })).status).toBe(200)
      expect((await call(relay, '/api/pair/focus', { watch: s.watch, field: { id: 'f', text: 'x'.repeat(70000) } })).json.code).toBe('OV_PAIR_TOO_LARGE')
      expect((await call(relay, '/api/pair/input', null, { raw: 'not json' })).json.code).toBe('OV_PAIR_BAD_REQUEST')
    } finally {
      relay.close()
    }
  })

  it('no timer before the first pair request; close() leaves none', async () => {
    const relay = createLanRelay({ log: { log() {}, error() {}, warn() {} }, heartbeatMs: 0 })
    expect(relay.pairStats()).toBeNull()
    await call(relay, '/api/pair/start', { context: CTX })
    expect(relay.pairStats()).toMatchObject({ sessions: 1, sweeper: true })
    relay.close()
    expect(relay.pairStats()).toBeNull()
  })

  it('without the pair core every call answers 503 OV_PAIR_UNAVAILABLE', async () => {
    const relay = createLanRelay({ log: { log() {}, error() {}, warn() {} }, pairCore: null })
    try {
      const r = await call(relay, '/api/pair/start', { context: CTX })
      expect(r.status).toBe(503)
      expect(r.json.code).toBe('OV_PAIR_UNAVAILABLE')
    } finally {
      relay.close()
    }
  })
})

describe('every Node relay runtime and the Rust relay speak Pair a phone', () => {
  it('standalone server.js', async () => {
    const [port, wsPort] = [await freePort(), await freePort()]
    const child = spawn(process.execPath, ['server.js'], {
      cwd: FRONTEND_DIR,
      env: { ...process.env, PORT: String(port), WS_PORT: String(wsPort), HTTPS: 'false', NODE_ENV: 'test' },
      stdio: 'ignore',
    })
    try {
      await waitForHttp(`http://127.0.0.1:${port}/api/server/status`)
      expect(await pairHttpScenario({ httpBase: `http://127.0.0.1:${port}` })).toEqual([])
      if (HAS_PAIR_PAGE) expect(await pairPageCheck({ httpBase: `http://127.0.0.1:${port}` })).toEqual([])
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('Vite dev plugin', async () => {
    const plugin = vitePluginApiRoutes({ wsPort: 0 })
    let middleware = null
    plugin.configureServer({
      config: { server: { https: false, port: 5173 } },
      middlewares: { use: (prefix, fn) => { if (prefix === '/api') middleware = fn } },
    })
    const httpServer = createHttpServer((req, res) => {
      if (!req.url.startsWith('/api/')) { res.writeHead(404); return res.end() }
      req.url = req.url.slice('/api'.length)
      middleware(req, res, () => { res.writeHead(404); res.end() })
    })
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r))
    try {
      expect(await pairHttpScenario({ httpBase: `http://127.0.0.1:${httpServer.address().port}` })).toEqual([])
    } finally {
      plugin.closeBundle()
      await new Promise((r) => httpServer.close(r))
    }
  })

  it.skipIf(!TAURI_RELAY_BIN)('Tauri Rust relay (OV_TAURI_RELAY_BIN)', async () => {
    const relay = await startTauriRelay()
    try {
      expect(await pairHttpScenario({ httpBase: relay.base })).toEqual([])
      expect(await pairPageCheck({ httpBase: relay.base })).toEqual([])
    } finally {
      await relay.stop()
    }
  }, 60000)
})
