/**
 * Approval with a PIN was removed (owner 27.11.2026: officials sign by hand).
 * Its old paths answer 410 OV_APPROVAL_REMOVED, signed in or not, so apps
 * already installed get a clean error, and nothing is written. The server
 * still needs OV_PIN_SECRET (game PINs, match tokens).
 *
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const PIN_SECRET = 'x'.repeat(40)
const PASSWORD = 'correct-horse-battery'
const ID = '6f1c2a9b-0000-4000-8000-000000000001'

describe('approval with a PIN is removed end to end', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 10
  const nextIp = () => `203.0.113.${ipSeq++}`
  const users = {}

  const env = () => ({
    DATABASE_URL: db.url,
    STORAGE_ROOT: storageRoot,
    STATUS_DIR: statusDir,
    TRUST_PROXY: 'cloudflare',
    TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
    STORAGE_BACKUP_MIN_FREE_MB: '1',
    STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
  })

  async function account (name, { first = name, last = 'Test', roles = null, password = PASSWORD } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: first, last_name: last } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, ip, password }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body, headers = {}) =>
    api(srv.base, path, { method, token: user?.token, body, proto: null, headers: { 'cf-connecting-ip': user?.ip || '203.0.113.250', ...headers } })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-approval-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-approval-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({ ...env(), OV_PIN_SECRET: PIN_SECRET })
    await account('owner', { first: 'Olga', last: 'Owner', roles: ['scorer'] })
    await account('admin', { first: 'Ada', last: 'Admin', roles: ['admin'] })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('every old approval path answers 410 OV_APPROVAL_REMOVED, signed in or not, and writes nothing', async () => {
    const { owner, admin } = users
    const calls = [
      ['GET', '/api/account/approval-pin'], ['POST', '/api/account/approval-pin', { password: PASSWORD, pin: '804613' }],
      ['POST', '/api/account/approval-pin/remove', { password: PASSWORD }], ['GET', '/api/account/approvals'],
      ['POST', '/api/approvals', { external_id: 'x', slot: 'referee1', email: 'a@example.ch', pin: '804613', result: { sets: [] } }],
      ['GET', '/api/approvals?external_id=x'], ['DELETE', `/api/approvals/${ID}`], ['GET', '/api/admin/approvals?q=x']
    ]
    for (const who of [owner, admin, null]) {
      for (const [method, path, body] of calls) expectCode(await call(who, method, path, body), 410, 'OV_APPROVAL_REMOVED')
    }
    const { rows: [n] } = await sql.query('SELECT (SELECT count(*) FROM public.match_approvals)::int + (SELECT count(*) FROM auth.approval_pins)::int AS n')
    assert.equal(n.n, 0)
  })

  it('without OV_PIN_SECRET the database backend still does not start (game PINs are never plaintext)', async () => {
    await assert.rejects(bootServer({ ...env(), OV_PIN_SECRET: '' }), /OV_PIN_SECRET is required/)
  })
})
