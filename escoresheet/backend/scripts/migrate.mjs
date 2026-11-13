#!/usr/bin/env node
/**
 * The migration runner: applies every db/NNN_*.sql the database does not have
 * yet, once, in number order, and records it in ov_meta.schema_migrations
 * (version, file, SHA-256 of the file, time). deploy/deploy.sh runs it with
 * the NEW image before the backend switches to it; by hand only for the dev
 * database, a re-run (--rerun) or the status (--status).
 *
 *   - Runs as the owner role (ov_owner; a superuser or the owner of
 *     public.matches), never as ov_app. Holds an advisory lock: a second run
 *     waits (30 s) and then gives up.
 *   - Each file runs in its own transaction together with its record: it
 *     either applies completely and is recorded, or changes nothing. A file
 *     may carry its own BEGIN; ... COMMIT; (so it also runs by hand with
 *     psql); the runner takes them out and wraps the file itself. Any other
 *     transaction control, and psql meta-commands, are refused.
 *   - A recorded file whose content changed is refused (the whole run stops
 *     before anything runs): a migration is never edited once it ran; the
 *     change goes into a new file. So is a database that has versions this
 *     image has no file for (an older image's runner).
 *   - After the numbered files, db/current_definitions.sql (the current body
 *     of every function that more than one file defines), on every run: a
 *     file run again by hand (007, 011, 015, 030) cannot leave its older
 *     trigger function behind past the next run.
 *   - Then USAGE + SELECT on the record for the app role (ov_app), so the
 *     backend can tell whether the database is behind its image
 *     (lib/schemaVersion.js), also after a restore without privileges.
 *   - roles.sql is psql-only (\if, \gexec): deploy.sh applies it right after
 *     this, through apply-roles.sh.
 *   - lock_timeout 10 s for the session (a file's SET LOCAL wins): a file
 *     that has to wait for a lock fails instead of stalling the live backend's
 *     writes behind it.
 *
 * First run (no record yet): the files up to 033 were applied by hand or by
 * restore.sh. When the objects of db/030 to db/033 are there, 000-033 are
 * recorded without running them; otherwise the run stops and asks where the
 * database stands: --baseline NNN records 000..NNN without running them
 * (checking what it can of them) and runs the files after NNN.
 * --baseline 001 builds a freshly restored dump from 002 on.
 *
 * Usage (production: deploy/deploy.sh; the dev database by hand):
 *   OV_MIGRATE_DATABASE_URL=postgres://ov_owner@host:5432/openvolley node scripts/migrate.mjs [options]
 *     --status          what ran and what would run; changes nothing. Exit 3
 *                       when a file is pending (or no record yet). Also as
 *                       the backend role: falls back to DATABASE_URL
 *     --baseline NNN    first run only (see above)
 *     --rerun NNN       run a recorded file once more (a file whose header asks
 *                       for a second run, e.g. 032 after the switch; or 007 to
 *                       put dropped guard triggers back); repeatable
 *     --db-dir DIR      the migrations (default: this checkout's / image's db/)
 *   The password comes from PGPASSWORD or the URL (never a command-line
 *   argument). OV_MIGRATE_APP_ROLE (default ov_app), OV_MIGRATE_LOCK_TIMEOUT
 *   (default 10s).
 *
 * Exit codes: 0 done (or nothing pending), 1 error, 2 usage, 3 --status with
 * pending files.
 */

import pg from 'pg'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultDbDir, migrationFiles, sha256, pad3, recordAccess,
  RECORD_SCHEMA, RECORD_TABLE, CURRENT_DEFINITIONS_FILE
} from '../lib/schemaVersion.js'

export class MigrationError extends Error {}

// 000 and 001 are steps of restore.sh around pg_restore (psql, the users CSV):
// recorded at the first run, never run by the runner.
const RESTORE_ONLY = new Set([0, 1])
// Files up to this one were applied by hand / restore.sh before the runner
// existed; only these can be recorded without running (--baseline).
const BASELINE_MAX = 33
const LOCK_KEY_SQL = "hashtextextended('openvolley:migrate', 0)"

