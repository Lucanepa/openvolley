/**
 * Throwaway Postgres databases for node:test.
 *
 * Set PG_TEST_URL (or TEST_DATABASE_URL) to a superuser connection string, e.g.
 *   docker run -d --rm --name ov-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:0:5432 postgres:17-alpine
 *   PG_TEST_URL=postgres://postgres:test@127.0.0.1:$(docker port ov-test-pg 5432 | cut -d: -f2)/postgres npm test
 *   docker stop ov-test-pg
 * Each test file gets its own database (created from tests/fixtures/synthetic_schema.sql)
 * and drops it at the end. Without the variable the Postgres suites are skipped.
 *
 * PG_TEST_TEMPLATE=<database> (same server): copy that database instead of
 * loading the synthetic schema, so the suites run against the real production
 * schema. Only the test-only objects (TEMPLATE_EXTRAS_SQL) are added, and
 * nothing may be connected to the template while the copies are made.
 *
 * REHEARSAL OR THROWAWAY CONTAINERS ONLY, NEVER THE PRODUCTION CLUSTER: the
 * suites create cluster-wide LOGIN roles with fixed passwords, add pgcrypto,
 * copy whatever users and password hashes the template holds into scratch
 * databases, and need the template idle (backend stopped). The template must
 * therefore be a scrubbed rehearsal restore, i.e. one loaded by
 *   scripts/migrate/restore.sh --scrub-except <email> ...
 * whose database comment ends in "(rehearsal, scrubbed)"; anything else is
 * refused. PG_TEST_TEMPLATE_UNSCRUBBED=1 lifts that check for a template you
 * built yourself from synthetic data in a throwaway container.
 */

import pg from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const PG_TEST_URL = process.env.PG_TEST_URL || process.env.TEST_DATABASE_URL || ''
export const SKIP_PG = PG_TEST_URL ? false : 'PG_TEST_URL not set (see tests/helpers/pgTestDb.js)'

export const PG_TEST_TEMPLATE = process.env.PG_TEST_TEMPLATE || ''
if (PG_TEST_TEMPLATE && !/^[a-z_][a-z0-9_]{0,62}$/.test(PG_TEST_TEMPLATE)) throw new Error('PG_TEST_TEMPLATE: not a plain database name')

const here = dirname(fileURLToPath(import.meta.url))
// The backend's own migrations that the synthetic schema does not carry
// (they run on the production database through restore.sh): applied after it,
// and after a template copy (all of them are idempotent).
// 007 needs 006's ov_touch_updated_at().
export const MIGRATIONS_SQL = ['005_match_ownership.sql', '006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql', '009_beach_saved_teams.sql', '010_auth_tokens.sql', '012_app_memberships.sql']
  .map((f) => readFileSync(join(here, '..', '..', 'db', f), 'utf8'))
  .join('\n')
const SYNTHETIC_SQL = readFileSync(join(here, '..', 'fixtures', 'synthetic_schema.sql'), 'utf8')
export const SCHEMA_SQL = SYNTHETIC_SQL + '\n' + MIGRATIONS_SQL
// The synthetic schema with 005 only (no 006 trigger, no 007): for the suites
// that test pgQuery's own behaviour without the later triggers.
export const SCHEMA_SQL_005_ONLY = SYNTHETIC_SQL + '\n' + readFileSync(join(here, '..', '..', 'db', '005_match_ownership.sql'), 'utf8')

// Test-only objects the synthetic schema has and a production copy does not:
// pgcrypto (crypt() in the auth tests) and a table that is NOT on the allowlist.
export const TEMPLATE_EXTRAS_SQL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE TABLE IF NOT EXISTS public.internal_notes (id serial PRIMARY KEY, note text);
  INSERT INTO public.internal_notes (note) VALUES ('do not leak');
