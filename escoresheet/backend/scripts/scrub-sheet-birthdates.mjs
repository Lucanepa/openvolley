#!/usr/bin/env node
/**
 * Deploy step, after db/048_no_birthdates.sql and the backend image that
 * reads it: the stored scoresheet files without the birthdates that db/048
 * took out of the match records (owner 2026-11-19: "Scrub past sheets too").
 *
 *   1. leftovers: a date of birth the OLD backend stored between db/048 and
 *      the switch to the new image (profiles, referee_database, svrz_games,
 *      competition_players / _staff, club_licences: NULL; game_rosters: the
 *      key dob goes). auth.users is the owner role's only: its count is
 *      printed with what to run (normally 0).
 *   2. the recorded PDFs (public.match_scoresheets) of every match recorded
 *      before db/048 ran: each match's PDFs replaced in place by one vector
 *      PDF of its scrubbed record, "Birthdates removed" printed on it as a
 *      rebuild's reason (lib/scoresheets.js rewriteRecordedWithVector; the
 *      render service, OV_RENDER_URL / OV_RENDER_TOKEN). A match done before
 *      (a scoresheet.rebuild entry with that reason after its newest PDF) is
 *      skipped: the step can run again, it only does what is left.
 *   3. the JSON files beside the PDFs (OpenBeach's sheet, older apps'
 *      exports): the birthdates taken out (lib/birthdates.js, db/048's rule),
 *      written back in place with the same owners.
 * A file it cannot rebuild is listed (path and why: a beach PDF, the render
 * service, a record that does not end as its close says, a match deleted, a
 * PDF without a record) for the owner to decide. It never deletes a file.
 * Dry run unless --apply (counts and the list only; the dry run renders
 * nothing).
 *
 * Usage (in the backend container, with its DATABASE_URL, STORAGE_ROOT /
 * STORAGE_DIR, OV_RENDER_URL, OV_RENDER_TOKEN and OV_PIN_SECRET; from the
 * production folder of the compose file):
 *   docker compose exec ov-backend node scripts/scrub-sheet-birthdates.mjs           # dry run
 *   docker compose exec ov-backend node scripts/scrub-sheet-birthdates.mjs --apply   # rebuild and replace
 *     --limit N     at most N matches in this run (a long run in parts)
 *
 * Prints counts and the paths of the files it leaves, never a name. Exit
 * codes: 0 done (or dry run), 1 error, 2 usage.
 */

import pg from 'pg'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createStorage, storageOptionsFromEnv } from '../lib/storage.js'
import { createScoresheets, SCORESHEETS_BUCKET, SCORESHEET_DAY_RE, isScoresheetPdf } from '../lib/scoresheets.js'
import { createVectorPdf } from '../lib/vectorPdf.js'
import { createPgQuery } from '../lib/pgQuery.js'
import { createMatchRestore } from '../lib/matchRestore.js'
import { createApprovals } from '../lib/approvals.js'
import { createAccounts } from '../lib/accounts.js'
import { SECRET_COLUMNS } from '../lib/secrets.js'
import { scrubBirthdates } from '../lib/birthdates.js'

export const REASON = 'Birthdates removed'
const USAGE = 'Usage: node scripts/scrub-sheet-birthdates.mjs [--apply] [--limit N]\n' +
  'Needs DATABASE_URL, the storage root (STORAGE_ROOT / STORAGE_DIR, default /data/storage), OV_RENDER_URL and OV_RENDER_TOKEN, the backend\'s.'

// db/048's step 1, for the rows the old backend may have written since
const LEFTOVER_COLUMNS = [
  ['public.profiles', 'dob'],
  ['public.referee_database', 'dob'],
  ['public.svrz_games', 'referee_1_dob'],
  ['public.svrz_games', 'referee_2_dob'],
  ['public.competition_players', 'dob'],
  ['public.competition_staff', 'dob'],
  ['public.club_licences', 'dob']
]
const ident = (s) => s.split('.').map((x) => `"${x.replace(/"/g, '""')}"`).join('.')

async function hasColumn (q, table, column) {
  const { rows: [r] } = await q.query(
    'SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped) AS ok', [table, column])
  return r.ok === true
}

