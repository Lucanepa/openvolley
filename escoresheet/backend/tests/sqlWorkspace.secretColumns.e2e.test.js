/**
 * The SQL tab's write mode never gives out a secret column (audit SEC-40).
 * Write mode runs as the app role, which reads every column; only names were
 * checked, so `SELECT * FROM matches` (and t.*, a whole row, row_to_json)
 * returned game_pin and connection_pins, club_api_tokens.token_hash and
 * invite_codes.code_hash, even in a preview. From the audit's
 * poc/sql-admin/sql.mjs. Now SELECT * and RETURNING * leave them out, and
 * whatever reaches one without its name is refused before anything runs.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles, readonlyRoleOf } from './helpers/pgTestDb.js'
import { checkWriteScope, checkPlanSecrets } from '../lib/sqlWorkspace.js'

const SECRET_NAMES = new Set(['matches', 'club_api_tokens', 'invite_codes'])

describe('sqlWorkspace write mode: secret columns (unit)', () => {
  it('renamed columns are refused on a statement that reads a table with secret columns', () => {
    for (const bad of ['select x.d from matches as x(a, b, c, d)', 'select d from public.matches m (a, b, c, d)',
      'with t (a, b, c, d) as (select * from matches) select d from t',
      'with t (a) as materialized (select * from matches) select a from t',
      'select s.d from (select * from matches limit 1) as s (a, b, c, d)',
      'select s.d from (select * from matches limit 1) s (a, b, c, d)']) {
      assert.equal(checkWriteScope(bad, { secretRelations: SECRET_NAMES })?.code, 'column_alias_not_allowed', bad)
    }
    for (const good of ['select count(*) filter (where status = \'live\') over (partition by status) from matches',
      'select cast((game_n) as numeric(6, 1)) from matches', 'insert into matches as m (external_id) values (\'x\')',
      "update matches set status = 'final' where (id, status) in (select id, status from matches)",
      'select x.d from clubs as x(a, b, c, d)', 'select * from matches m join clubs c using (id)']) {
      assert.equal(checkWriteScope(good, { secretRelations: SECRET_NAMES }), null, good)
    }
  })

  it('the plan: a whole row or a secret column in an expression is refused; a plain output column is not', () => {
    const S = new Set(['public.matches'])
    const scan = (over) => [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'matches', Schema: 'public', Alias: 'm', ...over } }]
    assert.equal(checkPlanSecrets(scan({ Output: ['id', 'game_pin', 'm.connection_pins'] }), { secretRelations: S }), null)
    assert.equal(checkPlanSecrets(scan({ Output: ['m.*'] }), { secretRelations: S })?.code, 'whole_row_not_allowed')
    assert.equal(checkPlanSecrets(scan({ Output: ["(row_to_json(m.*) ->> 'game_pin'::text)"] }), { secretRelations: S })?.code, 'whole_row_not_allowed')
    assert.equal(checkPlanSecrets(scan({ Output: ['ROW(id, game_pin)'] }), { secretRelations: S })?.code, 'secret_column_not_allowed')
    assert.equal(checkPlanSecrets(scan({ Output: ['id'], Filter: "(game_pin ~~ 'h1:a%'::text)" }), { secretRelations: S })?.code, 'secret_column_not_allowed')
    assert.equal(checkPlanSecrets(scan({ Output: ['id'], Filter: "(note = 'game_pin'::text)" }), { secretRelations: S }), null, 'a literal is no column')
    const clubs = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'clubs', Schema: 'public', Alias: 'c', Output: ['row_to_json(c.*)'] } }]
    assert.equal(checkPlanSecrets(clubs, { secretRelations: S }), null)
    // a write may not carry a secret column on into what it writes
    const copy = [{ Plan: { 'Node Type': 'ModifyTable', Operation: 'Insert', 'Relation Name': 'clubs', Schema: 'public', Alias: 'clubs', Plans: [scan({ Output: ['m.game_pin'] })[0].Plan] } }]
    assert.equal(checkPlanSecrets(copy, { secretRelations: S })?.code, 'secret_column_not_allowed')
    const returning = [{ Plan: { 'Node Type': 'ModifyTable', Operation: 'Update', 'Relation Name': 'matches', Schema: 'public', Alias: 'matches', Output: ['id', 'game_pin'], Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'matches', Schema: 'public', Alias: 'matches', Output: ["'final'::text", 'ctid'] }] } }]
    assert.equal(checkPlanSecrets(returning, { secretRelations: S }), null, 'RETURNING *: left out of the answer')
  })
})

describe('sqlWorkspace write mode: secret columns end to end', { skip: SKIP }, () => {
  let db, srv, sql, root, matchId, club
  const runSql = (body) => api(srv.base, '/api/admin/sql', { method: 'POST', token: root.token, body, proto: '2' })
  const write = (text) => runSql({ sql: text, write_mode: true })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const SECRET = /(^|_)(pin|pins|password|secret|token|salt|mac)(_|$)|(^|_)hash$/

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    const appUrl = db.appUrl()
    srv = await bootServer({ DATABASE_URL: appUrl, OV_SQL_READER_ROLE: readonlyRoleOf(new URL(appUrl).username), TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    const email = `root-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': '198.51.100.40' }, body: { email, password, metadata: { first_name: 'Root', last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': '198.51.100.40' }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    root = { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
    await grantRoles(sql, root.id, ['super_admin'])
    ;({ rows: [club] } = await sql.query("INSERT INTO public.clubs (name, contact_email) VALUES ('VBC Geheim', 'info@example.ch') RETURNING id"))
    ;({ rows: [{ id: matchId }] } = await sql.query(
      `INSERT INTO public.matches (external_id, status, game_n, game_pin, test) VALUES ($1, 'live', 5160, 'h1:not-for-the-console', true) RETURNING id`,
      [`match_${Date.now()}_${randomBytes(3).toString('hex')}`]))
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('SELECT * (the audit\'s PoC) answers every column but the secret ones', async () => {
    const r = await write('SELECT * FROM matches WHERE game_n = 5160 LIMIT 1')
    assert.equal(r.status, 200, r.text)
    const { columns, rows, hidden_columns: hidden } = r.json.data
    assert.ok(columns.includes('external_id') && columns.includes('status'))
    assert.ok(!columns.some((c) => SECRET.test(c)), columns.join())
    assert.ok(hidden.includes('game_pin'), JSON.stringify(hidden))
    assert.ok(!JSON.stringify(rows).includes('not-for-the-console'))
    for (const text of ['SELECT m.* FROM matches m WHERE m.game_n = 5160', 'TABLE matches', 'SELECT * FROM (SELECT * FROM matches LIMIT 5) s',
      'WITH t AS (SELECT * FROM matches) SELECT * FROM t', 'SELECT (m).* FROM matches m']) {
      const x = await write(text)
      assert.equal(x.status, 200, `${text}: ${x.text}`)
      assert.ok(!x.json.data.columns.some((c) => SECRET.test(c)), text)
      assert.ok(!JSON.stringify(x.json.data.rows).includes('not-for-the-console'), text)
    }
    // the tables of the other secret columns too
    for (const table of ['club_api_tokens', 'invite_codes']) {
      const x = await write(`SELECT * FROM ${table} LIMIT 1`)
      assert.equal(x.status, 200, x.text)
      assert.ok(!x.json.data.columns.some((c) => SECRET.test(c)), `${table}: ${x.json.data.columns}`)
    }
  })

  it('RETURNING * leaves them out too, and the write itself is untouched', async () => {
    const r = await write(`UPDATE matches SET status = status WHERE id = '${matchId}' RETURNING *`)
    assert.equal(r.status, 200, r.text)
    assert.ok(!r.json.data.columns.some((c) => SECRET.test(c)))
    assert.ok(r.json.data.hidden_columns.includes('game_pin'))
  })

  it('a secret column reached without its name is refused before anything runs', async () => {
    for (const [text, code] of [
      ['SELECT m FROM matches m', 'whole_row_not_allowed'],
      ['SELECT row_to_json(m) FROM matches m', 'whole_row_not_allowed'],
      ["SELECT row_to_json(m)->>'game_pin' FROM matches m", 'whole_row_not_allowed'],
      ['SELECT m::text FROM matches m', 'whole_row_not_allowed'],
      ['SELECT ROW(m.*) FROM matches m', 'secret_column_not_allowed'],
      ['SELECT concat_ws(\',\', m.*) FROM matches m', 'whole_row_not_allowed'],
      ['WITH t AS MATERIALIZED (SELECT * FROM matches) SELECT row_to_json(t) FROM t', 'whole_row_not_allowed'],
      ['SELECT to_jsonb(t) FROM club_api_tokens t', 'whole_row_not_allowed'],
      ['SELECT x.d FROM matches AS x(a, b, c, d)', 'column_alias_not_allowed'],
      ["WITH t (a, b, c, d) AS (SELECT * FROM matches) SELECT d || '' FROM t", 'column_alias_not_allowed'],
      ['INSERT INTO clubs (name) SELECT concat(m.*) FROM matches m', 'whole_row_not_allowed'],
      ['DECLARE c CURSOR FOR SELECT m FROM matches m; FETCH ALL FROM c', 'whole_row_not_allowed']
    ]) {
      expectCode(await write(text), 400, code)
    }
    // with commit: refused the same, and nothing was written
    const before = (await sql.query('SELECT count(*)::int AS n FROM public.clubs')).rows[0].n
    expectCode(await runSql({ sql: 'INSERT INTO clubs (name) SELECT concat(m.*) FROM matches m', write_mode: true, commit: true }), 400, 'whole_row_not_allowed')
    expectCode(await runSql({ sql: 'INSERT INTO clubs (name) SELECT concat_ws(\',\', external_id, connection_pins) FROM matches', write_mode: true, commit: true }), 400, 'secret_column_not_allowed')
    expectCode(await runSql({ sql: 'INSERT INTO clubs (name) SELECT ROW(m.*)::text FROM matches m', write_mode: true, commit: true }), 400, 'secret_column_not_allowed')
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM public.clubs')).rows[0].n, before)
  })

  it('everything else of write mode works as before', async () => {
    for (const text of ['SELECT id, external_id FROM matches m WHERE m.game_n = 5160', 'SELECT count(*) FROM matches',
      'SELECT row_to_json(c) FROM clubs c', 'SELECT cast((game_n) AS numeric(6, 1)) FROM matches',
      "SELECT count(*) FILTER (WHERE status = 'live') FROM matches", 'SELECT status, count(*) FROM matches GROUP BY status ORDER BY 1',
      `UPDATE clubs SET contact_email = contact_email WHERE id = '${club.id}'`,
      `DELETE FROM clubs WHERE id = '${club.id}' AND false`]) {
      const r = await write(text)
      assert.equal(r.status, 200, `${text}: ${r.text}`)
      assert.equal(r.json.data.hidden_columns, undefined, text)
    }
    // a statement Postgres refuses keeps its own error
    expectCode(await write('SELECT nope FROM matches'), 400, '42703')
    // read mode is unchanged
    const read = await runSql({ sql: 'SELECT * FROM matches WHERE game_n = 5160' })
    assert.equal(read.status, 200, read.text)
    assert.ok(!read.json.data.columns.includes('game_pin'))
  })
})
