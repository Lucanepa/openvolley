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
 * layer sends it ({ data, error }; a lock adds retryAfter, in seconds). Never
 * logs a key, PIN, token or address.
 *
 * Limits (audit 2026-11-23; every refusal is an answer the apps already
 * treat as "not saved, the next save tries again"):
 *   - SEC-01, the table shares the database volume with the official match
 *     records: at most maxTotalBytes / maxRows in all (counted from
 *     stored_bytes, db/053, cached usageTtlMs and kept up to date by every
 *     save), 507 OV_GLOBAL_FULL for a new key beyond them; a copy that
 *     exists may still grow up to growHeadroom above the ceiling. Per network
 *     (IPv6 /64 and /56, an IPv4 address; lib/globalQuota.js, in memory) and
 *     day: new keys, bytes added, bytes written, 429 OV_GLOBAL_QUOTA beyond;
 *     bytes written by everyone per minute (re-saves leave dead rows until
 *     vacuum), 503 OV_BUSY beyond. onAlert at alertShare of the ceiling and
 *     when it refuses (at most hourly).
 *   - SEC-30, the PIN (4 to 8 digits, the match's referee PIN): every wrong
 *     PIN of a copy is counted in its row (survives address changes and
 *     restarts); each PIN_LOCK_AFTER-th locks the copy (15 min, doubled each
 *     time, at most a day) for the networks that guessed it (IPv6 /48, IPv4
 *     /24, with a wrong PIN since their last right one): 429
 *     OV_GLOBAL_PIN_LOCKED, the right PIN from any other network still works
 *     (owner 2026-11-23: lock the guessers only). Compared in constant time.
 *   - PERM-15, the PDF a share link and the organizer list hand out: only a
 *     complete PDF (isPdfFile: header, startxref and %%EOF trailer, size),
 *     counted in stored_bytes; server.js serves it as an attachment.
 */
import crypto from 'node:crypto'
import { KEY_RE } from './globalStore.js'
import { addressPrefix, createNetworkBudget, createOncePer } from './globalQuota.js'

export const PIN_RE = /^[0-9]{4,8}$/
export const ORGANIZER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ORGANIZER_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const BUNDLE_MAX_BYTES = 3 * 1024 * 1024
export const PDF_MAX_BYTES = 3 * 1024 * 1024
export const ORGANIZER_LIST_MAX = 200
export const RETENTION_DAYS = 180
/** A real scoresheet is far larger (the app's own check wants 20 KB); a smaller "PDF" is a skeleton. */
export const PDF_MIN_BYTES = 1024

const MiB = 1024 * 1024
const GiB = 1024 * MiB
/** The ceilings and budgets (createGlobalMatches options override them; server.js: OV_GLOBAL_CLOUD_*). */
export const QUOTA_DEFAULTS = Object.freeze({
  // the whole table (every copy's stored_bytes): far below the database volume
  maxTotalBytes: 2 * GiB,
  maxRows: 50_000,
  // a copy that exists may still grow this share above maxTotalBytes (a match
  // in progress keeps its cloud copy when the ceiling is reached)
  growHeadroom: 0.25,
  usageTtlMs: 60_000,
  alertShare: 0.5,
  // bytes written by everyone in a minute
  writtenPerMinute: 256 * MiB,
  // per network and day: keys = new copies, bytes = what they add, written =
  // every byte saved (a copy is saved about once a minute during its match)
  perNetwork: Object.freeze([
    Object.freeze({ name: '/64', v6Bits: 64, v4Bits: 32, max: Object.freeze({ keys: 200, bytes: 512 * MiB, written: 3 * GiB }) }),
    Object.freeze({ name: '/56', v6Bits: 56, v4Bits: 32, max: Object.freeze({ keys: 500, bytes: 1 * GiB, written: 6 * GiB }) })
  ])
})
/**
 * The ceilings from the environment (server.js): OV_GLOBAL_CLOUD_MAX_MB (the
 * table's bytes, default 2048) and OV_GLOBAL_CLOUD_MAX_ROWS (default 50000).
 * Throws on a value it does not understand, so a typo fails at startup.
 */
export function cloudLimitsFromEnv(env = process.env) {
  const out = {}
  const num = (name) => {
    const raw = env[name]
    if (raw === undefined || String(raw).trim() === '') return undefined
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) throw new TypeError(`Global cloud: invalid ${name}=${JSON.stringify(raw)}`)
    return n
  }
  const mb = num('OV_GLOBAL_CLOUD_MAX_MB')
  if (mb !== undefined) out.maxTotalBytes = Math.round(mb * MiB)
  const rows = num('OV_GLOBAL_CLOUD_MAX_ROWS')
  if (rows !== undefined) out.maxRows = Math.floor(rows)
  return out
}
// SEC-30: wrong PINs of one copy, from anywhere
export const PIN_LOCK_AFTER = 10
export const PIN_LOCK_BASE_MS = 15 * 60_000
export const PIN_LOCK_MAX_MS = 24 * 60 * 60_000
/** The count of a copy starts over after this long without a wrong PIN. */
export const PIN_FAILURE_FORGET_MS = 24 * 60 * 60_000
/** The network a wrong PIN is held against while the copy is locked. */
export const guesserNetwork = (ip) => addressPrefix(ip, 48, 24)
/** How long the n-th wrong PIN (a multiple of PIN_LOCK_AFTER) locks the copy. */
export const pinLockMs = (n) => Math.min(PIN_LOCK_MAX_MS, PIN_LOCK_BASE_MS * 2 ** Math.max(0, Math.floor(n / PIN_LOCK_AFTER) - 1))
// a row from before db/053 has no stored_bytes: what its columns take
const STORED_SQL = 'coalesce(stored_bytes, pg_column_size(bundle) + pg_column_size(summary) + coalesce(octet_length(pdf), 0))'

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

