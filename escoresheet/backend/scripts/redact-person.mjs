#!/usr/bin/env node
/**
 * Operator tool for a data subject's request (privacy policy section 19):
 * erase one person from every stored copy, or correct their date of birth.
 * Runs as the owner role (closed matches, the event history, the activity
 * and audit logs are append-only or frozen for the backend role), in ONE
 * transaction with ov.allow_closed / ov.admin, and is audited
 * (person.redact: the mode, a digest of the person and the counts per table,
 * never a name). Dry run unless --apply.
 *
 * The person is found by first and last name (case, accents' composition and
 * spaces normalised), and, with --dob, only where a stored date of birth is
 * that date or missing (a namesake with another date is left). --match limits
 * it to those matches (external_id, repeatable) and everything stored for them.
 *
 *   records  (redacted in place: the record keeps the shirt number, role and
 *            flags; names become "[redacted]", date of birth, licence number,
 *            e-mail and phone go)
 *            matches (rosters, team staff, officials, remarks and every other
 *            json column), match_closures, events, event_revisions,
 *            activity_log, audit_log, game_rosters, beach_entries,
 *            beach_competition_matches, match_live_state, svrz_games
 *            Free text (remarks, manual changes, referee_1 ...) loses the full
 *            name ("First Last", "Last First", "Last, First").
 *   lists    (the row is deleted): club_licences, competition_players,
 *            competition_staff, referee_database
 *   files    the scoresheet PDFs and their JSON files of the matches touched
 *            are listed; --drop-files removes them (a PDF is not rewritten:
 *            the scorer or an admin makes a new one from the corrected record)
 * With --set-dob the date of birth is set to that date in the same places
 * (rows of lists included) and nothing else changes.
 *
 * Not reached: the account (profiles, auth.users: the account's own
 * deletion or the admin's), the per-account backup copies (encrypted, gone
 * after 30 days), copies on the devices, mails already sent, and the
 * encrypted backups (up to about 6 months). The backup note: --register FILE
 * appends the request (mode, the digest, the new date) to a register kept
 * outside the database; after a restore from a backup older than the request,
 * --reapply FILE runs every request of it again (structured fields: the
 * free-text names need the name, i.e. a new run with --first/--last).
 *
 * Usage (on the host, the owner role's connection as for scripts/migrate.mjs;
 * the storage root for the files):
 *   OV_MIGRATE_DATABASE_URL=postgres://ov_owner@... STORAGE_ROOT=/data/storage \
 *     node scripts/redact-person.mjs --first Mia --last Example [--dob 2011-03-02] \
 *       [--match <external_id>]... [--set-dob 2011-03-20] [--drop-files] \
 *       [--actor <admin account uuid>] [--register FILE] [--apply]
 *   ... node scripts/redact-person.mjs --reapply FILE [--apply]
 * Prints counts per table and the files (paths) only, never the rows.
 * Exit codes: 0 done (or dry run), 1 error, 2 usage.
 */

import pg from 'pg'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { createStorage, storageOptionsFromEnv } from '../lib/storage.js'

export const REDACTED = '[redacted]'

const FIRST_RE = /^(.*?)(first_?name|firstname|given_?name|vorname)$/i
const LAST_SUFFIXES = ['last_name', 'lastName', 'lastname', 'surname', 'family_name', 'familyName', 'nachname']
const DOB_SUFFIXES = ['dob', 'dateOfBirth', 'date_of_birth', 'birthDate', 'birthdate', 'birth_date']
const ERASE_SUFFIXES = ['licence', 'license', 'licenceNumber', 'licenseNumber', 'licence_number', 'license_number',
  'sv_number', 'svNumber', 'email', 'phone', 'mobile']

/** Records: redacted in place. Lists: the person's row is deleted (a correction edits it). */
export const RECORD_TABLES = ['matches', 'match_closures', 'events', 'event_revisions', 'activity_log', 'audit_log',
  'game_rosters', 'beach_entries', 'beach_competition_matches', 'match_live_state', 'svrz_games']
export const LIST_TABLES = ['club_licences', 'competition_players', 'competition_staff', 'referee_database']
// The tables whose rows belong to one match (for --match), by column
const MATCH_COLUMN = { matches: 'id', match_closures: 'match_id', events: 'match_id', event_revisions: 'match_id', match_live_state: 'match_id', audit_log: 'match_id' }

export function norm (s) {
  return typeof s === 'string' ? s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-CH') : ''
}

