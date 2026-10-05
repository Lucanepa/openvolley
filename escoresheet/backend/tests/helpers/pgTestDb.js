/**
 * Throwaway Postgres databases for node:test.
 *
 * Set PG_TEST_URL (or TEST_DATABASE_URL) to a superuser connection string, e.g.
 *   docker run -d --rm --name ov-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:0:5432 postgres:17-alpine
 *   PG_TEST_URL=postgres://postgres:test@127.0.0.1:$(docker port ov-test-pg 5432 | cut -d: -f2)/postgres npm test
 *   docker stop ov-test-pg
 * Each test file gets its own database (created from tests/fixtures/synthetic_schema.sql)
 * and drops it at the end. Without the variable the Postgres suites are skipped.
 */

import pg from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const PG_TEST_URL = process.env.PG_TEST_URL || process.env.TEST_DATABASE_URL || ''
export const SKIP_PG = PG_TEST_URL ? false : 'PG_TEST_URL not set (see tests/helpers/pgTestDb.js)'

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(here, '..', 'fixtures', 'synthetic_schema.sql'), 'utf8')

export async function createTestDatabase (label, { schemaSql = SCHEMA_SQL } = {}) {
  const admin = new pg.Client({ connectionString: PG_TEST_URL })
  await admin.connect()
  const name = `ov_test_${label}_${process.pid}_${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  await admin.query(`CREATE DATABASE "${name}"`)
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
