/**
 * An admin deactivates an account in the manager, and reactivates it
 * (POST /api/admin/accounts/:id/deactivate|reactivate, lib/accounts.js
 * setActive), end to end: server.js against a real Postgres (PG_TEST_URL, or
 * OV_E2E_DOCKER=1; see tests/server.e2e.test.js).
 *
 *   1. who: admins only; never the caller's own account; a super admin only
 *      by a super admin
 *   2. what it does: no sign-in, the open sessions end at once; nothing is
 *      deleted; reactivate lets it sign in again; the list says deactivated
 *   3. the audit entries: account.deactivate / account.reactivate, once each
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

describe('an admin deactivates an account', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const password = 'correct-horse-battery'

  const signIn = async (email) => {
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': nextIp() }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    return inn
  }
  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': nextIp() }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    const inn = await signIn(email)
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: method === 'GET' ? null : '2' })
  const deactivate = (actor, target) => call(actor, 'POST', `/api/admin/accounts/${target.id}/deactivate`, {})
  const reactivate = (actor, target) => call(actor, 'POST', `/api/admin/accounts/${target.id}/reactivate`, {})
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const listed = async (target) => (await call(users.admin, 'GET', `/api/admin/accounts?filter=all&q=${encodeURIComponent(target.email)}`)).json.data.accounts.find((a) => a.id === target.id)

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    // db/027 (the production users table has the column, the synthetic one not)
    await sql.query('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz')
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await account('admin', ['admin'])
    await account('cm', ['competition_manager'])
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('the accounts list says this server can deactivate accounts', async () => {
    const r = await call(users.admin, 'GET', '/api/admin/accounts?filter=all')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.can_deactivate, true)
  })

  it('only admins; never the own account; unknown accounts are 404', async () => {
    const target = await account('target1', ['scorer'])
    expectCode(await deactivate(users.cm, target), 403, 'OV_FORBIDDEN')
    assert.equal((await deactivate(null, target)).status, 401)
    expectCode(await deactivate(users.admin, users.admin), 409, 'OV_SELF_DEACTIVATE')
    expectCode(await deactivate(users.admin, { id: '00000000-0000-4000-8000-000000000000' }), 404, 'OV_ACCOUNT_NOT_FOUND')
    assert.equal((await listed(target)).deactivated, false)
  })

  it('no sign-in and no session while deactivated, nothing deleted, back after reactivate; audited once each', async () => {
    const target = await account('target2', ['scorer'])
    const r = await deactivate(users.admin, target)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data, { id: target.id, deactivated: true, changed: true })
    assert.equal((await call(target, 'GET', '/api/me')).status, 401, 'its open session ended')
    assert.notEqual((await signIn(target.email)).status, 200, 'it cannot sign in')
    const row = await listed(target)
    assert.equal(row.deactivated, true)
    assert.deepEqual(row.roles, ['scorer'], 'its roles stay')
    // again: nothing to change, no second audit entry
    assert.equal((await deactivate(users.admin, target)).json.data.changed, false)
    const back = await reactivate(users.admin, target)
    assert.equal(back.status, 200, back.text)
    assert.equal(back.json.data.deactivated, false)
    assert.equal((await signIn(target.email)).status, 200)
    assert.equal((await listed(target)).deactivated, false)
    const { rows } = await sql.query('SELECT action, actor_id FROM public.audit_log WHERE target_user_id = $1 AND action LIKE $2 ORDER BY id', [target.id, 'account.%activate'])
    assert.deepEqual(rows.map((x) => x.action), ['account.deactivate', 'account.reactivate'])
    assert.equal(rows[0].actor_id, users.admin.id)
  })

  it('a super admin only by a super admin', async () => {
    const boss = await account('boss', ['super_admin'])
    expectCode(await deactivate(users.admin, boss), 403, 'OV_FORBIDDEN')
    assert.equal((await listed(boss)).deactivated, false)
    // (the last-super-admin rule cannot be reached through the API: the
    // caller is a super admin that can sign in; it guards a stale caller)
    const boss2 = await account('boss2', ['super_admin'])
    assert.equal((await deactivate(boss2, boss)).status, 200)
    assert.equal((await reactivate(boss2, boss)).status, 200)
  })
})
