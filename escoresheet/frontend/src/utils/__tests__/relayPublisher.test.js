import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  createRelayPinTracker,
  createLiveStateOrder,
  isRelayErrorFor,
  relayReconnectDelay,
  relayConnectionStatus
} from '../relayPublisher'
import { getRelayWebSocketUrl, setBackendOverride } from '../backendConfig'

const PINS = { gamePin: '987654', refereePin: '314159', homeTeamPin: '271828', awayTeamPin: '161803' }
const match = (extra = {}) => ({ id: 1, seed_key: 'match_1_a', status: 'live', ...PINS, game_pin: '987654', connection_pins: { x: 1 }, ...extra })
const hasPins = (m) => 'gamePin' in m || 'refereePin' in m

describe('scorer relay publishing: PINs', () => {
  it('sends the PINs on a socket\'s first sync, then only when one changes', () => {
    const pins = createRelayPinTracker()
    const ws = {}
    const first = pins.payloadFor(ws, match())
    expect(first.match).toMatchObject(PINS)
    expect(first.match.game_pin).toBeUndefined()
    expect(first.match.connection_pins).toBeUndefined()
    first.commit()

    const second = pins.payloadFor(ws, match({ status: 'interval' }))
    expect(hasPins(second.match)).toBe(false)
    expect(second.match.status).toBe('interval')
    second.commit()

    // A changed PIN goes out (with the others)
    const changed = pins.payloadFor(ws, match({ refereePin: '565656' }))
    expect(changed.match.refereePin).toBe('565656')
    expect(changed.match.gamePin).toBe('987654')
  })

  it('a payload that was not sent (commit not called) does not count as sent', () => {
    const pins = createRelayPinTracker()
    const ws = {}
    pins.payloadFor(ws, match())
    expect(hasPins(pins.payloadFor(ws, match()).match)).toBe(true)
  })

  it('resends the PINs on a reconnect (new socket), once', () => {
    const pins = createRelayPinTracker()
    const a = {}
    const b = {}
    pins.payloadFor(a, match()).commit()
    const onB = pins.payloadFor(b, match())
    expect(hasPins(onB.match)).toBe(true)
    onB.commit()
    expect(hasPins(pins.payloadFor(b, match()).match)).toBe(false)
  })

  it('resends the PINs after a relay error about the match (refusal, lost room)', () => {
    const pins = createRelayPinTracker()
    const ws = {}
    pins.payloadFor(ws, match()).commit()
    const refusal = { type: 'error', code: 'not-match-owner', matchId: 'match_1_a' }
    expect(isRelayErrorFor(refusal, [1, 'match_1_a'])).toBe(true)
    pins.reset()
    expect(hasPins(pins.payloadFor(ws, match()).match)).toBe(true)
  })

  it('recognises errors about this match only', () => {
    const ids = [1, 'match_1_a']
    expect(isRelayErrorFor({ type: 'error', code: 'pins-required', matchId: 'match_1_a' }, ids)).toBe(true)
    expect(isRelayErrorFor({ type: 'error', code: 'room-limit', matchId: '1' }, ids)).toBe(true)
    expect(isRelayErrorFor({ type: 'error', message: 'Server room limit reached' }, ids)).toBe(true)
    expect(isRelayErrorFor({ type: 'error', code: 'not-match-owner', matchId: 'match_2_b' }, ids)).toBe(false)
    expect(isRelayErrorFor({ type: 'pong' }, ids)).toBe(false)
  })
})

describe('scorer relay publishing: live-state order', () => {
  it('a side-out never pushes or writes the older point row over the rotation row', async () => {
    const order = createLiveStateOrder()
    const writes = []
    // 'point' is called first, 'rotation' right after; the point's snapshot
    // read is slower, so it reaches the push / write second
    const point = order.next()
    const rotation = order.next()
    expect(order.shouldPush(rotation)).toBe(true)
    expect(order.shouldPush(point)).toBe(false)

    let releaseRotation
    const rotationWrite = order.write(rotation, () => new Promise((resolve) => {
      releaseRotation = () => { writes.push('rotation'); resolve({ error: null }) }
    }))
    const pointWrite = order.write(point, async () => { writes.push('point'); return { error: null } })
    await Promise.resolve()
    releaseRotation()
    expect(await rotationWrite).toEqual({ error: null })
    expect(await pointWrite).toEqual({ skipped: true })
    expect(writes).toEqual(['rotation'])
  })

  it('writes run one at a time, in order, and a failed write does not block the next', async () => {
    const order = createLiveStateOrder()
    const log = []
    const a = order.next()
    const b = order.next()
    const first = order.write(a, async () => { log.push('a:start'); await Promise.resolve(); log.push('a:end'); throw new Error('net') })
    const second = order.write(b, async () => { log.push('b'); return { error: null } })
    await expect(first).rejects.toThrow('net')
    expect(await second).toEqual({ error: null })
    expect(log).toEqual(['a:start', 'a:end', 'b'])
  })

  it('does not depend on the wall clock (an NTP step back does not freeze the livescore)', async () => {
    const order = createLiveStateOrder()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(2_000_000)
    const a = order.next()
    expect(order.shouldPush(a)).toBe(true)
    now.mockReturnValue(1_000_000) // clock stepped back
    const b = order.next()
    expect(order.shouldPush(b)).toBe(true)
    expect(await order.write(b, async () => 'written')).toBe('written')
    now.mockRestore()
  })
})

