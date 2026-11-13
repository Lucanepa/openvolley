// @vitest-environment node
/**
 * LAN relay core (electron/lanRelayCore.cjs) and the standalone relay
 * (server.js): room claims need the game PIN (also after a restart), the
 * wrong-PIN budget per match, memory bounds, the HTTP crash boundary and the
 * Origin / Host rule.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import WebSocket from 'ws'
import { createLanRelay, relayRequestRefusal } from '../../../lanRelayCore.js'

const FRONTEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const KEY = 'seed-court-1'

function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    send(text) { this.sent.push(JSON.parse(text)) },
    last(type) { return [...this.sent].reverse().find((m) => m.type === type) },
  }
}
function connect(relay, ip = '192.168.1.50') {
  const ws = fakeSocket()
  relay.addClient(ws, { ip })
  return ws
}
const msg = (relay, ws, m) => relay.handleMessage(ws, JSON.stringify(m))
const match = (o = {}) => ({
  id: 1, seed_key: KEY, status: 'live', gamePin: '111111',
  refereeConnectionEnabled: true, refereePin: '222222', homeTeamConnectionEnabled: true, homeTeamPin: '333333',
  ...o,
})
const sync = (m = match()) => ({ type: 'sync-match-data', matchId: m.id, match: m, homeTeam: { name: 'Home VC' }, awayTeam: { name: 'Away VC' } })

/** In-memory claimStore (server.js keeps the same on disk, hashed). */
function memoryClaims() {
  const pins = new Map()
  return {
    check: (id, pin) => (pins.has(id) ? pins.get(id) === pin : undefined),
    remember: (id, pin) => pins.set(id, pin),
    forget: (id) => pins.delete(id),
  }
}

describe('room claims', () => {
  it('never hands a room with a game PIN to a sync without it, also not after the scorer left', () => {
    const relay = createLanRelay({ orphanTakeoverMs: 0, staleTakeoverMs: 0 })
    const scorer = connect(relay, '192.168.1.10')
    msg(relay, scorer, sync())
    relay.removeClient(scorer)
    const intruder = connect(relay, '192.168.1.66')
    msg(relay, intruder, sync(match({ gamePin: null })))
    expect(intruder.last('error').code).toBe('not-match-owner')
    msg(relay, intruder, sync(match({ gamePin: '666666' })))
    expect(intruder.last('error').code).toBe('not-match-owner')
    const back = connect(relay, '192.168.1.10')
    msg(relay, back, sync())
    expect(back.last('error')).toBeUndefined()
    relay.close()
  })

  it('keeps the claim across a restart of the relay (claimStore)', () => {
    const claims = memoryClaims()
    const first = createLanRelay({ claimStore: claims })
    msg(first, connect(first, '192.168.1.10'), sync())
    first.close()
    const relay = createLanRelay({ claimStore: claims }) // restarted: the room store is empty
    const intruder = connect(relay, '192.168.1.66')
    msg(relay, intruder, sync(match({ gamePin: '666666' })))
    expect(intruder.last('error').code).toBe('not-match-owner')
    const { gamePin, ...noPin } = match()
    msg(relay, intruder, sync(noPin))
    expect(intruder.last('error').code).toBe('pins-required')
    expect(relay.hasMatch(KEY)).toBe(false)
    const scorer = connect(relay, '192.168.1.10')
    msg(relay, scorer, sync())
    expect(scorer.last('error')).toBeUndefined()
    expect(relay.hasMatch(KEY)).toBe(true)
    relay.close()
  })
})

describe('wrong-PIN budget', () => {
  it('counts PINs offered before the first sync, so many sockets cannot all be compared', () => {
    const relay = createLanRelay()
    const guessers = []
    for (let i = 0; i < 20; i++) {
      const g = connect(relay, '192.168.1.66')
      // the right referee PIN is the 11th guess
      msg(relay, g, { type: 'subscribe-match', matchId: KEY, device: 'referee', pin: i === 10 ? '222222' : String(500000 + i) })
      guessers.push(g)
    }
    expect(guessers.filter((g) => g.last('error')?.code === 'rate-limited').length).toBeGreaterThanOrEqual(15)
    msg(relay, connect(relay, '192.168.1.10'), sync())
    expect(guessers[10].last('match-data-update')?.access).not.toBe('full')
    relay.close()
  })

  it('limits wrong PINs per match across addresses and compares the role the caller names', async () => {
    const relay = createLanRelay({ matchPinFailureLimit: 30 })
    msg(relay, connect(relay, '192.168.1.10'), sync())
    for (let i = 0; i < 30; i++) {
      const r = await relay.getMatch(KEY, { pin: String(700000 + i), ip: `192.168.2.${i + 1}` })
      expect(r.body.access).not.toBe('full')
    }
    const blocked = await relay.getMatch(KEY, { pin: '222222', ip: '192.168.3.1' })
    expect(blocked.status).toBe(429)
    relay.close()

    const roles = createLanRelay()
    msg(roles, connect(roles, '192.168.1.10'), sync())
    const ref = connect(roles, '192.168.1.20')
    msg(roles, ref, { type: 'subscribe-match', matchId: KEY, device: 'referee', pin: '333333' })
    expect(ref.last('error').code).toBe('pin-invalid')
    roles.close()
  })
})

