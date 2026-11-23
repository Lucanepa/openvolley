/**
 * Live sockets (?purpose=live) can no longer be held by idle sockets of one
 * customer's network (audit 2611 SEC-08): 100 idle sockets from each of 30
 * IPv6 /64s of one /56 held the hub's 3000 slots, and every later live
 * socket (livescore, the referee's scorer alarm, the tablets' fallback) was
 * refused with 1013.
 *
 *   - per wider network (netsOf / maxPerNet; server.js: IPv6 /56 and /48,
 *     IPv4 /24) on top of the /64 bucket
 *   - at the total cap, a socket that holds no channel makes room
 *   - a socket that holds no channel for channelGraceMs is closed
 *
 * The unit part runs the hub on its own HTTP server; the end-to-end part
 * boots server.js against Postgres (PG_TEST_URL) with the production wiring.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import WebSocket from 'ws'
import { createRealtimeHub, isLiveRequest } from '../lib/realtimeHub.js'
import { redactSecrets as redact } from '../lib/secrets.js'
import { SKIP, bootServer, provisionDatabase, waitUntil } from './helpers/e2eServer.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startHub(options = {}) {
  const hub = createRealtimeHub({ redact, logger: { log() {}, warn() {} }, ...options })
  const server = createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket, head) => {
    if (isLiveRequest(req)) hub.handleUpgrade(req, socket, head, { ip: req.headers['x-test-ip'] || '127.0.0.1' })
    else socket.destroy()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    hub,
    url: `ws://127.0.0.1:${server.address().port}`,
    async stop() {
      hub.close()
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    }
  }
}

/** A live socket: resolves once greeted or closed; { ws, messages, closed, ok }. */
function open(url, { ip, header = 'x-test-ip', query = '' } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url}/?purpose=live${query}`, { headers: ip ? { [header]: ip } : {} })
    const s = { ws, messages: [], closed: null, ok: false }
    s.send = (m) => ws.send(JSON.stringify(m))
    let done = false
    const fin = () => { if (!done) { done = true; resolve(s) } }
    ws.on('message', (d) => {
      s.messages.push(JSON.parse(d.toString()))
      if (s.messages[0]?.type === 'connected') s.ok = true
      fin()
    })
    ws.on('close', (code, reason) => { s.closed = { code, reason: reason.toString() }; fin() })
    ws.on('error', () => fin())
  })
}
const isOpen = (s) => s.ok && !s.closed && s.ws.readyState === WebSocket.OPEN
async function subscribe(s, id = 'ch') {
  s.send({ type: 'subscribe-db', id, subs: [{ table: 'match_live_state', column: 'match_id', value: 'm-1' }] })
  await waitUntil(() => s.messages.find((m) => m.type === 'subscribe-db-ack' && m.id === id), { timeoutMs: 2000, what: 'ack' })
}

// the /56 and /48 of an IPv6 /64 bucket, as server.js derives them
const bucketOf = (ip) => (ip.includes(':') ? ip.split(':').slice(0, 4).join(':') + '::/64' : ip)
const netsOf = (ip) => {
  if (!ip.includes(':')) return [['v4net24', ip.split('.').slice(0, 3).join('.')]]
  const g = ip.split(':')
  return [['v6net56', `${g[0]}:${g[1]}:${g[2]}:${(parseInt(g[3], 16) & 0xff00).toString(16)}`], ['v6net48', `${g[0]}:${g[1]}:${g[2]}`]]
}
const in56 = (i, host = 1) => `2001:db8:77:${(0x1000 + i).toString(16)}::${host}`

describe('realtimeHub: wider networks, the total cap, sockets without a channel', () => {
  it('counts live sockets per wider network: one /56 cannot take more than its share', async () => {
    const srv = await startHub({ bucketOf, netsOf, maxPerIp: 2, maxPerNet: { v6net56: 3, v6net48: 5, v4net24: 2 } })
    try {
      const held = [await open(srv.url, { ip: in56(0) }), await open(srv.url, { ip: in56(0, 2) }), await open(srv.url, { ip: in56(1) })]
      assert.equal(held.every(isOpen), true)
      const fourth = await open(srv.url, { ip: in56(2) })
      assert.equal(fourth.closed?.code, 1008, 'a fourth socket of the /56')
      assert.match(fourth.closed.reason, /network/)
      // another /56 of the same /48: its own share, until the /48's
      const other = [await open(srv.url, { ip: '2001:db8:77:2000::1' }), await open(srv.url, { ip: '2001:db8:77:2001::1' })]
      assert.equal(other.every(isOpen), true)
      assert.equal((await open(srv.url, { ip: '2001:db8:77:2002::1' })).closed?.code, 1008, 'the /48 is full')
      assert.equal(isOpen(await open(srv.url, { ip: '2001:db8:99:1::1' })), true, 'another network')
      // IPv4 by /24
      assert.equal(isOpen(await open(srv.url, { ip: '203.0.113.1' })), true)
      assert.equal(isOpen(await open(srv.url, { ip: '203.0.113.2' })), true)
      assert.equal((await open(srv.url, { ip: '203.0.113.3' })).closed?.code, 1008)
      assert.equal(srv.hub.stats().nets > 0, true)
      // a socket closing frees its network's slot
      held[0].ws.close()
      await waitUntil(() => held[0].closed, { timeoutMs: 2000, what: 'closed' })
      await sleep(20)
      assert.equal(isOpen(await open(srv.url, { ip: in56(3) })), true)
    } finally { await srv.stop() }
  })

  it('at the total cap a socket without a channel makes room; sockets that all hold one refuse the next', async () => {
    const srv = await startHub({ bucketOf, maxTotal: 2 })
    try {
      const tablet = await open(srv.url, { ip: '198.51.100.1' })
      await subscribe(tablet)
      const idle = await open(srv.url, { ip: '198.51.100.2' })
      const late = await open(srv.url, { ip: '198.51.100.3' })
      assert.equal(isOpen(late), true, 'the newcomer gets the idle socket\'s slot')
      await waitUntil(() => idle.closed, { timeoutMs: 2000, what: 'the idle socket closed' })
      assert.equal(idle.closed.code, 1013)
      assert.equal(isOpen(tablet), true)
      await subscribe(late)
      const refused = await open(srv.url, { ip: '198.51.100.4' })
      assert.equal(refused.closed?.code, 1013, 'every socket holds a channel')
      assert.equal(srv.hub.stats().evicted, 1)
    } finally { await srv.stop() }
  })

  it('closes a socket that holds no channel for the grace time, also after its last channel went', async () => {
    const srv = await startHub({ bucketOf, channelGraceMs: 300 })
    try {
      const idle = await open(srv.url, { ip: '198.51.100.11' })
      const tablet = await open(srv.url, { ip: '198.51.100.12' })
      await subscribe(tablet)
      const leaving = await open(srv.url, { ip: '198.51.100.13' })
      await subscribe(leaving)
      await waitUntil(() => idle.closed, { timeoutMs: 2000, what: 'the idle socket closed' })
      assert.equal(idle.closed.code, 1008)
      leaving.send({ type: 'unsubscribe-db', id: 'ch' })
      await waitUntil(() => leaving.closed, { timeoutMs: 2000, what: 'the socket without a channel closed' })
      await sleep(400)
      assert.equal(isOpen(tablet), true, 'a socket with a channel stays')
      assert.equal(srv.hub.stats().closedNoChannel, 2)
    } finally { await srv.stop() }
  })
})

describe('server.js: live sockets of one /56 (end to end)', { skip: SKIP }, () => {
  let db
  let srv
  const sockets = []
  before(async () => {
    db = await provisionDatabase()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
  })
  after(async () => {
    for (const s of sockets) { try { s.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
    await db?.drop()
  })

  it('a /56 holds 200 live sockets, a tablet of another network still gets in', async () => {
    for (let b = 0; b < 2; b++) {
      const batch = await Promise.all(Array.from({ length: 100 }, (_, i) => open(srv.wsUrl, { ip: in56(b, i + 1), header: 'cf-connecting-ip' })))
      sockets.push(...batch)
      assert.equal(batch.every(isOpen), true)
    }
    const third = await open(srv.wsUrl, { ip: in56(2), header: 'cf-connecting-ip' })
    sockets.push(third)
    assert.equal(third.closed?.code, 1008, 'the 201st of the /56')
    const tablet = await open(srv.wsUrl, { ip: '198.51.100.79', header: 'cf-connecting-ip' })
    sockets.push(tablet)
    assert.equal(isOpen(tablet), true)
    const viewer = await open(srv.wsUrl, { ip: '198.51.100.80', header: 'cf-connecting-ip', query: '&client=viewer' })
    sockets.push(viewer)
    assert.equal(isOpen(viewer), true)
  })
})
