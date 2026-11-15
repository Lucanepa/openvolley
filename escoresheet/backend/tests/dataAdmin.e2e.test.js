/**
 * The manager's Data tab (lib/dataAdmin.js), end to end: super admins only;
 * the auth schema and secret columns never shown; logs read-only; an update
 * refused when the row changed since it was read; the closed-match lock
 * still holds; every write audited without personal values.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { readFileSync } from 'node:fs'
import { auditValue, cellOf, kindOf, sameValue, SECRET_COLUMN_RE } from '../lib/dataAdmin.js'

describe('dataAdmin (unit)', () => {
  it('secret columns: PINs, hashes, tokens; not their neighbours', () => {
    for (const c of ['game_pin', 'connection_pins', 'token_hash', 'code_hash', 'ip_hash', 'coach_signed_hash', 'salt', 'mac', 'hash', 'encrypted_password']) assert.ok(SECRET_COLUMN_RE.test(c), c)
    for (const c of ['id', 'pinned', 'hashtag', 'machine', 'sha256', 'game_n', 'code_hint', 'name', 'match_id']) assert.ok(!SECRET_COLUMN_RE.test(c), c)
  })
  it('roles.sql hides the same columns from ov_readonly (db-browse.sh) as the Data tab', () => {
    const roles = readFileSync(new URL('../db/roles.sql', import.meta.url), 'utf8')
    const m = /secret_re constant text := '([^']+)';/.exec(roles)
    assert.ok(m, 'roles.sql: secret_re')
    assert.equal(m[1], SECRET_COLUMN_RE.source)
  })
  it('kinds, cells, equality and audit values', () => {
    assert.equal(kindOf('U', 'jsonb'), 'json')
    assert.equal(kindOf('B', 'boolean'), 'bool')
    assert.equal(kindOf('A', 'text[]'), 'array')
    assert.equal(cellOf('x'.repeat(10)), 'x'.repeat(10))
    assert.deepEqual(cellOf('x'.repeat(300)), { $cut: 'x'.repeat(160), $len: 300 })
    assert.ok(sameValue({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }))
    assert.ok(!sameValue({ a: 1 }, { a: 1, b: 2 }))
    assert.ok(sameValue(null, undefined))
    assert.equal(auditValue({ name: 'status', kind: 'text' }, 'live'), 'live')
    assert.equal(auditValue({ name: 'first_name', kind: 'text' }, 'Anna'), '[personal]')
    assert.equal(auditValue({ name: 'dob', kind: 'date' }, '2001-01-01'), '[personal]')
    assert.equal(auditValue({ name: 'officials', kind: 'json' }, { a: 1 }), '[json]')
    assert.equal(auditValue({ name: 'team_id', kind: 'uuid' }, '00000000-0000-0000-0000-000000000000'), '00000000-0000-0000-0000-000000000000')
  })
})

describe('dataAdmin end to end', { skip: SKIP }, () => {
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
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const lastAudit = async (action) => (await sql.query('SELECT * FROM public.audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1', [action])).rows[0]

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await account('root', ['super_admin'])
    await account('admin', ['admin'])
    await account('scorer', ['scorer'])
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('super admins only: an admin and a scorer are refused', async () => {
    expectCode(await call(users.admin, 'GET', '/api/admin/data/tables'), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.scorer, 'GET', '/api/admin/data/tables'), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.admin, 'PATCH', '/api/admin/data/tables/clubs/row', { key: {}, set: {}, before: {} }), 403, 'OV_FORBIDDEN')
    expectCode(await call(null, 'GET', '/api/admin/data/tables'), 401, 'missing_token')
  })

  it('the tables of public only; secret columns left out; logs read-only', async () => {
    const r = await call(users.root, 'GET', '/api/admin/data/tables')
    assert.equal(r.status, 200, r.text)
    const tables = new Map(r.json.data.tables.map((t) => [t.name, t]))
    assert.ok(tables.has('matches') && tables.has('clubs') && tables.has('audit_log'))
    // auth.users and its kin are not tables of public
    assert.ok(![...tables.keys()].some((n) => /^(users|app_sessions|passkeys|app_tokens|approval_pins)$/.test(n)))
    const matches = tables.get('matches')
    assert.deepEqual(matches.pk, ['id'])
    assert.ok(!matches.columns.some((c) => c.name === 'game_pin' || c.name === 'connection_pins'))
    assert.deepEqual(matches.secret_columns.sort(), ['connection_pins', 'game_pin'])
    assert.equal(tables.get('audit_log').read_only, 'log')
    assert.equal(tables.get('clubs').read_only, null)
    // an unknown table and a bad name
    expectCode(await call(users.root, 'GET', '/api/admin/data/tables/nope'), 404, 'OV_NOT_FOUND')
    expectCode(await call(users.root, 'GET', '/api/admin/data/tables/Users;drop'), 404, 'OV_NOT_FOUND')
  })

  let club
  it('insert, find, read whole, update with the values read, delete: each audited', async () => {
    const made = await call(users.root, 'POST', '/api/admin/data/tables/clubs/rows', { values: { name: 'VBC Datahausen', contact_email: 'info@example.ch' } })
    assert.equal(made.status, 200, made.text)
    club = made.json.data.row
    assert.equal(club.name, 'VBC Datahausen')
    const ins = await lastAudit('data.insert')
    assert.equal(ins.actor_id, users.root.id)
    assert.equal(ins.details.table, 'clubs')
    assert.equal(ins.details.key.id, club.id)
    // personal values are not copied into the audit log
    assert.equal(ins.details.values.name, '[personal]')
    assert.equal(ins.details.values.contact_email, '[personal]')

    const found = await call(users.root, 'GET', '/api/admin/data/tables/clubs?q=datahausen')
    assert.equal(found.status, 200, found.text)
    assert.equal(found.json.data.total, 1)
    assert.equal(found.json.data.rows[0].id, club.id)
    const byCol = await call(users.root, 'GET', `/api/admin/data/tables/clubs?col=id&op=eq&val=${club.id}`)
    assert.equal(byCol.json.data.total, 1)
    const none = await call(users.root, 'GET', '/api/admin/data/tables/clubs?col=contact_email&op=null')
    assert.equal(none.json.data.rows.some((x) => x.id === club.id), false)
    expectCode(await call(users.root, 'GET', '/api/admin/data/tables/clubs?col=id&op=eq&val=not-a-uuid'), 400, 'OV_DATA_INVALID')
    expectCode(await call(users.root, 'GET', '/api/admin/data/tables/matches?col=game_pin&op=eq&val=1234'), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.root, 'GET', '/api/admin/data/tables/matches?sort=game_pin'), 400, 'OV_INVALID_REQUEST')

    const one = await call(users.root, 'GET', `/api/admin/data/tables/clubs/row?key=${encodeURIComponent(JSON.stringify({ id: club.id }))}`)
    assert.equal(one.status, 200, one.text)
    assert.equal(one.json.data.row.contact_email, 'info@example.ch')

    const up = await call(users.root, 'PATCH', '/api/admin/data/tables/clubs/row', { key: { id: club.id }, before: { contact_email: 'info@example.ch' }, set: { contact_email: 'board@example.ch' } })
    assert.equal(up.status, 200, up.text)
    assert.equal(up.json.data.row.contact_email, 'board@example.ch')
    const upd = await lastAudit('data.update')
    assert.deepEqual(upd.details.before, { contact_email: '[personal]' })

    // made from values that are no longer there: refused with the current ones
    const stale = await call(users.root, 'PATCH', '/api/admin/data/tables/clubs/row', { key: { id: club.id }, before: { contact_email: 'info@example.ch' }, set: { contact_email: 'x@example.ch' } })
    expectCode(stale, 409, 'OV_DATA_CHANGED')
    assert.deepEqual(stale.json.error.details.current, { contact_email: 'board@example.ch' })
    // the key is not changed; before is required; unknown columns refused
    expectCode(await call(users.root, 'PATCH', '/api/admin/data/tables/clubs/row', { key: { id: club.id }, before: { id: club.id }, set: { id: '00000000-0000-0000-0000-000000000001' } }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.root, 'PATCH', '/api/admin/data/tables/clubs/row', { key: { id: club.id }, set: { name: 'X' } }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(users.root, 'PATCH', '/api/admin/data/tables/clubs/row', { key: { id: club.id }, before: { nope: 1 }, set: { nope: 1 } }), 400, 'OV_INVALID_REQUEST')

    expectCode(await call(users.root, 'POST', '/api/admin/data/tables/clubs/row/delete', { key: { id: club.id } }), 400, 'OV_INVALID_REQUEST')
    const del = await call(users.root, 'POST', '/api/admin/data/tables/clubs/row/delete', { key: { id: club.id }, confirm: true })
    assert.equal(del.status, 200, del.text)
    assert.equal((await sql.query('SELECT 1 FROM public.clubs WHERE id = $1', [club.id])).rowCount, 0)
    const d = await lastAudit('data.delete')
    assert.equal(d.details.key.id, club.id)
    expectCode(await call(users.root, 'POST', '/api/admin/data/tables/clubs/row/delete', { key: { id: club.id }, confirm: true }), 404, 'OV_NOT_FOUND')
  })

  it('logs are read-only, also for a super admin', async () => {
    expectCode(await call(users.root, 'POST', '/api/admin/data/tables/audit_log/rows', { values: { action: 'x' } }), 409, 'OV_DATA_READ_ONLY')
    const { rows: [a] } = await sql.query('SELECT id FROM public.audit_log ORDER BY id DESC LIMIT 1')
    expectCode(await call(users.root, 'POST', '/api/admin/data/tables/audit_log/row/delete', { key: { id: a.id }, confirm: true }), 409, 'OV_DATA_READ_ONLY')
    const list = await call(users.root, 'GET', '/api/admin/data/tables/audit_log?limit=5')
    assert.equal(list.status, 200, list.text)
    assert.ok(list.json.data.rows.length > 0)
  })

  it('matches: typed values, no PIN, and the closed-match lock holds', async () => {
    const { rows: [m] } = await sql.query(
      `INSERT INTO public.matches (external_id, status, game_n, game_pin, test, officials) VALUES ($1, 'live', 4711, '123456', true, '{"r1":"A"}') RETURNING id`,
      [`match_${Date.now()}_${randomBytes(3).toString('hex')}`])
    const list = await call(users.root, 'GET', `/api/admin/data/tables/matches?col=id&op=eq&val=${m.id}`)
    assert.equal(list.status, 200, list.text)
    assert.equal(list.json.data.rows[0].game_n, 4711)
    assert.ok(!('game_pin' in list.json.data.rows[0]))
    // a search never reaches a PIN
    assert.equal((await call(users.root, 'GET', '/api/admin/data/tables/matches?q=123456')).json.data.total, 0)
    expectCode(await call(users.root, 'PATCH', '/api/admin/data/tables/matches/row', { key: { id: m.id }, before: { game_pin: null }, set: { game_pin: '1' } }), 400, 'OV_INVALID_REQUEST')

    // a number and a json value, typed by the column; the edit is audited with the match
    const up = await call(users.root, 'PATCH', '/api/admin/data/tables/matches/row', { key: { id: m.id }, before: { game_n: 4711, officials: { r1: 'A' } }, set: { game_n: '4712', officials: { r1: 'B' } } })
    assert.equal(up.status, 200, up.text)
    assert.equal(up.json.data.row.game_n, 4712)
    assert.deepEqual(up.json.data.row.officials, { r1: 'B' })
    assert.ok(!('game_pin' in up.json.data.row))
    const a = await lastAudit('data.update')
    assert.equal(a.match_id, m.id)
    assert.deepEqual(a.details.after, { game_n: 4712, officials: '[json]' })
    expectCode(await call(users.root, 'PATCH', '/api/admin/data/tables/matches/row', { key: { id: m.id }, before: { game_n: 4712 }, set: { game_n: 'many' } }), 400, 'OV_DATA_INVALID')

    // closed: the Data tab does not reopen (Closed matches does, and keeps the record)
    await sql.query('BEGIN')
    await sql.query("SELECT set_config('ov.allow_closed', 'on', true)")
    await sql.query("UPDATE public.matches SET status = 'final', closed_at = now() WHERE id = $1", [m.id])
    await sql.query('COMMIT')
    expectCode(await call(users.root, 'PATCH', '/api/admin/data/tables/matches/row', { key: { id: m.id }, before: { game_n: 4712 }, set: { game_n: 4713 } }), 409, 'OV_MATCH_CLOSED')
    expectCode(await call(users.root, 'POST', '/api/admin/data/tables/matches/row/delete', { key: { id: m.id }, confirm: true }), 409, 'OV_MATCH_CLOSED')
    assert.equal((await sql.query('SELECT game_n FROM public.matches WHERE id = $1', [m.id])).rows[0].game_n, 4712)
  })
})
