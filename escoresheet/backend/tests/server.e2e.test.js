/**
 * End-to-end test of the self-hosted (DATABASE_URL) backend: boots server.js
 * as a child process against a real Postgres and a temp STORAGE_ROOT, and
 * drives it over HTTP and WebSocket like the frontend does.
 *
 * Postgres source:
 *   PG_TEST_URL=postgres://...   use that server (a throwaway database is
 *                                created in it and dropped afterwards; CI)
 *   OV_E2E_DOCKER=1              start `docker run --rm postgres:17-alpine` on a
 *                                random port for this file; always stopped
 *   neither                      skipped
 *
 * The second suite boots server.js WITHOUT a database (--local) and checks the
 * LAN mode is unchanged: data endpoints 503, live sockets get the plain relay
 * hello (the frontend shim reads that as "realtime not supported").
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import WebSocket from 'ws'
import { createDatabase, testSchemaSql } from './helpers/pgTestDb.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = resolve(HERE, '..')
const SESSIONS_SQL = readFileSync(join(BACKEND_DIR, 'db', '002_app_sessions.sql'), 'utf8')

const PG_TEST_URL = process.env.PG_TEST_URL || process.env.TEST_DATABASE_URL || ''
const USE_DOCKER = !PG_TEST_URL && process.env.OV_E2E_DOCKER === '1'
const SKIP = PG_TEST_URL || USE_DOCKER ? false : 'PG_TEST_URL not set (or OV_E2E_DOCKER=1 for a throwaway container)'

// Every test value that must never reach a client.
const GAME_PIN = '864201'
const PINS = { referee: '531642', bench_home: '642753', bench_away: '753864', upload_home: '975310', upload_away: '097531' }
const containsSecret = (text) => [GAME_PIN, ...Object.values(PINS)].some((p) => text.includes(p))

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(fn, { timeoutMs = 15000, intervalMs = 100, what = 'condition' } = {}) {
  const start = Date.now()
  let lastErr
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) { lastErr = err }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}${lastErr ? `: ${lastErr.message}` : ''}`)
    await sleep(intervalMs)
  }
}

/** Starts `node server.js` with env; resolves once /health/live answers. */
async function bootServer(env, args = []) {
  const port = await freePort()
  const inherited = { ...process.env }
  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'POCKETBASE_URL', 'IS_CLOUD', 'TRUST_PROXY', 'TRUST_PROXY_FROM', 'BACKUP_MAX_AGE_HOURS', 'PG_TEST_URL', 'TEST_DATABASE_URL', 'DATABASE_URL']) delete inherited[k]
  const childEnv = { ...inherited, ...env, PORT: String(port) }
  const child = spawn(process.execPath, ['server.js', ...args], { cwd: BACKEND_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = []
  child.stdout.on('data', (d) => output.push(d.toString()))
  child.stderr.on('data', (d) => output.push(d.toString()))
  let exited = null
  child.on('exit', (code) => { exited = code })
  const base = `http://127.0.0.1:${port}`
  try {
    await waitUntil(async () => {
      if (exited !== null) throw new Error(`server exited with ${exited}`)
      return (await fetch(`${base}/health/live`)).ok
    }, { what: 'server /health/live' })
  } catch (err) {
    child.kill('SIGKILL')
    throw new Error(`${err.message}\n--- server output ---\n${output.join('').slice(-4000)}`)
  }
  return {
    port,
    base,
    wsUrl: `ws://127.0.0.1:${port}`,
    output,
    async stop() {
      if (exited !== null) return
      const done = new Promise((r) => child.once('exit', r))
      child.kill('SIGTERM')
      const t = setTimeout(() => child.kill('SIGKILL'), 5000)
      await done
      clearTimeout(t)
    }
  }
}

async function api(base, path, { body, token, proto = '2', method = 'POST', headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers }
  if (token) h.Authorization = `Bearer ${token}`
  if (proto != null) h['X-OV-Proto'] = proto
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers }
}

