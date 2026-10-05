import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'
import {
  createRealtimeHub,
  createLiveStateRelay,
  createHeartbeat,
  isLiveRequest,
  eventTypeForAction
} from '../lib/realtimeHub.js'

// Same shape as server.js SECRET_COLUMNS / redactSecrets (mutates, returns row).
const SECRET_COLUMNS = {
  matches: ['game_pin', 'connection_pins'],
  events: ['game_pin'],
  match_live_state: ['game_pin', 'connection_pins']
}
function redact(table, row) {
  for (const k of SECRET_COLUMNS[table] || []) delete row[k]
  return row
}

const MATCH_A = '11111111-1111-4111-8111-111111111111'
const MATCH_B = '22222222-2222-4222-8222-222222222222'

/**
 * Real HTTP + ws server on a random port, routed the way server.js will route:
 * purpose=live -> hub, everything else -> a stand-in "role socket" handler.
 */
async function startServer(hubOptions = {}) {
  const hub = createRealtimeHub({ redact, logger: { log() {}, warn() {} }, ...hubOptions })
  const server = createServer((req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ server })
  const roleSockets = new Set()
  wss.on('connection', (ws, req) => {
    if (hub.isLiveRequest(req)) {
      hub.handleConnection(ws, req, { ip: req.headers['x-test-ip'] || '127.0.0.1' })
      return
    }
    roleSockets.add(ws)
    ws.send(JSON.stringify({ type: 'connected', mode: 'role' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    hub,
    wss,
    roleSockets,
    url: `ws://127.0.0.1:${port}`,
    async stop() {
      hub.close()
      for (const c of wss.clients) c.terminate()
      await new Promise(resolve => wss.close(resolve))
      await new Promise(resolve => server.close(resolve))
    }
  }
}

/** A client that queues every parsed message so tests can await them in order. */
function connect(url, { live = true, ip, wsOptions = {} } = {}) {
  const ws = new WebSocket(`${url}/${live ? '?purpose=live' : ''}`, {
    headers: ip ? { 'x-test-ip': ip } : {},
    ...wsOptions
  })
  const queue = []
  const waiters = []
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    const w = waiters.shift()
    if (w) w.resolve(msg)
    else queue.push(msg)
  })
  const closed = new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  ws.on('error', () => {})
  return {
    ws,
    closed,
    send(obj) { ws.send(JSON.stringify(obj)) },
    next(timeoutMs = 1000) {
      if (queue.length) return Promise.resolve(queue.shift())
      return new Promise((resolve, reject) => {
        const w = { resolve: (m) => { clearTimeout(t); resolve(m) } }
        const t = setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error('timed out waiting for message'))
        }, timeoutMs)
        waiters.push(w)
      })
    },
    /** Resolves true when no message arrives within ms. */
    async silent(ms = 150) {
      if (queue.length) return false
      try { await this.next(ms); return false } catch { return true }
    },
    close() { ws.close() }
  }
}

async function liveClient(url, opts) {
  const c = connect(url, opts)
  const hello = await c.next()
  assert.equal(hello.type, 'connected')
  assert.equal(hello.mode, 'live')
  return c
}

async function subscribe(c, id, subs) {
  c.send({ type: 'subscribe-db', id, subs })
  const reply = await c.next()
  return reply
}

describe('isLiveRequest / eventTypeForAction', () => {
  it('detects purpose=live in the upgrade URL', () => {
    assert.equal(isLiveRequest({ url: '/?purpose=live' }), true)
    assert.equal(isLiveRequest({ url: '/ws?foo=1&purpose=live' }), true)
    assert.equal(isLiveRequest({ url: '/' }), false)
    assert.equal(isLiveRequest({ url: '/?purpose=scoreboard' }), false)
    assert.equal(isLiveRequest({}), false)
    assert.equal(isLiveRequest(null), false)
  })

  it('maps /api/db actions', () => {
    assert.equal(eventTypeForAction('insert'), 'INSERT')
    assert.equal(eventTypeForAction('update'), 'UPDATE')
    assert.equal(eventTypeForAction('upsert'), 'UPSERT')
    assert.equal(eventTypeForAction('delete'), 'DELETE')
    assert.equal(eventTypeForAction('select'), null)
  })

  it('requires a redact function', () => {
    assert.throws(() => createRealtimeHub({}), /redact/)
  })
})