/**
 * Step 1: { 'table.column': rows } with a date of birth left (apply: NULLed),
 * game_rosters (the key dob), and auth_users (counted only: the backend role
 * cannot write raw_user_meta_data).
 */
export async function scrubLeftovers (q, { apply = false } = {}) {
  const out = {}
  for (const [t, c] of LEFTOVER_COLUMNS) {
    if (!(await hasColumn(q, t, c))) continue
    const sql = apply
      ? `UPDATE ${ident(t)} SET "${c}" = NULL WHERE "${c}" IS NOT NULL`
      : `SELECT count(*)::int AS n FROM ${ident(t)} WHERE "${c}" IS NOT NULL`
    const r = await q.query(sql)
    out[`${t.slice(7)}.${c}`] = apply ? r.rowCount : r.rows[0].n
  }
  if (await hasColumn(q, 'public.game_rosters', 'players')) {
    const where = "jsonb_path_exists(players, '$[*].dob') OR jsonb_path_exists(staff, '$[*].dob')"
    const strip = (col) => `coalesce((SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object' THEN e - 'dob' ELSE e END ORDER BY i)
      FROM jsonb_array_elements(${col}) WITH ORDINALITY AS x(e, i)), '[]'::jsonb)`
    const r = apply
      ? await q.query(`UPDATE public.game_rosters SET players = ${strip('players')}, staff = ${strip('staff')} WHERE ${where}`)
      : await q.query(`SELECT count(*)::int AS n FROM public.game_rosters WHERE ${where}`)
    out['game_rosters'] = apply ? r.rowCount : r.rows[0].n
  }
  try {
    const { rows: [r] } = await q.query("SELECT count(*)::int AS n FROM auth.users WHERE raw_user_meta_data ? 'dob'")
    out.auth_users = r.n
  } catch {
    out.auth_users = null // not readable as this role
  }
  return out
}

/** When db/048 ran (ov_meta.schema_migrations), or null (no record: every match counts). */
async function migratedAt (q) {
  try {
    const { rows: [r] } = await q.query('SELECT applied_at FROM ov_meta.schema_migrations WHERE version = 48')
    return r?.applied_at ?? null
  } catch {
    return null
  }
}

/**
 * The recorded PDFs to rebuild, by match: [{ id, beach, test, paths, done }]
 * (done: rebuilt with REASON after its newest PDF), and the records whose
 * match is gone ([path]).
 */
export async function recordedSheets (q, { before = null } = {}) {
  const { rows } = await q.query(
    `SELECT m.id::text AS id, (m.sport_type IS NOT DISTINCT FROM 'beach') AS beach, (m.test IS TRUE) AS test,
            array_agg(s.path ORDER BY s.stored_at, s.path) AS paths,
            coalesce((SELECT max(a.at) FROM public.audit_log a
                       WHERE a.action = 'scoresheet.rebuild' AND a.match_id = m.id AND a.details ->> 'reason' = $1)
                     >= max(s.stored_at), false) AS done
       FROM public.match_scoresheets s JOIN public.matches m ON m.id = s.match_id
      WHERE ($2::timestamptz IS NULL OR m.created_at < $2::timestamptz)
      GROUP BY m.id
      ORDER BY min(s.stored_at), m.id`, [REASON, before])
  const { rows: gone } = await q.query('SELECT path FROM public.match_scoresheets WHERE match_id IS NULL ORDER BY path')
  return { matches: rows, orphaned: gone.map((r) => r.path) }
}

/** The day folders of the bucket ({day}, beach/{day}). */
async function dayFolders (storage) {
  const top = await storage.listFoldersTrusted({ bucket: SCORESHEETS_BUCKET, path: '' })
  const days = top.filter((d) => SCORESHEET_DAY_RE.test(d))
  if (top.includes('beach')) {
    for (const d of await storage.listFoldersTrusted({ bucket: SCORESHEETS_BUCKET, path: 'beach' })) {
      if (SCORESHEET_DAY_RE.test(d)) days.push(`beach/${d}`)
    }
  }
  return days.sort()
}

