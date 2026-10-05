import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  createRelayPinTracker,
  createScorerRelay,
  createLiveStateOrder,
  isRelayErrorFor,
  relayReconnectDelay
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

  it('sends the PINs with the first sync of a new key on the same socket (the match got its seed key)', () => {
    const pins = createRelayPinTracker()
    const ws = {}
    pins.payloadFor(ws, match(), 'match_1_a').commit()
    expect(hasPins(pins.payloadFor(ws, match(), 'match_1_a').match)).toBe(false)
    const other = pins.payloadFor(ws, match({ seed_key: 'match_2_b' }), 'match_2_b')
    expect(hasPins(other.match)).toBe(true)
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

describe('the scorer\'s one relay connection (App + Scoreboard)', () => {
  class FakeSocket {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      this.closed = null
    }
    send(text) { this.sent.push(JSON.parse(text)) }
    close(code) {
      this.readyState = 3
      this.closed = code
      this.onclose?.({ code })
    }
    open() {
      this.readyState = 1
      this.onopen?.()
    }
    receive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }) }
    drop() {
      this.readyState = 3
      this.onclose?.({ code: 1006 })
    }
  }
  let sockets
  let events
  const make = (opts = {}) => {
    sockets = []
    events = new EventTarget()
    return createScorerRelay({
      createSocket: (url) => {
        const s = new FakeSocket(url)
        sockets.push(s)
        return s
      },
      events,
      doc: null,
      ...opts
    })
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('App and Scoreboard share one socket: one owner of the match on the relay', async () => {
    const relay = make()
    const app = { onOpen: vi.fn(), onMessage: vi.fn() }
    const board = { onOpen: vi.fn(), onMessage: vi.fn() }
    const detachApp = relay.attach('wss://relay', app)
    sockets[0].open()
    expect(app.onOpen).toHaveBeenCalledTimes(1)
    const detachBoard = relay.attach('wss://relay', board)
    await Promise.resolve()
    expect(sockets).toHaveLength(1)
    expect(board.onOpen).toHaveBeenCalledWith(sockets[0])

    // The PIN tracker is the connection's: what App sent with PINs, the
    // Scoreboard does not resend (and vice versa)
    relay.pins.payloadFor(sockets[0], match(), 'match_1_a').commit()
    expect(hasPins(relay.pins.payloadFor(relay.socket, match(), 'match_1_a').match)).toBe(false)

    // Errors and updates reach both; a relay request gets one answer
    sockets[0].receive({ type: 'error', code: 'pins-required', matchId: 'match_1_a' })
    expect(app.onMessage).toHaveBeenCalledTimes(1)
    expect(board.onMessage).toHaveBeenCalledTimes(1)
    sockets[0].receive({ type: 'match-data-request', requestId: 'r1', matchId: 'match_1_a' })
    expect(board.onMessage).toHaveBeenCalledTimes(2)
    expect(app.onMessage).toHaveBeenCalledTimes(1)

    // The Scoreboard leaving (a sub-view) keeps the socket for App
    detachBoard()
    vi.runOnlyPendingTimers()
    expect(sockets[0].closed).toBeNull()
    expect(relay.userCount).toBe(1)
    sockets[0].receive({ type: 'game-number-request', requestId: 'r2' })
    expect(app.onMessage).toHaveBeenCalledTimes(2)

    // An effect re-run (detach + attach in one commit) keeps it too
    detachApp()
    const detachAgain = relay.attach('wss://relay', app)
    vi.runOnlyPendingTimers()
    expect(sockets[0].closed).toBeNull()
    expect(sockets).toHaveLength(1)

    // The last one leaving closes it
    detachAgain()
    vi.runOnlyPendingTimers()
    expect(sockets[0].closed).toBe(1000)
    expect(relay.send({ type: 'ping' })).toBe(false)
  })

  it('reconnects with backoff, at once when back online, and re-runs every onOpen', () => {
    const relay = make()
    const app = { onOpen: vi.fn() }
    relay.attach('wss://relay', app)
    sockets[0].open()
    sockets[0].drop()
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(4999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    sockets[1].drop()
    // Back online: no waiting for the 10 s backoff
    events.dispatchEvent(new Event('online'))
    expect(sockets).toHaveLength(3)
    sockets[2].open()
    expect(app.onOpen).toHaveBeenCalledTimes(2)
    expect(app.onOpen).toHaveBeenLastCalledWith(sockets[2])
  })

  it('replaces a socket that stops answering pings (Wi-Fi without uplink keeps it OPEN)', () => {
    const relay = make({ pingIntervalMs: 1000, pongTimeoutMs: 500 })
    relay.attach('wss://relay', {})
    sockets[0].open()
    vi.advanceTimersByTime(1000)
    expect(sockets[0].sent.at(-1).type).toBe('ping')
    sockets[0].receive({ type: 'pong' })
    vi.advanceTimersByTime(500)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1000) // next ping, no answer
    vi.advanceTimersByTime(500)
    expect(sockets[0].closed).toBe(4000)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
  })

  it('moves to another relay URL (LAN server port known) with fresh PINs', () => {
    const relay = make()
    relay.attach('ws://host:8080', {})
    sockets[0].open()
    relay.pins.payloadFor(sockets[0], match(), 'match_1_a').commit()
    relay.attach('ws://host:8181', {})
    expect(sockets[0].closed).toBe(1000)
    expect(sockets[1].url).toBe('ws://host:8181')
    sockets[1].open()
    expect(hasPins(relay.pins.payloadFor(sockets[1], match(), 'match_1_a').match)).toBe(true)
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