/** The digest kept in the audit log and the register: never the name. */
export function personDigest ({ first, last, dob = '' }) {
  return createHash('sha256').update(`ov-person:${norm(first)}\u0000${norm(last)}\u0000${dob || ''}`, 'utf8').digest('hex')
}

const dateOf = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)

/**
 * The person groups of one object: for each first-name key (with its prefix,
 * e.g. referee_1_first_name), its last-name, date-of-birth and erase keys.
 */
function groupsOf (o) {
  const out = []
  for (const k of Object.keys(o)) {
    const m = FIRST_RE.exec(k)
    if (!m) continue
    const p = m[1]
    const last = LAST_SUFFIXES.map((s) => p + s).find((x) => x in o)
    if (!last) continue
    out.push({
      first: k,
      last,
      dob: DOB_SUFFIXES.map((s) => p + s).filter((x) => x in o),
      erase: ERASE_SUFFIXES.map((s) => p + s).filter((x) => x in o)
    })
  }
  return out
}

/**
 * The matcher of one request: `who` = { first, last, dob? } (the name) or
 * { digest, withDob } (a register line: structured fields only).
 */
export function matcherOf (who) {
  if (who.digest) {
    return (first, last, dob) => personDigest({ first, last, dob: who.withDob ? (dob || '') : '' }) === who.digest ||
      (who.withDob && !dob && personDigest({ first, last, dob: '' }) === who.nameDigest)
  }
  const f = norm(who.first)
  const l = norm(who.last)
  return (first, last, dob) => norm(first) === f && norm(last) === l && (!who.dob || !dob || dob === who.dob)
}