/**
 * A complete PDF file (PERM-15): the %PDF-x.y header, PDF_MIN_BYTES to
 * PDF_MAX_BYTES, and the trailer at its end: startxref, then %%EOF as the
 * last thing in it (whitespace aside). What the apps' jsPDF writes, and what
 * their own check (scoresheet_pdf utils/pdfOutput isValidPdfBytes) wants
 * before they send it; a page with a %PDF prefix and anything after it is not one.
 */
export function isPdfFile(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < PDF_MIN_BYTES || buf.length > PDF_MAX_BYTES) return false
  if (!/^%PDF-[0-9]\.[0-9]/.test(buf.subarray(0, 8).toString('latin1'))) return false
  const tail = buf.subarray(Math.max(0, buf.length - 1024)).toString('latin1').trimEnd()
  return tail.endsWith('%%EOF') && tail.includes('startxref')
}

/** A PDF from base64: a Buffer, null for none, or false when it is not a complete PDF (isPdfFile) or too large. */
export function decodePdf(b64) {
  if (b64 == null) return null
  if (typeof b64 !== 'string' || b64.length > Math.ceil(PDF_MAX_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false
  const buf = Buffer.from(b64, 'base64')
  return isPdfFile(buf) ? buf : false
}

const ok = (data, status = 200) => ({ status, body: { data, error: null } })
const fail = (status, code, message, extra = {}) => ({ status, body: { data: null, error: { message, code, ...extra } } })
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null)

export function createGlobalMatches({ pool, now = () => new Date(), logger = console, onAlert = null, ...limits } = {}) {
  if (!pool) throw new Error('createGlobalMatches: pool required')
  const o = { ...QUOTA_DEFAULTS, ...limits }
  const q = (text, params) => pool.query(text, params)
  const ms = () => now().getTime()
  let lastSweep = 0

  // ---- SEC-01: the table's ceiling and the networks' budgets ----
  const budget = createNetworkBudget({ limits: o.perNetwork, now: ms })
  // { at, bytes, rows }: counted at most every usageTtlMs, kept up to date by the saves
  let usage = null
  let counting = null
  let written = { start: 0, bytes: 0 }
  const alertOnce = createOncePer(60 * 60_000, ms)
  const alert = (name, message) => {
    if (!alertOnce(name)) return
    logger.error?.(`[Global cloud] ALERT ${message}`)
    try { onAlert?.(message) } catch { /* an alert never fails a request */ }
  }
  async function currentUsage() {
    if (usage && ms() - usage.at < o.usageTtlMs) return usage
    counting ||= q(`SELECT count(*)::bigint AS rows, coalesce(sum(${STORED_SQL}), 0)::bigint AS bytes FROM public.global_matches`)
      .then(({ rows: [r] }) => { usage = { at: ms(), rows: Number(r.rows) || 0, bytes: Number(r.bytes) || 0 }; return usage })
      .finally(() => { counting = null })
    return counting
  }
  const mb = (n) => Math.round(n / MiB)

  /** The refusal of a save of newBytes (replacing oldBytes; isNew: a new copy) from ip, or null. */
  async function admit({ isNew, newBytes, oldBytes, ip }) {
    const grow = Math.max(0, newBytes - oldBytes)
    const t = ms()
    if (t - written.start >= 60_000) written = { start: t, bytes: 0 }
    if (written.bytes + newBytes > o.writtenPerMinute) {
      return fail(503, 'OV_BUSY', 'Server busy, retry shortly', { retryable: true })
    }
    const over = budget.over(ip, { keys: isNew ? 1 : 0, bytes: grow, written: newBytes })
    if (over) {
      logger.warn?.(`[Global cloud] refusing a save: a network's daily ${over.what} budget (${over.limit}) is spent`)
      return fail(429, 'OV_GLOBAL_QUOTA', 'Too much saved from this network today, try again later')
    }
    const u = await currentUsage()
    const full = isNew
      ? u.bytes + newBytes > o.maxTotalBytes || u.rows + 1 > o.maxRows
      : grow > 0 && u.bytes + grow > o.maxTotalBytes * (1 + o.growHeadroom)
    if (full) {
      alert('full', `the Global cloud is full (${mb(u.bytes)} MB in ${u.rows} copies, ceiling ${mb(o.maxTotalBytes)} MB / ${o.maxRows}): new copies are refused`)
      return fail(507, 'OV_GLOBAL_FULL', 'The cloud is full, try again later')
    }
    return null
  }

  function charged({ isNew, newBytes, oldBytes, ip }) {
    written.bytes += newBytes
    budget.charge(ip, { keys: isNew ? 1 : 0, bytes: Math.max(0, newBytes - oldBytes), written: newBytes })
    if (usage) {
      usage.bytes = Math.max(0, usage.bytes + newBytes - oldBytes)
      if (isNew) usage.rows++
      if (usage.bytes >= o.maxTotalBytes * o.alertShare || usage.rows >= o.maxRows * o.alertShare) {
        alert('half', `the Global cloud is over ${Math.round(o.alertShare * 100)}% full (${mb(usage.bytes)} MB in ${usage.rows} copies, ceiling ${mb(o.maxTotalBytes)} MB / ${o.maxRows})`)
      }
    }
  }

  // ---- SEC-30: wrong PINs ----
  // keyHash -> Map(network -> wrong PINs since its last right one); a day at most
  const guessers = new Map()
  const MAX_GUESSED_KEYS = 10_000
  const MAX_NETWORKS_PER_KEY = 64
  function guessedBy(kh, net) {
    const e = guessers.get(kh)?.get(net)
    if (!e) return 0
    if (ms() - e.at >= PIN_FAILURE_FORGET_MS) { guessers.get(kh).delete(net); return 0 }
    return e.n
  }
  function noteGuess(kh, net) {
    let nets = guessers.get(kh)
    if (!nets) {
      while (guessers.size >= MAX_GUESSED_KEYS) guessers.delete(guessers.keys().next().value)
      nets = new Map()
      guessers.set(kh, nets)
    }
    const e = nets.get(net)
    if (!e && nets.size >= MAX_NETWORKS_PER_KEY) nets.delete(nets.keys().next().value)
    nets.set(net, { n: (e && ms() - e.at < PIN_FAILURE_FORGET_MS ? e.n : 0) + 1, at: ms() })
  }
  function clearGuess(kh, net) {
    const nets = guessers.get(kh)
    if (!nets) return
    nets.delete(net)
    if (!nets.size) guessers.delete(kh)
  }
  const sameHash = (a, b) => {
    const x = Buffer.from(String(a || ''), 'hex')
    const y = Buffer.from(String(b || ''), 'hex')
    return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y)
  }

  /** The PIN check of an existing row: null when it is right, else the answer (a lock, or a counted wrong PIN). */
  async function checkPin(row, key, pin, ip) {
    const kh = keyHash(key)
    const net = guesserNetwork(ip)
    const lockedMs = row.locked_until ? new Date(row.locked_until).getTime() - ms() : 0
    if (lockedMs > 0 && guessedBy(kh, net) > 0) {
      return { ...fail(429, 'OV_GLOBAL_PIN_LOCKED', 'Too many wrong PINs, try again later'), retryAfter: Math.ceil(lockedMs / 1000) }
    }
    if (sameHash(row.pin_hash, pinHash(key, pin))) {
      clearGuess(kh, net)
      return null
    }
    noteGuess(kh, net)
    const { rows: [f] } = await q(
      `UPDATE public.global_matches SET
         pin_failures = CASE WHEN pin_failed_at IS NULL OR pin_failed_at < now() - make_interval(secs => $2) THEN 1 ELSE coalesce(pin_failures, 0) + 1 END,
         pin_failed_at = now()
       WHERE id = $1 RETURNING pin_failures`,
      [row.id, PIN_FAILURE_FORGET_MS / 1000])
    const n = Number(f?.pin_failures) || 0
    if (n > 0 && n % PIN_LOCK_AFTER === 0) {
      const lockMs = pinLockMs(n)
      await q('UPDATE public.global_matches SET locked_until = greatest(coalesce(locked_until, now()), now() + make_interval(secs => $2)) WHERE id = $1', [row.id, lockMs / 1000])
      logger.warn?.(`[Global cloud] a copy is locked for ${Math.round(lockMs / 60_000)} min after ${n} wrong PINs (for the networks that guessed)`)
      alert('pin', 'a Global cloud copy was locked after repeated wrong PINs (someone with its backup code guesses the PIN)')
    }
    return fail(403, 'OV_GLOBAL_PIN', 'Wrong PIN')
  }

  // The row of a key with the PIN checked: { row } or a failure answer
  async function own(key, pin, columns = 'id', ip = null) {
    if (!isGlobalKey(key) || !isPin(pin)) return { answer: fail(400, 'OV_GLOBAL_INVALID', 'Invalid request') }
    const { rows } = await q(`SELECT ${columns}, pin_hash AS own_pin_hash, locked_until AS own_locked_until FROM public.global_matches WHERE key_hash = $1 AND expires_at > now()`, [keyHash(key)])
    if (!rows[0]) return { answer: fail(404, 'OV_NOT_FOUND', 'Not found') }
    const refused = await checkPin({ id: rows[0].id, pin_hash: rows[0].own_pin_hash, locked_until: rows[0].own_locked_until }, key, pin, ip)
    if (refused) return { answer: refused }
    return { row: rows[0] }
  }

  async function save(key, pin, { bundle, summary, organizer = null, pdf } = {}, { ip = null } = {}) {
    if (!isGlobalKey(key) || !isPin(pin)) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid request')
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid request')
    if (organizer != null && !isOrganizerCode(organizer)) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid organizer code')
    const bundleText = JSON.stringify(bundle)
    const bundleBytes = Buffer.byteLength(bundleText)
    if (bundleBytes > BUNDLE_MAX_BYTES) return fail(413, 'OV_GLOBAL_TOO_LARGE', 'Match too large')
    const pdfBuf = pdf === undefined ? undefined : decodePdf(pdf)
    if (pdfBuf === false) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid PDF')
    const kh = keyHash(key)
    const ph = pinHash(key, pin)
    const sum = JSON.stringify(sanitizeSummary(summary))
    const org = organizer ? organizerHash(organizer) : null
    // An expired row is a new match (the sweep may not have run yet)
    const { rowCount: expired } = await q('DELETE FROM public.global_matches WHERE key_hash = $1 AND expires_at <= now()', [kh])
    if (expired) usage = null
    // the copy this save replaces: its PIN (SEC-30) and its size (SEC-01)
    const { rows: [cur] } = await q(
      `SELECT id, pin_hash, locked_until, ${STORED_SQL} AS bytes, coalesce(octet_length(pdf), 0) AS pdf_bytes FROM public.global_matches WHERE key_hash = $1`, [kh])
    if (cur) {
      const refused = await checkPin(cur, key, pin, ip)
      if (refused) return refused
    }
    const keepPdf = pdfBuf === undefined
    const isNew = !cur
    const newBytes = bundleBytes + Buffer.byteLength(sum) + (keepPdf ? Number(cur?.pdf_bytes) || 0 : pdfBuf?.length ?? 0)
    const oldBytes = cur ? Number(cur.bytes) || 0 : 0
    const refused = await admit({ isNew, newBytes, oldBytes, ip })
    if (refused) return refused
    const { rows } = await q(
      `INSERT INTO public.global_matches AS g (key_hash, pin_hash, organizer_hash, summary, bundle, pdf, stored_bytes)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $8)
       ON CONFLICT (key_hash) DO UPDATE SET
         organizer_hash = excluded.organizer_hash,
         summary = excluded.summary,
         bundle = excluded.bundle,
         pdf = CASE WHEN $7::boolean THEN g.pdf ELSE excluded.pdf END,
         stored_bytes = excluded.stored_bytes,
         updated_at = now(),
         expires_at = now() + interval '${RETENTION_DAYS} days'
       WHERE g.pin_hash = excluded.pin_hash
       RETURNING updated_at, share_token`,
      [kh, ph, org, sum, bundleText, keepPdf ? null : pdfBuf, keepPdf, newBytes]
    )
    // no row: another device made this key with another PIN meanwhile
    if (!rows[0]) return fail(403, 'OV_GLOBAL_PIN', 'Wrong PIN')
    charged({ isNew, newBytes, oldBytes, ip })
    maybeSweep()
    return ok({ ok: true, updatedAt: iso(rows[0].updated_at), shareToken: rows[0].share_token ?? null })
  }

  async function load(key, pin, { ip = null } = {}) {
    const r = await own(key, pin, 'id, bundle, summary, updated_at, share_token, organizer_hash', ip)
    if (r.answer) return r.answer
    const row = r.row
    return ok({ bundle: row.bundle, summary: row.summary, updatedAt: iso(row.updated_at), shareToken: row.share_token ?? null, organizer: row.organizer_hash != null })
  }

  async function setShare(key, pin, on, { ip = null } = {}) {
    const r = await own(key, pin, 'id', ip)
    if (r.answer) return r.answer
    const token = on === true ? newShareToken() : null
    await q('UPDATE public.global_matches SET share_token = $2 WHERE id = $1', [r.row.id, token])
    return ok({ shareToken: token })
  }

  async function del(key, pin, { ip = null } = {}) {
    const r = await own(key, pin, 'id', ip)
    if (r.answer) return r.answer
    await q('DELETE FROM public.global_matches WHERE id = $1', [r.row.id])
    usage = null
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
    if (rowCount) usage = null
    budget.sweep()
    return rowCount || 0
  }

  // at most hourly, after a save; failures only logged
  function maybeSweep() {
    if (now().getTime() - lastSweep < 60 * 60 * 1000) return
    sweepExpired().catch((err) => logger.warn?.('[Global cloud] sweep failed:', String(err?.code || err?.message || err).slice(0, 120)))
  }

  return { save, load, setShare, del, shared, sharedPdf, organizerList, organizerPdf, sweepExpired, usage: currentUsage, budget }
}
