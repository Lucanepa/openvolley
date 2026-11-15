/**
 * The manager's SQL tab (lib/sqlWorkspace.js), end to end, with the backend
 * running as the app role of roles.sql: super admins only; read mode as the
 * reader role on ov_read (no secret columns, no auth, always rolled back);
 * write mode previews (rolled back) and commits only when asked, with the
 * closed-match lock still on; session state never leaks to the pool; every
 * run audited with its literals masked.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles, readonlyRoleOf } from './helpers/pgTestDb.js'
import { checkStatementPolicy, checkWriteScope, leadingKeyword, maskSql, splitStatements } from '../lib/sqlWorkspace.js'

describe('sqlWorkspace (unit)', () => {
  it('statements split at top-level semicolons only; comments are no statements', () => {
    assert.deepEqual(splitStatements("select ';'; select 2; -- note"), ["select ';'", 'select 2'])
    assert.deepEqual(splitStatements('select $x$;$x$'), ['select $x$;$x$'])
    assert.throws(() => splitStatements("select 'open"), /Unterminated/)
    assert.equal(leadingKeyword('/* a */ -- b\n(SELECT 1)'), 'SELECT')
  })
  it('the policy refuses session state, code and privileges; literals never match', () => {
    for (const bad of ["set ov.allow_closed = 'on'", "select set_config('ov.allow_closed','on',false)", 'commit', 'reset role',
      'create function f() returns int as $$select 1$$ language sql', 'grant select on matches to public', 'listen x',
      'select pg_advisory_lock(1)', 'alter table matches disable trigger all', "update pg_settings set setting = '1'",
      'create temp table t (a int)', 'U&"set\\005fconfig"']) {
      assert.ok(checkStatementPolicy(bad), bad)
    }
    assert.equal(checkStatementPolicy("select 'set_config(1)' as x -- set role"), null)
    assert.equal(checkStatementPolicy('update matches set status = $$final$$ where id = 1'), null)
  })
  it('write mode reaches neither auth nor a secret column', () => {
    assert.equal(checkWriteScope('select email from auth.users')?.code, 'auth_not_allowed')
    assert.equal(checkWriteScope('select "game_pin" from matches')?.code, 'secret_column_not_allowed')
    assert.equal(checkWriteScope("update clubs set name = 'auth.users game_pin'"), null)
    assert.equal(checkWriteScope('select authorization_ok from x'), null)
  })
  it('the audit copy masks every string literal', () => {
    assert.equal(maskSql("select * from clubs where name = 'VBC Muster' and x = E'a\\'b' and y = $$z$$"), "select * from clubs where name = '?' and x = '?' and y = '?'")
  })
})

