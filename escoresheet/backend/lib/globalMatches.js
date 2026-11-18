/**
 * globalMatches — the Global tool's opt-in cloud copy of a match (db/046).
 *
 * A Global match (any tournament, no account) stays on the scorer's device;
 * with "Save in the cloud" (Match setup, owner 2026-11-17) the device also
 * keeps it here, readable by the server:
 *
 *   save(key, pin, { bundle, summary, organizer, pdf })  first save sets the PIN
 *   load(key, pin)          another scorer device continues or corrects it
 *   setShare(key, pin, on)  a read-only link: shared(token), sharedPdf(token)
 *   del(key, pin)           gone at once
 *   organizerList(code)     every match saved with that organizer code
 *   organizerPdf(code, id)
 *   sweepExpired()          180 days after the last save (privacy policy)
 *
 * The match's random key (frontend utils/globalCloud newGlobalKey, the backup
 * code) is the way to its row; only hashes of the key, the PIN and the
 * organizer code are stored. Each call answers { status, body } as the HTTP
 * layer sends it ({ data, error }). Never logs a key, PIN or token.
 */
import crypto from 'node:crypto'
import { KEY_RE } from './globalStore.js'

export const PIN_RE = /^[0-9]{4,8}$/
export const ORGANIZER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ORGANIZER_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const BUNDLE_MAX_BYTES = 3 * 1024 * 1024
export const PDF_MAX_BYTES = 3 * 1024 * 1024
export const ORGANIZER_LIST_MAX = 200
export const RETENTION_DAYS = 180

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
export const keyHash = (key) => sha(`global-key\0${key}`)
export const pinHash = (key, pin) => sha(`global-pin\0${key}\0${pin}`)
export const organizerHash = (code) => sha(`global-org\0${code}`)
export const newShareToken = () => crypto.randomBytes(16).toString('base64url') // 22 characters

export const isGlobalKey = (k) => typeof k === 'string' && KEY_RE.test(k)
export const isPin = (p) => typeof p === 'string' && PIN_RE.test(p)
export const isOrganizerCode = (c) => typeof c === 'string' && ORGANIZER_RE.test(c)
export const isShareToken = (t) => typeof t === 'string' && TOKEN_RE.test(t)
export const isUuid = (u) => typeof u === 'string' && UUID_RE.test(u)

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Math.max(0, Math.min(999, Math.trunc(Number(v)))) : 0)
const color = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : null)
const STATUSES = new Set(['scheduled', 'live', 'ended', 'final'])

/** The result as the lists show it: only these fields, bounded. */
export function sanitizeSummary(summary) {
  const s = summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {}
  const team = (t) => {
    const o = t && typeof t === 'object' ? t : {}
    return { name: str(o.name, 80), short: str(o.short, 12), color: color(o.color) }
  }
  const won = s.setsWon && typeof s.setsWon === 'object' ? s.setsWon : {}
  const sets = (Array.isArray(s.sets) ? s.sets : [])
    .filter((x) => x && typeof x === 'object')
    .slice(0, 5)
    .map((x) => ({ home: int(x.home), away: int(x.away) }))
  return {
    home: team(s.home),
    away: team(s.away),
    setsWon: { home: int(won.home), away: int(won.away) },
    sets,
    status: STATUSES.has(s.status) ? s.status : 'scheduled',
    hall: str(s.hall, 120),
    league: str(s.league, 120),
    scheduledAt: str(s.scheduledAt, 40),
    gameNumber: str(s.gameNumber != null ? String(s.gameNumber) : null, 20)
  }
}