/** A WebSocket client that records every message. */
function openSocket(url) {
  return new Promise((resolveOpen, rejectOpen) => {
    const ws = new WebSocket(url)
    const client = { ws, messages: [], raw: [] }
    client.send = (m) => ws.send(JSON.stringify(m))
    client.waitFor = (pred, timeoutMs = 5000, what = 'message') => new Promise((ok, fail) => {
      const found = client.messages.find(pred)
      if (found) return ok(found)
      const timer = setTimeout(() => {
        ws.off('message', check)
        fail(new Error(`timed out waiting for ${what}; got ${JSON.stringify(client.messages.map((m) => m.type))}`))
      }, timeoutMs)
      const check = () => {
        const m = client.messages.find(pred)
        if (m) {
          clearTimeout(timer)
          ws.off('message', check)
          ok(m)
        }
      }
      ws.on('message', check)
    })
    ws.on('message', (data) => {
      const text = data.toString()
      client.raw.push(text)
      try { client.messages.push(JSON.parse(text)) } catch { /* ignore */ }
    })
    ws.once('open', () => client.waitFor((m) => m.type === 'connected', 5000, 'hello').then(() => resolveOpen(client), rejectOpen))
    ws.once('error', rejectOpen)
  })
}

async function subscribe(client, id, subs) {
  client.send({ type: 'subscribe-db', id, subs })
  const ack = await client.waitFor((m) => (m.type === 'subscribe-db-ack' || m.type === 'subscribe-db-error') && m.id === id, 5000, `ack ${id}`)
  assert.equal(ack.type, 'subscribe-db-ack', JSON.stringify(ack))
}

// ---------------------------------------------------------------------------
// Postgres: own container (OV_E2E_DOCKER=1) or a throwaway database in PG_TEST_URL
// ---------------------------------------------------------------------------

