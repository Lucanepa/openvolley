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
  eventTypeForAction,
  matchKeyFromSyncedMatch
} from '../lib/realtimeHub.js'
// The real list and function /api/db uses, not a copy.
import { redactSecrets as redact, SECRET_COLUMNS } from '../lib/secrets.js'

const MATCH_A = '11111111-1111-4111-8111-111111111111'
const MATCH_B = '22222222-2222-4222-8222-222222222222'

/**
 * Real HTTP + ws server on a random port, routed the way server.js must route:
 * the role wss is `noServer` with server.js's options (10 MB frames, deflate),
 * and `server.on('upgrade')` hands purpose=live requests to hub.handleUpgrade.
 */
async function startServer(hubOptions = {}) {
  const hub = createRealtimeHub({ redact, logger: { log() {}, warn() {} }, ...hubOptions })
  const server = createServer((req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 10 * 1024 * 1024,
    perMessageDeflate: { clientNoContextTakeover: true, serverNoContextTakeover: true, threshold: 1024 }
  })
  const roleSockets = new Set()
  server.on('upgrade', (req, socket, head) => {
    if (isLiveRequest(req)) {
      hub.handleUpgrade(req, socket, head, { ip: req.headers['x-test-ip'] || '127.0.0.1' })
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (ws) => {
    roleSockets.add(ws)
    ws.on('close', () => roleSockets.delete(ws))
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
      server.closeAllConnections?.()
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
    // Every column of the shared list is covered.
    for (const col of SECRET_COLUMNS.matches) assert.equal(col in msg.new, false, col)
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
    const msg = await a.next()
    assert.equal(msg.id, 'multi')
    assert.equal('ids' in msg, false)
    assert.equal(await a.silent(), true)
  })

  it('sends a row once per socket with every matching channel id in ids', async () => {
    const a = await open()
    const b = await open()
    const sub = [{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'indoor' }]
    for (let i = 0; i < 9; i++) assert.equal((await subscribe(a, `dup${i}`, sub)).type, 'subscribe-db-ack')
    await subscribe(a, 'other', [{ table: 'match_live_state', event: '*', column: 'match_id', value: MATCH_A }])
    await subscribe(b, 'solo', sub)
    const sent = srv.hub.broadcastDbChange('match_live_state', 'UPDATE', [
      { match_id: MATCH_B, sport_type: 'indoor', points_a: 1 },
      { match_id: MATCH_A, sport_type: 'beach', points_a: 2 }
    ])
    assert.equal(sent, 3) // a: 2 rows (not 10 messages), b: 1 row
    const first = await a.next()
    assert.equal(first.new.points_a, 1)
    assert.deepEqual(first.ids, Array.from({ length: 9 }, (_, i) => `dup${i}`))
    assert.equal(first.id, 'dup0')
    const second = await a.next()
    assert.equal(second.new.points_a, 2)
    assert.equal(second.id, 'other')
    assert.equal('ids' in second, false)
    assert.equal(await a.silent(), true)
    const onB = await b.next()
    assert.equal(onB.id, 'solo')
    assert.equal(await b.silent(), true)
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

  it('closes on binary frames with 1003', async () => {
    const a = await open()
    a.ws.send(Buffer.from(JSON.stringify({ type: 'ping' })), { binary: true })
    assert.equal((await a.closed).code, 1003)
  })

  it('negotiates no compression on live sockets (role sockets keep theirs)', async () => {
    const a = await open()
    assert.equal(a.ws.extensions, '')
    const r = connect(srv.url, { live: false })
    await r.next()
    assert.match(r.ws.extensions, /permessage-deflate/)
    r.close(); await r.closed
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

describe('realtimeHub ordering and cascades', () => {
  let srv
  before(async () => { srv = await startServer() })
  after(async () => { await srv.stop() })

  it('drops a match_live_state row older than the newest published, passes equal and newer', async () => {
    const c = await liveClient(srv.url)
    await subscribe(c, 'l', [{ table: 'match_live_state', event: '*', column: 'match_id', value: MATCH_A }])
    const t = (s) => `2026-10-05T12:00:${s}.000Z`
    srv.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ match_id: MATCH_A, points_a: 2, updated_at: t('02') }])
    assert.equal((await c.next()).new.points_a, 2)
    // Late HTTP copy of the previous point: dropped.
    assert.equal(srv.hub.broadcastDbChange('match_live_state', 'UPSERT', [{ match_id: MATCH_A, points_a: 1, updated_at: t('01') }]), 0)
    assert.equal(await c.silent(), true)
    assert.equal(srv.hub.stats().staleDropped, 1)
    // Same timestamp (e.g. scorer_attention_trigger update that does not bump updated_at): passes.
    srv.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ match_id: MATCH_A, points_a: 2, scorer_attention_trigger: 'x', updated_at: new Date(t('02')) }])
    assert.equal((await c.next()).new.scorer_attention_trigger, 'x')
    // Rows without the ordering column pass; another match is independent.
    srv.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ match_id: MATCH_A, points_a: 9 }])
    assert.equal((await c.next()).new.points_a, 9)
    srv.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ match_id: MATCH_B, updated_at: t('00') }])
    // A DELETE forgets the key, so a new match_live_state row for the id starts fresh.
    srv.hub.broadcastDbChange('match_live_state', 'DELETE', [{ match_id: MATCH_A }])
    assert.equal((await c.next()).eventType, 'DELETE')
    srv.hub.broadcastDbChange('match_live_state', 'UPSERT', [{ match_id: MATCH_A, points_a: 0, updated_at: t('00'), __inserted: true }])
    const ins = await c.next()
    assert.equal(ins.eventType, 'INSERT')
    assert.equal(ins.new.points_a, 0)
    c.close(); await c.closed
  })

  it('tracks ordering even without subscribers', async () => {
    srv.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ match_id: 'pre', updated_at: '2026-10-05T13:00:00.000Z' }])
    const c = await liveClient(srv.url)
    await subscribe(c, 'l', [{ table: 'match_live_state', event: '*', column: 'match_id', value: 'pre' }])
    assert.equal(srv.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ match_id: 'pre', updated_at: '2026-10-05T12:59:59.000Z' }]), 0)
    c.close(); await c.closed
  })

  it('a matches DELETE also publishes a match_live_state DELETE (ON DELETE CASCADE is not RETURNed)', async () => {
    const livescore = await liveClient(srv.url)
    await subscribe(livescore, 'all', [{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'indoor' }])
    const watcher = await liveClient(srv.url)
    await subscribe(watcher, 'm', [{ table: 'matches', event: '*', column: 'external_id', value: 'seed-c' }])
    const sent = srv.hub.broadcastDbChange('matches', 'DELETE', [{ id: MATCH_A, external_id: 'seed-c', sport_type: 'indoor', game_pin: '123456' }])
    assert.equal(sent, 2)
    const live = await livescore.next()
    assert.equal(live.table, 'match_live_state')
    assert.equal(live.eventType, 'DELETE')
    assert.deepEqual(live.old, { match_id: MATCH_A, sport_type: 'indoor' })
    assert.deepEqual(live.new, {})
    const m = await watcher.next()
    assert.equal(m.table, 'matches')
    assert.equal('game_pin' in m.old, false)
    for (const c of [livescore, watcher]) { c.close(); await c.closed }
  })

  it('cascades and ordering can be switched off', async () => {
    const local = await startServer({ cascadeDeletes: {}, ordering: {} })
    try {
      const c = await liveClient(local.url)
      await subscribe(c, 'l', [{ table: 'match_live_state', event: '*', column: 'match_id', value: MATCH_A }])
      local.hub.broadcastDbChange('matches', 'DELETE', [{ id: MATCH_A, sport_type: 'indoor' }])
      assert.equal(await c.silent(), true)
      local.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ match_id: MATCH_A, updated_at: '2026-10-05T12:00:02Z' }])
      local.hub.broadcastDbChange('match_live_state', 'UPDATE', [{ match_id: MATCH_A, updated_at: '2026-10-05T12:00:01Z' }])
      await c.next(); await c.next()
      c.close(); await c.closed
    } finally { await local.stop() }
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

  it('refuses an oversized frame while parsing it, before the hub sees it', async () => {
    // Default 16 KB limit on the hub's own server; the role wss would accept 10 MB.
    const srv = await startServer()
    try {
      const a = await liveClient(srv.url)
      await subscribe(a, 's', [{ table: 'events', event: '*', column: 'match_id', value: MATCH_A }])
      a.send({ type: 'subscribe-db', id: 'big', subs: [{ table: 'events', column: 'match_id', value: 'x' }], pad: 'x'.repeat(1024 * 1024) })
      assert.equal((await a.closed).code, 1009)
      await new Promise(r => setTimeout(r, 20))
      assert.equal(srv.hub.stats().sockets, 0)
      assert.equal(srv.hub.stats().rejected, 0) // never parsed by the hub
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
  // What the real Scoreboard sends: matchId is the local Dexie ++id (a number),
  // liveState.match_id is the Postgres UUID it resolved, sport_type is set.
  const SEED = 'match_1759665600000_k3j9x2'
  const scoreboard = { id: 'client-1', role: 'scoreboard', matchId: 7 }
  const liveState = (extra = {}) => ({ match_id: MATCH_A, sport_type: 'indoor', points_a: 4, points_b: 2, updated_at: '2026-10-05T12:00:00.000Z', ...extra })
  const message = (extra) => ({ type: 'live-state-update', matchId: 7, liveState: liveState(extra) })

  function setup(overrides = {}) {
    const published = []
    const hub = overrides.hub || { broadcastDbChange: (table, type, rows) => { published.push({ table, type, rows }); return 1 } }
    // server.js activeMatches, filled by handleSyncMatchData: key String(dexieId).
    const activeMatches = new Map([
      ['7', { matchId: '7', match: { id: 7, seed_key: SEED, externalId: null, refereePin: '111111' }, updatedBy: 'client-1' }]
    ])
    const lookups = []
    const lookupMatch = overrides.lookupMatch || (async (key) => {
      lookups.push(`${key.column}=${key.value}`)
      if (key.column === 'external_id' && key.value === SEED) return { id: MATCH_A, sport_type: 'indoor' }
      if (key.column === 'id' && key.value === MATCH_B) return { id: MATCH_B, sport_type: 'indoor' }
      return null
    })
    const relay = createLiveStateRelay({ hub, getSyncedMatch: (id) => activeMatches.get(String(id)), lookupMatch, ...overrides })
    return { relay, published, lookups, activeMatches }
  }

  it('matchKeyFromSyncedMatch mirrors Scoreboard.jsx resolution, without the String(dexieId) fallback', () => {
    assert.deepEqual(matchKeyFromSyncedMatch({ id: 7, externalId: MATCH_B.toUpperCase(), seed_key: SEED }), { column: 'id', value: MATCH_B })
    assert.deepEqual(matchKeyFromSyncedMatch({ id: 7, externalId: 'not-a-uuid', seed_key: SEED }), { column: 'external_id', value: SEED })
    assert.deepEqual(matchKeyFromSyncedMatch({ id: 7, seedKey: SEED }), { column: 'external_id', value: SEED })
    assert.equal(matchKeyFromSyncedMatch({ id: 7 }), null)
    assert.equal(matchKeyFromSyncedMatch(null), null)
  })

  it('resolves the Dexie room id through the synced match seed key and publishes an UPDATE', async () => {
    const { relay, published, lookups } = setup()
    const res = await relay.handle(scoreboard, message({ __x: 1 }))
    assert.deepEqual(res, { ok: true, sent: 1 })
    assert.deepEqual(lookups, [`external_id=${SEED}`]) // never '7'
    assert.equal(published[0].table, 'match_live_state')
    assert.equal(published[0].type, 'UPDATE')
    assert.deepEqual(published[0].rows, [{ match_id: MATCH_A, sport_type: 'indoor', points_a: 4, points_b: 2, updated_at: '2026-10-05T12:00:00.000Z' }])
  })

  it('uses matches.id directly when the synced match externalId is a UUID', async () => {
    const { relay, published, lookups, activeMatches } = setup()
    activeMatches.get('7').match = { id: 7, externalId: MATCH_B }
    const res = await relay.handle(scoreboard, message({ match_id: MATCH_B }))
    assert.equal(res.ok, true)
    assert.deepEqual(lookups, [`id=${MATCH_B}`])
    assert.equal(published[0].rows[0].match_id, MATCH_B)
  })

  it('refuses legacy matches without a seed key instead of looking up String(dexieId)', async () => {
    const { relay, published, lookups, activeMatches } = setup()
    activeMatches.get('7').match = { id: 7 }
    assert.equal((await relay.handle(scoreboard, message())).reason, 'no_match_key')
    assert.deepEqual(lookups, [])
    assert.equal(published.length, 0)
  })

  it('refuses a liveState whose match_id disagrees with the synced match', async () => {
    const { relay, published } = setup()
    assert.equal((await relay.handle(scoreboard, message({ match_id: MATCH_B }))).reason, 'match_mismatch')
    assert.equal(published.length, 0)
    // Missing match_id is filled in from the lookup.
    const res = await relay.handle(scoreboard, { matchId: 7, liveState: { points_a: 1 } })
    assert.equal(res.ok, true)
    assert.equal(published[0].rows[0].match_id, MATCH_A)
  })

  it('only accepts the room scoreboard that currently owns the synced match', async () => {
    const { relay, published, activeMatches } = setup()
    assert.equal((await relay.handle({ id: 'client-1', role: 'referee', matchId: 7 }, message())).reason, 'forbidden')
    assert.equal((await relay.handle({ id: 'client-1', role: 'scoreboard', matchId: 8 }, message())).reason, 'forbidden')
    assert.equal((await relay.handle({ id: 'client-1', role: 'scoreboard', matchId: null }, message())).reason, 'forbidden')
    // A second socket that joined as scoreboard of room 7 but is not the owner.
    assert.equal((await relay.handle({ id: 'client-2', role: 'scoreboard', matchId: 7 }, message())).reason, 'forbidden')
    // Room never synced.
    assert.equal((await relay.handle({ id: 'client-1', role: 'scoreboard', matchId: 9 }, { matchId: 9, liveState: {} })).reason, 'not_synced')
    // Ownership moves with the latest sync-match-data.
    activeMatches.get('7').updatedBy = 'client-2'
    assert.equal((await relay.handle(scoreboard, message())).reason, 'forbidden')
    assert.equal((await relay.handle({ id: 'client-2', role: 'scoreboard', matchId: '7' }, message())).ok, true)
    assert.equal(published.length, 1)
  })

  it('validates the message', async () => {
    const { relay } = setup({ maxPayloadBytes: 50 })
    assert.equal((await relay.handle(scoreboard, { liveState: {} })).reason, 'missing_match_id')
    assert.equal((await relay.handle(scoreboard, { matchId: 7, liveState: [] })).reason, 'invalid_live_state')
    assert.equal((await relay.handle(scoreboard, { matchId: 7 })).reason, 'invalid_live_state')
    assert.equal((await relay.handle(scoreboard, { matchId: 7, liveState: { pad: 'x'.repeat(100) } })).reason, 'too_large')
  })

  it('caches lookups, coalesces concurrent ones and negative-caches unknown matches', async () => {
    const { relay, lookups, activeMatches } = setup()
    await Promise.all([
      relay.handle(scoreboard, message({ points_a: 1 })),
      relay.handle(scoreboard, message({ points_a: 2 }))
    ])
    await relay.handle(scoreboard, message({ points_a: 3 }))
    assert.deepEqual(lookups, [`external_id=${SEED}`])
    activeMatches.set('8', { match: { id: 8, seed_key: 'match_unknown' }, updatedBy: 'client-3' })
    const other = { id: 'client-3', role: 'scoreboard', matchId: 8 }
    assert.equal((await relay.handle(other, { matchId: 8, liveState: {} })).reason, 'unknown_match')
    assert.equal((await relay.handle(other, { matchId: 8, liveState: {} })).reason, 'unknown_match')
    assert.deepEqual(lookups, [`external_id=${SEED}`, 'external_id=match_unknown'])
    // invalidate by the resolved UUID (what a matches DELETE knows) drops the seed-keyed entry.
    relay.invalidate(MATCH_A)
    await relay.handle(scoreboard, message())
    assert.deepEqual(lookups, [`external_id=${SEED}`, 'external_id=match_unknown', `external_id=${SEED}`])
    relay.invalidate(SEED)
    await relay.handle(scoreboard, message())
    assert.equal(lookups.length, 4)
  })

  it('expires positive cache entries after cacheTtlMs', async () => {
    const { relay, lookups } = setup({ cacheTtlMs: 10 })
    await relay.handle(scoreboard, message())
    await new Promise(r => setTimeout(r, 25))
    await relay.handle(scoreboard, message())
    assert.equal(lookups.length, 2)
  })

  it('reports lookup failures without caching them', async () => {
    let calls = 0
    const { relay } = setup({ lookupMatch: async () => { calls++; throw new Error('db down') } })
    assert.equal((await relay.handle(scoreboard, message())).reason, 'lookup_failed')
    assert.equal((await relay.handle(scoreboard, message())).reason, 'lookup_failed')
    assert.equal(calls, 2)
  })

  it('drops keys the catalog predicate rejects', async () => {
    const cols = new Set(['match_id', 'sport_type', 'points_a'])
    const { relay, published } = setup({ allowColumn: (t, c) => t === 'match_live_state' && cols.has(c) })
    await relay.handle(scoreboard, { matchId: 7, liveState: { points_a: 1, bogus: 2 } })
    assert.deepEqual(published[0].rows[0], { points_a: 1, match_id: MATCH_A, sport_type: 'indoor' })
  })

  it('end to end: real Scoreboard payload reaches a sport_type=eq.indoor subscriber, redacted and ordered', async () => {
    const srv = await startServer()
    try {
      const { relay } = setup({ hub: srv.hub })
      const c = await liveClient(srv.url)
      await subscribe(c, 'livescore', [{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'indoor' }])
      const res = await relay.handle(scoreboard, message({ points_a: 7, updated_at: '2026-10-05T12:00:05.000Z', connection_pins: { referee: '999999' } }))
      assert.equal(res.ok, true)
      const msg = await c.next()
      assert.equal(msg.eventType, 'UPDATE')
      assert.equal(msg.new.match_id, MATCH_A)
      assert.equal(msg.new.points_a, 7)
      assert.equal('connection_pins' in msg.new, false)
      // The HTTP write-through of the previous point arrives late: dropped.
      srv.hub.broadcastDbChange('match_live_state', 'UPSERT', [{ ...liveState({ points_a: 6, updated_at: '2026-10-05T12:00:04.000Z' }) }])
      assert.equal(await c.silent(), true)
      c.close(); await c.closed
    } finally { await srv.stop() }
  })
})
