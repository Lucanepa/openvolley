/**
 * The SQL tab's write mode never gives out a secret column (audit SEC-40).
 * Write mode ran as the app role, which reads every column; only names were
 * checked, so `SELECT * FROM matches` (and t.*, a whole row, row_to_json)
 * returned game_pin and connection_pins, club_api_tokens.token_hash and
 * invite_codes.code_hash, even in a preview. From the audit's
 * poc/sql-admin/sql.mjs.
 *
 * A first fix read each statement's plan and left the secret columns out of
 * the answer by their origin. Its review found both sides wrong: a set
 * operation whose first branch gives harmless names (`SELECT NULL AS a, ...
 * WHERE false UNION ALL SELECT * FROM matches`) still returned game_pin (its
 * columns have no origin), and ordinary repairs were refused (UPDATE ...
 * FROM (VALUES ...) v(id, s), WHERE id IN (SELECT ... GROUP BY ...)). Now
 * write mode runs as ov_sql_writer (db/roles.sql): ov_app's grants without
 * SELECT of a secret column, so Postgres itself refuses whatever reads one,
 * and the views of ov_write give the tables by their plain names without
 * them. Every case of the first fix's test is kept here with what it does
 * now: by the plain name it answers without the secret columns, on
 * public.<table> Postgres refuses it (42501).
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles, readonlyRoleOf, writerRoleOf } from './helpers/pgTestDb.js'
import { checkWriteScope } from '../lib/sqlWorkspace.js'

const SECRET = /(^|_)(pin|pins|password|secret|token|salt|mac)(_|$)|(^|_)hash$/

describe('sqlWorkspace write mode: secret columns (unit)', () => {
  it('a secret column or auth named in the statement is refused; alias lists are left to Postgres', () => {
    for (const bad of ['select game_pin from matches', 'update matches set connection_pins = null',
      'select "token_hash" from club_api_tokens', 'select 1 as pin']) {
      assert.equal(checkWriteScope(bad)?.code, 'secret_column_not_allowed', bad)
    }
    assert.equal(checkWriteScope('select email from auth.users')?.code, 'auth_not_allowed')
    // alias lists the first fix refused: the writer role decides what they may read
    for (const good of ['select x.d from matches as x(a, b, c, d)', "update matches set status = v.s from (values (1, 'final')) v(id, s) where matches.game_n = v.id",
      'with t (a, b) as (select id, status from matches) select a from t', "select row_to_json(m)->>'game_pin' from matches m"]) {
      assert.equal(checkWriteScope(good), null, good)
    }
  })
})

describe('sqlWorkspace write mode: secret columns end to end', { skip: SKIP }, () => {
  let db, srv, sql, root, matchId, club, appRole, writerRole, matchCols
  const TOKEN_HEX = createHash('sha256').update('ovk_not-for-the-console').digest('hex')
  const runSql = (body) => api(srv.base, '/api/admin/sql', { method: 'POST', token: root.token, body, proto: '2' })
  const write = (text) => runSql({ sql: text, write_mode: true })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  /** 200 without a secret column or value, or Postgres' own refusal (42501): never the secret */
  const neverSecret = (r, text) => {
    assert.ok(!r.text.includes('not-for-the-console') && !r.text.includes(TOKEN_HEX), `${text}: ${r.text}`)
    if (r.status === 200) assert.ok(!r.json.data.columns.some((c) => SECRET.test(c)), `${text}: ${r.json.data.columns}`)
    else expectCode(r, 400, '42501')
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    const appUrl = db.appUrl()
    appRole = new URL(appUrl).username
    writerRole = writerRoleOf(appRole)
    srv = await bootServer({ DATABASE_URL: appUrl, OV_SQL_READER_ROLE: readonlyRoleOf(appRole), OV_SQL_WRITER_ROLE: writerRole, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
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
      `INSERT INTO public.matches (external_id, status, game_n, game_pin, connection_pins, test)
       VALUES ($1, 'live', 5160, 'h1:not-for-the-console', '{"referee": "h1:not-for-the-console"}', true) RETURNING id`,
      [`match_${Date.now()}_${randomBytes(3).toString('hex')}`]))
    await sql.query(`INSERT INTO public.club_api_tokens (club_id, created_by, label, prefix, token_hash, scopes)
      VALUES ($1, $2, 'audit', 'ovk_', decode($3, 'hex'), ARRAY['read'])`, [club.id, root.id, TOKEN_HEX])
    await sql.query(`INSERT INTO public.match_approvals (match_id, slot, display_name, match_status, result_key, result_hash)
      SELECT $1, s, 'Rita Referee', 'live', 'x', decode(repeat('ab', 32), 'hex') FROM unnest(ARRAY['referee1', 'referee2']) s`, [matchId])
    ;({ rows: [{ n: matchCols }] } = await sql.query(
      "SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = 'public.matches'::regclass AND attnum > 0 AND NOT attisdropped"))
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('roles.sql: the writer has the app role\'s grants on public, but SELECT of a secret column, and nothing of auth', async () => {
    const { rows } = await sql.query(
      `SELECT c.relname, a.attname, p.priv,
              has_column_privilege($1, c.oid, a.attnum, p.priv) AS app,
              has_column_privilege($2, c.oid, a.attnum, p.priv) AS writer
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p(priv)
        WHERE c.relkind IN ('r', 'p')`, [appRole, writerRole])
    assert.ok(rows.length > 100)
    for (const r of rows) {
      const want = r.priv === 'SELECT' && SECRET.test(r.attname) ? false : r.app
      assert.equal(r.writer, want, `${r.relname}.${r.attname} ${r.priv}: app ${r.app}, writer ${r.writer}`)
    }
    const { rows: tables } = await sql.query(
      `SELECT c.relname, has_table_privilege($1, c.oid, 'DELETE') AS app, has_table_privilege($2, c.oid, 'DELETE') AS writer
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public' WHERE c.relkind IN ('r', 'p')`, [appRole, writerRole])
    for (const t of tables) assert.equal(t.writer, t.app, `${t.relname} DELETE`)
    const { rows: [auth] } = await sql.query(
      "SELECT has_table_privilege($1, 'auth.users', 'SELECT') AS users, has_table_privilege($1, 'auth.app_sessions', 'SELECT') AS sessions, has_schema_privilege($1, 'auth', 'USAGE') AS usage",
      [writerRole])
    assert.deepEqual(auth, { users: false, sessions: false, usage: false })
    // the app role may SET ROLE to it and inherits nothing
    const { rows: [m] } = await sql.query(
      'SELECT m.inherit_option, m.set_option, m.admin_option FROM pg_auth_members m WHERE m.roleid = $1::regrole AND m.member = $2::regrole', [writerRole, appRole])
    assert.deepEqual(m, { inherit_option: false, set_option: true, admin_option: false })
  })

  it('SELECT * (the audit\'s PoC) answers every column but the secret ones', async () => {
    const r = await write('SELECT * FROM matches WHERE game_n = 5160 LIMIT 1')
    assert.equal(r.status, 200, r.text)
    const { columns, rows } = r.json.data
    assert.ok(columns.includes('external_id') && columns.includes('status'))
    assert.equal(rows.length, 1)
    neverSecret(r, 'SELECT *')
    for (const text of ['SELECT m.* FROM matches m WHERE m.game_n = 5160', 'TABLE matches', 'SELECT * FROM (SELECT * FROM matches LIMIT 5) s',
      'WITH t AS (SELECT * FROM matches) SELECT * FROM t', 'SELECT (m).* FROM matches m']) {
      const x = await write(text)
      assert.equal(x.status, 200, `${text}: ${x.text}`)
      neverSecret(x, text)
    }
    // the tables of the other secret columns too
    for (const table of ['club_api_tokens', 'invite_codes', 'match_approvals', 'game_rosters', 'global_matches']) {
      const x = await write(`SELECT * FROM ${table} LIMIT 1`)
      assert.equal(x.status, 200, x.text)
      neverSecret(x, table)
    }
    // the table itself: Postgres refuses the secret columns
    for (const text of ['SELECT * FROM public.matches', 'SELECT * FROM public.club_api_tokens', 'TABLE public.invite_codes']) {
      expectCode(await write(text), 400, '42501')
    }
  })

  it('RETURNING * leaves them out too, and the write itself is untouched', async () => {
    const r = await write(`UPDATE matches SET status = status WHERE id = '${matchId}' RETURNING *`)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.rows.length, 1)
    neverSecret(r, 'RETURNING *')
  })

  it('set operations whose first branch gives harmless names (the review\'s UNION case)', async () => {
    const nulls = (n) => Array.from({ length: n }, (_, i) => `NULL AS c${i}`).join(', ')
    const viewCols = (await write('SELECT * FROM matches LIMIT 0')).json.data.columns.length
    assert.equal(viewCols, matchCols - 2, 'matches by its plain name: all but game_pin and connection_pins')
    for (const text of [
      `SELECT ${nulls(matchCols)} WHERE false UNION ALL SELECT * FROM public.matches`,
      `SELECT ${nulls(viewCols)} WHERE false UNION ALL SELECT * FROM matches`,
      'SELECT * FROM public.club_api_tokens EXCEPT SELECT * FROM public.club_api_tokens WHERE false',
      'SELECT * FROM public.club_api_tokens INTERSECT SELECT * FROM public.club_api_tokens',
      'SELECT * FROM club_api_tokens INTERSECT SELECT * FROM club_api_tokens',
      'SELECT * FROM club_api_tokens UNION SELECT * FROM club_api_tokens',
      'WITH RECURSIVE r AS (SELECT * FROM public.club_api_tokens UNION ALL SELECT * FROM r WHERE false) SELECT * FROM r',
      'WITH RECURSIVE r AS (SELECT * FROM club_api_tokens UNION ALL SELECT * FROM r WHERE false) SELECT * FROM r',
      `WITH RECURSIVE r AS (SELECT ${nulls(matchCols)} WHERE false UNION ALL SELECT * FROM public.matches) SELECT * FROM r`
    ]) {
      neverSecret(await write(text), text)
    }
    // the review's case itself, on the table: refused
    expectCode(await write(`SELECT ${nulls(matchCols)} WHERE false UNION ALL SELECT * FROM public.matches`), 400, '42501')
    expectCode(await write('SELECT * FROM public.club_api_tokens EXCEPT SELECT * FROM public.club_api_tokens WHERE false'), 400, '42501')
    // by the plain name it answers, without the secret
    const ok = await write(`SELECT ${nulls(viewCols)} WHERE false UNION ALL SELECT * FROM matches WHERE game_n = 5160`)
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.data.rows.length, 1)
  })

  it('a secret column reached without its name: never answered, never written', async () => {
    // the first fix's cases: by the plain name a whole row has no secret column; on the table Postgres refuses
    for (const text of [
      'SELECT m FROM matches m', 'SELECT row_to_json(m) FROM matches m', "SELECT row_to_json(m)->>'game_pin' FROM matches m",
      'SELECT m::text FROM matches m', 'SELECT ROW(m.*) FROM matches m', "SELECT concat_ws(',', m.*) FROM matches m",
      'WITH t AS MATERIALIZED (SELECT * FROM matches) SELECT row_to_json(t) FROM t', 'SELECT to_jsonb(t) FROM club_api_tokens t',
      'SELECT x.d FROM matches AS x(a, b, c, d)', "WITH t (a, b, c, d) AS (SELECT * FROM matches) SELECT d || '' FROM t",
      'DECLARE c CURSOR FOR SELECT m FROM matches m; FETCH ALL FROM c'
    ]) {
      const r = await write(text)
      assert.equal(r.status, 200, `${text}: ${r.text}`)
      neverSecret(r, text)
    }
    for (const text of [
      'SELECT m FROM public.matches m', 'SELECT row_to_json(m) FROM public.matches m', 'SELECT m::text FROM public.matches m',
      'SELECT ROW(m.*) FROM public.matches m', "SELECT concat_ws(',', m.*) FROM public.matches m", 'SELECT to_jsonb(t) FROM public.club_api_tokens t',
      'SELECT x.d FROM public.matches AS x(a, b, c, d)', 'WITH t AS MATERIALIZED (SELECT * FROM public.matches) SELECT row_to_json(t) FROM t',
      'DECLARE c CURSOR FOR SELECT m FROM public.matches m; FETCH ALL FROM c'
    ]) {
      expectCode(await write(text), 400, '42501')
    }
    // with commit: a copy of a secret into a column we may read is refused, and nothing was written
    const before = (await sql.query('SELECT count(*)::int AS n FROM public.clubs')).rows[0].n
    for (const text of ['INSERT INTO clubs (name) SELECT concat(m.*) FROM public.matches m', 'INSERT INTO clubs (name) SELECT ROW(m.*)::text FROM public.matches m',
      'INSERT INTO clubs (name) SELECT left(t::text, 60) FROM public.club_api_tokens t']) {
      expectCode(await runSql({ sql: text, write_mode: true, commit: true }), 400, '42501')
    }
    // a script is refused whole: the write before the refused statement is rolled back
    expectCode(await runSql({ sql: "INSERT INTO clubs (name) VALUES ('VBC Vorher'); SELECT row_to_json(m) FROM public.matches m", write_mode: true, commit: true }), 400, '42501')
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM public.clubs')).rows[0].n, before)
    // a whole row by the plain name may be written: it has no secret in it
    const copy = await write('INSERT INTO clubs (name) SELECT left(concat(m.*), 60) FROM matches m WHERE m.game_n = 5160 RETURNING name')
    assert.equal(copy.status, 200, copy.text)
    neverSecret(copy, 'copy of a whole row')
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM public.clubs')).rows[0].n, before, 'a preview')
  })

  it('everything else of write mode works as before (the review\'s repairs too)', async () => {
    for (const text of ['SELECT id, external_id FROM matches m WHERE m.game_n = 5160', 'SELECT count(*) FROM matches',
      'SELECT row_to_json(c) FROM clubs c', 'SELECT cast((game_n) AS numeric(9, 1)) FROM matches',
      "SELECT count(*) FILTER (WHERE status = 'live') FROM matches", 'SELECT status, count(*) FROM matches GROUP BY status ORDER BY 1',
      `UPDATE clubs SET contact_email = contact_email WHERE id = '${club.id}'`,
      `DELETE FROM clubs WHERE id = '${club.id}' AND false`,
      // the review (ET-2): repairs the first fix refused
      "UPDATE matches SET status = 'live' WHERE game_n = 5160 AND id IN (SELECT match_id FROM match_approvals GROUP BY match_id HAVING count(*) = 2)",
      "UPDATE matches SET status = v.s FROM (VALUES (5160, 'live'), (5161, 'final')) v(id, s) WHERE matches.game_n = v.id",
      "UPDATE matches SET status = 'live' FROM (SELECT DISTINCT id FROM matches) s WHERE matches.id = s.id AND matches.game_n = 5160",
      'UPDATE sets SET home_points = home_points WHERE match_id IN (SELECT id FROM matches WHERE game_n = 5160 GROUP BY id)',
      "UPDATE public.matches SET status = 'live' WHERE game_n = 5160 RETURNING id, status",
      `DELETE FROM matches WHERE id = '${matchId}' AND false RETURNING *`,
      // writes through the plain name: the table's defaults, upserts and MERGE
      "INSERT INTO matches (external_id, status, game_n, test) VALUES ('sql_tab_new', 'setup', 5170, true) RETURNING id, created_at IS NOT NULL AS dated",
      `INSERT INTO matches (external_id, status, game_n, test) SELECT external_id, 'live', 5160, true FROM matches WHERE id = '${matchId}'
         ON CONFLICT (external_id) DO UPDATE SET status = excluded.status RETURNING *`,
      `MERGE INTO matches m USING (VALUES ('${matchId}'::uuid)) v(id) ON m.id = v.id WHEN MATCHED THEN UPDATE SET status = 'live'`,
      // a statement may use what an earlier one of the run made
      'DECLARE c CURSOR FOR SELECT id, name FROM clubs FOR UPDATE; FETCH NEXT FROM c; UPDATE clubs SET name = name WHERE CURRENT OF c',
      'DECLARE c CURSOR FOR SELECT id, external_id FROM matches; FETCH ALL FROM c']) {
      const r = await write(text)
      assert.equal(r.status, 200, `${text}: ${r.text}`)
      neverSecret(r, text)
    }
    const fresh = await write("INSERT INTO matches (external_id, status, game_n, test) VALUES ('sql_tab_new', 'setup', 5170, true) RETURNING id")
    assert.match(fresh.json.data.rows[0][0], /^[0-9a-f-]{36}$/, 'the table\'s default id')
    // a statement Postgres refuses keeps its own error
    expectCode(await write('SELECT nope FROM matches'), 400, '42703')
    // the game PIN is untouched by all of it
    assert.equal((await sql.query('SELECT game_pin FROM public.matches WHERE id = $1', [matchId])).rows[0].game_pin, 'h1:not-for-the-console')
    // read mode is unchanged
    const read = await runSql({ sql: 'SELECT * FROM matches WHERE game_n = 5160' })
    assert.equal(read.status, 200, read.text)
    assert.ok(!read.json.data.columns.includes('game_pin'))
  })

  it('a refused SELECT on public.<table> says where to look', async () => {
    const r = await write('SELECT * FROM public.matches')
    expectCode(r, 400, '42501')
    assert.match(r.json.error.details.hint, /plain names \(matches, not public\.matches\)/)
  })
})