async function provisionDatabase() {
  let containerId = null
  let adminUrl = PG_TEST_URL
  const cleanup = []
  if (USE_DOCKER) {
    containerId = execFileSync('docker', ['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=test', '-p', '127.0.0.1:0:5432', 'postgres:17-alpine'], { encoding: 'utf8' }).trim()
    const stopContainer = () => { try { execFileSync('docker', ['stop', '-t', '2', containerId], { stdio: 'ignore' }) } catch { /* already gone */ } }
    // Belt and braces: stop it even if the test process dies before after().
    process.once('exit', stopContainer)
    cleanup.push(stopContainer)
    const hostPort = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' }).trim().split('\n')[0].split(':').pop()
    adminUrl = `postgres://postgres:test@127.0.0.1:${hostPort}/postgres`
    await waitUntil(async () => {
      const c = new pg.Client({ connectionString: adminUrl })
      try { await c.connect(); await c.query('SELECT 1'); return true } finally { await c.end().catch(() => {}) }
    }, { timeoutMs: 60000, intervalMs: 500, what: 'postgres container' })
  }
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  const name = `ov_e2e_${process.pid}_${Date.now().toString(36)}`
  try {
    await createDatabase(admin, name, { useTemplate: !USE_DOCKER })
  } catch (err) {
    await admin.end().catch(() => {})
    throw err
  }
  cleanup.unshift(async () => {
    try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end().catch(() => {}) }
  })
  const url = new URL(adminUrl)
  url.pathname = '/' + name
  const c = new pg.Client({ connectionString: url.toString() })
  await c.connect()
  try {
    await c.query(testSchemaSql({ useTemplate: !USE_DOCKER }))
    await c.query(SESSIONS_SQL)
  } finally { await c.end() }
  return {
    url: url.toString(),
    async drop() {
      for (const fn of cleanup) {
        try { await fn() } catch { /* best effort */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DATABASE_URL mode
// ---------------------------------------------------------------------------

describe('server.js with DATABASE_URL (self-hosted cloud mode)', { skip: SKIP }, () => {
  let db
  let srv
  let storageRoot
  let statusDir
  let token
  let userId
  let live
  const ext = `e2e-${randomBytes(4).toString('hex')}`
  const email = `e2e-${randomBytes(4).toString('hex')}@example.ch`
  const password = 'correct-horse-battery'
  let matchUuid

  before(async () => {
    db = await provisionDatabase()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-e2e-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-e2e-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date(Date.now() - 5 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      // the e2e client is the "proxy": cf-connecting-ip picks the client address
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      // the test machine's free space must not decide the floor check
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
      PUBLIC_ORIGINS: 'https://staging.example.test'
    })
  })

  after(async () => {
    try { live?.ws.close() } catch { /* ignore */ }
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('/health reports db, catalog, sentinel, floor and backup age', async () => {
    const h = await waitUntil(async () => {
      const r = await api(srv.base, '/health', { method: 'GET', proto: null })
      return r.status === 200 ? r : null
    }, { what: '/health 200' })
    assert.equal(h.json.db, 'ok')
    assert.equal(h.json.catalog.ok, true)
    assert.equal(h.json.catalog.tables, 9)
    assert.equal(h.json.sentinel, 'ok')
    assert.equal(h.json.floor, 'ok')
    assert.equal(h.json.storageWritable, true)
    assert.equal(typeof h.json.diskFreeMB, 'number')
    assert.ok(h.json.lastBackupAgeMin >= 4 && h.json.lastBackupAgeMin <= 10, String(h.json.lastBackupAgeMin))
    assert.deepEqual(Object.keys(h.json.connections).sort(), ['live', 'role'])
    assert.equal(h.json.backup, 'ok')
    const liveness = await api(srv.base, '/health/live', { method: 'GET', proto: null })
    assert.equal(liveness.status, 200)
    assert.equal(liveness.json.status, 'ok')
    // Through a proxy (cloudflared / Traefik headers): the verdict only.
    for (const headers of [{ 'cf-connecting-ip': '203.0.113.9' }, { 'X-Forwarded-For': '203.0.113.9' }]) {
      const pub = await api(srv.base, '/health', { method: 'GET', proto: null, headers })
      assert.equal(pub.status, 200)
      assert.deepEqual(Object.keys(pub.json).sort(), ['backup', 'db', 'mode', 'status'])
    }
  })

  it('/health goes 503 (backup: stale) when the host backup is older than 36 h, and back', async () => {
    const stamp = (ageMin) => writeFileSync(join(statusDir, 'last_backup'), new Date(Date.now() - ageMin * 60000).toISOString() + '\n')
    try {
      stamp(37 * 60)
      const stale = await waitUntil(async () => {
        const r = await api(srv.base, '/health', { method: 'GET', proto: null })
        return r.status === 503 ? r : null
      }, { what: '/health 503' })
      assert.equal(stale.json.backup, 'stale')
      assert.equal(stale.json.status, 'degraded')
      rmSync(join(statusDir, 'last_backup'))
      const unknown = await waitUntil(async () => {
        const r = await api(srv.base, '/health', { method: 'GET', proto: null })
        return r.json?.backup === 'unknown' ? r : null
      }, { what: '/health backup unknown' })
      assert.equal(unknown.status, 503)
    } finally {
      stamp(5)
    }
    await waitUntil(async () => (await api(srv.base, '/health', { method: 'GET', proto: null })).status === 200, { what: '/health 200 again' })
  })

  it('CORS preflight allows X-OV-Proto; PUBLIC_ORIGINS is trusted; the removed rpc is 404', async () => {
    const pre = await fetch(`${srv.base}/api/db`, { method: 'OPTIONS', headers: { Origin: 'https://staging.example.test', 'Access-Control-Request-Headers': 'x-ov-proto' } })
    assert.match(pre.headers.get('access-control-allow-headers'), /X-OV-Proto/)
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://staging.example.test')
    assert.equal(pre.headers.get('access-control-allow-credentials'), 'true')
    const csp = pre.headers.get('content-security-policy')
    assert.doesNotMatch(csp, /supabase/)
    const rpc = await api(srv.base, '/api/db/rpc', { body: { fn: 'delete_user' } })
    assert.equal(rpc.status, 404)
  })

  it('signs up, then signs in with an opaque session token', async () => {
    const up = await api(srv.base, '/api/auth/sign-up', { body: { email, password, metadata: { first_name: 'E2E', roles: ['admin'] } } })
    assert.equal(up.status, 200, up.text)
    assert.equal(up.json.data.user.email, email)
    assert.equal(up.json.data.session, undefined)
    const bad = await api(srv.base, '/api/auth/sign-in', { body: { email, password: 'wrong-password' } })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error.code, 'invalid_credentials')
    const inn = await api(srv.base, '/api/auth/sign-in', { body: { email: email.toUpperCase(), password } })
    assert.equal(inn.status, 200, inn.text)
    token = inn.json.data.session.access_token
    userId = inn.json.data.user.id
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(typeof inn.json.data.session.expires_at, 'number')
    const me = await api(srv.base, '/api/auth/get-user', { body: { access_token: token } })
    assert.equal(me.status, 200)
    assert.equal(me.json.data.user.id, userId)
    const profile = await api(srv.base, '/api/auth/profile', { body: { access_token: token } })
    assert.equal(profile.status, 200)
    assert.deepEqual(profile.json.data.roles, ['scorer'], 'sign-up cannot self-assign roles')
  })

  it('a purpose=live socket gets the live hello', async () => {
    live = await openSocket(`${srv.wsUrl}/?purpose=live`)
    const hello = live.messages[0]
    assert.equal(hello.mode, 'live')
    assert.equal(hello.protocol, 1)
    await subscribe(live, 'match', [{ table: 'matches', event: '*', column: 'external_id', value: ext }])
    // secret columns can never be a filter
    live.send({ type: 'subscribe-db', id: 'pin', subs: [{ table: 'matches', event: '*', column: 'game_pin', value: GAME_PIN }] })
    const err = await live.waitFor((m) => m.id === 'pin')
    assert.equal(err.type, 'subscribe-db-error')
  })

  it('writes need a session and X-OV-Proto >= 2', async () => {
    const row = { external_id: ext, game_n: 4711 }
    const anon = await api(srv.base, '/api/db', { body: { table: 'matches', action: 'upsert', params: { data: row, onConflict: 'external_id' } } })
    assert.equal(anon.status, 401)
    const old = await api(srv.base, '/api/db', { token, proto: null, body: { table: 'matches', action: 'upsert', params: { data: row, onConflict: 'external_id' } } })
    assert.equal(old.status, 426)
    assert.equal(old.json.error.code, 'OV_CLIENT_TOO_OLD')
    const bogus = await api(srv.base, '/api/db', { token: 'x'.repeat(43), body: { table: 'matches', action: 'upsert', params: { data: row } } })
    assert.equal(bogus.status, 401)
    assert.equal(bogus.json.error.code, 'invalid_token')
  })

  it('logs rejected /api/db writes with status, code, table, action and request id, never values', async () => {
    const row = { external_id: ext, game_n: 4711, game_pin: GAME_PIN }
    const anon = await api(srv.base, '/api/db', { body: { table: 'matches', action: 'upsert', params: { data: row, onConflict: 'external_id' } } })
    const old = await api(srv.base, '/api/db', { token, proto: null, body: { table: 'matches', action: 'upsert', params: { data: row, onConflict: 'external_id' } } })
    const anonId = anon.headers.get('x-request-id')
    const oldId = old.headers.get('x-request-id')
    // a malformed Authorization header is answered (and logged) as missing_token
    const malformed = await api(srv.base, '/api/db', { headers: { Authorization: 'Bearer' }, body: { table: 'matches', action: 'upsert', params: { data: row, onConflict: 'external_id' } } })
    assert.equal(malformed.json.error.code, 'missing_token')
    const malformedId = malformed.headers.get('x-request-id')
    assert.match(anonId, /^[0-9a-f]{12}$/)
    assert.match(anon.headers.get('access-control-expose-headers') || '', /X-Request-Id/i)
    await waitUntil(() => srv.output.join('').includes(`req=${oldId}`) && srv.output.join('').includes(`req=${malformedId}`), { what: 'rejection log line' })
    const log = srv.output.join('')
    assert.match(log, new RegExp(`\\[DB\\] rejected req=${anonId} status=401 code=missing_token table=matches action=upsert`))
    assert.match(log, new RegExp(`\\[DB\\] rejected req=${malformedId} status=401 code=missing_token table=matches action=upsert`))
    assert.match(log, new RegExp(`\\[DB\\] rejected req=${oldId} status=426 code=OV_CLIENT_TOO_OLD table=matches action=upsert`))
    assert.equal(containsSecret(log), false, 'a PIN reached the server log')
    assert.equal(log.includes(token), false, 'a session token reached the server log')
    assert.equal(log.includes(ext), false, 'a row value reached the server log')
  })

  it('upserts a match through /api/db and publishes it without secrets', async () => {
    const r = await api(srv.base, '/api/db', {
      token,
      body: {
        table: 'matches',
        action: 'upsert',
        params: {
          data: {
            external_id: ext,
            game_n: 4711,
            game_pin: GAME_PIN,
            connection_pins: PINS,
            connections: { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: false },
            status: 'live',
            sport_type: 'indoor',
            home_team: { name: 'Home VC', color: '#ff0000' },
            away_team: { name: 'Away VC' },
            scheduled_at: new Date().toISOString()
          },
          onConflict: 'external_id',
          returning: '*',
          single: true
        }
      }
    })
    assert.equal(r.status, 200, r.text)
    matchUuid = r.json.data.id
    assert.match(matchUuid, /^[0-9a-f-]{36}$/)
    assert.equal(containsSecret(r.text), false, 'write response leaks a PIN')
    const change = await live.waitFor((m) => m.type === 'db-change' && m.table === 'matches' && m.new?.external_id === ext, 5000, 'matches db-change')
    assert.equal(change.eventType, 'INSERT')
    assert.equal(change.new.id, matchUuid)
    assert.equal('game_pin' in change.new, false)
    assert.equal('connection_pins' in change.new, false)

    // A JSON merge keeps the other PINs (connection_pins is a merge column)
    const merge = await api(srv.base, '/api/db', {
      token,
      body: { table: 'matches', action: 'update', params: { data: { connections: { away_bench_enabled: true } }, filters: [{ type: 'eq', column: 'external_id', value: ext }] } }
    })
    assert.equal(merge.status, 200, merge.text)
    await live.waitFor((m) => m.type === 'db-change' && m.table === 'matches' && m.eventType === 'UPDATE', 5000, 'matches UPDATE')
  })

  it('inserts a set and an event with namespaced external_ids; live subscribers get them', async () => {
    await subscribe(live, 'children', [
      { table: 'sets', event: '*', column: 'match_id', value: matchUuid },
      { table: 'events', event: 'INSERT', column: 'match_id', value: matchUuid }
    ])
    const set = await api(srv.base, '/api/db', {
      token,
      body: { table: 'sets', action: 'upsert', params: { data: { external_id: `${ext}:s:1`, match_id: matchUuid, index: 1, home_points: 3, away_points: 1 }, onConflict: 'external_id', returning: 'id, external_id' } }
    })
    assert.equal(set.status, 200, set.text)
    const ev = await api(srv.base, '/api/db', {
      token,
      body: { table: 'events', action: 'insert', params: { data: { external_id: `${ext}:e:1`, match_id: matchUuid, set_index: 1, type: 'point', seq: 1, payload: { team: 'home' } } } }
    })
    assert.equal(ev.status, 200, ev.text)
    const sc = await live.waitFor((m) => m.type === 'db-change' && m.table === 'sets', 5000, 'sets db-change')
    assert.equal(sc.new.external_id, `${ext}:s:1`)
    const ec = await live.waitFor((m) => m.type === 'db-change' && m.table === 'events', 5000, 'events db-change')
    assert.equal(ec.new.external_id, `${ext}:e:1`)
    assert.equal('game_pin' in ec.new, false)

    // A bare (pre-namespacing) id cannot attach to this match
    const bare = await api(srv.base, '/api/db', {
      token,
      body: { table: 'sets', action: 'insert', params: { data: { external_id: '1', match_id: matchUuid, index: 2 } } }
    })
    assert.equal(bare.status, 400)
    assert.equal(bare.json.error.code, 'OV_UNSCOPED_EXTERNAL_ID')
  })

  it('anonymous selects never return or filter on game_pin / connection_pins', async () => {
    const all = await api(srv.base, '/api/db', { proto: null, body: { table: 'matches', action: 'select', params: { columns: '*', filters: [{ type: 'eq', column: 'external_id', value: ext }] } } })
    assert.equal(all.status, 200)
    assert.equal(all.json.data.length, 1)
    assert.equal(containsSecret(all.text), false)
    const named = await api(srv.base, '/api/db', { proto: null, body: { table: 'matches', action: 'select', params: { columns: 'id, game_pin, connection_pins', filters: [{ type: 'eq', column: 'external_id', value: ext }] } } })
    assert.equal(named.status, 200)
    assert.equal(containsSecret(named.text), false)
    assert.deepEqual(Object.keys(named.json.data[0]), ['id'])
    for (const filter of [
      { type: 'eq', column: 'game_pin', value: GAME_PIN },
      { type: 'like', column: 'game_pin', value: '8*' },
      { type: 'eq', column: 'connection_pins->>referee', value: PINS.referee }
    ]) {
      const r = await api(srv.base, '/api/db', { proto: null, body: { table: 'matches', action: 'select', params: { columns: 'id', filters: [filter] } } })
      assert.equal(r.status, 400, JSON.stringify(filter))
      assert.equal(r.json.error.code, 'OV_SECRET_FILTER')
    }
    const order = await api(srv.base, '/api/db', { proto: null, body: { table: 'matches', action: 'select', params: { columns: 'id', order: [{ column: 'game_pin', ascending: true }] } } })
    assert.equal(order.status, 400)
    const embed = await api(srv.base, '/api/db', { proto: null, body: { table: 'match_live_state', action: 'select', params: { columns: '*, matches!match_live_state_match_id_fkey_cascade(set_results)' } } })
    assert.equal(embed.status, 200, embed.text)
    // owner-scoped tables need a session
    const prof = await api(srv.base, '/api/db', { proto: null, body: { table: 'profiles', action: 'select', params: {} } })
    assert.equal(prof.status, 401)
    const mine = await api(srv.base, '/api/db', { token, proto: null, body: { table: 'profiles', action: 'select', params: { columns: 'user_id' } } })
    assert.equal(mine.status, 200)
    assert.deepEqual(mine.json.data, [{ user_id: userId }])
  })

  it('validates connection PINs server-side without returning them', async () => {
    const ok = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, body: { pin: PINS.referee, type: 'referee' } })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.success, true)
    assert.equal(ok.json.match.id, ext)
    assert.equal(ok.json.match.homeTeam, 'Home VC')
    assert.equal(containsSecret(ok.text), false)
    const bench = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, body: { pin: PINS.bench_away, type: 'bench_away' } })
    assert.equal(bench.status, 200, 'the merged connections flag enabled the away bench')
    const wrong = await api(srv.base, '/api/match/validate-connection-pin', { proto: null, body: { pin: '000000', type: 'referee' } })
    assert.equal(wrong.status, 404)
  })

  it('limits FAILED connection-PIN guesses per IPv6 /64 (20 per 10 min); successes are refunded', async () => {
    const pinCall = (ip, pin, type) => api(srv.base, '/api/match/validate-connection-pin', {
      proto: null, headers: { 'cf-connecting-ip': ip }, body: { pin, type }
    })
    // Successes do not use the failure budget.
    for (let i = 0; i < 5; i++) assert.equal((await pinCall('2001:db8:1:2::5', PINS.referee, 'referee')).status, 200)
    // 20 failures from two addresses of the same /64 (two PIN types: the
    // per-type bucket is 20 per minute on its own).
    for (let i = 0; i < 10; i++) {
      assert.equal((await pinCall(`2001:db8:1:2::${i + 10}`, '000000', 'referee')).status, 404)
      assert.equal((await pinCall(`2001:db8:1:2:ffff::${i + 1}`, '000001', 'bench_home')).status, 404)
    }
    // The /64 is out of guesses, even with the right PIN and a fresh address.
    const blocked = await pinCall('2001:db8:1:2:abcd::1', PINS.bench_away, 'bench_away')
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers.get('retry-after'), '600')
    // Another /64 is unaffected.
    assert.equal((await pinCall('2001:db8:1:3::1', PINS.bench_away, 'bench_away')).status, 200)
  })

  it('restore-by-pin returns the match, sets, events and live state (no secrets)', async () => {
    const wrong = await api(srv.base, '/api/match/restore-by-pin', { proto: null, body: { gameN: 4711, pin: '000000' } })
    assert.equal(wrong.status, 404)
    assert.equal(wrong.json.error.code, 'OV_NOT_FOUND')
    const r = await api(srv.base, '/api/match/restore-by-pin', { proto: null, body: { gameN: '4711', pin: GAME_PIN } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.match.id, matchUuid)
    assert.equal(r.json.data.sets.length, 1)
    assert.equal(r.json.data.events.length, 1)
    assert.equal(containsSecret(r.text), false)
  })

  it('/api/match/restore replaces the children in one transaction and publishes the changes', async () => {
    await subscribe(live, 'restore-live', [{ table: 'match_live_state', event: '*', column: 'match_id', value: matchUuid }])
    const before = live.messages.length
    const body = {
      match: { external_id: ext, game_n: 4711, status: 'live', sport_type: 'indoor', game_pin: '' },
      sets: [1, 2].map((n) => ({ external_id: `${ext}:s:${n}`, index: n, home_points: 25, away_points: 20 + n, finished: true })),
      events: [1, 2, 3].map((n) => ({ external_id: `${ext}:e:${n}`, set_index: 1, type: 'point', seq: n })),
      liveState: { status: 'live', points_a: 1, points_b: 0, current_set: 3, updated_at: new Date().toISOString() }
    }
    const anon = await api(srv.base, '/api/match/restore', { body })
    assert.equal(anon.status, 401)
    const r = await api(srv.base, '/api/match/restore', { token, body })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.id, matchUuid)
    assert.deepEqual(r.json.data.counts, { sets: 2, events: 3, liveState: 1 })
    const ls = await live.waitFor((m, i) => m.type === 'db-change' && m.table === 'match_live_state' && m.eventType === 'INSERT', 5000, 'live state INSERT')
    assert.equal(ls.new.match_status, 'live', 'legacy `status` was renamed')
    assert.ok(live.messages.slice(before).some((m) => m.type === 'db-change' && m.table === 'sets' && m.eventType === 'DELETE'))
    // An empty game_pin kept the stored PIN
    const again = await api(srv.base, '/api/match/restore-by-pin', { proto: null, body: { gameN: 4711, pin: GAME_PIN } })
    assert.equal(again.status, 200)
    assert.equal(again.json.data.events.length, 3)
    // One bad event rolls everything back
    const bad = await api(srv.base, '/api/match/restore', { token, body: { ...body, events: [...body.events, { external_id: 'other-match:e:9', seq: 9 }] } })
    assert.equal(bad.status, 400)
    const still = await api(srv.base, '/api/match/restore-by-pin', { proto: null, body: { gameN: 4711, pin: GAME_PIN } })
    assert.equal(still.json.data.events.length, 3)
  })

  it('relay live-state-update from the scoreboard reaches live subscribers as a match_live_state UPDATE', async () => {
    const scoreboard = await openSocket(srv.wsUrl)
    try {
      assert.notEqual(scoreboard.messages[0].mode, 'live')
      scoreboard.send({ type: 'sync-match-data', matchId: 7, match: { id: 7, seed_key: ext, gamePin: GAME_PIN, status: 'live' }, homeTeam: { name: 'Home VC' }, awayTeam: { name: 'Away VC' }, sets: [], events: [] })
      scoreboard.send({ type: 'ping' })
      await scoreboard.waitFor((m) => m.type === 'pong')
      scoreboard.send({ type: 'live-state-update', matchId: 7, liveState: { points_a: 7, points_b: 5, match_id: matchUuid, updated_at: new Date(Date.now() + 1000).toISOString() } })
      const u = await live.waitFor((m) => m.type === 'db-change' && m.table === 'match_live_state' && m.eventType === 'UPDATE' && m.new.points_a === 7, 5000, 'relayed live state')
      assert.equal(u.new.match_id, matchUuid)
      assert.equal(u.new.sport_type, 'indoor', 'carried from the matches row')
      assert.equal(containsSecret(scoreboard.raw.join('')), false)
    } finally {
      scoreboard.ws.close()
    }
  })

  it('storage: upload, list, download; signed-url is gone; auth required', async () => {
    const content = JSON.stringify({ hello: 'wörld', n: 1 })
    const fileBase64 = Buffer.from(content, 'utf8').toString('base64')
    const anon = await api(srv.base, '/api/storage/upload', { body: { bucket: 'scoresheets', path: '2026-10-05/game4711_final.json', fileBase64, contentType: 'application/json' } })
    assert.equal(anon.status, 401)
    const up = await api(srv.base, '/api/storage/upload', { token, body: { bucket: 'scoresheets', path: '2026-10-05/game4711_final.json', fileBase64, contentType: 'application/json', upsert: true } })
    assert.equal(up.status, 200, up.text)
    assert.equal(up.json.data.path, '2026-10-05/game4711_final.json')
    const list = await api(srv.base, '/api/storage/list', { token, body: { bucket: 'scoresheets', path: '2026-10-05' } })
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.data.map((f) => f.name), ['game4711_final.json'])
    const down = await api(srv.base, '/api/storage/download', { token, body: { bucket: 'scoresheets', path: '2026-10-05/game4711_final.json' } })
    assert.equal(down.status, 200)
    assert.equal(Buffer.from(down.json.data, 'base64').toString('utf8'), content)
    assert.equal(readFileSync(join(storageRoot, 'scoresheets', '2026-10-05', 'game4711_final.json'), 'utf8'), content)
    const signed = await api(srv.base, '/api/storage/signed-url', { token, body: { bucket: 'scoresheets', path: '2026-10-05/game4711_final.json' } })
    assert.equal(signed.status, 404)
    const escape = await api(srv.base, '/api/storage/download', { token, body: { bucket: 'scoresheets', path: '../.ovdata' } })
    assert.equal(escape.status, 400)
    // An oversized body gets its 413 (not a reset connection)
    const big = await api(srv.base, '/api/storage/upload', { token, body: { bucket: 'backup', path: 'big.json', fileBase64: 'A'.repeat(8 * 1024 * 1024), contentType: 'application/json' } })
    assert.equal(big.status, 413)
    assert.equal(big.json.error.code, 'OV_STORAGE_TOO_LARGE')
  })

  it('sign-out revokes the session', async () => {
    const out = await api(srv.base, '/api/auth/sign-out', { body: { access_token: token } })
    assert.equal(out.status, 200)
    const me = await api(srv.base, '/api/auth/get-user', { body: { access_token: token } })
    assert.equal(me.status, 401)
    assert.equal(me.json.error.code, 'invalid_token')
    const write = await api(srv.base, '/api/db', { token, body: { table: 'matches', action: 'update', params: { data: { status: 'final' }, filters: [{ type: 'eq', column: 'external_id', value: ext }] } } })
    assert.equal(write.status, 401)
  })

  it('never logged a PIN', () => {
    assert.equal(containsSecret(srv.output.join('')), false)
  })
})

