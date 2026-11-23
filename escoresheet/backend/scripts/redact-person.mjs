#!/usr/bin/env node
/**
 * Operator tool for a data subject's request (privacy policy section 19):
 * erase one person from every stored copy. (Correcting a date of birth,
 * --set-dob, went with db/048: no date of birth is kept outside a match's own
 * sheet, and a sheet's is corrected in the match itself.)
 * Runs as the owner role (closed matches, the event history, the activity
 * and audit logs are append-only or frozen for the backend role), in ONE
 * transaction with ov.allow_closed / ov.admin, and is audited
 * (person.redact: the mode, a digest of the person and the counts per table,
 * never a name). Dry run unless --apply.
 *
 * The person is found by first and last name (case, accents' composition and
 * spaces normalised); --dob went with db/048 (the dates of birth it told
 * namesakes apart by are gone): name a namesake's matches with --match
 * instead. --match limits it to those matches (external_id, repeatable) and
 * everything stored for them.
 *
 *   records  (redacted in place: the record keeps the shirt number, role and
 *            flags; names become "[redacted]", date of birth, licence number,
 *            e-mail and phone go)
 *            matches (rosters, team staff, officials, remarks and every other
 *            json column), match_closures, events, event_revisions,
 *            activity_log, audit_log, game_rosters, beach_entries,
 *            beach_competition_matches, beach_tmatches (the tournament's
 *            referee and scorer), match_live_state, svrz_games,
 *            global_matches (the Global tool's readable cloud copy, db/046:
 *            its summary and bundle; a hit also drops its PDF, which prints
 *            the name, and the Global store's scoresheet PDFs of that match:
 *            see Global)
 *            Free text (remarks, manual changes, referee_1 ...) loses the full
 *            name ("First Last", "Last First", "Last, First").
 *   approvals match_approvals (db/011): the approving account's name
 *            (display_name, "Last First", which the sheet prints as
 *            "Approved electronically · <name>" and GET /api/approvals
 *            returns) becomes "[redacted]"; the slot, the time and the result
 *            hash stay. The table is append-only for every role: this one
 *            UPDATE runs with the triggers off (session_replication_role, so
 *            the owner role must be a superuser, as on the server), and the
 *            match is marked "Out of date" by hand (db/045) for a new PDF.
 *   Global   --global-key KEY (the match's backup code, repeatable): its
 *            cloud copy (global_matches, found by the key's hash) is deleted;
 *            with --drop-files --apply also the Global store's files of the
 *            key ({STORAGE_ROOT}/global/..: the encrypted backup and the PDFs).
 *            Without --first/--last only that is done. The register keeps the
 *            key's hash (never the key) for --reapply, which finds the store's
 *            folder by that hash (the folder is named by the key).
 *            By name, without the code: a cloud copy the person is in is
 *            redacted (above), and its key hash leads to the store's folder
 *            too: its scoresheet PDFs (scoresheet, scoresheet-final: plain
 *            PDFs that print the name and, in the Global tool, the date of
 *            birth; POST /api/global/load serves them to whoever has the code)
 *            are listed, and removed with --drop-files --apply. The store's
 *            backup stays: it is encrypted (as the per-account backups below)
 *            and is the match's restore; --global-key CODE deletes it. A Global
 *            match without a cloud copy has no row to find it by: its store
 *            is reached by its code only. Neither the codes nor the paths
 *            (which hold them) are printed.
 *   lists    (the row is deleted): club_licences, competition_players,
 *            competition_staff, referee_database
 *   files    the scoresheet PDFs and their JSON files of the matches touched
 *            are listed; --drop-files removes them (a PDF is not rewritten:
 *            the scorer or an admin makes a new one from the corrected record)
 *
 * The schedule sync (data-map F27): the daily VolleyManager sync rewrites
 * every game from yesterday to 14 days ahead, so it would write an erased
 * referee's name and licence number back while VolleyManager still lists
 * them. A request without --match therefore also registers the person in
 * public.redacted_people (db/052): keyed hashes of the name and of every
 * licence number the run erased (svrz_games referee_N_licence, club_licences
 * sv_number, a sheet's licence ...), HMAC with a key derived from
 * OV_PIN_SECRET (lib/redactedPeople.js), never the name or the number. The
 * sync (lib/vmSync.js) writes NULL for a registered 1st or 2nd referee
 * (names and licence number) and line judge, namesakes included, as this run
 * erased them. So --apply needs OV_PIN_SECRET, the backend's (the stack's
 * .env), without --match; a dry run without it says so. With --match the
 * schedule is left as it is (it has no match of its own) and nothing is
 * registered: name the person without --match for that. Rotating
 * OV_PIN_SECRET makes the entries unmatchable: run each request again by name.
 *
 * Not reached: the account (profiles, auth.users: the account's own
 * deletion or the admin's), the per-account backup copies (encrypted, gone
 * after 30 days), copies on the devices, mails already sent, and the
 * encrypted backups (up to about 6 months). The backup note: --register FILE
 * appends the request (mode, the digest, the keyed hashes it registered) to a
 * register kept outside the database; after a restore from a backup older
 * than the request, --reapply FILE runs every request of it again
 * (structured fields: the free-text names need the name, i.e. a new run with
 * --first/--last) and registers its keyed hashes for the sync again (no key
 * needed; a line written before db/052 has none: run that request again by
 * name). It reads every row of the record tables (in blocks of pages,
 * locking only the rows it changes): best before the restored server takes
 * traffic again.
 *
 * Usage (on the host, the owner role's connection as for scripts/migrate.mjs;
 * the backend's OV_PIN_SECRET; the storage root for the files):
 *   OV_MIGRATE_DATABASE_URL=postgres://ov_owner@... OV_PIN_SECRET=... STORAGE_ROOT=/data/storage \
 *     node scripts/redact-person.mjs --first Mia --last Example \
 *       [--match <external_id>]... [--drop-files] \
 *       [--actor <admin account uuid>] [--register FILE] [--apply]
 *   ... node scripts/redact-person.mjs --reapply FILE [--apply]
 * Prints counts per table and the files (paths) only, never the rows.
 * Exit codes: 0 done (or dry run), 1 error, 2 usage.
 */