describe('memory bounds', () => {
  it('counts rooms per creating address after its socket closed, evicts idle rooms, caps subscriptions', () => {
    const relay = createLanRelay({ maxRoomsPerIp: 3, roomIdleMs: 0 })
    for (let i = 0; i < 3; i++) {
      const ws = connect(relay, '192.168.1.66')
      msg(relay, ws, sync(match({ seed_key: `room-${i}` })))
      expect(ws.last('error')).toBeUndefined()
      relay.removeClient(ws)
    }
    const ws = connect(relay, '192.168.1.66')
    msg(relay, ws, sync(match({ seed_key: 'room-3' })))
    expect(ws.last('error').code).toBe('too-many-matches')
    relay.removeClient(ws)
    relay.heartbeat() // marks the rooms idle
    relay.heartbeat() // drops them
    expect(relay.hasMatch('room-0')).toBe(false)

    const sub = connect(relay, '192.168.1.70')
    for (let i = 0; i < 32; i++) msg(relay, sub, { type: 'subscribe-match', matchId: `x-${i}` })
    expect(sub.last('error')).toBeUndefined()
    msg(relay, sub, { type: 'subscribe-match', matchId: 'x-32' })
    expect(sub.last('error').code).toBe('too-many-subscriptions')
    relay.close()
  })

  it('refuses a sync whose status or names are not short text or numbers', async () => {
    const relay = createLanRelay()
    const ws = connect(relay, '192.168.1.66')
    msg(relay, ws, sync(match({ status: { toString: 1 } })))
    expect(ws.last('error').code).toBe('bad-request')
    expect((await relay.listMatches()).status).toBe(200)
    relay.close()
  })
})

describe('Origin, Host and loopback', () => {
  it('refuses pages of other sites and re-pointed names, keeps the app and the hall', () => {
    expect(relayRequestRefusal({ headers: { host: '192.168.1.5:8080', origin: 'https://evil.example' } })).toBe('origin-not-allowed')
    expect(relayRequestRefusal({ headers: { host: 'evil.example:8080' } })).toBe('host-not-allowed')
    expect(relayRequestRefusal({ headers: { host: '192.168.1.5:8080', origin: 'http://192.168.1.5:5173' } })).toBeNull()
    expect(relayRequestRefusal({ headers: { host: '127.0.0.1:8080', origin: 'https://referee.openvolley.app' } })).toBeNull()
    expect(relayRequestRefusal({ headers: { host: 'escoresheet.local:8080' } })).toBeNull()
    expect(relayRequestRefusal({ headers: {} })).toBeNull()
  })

  it('keys loopback claim failures by socket and caps loopback sockets', () => {
    const relay = createLanRelay({ maxLoopbackSockets: 2 })
    const page = connect(relay, '127.0.0.1')
    msg(relay, connect(relay, '192.168.1.10'), sync())
    for (let i = 0; i < 6; i++) msg(relay, page, sync(match({ gamePin: String(400000 + i) })))
    expect(page.last('error').code).toBe('rate-limited')
    const board = connect(relay, '127.0.0.1')
    msg(relay, board, sync())
    expect(board.last('error')).toBeUndefined()
    expect(relay.admit('127.0.0.1')).toMatchObject({ code: 1008 })
    relay.close()
  })
})

// --- Through the standalone relay (server.js) ---------------------------------

function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

async function startServer(env = {}) {
  const [port, wsPort] = [await freePort(), await freePort()]
  const child = spawn(process.execPath, ['server.js'], {
    cwd: FRONTEND_DIR,
    env: { ...process.env, PORT: String(port), WS_PORT: String(wsPort), HTTPS: 'false', NODE_ENV: 'test', ...env },
    stdio: 'ignore',
  })
  const base = `http://127.0.0.1:${port}`
  for (let t = Date.now(); ; ) {
    try { if ((await fetch(`${base}/api/match/list`)).ok) break } catch { /* not up yet */ }
    if (Date.now() - t > 10000) throw new Error('server.js did not start')
    await new Promise((r) => setTimeout(r, 100))
  }
  return { child, base, wsUrl: `ws://127.0.0.1:${wsPort}` }
}

function open(url, headers) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, { headers })
    const got = []
    ws.on('message', (d) => got.push(JSON.parse(d.toString())))
    ws.once('open', () => res({ ws, got, next: (type) => waitFor(got, type) }))
    ws.once('error', rej)
  })
}
async function waitFor(got, type) {
  for (let t = Date.now(); Date.now() - t < 5000; ) {
    const m = got.find((x) => x.type === type)
    if (m) return m
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`no ${type}`)
}

describe('standalone relay (server.js)', () => {
  it('refuses a WebSocket from another site, keeps a claimed room after a restart', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'ov-relay-claims-'))
    let srv = await startServer({ OV_RELAY_STATE_DIR: dir })
    try {
      await expect(open(srv.wsUrl, { Origin: 'https://evil.example' })).rejects.toThrow(/403/)
      const scorer = await open(srv.wsUrl)
      scorer.ws.send(JSON.stringify(sync()))
      await new Promise((r) => setTimeout(r, 300))
      scorer.ws.close()
      srv.child.kill('SIGKILL')

      srv = await startServer({ OV_RELAY_STATE_DIR: dir })
      const intruder = await open(srv.wsUrl)
      intruder.ws.send(JSON.stringify(sync(match({ gamePin: '666666' }))))
      expect((await intruder.next('error')).code).toBe('not-match-owner')
      intruder.ws.close()
      // A state-changing route from another site's page
      const r = await fetch(`${srv.base}/api/match/validate-pin`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"pin":"222222"}' })
      expect(r.status).toBe(403)
    } finally {
      srv.child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})