describe('realtimeHub over real sockets', () => {
  let srv
  const clients = []
  const open = async (opts) => { const c = await liveClient(srv.url, opts); clients.push(c); return c }

  before(async () => { srv = await startServer() })
  after(async () => { await srv.stop() })
  afterEach(async () => {
    for (const c of clients.splice(0)) { c.close(); await c.closed }
  })

  it('acks subscribe-db and delivers only rows that match the eq filter', async () => {
    const a = await open()
    const b = await open()
    assert.deepEqual(await subscribe(a, 'ch-a', [{ table: 'events', event: '*', column: 'match_id', value: MATCH_A }]), { type: 'subscribe-db-ack', id: 'ch-a' })
    assert.deepEqual(await subscribe(b, 'ch-b', [{ table: 'events', event: '*', schema: 'public', column: 'match_id', value: MATCH_B }]), { type: 'subscribe-db-ack', id: 'ch-b' })

    const sent = srv.hub.broadcastDbChange('events', 'INSERT', [{ id: 'e1', match_id: MATCH_A, type: 'point' }])
    assert.equal(sent, 1)
    const msg = await a.next()
    assert.equal(msg.type, 'db-change')
    assert.equal(msg.id, 'ch-a')
    assert.equal(msg.schema, 'public')
    assert.equal(msg.table, 'events')
    assert.equal(msg.eventType, 'INSERT')
    assert.deepEqual(msg.new, { id: 'e1', match_id: MATCH_A, type: 'point' })
    assert.deepEqual(msg.old, {})
    assert.ok(msg.commit_timestamp)
    assert.equal(await b.silent(), true)
  })

  it('filters by external_id on matches and sport_type on match_live_state', async () => {
    const a = await open()
    await subscribe(a, 'm', [{ table: 'matches', event: '*', column: 'external_id', value: 'seed-123' }])
    await subscribe(a, 'live', [{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'indoor' }])

    srv.hub.broadcastDbChange('matches', 'UPDATE', [{ id: MATCH_A, external_id: 'seed-999' }])
    srv.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ match_id: MATCH_A, sport_type: 'beach' }])
    assert.equal(await a.silent(), true)

    srv.hub.broadcastDbChange('matches', 'UPDATE', [{ id: MATCH_A, external_id: 'seed-123' }])
    const m = await a.next()
    assert.equal(m.id, 'm')
    assert.equal(m.new.external_id, 'seed-123')

    srv.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ match_id: MATCH_A, sport_type: 'indoor', points_a: 3 }])
    const l = await a.next()
    assert.equal(l.id, 'live')
    assert.equal(l.new.points_a, 3)
  })

  it('honours the event filter', async () => {
    const a = await open()
    await subscribe(a, 'ins', [{ table: 'sets', event: 'INSERT', column: 'match_id', value: MATCH_A }])
    srv.hub.broadcastDbChange('sets', 'UPDATE', [{ id: 's1', match_id: MATCH_A }])
    srv.hub.broadcastDbChange('sets', 'DELETE', [{ id: 's1', match_id: MATCH_A }])
    assert.equal(await a.silent(), true)
    srv.hub.broadcastDbChange('sets', 'INSERT', [{ id: 's2', match_id: MATCH_A }])
    assert.equal((await a.next()).new.id, 's2')
  })

  it('applies filters to the old row on DELETE and sends new as {}', async () => {
    const a = await open()
    await subscribe(a, 'm', [{ table: 'matches', event: '*', column: 'external_id', value: 'seed-del' }])
    srv.hub.broadcastDbChange('matches', 'DELETE', [{ id: MATCH_A, external_id: 'seed-del', game_pin: '123456' }])
    const msg = await a.next()
    assert.equal(msg.eventType, 'DELETE')
    assert.deepEqual(msg.new, {})
    assert.deepEqual(msg.old, { id: MATCH_A, external_id: 'seed-del' })
  })

  it('resolves UPSERT through __inserted and strips internal keys', async () => {
    const a = await open()
    await subscribe(a, 'l', [{ table: 'match_live_state', event: '*', column: 'match_id', value: MATCH_A }])
    srv.hub.broadcastDbChange('match_live_state', 'UPSERT', [{ match_id: MATCH_A, points_a: 0, __inserted: true }])
    const first = await a.next()
    assert.equal(first.eventType, 'INSERT')
    assert.equal('__inserted' in first.new, false)
    srv.hub.broadcastDbChange('match_live_state', 'UPSERT', [{ match_id: MATCH_A, points_a: 1, __inserted: false }])
    assert.equal((await a.next()).eventType, 'UPDATE')
    srv.hub.broadcastDbChange('match_live_state', 'UPSERT', [{ match_id: MATCH_A, points_a: 2 }])
    assert.equal((await a.next()).eventType, 'UPDATE')
  })

  it('never sends secret columns and does not mutate the caller rows', async () => {
    const a = await open()
    await subscribe(a, 'm', [{ table: 'matches', event: '*', column: 'external_id', value: 'seed-s' }])
    const row = { id: MATCH_A, external_id: 'seed-s', game_pin: '654321', connection_pins: { referee: '987123', bench_home: '222222' }, match_info: { a: 1 } }
    srv.hub.broadcastDbChange('matches', 'UPDATE', [row], {
      oldRows: [{ id: MATCH_A, external_id: 'seed-s', game_pin: '000000' }]
    })
    const msg = await a.next()
    assert.equal('game_pin' in msg.new, false)
    assert.equal('connection_pins' in msg.new, false)
    assert.equal('game_pin' in msg.old, false)
    assert.deepEqual(msg.new.match_info, { a: 1 })
    const raw = JSON.stringify(msg)
    assert.equal(raw.includes('654321'), false)
    assert.equal(raw.includes('987123'), false)
    // Caller's row untouched (it may still be returned to the HTTP caller).
    assert.equal(row.game_pin, '654321')
    assert.equal(row.connection_pins.referee, '987123')
  })

  it('refuses filters on secret / unknown columns (no PIN oracle)', async () => {
    const a = await open()
    const r1 = await subscribe(a, 'x', [{ table: 'matches', event: '*', column: 'game_pin', value: '123456' }])
    assert.equal(r1.type, 'subscribe-db-error')
    assert.equal(r1.code, 'invalid_sub')
    const r2 = await subscribe(a, 'y', [{ table: 'matches', event: '*', column: 'connection_pins->>referee', value: '1' }])
    assert.equal(r2.type, 'subscribe-db-error')
    // Socket stays usable.
    assert.equal((await subscribe(a, 'z', [{ table: 'events', event: '*', column: 'match_id', value: MATCH_A }])).type, 'subscribe-db-ack')
  })

  it('a filter on a redacted column never matches even if allowed by config', async () => {
    const local = await startServer({ filterColumns: ['external_id', 'game_pin'] })
    try {
      const c = await liveClient(local.url)
      assert.equal((await subscribe(c, 'p', [{ table: 'matches', event: '*', column: 'game_pin', value: '123456' }])).type, 'subscribe-db-ack')
      local.hub.broadcastDbChange('matches', 'UPDATE', [{ id: MATCH_A, external_id: 'e', game_pin: '123456' }])
      assert.equal(await c.silent(), true)
      c.close(); await c.closed
    } finally { await local.stop() }
  })

  it('rejects invalid subscriptions with subscribe-db-error', async () => {
    const a = await open()
    const cases = [
      [{ type: 'subscribe-db', id: 'a', subs: [{ table: 'profiles', event: '*', column: 'match_id', value: '1' }] }, 'invalid_sub'],
      [{ type: 'subscribe-db', id: 'b', subs: [{ table: 'events', event: 'TRUNCATE', column: 'match_id', value: '1' }] }, 'invalid_sub'],
      [{ type: 'subscribe-db', id: 'c', subs: [{ table: 'events', event: '*' }] }, 'invalid_sub'],
      [{ type: 'subscribe-db', id: 'd', subs: [{ table: 'events', schema: 'auth', event: '*', column: 'match_id', value: '1' }] }, 'invalid_sub'],
      [{ type: 'subscribe-db', id: 'e', subs: [{ table: 'events', event: '*', column: 'match_id', op: 'like', value: '1' }] }, 'invalid_sub'],
      [{ type: 'subscribe-db', id: 'f', subs: [{ table: 'events', event: '*', column: 'match_id', value: { x: 1 } }] }, 'invalid_sub'],
      [{ type: 'subscribe-db', id: 'g', subs: [] }, 'invalid_subs'],
      [{ type: 'subscribe-db', id: '', subs: [{ table: 'events' }] }, 'invalid_id'],
      [{ type: 'subscribe-db', id: 'h', subs: Array.from({ length: 11 }, () => ({ table: 'events', event: '*', column: 'match_id', value: '1' })) }, 'too_many_subs']
    ]
    for (const [msg, code] of cases) {
      a.send(msg)
      const reply = await a.next()
      assert.equal(reply.type, 'subscribe-db-error', JSON.stringify(msg))
      assert.equal(reply.code, code, JSON.stringify(msg))
    }
    assert.equal(srv.hub.stats().tables.events ?? 0, 0)
  })

  it('caps channels per socket and replaces a channel re-sent with the same id', async () => {
    const a = await open()
    for (let i = 0; i < 10; i++) {
      assert.equal((await subscribe(a, `c${i}`, [{ table: 'events', event: '*', column: 'match_id', value: `m${i}` }])).type, 'subscribe-db-ack')
    }
    const over = await subscribe(a, 'c10', [{ table: 'events', event: '*', column: 'match_id', value: 'm10' }])
    assert.equal(over.code, 'too_many_channels')
    // Replacing an existing id is allowed at the cap.
    assert.equal((await subscribe(a, 'c0', [{ table: 'sets', event: '*', column: 'match_id', value: 'm0' }])).type, 'subscribe-db-ack')
    srv.hub.broadcastDbChange('events', 'INSERT', [{ match_id: 'm0' }])
    assert.equal(await a.silent(), true)
    srv.hub.broadcastDbChange('sets', 'INSERT', [{ match_id: 'm0' }])
    assert.equal((await a.next()).id, 'c0')
  })

  it('unsubscribe-db stops delivery', async () => {
    const a = await open()
    await subscribe(a, 'u', [{ table: 'events', event: '*', column: 'match_id', value: MATCH_A }])
    a.send({ type: 'unsubscribe-db', id: 'u' })
    assert.deepEqual(await a.next(), { type: 'unsubscribe-db-ack', id: 'u' })
    assert.equal(srv.hub.broadcastDbChange('events', 'INSERT', [{ match_id: MATCH_A }]), 0)
    assert.equal(await a.silent(), true)
  })

  it('sends one message per channel per row, whatever the number of matching subs', async () => {
    const a = await open()
    await subscribe(a, 'multi', [
      { table: 'match_live_state', event: '*', column: 'match_id', value: MATCH_A },
      { table: 'match_live_state', event: 'UPDATE', column: 'sport_type', value: 'indoor' }
    ])
    srv.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ match_id: MATCH_A, sport_type: 'indoor' }])
    assert.equal((await a.next()).id, 'multi')
    assert.equal(await a.silent(), true)
  })

  it('coalesces large multi-row writes to the last row', async () => {
    const a = await open()
    await subscribe(a, 'ev', [{ table: 'events', event: '*', column: 'match_id', value: MATCH_A }])
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, match_id: i % 2 ? MATCH_A : MATCH_B }))
    srv.hub.broadcastDbChange('events', 'INSERT', rows)
    const msg = await a.next()
    assert.equal(msg.coalesced, 10)
    assert.equal(msg.new.id, 'e19')
    assert.equal(await a.silent(), true)

    srv.hub.broadcastDbChange('events', 'INSERT', rows.slice(0, 4))
    const got = [await a.next(), await a.next()]
    assert.deepEqual(got.map(m => m.new.id), ['e1', 'e3'])
    assert.equal(got[0].coalesced, undefined)
  })

  it('answers ping and closes with 1008 on any other message type', async () => {
    const a = await open()
    a.send({ type: 'ping' })
    assert.equal((await a.next()).type, 'pong')
    a.send({ type: 'clear-all-matches' })
    const { code } = await a.closed
    assert.equal(code, 1008)
  })

  it('closes on invalid JSON', async () => {
    const a = await open()
    a.ws.send('{nope')
    assert.equal((await a.closed).code, 1008)
  })

  it('does not touch role sockets', async () => {
    const r = connect(srv.url, { live: false })
    const hello = await r.next()
    assert.equal(hello.mode, 'role')
    assert.equal(srv.hub.stats().sockets, 0)
    r.close(); await r.closed
  })

  it('reports stats and frees state on close', async () => {
    const a = await open()
    await subscribe(a, 's', [{ table: 'events', event: '*', column: 'match_id', value: MATCH_A }])
    let s = srv.hub.stats()
    assert.equal(s.sockets, 1)
    assert.equal(s.channels, 1)
    assert.equal(s.tables.events, 1)
    clients.splice(clients.indexOf(a), 1)
    a.close(); await a.closed
    await new Promise(r => setTimeout(r, 20))
    s = srv.hub.stats()
    assert.equal(s.sockets, 0)
    assert.equal(s.ips, 0)
    assert.deepEqual(s.tables, {})
  })
})