import pg from 'pg'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { createStorage, storageOptionsFromEnv } from '../lib/storage.js'
import { isEntry, normLicence, normName, personEntries, redactedPeopleKey, registerEntries } from '../lib/redactedPeople.js'
import { isGlobalKey, keyHash } from '../lib/globalMatches.js'
import { KINDS as GLOBAL_KINDS } from '../lib/globalStore.js'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'

export const REDACTED = '[redacted]'

const FIRST_RE = /^(.*?)(first_?name|firstname|given_?name|vorname)$/i
const LAST_SUFFIXES = ['last_name', 'lastName', 'lastname', 'surname', 'family_name', 'familyName', 'nachname']
const DOB_SUFFIXES = ['dob', 'dateOfBirth', 'date_of_birth', 'birthDate', 'birthdate', 'birth_date']
// The licence numbers among them: registered for the schedule sync (db/052)
const LICENCE_SUFFIXES = ['licence', 'license', 'licenceNumber', 'licenseNumber', 'licence_number', 'license_number',
  'sv_number', 'svNumber']
const ERASE_SUFFIXES = [...LICENCE_SUFFIXES, 'email', 'phone', 'mobile']

/** Records: redacted in place. Lists: the person's row is deleted (a correction edits it). */
export const RECORD_TABLES = ['matches', 'match_closures', 'events', 'event_revisions', 'activity_log', 'audit_log',
  'game_rosters', 'beach_entries', 'beach_competition_matches', 'beach_tmatches', 'match_live_state', 'svrz_games', 'global_matches']
export const LIST_TABLES = ['club_licences', 'competition_players', 'competition_staff', 'referee_database']
// Pages read per query when scanning a table
const SCAN_PAGES = 64
// The tables whose rows belong to one match (for --match), by column
const MATCH_COLUMN = { matches: 'id', match_closures: 'match_id', events: 'match_id', event_revisions: 'match_id', match_live_state: 'match_id', audit_log: 'match_id', beach_tmatches: 'match_id' }
/**
 * Per table: the columns left out of the scan (`omit`: large or secret, never
 * a name) and the columns a row the person is in also gets (`onHit`).
 * global_matches (db/046): its PDF prints the names (and, in the Global tool,
 * dates of birth) and cannot be redacted: it goes; the hashes and the share
 * token are no person's data.
 */
