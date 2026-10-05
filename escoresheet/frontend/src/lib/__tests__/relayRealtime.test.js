import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRelayRealtime, parseFilter, toLiveUrl, REALTIME_SUBSCRIBE_STATES } from '../relayRealtime'
import { setBackendOverride, clearBackendOverride } from '../../utils/backendConfig'

const UUID = '3f1c2a9e-8d7b-4c6a-9e5f-0a1b2c3d4e5f'
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

class FakeWebSocket {
  static instances = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.closedWith = null
    this.onopen = this.onmessage = this.onclose = this.onerror = null
    FakeWebSocket.instances.push(this)
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('not open')
    this.sent.push(JSON.parse(data))
  }

  close(code, reason) {
    this.closedWith = { code, reason }
    this.readyState = 3
  }

  // --- test helpers (the "server") ---
  serverOpen() {
    this.readyState = 1
    this.onopen?.({})
    this.serverSend({ type: 'connected', mode: 'live', protocol: 1 })
  }

  serverSend(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  serverClose(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }

  ofType(type) {
    return this.sent.filter(m => m.type === type)
  }

  ackAll() {
    for (const m of this.ofType('subscribe-db')) this.serverSend({ type: 'subscribe-db-ack', id: m.id })
  }

  change(id, table, eventType, row, extra = {}) {
    this.serverSend({
      type: 'db-change',
      id,
      schema: 'public',
      table,
      eventType,
      new: eventType === 'DELETE' ? {} : row,
      old: eventType === 'DELETE' ? row : {},
      commit_timestamp: '2026-10-05T12:00:00.000Z',
      ...extra
    })
  }
}

const last = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]