function escapeRe (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Free-text forms of the full name, case-insensitive (name-only requests). */
export function nameTextRe (who) {
  if (!who.first || !who.last) return null
  const f = escapeRe(who.first.normalize('NFC').trim()).replace(/\s+/g, '\\s+')
  const l = escapeRe(who.last.normalize('NFC').trim()).replace(/\s+/g, '\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${f}\\s+${l}|${l},?\\s+${f})(?![\\p{L}\\p{N}])`, 'giu')
}

/**
 * Walk one JSON value and redact (mode 'erase') or correct (mode 'correct',
 * setDob) the person in it. Returns { value, hits } (value is a new copy
 * when anything changed, else the same).
 */
export function redactValue (value, { match, textRe = null, mode = 'erase', setDob = null }) {
  let hits = 0
  const walk = (v) => {
    if (typeof v === 'string') {
      if (mode !== 'erase' || !textRe) return v
      textRe.lastIndex = 0
      if (!textRe.test(v)) return v
      textRe.lastIndex = 0
      hits++
      return v.replace(textRe, REDACTED)
    }
    if (Array.isArray(v)) {
      let changed = false
      const out = v.map((x) => { const y = walk(x); if (y !== x) changed = true; return y })
      return changed ? out : v
    }
    if (!v || typeof v !== 'object') return v
    let out = v
    const set = (k, val) => {
      if (out[k] === val) return
      if (out === v) out = { ...v }
      out[k] = val
    }
    for (const g of groupsOf(v)) {
      const dob = g.dob.map((k) => dateOf(v[k])).find(Boolean) || null
      if (!match(v[g.first], v[g.last], dob)) continue
      hits++
      if (mode === 'correct') {
        for (const k of g.dob) set(k, setDob)
      } else {
        set(g.first, REDACTED)
        set(g.last, REDACTED)
        for (const k of [...g.dob, ...g.erase]) set(k, null)
      }
    }
    for (const k of Object.keys(out)) {
      const x = out[k]
      const y = walk(x)
      if (y !== x) {
        if (out === v) out = { ...v }
        out[k] = y
      }
    }
    return out
  }
  const result = walk(value)
  return { value: result, hits }
}

/** A plain-text search pattern for the row pre-filter (ILIKE on to_jsonb(row)::text). */
function likeOf (s) {
  return '%' + String(s).normalize('NFC').trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%'
}

/**
 * Run one request in `client`'s open transaction. `who`: { first, last, dob? }
 * or a register line ({ digest, nameDigest, withDob, mode, setDob }).
 * Returns { tables: { name: rows }, matches: [ids], hits }.
 */
export async function redactPerson (client, { who, mode = 'erase', setDob = null, matches = [] } = {}) {
  if (mode === 'correct' && !dateOf(setDob)) throw new Error('correct: setDob must be YYYY-MM-DD')
  await client.query("SELECT set_config('ov.allow_closed', 'on', true), set_config('ov.admin', 'on', true)")
  const match = matcherOf(who)
  const textRe = who.digest ? null : nameTextRe(who)
  let matchIds = null
  if (matches.length) {
    const { rows } = await client.query('SELECT id::text FROM public.matches WHERE external_id = ANY($1::text[]) OR id::text = ANY($1::text[])', [matches])
    matchIds = rows.map((r) => r.id)
  }
  const tables = {}
  const touchedMatches = new Set()
  let hits = 0
  for (const table of [...RECORD_TABLES, ...LIST_TABLES]) {
    const { rows: [reg] } = await client.query('SELECT to_regclass($1)::oid AS oid', [`public.${table}`])
    if (!reg.oid) continue
    const { rows: cols } = await client.query(
      `SELECT attname, format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped AND attgenerated = ''`, [reg.oid])
    const types = new Map(cols.map((c) => [c.attname, c.type]))
    const where = []
    const args = []
    // pre-filter: the last name in the row's text; a register line has no name: every row
    if (!who.digest) { args.push(likeOf(who.last)); where.push(`to_jsonb(t)::text ILIKE $${args.length}`) }
    if (matchIds) {
      const col = MATCH_COLUMN[table]
      if (!col && table !== 'activity_log') continue
      args.push(matchIds)
      where.push(table === 'activity_log'
        ? `t.match_external_id IN (SELECT external_id FROM public.matches WHERE id::text = ANY($${args.length}::text[]))`
        : `t.${col}::text = ANY($${args.length}::text[])`)
    }
    const { rows } = await client.query(
      `SELECT t.ctid::text AS ctid_, to_jsonb(t) AS row_ FROM public.${table} t
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} FOR UPDATE`, args)
    let n = 0
    const isList = LIST_TABLES.includes(table)
    for (const r of rows) {
      const before = r.row_
      const { value: after, hits: h } = redactValue(before, { match, textRe: isList ? null : textRe, mode, setDob })
      if (!h) continue
      hits += h
      n++
      const mid = table === 'matches' ? before.id : before.match_id
      if (mid) touchedMatches.add(String(mid))
      if (isList && mode === 'erase') {
        await client.query(`DELETE FROM public.${table} WHERE ctid = $1::tid`, [r.ctid_])
        continue
      }
      const sets = []
      const vals = []
      for (const [k, v] of Object.entries(after)) {
        if (JSON.stringify(v) === JSON.stringify(before[k]) || !types.has(k)) continue
        const type = types.get(k)
        vals.push(v == null ? null : (/^jsonb?$/.test(type) ? JSON.stringify(v) : typeof v === 'string' ? v : JSON.stringify(v)))
        sets.push(`"${k.replace(/"/g, '""')}" = $${vals.length}::text::${type}`)
      }
      if (!sets.length) continue
      vals.push(r.ctid_)
      await client.query(`UPDATE public.${table} SET ${sets.join(', ')} WHERE ctid = $${vals.length}::tid`, vals)
    }
    if (n) tables[table] = n
  }
  return { tables, matches: [...touchedMatches], hits }
}

/** The stored scoresheet files (PDF and its JSON) of these matches: paths. */
export async function filesOf (client, matchIds) {
  if (!matchIds.length) return []
  const { rows } = await client.query(
    `SELECT path FROM public.match_scoresheets WHERE match_id::text = ANY($1::text[]) ORDER BY path`, [matchIds]).catch((err) => {
    if (err?.code === '42P01') return { rows: [] }
    throw err
  })
  return rows.flatMap((r) => [r.path, r.path.replace(/\.pdf$/i, '.json')])
}

const USAGE = `Usage: OV_MIGRATE_DATABASE_URL=postgres://ov_owner@... node scripts/redact-person.mjs
  --first NAME --last NAME [--dob YYYY-MM-DD] [--match EXTERNAL_ID]... [--set-dob YYYY-MM-DD]
  [--drop-files] [--actor ACCOUNT_UUID] [--register FILE] [--apply]
  | --reapply FILE [--apply]
Dry run unless --apply. See the header of this file.`

export function parseArgs (argv) {
  const o = { matches: [], apply: false, dropFiles: false }
  const takes = { '--first': 'first', '--last': 'last', '--dob': 'dob', '--set-dob': 'setDob', '--actor': 'actor', '--register': 'register', '--reapply': 'reapply' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') o.apply = true
    else if (a === '--drop-files') o.dropFiles = true
    else if (a === '--match') { if (!argv[i + 1]) return { error: '--match needs a value' }; o.matches.push(argv[++i]) }
    else if (takes[a]) { if (argv[i + 1] == null) return { error: `${a} needs a value` }; o[takes[a]] = argv[++i] }
    else if (a === '--help' || a === '-h') o.help = true
    else return { error: `Unknown argument ${a}` }
  }
  if (o.help) return o
  if (o.reapply) return o
  if (!o.first || !o.last) return { error: '--first and --last are needed (or --reapply FILE)' }
  for (const k of ['dob', 'setDob']) if (o[k] && !dateOf(o[k])) return { error: `--${k === 'dob' ? 'dob' : 'set-dob'}: YYYY-MM-DD` }
  return o
}

async function main () {
  const o = parseArgs(process.argv.slice(2))
  if (o.error) { console.error(`${o.error}\n${USAGE}`); return 2 }
  if (o.help) { console.log(USAGE); return 0 }
  const url = process.env.OV_MIGRATE_DATABASE_URL
  if (!url) { console.error(`OV_MIGRATE_DATABASE_URL is not set (the owner role's connection).\n${USAGE}`); return 2 }
  const requests = o.reapply
    ? readFileSync(o.reapply, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    : [{ who: { first: o.first, last: o.last, dob: o.dob || null }, mode: o.setDob ? 'correct' : 'erase', setDob: o.setDob || null, matches: o.matches }]
  const client = new pg.Client({ connectionString: url, application_name: 'redact-person' })
  await client.connect()
  let storage = null
  try {
    await client.query('BEGIN')
    const report = []
    const matchIds = new Set()
    for (const req of requests) {
      const who = req.who || { digest: req.digest, nameDigest: req.nameDigest, withDob: req.withDob }
      const r = await redactPerson(client, { who, mode: req.mode, setDob: req.setDob, matches: req.matches || [] })
      r.matches.forEach((m) => matchIds.add(m))
      const digest = req.digest || personDigest(who)
      report.push({ mode: req.mode, digest, tables: r.tables, matches: r.matches.length })
      await client.query(
        `INSERT INTO public.audit_log (actor_id, action, details) VALUES ($1, 'person.redact', $2::jsonb)`,
        [/^[0-9a-f-]{36}$/i.test(o.actor || '') ? o.actor : null,
          JSON.stringify({ mode: req.mode, digest, reapply: !!o.reapply, tables: r.tables, matches: r.matches.length })])
    }
    const files = await filesOf(client, [...matchIds])
    if (o.apply) await client.query('COMMIT')
    else await client.query('ROLLBACK')
    for (const r of report) console.log(`${r.mode} ${r.digest.slice(0, 16)}: ${r.matches} matches; rows per table ${JSON.stringify(r.tables)}`)
    console.log(o.apply ? 'Applied (one transaction).' : 'Dry run: nothing changed (--apply writes).')
    if (files.length) {
      if (o.dropFiles && o.apply) {
        const env = { ...process.env, STORAGE_DIR: process.env.STORAGE_ROOT || process.env.STORAGE_DIR || '/data/storage' }
        storage = createStorage({ ...storageOptionsFromEnv(env), logger: console })
        let removed = 0
        for (const p of files) removed += (await storage.removeTrusted({ bucket: 'scoresheets', path: p })).objectsRemoved
        await client.query('DELETE FROM public.match_scoresheets WHERE path = ANY($1::text[])', [files])
        console.log(`Scoresheet files removed: ${removed} (make a new PDF from the corrected record).`)
      } else {
        console.log(`Scoresheet files of these matches (not rewritten; --drop-files --apply removes them):\n  ${files.join('\n  ')}`)
      }
    }
    if (o.apply && o.register && !o.reapply) {
      const req = requests[0]
      const withDob = !!req.who.dob
      appendFileSync(o.register, JSON.stringify({
        at: new Date().toISOString(), mode: req.mode, setDob: req.setDob, matches: req.matches,
        digest: personDigest(req.who), nameDigest: personDigest({ ...req.who, dob: '' }), withDob
      }) + '\n', { mode: 0o600 })
      console.log(`Recorded in the register ${o.register} (no name).`)
    }
    console.log('Not reached: the account itself, devices, mails already sent, per-account backup copies (30 days) and ' +
      'the encrypted backups (up to about 6 months). After a restore from an older backup: --reapply the register.')
    return 0
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => {
    console.error('redact-person failed:', err?.code ? `${err.code}: ${err.message}` : err?.message || err)
    process.exit(1)
  })
}