describe('realtimeHub limits', () => {
  it('caps live sockets per IP, separately from role sockets', async () => {
    const srv = await startServer({ maxPerIp: 2 })
    try {
      const a = await liveClient(srv.url, { ip: '10.0.0.1' })
      const b = await liveClient(srv.url, { ip: '10.0.0.1' })
      const c = connect(srv.url, { ip: '10.0.0.1' })
      const closed = await c.closed
      assert.equal(closed.code, 1008)
      // Another IP still gets in, and role sockets are not counted.
      const d = await liveClient(srv.url, { ip: '10.0.0.2' })
      const role = connect(srv.url, { live: false, ip: '10.0.0.1' })
      assert.equal((await role.next()).mode, 'role')
      // Closing one frees a slot.
      a.close(); await a.closed
      await new Promise(r => setTimeout(r, 20))
      const e = await liveClient(srv.url, { ip: '10.0.0.1' })
      for (const x of [b, d, e, role]) { x.close(); await x.closed }
    } finally { await srv.stop() }
  })

  it('caps live sockets in total with 1013', async () => {
    const srv = await startServer({ maxTotal: 1 })
    try {
      const a = await liveClient(srv.url, { ip: '10.0.0.1' })
      const b = connect(srv.url, { ip: '10.0.0.2' })
      assert.equal((await b.closed).code, 1013)
      a.close(); await a.closed
    } finally { await srv.stop() }
  })

  it('rate-limits inbound messages per socket', async () => {
    const srv = await startServer({ rateLimitCount: 5, rateLimitWindowMs: 60000 })
    try {
      const a = await liveClient(srv.url)
      for (let i = 0; i < 6; i++) a.send({ type: 'ping' })
      assert.equal((await a.closed).code, 1008)
    } finally { await srv.stop() }
  })

  it('closes oversized frames with 1009', async () => {
    const srv = await startServer({ maxMessageBytes: 100 })
    try {
      const a = await liveClient(srv.url)
      a.send({ type: 'ping', pad: 'x'.repeat(200) })
      assert.equal((await a.closed).code, 1009)
    } finally { await srv.stop() }
  })

  it('pings every interval and terminates sockets that stop answering', async () => {
    const srv = await startServer({ pingIntervalMs: 60 })
    try {
      const healthy = await liveClient(srv.url)
      let pings = 0
      healthy.ws.on('ping', () => { pings++ })
      const dead = await liveClient(srv.url, { wsOptions: { autoPong: false } })
      const closed = await dead.closed
      assert.equal(closed.code, 1006) // terminated, no close frame
      await new Promise(r => setTimeout(r, 150))
      assert.ok(pings >= 2, `expected pings, got ${pings}`)
      assert.equal(healthy.ws.readyState, WebSocket.OPEN)
      assert.equal(srv.hub.stats().sockets, 1)
      healthy.close(); await healthy.closed
    } finally { await srv.stop() }
  })

  it('heartbeat.track can watch role sockets too', async () => {
    const hb = createHeartbeat({ intervalMs: 0 })
    const srv = await startServer()
    try {
      srv.wss.on('connection', (ws, req) => { if (!isLiveRequest(req)) hb.track(ws) })
      const role = connect(srv.url, { live: false, wsOptions: { autoPong: false } })
      await role.next()
      assert.equal(hb.size, 1)
      hb.tick() // marks as waiting and pings
      hb.tick() // no pong -> terminate
      assert.equal((await role.closed).code, 1006)
      assert.equal(hb.size, 0)
    } finally { hb.stop(); await srv.stop() }
  })

  it('terminates slow consumers instead of buffering without bound', async () => {
    const srv = await startServer({ maxBufferedBytes: -1 })
    try {
      const a = await liveClient(srv.url)
      await subscribe(a, 's', [{ table: 'events', event: '*', column: 'match_id', value: MATCH_A }])
      assert.equal(srv.hub.broadcastDbChange('events', 'INSERT', [{ match_id: MATCH_A }]), 0)
      assert.equal((await a.closed).code, 1006)
      assert.equal(srv.hub.stats().terminatedSlow, 1)
    } finally { await srv.stop() }
  })

  it('accepts a catalog predicate for filter columns and unfiltered subs when enabled', async () => {
    const allowed = new Set(['events.match_id', 'events.team'])
    const srv = await startServer({ filterColumns: (t, c) => allowed.has(`${t}.${c}`), allowUnfiltered: true })
    try {
      const a = await liveClient(srv.url)
      assert.equal((await subscribe(a, 't', [{ table: 'events', event: '*', column: 'team', value: 'home' }])).type, 'subscribe-db-ack')
      assert.equal((await subscribe(a, 'm', [{ table: 'matches', event: '*', column: 'external_id', value: 'x' }])).code, 'invalid_sub')
      assert.equal((await subscribe(a, 'all', [{ table: 'sets', event: 'DELETE' }])).type, 'subscribe-db-ack')
      srv.hub.broadcastDbChange('sets', 'DELETE', [{ id: 1, match_id: MATCH_B }])
      assert.equal((await a.next()).id, 'all')
      a.close(); await a.closed
    } finally { await srv.stop() }
  })
})

