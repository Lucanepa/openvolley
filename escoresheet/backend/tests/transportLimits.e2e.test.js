/**
 * The backend transport against abuse (the rollout audit's transport unit):
 * what a web page in a visitor's browser, a client rotating its addresses or
 * an anonymous socket can make the server do. Boots server.js as a cloud
 * relay behind Cloudflare (IS_CLOUD, TRUST_PROXY, --local), as a venue relay
 * (--local) and, with PG_TEST_URL, in DATABASE_URL mode.
 *
 *   - rate limits key on the address bucket (an IPv6 /64 on the cloud)
 *   - API writes from a foreign Origin (403) or with a body that is not JSON
 *     (415) are refused before any rate bucket is charged
 *   - WebSocket upgrades from a foreign Origin are refused; no Origin, the app
 *     sites and (venue relay) pages of the hall network connect
 *   - the CORS answer never reflects a foreign origin
 *   - the cloud landing page lists no rooms
 *   - a socket that owns no room sends only a few large frames; sockets that
 *     own only rooms no database proved share their address's budget for
 *     them; client text reaches the log cut short and without control
 *     characters
 *   - a page of an outside name re-pointed at a venue relay (DNS rebinding)
 *     is no page of the server's own
 *   - the cloud's /api/server/status names no counts
 *   - DATABASE_URL: approvals, the approval PIN and the test mail count in
 *     counters of their own; anonymous /api/db reads, and those of an account
 *     without a role, count at most 1000 rows and scan at most 100 of events;
 *     a scorer whose room the database proved is not held back by its
 *     address's frame budget; backups need a role and fit a total
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import WebSocket from 'ws'
import { SKIP, bootServer, api, openSocket, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { MAX_RELAY_ROOM_ADDRESS_BYTES, MAX_RELAY_ROOM_SOCKET_BYTES } from '../lib/relayLimits.js'

const EVIL = 'https://evil.example'

/** Opens a raw socket: 'open' or the refused upgrade's HTTP status. */
function upgrade(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    ws.once('open', () => { ws.terminate(); resolve('open') })
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate() })
    ws.once('error', () => resolve('error'))
  })
}

const post = (base, path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

function syncMessage(room, { match = {}, ...extra } = {}) {
  return {
    type: 'sync-match-data',
    matchId: room,
    match: { id: 1, seed_key: room, status: 'live', gamePin: '987654', refereePin: '314159', refereeConnectionEnabled: true, ...match },
    homeTeam: { id: 1, name: 'Fictional Home VC' },
    awayTeam: { id: 2, name: 'Fictional Away VC' },
    homePlayers: [],
    awayPlayers: [],
    sets: [],
    events: [],
    ...extra
  }
}

/** Waits until the socket received `n` messages of `type` (or the timeout), then returns them. */
async function received(c, type, n, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end && c.messages.filter((m) => m.type === type).length < n) await sleep(20)
  return c.messages.filter((m) => m.type === type)
}

/** A ping of exactly 1,000,000 bytes: a large frame (over 64 KB) that is cheap to parse. */
const LARGE_FRAME = JSON.stringify({ type: 'ping', pad: 'x'.repeat(1000000 - 24) })

/**
 * Sends `n` copies of `frame` on each socket, waits until every copy was
 * answered (pong, or too-large) or the socket closed, and counts the answers.
 */
async function flood(socks, frame, n) {
  const from = socks.map((c) => c.messages.length)
  for (let i = 0; i < n; i++) for (const c of socks) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(frame)
  const since = (c, i) => c.messages.slice(from[i])
  const answered = (c, i) => since(c, i).filter((m) => m.type === 'pong' || m.code === 'too-large').length
  const end = Date.now() + 30000
  while (Date.now() < end && !socks.every((c, i) => c.ws.readyState === WebSocket.CLOSED || answered(c, i) >= n)) await sleep(20)
  const count = (pred) => socks.reduce((sum, c, i) => sum + since(c, i).filter(pred).length, 0)
  return {
    pongs: count((m) => m.type === 'pong'),
    refused: count((m) => m.code === 'too-large'),
    closed: socks.filter((c) => c.ws.readyState === WebSocket.CLOSED).length
  }
}

