/**
 * The database schema the backend image expects, and whether the database has it.
 *
 * Migrations are the files db/NNN_*.sql shipped in the image. scripts/migrate.mjs
 * applies each once and records it in ov_meta.schema_migrations (version,
 * file, SHA-256, time); this module reads that record and the catalog:
 *
 *   expected  the newest NNN in this image's db/
 *   applied   the newest recorded NNN
 *   pending   files of this image without a record (the database is behind)
 *   ahead     recorded versions this image has no file for (an older image)
 *   changed   recorded files whose content is no longer what ran
 *   problems  required guard triggers, unique indexes and current trigger
 *             functions (db/current_definitions.sql) that are missing,
 *             disabled, invalid or old (schemaProblems). On a database that
 *             is ahead (an older image after a rollback) the function bodies
 *             are not compared: a newer migration changed them on purpose
 *   ready     a readable record, nothing pending or changed, no problem
 *
 * The backend calls checkSchemaAtStart at start (server.js): it logs the
 * result, checks again every few minutes (sooner while the database cannot be
 * reached) and logs only what changed. schemaStatus() returns the last state,
 * refreshSchemaStatus() one at most a minute old (for /health).
 * scripts/check-schema.mjs is the same check from the command line
 * (deploy.sh, restore.sh).
 *
 * The record lives in its own schema, so that roles.sql's grants on public
 * (DML on every table for ov_app) never reach it: the app role gets USAGE +
 * SELECT only (from the runner, and from roles.sql after a restore without
 * privileges).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const RECORD_SCHEMA = 'ov_meta'
export const RECORD_TABLE = 'ov_meta.schema_migrations'
export const CURRENT_DEFINITIONS_FILE = 'current_definitions.sql'
export const MIGRATION_FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/
// What restore.sh and a person take for a migration (NNN...sql): one that
// MIGRATION_FILE_RE does not accept would never run and never count as pending.
const LOOKS_LIKE_MIGRATION_RE = /^\d{3}.*\.sql$/i

/** backend/db of this checkout or image. */
export function defaultDbDir () {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'db')
}

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * The numbered migration files of a db/ directory, in number order:
 * [{ version, file, path }]. Two files with one number are refused (they would
 * run in an order nobody chose), and so is a file named like a migration that
 * is not NNN_lowercase_words.sql (it would be skipped without a word).
 */
export function migrationFiles (dbDir = defaultDbDir()) {
  const files = []
  const seen = new Map()
  for (const file of readdirSync(dbDir)) {
    const m = MIGRATION_FILE_RE.exec(file)
    if (!m) {
      if (LOOKS_LIKE_MIGRATION_RE.test(file)) throw new Error(`${dbDir}/${file}: not a migration name the runner takes (NNN_lowercase_words.sql: digits, a-z and _ only); rename it`)
      continue
    }
    const version = Number(m[1])
    if (seen.has(version)) throw new Error(`${dbDir} has two migrations numbered ${m[1]}: ${seen.get(version)} and ${file} (renumber one)`)
    seen.set(version, file)
    files.push({ version, file, path: join(dbDir, file) })
  }
  return files.sort((x, y) => x.version - y.version)
}

export const pad3 = (n) => String(n).padStart(3, '0')

