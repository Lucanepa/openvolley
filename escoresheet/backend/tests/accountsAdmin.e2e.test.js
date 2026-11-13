/**
 * The admin's account actions and the authorization matrix, end to end, with
 * the server connected as a role that has exactly the grants of db/roles.sql
 * (production's ov_app; tests/helpers/e2eServer.js appUrl) and account mails
 * on (tests/helpers/fakeSmtp.js), so a fresh sign-up is what it is in
 * production: signed in, unconfirmed, without a role.
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
import { startFakeSmtp, linkToken } from './helpers/fakeSmtp.js'

describe('admin account actions with the production grants', { skip: SKIP }, () => {
  let db, sql, smtp, srv, storageRoot, statusDir
  let ipSeq = 1
  const nextIp = () => `203.0.113.${ipSeq++}`
  const PASSWORD = 'correct-horse-battery'
  const users = {}

  const auth = (action, body) => api(srv.base, `/api/auth/${action}`, { body, proto: null, headers: { 'cf-connecting-ip': nextIp() } })
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: null })
  const dbCall = (user, table, action, params) =>
    api(srv.base, '/api/db', { token: user?.token, proto: action === 'select' ? null : '2', body: { table, action, params } })
  const me = (user) => call(user, 'GET', '/api/me')

  async function signIn (email) {
    let r
    for (let i = 0; i < 10; i++) {
      r = await auth('sign-in', { email, password: PASSWORD })
      if (!(r.status === 503 && r.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(r.status, 200, r.text)
    return r.json.data.session.access_token
  }

  /** A fresh sign-up: unconfirmed, no role. `confirm` follows its link; `roles` are set in SQL. */
  async function account (name, { confirm = true, roles = [] } = {}) {
    const email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.test`
    const up = await auth('sign-up', { email, password: PASSWORD, metadata: { first_name: name } })
    assert.equal(up.status, 200, up.text)
    if (confirm) {
      const mail = await smtp.waitForMail((m) => m.envelope.to.includes(email))
      const r = await auth('confirm-email', { token: linkToken(mail).token })
      assert.equal(r.status, 200, r.text)
    }
    const u = { email, token: await signIn(email) }
    u.id = (await auth('get-user', { access_token: u.token })).json.data.user.id
    if (roles.length) await grantRoles(sql, u.id, roles)
    return u
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-adm-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-adm-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    smtp = await startFakeSmtp({ implicitTls: false })
    srv = await bootServer({
      DATABASE_URL: db.appUrl(),
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
      ...smtp.env()
    })
    users.root = await account('root', { roles: ['admin', 'super_admin'] })
    users.adminA = await account('adminA', { roles: ['admin'] })
    users.adminB = await account('adminB', { roles: ['admin'] })
    users.scorer = await account('scorer', { roles: ['scorer'] })
    users.fresh = await account('fresh', { confirm: false }) // unconfirmed, no role
    users.plain = await account('plain') // confirmed, no role
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await smtp?.close()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('deactivate and reactivate work as ov_app', async () => {
    const t = await account('target', { roles: ['scorer'] })
    const off = await call(users.adminA, 'POST', `/api/admin/accounts/${t.id}/deactivate`)
    assert.equal(off.status, 200, off.text)
    assert.equal((await me(t)).status, 401)
    const on = await call(users.adminA, 'POST', `/api/admin/accounts/${t.id}/reactivate`)
    assert.equal(on.status, 200, on.text)
  })

  it('two admins deactivating each other at once: only one succeeds', async () => {
    const a = await account('raceA', { roles: ['admin'] })
    const b = await account('raceB', { roles: ['admin'] })
    // hold both profile rows so that both requests wait for the lock
    const hold = new pg.Client({ connectionString: db.url })
    await hold.connect()
    try {
      await hold.query('BEGIN')
      await hold.query('SELECT 1 FROM public.profiles WHERE user_id = ANY($1::uuid[]) FOR UPDATE', [[a.id, b.id]])
      const ab = call(a, 'POST', `/api/admin/accounts/${b.id}/deactivate`)
      const ba = call(b, 'POST', `/api/admin/accounts/${a.id}/deactivate`)
      for (let i = 0; i < 50; i++) {
        const { rows: [w] } = await sql.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")
        if (w.n >= 2) break
        await sleep(100)
      }
      await hold.query('COMMIT')
      const codes = (await Promise.all([ab, ba])).map((r) => r.status).sort()
      assert.equal(codes[0], 200, JSON.stringify(codes))
      assert.notEqual(codes[1], 200, JSON.stringify(codes))
      const { rows: [n] } = await sql.query('SELECT count(*)::int AS n FROM auth.users WHERE id = ANY($1::uuid[]) AND banned_until > now()', [[a.id, b.id]])
      assert.equal(n.n, 1)
    } finally { await hold.end() }
  })

  it('Edit details: a new address is unconfirmed, the sessions end, the old address is told, the audit keeps digests', async () => {
    const t = await account('mover', { roles: ['scorer'] })
    const newEmail = `moved-${randomBytes(3).toString('hex')}@example.test`
    const r = await call(users.adminA, 'PATCH', `/api/admin/accounts/${t.id}`, { email: newEmail })
    assert.equal(r.status, 200, r.text)
    const { rows: [u] } = await sql.query('SELECT email, email_confirmed_at FROM auth.users WHERE id = $1', [t.id])
    assert.equal(u.email, newEmail)
    assert.equal(u.email_confirmed_at, null)
    assert.equal((await me(t)).status, 401, 'the old session ended')
    await smtp.waitForMail((m) => m.envelope.to.includes(t.email) && /address/i.test(m.subject))
    // the owner of the new address can still sign in and confirm it
    const token = await signIn(newEmail)
    assert.ok(token)
    const { rows: [a] } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'account.profile' AND target_user_id = $1", [t.id])
    assert.ok(!JSON.stringify(a.details).includes('@'), JSON.stringify(a.details))
  })

  it('adding an editor and linking to a club need a confirmed account; the audit keeps no address', async () => {
    const { rows: [m] } = await sql.query("INSERT INTO public.matches (external_id, status, sport_type) VALUES ($1, 'setup', 'indoor') RETURNING id", [`adm_${randomBytes(3).toString('hex')}`])
    const no = await call(users.adminA, 'POST', `/api/admin/matches/${m.id}/editors`, { email: users.fresh.email })
    assert.equal(no.status, 409, no.text)
    assert.equal(no.json.error.code, 'OV_EMAIL_UNCONFIRMED')
    const yes = await call(users.adminA, 'POST', `/api/admin/matches/${m.id}/editors`, { email: users.plain.email })
    assert.equal(yes.status, 200, yes.text)
    const { rows: [a] } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'match.editor_add' AND match_id = $1", [m.id])
    assert.ok(!JSON.stringify(a.details).includes('@'), JSON.stringify(a.details))
    const club = await call(users.adminA, 'POST', '/api/admin/clubs', { name: `Club ${randomBytes(2).toString('hex')}` })
    assert.equal(club.status, 201, club.text)
    const clubId = club.json.data.club.id
    const link = await call(users.adminA, 'PUT', `/api/admin/accounts/${users.fresh.id}/clubs`, { club_ids: [clubId] })
    assert.equal(link.status, 409, link.text)
    assert.equal(link.json.error.code, 'OV_EMAIL_UNCONFIRMED')
    const ok = await call(users.adminA, 'PUT', `/api/admin/accounts/${users.plain.id}/clubs`, { club_ids: [clubId] })
    assert.equal(ok.status, 200, ok.text)
  })

  it('the audit log and approvals cannot be rewritten or removed by ov_app', async () => {
    const app = new pg.Client({ connectionString: db.appUrl() })
    await app.connect()
    try {
      await assert.rejects(() => app.query("UPDATE public.audit_log SET action = 'x' WHERE false"), (e) => e.code === '42501')
      await assert.rejects(() => app.query('DELETE FROM public.audit_log WHERE false'), (e) => e.code === '42501')
      await app.query('UPDATE public.audit_log SET actor_id = NULL, target_user_id = NULL WHERE false') // the account detach
      const { rows: [m] } = await sql.query("INSERT INTO public.matches (external_id, status, sport_type) VALUES ($1, 'setup', 'indoor') RETURNING id", [`apr_${randomBytes(3).toString('hex')}`])
      await sql.query("INSERT INTO public.match_approvals (match_id, slot, display_name, match_status, result_key, result_hash) VALUES ($1, 'scorer', 'Test Scorer', 'setup', 'k', sha256('k'::bytea))", [m.id])
      await assert.rejects(() => app.query('DELETE FROM public.match_approvals WHERE match_id = $1', [m.id]), /cascade|deleted/i)
      await app.query('DELETE FROM public.matches WHERE id = $1', [m.id]) // the cascade still works
      const { rows: [n] } = await sql.query('SELECT count(*)::int AS n FROM public.match_approvals WHERE match_id = $1', [m.id])
      assert.equal(n.n, 0)
    } finally { await app.end() }
  })

  it('referee directory: only scorers and admins add rows; removing a sport needs an admin', async () => {
    const row = { first_name: 'Rita', last_name: `Ref${randomBytes(2).toString('hex')}`, country: 'CHE', sport_type: ['indoor'] }
    for (const who of ['fresh', 'plain']) {
      const r = await dbCall(users[who], 'referee_database', 'insert', { data: { ...row, last_name: row.last_name + who }, returning: 'id' })
      assert.equal(r.status, 403, `${who}: ${r.text}`)
    }
    const ins = await dbCall(users.scorer, 'referee_database', 'insert', { data: row, returning: 'id', single: true })
    assert.equal(ins.status, 200, ins.text)
    const id = ins.json.data.id
    const eq = [{ type: 'eq', column: 'id', value: id }]
    assert.equal((await dbCall(users.plain, 'referee_database', 'update', { data: { sport_type: ['indoor', 'beach'] }, filters: eq })).status, 403)
    assert.equal((await dbCall(users.scorer, 'referee_database', 'update', { data: { sport_type: ['indoor', 'beach'] }, filters: eq })).status, 200)
    const hide = await dbCall(users.scorer, 'referee_database', 'update', { data: { sport_type: [] }, filters: eq })
    assert.equal(hide.status, 403, hide.text)
    assert.equal((await dbCall(users.adminA, 'referee_database', 'update', { data: { sport_type: ['beach'] }, filters: eq })).status, 200)
  })

  it('authorization matrix: role-less accounts, a revoked and an expired session', async () => {
    const { rows: [m] } = await sql.query("INSERT INTO public.matches (external_id, status, sport_type) VALUES ($1, 'setup', 'indoor') RETURNING id", [`mx_${randomBytes(3).toString('hex')}`])
    const revoked = await account('revoked', { roles: ['scorer'] })
    await auth('sign-out', { access_token: revoked.token })
    const expired = await account('expired', { roles: ['scorer'] })
    await sql.query("UPDATE auth.app_sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [expired.id])
    for (const [who, u] of [['fresh', users.fresh], ['plain', users.plain], ['revoked', revoked], ['expired', expired]]) {
      const dead = who === 'revoked' || who === 'expired'
      // admin endpoints
      for (const [method, path, body] of [
        ['GET', '/api/admin/accounts'],
        ['POST', `/api/admin/accounts/${users.scorer.id}/deactivate`],
        ['PATCH', `/api/admin/accounts/${users.scorer.id}`, { first_name: 'X' }],
        ['POST', `/api/admin/matches/${m.id}/editors`, { email: u.email }],
        ['PUT', `/api/admin/accounts/${u.id}/clubs`, { club_ids: [] }]
      ]) {
        const r = await call(u, method, path, body)
        assert.equal(r.status, dead ? 401 : 403, `${who} ${method} ${path}: ${r.text}`)
      }
      // another account's match: no write, and a dead session gets no public view either
      const w = await dbCall(u, 'matches', 'update', { data: { status: 'live' }, filters: [{ type: 'eq', column: 'id', value: m.id }] })
      assert.ok([401, 403].includes(w.status), `${who} write: ${w.text}`)
      const rd = await dbCall(u, 'matches', 'select', { columns: '*', filters: [{ type: 'eq', column: 'id', value: m.id }] })
      if (dead) {
        assert.equal(rd.status, 401, `${who} read: ${rd.text}`)
        assert.equal(rd.json.error.code, 'invalid_token')
      } else {
        assert.equal(rd.status, 200, `${who} read: ${rd.text}`)
        assert.equal(rd.json.data?.[0]?.created_by, undefined, `${who} read the full row`)
      }
    }
    // no bearer: the public view, as before
    const anon = await dbCall(null, 'matches', 'select', { columns: '*', filters: [{ type: 'eq', column: 'id', value: m.id }] })
    assert.equal(anon.status, 200, anon.text)
  })
})