/** A raw upgrade or POST with the Host header given: the status code. */
function rawRequest(port, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: method === 'GET' ? '/' : '/api/match/validate-pin', method, headers })
    req.on('upgrade', (res, sock) => { sock.destroy(); resolve(res.statusCode) })
    req.on('response', (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', () => resolve('error'))
    req.end(body)
  })
}
const upgradeHeaders = (host, origin) => ({
  Host: host, Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket',
  // a fresh 16-byte nonce, as every WebSocket client sends
  'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64')
})

const closed = (c, timeoutMs = 3000) => new Promise((resolve) => {
  if (c.ws.readyState === WebSocket.CLOSED) return resolve(c.closeCode ?? null)
  const t = setTimeout(() => resolve(null), timeoutMs)
  c.ws.once('close', (code) => { clearTimeout(t); resolve(code) })
})

describe('transport limits: cloud relay behind Cloudflare', () => {
  let srv
  const sockets = []
  before(async () => {
    srv = await bootServer({ IS_CLOUD: '1', TRUST_PROXY: 'cloudflare' }, ['--local'])
  })
  after(async () => {
    for (const c of sockets.splice(0)) { try { c.ws.terminate() } catch { /* gone */ } }
    await srv?.stop()
  })
  const open = async (headers) => {
    const c = await openSocket(srv.wsUrl, headers ? { headers } : undefined)
    c.ws.on('close', (code) => { c.closeCode = code })
    sockets.push(c)
    return c
  }

  it('relay reads are limited per /64: rotating the addresses of one prefix does not escape the limit', async () => {
    const statuses = { rotating: {}, other: 0 }
    for (let i = 0; i < 1100; i++) {
      const r = await fetch(`${srv.base}/api/match/list`, { headers: { 'cf-connecting-ip': `2001:db8:a:b::${(i + 1).toString(16)}` } })
      await r.arrayBuffer()
      statuses.rotating[r.status] = (statuses.rotating[r.status] || 0) + 1
    }
    assert.ok((statuses.rotating[429] || 0) >= 90, JSON.stringify(statuses.rotating))
    // another /64 has its own bucket
    const r = await fetch(`${srv.base}/api/match/list`, { headers: { 'cf-connecting-ip': '2001:db8:c:d::1' } })
    assert.equal(r.status, 200)
  })

  it('an API write with a body that is not JSON is refused (415) before any bucket is charged', async () => {
    const ip = { 'cf-connecting-ip': '198.51.100.10' }
    const body = JSON.stringify({ pin: '123456', type: 'referee' })
    const plain = []
    for (let i = 0; i < 70; i++) {
      const r = await post(srv.base, '/api/match/validate-pin', body, { ...ip, 'Content-Type': 'text/plain' })
      plain.push(r.status)
      await r.arrayBuffer()
    }
    assert.deepEqual([...new Set(plain)], [415])
    for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      const r = await post(srv.base, '/api/match/validate-pin', body, { ...ip, ...(type ? { 'Content-Type': type } : {}) })
      assert.equal(r.status, 415, type)
      assert.equal((await r.json()).error.code, 'OV_UNSUPPORTED_MEDIA_TYPE')
    }
    // the address's PIN bucket (60 a minute) is untouched: the JSON check is answered
    const r = await post(srv.base, '/api/match/validate-pin', body, { ...ip, 'Content-Type': 'application/json' })
    assert.equal(r.status, 404)
    // the support form also takes multipart
    const form = await post(srv.base, '/api/contact', '--x--\r\n', { ...ip, 'Content-Type': 'multipart/form-data; boundary=x' })
    assert.notEqual(form.status, 415)
  })

  it('an API write from a page of a foreign origin is refused (403); the app sites and requests without Origin are not', async () => {
    const ip = { 'cf-connecting-ip': '198.51.100.11', 'Content-Type': 'application/json' }
    const body = { pin: '123456', type: 'referee' }
    const evil = await post(srv.base, '/api/match/validate-pin', body, { ...ip, Origin: EVIL })
    assert.equal(evil.status, 403)
    assert.equal((await evil.json()).error.code, 'OV_ORIGIN_REFUSED')
    for (const o of ['https://dev-app.openvolley.app', 'null', 'http://192.168.1.20:5173']) {
      const r = await post(srv.base, '/api/match/validate-pin', body, { ...ip, Origin: o })
      assert.equal(r.status, 403, o)
    }
    for (const o of [undefined, 'https://referee.openvolley.app', 'capacitor://localhost', 'http://localhost:5173']) {
      const r = await post(srv.base, '/api/match/validate-pin', body, { ...ip, ...(o ? { Origin: o } : {}) })
      assert.equal(r.status, 404, String(o))
    }
    // the multipart support form too
    const form = await post(srv.base, '/api/contact', '--x--\r\n', { 'cf-connecting-ip': '198.51.100.12', 'Content-Type': 'multipart/form-data; boundary=x', Origin: EVIL })
    assert.equal(form.status, 403)
    // reads are not refused; their CORS answer names the first site
    const list = await fetch(`${srv.base}/api/match/list`, { headers: { Origin: EVIL } })
    assert.equal(list.status, 200)
    assert.equal(list.headers.get('access-control-allow-origin'), 'https://openvolley.app')
    assert.equal(list.headers.get('access-control-allow-credentials'), null)
  })

  it('a WebSocket upgrade from a foreign origin is refused; no Origin and the app sites connect', async () => {
    assert.equal(await upgrade(srv.wsUrl, { Origin: EVIL }), 403)
    assert.equal(await upgrade(srv.wsUrl, { Origin: 'https://dev-app.openvolley.app' }), 403)
    assert.equal(await upgrade(`${srv.wsUrl}/?purpose=live`, { Origin: EVIL }), 403)
    assert.equal(await upgrade(srv.wsUrl), 'open')
    assert.equal(await upgrade(srv.wsUrl, { Origin: 'https://referee.openvolley.app' }), 'open')
    assert.equal(await upgrade(srv.wsUrl, { Origin: 'tauri://localhost' }), 'open')
  })

  it('the landing page lists no rooms and no counts', async () => {
    const scorer = await open()
    scorer.send(syncMessage('landing-room'))
    await received(scorer, 'joined_match', 0, 300)
    await sleep(200)
    const html = await (await fetch(`${srv.base}/`)).text()
    assert.ok(html.includes('OpenVolley server'))
    assert.ok(!html.includes('Fictional Home VC'), 'no team names')
    assert.ok(!/connected client|active match/.test(html), 'no counts')
  })

  it('a socket without a claim sends a few large frames, then is refused and closed; client text is logged short and printable', async () => {
    const c = await open()
    const pad = 'x'.repeat(100 * 1024)
    for (let i = 0; i < 7; i++) c.ws.send(JSON.stringify({ type: 'ping', pad }))
    const pongs = await received(c, 'pong', 4)
    assert.equal(await closed(c), 1009)
    assert.equal(pongs.length, 4, 'the first four large frames are handled')
    assert.equal(c.messages.filter((m) => m.type === 'error' && m.code === 'too-large').length, 2)
    // small frames are not limited by size
    const small = await open()
    for (let i = 0; i < 20; i++) small.send({ type: 'ping', pad: 'y'.repeat(1000) })
    assert.equal((await received(small, 'pong', 20)).length, 20)

    // an unknown type is printed cut short, without its line breaks
    const before = srv.output.join('').length
    small.send({ type: `${'t'.repeat(50000)}\n[Auth] forged line` })
    small.send({ type: 'ping' })
    await received(small, 'pong', 21)
    await sleep(100)
    const out = srv.output.join('').slice(before)
    assert.ok(out.length < 2000, `log grew by ${out.length}`)
    assert.ok(!/^\[Auth\] forged line/m.test(out), out)
  })

  it('a scorer that owns its room keeps syncing large bundles', async () => {
    const scorer = await open()
    const events = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, type: 'point', seq: i + 1, setIndex: 1, payload: { team: i % 2 ? 'home' : 'away' }, ts: new Date(1767225600000 + i * 1000).toISOString() }))
    for (let i = 0; i < 8; i++) {
      scorer.send(syncMessage('large-room', { events: events.slice(0, 1000 + i * 50) }))
      await sleep(30)
    }
    await sleep(500)
    const errors = scorer.messages.filter((m) => m.type === 'error')
    assert.deepEqual(errors, [])
    assert.notEqual(scorer.ws.readyState, WebSocket.CLOSED)
  })

  it("owning a made-up room is no proof: the address's sockets share one budget for large frames", async () => {
    assert.equal(LARGE_FRAME.length, 1000000)
    const hall = { 'cf-connecting-ip': '198.51.100.40' }
    const owners = []
    for (let s = 0; s < 4; s++) {
      const c = await open(hall)
      // a sync of a room no one else knows: the relay lets the socket own it
      c.send(syncMessage(`made-up-room-${s}`))
      c.send({ type: 'ping' })
      await received(c, 'pong', 1)
      owners.push(c)
    }
    const r = await flood(owners, LARGE_FRAME, 20)
    assert.equal(r.pongs, Math.floor(MAX_RELAY_ROOM_ADDRESS_BYTES / LARGE_FRAME.length), JSON.stringify(r))
    assert.ok(r.refused >= 1, JSON.stringify(r))
    // another address has its own budget
    const other = await open({ 'cf-connecting-ip': '198.51.100.41' })
    other.send(syncMessage('made-up-room-other'))
    other.send({ type: 'ping' })
    await received(other, 'pong', 1)
    assert.deepEqual(await flood([other], LARGE_FRAME, 5), { pongs: 5, refused: 0, closed: 0 })
  })

  it('a socket that owns only made-up rooms sends at most its own bytes of large frames, then is closed', async () => {
    const c = await open({ 'cf-connecting-ip': '198.51.100.42' })
    c.send(syncMessage('made-up-room-single'))
    c.send({ type: 'ping' })
    await received(c, 'pong', 1)
    const allowed = Math.floor(MAX_RELAY_ROOM_SOCKET_BYTES / LARGE_FRAME.length)
    const r = await flood([c], LARGE_FRAME, allowed + 3)
    assert.deepEqual(r, { pongs: allowed, refused: 2, closed: 1 })
    assert.equal(await closed(c), 1009)
  })

  it('/api/server/status and /api/server/connections name no counts of the cloud', async () => {
    const status = await (await fetch(`${srv.base}/api/server/status`)).json()
    assert.equal(status.status, 'online')
    assert.equal(status.mode, 'cloud')
    assert.ok(status.wsPort != null, 'the apps read wsPort')
    for (const k of ['connections', 'matches', 'rooms']) assert.equal(k in status, false, k)
    const conns = await (await fetch(`${srv.base}/api/server/connections`)).json()
    assert.equal(conns.totalClients, null)
  })
})