// --- Required objects -----------------------------------------------------------
// The triggers the numbered files create (table, trigger, function it calls).
// Without one, a rule is silently off: closed matches editable, no audit of
// a close, approvals not voided, the sport or external_id of a match
// changeable, manager roles out of step, updated_at frozen. `ifColumn`: only
// where the file creates it (006 needs sets.updated_at).
export const REQUIRED_TRIGGERS = [
  { table: 'public.matches', name: 'matches_touch_updated_at', fn: 'public.ov_touch_updated_at' }, // 006
  { table: 'public.sets', name: 'sets_touch_updated_at', fn: 'public.ov_touch_updated_at', ifColumn: 'updated_at' }, // 006
  { table: 'public.matches', name: 'matches_guard', fn: 'public.ov_matches_guard' }, // 007
  { table: 'public.matches', name: 'matches_close_audit', fn: 'public.ov_matches_close_audit' }, // 007, 012
  { table: 'public.sets', name: 'sets_closed_guard', fn: 'public.ov_match_children_guard' }, // 007
  { table: 'public.events', name: 'events_closed_guard', fn: 'public.ov_match_children_guard' }, // 007
  { table: 'public.match_live_state', name: 'match_live_state_closed_guard', fn: 'public.ov_match_children_guard' }, // 007
  { table: 'public.competitions', name: 'competitions_touch_updated_at', fn: 'public.ov_touch_updated_at' }, // 007
  { table: 'public.competition_teams', name: 'competition_teams_touch_updated_at', fn: 'public.ov_touch_updated_at' }, // 007
  { table: 'public.match_approvals', name: 'match_approvals_immutable', fn: 'public.ov_match_approvals_immutable' }, // 011
  { table: 'public.match_approvals', name: 'match_approvals_closed_guard', fn: 'public.ov_match_children_guard' }, // 011
  { table: 'public.match_approvals', name: 'match_approvals_closed_guard_update', fn: 'public.ov_match_children_guard' }, // 011
  { table: 'public.matches', name: 'matches_void_approvals', fn: 'public.ov_matches_void_approvals' }, // 011, 012
  { table: 'public.matches', name: 'matches_sport_lock', fn: 'public.ov_matches_sport_lock' }, // 012
  { table: 'public.beach_tournaments', name: 'beach_tournaments_touch_updated_at', fn: 'public.ov_touch_updated_at' }, // 014
  { table: 'public.beach_draws', name: 'beach_draws_touch_updated_at', fn: 'public.ov_touch_updated_at' }, // 014
  { table: 'public.beach_entries', name: 'beach_entries_touch_updated_at', fn: 'public.ov_touch_updated_at' }, // 014
  { table: 'public.beach_tmatches', name: 'beach_tmatches_touch_updated_at', fn: 'public.ov_touch_updated_at' }, // 014
  { table: 'public.event_revisions', name: 'event_revisions_closed_guard', fn: 'public.ov_match_children_guard' }, // 015
  { table: 'public.events', name: 'events_apply_void', fn: 'public.ov_events_apply_void' }, // 015, 032
  { table: 'public.matches', name: 'matches_delete_activity', fn: 'public.ov_matches_delete_activity' }, // 016
  { table: 'public.clubs', name: 'clubs_touch_updated_at', fn: 'public.ov_touch_updated_at' }, // 018
  { table: 'public.matches', name: 'matches_club_guard', fn: 'public.ov_matches_club_guard' }, // 018
  { table: 'public.club_managers', name: 'club_managers_roles', fn: 'public.ov_manager_rows_changed' }, // 030
  { table: 'public.team_managers', name: 'team_managers_roles', fn: 'public.ov_manager_rows_changed' }, // 030
  { table: 'public.matches', name: 'matches_external_id_lock', fn: 'public.ov_matches_external_id_lock' } // 032
]

// The unique indexes the numbered files create: each one is a rule (one
// match per official game, one approval per slot, one account per address ...)
// that the code relies on instead of checking itself.
export const REQUIRED_INDEXES = [
  'auth.users_email_lower', // 002
  'public.matches_official_game_uidx', // 007, 013
  'public.competition_teams_name_uidx', // 007
  'public.match_approvals_slot_uidx', // 011
  'public.match_approvals_user_uidx', // 011
  'public.matches_tournament_match_uidx', // 014
  'public.clubs_name_uidx', // 018
  'public.club_teams_name_uidx', // 018
  'public.club_teams_id_uidx', // 023
  'public.club_teams_id_club_uidx', // 025
  'public.account_requests_part_uidx', // 025
  'public.notifications_once_uidx' // 028
]

/**
 * The functions of db/current_definitions.sql with their bodies:
 * [{ name: 'public.x', body, securityDefiner, searchPath }].
 */
export function currentDefinitions (dbDir = defaultDbDir()) {
  const sql = readFileSync(join(dbDir, CURRENT_DEFINITIONS_FILE), 'utf8')
  const out = []
  const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\([^)]*\)([\s\S]*?)\bAS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\4/gi
  for (const m of sql.matchAll(re)) {
    out.push({
      name: `${m[1].toLowerCase()}.${m[2].toLowerCase()}`,
      body: m[5],
      securityDefiner: /\bSECURITY\s+DEFINER\b/i.test(m[3]),
      searchPath: /\bSET\s+search_path\b/i.test(m[3])
    })
  }
  return out
}