/** The bucket's PDFs without a record (before db/033, never recorded): [path]. */
export async function unrecordedPdfs (q, storage) {
  const all = []
  for (const folder of await dayFolders(storage)) {
    for (const f of await storage.listFilesTrusted({ bucket: SCORESHEETS_BUCKET, path: folder })) {
      if (isScoresheetPdf(`${folder}/${f.name}`)) all.push(`${folder}/${f.name}`)
    }
  }
  if (!all.length) return []
  const { rows } = await q.query('SELECT path FROM public.match_scoresheets WHERE path = ANY($1::text[])', [all])
  const recorded = new Set(rows.map((r) => r.path))
  return all.filter((p) => !recorded.has(p))
}

/**
 * Step 3: the JSON files of the bucket. { files, withBirthdates, rewritten,
 * cannot: [{ path, code }] } (apply: written back in place, same owners).
 */
export async function scrubJsonFiles (storage, { apply = false } = {}) {
  const out = { files: 0, withBirthdates: 0, rewritten: 0, cannot: [] }
  for (const folder of await dayFolders(storage)) {
    for (const f of await storage.listFilesTrusted({ bucket: SCORESHEETS_BUCKET, path: folder })) {
      if (!f.name.endsWith('.json')) continue
      const path = `${folder}/${f.name}`
      out.files++
      let json
      try {
        json = JSON.parse((await storage.readTrusted({ bucket: SCORESHEETS_BUCKET, path })).toString('utf8'))
      } catch {
        out.cannot.push({ path, code: 'OV_NOT_JSON' })
        continue
      }
      const { value, changed } = scrubBirthdates(json)
      if (!changed) continue
      out.withBirthdates++
      if (!apply) continue
      const owners = await storage.getOwners({ bucket: SCORESHEETS_BUCKET, path }).catch(() => [])
      const by = owners.find((o) => /^[0-9a-f-]{36}$/i.test(o)) ?? null
      if (!by) {
        out.cannot.push({ path, code: 'OV_NO_OWNER' })
        continue
      }
      const r = await storage.handle('upload',
        { bucket: SCORESHEETS_BUCKET, path, fileBase64: Buffer.from(JSON.stringify(value)).toString('base64'), contentType: 'application/json', upsert: true },
        { userId: by, adopt: (o) => o })
      if (r.status === 200) out.rewritten++
      else out.cannot.push({ path, code: r.body?.error?.code || 'OV_STORE_FAILED' })
    }
  }
  return out
}

/**
 * Step 2: { matches, pdfs, done, rebuilt, replaced, cannot: [{ path, code }] }.
 * Dry run: what would be rebuilt, and what cannot be (beach, no render
 * service, a deleted match, a PDF without a record); nothing is drawn.
 */
export async function rebuildSheets ({ q, storage, scoresheets, vectorEnabled, apply = false, limit = Infinity, log = () => {} }) {
  const out = { matches: 0, pdfs: 0, done: 0, rebuilt: 0, replaced: 0, cannot: [] }
  const { matches, orphaned } = await recordedSheets(q, { before: await migratedAt(q) })
  for (const path of orphaned) out.cannot.push({ path, code: 'OV_MATCH_DELETED' })
  for (const path of await unrecordedPdfs(q, storage)) out.cannot.push({ path, code: 'OV_NO_RECORD' })
  let n = 0
  for (const m of matches) {
    if (m.done) { out.done++; continue }
    if (m.beach) { for (const path of m.paths) out.cannot.push({ path, code: 'OV_BEACH_SHEET' }); continue }
    if (!vectorEnabled) { for (const path of m.paths) out.cannot.push({ path, code: 'OV_RENDER_UNAVAILABLE' }); continue }
    if (n >= limit) break
    n++
    out.matches++
    out.pdfs += m.paths.length
    if (!apply) continue
    const r = await scoresheets.rewriteRecordedWithVector({ matchId: m.id, reason: REASON })
    if (r.ok) {
      out.rebuilt++
      out.replaced += r.replaced
      log(`  rebuilt ${r.replaced} PDF(s) of match ${m.id}`)
    } else {
      out.replaced += r.replaced || 0
      for (const path of r.paths.slice(r.replaced || 0)) out.cannot.push({ path, code: r.code })
    }
  }
  return out
}