// ---------------------------------------------------------------------------
// LAN mode: no DATABASE_URL (also --local with one set)
// ---------------------------------------------------------------------------

describe('server.js without a database (LAN relay mode)', () => {
  let srv

  before(async () => {
    // A DATABASE_URL that would fail if it were used: --local must ignore it.
    srv = await bootServer({ DATABASE_URL: 'postgres://127.0.0.1:1/none' }, ['--local'])
  })

  after(async () => {
    await srv?.stop()
  })

  it('answers /health and /health/live without a database', async () => {
    const live = await api(srv.base, '/health/live', { method: 'GET', proto: null })
    assert.equal(live.status, 200)
    const h = await api(srv.base, '/health', { method: 'GET', proto: null })
    assert.equal(h.status, 200)
    assert.equal(h.json.status, 'healthy')
    assert.equal(h.json.mode, 'local')
    assert.equal(h.json.db, undefined)
  })

  it('data endpoints answer 503', async () => {
    for (const path of ['/api/db', '/api/auth/sign-in', '/api/storage/list', '/api/match/restore', '/api/match/restore-by-pin', '/api/match/validate-connection-pin']) {
      const r = await api(srv.base, path, { body: {} })
      assert.equal(r.status, 503, path)
    }
  })

  it('cf-connecting-ip is ignored unless the peer is inside TRUST_PROXY_FROM', async () => {
    // validate-connection-pin checks its per-IP bucket (60/min) before the 503.
    const outside = await bootServer({ TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '10.0.0.0/8' }, ['--local'])
    try {
      const statuses = []
      for (let i = 0; i < 61; i++) {
        const r = await api(outside.base, '/api/match/validate-connection-pin', { body: {}, headers: { 'cf-connecting-ip': `198.51.100.${i + 1}` } })
        statuses.push(r.status)
      }
      assert.equal(statuses.at(-1), 429, 'all forged addresses share the socket peer bucket')
    } finally {
      await outside.stop()
    }
    const inside = await bootServer({ TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.0/8' }, ['--local'])
    try {
      for (let i = 0; i < 61; i++) {
        const r = await api(inside.base, '/api/match/validate-connection-pin', { body: {}, headers: { 'cf-connecting-ip': `198.51.100.${i + 1}` } })
        assert.equal(r.status, 503)
      }
    } finally {
      await inside.stop()
    }
  })

  it('refuses to start with a bad TRUST_PROXY_FROM', async () => {
    const r = spawnSync(process.execPath, ['server.js', '--local'], {
      cwd: BACKEND_DIR,
      env: { PATH: process.env.PATH, PORT: '0', TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '10.0.0.0/33' },
      encoding: 'utf8',
      timeout: 10000
    })
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /TRUST_PROXY_FROM: invalid CIDR/)
  })

  it('a purpose=live socket gets the plain relay hello (realtime not supported)', async () => {
    const c = await openSocket(`${srv.wsUrl}/?purpose=live`)
    try {
      assert.equal(c.messages[0].type, 'connected')
      assert.equal(c.messages[0].mode, 'local')
      assert.ok(c.messages[0].clientId)
    } finally {
      c.ws.close()
    }
  })
})
