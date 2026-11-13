/**
 * After a database restore the server can lack a match a device already
 * sent: an update of it matched no row and was answered 200, so the app
 * counted it as sent and never sent the match again. Such an update is now
 * answered 404 OV_MATCH_UNKNOWN (the app re-sends the match from its own
 * data, useSyncQueue resyncMatch). /health shows the database run and the
 * files run of the host backup apart (last_backup, last_files_backup).
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

describe('writes of a match the server lacks', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  const ip = '198.51.100.71'
  const stamp = (ageMin) => new Date(Date.now() - ageMin * 60000).toISOString() + '\n'

  async function account (name) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    assert.equal((await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })).status, 200)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
    await grantRoles(sql, u.id, ['scorer'])
    return u
  }
  const dbCall = (user, table, action, params, device) =>
    api(srv.base, '/api/db', { token: user.token, proto: '2', headers: { 'cf-connecting-ip': ip }, body: { table, action, params, ...(device ? { device } : {}) } })
  const updateMatch = (user, ext, data, device) => dbCall(user, 'matches', 'update', { data, filters: [{ type: 'eq', column: 'external_id', value: ext }] }, device)

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-unknown-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-unknown-status-'))
    writeFileSync(join(statusDir, 'last_backup'), stamp(5))
    srv = await bootServer({ DATABASE_URL: db.url, STORAGE_ROOT: storageRoot, STATUS_DIR: statusDir, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('an update of a match the server lacks is 404 OV_MATCH_UNKNOWN; of a stored one 200', async () => {
    const owner = await account('mira')
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const missing = await updateMatch(owner, ext, { status: 'live' })
    assert.equal(missing.status, 404, missing.text)
    assert.equal(missing.json.error.code, 'OV_MATCH_UNKNOWN')
    assert.equal((await updateMatch(owner, ext, {})).json?.error?.code, 'OV_MATCH_UNKNOWN')
    // an app that names its scoring device (db/019 guardedWrite)
    assert.equal((await updateMatch(owner, ext, { status: 'live' }, { id: randomUUID(), platform: 'web' })).json?.error?.code, 'OV_MATCH_UNKNOWN')

    const ins = await dbCall(owner, 'matches', 'insert', { data: { external_id: ext, game_n: 91001, status: 'live', game_pin: '615283' } })
    assert.equal(ins.status, 200, ins.text)
    assert.equal((await updateMatch(owner, ext, { status: 'live' })).status, 200)
  })

  it('an update of another account\'s match stays 403, never OV_MATCH_UNKNOWN', async () => {
    const owner = await account('lena')
    const other = await account('tino')
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    assert.equal((await dbCall(owner, 'matches', 'insert', { data: { external_id: ext, game_n: 91002, status: 'live', game_pin: '615283' } })).status, 200)
    const r = await updateMatch(other, ext, { status: 'live' })
    assert.notEqual(r.json?.error?.code, 'OV_MATCH_UNKNOWN')
  })

  it('/health shows the files run apart; a stale files run degrades it', async () => {
    rmSync(join(statusDir, 'last_files_backup'), { force: true })
    let h = await api(srv.base, '/health', { method: 'GET' })
    assert.equal(h.json.backup, 'ok')
    assert.equal(h.json.filesBackup, 'unknown')
    writeFileSync(join(statusDir, 'last_files_backup'), stamp(60))
    await sleep(2100) // the health cache
    h = await api(srv.base, '/health', { method: 'GET' })
    assert.equal(h.json.filesBackup, 'ok')
    assert.equal(h.json.lastFilesBackupAgeMin >= 59, true)
    writeFileSync(join(statusDir, 'last_files_backup'), stamp(40 * 60))
    await sleep(2100)
    h = await api(srv.base, '/health', { method: 'GET' })
    assert.equal(h.json.filesBackup, 'stale')
    assert.equal(h.status, 503)
  })
})