const TABLE_OPTS = {
  // keyHash: the column a hit row is reported by (globalKeyHashes): it leads to the Global store's folder
  global_matches: { omit: ['pdf', 'key_hash', 'pin_hash', 'share_token', 'organizer_hash'], onHit: { pdf: null }, keyHash: 'key_hash' }
}

/** The name normalisation (lib/redactedPeople.js keys the register with the same one). */
export const norm = normName

/** The digest kept in the audit log and the register: never the name. */
export function personDigest ({ first, last, dob = '' }) {
  return createHash('sha256').update(`ov-person:${norm(first)}\u0000${norm(last)}\u0000${dob || ''}`, 'utf8').digest('hex')
}

const isoDateOf = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)

/**
 * A stored date of birth as YYYY-MM-DD. Match Setup keeps some in the
 * display form (DD.MM.YYYY or DD/MM/YYYY, the rule of displayDobToIso in
 * frontend/src/domain/savedTeams.js), so those count as the same date.
 */
export function dateOf (v) {
  const iso = isoDateOf(v)
  if (iso || typeof v !== 'string') return iso
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v.trim()) || /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim())
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null
}

/**
 * The person groups of one object: for each first-name key (with its prefix,
 * e.g. referee_1_first_name), its last-name, date-of-birth and erase keys.
 * The beach entries' players are { first, last, licence, country } (db/014):
 * the bare keys first and last together are a person too.
 */
function groupsOf (o) {
  const out = []
  if ('first' in o && 'last' in o) {
    out.push({
      first: 'first',
      last: 'last',
      dob: DOB_SUFFIXES.filter((x) => x in o),
      erase: ERASE_SUFFIXES.filter((x) => x in o),
      licence: LICENCE_SUFFIXES.filter((x) => x in o)
    })
  }
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
      erase: ERASE_SUFFIXES.map((s) => p + s).filter((x) => x in o),
      licence: LICENCE_SUFFIXES.map((s) => p + s).filter((x) => x in o)
    })
  }
  return out
}

/**
 * The matcher of one request: `who` = { first, last } (the name) or
 * { digest, withDob } (a register line: structured fields only; withDob: a
 * line written before db/048 with --dob, matched by its date where a record
 * still has one, else by the name).
 */
