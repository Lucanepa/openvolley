#!/usr/bin/env node
/**
 * Is the database what this image expects? (lib/schemaVersion.js)
 *
 *   - every db/NNN_*.sql of this image recorded as applied in
 *     ov_meta.schema_migrations (scripts/migrate.mjs), none changed since,
 *   - the guard triggers there and enabled, calling their function
 *     (REQUIRED_TRIGGERS), the unique indexes there and valid
 *     (REQUIRED_INDEXES), the trigger functions of db/current_definitions.sql
 *     in their current form (an older migration run again by hand puts an
 *     old one back).
 *
 * deploy/deploy.sh runs it in the new backend container after the switch;
 * the backend runs the same check at start (logged). Read-only, any role that
 * can read the catalog (the backend's DATABASE_URL).
 *
 *   docker compose exec -T ov-backend node scripts/check-schema.mjs
 *     --objects-only   leave the migration record out (a database restored by
 *                      restore.sh, before its first migrate.mjs run)
 *     --print-sql      print the object check as one SQL query, for psql
 *                      (no connection; restore.sh runs it in ov-postgres):
 *                      one row per problem, none when all is in place
 *     --db-dir DIR     the migrations (default: this image's db/)
 *
 * Exit codes: 0 ready, 1 a problem (listed), 2 usage.
 */

import pg from 'pg'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultDbDir, readSchemaState, describeSchemaState, schemaCheckSql } from '../lib/schemaVersion.js'

const USAGE = 'Usage: DATABASE_URL=... node scripts/check-schema.mjs [--objects-only] [--print-sql] [--db-dir DIR]'

async function main () {
  const opts = { objectsOnly: false, printSql: false, dbDir: defaultDbDir() }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--objects-only') opts.objectsOnly = true
    else if (a === '--print-sql') opts.printSql = true
    else if (a === '--db-dir' && args[i + 1]) opts.dbDir = resolve(args[++i])
    else if (a === '-h' || a === '--help') { console.log(USAGE); return 0 } else {
      console.error(`Unknown argument ${a}\n${USAGE}`)
      return 2
    }
  }
  if (opts.printSql) {
    process.stdout.write(schemaCheckSql({ dbDir: opts.dbDir }))
    return 0
  }
  if (!process.env.DATABASE_URL) {
    console.error(`DATABASE_URL is not set.\n${USAGE}`)
    return 2
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'check-schema' })
  await client.connect()
  try {
    const st = await readSchemaState(client, { dbDir: opts.dbDir })
    for (const p of st.problems) console.log(`PROBLEM ${p}`)
    if (opts.objectsOnly) {
      console.log(st.problems.length ? `${st.problems.length} problem(s)` : 'ok: guard triggers, unique indexes and trigger functions in place')
      return st.problems.length ? 1 : 0
    }
    for (const { text } of describeSchemaState(st, { dbDir: opts.dbDir })) console.log(text)
    return st.ready ? 0 : 1
  } finally {
    await client.end()
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]) } catch { return false }
})()
if (isMain) {
  main().then((code) => process.exit(code), (err) => {
    console.error('check-schema failed:', err?.code ? `${err.code}: ${err.message}` : err?.message || err)
    process.exit(1)
  })
}
