/**
 * redactedPeople — the register of people erased on request (db/052,
 * data-map F27), kept so the daily VolleyManager sync does not write them back.
 *
 * scripts/redact-person.mjs erases a person everywhere, svrz_games included.
 * The sync (lib/vmSync.js) overwrites every column of each game in its window
 * (yesterday to 14 days ahead), so while VolleyManager still lists that
 * referee, the next run would bring the name and the licence number back.
 * redact-person therefore registers the person in public.redacted_people, and
 * the sync leaves a registered referee's or line judge's fields empty (NULL)
 * instead of writing VolleyManager's values.
 *
 * The register keeps no name and no number, only keyed hashes:
 *
 *   key  = HKDF-SHA256(ikm = OV_PIN_SECRET, salt = <empty>, info = "ov-redacted-person-v1", 32)
 *   name = HMAC-SHA256(key, "name" 0x00 norm(first) 0x00 norm(last))
 *   licence = HMAC-SHA256(key, "licence" 0x00 <4 to 7 digits>)
 *
 * norm() is redact-person's (NFC, trimmed, inner spaces collapsed, lower case
 * de-CH). Why keyed: a name, and even more a licence number (at most 10^7
 * values), falls to a dictionary from a dump if the hash is plain or salted
 * with a salt that sits in the same dump; the key is not in the database or
 * its backups (as for the PINs, lib/pinHash.js, and the approval PINs,
 * lib/approvalPin.js, whose HKDF pattern this follows with its own info, so
 * these MACs never equal any of theirs). The sync must find a referee by the
 * hash, so there is no per-row salt. OV_PIN_SECRET is already required in
 * database mode and backed up with the secrets (deploy/backup-openvolley.sh).
 *
 * Rotating OV_PIN_SECRET makes every entry unmatchable: register each request
 * again by name (redact-person --first/--last) after a rotation.
 *
 * node:crypto only; never logs a name, a number or a hash.
 */
import { createHmac, hkdfSync } from 'node:crypto'

export const REDACTED_PEOPLE_INFO = 'ov-redacted-person-v1'
export const MIN_SECRET_LENGTH = 32
export const REGISTER_KINDS = Object.freeze(['name', 'licence'])
const HASH_HEX_RE = /^[0-9a-f]{64}$/
const LICENCE_RE = /^[0-9]{4,7}$/

/** redact-person's normalisation of a name part: NFC, trimmed, spaces collapsed, lower case. */
export function normName (s) {
  return typeof s === 'string' ? s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-CH') : ''
}

/** A licence number as the schedule stores it (db/051): 4 to 7 digits, spaces aside; else null. */
export function normLicence (v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const t = String(v).replace(/\s+/g, '')
  return LICENCE_RE.test(t) ? t : null
}

/** The register's key from OV_PIN_SECRET. Throws on a missing or too short secret. */
export function redactedPeopleKey (secret) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`OV_PIN_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters) for the register of people erased on request`)
  }
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(REDACTED_PEOPLE_INFO, 'utf8'), 32))
}

const mac = (key, kind, ...parts) => createHmac('sha256', key).update([kind, ...parts].join('\u0000'), 'utf8').digest('hex')

/** The name entry (hex) of a first and last name; null when either is empty. */
export function nameHash (key, first, last) {
  const f = normName(first)
  const l = normName(last)
  return f && l ? mac(key, 'name', f, l) : null
}

/** The licence entry (hex) of a licence number; null when it is not 4 to 7 digits. */
export function licenceHash (key, licence) {
  const n = normLicence(licence)
  return n ? mac(key, 'licence', n) : null
}

/**
 * The name entries a display name can stand for: VolleyManager's displayName
 * and the referee and line judge fields are one string ("Last First", "First
 * Last", "Last, First"), so every split of its words in both orders. The
 * whole string must be the name: "Mia Example Jr" is not Mia Example.
 */
export function displayNameHashes (key, display) {
  const s = normName(display)
  if (!s) return []
  const out = new Set()
  const add = (first, last) => { const h = nameHash(key, first, last); if (h) out.add(h) }
  const comma = s.indexOf(',')
  if (comma > 0) add(s.slice(comma + 1), s.slice(0, comma))
  const words = s.replace(/,/g, ' ').split(' ').filter(Boolean)
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ')
    const b = words.slice(i).join(' ')
    add(a, b)
    add(b, a)
  }
  return [...out]
}

/**
 * The entries of one person: their name and every licence number known for
 * them, as [{ kind, hash }] (hex, de-duplicated).
 */
export function personEntries (key, { first, last, licences = [] } = {}) {
  const out = new Map()
  const n = nameHash(key, first, last)
  if (n) out.set(n, 'name')
  for (const l of licences) {
    const h = licenceHash(key, l)
    if (h && !out.has(h)) out.set(h, 'licence')
  }
  return [...out].map(([hash, kind]) => ({ kind, hash }))
}