export function matcherOf (who) {
  if (who.digest) {
    return (first, last, dob) => personDigest({ first, last, dob: who.withDob ? (dob || '') : '' }) === who.digest ||
      (who.withDob && !dob && personDigest({ first, last, dob: '' }) === who.nameDigest)
  }
  const f = norm(who.first)
  const l = norm(who.last)
  return (first, last) => norm(first) === f && norm(last) === l
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
 * Walk one JSON value and redact the person in it (names "[redacted]", a date
 * of birth a sheet still carries, licence, e-mail and phone null). Returns
 * { value, hits } (value is a new copy when anything changed, else the same).
 * `licences` (a Set): gets the licence numbers erased (4 to 7 digits), for
 * the register of the schedule sync.
 */
export function redactValue (value, { match, textRe = null, licences = null }) {
  let hits = 0
  const walk = (v) => {
    if (typeof v === 'string') {
      if (!textRe) return v
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
      if (licences) for (const k of g.licence) { const n = normLicence(v[k]); if (n) licences.add(n) }
      set(g.first, REDACTED)
      set(g.last, REDACTED)
      for (const k of [...g.dob, ...g.erase]) set(k, null)
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
 * Run one request in `client`'s open transaction. `who`: { first, last }
 * or a register line ({ digest, nameDigest, withDob }).
 * Returns { tables: { name: rows }, matches: [ids], hits, licences: [the
 * licence numbers erased], globalKeyHashes: [the key hashes of the Global
 * cloud copies redacted] } (the licences for registerPerson, the key hashes
 * for the Global store's PDFs: globalStoreDirsByHash; neither printed).
 */
export async function redactPerson (client, { who, matches = [] } = {}) {
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
  const licences = new Set()
  const globalKeyHashes = new Set()
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
    const opts = TABLE_OPTS[table] || {}
    // the row as JSON, without the columns left out of the scan
    const rowSql = opts.omit?.length ? `(to_jsonb(t) - ${`ARRAY[${opts.omit.map((c) => `'${c}'`).join(', ')}]::text[]`})` : 'to_jsonb(t)'
    // pre-filter: the last name in the row's text; a register line has no name: every row
    if (!who.digest) { args.push(likeOf(who.last)); where.push(`${rowSql}::text ILIKE $${args.length}`) }
    if (matchIds) {
      const col = MATCH_COLUMN[table]
      if (!col && table !== 'activity_log') continue
      args.push(matchIds)
      where.push(table === 'activity_log'
        ? `t.match_external_id IN (SELECT external_id FROM public.matches WHERE id::text = ANY($${args.length}::text[]))`
        : `t.${col}::text = ANY($${args.length}::text[])`)
    }
    // In blocks of pages (a TID range scan, without a lock): a register line
    // reads every row, so neither the whole table in memory nor a lock on
    // every row. A row the person is in is locked and read again first.
    const filter = where.length ? ` AND ${where.join(' AND ')}` : ''
    const written = new Set()
    let n = 0
    const isList = LIST_TABLES.includes(table)
    const apply = async (ctid) => {
      const { rows: [locked] } = await client.query(
        `SELECT ${rowSql} AS row_${opts.keyHash ? `, t.${opts.keyHash}::text AS key_hash_` : ''} FROM public.${table} t WHERE t.ctid = $1::tid FOR UPDATE`, [ctid])
      if (!locked) return false // changed by another session since the read: the next pass finds it
      const before = locked.row_
      const { value: redacted, hits: h } = redactValue(before, { match, textRe: isList ? null : textRe, licences })
      if (!h) return true
      const after = opts.onHit ? { ...redacted, ...opts.onHit } : redacted
      hits += h
      n++
      if (locked.key_hash_) globalKeyHashes.add(locked.key_hash_)
      const mid = table === 'matches' ? before.id : before.match_id
      if (mid) touchedMatches.add(String(mid))
      if (isList) {
        await client.query(`DELETE FROM public.${table} WHERE ctid = $1::tid`, [ctid])
        return true
      }
      const sets = []
      const vals = []
      for (const [k, v] of Object.entries(after)) {
        if ((k in before && JSON.stringify(v) === JSON.stringify(before[k])) || !types.has(k)) continue
        const type = types.get(k)
        vals.push(v == null ? null : (/^jsonb?$/.test(type) ? JSON.stringify(v) : typeof v === 'string' ? v : JSON.stringify(v)))
        sets.push(`"${k.replace(/"/g, '""')}" = $${vals.length}::text::${type}`)
      }
      if (!sets.length) return true
      vals.push(ctid)
      const { rows: [w] } = await client.query(
        `UPDATE public.${table} SET ${sets.join(', ')} WHERE ctid = $${vals.length}::tid RETURNING ctid::text AS ctid_`, vals)
      if (w) written.add(w.ctid_) // the new version: not read again further on
      return true
    }
    for (let pass = 0; ; pass++) {
      let missed = 0
      for (let page = 0; ; page += SCAN_PAGES) {
        const { rows: [{ pages }] } = await client.query(
          "SELECT (pg_relation_size($1::oid) / current_setting('block_size')::bigint)::int AS pages", [reg.oid])
        if (page >= pages) break
        const { rows } = await client.query(
          `SELECT t.ctid::text AS ctid_, ${rowSql} AS row_ FROM public.${table} t
            WHERE t.ctid >= $${args.length + 1}::tid AND t.ctid < $${args.length + 2}::tid${filter}`,
          [...args, `(${page},0)`, `(${page + SCAN_PAGES},0)`])
        for (const r of rows) {
          if (written.has(r.ctid_) || !redactValue(r.row_, { match, textRe: isList ? null : textRe }).hits) continue
          if (!(await apply(r.ctid_))) missed++
        }
      }
      if (!missed) break
      if (pass >= 4) throw new Error(`${table}: rows keep changing while the tool runs; run it again in a quieter moment`)
    }
    if (n) tables[table] = n
  }
  const approvals = await redactApprovals(client, { who, match, textRe, matchIds })
  if (approvals.length) {
    tables.match_approvals = approvals.length
    hits += approvals.length
    for (const a of approvals) touchedMatches.add(a.match_id)
  }
  return { tables, matches: [...touchedMatches], hits, licences: [...licences], globalKeyHashes: [...globalKeyHashes] }
}

/** The (first, last) readings of a name kept as one text ("Last First", lib/approvals.js; or "First Last"). */
function nameSplits (name) {
  const words = String(name || '').normalize('NFC').trim().split(/\s+/).filter(Boolean)
  const out = []
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ')
    const b = words.slice(i).join(' ')
    out.push({ first: b, last: a }, { first: a, last: b })
  }
  return out
}

/**
 * The approving account's name in match_approvals (db/011, display_name) set
 * to "[redacted]" where it names the person; the slot, the time, the result
 * key and hash stay. By name (textRe), or for a register line by its digest
 * against each reading of the name (nameSplits). Approvals are append-only
 * for every role (ov_match_approvals_immutable, a closed match's guard): the
 * UPDATE runs with the triggers off for it alone (session_replication_role,
 * superuser only), and the match is then marked "Out of date" (db/045
 * match_sheet_changes) as its trigger would have: the PDF is made anew.
 * Returns [{ id, match_id }].
 */
export async function redactApprovals (client, { who, match = matcherOf(who), textRe = who?.digest ? null : nameTextRe(who), matchIds = null } = {}) {
  const { rows: [reg] } = await client.query("SELECT to_regclass('public.match_approvals')::oid AS oid")
  if (!reg.oid) return []
  const args = [REDACTED]
  const where = ['a.display_name <> $1']
  if (!who.digest) { args.push(likeOf(who.last)); where.push(`a.display_name ILIKE $${args.length}`) }
  if (matchIds) { args.push(matchIds); where.push(`a.match_id::text = ANY($${args.length}::text[])`) }
  const { rows } = await client.query(
    `SELECT a.id::text AS id, a.match_id::text AS match_id, a.display_name FROM public.match_approvals a WHERE ${where.join(' AND ')}`, args)
  const names = (n) => {
    if (textRe) {
      textRe.lastIndex = 0
      const hit = textRe.test(n)
      textRe.lastIndex = 0
      return hit
    }
    return nameSplits(n).some((x) => match(x.first, x.last, null))
  }
  const hit = rows.filter((r) => names(r.display_name))
  if (!hit.length) return []
  const ids = hit.map((r) => r.id)
  try {
    await client.query("SELECT set_config('session_replication_role', 'replica', true)")
  } catch (err) {
    throw new Error(`match_approvals: the names in the approvals need the owner role as a superuser (session_replication_role): ${err?.code || err?.message}`)
  }
  try {
    await client.query('UPDATE public.match_approvals SET display_name = $1 WHERE id = ANY($2::uuid[])', [REDACTED, ids])
  } finally {
    await client.query("SELECT set_config('session_replication_role', 'origin', true)")
  }
  const { rows: [sheet] } = await client.query("SELECT to_regclass('public.match_sheet_changes')::oid AS oid")
  if (sheet.oid) {
    await client.query(
      `INSERT INTO public.match_sheet_changes AS c (match_id, changed_at)
       SELECT DISTINCT a.match_id, now() FROM public.match_approvals a
        WHERE a.id = ANY($1::uuid[]) AND EXISTS (SELECT 1 FROM public.matches m WHERE m.id = a.match_id)
       ON CONFLICT (match_id) DO UPDATE SET changed_at = greatest(c.changed_at, excluded.changed_at)`, [ids])
  }
  return hit.map((r) => ({ id: r.id, match_id: r.match_id }))
}

const KEY_HASH_RE = /^[0-9a-f]{64}$/

/**
 * --global-key: the cloud copies of these Global matches (global_matches)
 * deleted in `client`'s open transaction, by the hashes of their backup codes
 * (lib/globalMatches.js keyHash: the only way to a row; a register line keeps
 * the hashes, never the code). Returns the rows deleted.
 */
export async function dropGlobalCopies (client, keyHashes = []) {
  const hashes = [...new Set(keyHashes.filter((h) => KEY_HASH_RE.test(String(h))))]
  if (!hashes.length) return 0
  const { rows: [reg] } = await client.query("SELECT to_regclass('public.global_matches')::oid AS oid")
  if (!reg.oid) return 0
  const r = await client.query('DELETE FROM public.global_matches WHERE key_hash = ANY($1::text[])', [hashes])
  return r.rowCount
}

/**
 * Register a person for the schedule sync (db/052) in `client`'s open
 * transaction: keyed hashes of `who`'s name and of `licences` (key:
 * redactedPeopleKey(OV_PIN_SECRET)), or a register line's `entries` as they
 * are. Returns { entries, registered } (registered: the new rows).
 */
export async function registerPerson (client, { key = null, who = {}, licences = [], entries = null } = {}) {
  const list = entries ? entries.filter(isEntry) : (key ? personEntries(key, { first: who.first, last: who.last, licences }) : [])
  return { entries: list, registered: await registerEntries(client, list) }
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

const USAGE = `Usage: OV_MIGRATE_DATABASE_URL=postgres://ov_owner@... OV_PIN_SECRET=... node scripts/redact-person.mjs
  --first NAME --last NAME [--match EXTERNAL_ID]... [--global-key BACKUP_CODE]...
  [--drop-files] [--actor ACCOUNT_UUID] [--register FILE] [--apply]
  | --global-key BACKUP_CODE... [--drop-files] [--actor ACCOUNT_UUID] [--register FILE] [--apply]
  | --reapply FILE [--apply]   (reads every row: best before the restored server takes traffic)
Dry run unless --apply. OV_PIN_SECRET (the backend's) registers the person for the
schedule sync (db/052); --apply by name without --match needs it. See the header of this file.`

export function parseArgs (argv) {
  const o = { matches: [], globalKeys: [], apply: false, dropFiles: false }
  const takes = { '--first': 'first', '--last': 'last', '--actor': 'actor', '--register': 'register', '--reapply': 'reapply' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dob' || a === '--set-dob') return { error: `${a}: gone with db/048 (no dates of birth are kept); find a namesake's records with --match` }
    if (a === '--apply') o.apply = true
    else if (a === '--drop-files') o.dropFiles = true
    else if (a === '--match') { if (!argv[i + 1]) return { error: '--match needs a value' }; o.matches.push(argv[++i]) }
    else if (a === '--global-key') {
      if (!isGlobalKey(argv[i + 1])) return { error: '--global-key needs a Global match\'s backup code (22 to 64 letters, digits, - or _)' }
      o.globalKeys.push(argv[++i])
    }
    else if (takes[a]) { if (argv[i + 1] == null) return { error: `${a} needs a value` }; o[takes[a]] = argv[++i] }
    else if (a === '--help' || a === '-h') o.help = true
    else return { error: `Unknown argument ${a}` }
  }
  if (o.help) return o
  if (o.reapply) return o
  // --global-key alone: only those cloud copies (a parent with the backup code, privacy policy section 17)
  if (!o.first && !o.last && o.globalKeys.length && !o.matches.length) return { ...o, globalOnly: true }
  if (!o.first || !o.last) return { error: '--first and --last are needed (or --global-key CODE, or --reapply FILE)' }
  return o
}

/** The Global store's folder of a backup code (lib/globalStore.js dirOf), or null for anything else. */
export function globalStoreDirOf (root, k) {
  return isGlobalKey(k) && root ? path.join(root, 'global', k.slice(0, 2), k) : null
}

/**
 * The Global store's folders whose backup code hashes (keyHash) to one of
 * `hashes`: the folder is named by the code, the database and the register
 * keep its hash only, so every folder name is hashed. Returns [{ hash, dir }].
 */
export async function globalStoreDirsByHash (root, hashes = []) {
  const want = new Set(hashes.filter((h) => KEY_HASH_RE.test(String(h))))
  if (!root || !want.size) return []
  const base = path.join(root, 'global')
  const out = []
  for (const a of (await readdir(base).catch(() => [])).sort()) {
    for (const k of (await readdir(path.join(base, a)).catch(() => [])).sort()) {
      if (!isGlobalKey(k) || k.slice(0, 2) !== a) continue
      const hash = keyHash(k)
      if (want.has(hash)) out.push({ hash, dir: path.join(base, a, k) })
    }
  }
  return out
}

/** The store's scoresheet PDFs (lib/globalStore.js KINDS: scoresheet, scoresheet-final) */
export const GLOBAL_STORE_PDFS = Object.entries(GLOBAL_KINDS).filter(([, s]) => s.ext === 'pdf').map(([kind, s]) => `${kind}.${s.ext}`)

/** The scoresheet PDFs present in these store folders: paths. */
export async function globalStorePdfsOf (dirs) {
  const out = []
  for (const d of dirs) {
    const names = new Set(await readdir(d).catch(() => []))
    for (const f of GLOBAL_STORE_PDFS) if (names.has(f)) out.push(path.join(d, f))
  }
  return out
}

async function main () {
  const o = parseArgs(process.argv.slice(2))
  if (o.error) { console.error(`${o.error}\n${USAGE}`); return 2 }
  if (o.help) { console.log(USAGE); return 0 }
  const url = process.env.OV_MIGRATE_DATABASE_URL
  if (!url) { console.error(`OV_MIGRATE_DATABASE_URL is not set (the owner role's connection).\n${USAGE}`); return 2 }
  // A request by name without --match reaches the schedule: register it for the sync (db/052)
  const bySchedule = !o.reapply && !o.matches.length && !o.globalOnly
  let key = null
  if (bySchedule) {
    try {
      key = redactedPeopleKey(process.env.OV_PIN_SECRET)
    } catch (err) {
      if (o.apply) {
        console.error(`${err.message}: the person is registered so that the schedule sync does not write them back (db/052). Use the backend's.\n${USAGE}`)
        return 2
      }
      console.log('Note: OV_PIN_SECRET is not set; --apply needs it to register the person for the schedule sync (db/052).')
    }
  }
  // a register's corrections of a date of birth (before db/048) have nothing left to correct
  // the Global cloud copies of a request by their keys' hashes (a register line keeps the hashes only)
  const globalHashes = o.globalKeys.map(keyHash)
  const requests = o.reapply
    ? readFileSync(o.reapply, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => r.mode !== 'correct')
    : o.globalOnly
      ? [{ mode: 'global', global: globalHashes }]
      : [{ who: { first: o.first, last: o.last }, mode: 'erase', matches: o.matches, global: globalHashes }]
  const client = new pg.Client({ connectionString: url, application_name: 'redact-person' })
  await client.connect()
  let storage = null
  try {
    await client.query('BEGIN')
    const report = []
    const matchIds = new Set()
    // the Global store: whole folders of a register line's --global-key copies (their hashes),
    // the scoresheet PDFs of the cloud copies a request by name redacted
    const storeWhole = new Set()
    const storePdfs = new Set()
    let unregistered = 0
    for (const req of requests) {
      if (o.reapply && Array.isArray(req.global)) req.global.forEach((h) => storeWhole.add(h))
      // the Global cloud copies named by backup code (--global-key; a register line: their hashes)
      const globalCopies = await dropGlobalCopies(client, Array.isArray(req.global) ? req.global : [])
      if (req.mode === 'global') {
        report.push({ mode: req.mode, digest: null, tables: {}, matches: 0, entries: [], registered: 0, globalCopies })
        await client.query(
          `INSERT INTO public.audit_log (actor_id, action, details) VALUES ($1, 'person.redact', $2::jsonb)`,
          [/^[0-9a-f-]{36}$/i.test(o.actor || '') ? o.actor : null, JSON.stringify({ mode: 'global', reapply: !!o.reapply, global_copies: globalCopies })])
        continue
      }
      const who = req.who || { digest: req.digest, nameDigest: req.nameDigest, withDob: req.withDob }
      const r = await redactPerson(client, { who, matches: req.matches || [] })
      r.matches.forEach((m) => matchIds.add(m))
      r.globalKeyHashes.forEach((h) => storePdfs.add(h))
      const digest = req.digest || personDigest(who)
      // the schedule sync's register (db/052): the name and the licences erased, or a line's entries again
      const reg = req.who
        ? await registerPerson(client, { key, who: req.who, licences: r.licences })
        : await registerPerson(client, { entries: Array.isArray(req.entries) ? req.entries : [] })
      if (!req.who && !Array.isArray(req.entries) && !(req.matches || []).length) unregistered++
      report.push({ mode: req.mode, digest, tables: r.tables, matches: r.matches.length, entries: reg.entries, registered: reg.registered, globalCopies })
      await client.query(
        `INSERT INTO public.audit_log (actor_id, action, details) VALUES ($1, 'person.redact', $2::jsonb)`,
        [/^[0-9a-f-]{36}$/i.test(o.actor || '') ? o.actor : null,
          JSON.stringify({ mode: req.mode, digest, reapply: !!o.reapply, tables: r.tables, matches: r.matches.length, registered: reg.registered, ...(globalCopies ? { global_copies: globalCopies } : {}) })])
    }
    const files = await filesOf(client, [...matchIds])
    if (o.apply) await client.query('COMMIT')
    else await client.query('ROLLBACK')
    for (const r of report) {
      if (r.mode === 'global') {
        console.log(`global: ${r.globalCopies} Global cloud cop${r.globalCopies === 1 ? 'y' : 'ies'} deleted`)
        continue
      }
      console.log(`${r.mode} ${r.digest.slice(0, 16)}: ${r.matches} matches; rows per table ${JSON.stringify(r.tables)}; ` +
        `schedule sync register (db/052): ${r.registered} new of ${r.entries.length} keyed hash(es)` +
        (r.globalCopies ? `; ${r.globalCopies} Global cloud cop${r.globalCopies === 1 ? 'y' : 'ies'} deleted` : ''))
    }
    if (!bySchedule && !o.reapply && !o.globalOnly) {
      console.log('--match: the schedule (svrz_games) is left as it is and nothing is registered for its sync; name the person without --match for that.')
    }
    if (unregistered) {
      console.log(`${unregistered} register line(s) of before db/052 hold no keyed hashes: run those requests again by name (--first/--last) so the schedule sync leaves them out.`)
    }
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
    // the Global store's files of the backup codes (the encrypted backup and the PDFs, lib/globalStore.js)
    const storeRoot = process.env.STORAGE_ROOT || process.env.STORAGE_DIR || '/data/storage'
    const storeDirs = [...new Set(o.globalKeys.map((k) => globalStoreDirOf(storeRoot, k)).filter(Boolean))]
    // a register line keeps the codes' hashes and a cloud copy found by name its key hash: the folders by hash
    const byHash = await globalStoreDirsByHash(storeRoot, [...storeWhole, ...storePdfs])
    for (const { hash, dir } of byHash) if (storeWhole.has(hash) && !storeDirs.includes(dir)) storeDirs.push(dir)
    const pdfs = await globalStorePdfsOf(byHash.filter(({ dir }) => !storeDirs.includes(dir)).map(({ dir }) => dir))
    if (pdfs.length) {
      const of = `of ${new Set(pdfs.map((p) => path.dirname(p))).size} Global match(es)`
      if (o.dropFiles && o.apply) {
        for (const p of pdfs) await rm(p, { force: true })
        console.log(`Global store: ${pdfs.length} scoresheet PDF(s) ${of} removed (the encrypted backup stays; --global-key CODE deletes it).`)
      } else {
        console.log(`Global store: ${pdfs.length} scoresheet PDF(s) ${of} the person is in stay (--drop-files --apply removes them).`)
      }
    }
    if (storeDirs.length) {
      if (o.dropFiles && o.apply) {
        for (const d of storeDirs) await rm(d, { recursive: true, force: true })
        console.log(`Global store files removed for ${storeDirs.length} backup code(s).`)
      } else {
        console.log(`The Global store's files of ${storeDirs.length} backup code(s) stay (--drop-files --apply removes them).`)
      }
    }
    if (o.apply && o.register && !o.reapply) {
      const req = requests[0]
      appendFileSync(o.register, JSON.stringify(req.mode === 'global'
        ? { at: new Date().toISOString(), mode: 'global', matches: [], global: req.global }
        : {
            at: new Date().toISOString(), mode: req.mode, matches: req.matches,
            digest: personDigest(req.who), nameDigest: personDigest(req.who), withDob: false,
            // the keyed hashes of db/052, for --reapply after a restore (no name, no number)
            entries: report[0].entries,
            // the Global cloud copies by their keys' hashes (never the backup code)
            ...(req.global?.length ? { global: req.global } : {})
          }) + '\n', { mode: 0o600 })
      console.log(`Recorded in the register ${o.register} (no name${req.global?.length ? ', no backup code' : ''}).`)
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