/** A PDF from base64: a Buffer, null for none, or false when it is not a PDF or too large. */
export function decodePdf(b64) {
  if (b64 == null) return null
  if (typeof b64 !== 'string' || b64.length > Math.ceil(PDF_MAX_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false
  const buf = Buffer.from(b64, 'base64')
  if (buf.length === 0 || buf.length > PDF_MAX_BYTES || buf.subarray(0, 4).toString('latin1') !== '%PDF') return false
  return buf
}

const ok = (data, status = 200) => ({ status, body: { data, error: null } })
const fail = (status, code, message) => ({ status, body: { data: null, error: { message, code } } })
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null)

export function createGlobalMatches({ pool, now = () => new Date(), logger = console } = {}) {
  if (!pool) throw new Error('createGlobalMatches: pool required')
  const q = (text, params) => pool.query(text, params)
  let lastSweep = 0

  // The row of a key with the PIN checked: { row } or a failure answer
  async function own(key, pin, columns = 'id, pin_hash') {
    if (!isGlobalKey(key) || !isPin(pin)) return { answer: fail(400, 'OV_GLOBAL_INVALID', 'Invalid request') }
    const { rows } = await q(`SELECT ${columns} FROM public.global_matches WHERE key_hash = $1 AND expires_at > now()`, [keyHash(key)])
    if (!rows[0]) return { answer: fail(404, 'OV_NOT_FOUND', 'Not found') }
    if (rows[0].pin_hash !== pinHash(key, pin)) return { answer: fail(403, 'OV_GLOBAL_PIN', 'Wrong PIN') }
    return { row: rows[0] }
  }

  async function save(key, pin, { bundle, summary, organizer = null, pdf } = {}) {
    if (!isGlobalKey(key) || !isPin(pin)) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid request')
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid request')
    if (organizer != null && !isOrganizerCode(organizer)) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid organizer code')
    const bundleText = JSON.stringify(bundle)
    if (Buffer.byteLength(bundleText) > BUNDLE_MAX_BYTES) return fail(413, 'OV_GLOBAL_TOO_LARGE', 'Match too large')
    const pdfBuf = pdf === undefined ? undefined : decodePdf(pdf)
    if (pdfBuf === false) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid PDF')
    const kh = keyHash(key)
    const ph = pinHash(key, pin)
    const sum = JSON.stringify(sanitizeSummary(summary))
    const org = organizer ? organizerHash(organizer) : null
    // An expired row is a new match (the sweep may not have run yet)
    await q('DELETE FROM public.global_matches WHERE key_hash = $1 AND expires_at <= now()', [kh])
    const keepPdf = pdfBuf === undefined
    const { rows } = await q(
      `INSERT INTO public.global_matches AS g (key_hash, pin_hash, organizer_hash, summary, bundle, pdf)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       ON CONFLICT (key_hash) DO UPDATE SET
         organizer_hash = excluded.organizer_hash,
         summary = excluded.summary,
         bundle = excluded.bundle,
         pdf = CASE WHEN $7::boolean THEN g.pdf ELSE excluded.pdf END,
         updated_at = now(),
         expires_at = now() + interval '${RETENTION_DAYS} days'
       WHERE g.pin_hash = excluded.pin_hash
       RETURNING updated_at, share_token`,
      [kh, ph, org, sum, bundleText, keepPdf ? null : pdfBuf, keepPdf]
    )
    // no row: the key exists with another PIN
    if (!rows[0]) return fail(403, 'OV_GLOBAL_PIN', 'Wrong PIN')
    maybeSweep()
    return ok({ ok: true, updatedAt: iso(rows[0].updated_at), shareToken: rows[0].share_token ?? null })
  }

  async function load(key, pin) {
    const r = await own(key, pin, 'id, pin_hash, bundle, summary, updated_at, share_token, organizer_hash')
    if (r.answer) return r.answer
    const row = r.row
    return ok({ bundle: row.bundle, summary: row.summary, updatedAt: iso(row.updated_at), shareToken: row.share_token ?? null, organizer: row.organizer_hash != null })
  }

  async function setShare(key, pin, on) {
    const r = await own(key, pin)
    if (r.answer) return r.answer
    const token = on === true ? newShareToken() : null
    await q('UPDATE public.global_matches SET share_token = $2 WHERE id = $1', [r.row.id, token])
    return ok({ shareToken: token })
  }

  async function del(key, pin) {
    const r = await own(key, pin)
    if (r.answer) return r.answer
    await q('DELETE FROM public.global_matches WHERE id = $1', [r.row.id])
    return ok({ ok: true })
  }

  async function shared(token) {
    if (!isShareToken(token)) return fail(404, 'OV_NOT_FOUND', 'Not found')
    const { rows } = await q('SELECT summary, updated_at, pdf IS NOT NULL AS has_pdf FROM public.global_matches WHERE share_token = $1 AND expires_at > now()', [token])
    if (!rows[0]) return fail(404, 'OV_NOT_FOUND', 'Not found')
    return ok({ summary: rows[0].summary, updatedAt: iso(rows[0].updated_at), hasPdf: rows[0].has_pdf === true })
  }

  /** The PDF Buffer of a shared match, or null. */
  async function sharedPdf(token) {
    if (!isShareToken(token)) return null
    const { rows } = await q('SELECT pdf FROM public.global_matches WHERE share_token = $1 AND expires_at > now() AND pdf IS NOT NULL', [token])
    return rows[0]?.pdf ?? null
  }

  async function organizerList(code) {
    if (!isOrganizerCode(code)) return fail(404, 'OV_NOT_FOUND', 'Not found')
    const { rows } = await q(
      `SELECT id, summary, updated_at, share_token, pdf IS NOT NULL AS has_pdf FROM public.global_matches
        WHERE organizer_hash = $1 AND expires_at > now() ORDER BY updated_at DESC LIMIT ${ORGANIZER_LIST_MAX}`,
      [organizerHash(code)]
    )
    return ok({ matches: rows.map((r) => ({ id: r.id, summary: r.summary, updatedAt: iso(r.updated_at), shareToken: r.share_token ?? null, hasPdf: r.has_pdf === true })) })
  }

  /** The PDF Buffer of one match of an organizer code, or null. */
  async function organizerPdf(code, id) {
    if (!isOrganizerCode(code) || !isUuid(id)) return null
    const { rows } = await q('SELECT pdf FROM public.global_matches WHERE id = $1 AND organizer_hash = $2 AND expires_at > now() AND pdf IS NOT NULL', [id, organizerHash(code)])
    return rows[0]?.pdf ?? null
  }

  async function sweepExpired() {
    lastSweep = now().getTime()
    const { rowCount } = await q('DELETE FROM public.global_matches WHERE expires_at <= now()')
    return rowCount || 0
  }

  // at most hourly, after a save; failures only logged
  function maybeSweep() {
    if (now().getTime() - lastSweep < 60 * 60 * 1000) return
    sweepExpired().catch((err) => logger.warn?.('[Global cloud] sweep failed:', String(err?.code || err?.message || err).slice(0, 120)))
  }

  return { save, load, setShare, del, shared, sharedPdf, organizerList, organizerPdf, sweepExpired }
}
