/**
 * Shared helpers of the end-to-end suites that boot server.js against a real
 * Postgres (see tests/server.e2e.test.js for the PG_TEST_URL / OV_E2E_DOCKER
 * switches). A copy of that file's helpers, exported.
 */
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
import { createDatabase, testSchemaSql } from './pgTestDb.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = resolve(HERE, '..', '..')
const SESSIONS_SQL = readFileSync(join(BACKEND_DIR, 'db', '002_app_sessions.sql'), 'utf8')

export const PG_TEST_URL = process.env.PG_TEST_URL || process.env.TEST_DATABASE_URL || ''
export const USE_DOCKER = !PG_TEST_URL && process.env.OV_E2E_DOCKER === '1'
export const SKIP = PG_TEST_URL || USE_DOCKER ? false : 'PG_TEST_URL not set (or OV_E2E_DOCKER=1 for a throwaway container)'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function waitUntil(fn, { timeoutMs = 15000, intervalMs = 100, what = 'condition' } = {}) {
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
export async function bootServer(env, args = []) {
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

export async function api(base, path, { body, token, proto = '2', method = 'POST', headers = {} } = {}) {
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
export function openSocket(url) {
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

export async function subscribe(client, id, subs) {
  client.send({ type: 'subscribe-db', id, subs })
  const ack = await client.waitFor((m) => (m.type === 'subscribe-db-ack' || m.type === 'subscribe-db-error') && m.id === id, 5000, `ack ${id}`)
  assert.equal(ack.type, 'subscribe-db-ack', JSON.stringify(ack))
}

// ---------------------------------------------------------------------------
// Postgres: own container (OV_E2E_DOCKER=1) or a throwaway database in PG_TEST_URL
// ---------------------------------------------------------------------------

export async function provisionDatabase() {
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