const lit = (s) => s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`

/**
 * One SQL query (no parameters) that lists every problem of the required
 * objects, one row each (column `problem`), none when all is in place. Plain
 * SQL so that restore.sh can run it through psql (check-schema.mjs --print-sql).
 * `functions: false` leaves out the comparison with db/current_definitions.sql
 * (a database ahead of this image: its newer bodies are not old ones).
 */
export function schemaCheckSql ({ dbDir = defaultDbDir(), functions = true } = {}) {
  // Names are resolved through the catalog, never with to_regclass: that one
  // raises for a schema the role has no USAGE on, and the check runs as any role.
  const split = (q) => q.split('.').map(lit).join(', ')
  const trg = REQUIRED_TRIGGERS.map((t) =>
    `(${split(t.table)}, ${lit(t.name)}, ${lit(t.fn)}, ${lit(t.ifColumn ?? null)})`).join(',\n    ')
  const idx = REQUIRED_INDEXES.map((i) => `(${split(i)})`).join(', ')
  const defs = functions ? currentDefinitions(dbDir) : []
  const fns = defs.map((f) =>
    `(${lit(f.name)}, ${lit(sha256(f.body))}, ${f.securityDefiner}, ${f.searchPath})`).join(',\n    ')
  const fnCtes = defs.length
    ? `,
want_fn (name, src_sha256, secdef, search_path) AS (VALUES
    ${fns}),
fn AS (
  SELECT w.*, count(p.oid) AS n,
         bool_and(encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = w.src_sha256) AS same_src,
         bool_and(p.prosecdef) AS is_secdef,
         bool_and(coalesce(array_to_string(p.proconfig, ','), '') LIKE '%search_path=%') AS has_path
    FROM want_fn w
    LEFT JOIN pg_namespace n ON n.nspname = split_part(w.name, '.', 1)
    LEFT JOIN pg_proc p ON p.pronamespace = n.oid AND p.proname = split_part(w.name, '.', 2)
   GROUP BY w.name, w.src_sha256, w.secdef, w.search_path
)`
    : ''
  const fnRows = defs.length
    ? `
  UNION ALL
  SELECT 3, name, format('function %s() is missing', name) FROM fn WHERE n = 0
  UNION ALL
  SELECT 3, name, format('function %s() has %s definitions', name, n) FROM fn WHERE n > 1
  UNION ALL
  SELECT 3, name, format('function %s() is not the current definition (db/current_definitions.sql): an older migration ran again; scripts/migrate.mjs puts it back', name)
    FROM fn WHERE n = 1 AND NOT same_src
  UNION ALL
  SELECT 3, name, format('function %s() should %s SECURITY DEFINER (db/current_definitions.sql); scripts/migrate.mjs puts it back', name, CASE WHEN secdef THEN 'be' ELSE 'not be' END)
    FROM fn WHERE n = 1 AND is_secdef IS DISTINCT FROM secdef
  UNION ALL
  SELECT 3, name, format('function %s() has no fixed search_path (db/current_definitions.sql); scripts/migrate.mjs puts it back', name)
    FROM fn WHERE n = 1 AND search_path AND NOT has_path`
    : ''
  return `-- lib/schemaVersion.js schemaCheckSql: required triggers, unique indexes${defs.length ? ' and current trigger functions' : ''}
WITH want_trg (tschema, trel, name, fn, if_col) AS (VALUES
    ${trg}),