` + MIGRATIONS_SQL

export const REHEARSAL_MARK = '(rehearsal, scrubbed)'

/** CREATE DATABASE for a test database: a copy of PG_TEST_TEMPLATE when set. */
export function createDatabaseSql (name, { useTemplate = true } = {}) {
  return useTemplate && PG_TEST_TEMPLATE
    ? `CREATE DATABASE "${name}" TEMPLATE "${PG_TEST_TEMPLATE}"`
    : `CREATE DATABASE "${name}"`
}

/** Throws unless PG_TEST_TEMPLATE is a scrubbed rehearsal restore (see the header). */
export async function assertRehearsalTemplate (admin) {
  if (!PG_TEST_TEMPLATE || process.env.PG_TEST_TEMPLATE_UNSCRUBBED === '1') return
  const { rows } = await admin.query(
    "SELECT coalesce(shobj_description(oid, 'pg_database'), '') AS mark FROM pg_database WHERE datname = $1",
    [PG_TEST_TEMPLATE])
  if (!rows.length) throw new Error(`PG_TEST_TEMPLATE: no database ${PG_TEST_TEMPLATE}`)
  if (!rows[0].mark.endsWith(REHEARSAL_MARK)) {
    throw new Error(`PG_TEST_TEMPLATE: ${PG_TEST_TEMPLATE} is not a scrubbed rehearsal restore ` +
      `(its comment is ${JSON.stringify(rows[0].mark)}). Use restore.sh --scrub-except in a throwaway ` +
      'container; never point the tests at the production cluster. See tests/helpers/pgTestDb.js.')
  }
}

/** Creates a test database on `admin`'s server: a copy of PG_TEST_TEMPLATE when set (checked first). */
export async function createDatabase (admin, name, { useTemplate = true } = {}) {
  if (useTemplate && PG_TEST_TEMPLATE) await assertRehearsalTemplate(admin)
  await admin.query(createDatabaseSql(name, { useTemplate }))
}

/** The schema SQL to load into a fresh test database (synthetic, or only the extras). */
export function testSchemaSql ({ useTemplate = true } = {}) {
  return useTemplate && PG_TEST_TEMPLATE ? TEMPLATE_EXTRAS_SQL : SCHEMA_SQL
}

export async function createTestDatabase (label, { schemaSql = SCHEMA_SQL } = {}) {
  const admin = new pg.Client({ connectionString: PG_TEST_URL })
  await admin.connect()
  const name = `ov_test_${label}_${process.pid}_${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  // A copy of the template replaces the default synthetic schema only.
  const fromTemplate = !!PG_TEST_TEMPLATE && schemaSql === SCHEMA_SQL
  try {
    await createDatabase(admin, name, { useTemplate: fromTemplate })
  } catch (err) {
    await admin.end().catch(() => {}) // an open client would keep the test process alive
    throw err
  }
  if (fromTemplate) schemaSql = TEMPLATE_EXTRAS_SQL
  const url = new URL(PG_TEST_URL)
  url.pathname = '/' + name
  if (schemaSql) {
    const c = new pg.Client({ connectionString: url.toString() })
    await c.connect()
    try { await c.query(schemaSql) } finally { await c.end() }
  }
  let appRole = null
  return {
    name,
    url: url.toString(),
    /**
     * A login role with only what the app needs (like the production `ov_app`):
     * USAGE on public, DML on its tables, USAGE on sequences. No DDL, no superuser,
     * nothing on `auth` or on `internal_notes`. Returns its connection string.
     */
    async createAppRole () {
      appRole = `${name}_app`
      await admin.query(`CREATE ROLE "${appRole}" LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE`)
      const c = new pg.Client({ connectionString: url.toString() })
      await c.connect()
      try {
        await c.query(`GRANT USAGE ON SCHEMA public TO "${appRole}";
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${appRole}";
          REVOKE ALL ON public.internal_notes FROM "${appRole}";
          GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appRole}";`)
      } finally { await c.end() }
      const u = new URL(url.toString())
      u.username = appRole
      u.password = 'app'
      return u.toString()
    },
    async drop () {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
        if (appRole) await admin.query(`DROP ROLE IF EXISTS "${appRole}"`)
      } finally { await admin.end() }
    }
  }
}

/** Logger that keeps test output quiet but remembers what was logged. */
export function quietLogger () {
  const lines = []
  const push = (lvl) => (...a) => lines.push(`${lvl} ${a.join(' ')}`)
  return { lines, log: push('log'), warn: push('warn'), error: push('error') }
}

/**
 * Give an account roles directly in SQL (new accounts have none since db/007:
 * they are pending and may only write test matches). Tests only.
 * @param {{query: Function}} db  pg Client/Pool or a connection string
 */
export async function grantRoles (db, userId, roles = ['scorer']) {
  if (typeof db === 'string') {
    const c = new pg.Client({ connectionString: db })
    await c.connect()
    try { return await grantRoles(c, userId, roles) } finally { await c.end() }
  }
  const r = await db.query('UPDATE public.profiles SET roles = $2::text[] WHERE user_id = $1', [userId, roles])
  if (r.rowCount === 0) await db.query('INSERT INTO public.profiles (user_id, roles) VALUES ($1, $2::text[])', [userId, roles])
}
