/**
 * /api/storage/* bodies (audit 2026-11-23 SEC-18): the body read had no idle
 * or total timeout and no concurrency gate, so a body that trickled held a
 * socket and its buffer until Node's 5-minute requestTimeout, as many at once
 * as an account opened. Now: an idle and a total timeout (408), a gate per
 * account and per process (503 OV_BUSY beyond its short queue). Also the
 * scoresheets bucket's refusal of a day folder far in the future (SEC-16).
 * OV_STORAGE_BODY_TEST_MS shortens the timeouts (tests only).
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const BODY_TEST_MS = 1500 // idle 1.5 s, total 3 s; an upload's floor rate after 1.5 s

describe('/api/storage/* bodies: timeouts and gates (SEC-18)', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot
  let ipSeq = 1
  const open = []

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
    await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery', metadata: { first_name: name, last_name: 'Test' } } })
    await sql.query('UPDATE auth.users SET email_confirmed_at = now() WHERE lower(email) = lower($1)', [email])
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery' } })
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
    if (roles) await grantRoles(sql, u.id, roles)
    return u
  }

  /** A request whose body never ends (or sends a byte every trickleMs): resolves to { status, ms }. */
  function slowBody (user, action, { contentLength = 100_000, trickleMs = 0, ip = '203.0.113.70' } = {}) {
    const u = new URL(srv.base)
    const t0 = Date.now()
    let timer = null
    const done = new Promise((resolve) => {
      const req = http.request({ host: u.hostname, port: u.port, path: `/api/storage/${action}`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(contentLength), Authorization: `Bearer ${user.token}`, 'cf-connecting-ip': ip } })
      req.on('response', (res) => {
        let text = ''
        res.on('data', (d) => { text += d })
        res.on('end', () => { clearInterval(timer); resolve({ status: res.statusCode, ms: Date.now() - t0, text }) })
      })
      req.on('error', () => { clearInterval(timer); resolve({ status: 0, ms: Date.now() - t0 }) })
      req.write('{"bucket":"backup","path":"')
      if (trickleMs) timer = setInterval(() => { try { req.write('a') } catch { /* closed */ } }, trickleMs)
      open.push(req)
    })
    return done
  }
  const download = (user, ip = '203.0.113.71') => api(srv.base, '/api/storage/download', { token: user.token, body: { bucket: 'backup', path: 'backups/none.json' }, headers: { 'cf-connecting-ip': ip } })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-storage-body-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    srv = await bootServer({
      DATABASE_URL: db.appUrl(), STORAGE_ROOT: storageRoot, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1', STORAGE_SCORESHEETS_MIN_FREE_MB: '1', OV_STORAGE_BODY_TEST_MS: String(BODY_TEST_MS)
    })
  })
  after(async () => {
    for (const r of open) r.destroy()
    await srv?.stop()
    await sql?.end()
    await db?.drop()
    rmSync(storageRoot, { recursive: true, force: true })
  })

  it('a body that goes silent is cut off after the idle time (408), not held for minutes', async () => {
    const user = await account('idle', ['scorer'])
    const r = await Promise.race([slowBody(user, 'download'), sleep(20_000).then(() => ({ status: 'still waiting' }))])
    assert.equal(r.status, 408)
    assert.ok(r.ms < 5 * BODY_TEST_MS, `${r.ms} ms`)
  })

  it('a body that trickles (a byte now and then, never idle) is cut off at the total time (408)', async () => {
    const user = await account('trickle', ['scorer'])
    const r = await Promise.race([slowBody(user, 'download', { trickleMs: 300 }), sleep(20_000).then(() => ({ status: 'still waiting' }))])
    assert.equal(r.status, 408)
    assert.ok(r.ms >= 2 * BODY_TEST_MS - 200 && r.ms < 6 * BODY_TEST_MS, `${r.ms} ms`)
  })

  it('one account holds 4 bodies and queues 16: the next gets 503 OV_BUSY at once; another account is not held up', async () => {
    const user = await account('many', ['scorer'])
    const other = await account('other', ['scorer'])
    const from = open.length
    const held = Array.from({ length: 20 }, () => slowBody(user, 'download', { trickleMs: 200, ip: '203.0.113.72' }))
    await sleep(400) // signed in and in the gate
    const t0 = Date.now()
    const busy = await download(user, '203.0.113.73')
    assert.equal(busy.status, 503, busy.text)
    assert.equal(busy.json.error.code, 'OV_BUSY')
    assert.equal(busy.headers.get('retry-after'), '5')
    assert.ok(Date.now() - t0 < 1000, 'refused at once')
    const fine = await download(other, '203.0.113.74')
    assert.equal(fine.status, 200, fine.text)
    assert.equal(fine.json.error.code, 'OV_STORAGE_NOT_FOUND')
    // the clients leave: their slots come back (the reading ones and the queued ones)
    for (const r of open.slice(from)) r.destroy()
    await Promise.all(held)
    await sleep(200)
    assert.equal((await download(user, '203.0.113.75')).status, 200)
  })

  it('four accounts trickling 20 uploads each hold their own slots only: a fifth account still uploads (GCS-R5)', async () => {
    // self-registered accounts, no role: the bucket is in the body, which they never finish
    const attackers = await Promise.all([0, 1, 2, 3].map((i) => account(`trickler${i}`, null)))
    const scorer = await account('fifth', ['scorer'])
    const from = open.length
    const held = attackers.flatMap((a, i) => Array.from({ length: 20 }, () => slowBody(a, 'upload', { contentLength: 6_800_000, trickleMs: 200, ip: `203.0.113.${90 + i}` })))
    await sleep(500) // signed in, in their gates
    // the attack is on: an attacker's next body is refused at once
    const extra = await api(srv.base, '/api/storage/upload', { token: attackers[0].token, body: { bucket: 'backup', path: 'x.json', fileBase64: 'e30=', contentType: 'application/json' }, headers: { 'cf-connecting-ip': '203.0.113.95' } })
    assert.equal(extra.status, 503, extra.text)
    // before the fix the 16 process slots were theirs: the fifth waited in the
    // process queue until their bodies timed out (in production 503 OV_BUSY
    // after 30 s, their uploads may trickle for 280 s); now it is served at once
    const t0 = Date.now()
    const up = await api(srv.base, '/api/storage/upload', { token: scorer.token, body: { bucket: 'backup', path: 'backups/fifth.json', fileBase64: Buffer.from('{"set":1}').toString('base64'), contentType: 'application/json' }, headers: { 'cf-connecting-ip': '203.0.113.96' } })
    assert.equal(up.status, 200, up.text)
    assert.ok(Date.now() - t0 < BODY_TEST_MS / 2, `the fifth waited ${Date.now() - t0} ms for the attackers' bodies`)
    const down = await api(srv.base, '/api/storage/download', { token: scorer.token, body: { bucket: 'backup', path: 'backups/fifth.json' }, headers: { 'cf-connecting-ip': '203.0.113.96' } })
    assert.equal(down.status, 200, down.text)
    for (const r of open.slice(from)) r.destroy()
    await Promise.all(held)
  })

  it('an upload that trickles is cut once it averages under the floor rate, before its total time (GCS-R5)', async () => {
    const user = await account('slowup', ['scorer'])
    const r = await Promise.race([slowBody(user, 'upload', { contentLength: 6_800_000, trickleMs: 200, ip: '203.0.113.97' }), sleep(20_000).then(() => ({ status: 'still waiting' }))])
    assert.equal(r.status, 408)
    assert.ok(r.ms >= BODY_TEST_MS - 200 && r.ms < 2 * BODY_TEST_MS - 300, `${r.ms} ms`)
  })

  it('a download, list or remove body is small (256 KiB at most); an upload keeps its own cap', async () => {
    const user = await account('small', ['scorer'])
    const big = await api(srv.base, '/api/storage/download', { token: user.token, body: { bucket: 'backup', path: 'x'.repeat(300 * 1024) }, headers: { 'cf-connecting-ip': '203.0.113.76' } })
    assert.equal(big.status, 413)
    const up = await api(srv.base, '/api/storage/upload', { token: user.token, body: { bucket: 'backup', path: 'backups/b.json', fileBase64: Buffer.from(JSON.stringify({ x: 'y'.repeat(400 * 1024) })).toString('base64'), contentType: 'application/json' }, headers: { 'cf-connecting-ip': '203.0.113.76' } })
    assert.equal(up.status, 200, up.text)
  })

  it('scoresheets: a day folder more than a week ahead is refused (SEC-16), today\'s is stored', async () => {
    const scorer = await account('sheets', ['scorer'])
    const put = (day) => api(srv.base, '/api/storage/upload', { token: scorer.token, body: { bucket: 'scoresheets', path: `${day}/game1_k${randomBytes(16).toString('hex')}_final.json`, fileBase64: Buffer.from('{}').toString('base64'), contentType: 'application/json', upsert: true }, headers: { 'cf-connecting-ip': '203.0.113.77' } })
    const far = await put('2099-12-31')
    assert.equal(far.status, 400, far.text)
    assert.equal(far.json.error.code, 'OV_STORAGE_INVALID_PATH')
    const today = await put(new Date().toISOString().slice(0, 10))
    assert.equal(today.status, 200, today.text)
  })
})