describe('createLiveStateRelay', () => {
  function setup(overrides = {}) {
    const published = []
    const hub = { broadcastDbChange: (table, type, rows) => { published.push({ table, type, rows }); return 1 } }
    const lookups = []
    const lookupMatch = overrides.lookupMatch || (async (ext) => {
      lookups.push(ext)
      return ext === 'seed-1' ? { id: MATCH_A, sport_type: 'indoor' } : null
    })
    const relay = createLiveStateRelay({ hub, lookupMatch, ...overrides })
    return { relay, published, lookups }
  }
  const scoreboard = { role: 'scoreboard', matchId: 'seed-1' }

  it('publishes an UPDATE with the resolved match_id and sport_type', async () => {
    const { relay, published } = setup()
    const res = await relay.handle(scoreboard, { matchId: 'seed-1', liveState: { match_id: MATCH_B, sport_type: 'beach', points_a: 4, __x: 1 } })
    assert.deepEqual(res, { ok: true, sent: 1 })
    assert.equal(published.length, 1)
    assert.equal(published[0].table, 'match_live_state')
    assert.equal(published[0].type, 'UPDATE')
    assert.deepEqual(published[0].rows, [{ match_id: MATCH_A, sport_type: 'indoor', points_a: 4 }])
  })

  it('only accepts the scoreboard of that match', async () => {
    const { relay, published } = setup()
    assert.equal((await relay.handle({ role: 'referee', matchId: 'seed-1' }, { matchId: 'seed-1', liveState: {} })).reason, 'forbidden')
    assert.equal((await relay.handle({ role: 'scoreboard', matchId: 'seed-2' }, { matchId: 'seed-1', liveState: {} })).reason, 'forbidden')
    assert.equal((await relay.handle({ role: 'scoreboard', matchId: null }, { matchId: 'seed-1', liveState: {} })).reason, 'forbidden')
    assert.equal(published.length, 0)
  })

  it('validates the message', async () => {
    const { relay } = setup({ maxPayloadBytes: 50 })
    assert.equal((await relay.handle(scoreboard, { liveState: {} })).reason, 'missing_match_id')
    assert.equal((await relay.handle(scoreboard, { matchId: 'seed-1', liveState: [] })).reason, 'invalid_live_state')
    assert.equal((await relay.handle(scoreboard, { matchId: 'seed-1' })).reason, 'invalid_live_state')
    assert.equal((await relay.handle(scoreboard, { matchId: 'seed-1', liveState: { pad: 'x'.repeat(100) } })).reason, 'too_large')
  })

  it('caches lookups, coalesces concurrent ones and negative-caches unknown matches', async () => {
    const { relay, lookups } = setup()
    await Promise.all([
      relay.handle(scoreboard, { matchId: 'seed-1', liveState: { a: 1 } }),
      relay.handle(scoreboard, { matchId: 'seed-1', liveState: { a: 2 } })
    ])
    await relay.handle(scoreboard, { matchId: 'seed-1', liveState: { a: 3 } })
    assert.deepEqual(lookups, ['seed-1'])
    const other = { role: 'scoreboard', matchId: 'seed-x' }
    assert.equal((await relay.handle(other, { matchId: 'seed-x', liveState: {} })).reason, 'unknown_match')
    assert.equal((await relay.handle(other, { matchId: 'seed-x', liveState: {} })).reason, 'unknown_match')
    assert.deepEqual(lookups, ['seed-1', 'seed-x'])
    relay.invalidate('seed-1')
    await relay.handle(scoreboard, { matchId: 'seed-1', liveState: {} })
    assert.deepEqual(lookups, ['seed-1', 'seed-x', 'seed-1'])
  })

  it('expires positive cache entries after cacheTtlMs', async () => {
    const { relay, lookups } = setup({ cacheTtlMs: 10 })
    await relay.handle(scoreboard, { matchId: 'seed-1', liveState: {} })
    await new Promise(r => setTimeout(r, 25))
    await relay.handle(scoreboard, { matchId: 'seed-1', liveState: {} })
    assert.deepEqual(lookups, ['seed-1', 'seed-1'])
  })

  it('reports lookup failures without caching them', async () => {
    let calls = 0
    const { relay } = setup({ lookupMatch: async () => { calls++; throw new Error('db down') } })
    assert.equal((await relay.handle(scoreboard, { matchId: 'seed-1', liveState: {} })).reason, 'lookup_failed')
    assert.equal((await relay.handle(scoreboard, { matchId: 'seed-1', liveState: {} })).reason, 'lookup_failed')
    assert.equal(calls, 2)
  })

  it('drops keys the catalog predicate rejects', async () => {
    const cols = new Set(['match_id', 'sport_type', 'points_a'])
    const { relay, published } = setup({ allowColumn: (t, c) => t === 'match_live_state' && cols.has(c) })
    await relay.handle(scoreboard, { matchId: 'seed-1', liveState: { points_a: 1, bogus: 2 } })
    assert.deepEqual(published[0].rows[0], { points_a: 1, match_id: MATCH_A, sport_type: 'indoor' })
  })

  it('end to end: live-state-update reaches a sport_type=eq.indoor subscriber, redacted', async () => {
    const srv = await startServer()
    try {
      const relay = createLiveStateRelay({ hub: srv.hub, lookupMatch: async () => ({ id: MATCH_A, sport_type: 'indoor' }) })
      const c = await liveClient(srv.url)
      await subscribe(c, 'livescore', [{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'indoor' }])
      const res = await relay.handle(scoreboard, { matchId: 'seed-1', liveState: { points_a: 7, connection_pins: { referee: '999999' } } })
      assert.equal(res.ok, true)
      const msg = await c.next()
      assert.equal(msg.eventType, 'UPDATE')
      assert.equal(msg.new.match_id, MATCH_A)
      assert.equal(msg.new.points_a, 7)
      assert.equal('connection_pins' in msg.new, false)
      c.close(); await c.closed
    } finally { await srv.stop() }
  })
})