function makeClient(overrides = {}) {
  return createRelayRealtime({
    getUrl: () => 'wss://backend.openvolley.app',
    WebSocketImpl: FakeWebSocket,
    random: () => 1, // no jitter: delay = full backoff
    logger: { log() {}, warn() {}, error() {} },
    ...overrides
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('parseFilter / toLiveUrl', () => {
  it('parses eq filters used by the app', () => {
    expect(parseFilter(`match_id=eq.${UUID}`)).toEqual({ column: 'match_id', value: UUID })
    expect(parseFilter('external_id=eq.seed.with.dots=and=eq')).toEqual({ column: 'external_id', value: 'seed.with.dots=and=eq' })
    expect(parseFilter('sport_type=eq.indoor')).toEqual({ column: 'sport_type', value: 'indoor' })
    expect(parseFilter(undefined)).toBeNull()
    expect(parseFilter('')).toBeNull()
  })

  it('rejects anything but eq', () => {
    expect(() => parseFilter('id=in.(1,2)')).toThrow(/only eq/)
    expect(() => parseFilter('match_id')).toThrow()
    expect(() => parseFilter('a b=eq.1')).toThrow()
    expect(() => parseFilter('match_id=eq.')).toThrow()
  })

  it('adds purpose=live', () => {
    expect(toLiveUrl('wss://backend.openvolley.app')).toBe('wss://backend.openvolley.app/?purpose=live')
    expect(toLiveUrl('ws://192.168.1.10:8080')).toBe('ws://192.168.1.10:8080/?purpose=live')
  })
})

describe('backend URL resolution', () => {
  it('uses backendConfig.getWebSocketUrl (runtime override honoured)', () => {
    setBackendOverride('https://backend.openvolley.app')
    const client = createRelayRealtime({ WebSocketImpl: FakeWebSocket, logger: { warn() {}, error() {} } })
    client.channel('x').on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `match_id=eq.${UUID}` }, () => {}).subscribe()
    expect(last().url).toBe('wss://backend.openvolley.app/?purpose=live')
    client.disconnect()
    clearBackendOverride()
  })

  it('reports CHANNEL_ERROR and keeps retrying when no backend is available', () => {
    let url = null
    const client = makeClient({ getUrl: () => url })
    const status = vi.fn()
    client.channel('x').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, () => {}).subscribe(status)
    expect(status).toHaveBeenCalledWith('CHANNEL_ERROR', expect.any(Error))
    expect(FakeWebSocket.instances).toHaveLength(0)
    url = 'ws://localhost:8080'
    vi.advanceTimersByTime(1000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    last().serverOpen()
    last().ackAll()
    expect(status).toHaveBeenLastCalledWith('SUBSCRIBED', undefined)
    client.disconnect()
  })
})

describe('channel subscribe / dispatch', () => {
  it('mirrors useRealtimeConnection: four bindings in one channel, one subscribe-db', () => {
    const client = makeClient()
    const seen = []
    const status = vi.fn()
    const ch = client.channel(`match-seed-1-${Date.now()}`)
    const ret = ch
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `match_id=eq.${UUID}` }, (p) => seen.push(['events', p]))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sets', filter: `match_id=eq.${UUID}` }, (p) => seen.push(['sets', p]))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'match_live_state', filter: `match_id=eq.${UUID}` }, (p) => seen.push(['live', p]))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: 'external_id=eq.seed-1' }, (p) => seen.push(['matches', p]))
      .subscribe(status)
    expect(ret).toBe(ch)
    const ws = last()
    expect(ws.url).toBe('wss://backend.openvolley.app/?purpose=live')
    ws.serverOpen()
    const [sub] = ws.ofType('subscribe-db')
    expect(sub.subs).toEqual([
      { table: 'events', schema: 'public', event: '*', column: 'match_id', value: UUID },
      { table: 'sets', schema: 'public', event: '*', column: 'match_id', value: UUID },
      { table: 'match_live_state', schema: 'public', event: '*', column: 'match_id', value: UUID },
      { table: 'matches', schema: 'public', event: '*', column: 'external_id', value: 'seed-1' }
    ])
    expect(status).not.toHaveBeenCalled()
    ws.ackAll()
    expect(status).toHaveBeenCalledWith('SUBSCRIBED', undefined)

    ws.change(sub.id, 'events', 'INSERT', { id: 'e1', match_id: UUID })
    ws.change(sub.id, 'matches', 'DELETE', { id: UUID, external_id: 'seed-1' })
    expect(seen.map(s => s[0])).toEqual(['events', 'matches'])
    expect(seen[0][1]).toEqual({
      schema: 'public',
      table: 'events',
      commit_timestamp: '2026-10-05T12:00:00.000Z',
      eventType: 'INSERT',
      new: { id: 'e1', match_id: UUID },
      old: {},
      errors: null
    })
    expect(seen[1][1].eventType).toBe('DELETE')
    expect(seen[1][1].new).toEqual({})
    expect(seen[1][1].old.external_id).toBe('seed-1')
    client.disconnect()
  })

  it('mirrors LivescoreApp: sport_type=eq.indoor, INSERT/UPDATE/DELETE payloads', () => {
    const client = makeClient()
    const cb = vi.fn()
    client.channel('livescore-all-games')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'match_live_state', filter: 'sport_type=eq.indoor' }, cb)
      .subscribe()
    const ws = last()
    ws.serverOpen()
    ws.ackAll()
    const id = ws.ofType('subscribe-db')[0].id
    ws.change(id, 'match_live_state', 'INSERT', { match_id: UUID, sport_type: 'indoor', points_a: 0 })
    ws.change(id, 'match_live_state', 'UPDATE', { match_id: UUID, sport_type: 'indoor', points_a: 1 })
    ws.change(id, 'match_live_state', 'UPDATE', { match_id: OTHER, sport_type: 'beach', points_a: 1 }) // client re-checks
    ws.change(id, 'match_live_state', 'DELETE', { match_id: UUID, sport_type: 'indoor' })
    expect(cb.mock.calls.map(c => c[0].eventType)).toEqual(['INSERT', 'UPDATE', 'DELETE'])
    expect(cb.mock.calls[2][0].old.match_id).toBe(UUID)
    client.disconnect()
  })

  it('mirrors Referee: subscribe() without a status callback, event filter respected', () => {
    const client = makeClient()
    const all = vi.fn()
    const updatesOnly = vi.fn()
    client.channel(`match_live_state:${UUID}-1`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'match_live_state', filter: `match_id=eq.${UUID}` }, all)
      .on('postgres_changes', { event: 'update', schema: 'public', table: 'match_live_state', filter: `match_id=eq.${UUID}` }, updatesOnly)
      .subscribe()
    const ws = last()
    ws.serverOpen()
    ws.ackAll()
    const id = ws.ofType('subscribe-db')[0].id
    ws.change(id, 'match_live_state', 'INSERT', { match_id: UUID })
    ws.change(id, 'match_live_state', 'UPDATE', { match_id: UUID, scorer_attention_trigger: 't1' })
    expect(all).toHaveBeenCalledTimes(2)
    expect(updatesOnly).toHaveBeenCalledTimes(1)
    expect(updatesOnly.mock.calls[0][0].new.scorer_attention_trigger).toBe('t1')
    client.disconnect()
  })

  it('shares one socket between channels and ignores changes for unknown ids', () => {
    const client = makeClient()
    const a = vi.fn()
    const b = vi.fn()
    client.channel('a').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, a).subscribe()
    client.channel('b').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${OTHER}` }, b).subscribe()
    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = last()
    ws.serverOpen()
    ws.ackAll()
    const [subA, subB] = ws.ofType('subscribe-db')
    expect(subA.id).not.toBe(subB.id)
    ws.change(subB.id, 'events', 'INSERT', { match_id: OTHER })
    ws.change('nope', 'events', 'INSERT', { match_id: UUID })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    client.disconnect()
  })

  it('a throwing callback does not break other bindings', () => {
    const client = makeClient()
    const ok = vi.fn()
    client.channel('x')
      .on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, () => { throw new Error('boom') })
      .on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, ok)
      .subscribe()
    const ws = last()
    ws.serverOpen(); ws.ackAll()
    ws.change(ws.ofType('subscribe-db')[0].id, 'events', 'INSERT', { match_id: UUID })
    expect(ok).toHaveBeenCalledTimes(1)
    client.disconnect()
  })

  it('emits CHANNEL_ERROR for unsupported filters without contacting the server', () => {
    const client = makeClient()
    const status = vi.fn()
    client.channel('x').on('postgres_changes', { event: '*', table: 'events', filter: 'id=in.(1,2)' }, () => {}).subscribe(status)
    expect(status).toHaveBeenCalledWith('CHANNEL_ERROR', expect.any(Error))
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('emits CHANNEL_ERROR when the server refuses the subscription', () => {
    const client = makeClient()
    const status = vi.fn()
    client.channel('x').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, () => {}).subscribe(status)
    const ws = last()
    ws.serverOpen()
    ws.serverSend({ type: 'subscribe-db-error', id: ws.ofType('subscribe-db')[0].id, code: 'too_many_channels', message: 'nope' })
    expect(status).toHaveBeenCalledWith('CHANNEL_ERROR', expect.objectContaining({ message: 'nope', code: 'too_many_channels' }))
    client.disconnect()
  })

  it('emits TIMED_OUT after 10 s without an ack, then SUBSCRIBED if the ack arrives', () => {
    const client = makeClient()
    const status = vi.fn()
    client.channel('x').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, () => {}).subscribe(status)
    const ws = last()
    ws.serverOpen()
    vi.advanceTimersByTime(9999)
    expect(status).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(status).toHaveBeenCalledWith('TIMED_OUT', undefined)
    ws.ackAll()
    expect(status).toHaveBeenLastCalledWith('SUBSCRIBED', undefined)
    client.disconnect()
  })

  it('ignores non postgres_changes bindings and repeated subscribe()', () => {
    const client = makeClient()
    const ch = client.channel('x')
      .on('broadcast', { event: 'x' }, () => {})
      .on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, () => {})
    ch.subscribe()
    ch.subscribe()
    const ws = last()
    ws.serverOpen()
    expect(ws.ofType('subscribe-db')).toHaveLength(1)
    expect(ws.ofType('subscribe-db')[0].subs).toHaveLength(1)
    client.disconnect()
  })
})

describe('removeChannel', () => {
  it('is null-safe and resolves ok', async () => {
    const client = makeClient()
    await expect(client.removeChannel(null)).resolves.toBe('ok')
    await expect(client.removeChannel(undefined)).resolves.toBe('ok')
  })

  it('sends unsubscribe-db, emits CLOSED, stops dispatch and closes the idle socket', async () => {
    const client = makeClient({ idleCloseMs: 5000 })
    const status = vi.fn()
    const cb = vi.fn()
    const ch = client.channel('x').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, cb).subscribe(status)
    const ws = last()
    ws.serverOpen(); ws.ackAll()
    const id = ws.ofType('subscribe-db')[0].id
    await expect(client.removeChannel(ch)).resolves.toBe('ok')
    expect(ws.ofType('unsubscribe-db')).toEqual([{ type: 'unsubscribe-db', id }])
    expect(status).toHaveBeenLastCalledWith('CLOSED', undefined)
    ws.change(id, 'events', 'INSERT', { match_id: UUID })
    expect(cb).not.toHaveBeenCalled()
    expect(client.getChannels()).toHaveLength(0)
    expect(ws.closedWith).toBeNull()
    vi.advanceTimersByTime(5000)
    expect(ws.closedWith).toEqual({ code: 1000, reason: 'client closing' })
    // Removing twice is harmless.
    await expect(ch.unsubscribe()).resolves.toBe('ok')
  })

  it('keeps the socket when a new channel arrives within the idle window (StrictMode remount)', () => {
    const client = makeClient({ idleCloseMs: 5000 })
    const make = () => client.channel(`x-${Math.random()}`).on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, () => {}).subscribe()
    const first = make()
    const ws = last()
    ws.serverOpen()
    client.removeChannel(first)
    make()
    vi.advanceTimersByTime(6000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(ws.closedWith).toBeNull()
    expect(ws.ofType('subscribe-db')).toHaveLength(2)
    client.disconnect()
  })

  it('removeAllChannels clears everything', async () => {
    const client = makeClient()
    client.channel('a').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, () => {}).subscribe()
    client.channel('b').on('postgres_changes', { event: '*', table: 'sets', filter: `match_id=eq.${UUID}` }, () => {}).subscribe()
    expect(client.getChannels()).toHaveLength(2)
    await client.removeAllChannels()
    expect(client.getChannels()).toHaveLength(0)
  })
})

describe('reconnect', () => {
  it('reconnects with exponential backoff and resubscribes every channel', () => {
    const client = makeClient()
    const status = vi.fn()
    const cb = vi.fn()
    client.channel('x').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, cb).subscribe(status)
    client.channel('y').on('postgres_changes', { event: '*', table: 'match_live_state', filter: 'sport_type=eq.indoor' }, () => {}).subscribe()
    let ws = last()
    ws.serverOpen(); ws.ackAll()
    expect(status.mock.calls.map(c => c[0])).toEqual(['SUBSCRIBED'])
    const ids = ws.ofType('subscribe-db').map(m => m.id)

    ws.serverClose(1006)
    expect(status).toHaveBeenLastCalledWith('CHANNEL_ERROR', expect.any(Error))
    expect(FakeWebSocket.instances).toHaveLength(1)

    vi.advanceTimersByTime(999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)

    // Second failure before 'connected' -> 2 s, third -> 4 s.
    last().serverClose(1006)
    vi.advanceTimersByTime(1999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(3)
    last().serverClose(1006)
    vi.advanceTimersByTime(4000)
    expect(FakeWebSocket.instances).toHaveLength(4)
    // CHANNEL_ERROR is reported once per outage, not once per attempt.
    expect(status.mock.calls.filter(c => c[0] === 'CHANNEL_ERROR')).toHaveLength(1)

    ws = last()
    ws.serverOpen()
    expect(ws.ofType('subscribe-db').map(m => m.id)).toEqual(ids)
    ws.ackAll()
    expect(status).toHaveBeenLastCalledWith('SUBSCRIBED', undefined)
    ws.change(ids[0], 'events', 'UPDATE', { match_id: UUID })
    expect(cb).toHaveBeenCalledTimes(1)

    // Backoff reset after a good connection: next drop retries after 1 s.
    ws.serverClose(1006)
    vi.advanceTimersByTime(1000)
    expect(FakeWebSocket.instances).toHaveLength(5)
    client.disconnect()
  })

  it('caps the backoff at reconnectMaxMs', () => {
    const client = makeClient({ reconnectMaxMs: 3000 })
    client.channel('x').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, () => {}).subscribe()
    for (let i = 0; i < 6; i++) {
      const n = FakeWebSocket.instances.length
      last().serverClose(1006)
      vi.advanceTimersByTime(3000)
      expect(FakeWebSocket.instances).toHaveLength(n + 1)
    }
    client.disconnect()
  })

  it('does not reconnect once every channel is gone', () => {
    const client = makeClient()
    const ch = client.channel('x').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, () => {}).subscribe()
    last().serverOpen()
    client.removeChannel(ch)
    last().serverClose(1006)
    vi.advanceTimersByTime(60000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('reconnects immediately on the browser online event', () => {
    const client = makeClient()
    client.channel('x').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, () => {}).subscribe()
    last().serverOpen()
    last().serverClose(1006)
    expect(FakeWebSocket.instances).toHaveLength(1)
    window.dispatchEvent(new Event('online'))
    expect(FakeWebSocket.instances).toHaveLength(2)
    client.disconnect()
  })

  it('pings every 25 s and drops a silent (half-open) socket', () => {
    const client = makeClient()
    const status = vi.fn()
    client.channel('x').on('postgres_changes', { event: '*', table: 'events', filter: `match_id=eq.${UUID}` }, () => {}).subscribe(status)
    const ws = last()
    ws.serverOpen(); ws.ackAll()
    vi.advanceTimersByTime(25000)
    expect(ws.ofType('ping')).toHaveLength(1)
    ws.serverSend({ type: 'pong' })
    vi.advanceTimersByTime(25000)
    expect(ws.ofType('ping')).toHaveLength(2)
    // No pong this time: the next tick finds lastSeen too old.
    vi.advanceTimersByTime(25000)
    expect(ws.closedWith?.code).toBe(4000)
    expect(status).toHaveBeenLastCalledWith('CHANNEL_ERROR', expect.objectContaining({ message: expect.stringMatching(/heartbeat/) }))
    vi.advanceTimersByTime(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    client.disconnect()
  })
})

describe('singleton export', () => {
  it('relayRealtime is created lazily and opens no socket on import', async () => {
    const mod = await import('../relayRealtime')
    expect(typeof mod.relayRealtime.channel).toBe('function')
    expect(typeof mod.relayRealtime.removeChannel).toBe('function')
    expect(mod.relayRealtime.connectionState).toBe('closed')
    expect(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED).toBe('SUBSCRIBED')
  })
})
