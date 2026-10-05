/**
 * runVmSync and db/003 against a real Postgres. Skipped without PG_TEST_URL
 * (or TEST_DATABASE_URL), a superuser URL:
 *
 *   docker run -d --rm --name ov-vmsync-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:0:5432 postgres:17-alpine
 *   PG_TEST_URL=postgres://postgres:test@127.0.0.1:$(docker port ov-vmsync-pg 5432 | cut -d: -f2)/postgres \
 *     node --test tests/vmSync.pg.test.js
 *   docker stop ov-vmsync-pg
 *
 * Each run creates its own database from tests/fixtures/svrz_schema.sql (the
 * production definitions) and drops it at the end. VolleyManager is the
 * in-memory fake: no network.
 *
 * With PG_TEST_TEMPLATE=<database> (a scrubbed rehearsal restore made by
 * scripts/migrate/restore.sh; see tests/helpers/pgTestDb.js) the database is a
 * copy of that one instead, and the sync runs as a login role that is only a
 * member of the restored ov_app, i.e. with exactly the grants db/roles.sql
 * gives the backend.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runVmSync, ADVISORY_LOCK_KEY } from '../lib/vmSync.js'
import { createFakeVolleyManager, makeGame, FAKE_USER, FAKE_PASSWORD } from './helpers/fakeVolleyManager.js'
import { PG_TEST_TEMPLATE, createDatabase } from './helpers/pgTestDb.js'

const PG_TEST_URL = process.env.PG_TEST_URL || process.env.TEST_DATABASE_URL || ''
const SKIP = PG_TEST_URL ? false : 'PG_TEST_URL not set (see the header of this file)'
const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(here, 'fixtures', 'svrz_schema.sql'), 'utf8')
const MIGRATION_SQL = readFileSync(join(here, '..', 'db', '003_svrz_games_local_time.sql'), 'utf8')

const http = { sleep: async () => {}, backoffMs: 1, timeoutMs: 5000 }
const creds = { username: FAKE_USER, password: FAKE_PASSWORD }
const quiet = { log() {}, warn() {}, error() {} }
const NOW = new Date('2026-10-05T04:00:00Z')

describe('vm-sync on Postgres', { skip: SKIP }, () => {
  let pg
  let admin
  let dbName
  let dbUrl
  let appUrl
  let appRole
  let noRlsRole
  let pool
  let ownerPool

  before(async () => {
    pg = (await import('pg')).default
    admin = new pg.Client({ connectionString: PG_TEST_URL })
    await admin.connect()
    dbName = `ov_test_vmsync_${process.pid}_${Date.now().toString(36)}`
    await createDatabase(admin, dbName) // a copy of PG_TEST_TEMPLATE when set
    const u = new URL(PG_TEST_URL)
    u.pathname = '/' + dbName
    dbUrl = u.toString()
    const c = new pg.Client({ connectionString: dbUrl })
    await c.connect()
    // A DML-only login role like the production ov_app: the sync must not need
    // more. svrz_games / svrz_sync_log have RLS enabled and no policies (as on
    // Supabase), so here the role needs BYPASSRLS, as Supabase's service_role
    // had. On the self-hosted database db/001_post_restore.sql disables RLS
    // instead (restore.sh verifies it) and ov_app has no BYPASSRLS. See the
    // 'without BYPASSRLS' test below for what happens with RLS still on.
    appRole = `${dbName}_app`
    noRlsRole = `${dbName}_norls`
    try {
      if (PG_TEST_TEMPLATE) {
        // The restored database: no RLS left (restore.sh checks that), and the
        // app role is nothing but ov_app.
        const { rows: [{ ok }] } = await admin.query(`SELECT count(*) = 1 AS ok FROM pg_roles WHERE rolname = 'ov_app'`)
        assert.ok(ok, 'PG_TEST_TEMPLATE: role ov_app missing (run db/roles.sql)')
        await admin.query(`CREATE ROLE "${appRole}" LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT IN ROLE ov_app`)
      } else {
        await c.query(SCHEMA_SQL)
        await admin.query(`CREATE ROLE "${appRole}" LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS`)
      }
      await admin.query(`CREATE ROLE "${noRlsRole}" LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
      for (const r of PG_TEST_TEMPLATE ? [noRlsRole] : [appRole, noRlsRole]) {
        await c.query(`GRANT USAGE ON SCHEMA public TO "${r}";
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${r}";
          GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${r}";`)
      }
    } finally { await c.end() }
    const a = new URL(dbUrl)
    a.username = appRole
    a.password = 'app'
    appUrl = a.toString()
    pool = new pg.Pool({ connectionString: appUrl, max: 4 }) // what runVmSync uses
    ownerPool = new pg.Pool({ connectionString: dbUrl, max: 2 }) // test setup / assertions
  })

  after(async () => {
    await pool?.end().catch(() => {})
    await ownerPool?.end().catch(() => {})
    if (admin) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
        await admin.query(`DROP ROLE IF EXISTS "${appRole}"`)
        await admin.query(`DROP ROLE IF EXISTS "${noRlsRole}"`)
      } finally { await admin.end() }
    }
  })

  const q = (text, params) => ownerPool.query(text, params)
  const reset = () => q('TRUNCATE public.svrz_games, public.svrz_sync_log RESTART IDENTITY')
  const sync = (vm, extra = {}) => runVmSync({
    pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: quiet, pageDelayMs: 0, ...extra
  })

  it('upserts on game_number and counts created / updated / unchanged', async () => {
    await reset()
    const games = [
      makeGame(5001, { startingDateTime: '2026-03-29T18:00:00Z' }),
      makeGame(5002, { startingDateTime: '2026-10-25T18:00:00Z', dob1: '05.03.1990' }),
      makeGame(5003, { startingDateTime: '2026-10-10T16:00:00.000Z' }),
      makeGame(5004, { shortName: 'NLA' })
    ]
    let r = await sync(createFakeVolleyManager({ games }), { batchSize: 2 })
    assert.equal(r.status, 'success', r.message)
    assert.deepEqual([r.created, r.updated, r.unchanged, r.excluded], [3, 0, 0, 1])

    const { rows } = await q(`SELECT game_number, date, "time", datetime, to_char(referee_1_dob, 'YYYY-MM-DD') AS dob, convocations
                                FROM public.svrz_games ORDER BY game_number`)
    assert.deepEqual(rows.map((x) => [x.game_number, x.date, x.time]), [
      ['5001', '29/03/2026', '20:00'],
      ['5002', '25/10/2026', '19:00'],
      ['5003', '10/10/2026', '18:00']
    ])
    assert.equal(rows[1].dob, '1990-03-05')
    assert.deepEqual(rows[0].convocations, ['Muster Anna'])

    // Same data again: nothing changes but synced_at
    r = await sync(createFakeVolleyManager({ games }))
    assert.deepEqual([r.created, r.updated, r.unchanged], [0, 0, 3])

    // One game moved, one new
    games[2] = makeGame(5003, { startingDateTime: '2026-10-10T17:30:00.000Z' })
    games.push(makeGame(5005))
    r = await sync(createFakeVolleyManager({ games }))
    assert.deepEqual([r.created, r.updated, r.unchanged], [1, 1, 2])
    const { rows: [moved] } = await q(`SELECT "time" FROM public.svrz_games WHERE game_number = '5003'`)
    assert.equal(moved.time, '19:30')

    const { rows: log } = await q('SELECT status, games_fetched, games_created, games_updated, games_unchanged, errors, finished_at FROM public.svrz_sync_log ORDER BY id')
    assert.equal(log.length, 3)
    assert.ok(log.every((l) => l.status === 'success' && l.finished_at && l.errors === 0))
    assert.deepEqual([log[2].games_fetched, log[2].games_created, log[2].games_updated, log[2].games_unchanged], [5, 1, 1, 2])
  })

  it('a failure after the running row closes it as failed without credentials', async () => {
    await reset()
    const r = await sync(createFakeVolleyManager({ password: 'not-this-one' }))
    assert.equal(r.status, 'failed')
    const { rows: [row] } = await q('SELECT status, finished_at, message FROM public.svrz_sync_log WHERE id = $1', [r.logId])
    assert.equal(row.status, 'failed')
    assert.ok(row.finished_at)
    assert.match(row.message, /login failed/)
    assert.ok(!row.message.includes(FAKE_PASSWORD))
    assert.ok(!row.message.includes(FAKE_USER))
    const { rows: [{ n }] } = await q(`SELECT count(*)::int AS n FROM public.svrz_sync_log WHERE status = 'running'`)
    assert.equal(n, 0)
  })

  it('closes abandoned running rows (older than an hour) before a run', async () => {
    await reset()
    await q(`INSERT INTO public.svrz_sync_log (status, started_at) VALUES ('running', now() - interval '3 hours'), ('running', now() - interval '5 minutes')`)
    const r = await sync(createFakeVolleyManager({ games: [] }))
    assert.equal(r.status, 'success')
    const { rows } = await q('SELECT id, status, message FROM public.svrz_sync_log ORDER BY id')
    assert.equal(rows[0].status, 'failed')
    assert.match(rows[0].message, /abandoned/)
    assert.equal(rows[1].status, 'running', 'a recent row is left alone')
    assert.equal(rows[2].status, 'success')
  })

  it('overlap lock: a second concurrent run is skipped, the lock is released afterwards', async () => {
    await reset()
    // Run A blocks inside VolleyManager until released
    let releaseA
    const gate = new Promise((r) => { releaseA = r })
    let enteredA
    const entered = new Promise((r) => { enteredA = r })
    const vmA = createFakeVolleyManager({ games: [makeGame(6001)] })
    const slowFetch = async (url, init) => { enteredA(); await gate; return vmA.fetch(url, init) }
    const runA = sync(vmA, { fetch: slowFetch })
    await entered

    const vmB = createFakeVolleyManager({ games: [makeGame(6002)] })
    const rB = await sync(vmB)
    assert.equal(rB.status, 'skipped')
    assert.equal(vmB.calls.length, 0)

    releaseA()
    const rA = await runA
    assert.equal(rA.status, 'success')
    const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM public.svrz_sync_log')
    assert.equal(n, 1, 'the skipped run wrote no log row')

    const { rows: [{ held }] } = await q(`SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory' AND granted`)
    assert.equal(held, 0, 'lock released')
    const rC = await sync(createFakeVolleyManager({ games: [] }))
    assert.equal(rC.status, 'success')
  })

  it('respects a lock held by another process', async () => {
    const other = new pg.Client({ connectionString: dbUrl })
    await other.connect()
    try {
      await other.query('SELECT pg_advisory_lock($1::bigint)', [ADVISORY_LOCK_KEY])
      const r = await sync(createFakeVolleyManager({ games: [] }))
      assert.equal(r.status, 'skipped')
    } finally {
      await other.end()
    }
  })

  it('db/003 recomputes date/time in Zurich and closes stuck rows, idempotently', async () => {
    await reset()
    // Rows as the Edge Function wrote them (formatted from UTC)
    await q(`INSERT INTO public.svrz_games (game_number, datetime, date, "time") VALUES
      ('7001', '2026-03-29T18:00:00Z',          '29/03/2026', '18:00'),
      ('7002', '2026-10-25T18:00:00.000Z',      '25/10/2026', '18:00'),
      ('7003', '2026-06-30T22:15:00.000Z',      '30/06/2026', '22:15'),
      ('7004', '2026-10-10T18:00:00+02:00',     '10/10/2026', '16:00'),
      ('7005', '2026-01-17T19:30:00',           '17/01/2026', '19:30'),
      ('7006', 'garbage',                       'x',          'y'),
      ('7007', NULL,                            NULL,         NULL),
      ('7008', '2026-02-30T10:00:00Z',          'a',          'b'),
      ('7009', '2026-10-10 18:00:00',           'c',          'd'),
      ('7010', '2026-10-10T24:00:00Z',          'e',          'f'),
      ('7011', '',                              '',           '')`)
    await q(`INSERT INTO public.svrz_sync_log (status, started_at, message) VALUES
      ('running', now() - interval '2 days', NULL),
      ('running', now() - interval '10 minutes', 'fresh'),
      ('success', now() - interval '2 days', 'ok')`)

    const owner = new pg.Client({ connectionString: dbUrl })
    await owner.connect()
    try {
      // A non-UTC session must not change the result (offset-less values are read as UTC)
      await owner.query(`SET TimeZone = 'America/New_York'`)
      await owner.query(MIGRATION_SQL)
      const { rows } = await q('SELECT game_number, date, "time" FROM public.svrz_games ORDER BY game_number')
      assert.deepEqual(rows.map((x) => [x.game_number, x.date, x.time]), [
        ['7001', '29/03/2026', '20:00'],
        ['7002', '25/10/2026', '19:00'],
        ['7003', '01/07/2026', '00:15'],
        ['7004', '10/10/2026', '18:00'],
        ['7005', '17/01/2026', '19:30'], // no zone: Zurich wall clock, already right
        ['7006', 'x', 'y'],
        ['7007', null, null],
        ['7008', 'a', 'b'], // out of range: the cast fails, the row is skipped, nothing aborts
        ['7009', 'c', 'd'],
        ['7010', 'e', 'f'],
        ['7011', '', '']
      ])
      const { rows: log } = await q('SELECT status, finished_at, message FROM public.svrz_sync_log ORDER BY id')
      assert.equal(log[0].status, 'failed')
      assert.ok(log[0].finished_at)
      assert.match(log[0].message, /closed by 003/)
      assert.equal(log[1].status, 'running')
      assert.equal(log[2].status, 'success')

      // Second run: no row changes
      const before = await q('SELECT xmin::text AS x FROM public.svrz_games ORDER BY game_number')
      await owner.query(MIGRATION_SQL)
      const afterRun = await q('SELECT xmin::text AS x FROM public.svrz_games ORDER BY game_number')
      assert.deepEqual(afterRun.rows, before.rows)

      // SET LOCAL stayed inside the migration's transaction
      const { rows: [{ TimeZone: tz }] } = await owner.query('SHOW TimeZone')
      assert.equal(tz, 'America/New_York')
    } finally {
      await owner.end()
    }

    // The migration and the sync agree: re-syncing the same games keeps date/time
    const vm = createFakeVolleyManager({ games: [
      makeGame(7001, { startingDateTime: '2026-03-29T18:00:00Z' }),
      makeGame(7005, { startingDateTime: '2026-01-17T19:30:00' })
    ] })
    const r = await sync(vm)
    assert.equal(r.status, 'success')
    assert.equal(r.offsetlessDatetimes, 1)
    const { rows: g } = await q(`SELECT game_number, date, "time" FROM public.svrz_games WHERE game_number IN ('7001', '7005') ORDER BY 1`)
    assert.deepEqual(g.map((x) => [x.game_number, x.date, x.time]), [['7001', '29/03/2026', '20:00'], ['7005', '17/01/2026', '19:30']])
  })

  it('without BYPASSRLS (RLS on, no policies) the run fails cleanly and releases the lock', {
    skip: PG_TEST_TEMPLATE ? 'restored database: restore.sh removes RLS, so ov_app needs no BYPASSRLS' : false
  }, async () => {
    await reset()
    const u = new URL(dbUrl)
    u.username = noRlsRole
    u.password = 'app'
    const noRlsPool = new pg.Pool({ connectionString: u.toString(), max: 2 })
    try {
      const vm = createFakeVolleyManager({ games: [makeGame(8001)] })
      const r = await runVmSync({ pool: noRlsPool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: quiet, pageDelayMs: 0 })
      assert.equal(r.status, 'failed')
      assert.equal(r.logId, null)
      assert.match(r.error, /row-level security/)
      assert.equal(vm.calls.length, 0, 'no VM traffic')
    } finally {
      await noRlsPool.end()
    }
    const { rows: [{ held }] } = await q(`SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory' AND granted`)
    assert.equal(held, 0)
  })

  it('a connection killed during the VM phase does not crash the process; the row is closed on a fresh connection', async () => {
    await reset()
    const lines = []
    const logger = { log() {}, warn: (m) => lines.push(m), error: (m) => lines.push(m) }
    let releaseVm
    const gate = new Promise((r) => { releaseVm = r })
    let enteredVm
    const entered = new Promise((r) => { enteredVm = r })
    const vm = createFakeVolleyManager({ games: [makeGame(9001)] })
    const slowFetch = async (url, init) => { enteredVm(); await gate; return vm.fetch(url, init) }
    const run = sync(vm, { fetch: slowFetch, logger })
    try {
      await entered
      // The run's connection is idle (checked out, holding the lock): kill it
      const { rows: [{ pid }] } = await q(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted`)
      await q('SELECT pg_terminate_backend($1)', [pid])
      for (let i = 0; i < 100 && !lines.some((l) => /database connection lost/.test(l)); i++) {
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.ok(lines.some((l) => /database connection lost/.test(l)), 'the error event was handled')
    } finally {
      releaseVm()
    }
    const r = await run
    assert.equal(r.status, 'failed')
    const { rows: [row] } = await q('SELECT status, finished_at FROM public.svrz_sync_log WHERE id = $1', [r.logId])
    assert.equal(row.status, 'failed')
    assert.ok(row.finished_at, 'closed on a fresh connection')

    // The dead client was discarded: the pool still works and the next run succeeds
    const next = await sync(createFakeVolleyManager({ games: [makeGame(9002)] }))
    assert.equal(next.status, 'success')
  })
})