export function parseArgs (argv) {
  const o = { apply: false, limit: Infinity }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') o.apply = true
    else if (a === '--limit') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1) return { error: '--limit: a whole number above 0' }
      o.limit = n
    } else if (a === '--help' || a === '-h') o.help = true
    else return { error: `Unknown argument ${a}` }
  }
  return o
}

/**
 * The modules the steps need, wired as server.js wires them (no HTTP, no
 * mail). Tests pass `storage` (a temporary root) and `fetchImpl` (a fake
 * render service).
 */
export function wire ({ connectionString, env = process.env, logger = console, storage = null, fetchImpl = undefined } = {}) {
  const db = createPgQuery({ connectionString, allowedTables: ['matches', 'sets', 'events', 'match_live_state'], secretColumns: SECRET_COLUMNS, poolMax: 2, logger })
  const restore = createMatchRestore(db, {})
  storage ??= createStorage({ ...storageOptionsFromEnv({ ...env, STORAGE_DIR: env.STORAGE_ROOT || env.STORAGE_DIR || '/data/storage' }), logger })
  const approvals = createApprovals({ pool: db.pool, secret: env.OV_PIN_SECRET || null, beachApprovals: true, logger })
  const accounts = createAccounts({ pool: db.pool, db, restore, access: null, logger })
  const vector = createVectorPdf({ url: env.OV_RENDER_URL, token: env.OV_RENDER_TOKEN, logger, ...(fetchImpl ? { fetchImpl } : {}) })
  const scoresheets = createScoresheets({
    pool: db.pool, db, storage, accounts, vector, logger,
    readMatch: (id) => restore.readWhole(id),
    readApprovals: (id) => approvals.recordsForMatch(id)
  })
  return { db, pool: db.pool, storage, scoresheets, vector }
}

const list = (cannot) => cannot.map((c) => `    ${c.path}  (${c.code})`).join('\n')

async function main () {
  const o = parseArgs(process.argv.slice(2))
  if (o.error) { console.error(`${o.error}\n${USAGE}`); return 2 }
  if (o.help) { console.log(USAGE); return 0 }
  if (!process.env.DATABASE_URL) { console.error(`DATABASE_URL is not set.\n${USAGE}`); return 2 }
  const w = wire({ connectionString: process.env.DATABASE_URL })
  try {
    const verb = o.apply ? 'cleared' : 'to clear'
    const left = await scrubLeftovers(w.pool, { apply: o.apply })
    console.log(`1. Dates of birth stored by the old backend after db/048, ${verb}: ${JSON.stringify(left)}`)
    if (left.auth_users) {
      console.log("   auth.users: as the owner role, run: UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data - 'dob' WHERE raw_user_meta_data ? 'dob';")
    }
    const sheets = await rebuildSheets({ q: w.pool, storage: w.storage, scoresheets: w.scoresheets, vectorEnabled: w.vector.enabled, apply: o.apply, limit: o.limit, log: console.log })
    console.log(`2. Recorded PDFs: ${sheets.matches} match(es) with ${sheets.pdfs} PDF(s) ${o.apply ? `rebuilt (${sheets.rebuilt} matches, ${sheets.replaced} PDFs replaced)` : 'to rebuild (dry run: --apply draws and replaces them)'}, ` +
      `${sheets.done} match(es) done before`)
    const json = await scrubJsonFiles(w.storage, { apply: o.apply })
    console.log(`3. JSON files: ${json.files} read, ${json.withBirthdates} with dates of birth, ${o.apply ? `${json.rewritten} written back` : 'to write back (dry run)'}`)
    const cannot = [...sheets.cannot, ...json.cannot]
    if (cannot.length) {
      console.log(`Not rebuilt (${cannot.length}), left as they are (never deleted), for the owner to decide:\n${list(cannot)}`)
    } else {
      console.log('Nothing left that cannot be rebuilt.')
    }
    return 0
  } finally {
    await w.pool.end()
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]) } catch { return false }
})()
if (isMain) {
  main().then((code) => process.exit(code), (err) => {
    console.error('scrub-sheet-birthdates failed:', err?.code ? `${err.code}: ${err.message}` : err?.message || err)
    process.exit(1)
  })
}
