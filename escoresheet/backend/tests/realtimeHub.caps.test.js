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
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

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

  // review R-SEC08-1: a socket without a channel makes room only once it
  // held none for idleEvictMs (a newer one may still be subscribing)
  it('at the total cap a socket without a channel makes room; sockets that all hold one refuse the next', async () => {
    const srv = await startHub({ bucketOf, maxTotal: 2, idleEvictMs: 150 })
    try {
      const tablet = await open(srv.url, { ip: '198.51.100.1' })
      await subscribe(tablet)
      const idle = await open(srv.url, { ip: '198.51.100.2' })
      const early = await open(srv.url, { ip: '198.51.100.5' })
      assert.equal(early.closed?.code, 1013, 'a socket that just connected (no channel yet) keeps its slot')
      assert.equal(isOpen(idle), true)
      await sleep(200)
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

// Review of the SEC-08 fix (R-SEC08-1): any anonymous subscribe-db is a
// channel, so a network's sockets were never pushed out nor closed, and the
// 20 % kept for tablets was taken by sockets that leave client=viewer out.
describe('realtimeHub: who makes room at a cap (fair share, slots kept for match devices)', () => {
  // the widest network of each address, as server.js derives it (IPv4 /24)
  const v4netsOf = (ip) => [['v4net24', ip.split('.').slice(0, 3).join('.')]]
  const subscribed = async (url, ip, query = '') => {
    const s = await open(url, { ip, query })
    if (isOpen(s)) await subscribe(s)
    return s
  }

  it('at the total cap the newest socket of the network holding the most makes room; a newcomer of that network is refused', async () => {
    const srv = await startHub({ bucketOf, netsOf: v4netsOf, maxTotal: 5 })
    try {
      const hall = await subscribed(srv.url, '198.51.100.20') // connected before the flood
      const flood = []
      for (let i = 1; i <= 4; i++) flood.push(await subscribed(srv.url, `203.0.113.${i}`))
      assert.equal([hall, ...flood].every(isOpen), true)
      const more = await open(srv.url, { ip: '203.0.113.50' })
      assert.equal(more.closed?.code, 1013, 'the flooding network\'s newcomer is refused')
      const tablet = await subscribed(srv.url, '192.0.2.30')
      assert.equal(isOpen(tablet), true, 'a socket of another network gets in')
      await waitUntil(() => flood[3].closed, { timeoutMs: 2000, what: 'the flood\'s newest pushed out' })
      assert.equal(flood[3].closed.code, 1013)
      assert.equal(isOpen(hall), true, 'the hall\'s socket that connected before the flood stays')
      assert.equal(flood.slice(0, 3).every(isOpen), true)
      // the next one of the tablet's network too (2 there, 3 in the flood's)
      const tablet2 = await subscribed(srv.url, '192.0.2.31')
      assert.equal(isOpen(tablet2), true)
      await waitUntil(() => flood[2].closed, { timeoutMs: 2000, what: 'the flood\'s newest pushed out' })
      // now no network holds more than the tablets' would: its third is refused
      assert.equal((await open(srv.url, { ip: '192.0.2.32' })).closed?.code, 1013)
      assert.equal([tablet, tablet2, hall, flood[0], flood[1]].every(isOpen), true)
    } finally { await srv.stop() }
  })

  it('sockets that proved nothing (viewers or not) leave the tablets\' share free; a proved socket takes it and pushes an unproved one out', async () => {
    const proved = new Set(['192.0.2.40', '192.0.2.41', '192.0.2.42'])
    const srv = await startHub({ bucketOf, netsOf: v4netsOf, maxTotal: 5, maxViewers: 3, socketProof: (s) => (proved.has(s.ip) ? `a:${s.bucket}` : null) })
    try {
      // the attacker leaves client=viewer out: it still gets the unproved share only (3)
      const flood = []
      for (let i = 1; i <= 3; i++) flood.push(await subscribed(srv.url, `203.0.113.${i}`))
      assert.equal(flood.every(isOpen), true)
      assert.equal((await open(srv.url, { ip: '203.0.113.9' })).closed?.code, 1013, 'the unproved share is full')
      assert.equal(srv.hub.stats().sockets, 3)
      // the referee and bench tablets (their address proved the match)
      const referee = await subscribed(srv.url, '192.0.2.40')
      const bench = await subscribed(srv.url, '192.0.2.41')
      assert.equal(isOpen(referee) && isOpen(bench), true, 'the tablets\' share')
      assert.equal(srv.hub.stats().proved, 2)
      // all 5 slots held: one more proved socket pushes the flood's newest out
      const bench2 = await subscribed(srv.url, '192.0.2.42')
      assert.equal(isOpen(bench2), true)
      await waitUntil(() => flood[2].closed, { timeoutMs: 2000, what: 'an unproved socket made room' })
      // a viewer of another network: the flood's newest again
      const viewer = await subscribed(srv.url, '198.51.100.60', '&client=viewer')
      assert.equal(isOpen(viewer), true)
      await waitUntil(() => flood[1].closed, { timeoutMs: 2000, what: 'the flood made room for a viewer' })
      assert.equal([referee, bench, bench2].every(isOpen), true, 'a proved socket is never pushed out')
    } finally { await srv.stop() }
  })

  it('one proof key keeps slots for maxProvedPerKey sockets; a channel\'s proof (a match token) counts from its subscribe on', async () => {
    const srv = await startHub({
      bucketOf,
      maxTotal: 10,
      maxProvedPerKey: 2,
      socketProof: (s) => {
        for (const ch of s.channels.values()) if (ch.grant?.match) return `t:${ch.grant.match}`
        return null
      },
      grantChannel: (msg) => (msg.token === 'good' ? { match: 'm-1' } : null)
    })
    try {
      const tablets = []
      for (let i = 1; i <= 3; i++) {
        const s = await open(srv.url, { ip: `198.51.100.${70 + i}` })
        s.send({ type: 'subscribe-db', id: 'ch', token: 'good', subs: [{ table: 'match_live_state', column: 'match_id', value: 'm-1' }] })
        await waitUntil(() => s.messages.find((m) => m.type === 'subscribe-db-ack'), { timeoutMs: 2000, what: 'ack' })
        tablets.push(s)
      }
      assert.equal(srv.hub.stats().proved, 2, 'the third copy of the token proves nothing')
      assert.equal(srv.hub.stats().unproved, 1)
    } finally { await srv.stop() }
  })

  it('a proved socket refused at a full hub keeps no place of its proof key', async () => {
    const srv = await startHub({ bucketOf, maxTotal: 1, maxProvedPerKey: 2, socketProof: () => 'a:hall' })
    try {
      const first = await open(srv.url, { ip: '198.51.100.81' })
      assert.equal(isOpen(first), true)
      assert.equal((await open(srv.url, { ip: '198.51.100.82' })).closed?.code, 1013, 'every socket proved something')
      assert.equal(srv.hub.stats().provedPlaces, 1)
      first.ws.close()
      await waitUntil(() => first.closed, { timeoutMs: 2000, what: 'closed' })
      await sleep(20)
      assert.equal(srv.hub.stats().provedPlaces, 0)
    } finally { await srv.stop() }
  })

  it('counts sockets that proved nothing and are no viewer per network at half its share', async () => {
    const srv = await startHub({ bucketOf, netsOf: v4netsOf, maxPerNet: { v4net24: 4 }, socketProof: (s) => (s.ip === '203.0.113.200' ? 'a:x' : null) })
    try {
      assert.equal(isOpen(await open(srv.url, { ip: '203.0.113.1' })), true)
      assert.equal(isOpen(await open(srv.url, { ip: '203.0.113.2' })), true)
      assert.equal((await open(srv.url, { ip: '203.0.113.3' })).closed?.code, 1008, 'two unproved tablets of the /24')
      assert.equal(isOpen(await open(srv.url, { ip: '203.0.113.4', query: '&client=viewer' })), true, 'a viewer of the /24')
      assert.equal(isOpen(await open(srv.url, { ip: '203.0.113.200' })), true, 'a proved socket of the /24')
      assert.equal((await open(srv.url, { ip: '203.0.113.5', query: '&client=viewer' })).closed?.code, 1008, 'the /24\'s whole share')
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

  // review of the SEC-08 fix: sockets that proved nothing and are no viewer
  // get half a network's share (100 of a /56's 200); updated from "a /56
  // holds 200 live sockets" of any kind
  it('a /56 holds 200 live sockets, 100 of them unproved non-viewers; a tablet of another network still gets in', async () => {
    const batch = await Promise.all(Array.from({ length: 100 }, (_, i) => open(srv.wsUrl, { ip: in56(0, i + 1), header: 'cf-connecting-ip' })))
    sockets.push(...batch)
    assert.equal(batch.every(isOpen), true)
    const tablet101 = await open(srv.wsUrl, { ip: in56(1, 1), header: 'cf-connecting-ip' })
    sockets.push(tablet101)
    assert.equal(tablet101.closed?.code, 1008, 'the 101st unproved non-viewer of the /56')
    const viewers = await Promise.all(Array.from({ length: 100 }, (_, i) => open(srv.wsUrl, { ip: in56(1, i + 1), header: 'cf-connecting-ip', query: '&client=viewer' })))
    sockets.push(...viewers)
    assert.equal(viewers.every(isOpen), true, 'viewers of the /56 up to its 200')
    const third = await open(srv.wsUrl, { ip: in56(2), header: 'cf-connecting-ip', query: '&client=viewer' })
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

// Review of the SEC-08 fix (R-SEC08-1) with the production wiring: the slots
// kept for match devices (20 %) go to sockets that proved a match (a match
// token on a channel, or an address that proved the match: a PIN check on
// HTTP or on the relay), and a flood of anonymous subscribe-db sockets
// makes room for a viewer of another network.
describe('server.js: the live slots kept for match devices (end to end)', { skip: SKIP }, () => {
  const PIN_SECRET = randomBytes(32).toString('base64url')
  const PINS = { referee: '461302', bench_home: '730214', bench_away: '519027' }
  const GAME_PIN = '824613'
  const ext = `match_res_${Date.now()}_${randomBytes(3).toString('hex')}`
  let db
  let sql
  let srv
  let scorer
  let matchUuid
  const sockets = []
  const live = async (ip, query = '') => {
    const s = await open(srv.wsUrl, { ip, header: 'cf-connecting-ip', query })
    sockets.push(s)
    return s
  }
  const role = (ip) => new Promise((resolve) => {
    const ws = new WebSocket(srv.wsUrl, { headers: { 'cf-connecting-ip': ip } })
    const s = { ws, messages: [] }
    s.send = (m) => ws.send(JSON.stringify(m))
    ws.on('message', (d) => { s.messages.push(JSON.parse(d.toString())); if (s.messages.length === 1) resolve(s) })
    sockets.push(s)
  })
  const subWith = async (s, id, subs) => {
    s.send({ type: 'subscribe-db', id, subs })
    await waitUntil(() => s.messages.find((m) => m.type === 'subscribe-db-ack' && m.id === id), { timeoutMs: 3000, what: `ack ${id}` })
  }
  const byMatch = (id) => [{ table: 'match_live_state', event: '*', column: 'match_id', value: id }]

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', OV_PIN_SECRET: PIN_SECRET, OV_LIVE_MAX_CONNECTIONS: '20' })
    const email = `scorer-${randomBytes(3).toString('hex')}@example.ch`
    const headers = { 'cf-connecting-ip': '198.51.100.71' }
    assert.equal((await api(srv.base, '/api/auth/sign-up', { headers, body: { email, password: 'correct-horse-battery' } })).status, 200)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers, body: { email, password: 'correct-horse-battery' } })
    await grantRoles(sql, inn.json.data.user.id, ['scorer'])
    scorer = inn.json.data.session.access_token
    const r = await api(srv.base, '/api/db', {
      token: scorer,
      headers,
      body: {
        table: 'matches',
        action: 'upsert',
        params: {
          data: {
            external_id: ext, game_n: 9701, game_pin: GAME_PIN, connection_pins: PINS,
            connections: { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: true },
            status: 'live', sport_type: 'indoor', home_team: { name: 'Home VC' }, away_team: { name: 'Away VC' },
            scheduled_at: new Date().toISOString()
          },
          onConflict: 'external_id',
          returning: 'id',
          single: true
        }
      }
    })
    assert.equal(r.status, 200, r.text)
    matchUuid = r.json.data.id
  })
  after(async () => {
    for (const s of sockets) { try { s.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
    await sql?.end().catch(() => {})
    await db?.drop()
  })

  it('a flood of anonymous channels takes 80 % at most; a viewer of another network and the proved tablets get in', async () => {
    // 16 = 80 % of 20: anonymous sockets of one /24, each with a channel, no client=viewer
    const flood = []
    for (let i = 1; i <= 16; i++) {
      const s = await live(`203.0.113.${i}`)
      await subWith(s, 'all', [{ table: 'match_live_state', event: '*', column: 'sport_type', value: 'indoor' }])
      flood.push(s)
    }
    const more = await live('203.0.113.99')
    assert.equal(more.closed?.code, 1013, 'the flood\'s 17th: the rest is kept for match devices')
    // a public livescore page of another network: the flood's newest makes room
    const viewer = await live('198.18.0.5', '&client=viewer')
    assert.equal(isOpen(viewer), true)
    await waitUntil(() => flood[15].closed, { timeoutMs: 3000, what: 'the flood made room' })
    // a referee tablet of an installed app: its PIN check, then its live socket (no token)
    const check = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: { 'cf-connecting-ip': '192.0.2.10' }, body: { pin: PINS.referee, type: 'referee', matchExternalId: ext } })
    assert.equal(check.status, 200, check.text)
    const referee = await live('192.0.2.10')
    assert.equal(isOpen(referee), true, 'the referee\'s live socket')
    await subWith(referee, 'alarm', byMatch(matchUuid))
    // a bench tablet that proved the match on the relay only (its PIN on a role socket)
    const room = await role('198.51.100.10')
    room.send({
      type: 'sync-match-data',
      matchId: ext,
      match: { id: 1, seed_key: ext, status: 'live', gamePin: GAME_PIN, refereePin: PINS.referee, homeTeamPin: PINS.bench_home, awayTeamPin: PINS.bench_away, refereeConnectionEnabled: true, homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: true },
      homeTeam: { id: 1, name: 'Home VC' },
      awayTeam: { id: 2, name: 'Away VC' },
      homePlayers: [],
      awayPlayers: [],
      sets: [],
      events: [],
      _timestamp: Date.now()
    })
    await waitUntil(() => room.messages.find((m) => m.type === 'display-presence'), { timeoutMs: 5000, what: 'the scorer owns the room' })
    const benchRole = await role('192.0.2.30')
    benchRole.send({ type: 'subscribe-match', matchId: ext, role: 'bench', team: 'home', pin: PINS.bench_home })
    await waitUntil(() => benchRole.messages.find((m) => m.type === 'match-full-data' && m.access === 'full'), { timeoutMs: 5000, what: 'the bench\'s bundle' })
    const bench = await live('192.0.2.30')
    assert.equal(isOpen(bench), true)
    await subWith(bench, 'live', byMatch(matchUuid))
    await sleep(300) // the match row read for the proofs
    const r = await api(srv.base, '/api/db', {
      token: scorer,
      body: { table: 'match_live_state', action: 'upsert', params: { data: { match_id: matchUuid, sport_type: 'indoor', current_set: 1, points_a: 5, points_b: 0, lineup_a: { I: { number: 7 } }, updated_at: new Date().toISOString() }, onConflict: 'match_id' } }
    })
    assert.equal(r.status, 200, r.text)
    const frame = (s) => waitUntil(() => s.messages.find((m) => m.type === 'db-change' && m.new?.points_a === 5), { timeoutMs: 5000, what: 'the live state' })
    assert.equal((await frame(referee)).new.lineup_a?.I?.number, 7, 'the referee (HTTP PIN check) gets the line-up')
    assert.equal((await frame(bench)).new.lineup_a?.I?.number, 7, 'the bench (relay PIN) gets the line-up')
    assert.equal((await frame(flood[0])).new.lineup_a, undefined, 'the flood does not')
  })
})