describe('transport limits: venue relay', () => {
  let srv
  before(async () => { srv = await bootServer({}, ['--local']) })
  after(async () => { await srv?.stop() })

  it('pages of the hall network and the server itself connect; look-alike names do not', async () => {
    for (const o of ['http://192.168.1.20:5173', 'http://10.0.0.7', 'http://[fd00::7]:5173', 'http://scoretable.local:5173', `http://127.0.0.1:${srv.port}`]) {
      assert.equal(await upgrade(srv.wsUrl, { Origin: o }), 'open', o)
    }
    for (const o of ['http://10.evil.example', 'http://192.168.evil.example', 'http://8.8.8.8', EVIL]) {
      assert.equal(await upgrade(srv.wsUrl, { Origin: o }), 403, o)
    }
  })

  it('the CORS answer never reflects a foreign origin', async () => {
    const lan = await fetch(`${srv.base}/api/match/list`, { headers: { Origin: 'http://192.168.1.20:5173' } })
    assert.equal(lan.headers.get('access-control-allow-origin'), 'http://192.168.1.20:5173')
    const evil = await fetch(`${srv.base}/api/match/list`, { headers: { Origin: 'http://10.evil.example' } })
    assert.equal(evil.headers.get('access-control-allow-origin'), 'https://openvolley.app')
  })

  it("the landing page lists the hall's rooms", async () => {
    const scorer = await openSocket(srv.wsUrl)
    scorer.send(syncMessage('hall-room'))
    await sleep(300)
    const html = await (await fetch(`${srv.base}/`)).text()
    scorer.ws.terminate()
    assert.ok(html.includes('Fictional Home VC'))
  })

  it("a page of an outside name re-pointed at the relay (DNS rebinding) is not the server's own; a bare or .local name is", async () => {
    const rebind = `rebind.attacker.example:${srv.port}`
    assert.equal(await rawRequest(srv.port, { headers: upgradeHeaders(rebind, `http://${rebind}`) }), 403)
    const body = JSON.stringify({ pin: '123456', type: 'referee' })
    const write = await rawRequest(srv.port, {
      method: 'POST', body,
      headers: { Host: rebind, Origin: `http://${rebind}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    })
    assert.equal(write, 403)
    for (const host of [`scoretable:${srv.port}`, `scoretable.local:${srv.port}`, `127.0.0.1:${srv.port}`]) {
      assert.equal(await rawRequest(srv.port, { headers: upgradeHeaders(host, `http://${host}`) }), 101, host)
    }
  })

  it('/api/server/status names the counts on a venue relay', async () => {
    const status = await (await fetch(`${srv.base}/api/server/status`)).json()
    assert.equal(status.mode, 'local')
    for (const k of ['connections', 'matches', 'rooms']) assert.equal(typeof status[k], 'number', k)
  })
})

describe('transport limits: DATABASE_URL mode', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 20
  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
    await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery', metadata: { first_name: name, last_name: 'Test' } } })
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery' } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, ip }
    if (roles) await grantRoles(sql, u.id, roles)
    return u
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = await mkdtemp(join(tmpdir(), 'ov-transport-'))
    await writeFile(join(storageRoot, '.ovdata'), '')
    statusDir = await mkdtemp(join(tmpdir(), 'ov-transport-status-'))
    await writeFile(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url, STORAGE_ROOT: storageRoot, STATUS_DIR: statusDir, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1', STORAGE_SCORESHEETS_MIN_FREE_MB: '1', STORAGE_BACKUP_ACCOUNT_MAX_MB: '0.001'
    })
  })
  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
    if (statusDir) await rm(statusDir, { recursive: true, force: true })
  })

  it('approvals, the approval PIN and the test mail count in counters of their own', async () => {
    const u = await account('counters', ['scorer'])
    for (let i = 0; i < 11; i++) {
      const r = await api(srv.base, '/api/approvals', { method: 'GET', token: u.token, proto: null })
      assert.notEqual(r.status, 429, r.text)
    }
    const mail = await api(srv.base, '/api/scoresheet/test-mail', { token: u.token, body: { pdf: Buffer.from('%PDF-1.4').toString('base64') } })
    assert.notEqual(mail.status, 429, mail.text)
  })

  it('an anonymous read counts at most 1000 rows and scans at most 100 events; a match by its id reads them all', async () => {
    await sql.query('SET session_replication_role = replica')
    let matchId
    try {
      matchId = (await sql.query("INSERT INTO public.matches (external_id, status) VALUES ($1, 'live') RETURNING id", [`match_${randomBytes(4).toString('hex')}`])).rows[0].id
      await sql.query(`INSERT INTO public.events (external_id, match_id, set_index, type, seq, ts)
        SELECT 'ev_' || $2 || '_' || g, $1, 1, 'point', g, now() FROM generate_series(1, 1200) g`, [matchId, randomBytes(3).toString('hex')])
    } finally {
      await sql.query('SET session_replication_role = origin')
    }
    const anon = (params) => api(srv.base, '/api/db', { headers: { 'cf-connecting-ip': '198.51.100.90' }, proto: null, body: { table: 'events', action: 'select', params } })
    const counted = await anon({ columns: 'id', count: true, limit: 1 })
    assert.equal(counted.status, 200, counted.text)
    assert.equal(counted.json.count, 1000)
    const scan = await anon({ columns: 'id' })
    assert.equal(scan.json.data.length, 100)
    const one = await anon({ columns: 'id', filters: [{ type: 'eq', column: 'match_id', value: matchId }] })
    assert.equal(one.json.data.length, 1000)
    // an account without a role (anyone may sign up) reads like an anonymous caller
    const none = await account('noroles', null)
    const roleless = (params) => api(srv.base, '/api/db', { token: none.token, proto: null, body: { table: 'events', action: 'select', params } })
    const rolelessCount = await roleless({ columns: '*', count: true, limit: 1 })
    assert.equal(rolelessCount.status, 200, rolelessCount.text)
    assert.equal(rolelessCount.json.count, 1000)
    assert.equal((await roleless({ columns: '*' })).json.data.length, 100)
    // a signed-in reader with a role gets the exact count
    const u = await account('reader', ['scorer'])
    const exact = await api(srv.base, '/api/db', { token: u.token, proto: null, body: { table: 'events', action: 'select', params: { columns: '*', count: true, limit: 1, filters: [{ type: 'eq', column: 'match_id', value: matchId }] } } })
    assert.equal(exact.status, 200, exact.text)
    assert.equal(exact.json.count, 1200)
  })

  it("a scorer whose room the database proved is not held back by its address's budget for large frames", async () => {
    const room = `match_${randomBytes(4).toString('hex')}`
    await sql.query('SET session_replication_role = replica')
    try {
      await sql.query("INSERT INTO public.matches (external_id, status, game_pin) VALUES ($1, 'live', '987654')", [room])
    } finally {
      await sql.query('SET session_replication_role = origin')
    }
    const hall = { 'cf-connecting-ip': '198.51.100.140' }
    const sockets = []
    try {
      // sockets of the hall's address that own made-up rooms spend its budget
      for (let s = 0; s < 3; s++) {
        const c = await openSocket(srv.wsUrl, { headers: hall })
        sockets.push(c)
        c.send(syncMessage(`made-up-${room}-${s}`))
        c.send({ type: 'ping' })
        await received(c, 'pong', 1)
      }
      const spent = await flood(sockets, LARGE_FRAME, 25)
      assert.equal(spent.pongs, Math.floor(MAX_RELAY_ROOM_ADDRESS_BYTES / LARGE_FRAME.length), JSON.stringify(spent))
      // the match's scorer proves its game PIN against the database row
      const scorer = await openSocket(srv.wsUrl, { headers: hall })
      sockets.push(scorer)
      scorer.send(syncMessage(room))
      scorer.send({ type: 'ping' })
      await received(scorer, 'pong', 1)
      assert.deepEqual(scorer.messages.filter((m) => m.type === 'error'), [])
      assert.deepEqual(await flood([scorer], LARGE_FRAME, 10), { pongs: 10, refused: 0, closed: 0 })
    } finally {
      for (const c of sockets) c.ws.terminate()
    }
  })

  it('backups need an account with a role, and one account holds at most its total', async () => {
    const none = await account('norole', null)
    const file = Buffer.from(JSON.stringify({ match: { gameN: 1 }, pad: 'x'.repeat(600) })).toString('base64')
    const up = (u, path) => api(srv.base, '/api/storage/upload', { token: u.token, body: { bucket: 'backup', path, fileBase64: file, contentType: 'application/json' } })
    const refused = await up(none, 'backups/backup_g1/a.json')
    assert.equal(refused.status, 403, refused.text)
    assert.equal(refused.json.error.code, 'OV_STORAGE_FORBIDDEN')
    // reading its own folder still works
    assert.equal((await api(srv.base, '/api/storage/list', { token: none.token, body: { bucket: 'backup', path: '' } })).status, 200)
    const scorer = await account('backer', ['scorer'])
    assert.equal((await up(scorer, 'backups/backup_g1/a.json')).status, 200)
    // STORAGE_BACKUP_ACCOUNT_MAX_MB=0.001 (about 1 KB)
    const full = await up(scorer, 'backups/backup_g1/b.json')
    assert.equal(full.status, 507, full.text)
    assert.equal(full.json.error.code, 'OV_STORAGE_ACCOUNT_FULL')
  })
})