want_idx (ischema, iname) AS (VALUES ${idx}),
trg AS (
  SELECT w.tschema || '.' || w.trel AS tbl, w.name, w.fn,
         (w.if_col IS NULL OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = w.if_col AND NOT a.attisdropped)) AS applies,
         t.tgenabled, (SELECT pn.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace pn ON pn.oid = p.pronamespace WHERE p.oid = t.tgfoid) AS calls
    FROM want_trg w
    LEFT JOIN pg_namespace n ON n.nspname = w.tschema
    LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = w.trel AND c.relkind IN ('r', 'p')
    LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = w.name AND NOT t.tgisinternal
),
idx AS (
  SELECT w.ischema || '.' || w.iname AS name, i.indisunique, i.indisvalid, i.indisready, i.indexrelid
    FROM want_idx w
    LEFT JOIN pg_namespace n ON n.nspname = w.ischema
    LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = w.iname AND c.relkind = 'i'
    LEFT JOIN pg_index i ON i.indexrelid = c.oid
)${fnCtes}
SELECT problem FROM (
  SELECT 1 AS k, tbl || '.' || name AS o, format('trigger %s on %s is missing', name, tbl) AS problem
    FROM trg WHERE applies AND tgenabled IS NULL
  UNION ALL
  SELECT 1, tbl || '.' || name, format('trigger %s on %s is disabled', name, tbl)
    FROM trg WHERE applies AND tgenabled IS NOT NULL AND tgenabled NOT IN ('O', 'A')
  UNION ALL
  SELECT 1, tbl || '.' || name, format('trigger %s on %s calls %s, not %s', name, tbl, calls, fn)
    FROM trg WHERE applies AND tgenabled IS NOT NULL AND calls IS DISTINCT FROM fn
  UNION ALL
  SELECT 2, name, format('index %s is missing', name) FROM idx WHERE indexrelid IS NULL
  UNION ALL
  SELECT 2, name, format('index %s is not valid (a failed CREATE INDEX CONCURRENTLY?)', name)
    FROM idx WHERE indexrelid IS NOT NULL AND NOT (indisvalid AND indisready)
  UNION ALL
  SELECT 2, name, format('index %s is not unique', name) FROM idx WHERE indexrelid IS NOT NULL AND NOT indisunique${fnRows}
) p
ORDER BY k, o, problem;
`
}

/**
 * The problems of the required objects (schemaCheckSql), as strings; [] when
 * all is in place. `functions: false`: without the current-definition check.
 */
export async function schemaProblems (db, { dbDir, functions = true } = {}) {
  const { rows } = await db.query(schemaCheckSql({ dbDir, functions }))
  return rows.map((r) => r.problem)
}

/** Whether the record exists and the connected role may read it (catalog only: never raises). */
export async function recordAccess (db) {
  const { rows: [r] } = await db.query(`
    SELECT n.oid IS NOT NULL AS has_schema, c.oid IS NOT NULL AS has_table,
           coalesce(has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT'), false) AS readable
      FROM (SELECT 1) x
      LEFT JOIN pg_namespace n ON n.nspname = $1
      LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'schema_migrations'`, [RECORD_SCHEMA])
  return r
}

/**
 * The schema state of the database behind `db` (a pg Client or Pool) against
 * the files of `dbDir` (this image's). `objects: false` leaves the object
 * check out. `functionsChecked` is false when the database is ahead: the
 * bodies of db/current_definitions.sql are then this image's older ones, and
 * a newer migration's are no problem (the newer image's runner puts them).
 */
export async function readSchemaState (db, { dbDir = defaultDbDir(), objects = true } = {}) {
  const files = migrationFiles(dbDir)
  const expected = files.length ? files[files.length - 1].version : null
  const state = { expected, applied: null, record: 'missing', pending: files.map((f) => f.version), ahead: [], changed: [], problems: [], functionsChecked: false, ready: false, checkedAt: new Date().toISOString() }
  const access = await recordAccess(db)
  if (access.has_table && !access.readable) state.record = 'unreadable'
  if (access.readable) {
    const { rows } = await db.query(`SELECT version, checksum FROM ${RECORD_TABLE} ORDER BY version`)
    if (rows.length) {
      state.record = 'ok'
      const recorded = new Map(rows.map((r) => [r.version, r.checksum]))
      const byVersion = new Map(files.map((f) => [f.version, f]))
      state.applied = rows[rows.length - 1].version
      state.pending = files.filter((f) => !recorded.has(f.version)).map((f) => f.version)
      state.ahead = rows.filter((r) => !byVersion.has(r.version)).map((r) => r.version)
      state.changed = rows.filter((r) => byVersion.has(r.version) &&
        sha256(readFileSync(byVersion.get(r.version).path, 'utf8')) !== r.checksum).map((r) => r.version)
    }
  }
  if (objects) {
    state.functionsChecked = !state.ahead.length
    state.problems = await schemaProblems(db, { dbDir, functions: state.functionsChecked })
  }
  state.ready = state.record === 'ok' && !state.pending.length && !state.changed.length && !state.problems.length
  return state
}

/** One line per finding of a state (no secrets, no row data). */
export function describeSchemaState (st, { dbDir = defaultDbDir() } = {}) {
  if (st.error) return [{ level: 'warn', text: `schema not checked: ${st.error}` }]
  const names = new Map(migrationFiles(dbDir).map((f) => [f.version, f.file]))
  const list = (vs) => vs.map((v) => names.get(v) ? `db/${names.get(v)}` : `db/${pad3(v)}`).join(', ')
  const lines = []
  if (st.record === 'missing') lines.push({ level: 'warn', text: `schema: no migration record (${RECORD_TABLE}); run scripts/migrate.mjs (deploy/deploy.sh does)` })
  else if (st.record === 'unreadable') lines.push({ level: 'warn', text: `schema: the migration record (${RECORD_TABLE}) is not readable by this role; roles.sql (apply-roles.sh) and scripts/migrate.mjs grant it` })
  else if (st.pending.length) lines.push({ level: 'error', text: `schema behind this image (db/${pad3(st.expected)}): ${list(st.pending)} not applied; run scripts/migrate.mjs (deploy/deploy.sh)` })
  if (st.changed.length) lines.push({ level: 'error', text: `schema: ${list(st.changed)} changed after they ran (a migration is never edited once applied)` })
  if (st.ahead.length) lines.push({ level: 'warn', text: `schema: the database has ${st.ahead.map((v) => `db/${pad3(v)}`).join(', ')}, which this image does not know (an older image, e.g. after a rollback); trigger functions not compared with this image's` })
  if (st.problems.length) lines.push({ level: 'error', text: `schema check: ${st.problems.length} problem(s): ${st.problems.slice(0, 5).join('; ')}${st.problems.length > 5 ? '; ...' : ''} (scripts/check-schema.mjs lists all)` })
  if (st.ready) lines.push({ level: 'log', text: `schema: db/${pad3(st.applied)} applied (this image: db/${pad3(st.expected)}), guard triggers, unique indexes${st.functionsChecked ? ' and trigger functions' : ''} in place` })
  return lines
}