// What each of the last hand-applied files left, to check a first run's
// baseline against (true when the file's objects are there).
const PROBES = {
  30: `EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'club_managers_roles' AND tgrelid = to_regclass('public.club_managers'))
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'team_managers_roles' AND tgrelid = to_regclass('public.team_managers'))`,
  31: `EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.ov_manager_rows_changed()') AND prosecdef)`,
  32: `EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'matches_external_id_lock' AND tgrelid = to_regclass('public.matches'))
       AND EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.ov_events_apply_void()') AND prosrc LIKE '%match_id = NEW.match_id%')`,
  33: `to_regclass('public.match_scoresheets') IS NOT NULL AND to_regclass('public.match_scoresheets_start') IS NULL
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.match_scoresheets') AND attname = 'first_stored_at' AND NOT attisdropped)`
}

// --- SQL text ---------------------------------------------------------------------

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/
const lineOf = (sql, pos) => sql.slice(0, pos).split('\n').length

/**
 * Splits SQL into its top-level statements (strings, quoted identifiers,
 * dollar quotes and comments respected). Returns { statements: [{ start, end,
 * head }], masked } where `head` is the statement's text without comments and
 * `masked` the whole text with comments blanked out (same length).
 */
export function scanSql (sql, name = 'sql') {
  const masked = sql.split('')
  const statements = []
  const n = sql.length
  let start = 0
  let i = 0
  const fail = (what, at) => { throw new MigrationError(`${name}: ${what} (line ${lineOf(sql, at)})`) }
  const blank = (from, to) => { for (let k = from; k < to; k++) if (sql[k] !== '\n') masked[k] = ' ' }
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const e = sql.indexOf('\n', i)
      const end = e < 0 ? n : e
      blank(i, end)
      i = end
    } else if (ch === '/' && next === '*') {
      const from = i
      let depth = 1
      i += 2
      while (i < n && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2 } else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 } else i++
      }
      if (depth) fail('unterminated /* comment', from)
      blank(from, i)
    } else if (ch === "'") {
      const from = i
      const escapes = /[Ee]/.test(sql[i - 1] ?? '') && !IDENT_CHAR.test(sql[i - 2] ?? ' ')
      i++
      for (;;) {
        if (i >= n) fail('unterminated string', from)
        if (escapes && sql[i] === '\\') { i += 2; continue }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue }
          i++
          break
        }
        i++
      }
    } else if (ch === '"') {
      const from = i
      i++
      for (;;) {
        if (i >= n) fail('unterminated quoted identifier', from)
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue }
          i++
          break
        }
        i++
      }
    } else if (ch === '$' && !IDENT_CHAR.test(sql[i - 1] ?? ' ') && /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.test(sql.slice(i, i + 66))) {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 66))[0]
      const close = sql.indexOf(tag, i + tag.length)
      if (close < 0) fail(`unterminated ${tag} quote`, i)
      i = close + tag.length
    } else if (ch === '\\') {
      fail('a psql meta-command (\\...); the runner sends plain SQL, apply this file with psql', i)
    } else if (ch === ';') {
      statements.push({ start, end: i + 1 })
      start = i + 1
      i++
    } else {
      i++
    }
  }
  const text = masked.join('')
  if (text.slice(start).trim()) statements.push({ start, end: n })
  for (const s of statements) {
    const own = text.slice(s.start, s.end)
    s.head = own.replace(/;\s*$/, '').trim()
    s.at = s.start + Math.max(0, own.search(/\S/))
  }
  return { statements: statements.filter((s) => s.head), masked: text }
}

