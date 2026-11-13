#!/usr/bin/env node
/**
 * Deploy step, right after db/033_match_scoresheets.sql: record the PDF of
 * every match closed before it (lib/scoresheets.js recordOldPdfs).
 *
 * Those matches have their approval's PDF on disk without a
 * public.match_scoresheets row, so the server finds it by its name (the
 * match's day folder, game number, owner record; only a file stored before
 * db/033 ran). Recorded, it is held as every later match's PDF: the
 * closed-match rules apply by the record, other matches of the same name
 * never reach it, and deleting its uploader's account no longer hides it
 * from the Scoresheets tab. A file that the names serve for two closed
 * matches is left as it is (counted as shared; the server logs each such
 * match when it serves it). Idempotent; dry run unless --apply. Run it with
 * the new backend image and db/033 in (it can run while the server does),
 * and again any time.
 *
 * Usage (in the backend container, with its DATABASE_URL and STORAGE_ROOT / STORAGE_DIR;
 * from the production folder of the compose file):
 *   docker compose exec ov-backend node scripts/scoresheet-records.mjs           # count only
 *   docker compose exec ov-backend node scripts/scoresheet-records.mjs --apply   # record
 *
 * Prints counts only (no names, no paths). Exit codes: 0 done, 1 error, 2 usage.
 */

import pg from 'pg'
import { createStorage, storageOptionsFromEnv } from '../lib/storage.js'
import { createScoresheets } from '../lib/scoresheets.js'

const USAGE = 'Usage: node scripts/scoresheet-records.mjs [--apply]\nNeeds DATABASE_URL and the storage root (STORAGE_ROOT / STORAGE_DIR, default /data/storage), the backend\'s.'

async function main () {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const unknown = args.filter((a) => a !== '--apply')
  if (unknown.length) {
    console.error(`Unknown argument ${unknown[0]}\n${USAGE}`)
    return 2
  }
  if (!process.env.DATABASE_URL) {
    console.error(`DATABASE_URL is not set.\n${USAGE}`)
    return 2
  }
  const env = { ...process.env, STORAGE_DIR: process.env.STORAGE_ROOT || process.env.STORAGE_DIR || '/data/storage' }
  const storage = createStorage({ ...storageOptionsFromEnv(env), logger: console })
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, application_name: 'scoresheet-records' })
  try {
    const apply = args.includes('--apply')
    const r = await createScoresheets({ pool, storage, accounts: null }).recordOldPdfs({ apply })
    console.log(`db/033 ran ${r.started_at}; PDFs stored since are recorded by the server.`)
    console.log(`${r.matches} closed matches without a recorded PDF: ${r.recorded} ${apply ? 'recorded' : 'to record (dry run: --apply records them)'}, ` +
      `${r.shared} shared with another match (left by name), ${r.none} without a PDF, ${r.unknown} unreadable`)
    return 0
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => {
    console.error('scoresheet-records failed:', err?.code ? `${err.code}: ${err.message}` : err?.message || err)
    process.exit(1)
  })
}