/** Is this a register entry ({ kind, hash: 64 hex }) as personEntries makes them? */
export const isEntry = (e) => !!e && REGISTER_KINDS.includes(e.kind) && typeof e.hash === 'string' && HASH_HEX_RE.test(e.hash)

/**
 * Inserts entries into public.redacted_people (ON CONFLICT DO NOTHING).
 * Needs a role that may write it (the owner: redact-person). Returns how many
 * were new. Throws when the table is missing (db/052 not applied).
 */
export async function registerEntries (db, entries) {
  const list = (entries || []).filter(isEntry)
  if (!list.length) return 0
  const { rows: [reg] } = await db.query("SELECT to_regclass('public.redacted_people') IS NOT NULL AS ok")
  if (!reg?.ok) throw new Error('public.redacted_people is missing: apply the migrations (db/052_redacted_people.sql) first')
  const { rowCount } = await db.query(
    `INSERT INTO public.redacted_people (hash, kind)
     SELECT decode(x.h, 'hex'), x.k FROM unnest($1::text[], $2::text[]) AS x(h, k)
     ON CONFLICT (hash) DO NOTHING`, [list.map((e) => e.hash), list.map((e) => e.kind)])
  return rowCount ?? 0
}

/**
 * The register as two sets of hex hashes, { names, licences, size }; an empty
 * one when the table is missing (a database before db/052 has no entries).
 */
export async function loadRegister (db) {
  const empty = { names: new Set(), licences: new Set(), size: 0, missing: false }
  const { rows: [reg] } = await db.query("SELECT to_regclass('public.redacted_people') IS NOT NULL AS ok")
  if (!reg?.ok) return { ...empty, missing: true }
  const { rows } = await db.query("SELECT kind, encode(hash, 'hex') AS hash FROM public.redacted_people")
  for (const r of rows) (r.kind === 'licence' ? empty.licences : empty.names).add(r.hash)
  empty.size = rows.length
  return empty
}

/**
 * The matcher of a loaded register with the key: isRedacted({ first, last,
 * display, licence }) is true when the licence number, the first and last
 * name, or the display name is registered. An empty register matches nobody
 * (and needs no key).
 */
export function createRedactedMatcher (register, key) {
  const names = register?.names || new Set()
  const licences = register?.licences || new Set()
  const empty = names.size === 0 && licences.size === 0
  if (!empty && !key) throw new TypeError('createRedactedMatcher: the register holds entries and there is no key')
  const byDisplay = (display) => names.size > 0 && displayNameHashes(key, display).some((h) => names.has(h))
  return {
    empty,
    isRedacted ({ first, last, display, licence } = {}) {
      if (empty) return false
      if (licences.size) { const h = licenceHash(key, licence); if (h && licences.has(h)) return true }
      if (names.size) { const h = nameHash(key, first, last); if (h && names.has(h)) return true }
      return byDisplay(display)
    },
    isRedactedDisplay: (display) => !empty && byDisplay(display)
  }
}

/**
 * svrz_games rows (transformGame's) without the registered people: a
 * registered 1st or 2nd referee's name, first and last name and licence
 * number become NULL, a registered line judge NULL, and their names leave
 * `convocations`. Returns { rows, withheld } (rows changed are new objects;
 * withheld counts the referee and line judge places left empty).
 */
export function withholdRedacted (rows, matcher) {
  if (!matcher || matcher.empty) return { rows, withheld: 0 }
  let withheld = 0
  const out = rows.map((row) => {
    let r = row
    const drop = new Set() // display names to take out of the convocations
    const set = (k, v) => { if (r === row) r = { ...row }; r[k] = v }
    for (const n of [1, 2]) {
      const p = `referee_${n}`
      const who = { first: row[`${p}_first_name`], last: row[`${p}_last_name`], display: row[p], licence: row[`${p}_licence`] }
      if (!matcher.isRedacted(who)) continue
      withheld++
      if (normName(row[p])) drop.add(normName(row[p]))
      for (const k of [p, `${p}_first_name`, `${p}_last_name`, `${p}_licence`]) set(k, null)
    }
    for (const k of ['linesman_1', 'linesman_2']) {
      if (!matcher.isRedactedDisplay(row[k])) continue
      withheld++
      drop.add(normName(row[k]))
      set(k, null)
    }
    if (Array.isArray(row.convocations)) {
      const kept = row.convocations.filter((c) => !drop.has(normName(c)) && !matcher.isRedactedDisplay(c))
      if (kept.length !== row.convocations.length) set('convocations', kept)
    }
    return r
  })
  return { rows: out, withheld }
}