const BEGIN_RE = /^(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION)\b/i
const COMMIT_RE = /^(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?$/i
const OTHER_TX_RE = /^(?:ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED|COMMIT\s+AND\s+CHAIN|SET\s+SESSION\s+CHARACTERISTICS)\b/i

/**
 * The file's SQL for the runner's own transaction: a first-statement BEGIN and
 * a last-statement COMMIT (the file's own transaction) are blanked out, same
 * length, so error positions still point into the file. Anything else that
 * controls the transaction is refused: the file and its record must commit
 * together.
 */
export function unwrapTransaction (sql, name = 'sql') {
  const { statements } = scanSql(sql, name)
  const out = sql.split('')
  const blank = (s) => { for (let k = s.start; k < s.end; k++) if (sql[k] !== '\n') out[k] = ' ' }
  const begins = statements.filter((s) => BEGIN_RE.test(s.head))
  const commits = statements.filter((s) => COMMIT_RE.test(s.head) || /^COMMIT\b/i.test(s.head))
  const other = statements.find((s) => OTHER_TX_RE.test(s.head) && !COMMIT_RE.test(s.head))
  if (other) throw new MigrationError(`${name}: ${other.head.split(/\s+/)[0].toUpperCase()} at line ${lineOf(sql, other.at)}: a migration is one transaction, the runner's (no ROLLBACK, SAVEPOINT or other transaction control)`)
  if (begins.length > 1 || commits.length > 1 ||
      (begins.length && statements[0] !== begins[0]) || (commits.length && statements[statements.length - 1] !== commits[0])) {
    throw new MigrationError(`${name}: a migration is one transaction: at most one BEGIN, as its first statement, and one COMMIT, as its last`)
  }
  if (begins.length !== commits.length) {
    throw new MigrationError(`${name}: ${begins.length ? 'BEGIN without COMMIT' : 'COMMIT without BEGIN'}`)
  }
  if (begins.length) {
    if (!/^(?:BEGIN|START\s+TRANSACTION)(?:\s+(?:WORK|TRANSACTION))?$/i.test(begins[0].head)) {
      throw new MigrationError(`${name}: BEGIN with options (${begins[0].head}): the runner's transaction has the defaults`)
    }
    blank(begins[0])
    blank(commits[0])
  }
  return out.join('')
}

// --- current_definitions.sql coverage ----------------------------------------------

const qname = (raw, defaultSchema = 'public') => {
  const parts = raw.replace(/"/g, '').toLowerCase().split('.')
  return parts.length > 1 ? parts.join('.') : `${defaultSchema}.${parts[0]}`
}
const NAME = '(?:"?[A-Za-z_][\\w$]*"?\\.)?"?[A-Za-z_][\\w$]*"?'
const FN_RE = new RegExp(`\\b(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION|ALTER\\s+(?:FUNCTION|ROUTINE))\\s+(${NAME})\\s*\\(`, 'gi')
const TRG_RE = new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+(${NAME})\\s[\\s\\S]*?\\bON\\s+(${NAME})`, 'gi')
const DROP_FN_RE = new RegExp(`\\bDROP\\s+(?:FUNCTION|ROUTINE)\\s+(?:IF\\s+EXISTS\\s+)?(${NAME})`, 'gi')
const DROP_TRG_RE = new RegExp(`\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?(${NAME})\\s+ON\\s+(${NAME})`, 'gi')

/**
 * Functions and triggers a SQL text defines and drops: { defined, dropped },
 * Sets of 'function public.x' / 'trigger public.t.name'.
 */
function definedObjects (sql, name) {
  const { masked } = scanSql(sql, name)
  const defined = new Set()
  const dropped = new Set()
  const fn = (raw) => qname(raw)
  const trg = (rawName, rawTable) => `trigger ${qname(rawTable)}.${rawName.replace(/"/g, '').toLowerCase()}`
  for (const m of masked.matchAll(FN_RE)) if (!fn(m[1]).startsWith('pg_temp.')) defined.add(`function ${fn(m[1])}`)
  for (const m of masked.matchAll(TRG_RE)) defined.add(trg(m[1], m[2]))
  for (const m of masked.matchAll(DROP_FN_RE)) if (!fn(m[1]).startsWith('pg_temp.')) dropped.add(`function ${fn(m[1])}`)
  for (const m of masked.matchAll(DROP_TRG_RE)) dropped.add(trg(m[1], m[2]))
  return { defined, dropped }
}

/**
 * What is wrong with db/current_definitions.sql against the numbered files
 * (empty: nothing). Every function or trigger that two or more numbered files
 * define must be in it, as of the newest of them ("current as of: db/NNN");
 * and it defines nothing the numbered files do not.
 */
export function currentDefinitionProblems ({ dbDir = defaultDbDir() } = {}) {
  const problems = []
  const where = new Map() // object -> [versions that define it]
  const droppedIn = new Map() // object -> [versions that drop it without defining it again]
  for (const f of migrationFiles(dbDir)) {
    if (RESTORE_ONLY.has(f.version)) continue
    const { defined, dropped } = definedObjects(readFileSync(f.path, 'utf8'), f.file)
    for (const o of defined) {
      if (!where.has(o)) where.set(o, [])
      where.get(o).push(f.version)
    }
    for (const o of dropped) {
      if (defined.has(o)) continue
      if (!droppedIn.has(o)) droppedIn.set(o, [])
      droppedIn.get(o).push(f.version)
    }
  }
  const path = join(dbDir, CURRENT_DEFINITIONS_FILE)
  if (!existsSync(path)) return [`${CURRENT_DEFINITIONS_FILE} is missing`]
  const sql = readFileSync(path, 'utf8')
  const asOf = Number((/current as of: db\/(\d{3})/.exec(sql) || [])[1] ?? NaN)
  if (!Number.isInteger(asOf)) problems.push(`${CURRENT_DEFINITIONS_FILE}: no "current as of: db/NNN" line`)
  const current = definedObjects(sql, CURRENT_DEFINITIONS_FILE).defined
  const fileOf = new Map(migrationFiles(dbDir).map((f) => [f.version, f.file]))
  for (const [o, versions] of where) {
    if (versions.length < 2) continue
    const newest = Math.max(...versions)
    if (!current.has(o)) {
      problems.push(`${o} is defined in ${versions.map((v) => `db/${pad3(v)}`).join(' and ')}: copy its definition from db/${fileOf.get(newest)} into ${CURRENT_DEFINITIONS_FILE} (otherwise a run of an older file by hand leaves the older one behind)`)
    } else if (newest > asOf) {
      problems.push(`db/${fileOf.get(newest)} redefines ${o} after ${CURRENT_DEFINITIONS_FILE} (current as of db/${pad3(asOf)}): copy its new definition there and raise "current as of" (otherwise every run puts the older one back)`)
    }
  }
  for (const o of current) {
    if (!where.has(o)) problems.push(`${CURRENT_DEFINITIONS_FILE} defines ${o}, which no numbered migration creates (new objects go into a new numbered file)`)
    const drops = (droppedIn.get(o) ?? []).filter((v) => v > Math.max(...(where.get(o) ?? [0])))
    if (drops.length) problems.push(`db/${fileOf.get(drops[drops.length - 1])} drops ${o}: take it out of ${CURRENT_DEFINITIONS_FILE} too (otherwise every run creates it again)`)
  }
  return problems
}

// --- Runner -------------------------------------------------------------------------

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function failure (f, sql, err) {
  const ctx = err.where ? ` (${String(err.where).split('\n')[0]})` : ''
  const at = Number.isInteger(err.ovAt) ? ` at line ${lineOf(sql, err.ovAt)}` : ''
  return new MigrationError(`${f.file} failed${at}: ${err.message}${ctx}; rolled back, nothing of it was applied`)
}

/**
 * Runs an unwrapped file statement by statement (in the caller's
 * transaction), so that a failure names its line: Postgres reports no
 * position for an error at run time, and in a multi-statement query not even
 * which statement failed.
 */
async function runStatements (client, body, name) {
  for (const s of scanSql(body, name).statements) {
    try {
      await client.query(body.slice(s.start, s.end))
    } catch (err) {
      const pos = Number(err.position)
      err.ovAt = Number.isInteger(pos) && pos > 0 ? s.start + pos - 1 : s.at
      throw err
    }
  }
}

async function inTransaction (client, fn) {
  await client.query('BEGIN')
  try {
    const r = await fn()
    await client.query('COMMIT')
    return r
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

/**
 * Applies the pending migrations of `dbDir` to the database (see the header).
 * Returns { firstRun, baseline, applied, rerun, pending, current }: baseline
 * is the NNN recorded without running at this first run (else null), applied
 * the versions run now, pending (dry run) the versions that would run.
 */
export async function migrate ({
  connectionString, client: givenClient, dbDir = defaultDbDir(), baseline = null, rerun = [], dryRun = false,
  appRole = 'ov_app', lockTimeout = '10s', lockWaitMs = 30000, log = (line) => console.log(line)
} = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(appRole)) throw new MigrationError(`app role ${JSON.stringify(appRole)}: not a plain role name`)
  if (!/^\d+(ms|s|min)?$/.test(String(lockTimeout))) throw new MigrationError(`lock timeout ${JSON.stringify(lockTimeout)}: e.g. 10s`)
  if (baseline != null && !(Number.isInteger(baseline) && baseline >= 1 && baseline <= BASELINE_MAX)) {
    throw new MigrationError(`--baseline ${baseline}: only the files from before the runner can be recorded without running (001 to ${pad3(BASELINE_MAX)})`)
  }
  // Every check that needs no database first.
  const files = migrationFiles(dbDir)
  if (!files.length) throw new MigrationError(`no db/NNN_*.sql in ${dbDir}`)
  for (const f of files) {
    f.sql = readFileSync(f.path, 'utf8')
    f.checksum = sha256(f.sql)
  }
  const byVersion = new Map(files.map((f) => [f.version, f]))
  const stale = currentDefinitionProblems({ dbDir })
  if (stale.length) throw new MigrationError(`${CURRENT_DEFINITIONS_FILE} is not current; nothing was run:\n  - ${stale.join('\n  - ')}`)
  const currentSql = readFileSync(join(dbDir, CURRENT_DEFINITIONS_FILE), 'utf8')
  const currentBody = unwrapTransaction(currentSql, CURRENT_DEFINITIONS_FILE)
  for (const v of rerun) {
    if (!byVersion.has(v)) throw new MigrationError(`--rerun ${pad3(v)}: this image has no db/${pad3(v)}_*.sql`)
    if (RESTORE_ONLY.has(v)) throw new MigrationError(`--rerun ${pad3(v)}: ${byVersion.get(v).file} is a restore step (restore.sh), never run by the runner`)
  }

  const client = givenClient ?? new pg.Client({ connectionString, application_name: 'openvolley-migrate' })
  if (!givenClient) await client.connect()
  let current = null
  const onNotice = (msg) => {
    if (/, skipping$/.test(msg.message)) return // IF [NOT] EXISTS
    log(`[migrate]   ${current ? current + ': ' : ''}${msg.severity || 'NOTICE'}: ${msg.message}`)
  }
  client.on('notice', onNotice)
  let locked = false
  try {
    const { rows: [who] } = await client.query(`
      SELECT current_user AS role, r.rolsuper AS superuser, to_regclass('public.matches') IS NOT NULL AS has_matches,
             coalesce((SELECT pg_has_role(current_user, c.relowner, 'USAGE') FROM pg_class c WHERE c.oid = to_regclass('public.matches')), false) AS owns_matches
        FROM pg_roles r WHERE r.rolname = current_user`)
    if (!who.has_matches) throw new MigrationError('public.matches does not exist: not an OpenVolley database (restore it first: restore.sh / restore-db.sh)')
    if (!dryRun && !who.superuser && !who.owns_matches) {
      throw new MigrationError(`connected as ${who.role}, which does not own the schema: migrations run as the owner role (ov_owner), never as the backend's`)
    }
    await client.query(`SET lock_timeout = '${lockTimeout}'`)

    if (!dryRun) {
      const deadline = Date.now() + lockWaitMs
      for (;;) {
        const { rows: [l] } = await client.query(`SELECT pg_try_advisory_lock(${LOCK_KEY_SQL}) AS ok`)
        if (l.ok) { locked = true; break }
        if (Date.now() >= deadline) throw new MigrationError(`another migration run holds the lock (waited ${Math.round(lockWaitMs / 1000)} s); nothing was run`)
        await sleep(Math.min(250, lockWaitMs))
      }
    }

    // The record; created and filled in one transaction at the first run.
    const summary = { firstRun: false, baseline: null, applied: [], rerun: [], pending: [], current: false }
    const access = await recordAccess(client)
    if (access.has_table && !access.readable) throw new MigrationError(`${RECORD_TABLE} is not readable by ${who.role} (scripts/migrate.mjs grants the app role SELECT on it when it runs as the owner)`)
    const readRecord = async () => (await client.query(`SELECT version, file, checksum, baseline, applied_at FROM ${RECORD_TABLE} ORDER BY version`)).rows
    let rows = access.has_table ? await readRecord() : []
    if (rows.length && baseline != null) throw new MigrationError(`--baseline is for the first run only; ${RECORD_TABLE} already records ${rows.length} file(s)`)
    if (!rows.length) {
      summary.firstRun = true
      const probes = {}
      for (const [v, sql] of Object.entries(PROBES)) probes[v] = (await client.query(`SELECT (${sql}) AS ok`)).rows[0].ok
      const have = Object.keys(probes).filter((v) => probes[v]).map(Number)
      const lacking = Object.keys(probes).filter((v) => !probes[v]).map(Number)
      let b = baseline
      if (b == null) {
        if (lacking.length) {
          const msg = `no migration record yet, and the objects of ${lacking.map((v) => `db/${pad3(v)}`).join(', ')} are missing${have.length ? ` (those of ${have.map((v) => `db/${pad3(v)}`).join(', ')} are there)` : ''}: ` +
            'tell the runner the last file this database has, --baseline NNN (files up to NNN are recorded without running, the later ones run; --baseline 001 for a freshly restored dump). Nothing was changed.'
          if (!dryRun) throw new MigrationError(msg)
          log(`[migrate] ${msg}`)
          summary.pending = files.filter((f) => !RESTORE_ONLY.has(f.version)).map((f) => f.version)
          return summary
        }
        b = BASELINE_MAX
      } else {
        const wrong = lacking.filter((v) => v <= b)
        if (wrong.length) throw new MigrationError(`--baseline ${pad3(b)}: the objects of ${wrong.map((v) => `db/${pad3(v)}`).join(', ')} are missing, so this database is not at db/${pad3(b)}. Nothing was changed.`)
      }
      summary.baseline = b
      const recordNow = files.filter((f) => f.version <= b)
      if (dryRun) {
        log(`[migrate] no record yet: would record ${recordNow.map((f) => pad3(f.version)).join(', ')} without running them`)
        rows = recordNow.map((f) => ({ version: f.version, file: f.file, checksum: f.checksum, baseline: true }))
      } else {
        await inTransaction(client, async () => {
          await client.query(`CREATE SCHEMA IF NOT EXISTS ${RECORD_SCHEMA}`)
          await client.query(`COMMENT ON SCHEMA ${RECORD_SCHEMA} IS 'OpenVolley bookkeeping (scripts/migrate.mjs): which db/NNN_*.sql files ran'`)
          await client.query(`CREATE TABLE IF NOT EXISTS ${RECORD_TABLE} (
            version     integer     PRIMARY KEY CHECK (version BETWEEN 0 AND 999),
            file        text        NOT NULL CHECK (length(file) BETWEEN 1 AND 200),
            checksum    text        NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
            applied_at  timestamptz NOT NULL DEFAULT now(),
            baseline    boolean     NOT NULL DEFAULT false,
            last_run_at timestamptz
          )`)
          await client.query(`COMMENT ON TABLE ${RECORD_TABLE} IS 'One row per db/NNN_*.sql that ran (scripts/migrate.mjs): checksum = SHA-256 of the file; baseline = recorded at the first run without running (applied by hand or restore.sh before); last_run_at = --rerun'`)
          for (const f of recordNow) {
            await client.query(`INSERT INTO ${RECORD_TABLE} (version, file, checksum, baseline) VALUES ($1, $2, $3, true)`, [f.version, f.file, f.checksum])
          }
        })
        log(`[migrate] first run: recorded ${pad3(recordNow[0]?.version ?? 0)}-${pad3(b)} (${recordNow.length} files) without running them`)
        rows = await readRecord()
      }
    }

    // The record against this image's files.
    const changed = rows.filter((r) => byVersion.has(r.version) && byVersion.get(r.version).checksum !== r.checksum)
    if (changed.length) {
      throw new MigrationError(`${changed.map((r) => byVersion.get(r.version).file).join(', ')} changed after ${changed.length > 1 ? 'they' : 'it'} ran (recorded SHA-256 ${changed.map((r) => r.checksum.slice(0, 12)).join(', ')}): ` +
        'a migration is never edited once applied; undo the edit and put the change into a new file. Nothing was run.')
    }
    const unknown = rows.filter((r) => !byVersion.has(r.version))
    if (unknown.length) {
      const newest = files.length ? files[files.length - 1].version : -1
      throw new MigrationError(`the database records ${unknown.map((r) => `${r.file} (${pad3(r.version)})`).join(', ')}, which this image does not have` +
        `${unknown.some((r) => r.version > newest) ? ': the database is newer than this image; run the newer image\'s runner' : ' (a renamed or deleted migration?)'}. Nothing was run.`)
    }
    const recorded = new Set(rows.map((r) => r.version))
    const pending = files.filter((f) => !recorded.has(f.version))
    const restorePending = pending.filter((f) => RESTORE_ONLY.has(f.version))
    if (restorePending.length) throw new MigrationError(`${restorePending.map((f) => f.file).join(', ')}: restore steps (restore.sh), never run by the runner`)
    for (const f of [...pending, ...rerun.map((v) => byVersion.get(v))]) f.body = unwrapTransaction(f.sql, f.file)
    for (const v of rerun) if (!recorded.has(v)) throw new MigrationError(`--rerun ${pad3(v)}: ${byVersion.get(v).file} has not run yet (it runs as a pending file)`)
    summary.pending = pending.map((f) => f.version)

    if (dryRun) {
      log(pending.length ? `[migrate] pending: ${pending.map((f) => f.file).join(', ')}` : '[migrate] up to date: no pending file')
      if (rerun.length) log(`[migrate] would run again: ${rerun.map((v) => byVersion.get(v).file).join(', ')}`)
      return summary
    }

    for (const f of pending) {
      current = f.file
      const t0 = Date.now()
      try {
        await inTransaction(client, async () => {
          await runStatements(client, f.body, f.file)
          await client.query(`INSERT INTO ${RECORD_TABLE} (version, file, checksum) VALUES ($1, $2, $3)`, [f.version, f.file, f.checksum])
        })
      } catch (err) {
        throw failure(f, f.sql, err)
      }
      summary.applied.push(f.version)
      log(`[migrate] ${f.file} applied (${Date.now() - t0} ms)`)
    }
    for (const v of rerun) {
      const f = byVersion.get(v)
      current = f.file
      try {
        await inTransaction(client, async () => {
          await runStatements(client, f.body, f.file)
          await client.query(`UPDATE ${RECORD_TABLE} SET last_run_at = now() WHERE version = $1`, [f.version])
        })
      } catch (err) {
        throw failure(f, f.sql, err)
      }
      summary.rerun.push(v)
      log(`[migrate] ${f.file} run again`)
    }
    current = CURRENT_DEFINITIONS_FILE
    try {
      await inTransaction(client, () => runStatements(client, currentBody, CURRENT_DEFINITIONS_FILE))
    } catch (err) {
      throw failure({ file: CURRENT_DEFINITIONS_FILE }, currentSql, err)
    }
    summary.current = true
    current = null
    log(`[migrate] ${CURRENT_DEFINITIONS_FILE} applied`)

    const { rows: [role] } = await client.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1', [appRole])
    await client.query(`REVOKE ALL ON SCHEMA ${RECORD_SCHEMA} FROM PUBLIC; REVOKE ALL ON ${RECORD_TABLE} FROM PUBLIC`)
    if (role.n) {
      await client.query(`GRANT USAGE ON SCHEMA ${RECORD_SCHEMA} TO ${quoteIdent(appRole)}; ` +
        `REVOKE ALL ON ${RECORD_TABLE} FROM ${quoteIdent(appRole)}; GRANT SELECT ON ${RECORD_TABLE} TO ${quoteIdent(appRole)}`)
    }
    const newest = Math.max(...files.map((f) => f.version))
    log(`[migrate] done: ${summary.applied.length ? `applied ${summary.applied.map(pad3).join(', ')}` : 'nothing pending'}; database at db/${pad3(newest)}`)
    return summary
  } finally {
    client.removeListener('notice', onNotice)
    if (locked) await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`).catch(() => {})
    if (!givenClient) await client.end().catch(() => {})
  }
}

// --- CLI ------------------------------------------------------------------------------

const USAGE = `Usage: OV_MIGRATE_DATABASE_URL=postgres://ov_owner@host:5432/openvolley node scripts/migrate.mjs [--status] [--baseline NNN] [--rerun NNN]... [--db-dir DIR]
  (production: deploy/deploy.sh runs it; see the header of this file)`

export function parseArgs (argv) {
  const opts = { status: false, baseline: null, rerun: [], dbDir: null }
  const num = (flag, v) => {
    if (!/^\d{1,3}$/.test(v ?? '')) throw new MigrationError(`${flag} needs a migration number (e.g. 031)`)
    return Number(v)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--status') opts.status = true
    else if (a === '--baseline') opts.baseline = num(a, argv[++i])
    else if (a === '--rerun') opts.rerun.push(num(a, argv[++i]))
    else if (a === '--db-dir') {
      if (!argv[i + 1]) throw new MigrationError('--db-dir needs a directory')
      opts.dbDir = resolve(argv[++i])
    }
    else if (a === '-h' || a === '--help') opts.help = true
    else throw new MigrationError(`unknown argument ${a}`)
  }
  return opts
}

async function main () {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`)
    return 2
  }
  if (opts.help) { console.log(USAGE); return 0 }
  const url = process.env.OV_MIGRATE_DATABASE_URL || (opts.status ? process.env.DATABASE_URL : '')
  if (!url) {
    console.error(`OV_MIGRATE_DATABASE_URL is not set (the owner role's connection; never the backend's DATABASE_URL).\n${USAGE}`)
    return 2
  }
  const r = await migrate({
    connectionString: url,
    dbDir: opts.dbDir ?? defaultDbDir(),
    baseline: opts.baseline,
    rerun: opts.rerun,
    dryRun: opts.status,
    appRole: process.env.OV_MIGRATE_APP_ROLE || 'ov_app',
    lockTimeout: process.env.OV_MIGRATE_LOCK_TIMEOUT || '10s'
  })
  return opts.status && (r.firstRun || r.pending.length) ? 3 : 0
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]) } catch { return false }
})()
if (isMain) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`[migrate] FAILED: ${err instanceof MigrationError ? err.message : (err?.code ? `${err.code}: ${err.message}` : err?.message || err)}`)
    process.exit(1)
  })
}