describe('scorer relay publishing: reconnect backoff', () => {
  it('backs off from 5 s to a 60 s cap', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(relayReconnectDelay)).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 60000])
  })
})

describe('getRelayWebSocketUrl (one relay for the scorer and its tablets)', () => {
  afterEach(() => {
    localStorage.clear()
    vi.unstubAllEnvs()
  })

  it('follows the ?server= / connection-screen override first', () => {
    setBackendOverride('http://192.168.1.100:8080')
    expect(getRelayWebSocketUrl({ wsPort: 9999 })).toBe('ws://192.168.1.100:8080')
    setBackendOverride('https://backend.openvolley.app')
    expect(getRelayWebSocketUrl()).toBe('wss://backend.openvolley.app')
  })

  it('then VITE_BACKEND_URL (the cloud relay takes the socket on its HTTP port)', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://backend.example.ch')
    expect(getRelayWebSocketUrl({ wsPort: 8080 })).toBe('wss://backend.example.ch')
  })

  it('a page served by a LAN relay reaches the relay\'s own WS port', () => {
    vi.stubEnv('VITE_BACKEND_URL', '')
    const host = window.location.hostname
    expect(getRelayWebSocketUrl({ wsPort: 8181 })).toBe(`ws://${host}:8181`)
    vi.stubEnv('DEV', false)
    const expected = window.location.port ? `ws://${host}:8080` : `ws://${window.location.host}`
    expect(getRelayWebSocketUrl()).toBe(expected)
  })

  it('the dev server: VITE_WS_PORT or 8080', () => {
    vi.stubEnv('VITE_BACKEND_URL', '')
    vi.stubEnv('DEV', true)
    expect(getRelayWebSocketUrl()).toBe(`ws://${window.location.hostname}:8080`)
  })
})

describe('relayConnectionStatus (status modal, no probe socket)', () => {
  const WS_URL = 'ws://192.168.1.10:8080'
  const statusCheck = (running) => vi.fn(async () => ({ running }))

  it('no relay for the page: not available, nothing asked', async () => {
    const getStatus = statusCheck(true)
    expect(await relayConnectionStatus({ wsUrl: null, ws: null, getStatus })).toMatchObject({ status: 'not_available' })
    expect(getStatus).not.toHaveBeenCalled()
  })

  it("the scorer's own open socket answers without a request", async () => {
    const getStatus = statusCheck(false)
    expect(await relayConnectionStatus({ wsUrl: WS_URL, ws: { readyState: 1 }, getStatus })).toMatchObject({ status: 'connected' })
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('no open socket (home page, reconnect pending): the HTTP status check decides', async () => {
    expect(await relayConnectionStatus({ wsUrl: WS_URL, ws: null, getStatus: statusCheck(true) }))
      .toMatchObject({ status: 'connected', message: 'WebSocket server is reachable' })
    expect(await relayConnectionStatus({ wsUrl: WS_URL, ws: { readyState: 3 }, getStatus: statusCheck(false) }))
      .toMatchObject({ status: 'disconnected', details: `Relay: ${WS_URL}` })
    expect(await relayConnectionStatus({ wsUrl: WS_URL, ws: { readyState: 0 }, getStatus: statusCheck(false) }))
      .toMatchObject({ status: 'connecting' })
  })

  it('by default asks GET /api/server/status and never opens a WebSocket', async () => {
    const OrigWS = globalThis.WebSocket
    const wsCtor = vi.fn()
    globalThis.WebSocket = wsCtor
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ running: true })
    })
    try {
      expect(await relayConnectionStatus({ wsUrl: WS_URL, ws: null })).toMatchObject({ status: 'connected' })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/api\/server\/status$/)
      expect(wsCtor).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
      globalThis.WebSocket = OrigWS
    }
  })
})