describe('sqlWorkspace end to end', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: method === 'GET' ? null : '2' })
  const runSql = (body, user = users.root) => call(user, 'POST', '/api/admin/sql', body)
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const lastAudit = async (action) => (await sql.query('SELECT * FROM public.audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1', [action])).rows[0]
  let appRole, readerRole, club, closed

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    const appUrl = db.appUrl()
    appRole = new URL(appUrl).username
    readerRole = readonlyRoleOf(appRole)
    srv = await bootServer({ DATABASE_URL: appUrl, OV_SQL_READER_ROLE: readerRole, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await account('root', ['super_admin'])
    await account('admin', ['admin'])
    ;({ rows: [club] } = await sql.query("INSERT INTO public.clubs (name, contact_email) VALUES ('VBC Sqlhausen', 'info@example.ch') RETURNING id"))
    ;({ rows: [closed] } = await sql.query(
      `INSERT INTO public.matches (external_id, status, game_n, game_pin, test) VALUES ($1, 'live', 5150, '424242', true) RETURNING id`,
      [`match_${Date.now()}_${randomBytes(3).toString('hex')}`]))
    await sql.query('BEGIN')
    await sql.query("SELECT set_config('ov.allow_closed', 'on', true)")
    await sql.query("UPDATE public.matches SET status = 'final', closed_at = now() WHERE id = $1", [closed.id])
    await sql.query('COMMIT')
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('super admins only', async () => {
    expectCode(await runSql({ sql: 'select 1' }, users.admin), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.admin, 'GET', '/api/admin/sql/schema'), 403, 'OV_FORBIDDEN')
  })

  it('the schema: the tables of ov_read, no secret column, no auth', async () => {
    const r = await call(users.root, 'GET', '/api/admin/sql/schema?refresh=1')
    assert.equal(r.status, 200, r.text)
    const tables = new Map(r.json.data.tables.map((t) => [t.name, t]))
    assert.ok(tables.has('matches') && tables.has('clubs'))
    assert.ok(!tables.has('users') && !tables.has('app_sessions'))
    const m = tables.get('matches')
    assert.ok(!m.columns.some((c) => c.name === 'game_pin' || c.name === 'connection_pins'))
    assert.ok(m.columns.find((c) => c.name === 'id')?.pk)
    assert.match(r.json.data.server_version, /^\d+/)
  })

  it('read mode: plain names, no PIN, no auth, no writes, no session state', async () => {
    const all = await runSql({ sql: 'select * from matches where game_n = 5150' })
    assert.equal(all.status, 200, all.text)
    assert.ok(all.json.data.columns.includes('external_id'))
    assert.ok(!all.json.data.columns.includes('game_pin'))
    assert.equal(all.json.data.row_count, 1)

    expectCode(await runSql({ sql: 'select game_pin from public.matches' }), 400, 'credential_column_denied')
    expectCode(await runSql({ sql: 'select email from auth.users' }), 400, 'credential_column_denied')
    expectCode(await runSql({ sql: 'delete from clubs' }), 400, 'write_required')
    expectCode(await runSql({ sql: 'with d as (delete from clubs returning 1) select * from d' }), 400, 'credential_column_denied')
    expectCode(await runSql({ sql: "select set_config('ov.allow_closed', 'on', false)" }), 400, 'function_not_allowed')
    expectCode(await runSql({ sql: 'commit; delete from clubs' }), 400, 'statement_not_allowed')

    // the role and the settings do not survive on the pooled connection
    const who = await runSql({ sql: 'select current_user as u' })
    assert.equal(who.json.data.rows[0][0], readerRole)
    for (let i = 0; i < 4; i++) {
      const back = await runSql({ sql: "select current_user as u, current_setting('ov.allow_closed', true) as ac", write_mode: true })
      assert.equal(back.status, 200, back.text)
      assert.equal(back.json.data.rows[0][0], appRole)
      assert.ok(!back.json.data.rows[0][1])
    }
  })

  it('values as Postgres prints them; a bare SELECT capped at 1000 rows', async () => {
    const d = await runSql({ sql: "select date '2026-09-15' as d, timestamp '2026-09-15 20:00' as ts, 1::bigint as n" })
    assert.deepEqual(d.json.data.rows[0], ['2026-09-15', '2026-09-15 20:00:00', '1'])
    const big = await runSql({ sql: 'select g from generate_series(1, 1500) g' })
    assert.equal(big.json.data.rows.length, 1000)
    assert.equal(big.json.data.truncated, true)
  })

  it('every run is audited, its literals masked', async () => {
    const r = await runSql({ sql: "select id from clubs where name = 'VBC Sqlhausen'" })
    assert.equal(r.status, 200, r.text)
    const a = await lastAudit('sql.read')
    assert.equal(a.actor_id, users.root.id)
    assert.equal(a.details.sql, "select id from clubs where name = '?'")
    assert.equal(a.details.rows, 1)
    assert.match(a.details.sql_sha256, /^[0-9a-f]{64}$/)
  })

  it('write mode: a preview is rolled back; commit writes and is audited', async () => {
    const stmt = `update clubs set contact_email = 'board@example.ch' where id = '${club.id}'`
    const preview = await runSql({ sql: stmt, write_mode: true })
    assert.equal(preview.status, 200, preview.text)
    assert.equal(preview.json.data.committed, false)
    assert.deepEqual(preview.json.data.rows, [['UPDATE', 1]])
    assert.equal((await sql.query('SELECT contact_email FROM public.clubs WHERE id = $1', [club.id])).rows[0].contact_email, 'info@example.ch')
    assert.equal((await lastAudit('sql.write')).details.committed, false)

    const done = await runSql({ sql: stmt, write_mode: true, commit: true })
    assert.equal(done.status, 200, done.text)
    assert.equal(done.json.data.committed, true)
    assert.equal((await sql.query('SELECT contact_email FROM public.clubs WHERE id = $1', [club.id])).rows[0].contact_email, 'board@example.ch')
    const a = await lastAudit('sql.write')
    assert.equal(a.details.committed, true)
    assert.equal(a.details.affected, 1)
    assert.ok(!a.details.sql.includes('board@example.ch'))
  })

  it('write mode: no auth, no secret column, no schema change, and a closed match stays closed', async () => {
    expectCode(await runSql({ sql: 'select email from auth.users', write_mode: true }), 400, 'auth_not_allowed')
    expectCode(await runSql({ sql: "update matches set game_pin = '1'", write_mode: true }), 400, 'secret_column_not_allowed')
    expectCode(await runSql({ sql: 'create table x (a int)', write_mode: true, commit: true }), 400, '42501')
    expectCode(await runSql({ sql: 'update audit_log set action = action', write_mode: true, commit: true }), 400, '42501')
    expectCode(await runSql({ sql: `update matches set game_n = 5151 where id = '${closed.id}'`, write_mode: true, commit: true }), 409, 'OVC01')
    assert.equal((await sql.query('SELECT game_n FROM public.matches WHERE id = $1', [closed.id])).rows[0].game_n, 5150)
  })
})