// The backend's check (checkSchemaAtStart): the pool and options it watches,
// the last state, and the text last logged (only a change is logged again).
const RECHECK_MS = 5 * 60 * 1000
const RETRY_MS = [5000, 15000, 30000, 60000]
const REFRESH_MAX_AGE_MS = 60 * 1000
const ERROR_MAX_AGE_MS = 5000 // a failed check is not repeated for every /health call
let watch = null
let lastState = null

async function runCheck (w) {
  if (w.inflight) return w.inflight
  w.inflight = (async () => {
    let st
    try {
      st = await readSchemaState(w.pool, { dbDir: w.dbDir })
    } catch (err) {
      st = { ready: false, error: err.message, checkedAt: new Date().toISOString() }
    }
    if (watch !== w) return st // stopped or replaced meanwhile
    lastState = st
    const lines = describeSchemaState(st, { dbDir: w.dbDir })
    const text = lines.map((l) => l.text).join('\n')
    if (text !== w.logged) {
      w.logged = text
      for (const { level, text } of lines) {
        const prefix = level === 'error' ? '❌ [DB] ' : level === 'warn' ? '⚠️  [DB] ' : '[DB] '
        ;(w.log[level] ?? w.log.log)(prefix + text)
      }
    }
    // Next check: soon while the database cannot be reached (it may still be
    // starting, e.g. after a host reboot), else every few minutes.
    clearTimeout(w.timer)
    w.retry = st.error ? w.retry + 1 : 0
    const ms = st.error ? w.retryMs[Math.min(w.retry, w.retryMs.length) - 1] : w.recheckMs
    if (ms > 0) {
      w.timer = setTimeout(() => { runCheck(w) }, ms)
      w.timer.unref?.()
    }
    return st
  })().finally(() => { w.inflight = null })
  return w.inflight
}

/**
 * Startup check (server.js, DATABASE_URL mode): reads the state, logs it and
 * keeps it for schemaStatus(); then checks again every `recheckMs` (5 min),
 * after a failure sooner (`retryMs`: 5, 15, 30 s, then every 60 s), and logs
 * only a change (a guard dropped later, a migration applied, the database
 * reachable again). Never throws: a database that is down is logged and
 * reported as not checked. The timers do not keep the process alive.
 */
export async function checkSchemaAtStart (pool, { log = console, dbDir = defaultDbDir(), recheckMs = RECHECK_MS, retryMs = RETRY_MS } = {}) {
  stopSchemaChecks()
  watch = { pool, log, dbDir, recheckMs, retryMs: retryMs.length ? retryMs : [0], retry: 0, timer: null, inflight: null, logged: null }
  return runCheck(watch)
}

/** The state of the last check (null before checkSchemaAtStart). */
export function schemaStatus () {
  return lastState
}

/**
 * A state at most `maxAgeMs` old (default 60 s; a failed check 5 s), checked
 * again now when the last one is older; for /health. Concurrent calls share
 * one check. Never throws; null before checkSchemaAtStart.
 */
export async function refreshSchemaStatus ({ maxAgeMs = REFRESH_MAX_AGE_MS } = {}) {
  if (!watch) return lastState
  const age = lastState ? Date.now() - Date.parse(lastState.checkedAt) : Infinity
  if (age < (lastState?.error ? Math.min(maxAgeMs, ERROR_MAX_AGE_MS) : maxAgeMs)) return lastState
  return runCheck(watch)
}

/** Ends the checks of checkSchemaAtStart (tests; a server that shuts down). */
export function stopSchemaChecks () {
  if (watch) clearTimeout(watch.timer)
  watch = null
}
