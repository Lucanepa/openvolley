/**
 * POST /api/match/restore and its concurrency gate (2 bodies read at once,
 * 4 queued, 503 OV_BUSY beyond), end to end: server.js against a real
 * Postgres (PG_TEST_URL, or OV_E2E_DOCKER=1; see tests/server.e2e.test.js).
 *
 * A gate slot is held while the request body is read. A request whose client
 * goes away (Wi-Fi drop, app closed, laptop lid shut) must give its slot back,
 * whether it was reading or still queued: the gate is shared by every scorer
 * of the deployment, and two lost slots used to stop all restores until the
 * backend was restarted.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

describe('/api/match/restore: the concurrency gate never loses a slot', { skip: SKIP }, () => {
  let db
  let srv
  let sql
  let storageRoot
  let statusDir
  let token
  const sockets = new Set()

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-gate-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-gate-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
    })
    const email = `gate-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const up = await api(srv.base, '/api/auth/sign-up', { body: { email, password, metadata: { first_name: 'Gate' } } })
    assert.equal(up.status, 200, up.text)
    const inn = await api(srv.base, '/api/auth/sign-in', { body: { email, password } })
    assert.equal(inn.status, 200, inn.text)
    token = inn.json.data.session.access_token
    await grantRoles(sql, inn.json.data.user.id, ['scorer'])
  })

  after(async () => {
    for (const s of sockets) s.destroy()
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  /** A restore that never finishes its body: holds a gate slot (or a queue place). */
  function stalledRestore() {
    const sock = net.connect(srv.port, '127.0.0.1')
    sockets.add(sock)
    sock.answer = ''
    sock.on('data', (d) => { sock.answer += d.toString('latin1') })
    sock.on('error', () => {})
    sock.on('connect', () => sock.write(
      'POST /api/match/restore HTTP/1.1\r\nHost: x\r\n' +
      `Authorization: Bearer ${token}\r\nContent-Type: application/json\r\nX-OV-Proto: 2\r\n` +
      'Content-Length: 400000\r\n\r\n{"match":'))
    return sock
  }

  /** An empty restore: 400 when it gets a slot, 503 when the gate is full, null when it hangs. */
  async function probe(ms = 4000) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), ms)
    try {
      const res = await fetch(`${srv.base}/api/match/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OV-Proto': '2', Authorization: `Bearer ${token}` },
        body: '{}',
        signal: ac.signal
      })
      await res.text()
      return res.status
    } catch (err) {
      if (err.name === 'AbortError') return null
      throw err
    } finally { clearTimeout(timer) }
  }

  it('a restore answers on a clean gate', async () => {
    assert.equal(await probe(), 400)
  })

  it('requests whose client left while queued give their slot back once promoted', async () => {
    const active = [stalledRestore(), stalledRestore()]
    await sleep(800)
    const queued = [stalledRestore(), stalledRestore(), stalledRestore(), stalledRestore()]
    await sleep(800)
    assert.equal(await probe(), 503, 'two bodies read, four queued: the gate is full')
    // the four queued clients go away while they wait, then the two readers do:
    // their slots pass to the four dead requests, which must release them again
    for (const s of queued) s.end()
    await sleep(500)
    for (const s of active) s.end()
    await sleep(800)
    assert.equal(await probe(), 400, 'the gate is back to full capacity')
    assert.equal(await probe(), 400)
    assert.deepEqual(await Promise.all([probe(), probe(), probe()]), [400, 400, 400])
  })

  it('an upload that goes silent (no FIN, no data) loses its slot after the idle timeout', async () => {
    // two uploads whose devices vanished without closing the connection
    const silent = [stalledRestore(), stalledRestore()]
    await sleep(800)
    // they hold both slots: this request queues behind them, and gets its
    // slot (and its 400) once the idle timeout frees one
    const t0 = Date.now()
    const status = await probe(45_000)
    const waited = Date.now() - t0
    assert.equal(status, 400, 'the queued restore ran')
    assert.ok(waited > 20_000, `it waited for the idle timeout (${waited} ms)`)
    // the silent uploads were answered (408) and their connections closed
    for (const s of silent) {
      if (!s.destroyed) await new Promise((resolve) => s.once('close', resolve))
      assert.match(s.answer, /^HTTP\/1\.1 408 /)
      assert.match(s.answer, /OV_BODY_TIMEOUT/)
    }
    assert.equal(await probe(), 400)
  })
})
