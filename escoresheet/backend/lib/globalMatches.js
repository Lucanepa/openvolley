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
 *     exists may still grow up to growHeadroom above the ceiling, each network
 *     (IPv6 /48, IPv4 /24) by its 'headroom' a day. Per network (IPv6 /64,
 *     /56 and /48, an IPv4 address and its /24; lib/globalQuota.js, in
 *     memory) and day: new keys and bytes added, 429 OV_GLOBAL_QUOTA beyond.
 *     A full table evicts the newest copies of the networks that created
 *     more than evictShare of it since the start (the creator is known in
 *     memory only), never anyone else's; 507 when there are none
 *     (scripts/global-cloud-purge.mjs clears junk an earlier process let in).
 *     onAlert at alertShare of the ceiling, when it refuses and when it
 *     evicts (at most hourly).
 *   - GCS-R1, every byte saved becomes WAL, which the archive keeps on the
 *     same volume until the hourly backup run: what everyone writes a minute,
 *     an hour and a day (counted as stored, compressed), a network a quarter
 *     of each and the last quarter for networks that wrote little (503
 *     OV_BUSY when all is spent, 429 OV_GLOBAL_QUOTA for a network's share);
 *     with walGuard, no write while walMaxBytes of WAL wait for the next
 *     backup run or the archiving fails (503).
 *   - SEC-30, the PIN (4 to 8 digits, the match's referee PIN): every wrong
 *     PIN of a copy is counted in its row (survives address changes and
 *     restarts); each PIN_LOCK_AFTER-th locks the copy (15 min, doubled each
 *     time, at most a day) for the networks that guessed it (IPv6 /48, IPv4
 *     /24, with a wrong PIN since their last right one): 429
 *     OV_GLOBAL_PIN_LOCKED, the right PIN from any other network still works
 *     (owner 2026-11-23: lock the guessers only). Compared in constant time.
 *     A copy remembers up to PIN_NETWORKS_PER_KEY guessing networks and never
 *     forgets one for a newer one; once that list is full (a guesser with
 *     more networks), every network it does not know is held off too while
 *     the copy is locked, except the few that gave the right PIN in the last
 *     day (the scorer's devices). PIN_MEMORY_ENTRIES networks in all.
 *   - PERM-15, the PDF a share link and the organizer list hand out: only a
 *     complete PDF (isPdfFile: header, startxref and %%EOF trailer, size),
 *     counted in stored_bytes; server.js serves it as an attachment.
 */
import crypto from 'node:crypto'
import { KEY_RE } from './globalStore.js'
import { addressPrefix, createNetworkBudget, createOncePer, createSharedBudget, DAY_MS } from './globalQuota.js'

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
  // in progress keeps its cloud copy when the ceiling is reached); what one
  // network may grow there is its perNetwork 'headroom' (GCS-R4)
  growHeadroom: 0.25,
  usageTtlMs: 60_000,
  alertShare: 0.5,
  // What everyone writes (GCS-R1): every saved byte becomes WAL, which the
  // archive keeps on the database volume until the hourly backup takes it
  // away, and the backups keep 8 days of. Counted as Postgres stores it
  // (pg_column_size: a real match's JSON compresses about 4:1, random filler
  // does not), plus WAL_ROW_BYTES a save. A genuine copy writes about 20-40
  // KB a minute while its match runs (2-3 MB a match with its PDF), so a
  // minute serves hundreds of matches at once and a day thousands. One
  // network (IPv6 /48, IPv4 /24) may use a quarter of each window, and the
  // last quarter is kept for networks that used little of it (under 1/32):
  // beyond, 429 OV_GLOBAL_QUOTA (the network's share) or 503 OV_BUSY (all).
  writtenPerMinute: 16 * MiB,
  writtenPerHour: 256 * MiB,
  writtenPerDay: 1 * GiB,
  writtenNetShare: 0.25,
  writtenReserveShare: 0.25,
  writtenLightShare: 1 / 32,
  // When the table is full (GCS-R4): a network that created more than this
  // share of its rows or bytes since the start gives room, its newest copies
  // first (at most evictPerSave a save); a new copy of that network itself
  // gets 507. The copies of every other network are never evicted.
  evictShare: 0.1,
  evictPerSave: 50,
  // per network and day: keys = new copies, bytes = what they add to the
  // table, headroom = what they grow while the table is above its ceiling
  perNetwork: Object.freeze([
    Object.freeze({ name: '/64', v6Bits: 64, v4Bits: 32, max: Object.freeze({ keys: 200, bytes: 128 * MiB }) }),
    Object.freeze({ name: '/56', v6Bits: 56, v4Bits: 32, max: Object.freeze({ keys: 500, bytes: 256 * MiB }) }),
    Object.freeze({ name: '/48', v6Bits: 48, v4Bits: 24, max: Object.freeze({ keys: 1000, bytes: 512 * MiB, headroom: 32 * MiB }) })
  ]),
  // the WAL waiting for the next backup run (walGuard, server.js): beyond
  // walMaxBytes (or while the archiving fails) every cloud write is refused
  walMaxBytes: 1 * GiB,
  walSampleMs: 60_000
})
/** What a save costs in WAL beside its columns: the row version, its index entries, the TOAST index. */
export const WAL_ROW_BYTES = 2048
/**
 * The ceilings from the environment (server.js): OV_GLOBAL_CLOUD_MAX_MB (the
 * table's bytes, default 2048), OV_GLOBAL_CLOUD_MAX_ROWS (default 50000),
 * OV_GLOBAL_CLOUD_WRITE_MB_DAY (what everyone may write a day, default 1024;
 * an hour a quarter of it, a minute 1/64) and OV_GLOBAL_CLOUD_WAL_MAX_MB (the
 * WAL waiting for the next backup beyond which cloud writes stop, default
 * 1024). Throws on a value it does not understand, so a typo fails at startup.
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
  const day = num('OV_GLOBAL_CLOUD_WRITE_MB_DAY')
  if (day !== undefined) {
    out.writtenPerDay = Math.round(day * MiB)
    out.writtenPerHour = Math.round(day * MiB / 4)
    out.writtenPerMinute = Math.round(day * MiB / 64)
  }
  const wal = num('OV_GLOBAL_CLOUD_WAL_MAX_MB')
  if (wal !== undefined) out.walMaxBytes = Math.round(wal * MiB)
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
/** The network a copy's creation and its writes are counted to (GCS-R1, GCS-R4): an IPv6 /48, an IPv4 /24. */
export const creatorNetwork = (ip) => addressPrefix(ip, 48, 24)
/**
 * The memory of who guessed (GCS-R3, the review of the SEC-30 fix): at most
 * PIN_NETWORKS_PER_KEY guessing networks per copy, never pushed out by a new
 * one (a copy whose list is full holds every network it does not know off
 * while locked, except PIN_PROVEN_PER_KEY networks that gave the right PIN),
 * and PIN_MEMORY_ENTRIES networks in all, the entries of unlocked copies
 * given up first. createGlobalMatches options pinNetworksPerKey /
 * pinMemoryEntries override them (tests).
 */
export const PIN_NETWORKS_PER_KEY = 64
export const PIN_PROVEN_PER_KEY = 8
export const PIN_MEMORY_ENTRIES = 50_000
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
  // what everyone writes, a minute, an hour, a day (GCS-R1)
  const writes = createSharedBudget({
    windows: [
      { name: 'minute', ms: 60_000, max: o.writtenPerMinute },
      { name: 'hour', ms: 60 * 60_000, max: o.writtenPerHour },
      { name: 'day', ms: DAY_MS, max: o.writtenPerDay }
    ],
    netOf: creatorNetwork,
    netShare: o.writtenNetShare,
    reserveShare: o.writtenReserveShare,
    lightShare: o.writtenLightShare,
    now: ms
  })
  // { at, bytes, rows }: counted at most every usageTtlMs, kept up to date by the saves
  let usage = null
  let counting = null
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
  const busy = (retryAfter) => ({ ...fail(503, 'OV_BUSY', 'Server busy, retry shortly', { retryable: true }), retryAfter })

  // ---- GCS-R1: the WAL waiting for the next backup (walGuard) ----
  // server.js passes walGuard { lastBackupAt: async () => ms | null } (the
  // host's last_backup stamp): the archive the backup run empties holds the
  // WAL written since it. Measured from pg_current_wal_insert_lsn, sampled at
  // most every walSampleMs; a failing archive_command (pg_stat_archiver) stops
  // the cloud writes at once. Unknown (no stamp, a failed probe): not refused.
  const walGuard = o.walGuard || null
  const walSamples = [] // { at, lsn }, a day and a bit
  let walSeen = null // { at, failing, pending }
  let walChecking = null
  async function walProbe() {
    if (walGuard.probe) return walGuard.probe()
    const { rows: [r] } = await q(`SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), '0/0')::bigint AS lsn,
      coalesce((SELECT last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time) FROM pg_stat_archiver), false) AS failing`)
    return { lsn: Number(r.lsn), failing: r.failing === true }
  }
  async function walState() {
    if (!walGuard) return null
    if (walSeen && ms() - walSeen.at < o.walSampleMs) return walSeen
    walChecking ||= (async () => {
      const p = await walProbe()
      const backupAt = await walGuard.lastBackupAt?.() ?? null
      const at = ms()
      walSamples.push({ at, lsn: p.lsn })
      while (walSamples.length > 2 && at - walSamples[1].at > DAY_MS + 3600_000) walSamples.shift()
      let base = walSamples[0]
      for (const x of walSamples) { if (x.at <= backupAt) base = x; else break }
      walSeen = { at, failing: p.failing === true, pending: Number.isFinite(backupAt) ? Math.max(0, p.lsn - base.lsn) : null }
    })().catch((err) => {
      if (alertOnce('wal-probe')) logger.warn?.('[Global cloud] WAL check failed:', String(err?.code || err?.message || err).slice(0, 120))
      walSeen = { at: ms(), failing: false, pending: null }
    }).finally(() => { walChecking = null })
    await walChecking
    return walSeen
  }

  // ---- GCS-R4: who created which copy, for the eviction when full ----
  // keyHash -> { net, bytes, last } of the copies this process saw created
  // (memory only: addresses are never stored), net -> { rows, bytes, keys }
  const created = new Map()
  const holdings = new Map()
  function forgetCopy(kh) {
    const c = created.get(kh)
    if (!c) return
    created.delete(kh)
    const h = holdings.get(c.net)
    if (!h) return
    h.rows--
    h.bytes -= c.bytes
    h.keys.delete(kh)
    if (!h.keys.size) holdings.delete(c.net)
  }
  function noteCopy(kh, net, bytes, isNew) {
    let c = created.get(kh)
    if (isNew) {
      if (c) forgetCopy(kh)
      while (created.size >= o.maxRows * 1.1 + 100) forgetCopy(created.keys().next().value)
      c = { net, bytes: 0, last: ms() }
      created.set(kh, c)
      let h = holdings.get(net)
      if (!h) { h = { rows: 0, bytes: 0, keys: new Set() }; holdings.set(net, h) }
      h.rows++
      h.keys.add(kh)
    }
    if (!c) return
    const h = holdings.get(c.net)
    if (h) h.bytes += bytes - c.bytes
    c.bytes = bytes
    c.last = ms()
  }
  const overShare = (net) => {
    const h = holdings.get(net)
    return !!h && (h.rows > o.maxRows * o.evictShare || h.bytes > o.maxTotalBytes * o.evictShare)
  }
  /**
   * A full table makes room for one new copy of newBytes from net: the
   * newest copies of the networks over their share (evictShare), the largest
   * holder of what is short first. Returns the usage after it, or null when
   * there is no such copy (or net is over its share itself).
   */
  async function evictFor(u, newBytes, net) {
    if (overShare(net)) return null
    const rowsShort = (x) => x.rows + 1 > o.maxRows
    const bytesShort = (x) => x.bytes + newBytes > o.maxTotalBytes
    const nets = [...holdings].filter(([n]) => n !== net && overShare(n))
      .sort(([, a], [, b]) => (rowsShort(u) ? b.rows - a.rows : b.bytes - a.bytes))
    const victims = []
    let freeRows = 0
    let freeBytes = 0
    for (const [, h] of nets) {
      for (const kh of [...h.keys].reverse()) {
        if (victims.length >= o.evictPerSave) break
        if (!rowsShort({ rows: u.rows - freeRows }) && !bytesShort({ bytes: u.bytes - freeBytes })) break
        victims.push(kh)
        freeRows++
        freeBytes += created.get(kh)?.bytes ?? 0
      }
    }
    if (!victims.length) return null
    const { rows } = await q(`DELETE FROM public.global_matches WHERE key_hash = ANY($1::text[]) RETURNING key_hash, ${STORED_SQL} AS bytes`, [victims])
    for (const kh of victims) forgetCopy(kh)
    const after = { ...u, at: u.at, rows: Math.max(0, u.rows - rows.length), bytes: Math.max(0, u.bytes - rows.reduce((n, r) => n + (Number(r.bytes) || 0), 0)) }
    if (usage) { usage.rows = after.rows; usage.bytes = after.bytes }
    logger.warn?.(`[Global cloud] the table was full: ${rows.length} copies of networks over their share evicted`)
    alert('evicted', `the Global cloud is full (${mb(after.bytes)} MB in ${after.rows} copies, ceiling ${mb(o.maxTotalBytes)} MB / ${o.maxRows}): the newest copies of networks over a ${Math.round(o.evictShare * 100)}% share were evicted`)
    return after
  }

  /** The refusal of a save of newBytes (replacing oldBytes; isNew: a new copy) from ip, or { headroom }: what it grows above the ceiling. */
  async function admit({ isNew, newBytes, oldBytes, ip }) {
    const grow = Math.max(0, newBytes - oldBytes)
    const wal = await walState()
    if (wal?.failing) {
      alert('wal', 'the database\'s WAL archiving fails (pg_stat_archiver): Global cloud saves are refused until it works again')
      return busy(300)
    }
    if (wal?.pending != null && wal.pending > o.walMaxBytes) {
      alert('wal', `${mb(wal.pending)} MB of WAL wait for the next backup run (limit ${mb(o.walMaxBytes)} MB): Global cloud saves are refused until it runs`)
      return busy(300)
    }
    // a save is let in while its window has room, and charged what it wrote
    const w = writes.over(ip, 1)
    if (w) {
      logger.warn?.(`[Global cloud] refusing a save: ${w.why === 'total' ? 'everyone\'s' : 'a network\'s share of the'} ${w.window}'s write budget is spent`)
      if (w.why === 'total') return busy(Math.ceil(w.retryMs / 1000))
      return { ...fail(429, 'OV_GLOBAL_QUOTA', 'Too much saved from this network, try again later'), retryAfter: Math.ceil(w.retryMs / 1000) }
    }
    let u = await currentUsage()
    const headroom = !isNew && grow > 0 && u.bytes + grow > o.maxTotalBytes ? grow : 0
    const over = budget.over(ip, { keys: isNew ? 1 : 0, bytes: grow, headroom })
    if (over?.what === 'headroom' || (headroom && u.bytes + grow > o.maxTotalBytes * (1 + o.growHeadroom))) {
      alert('full', `the Global cloud is full (${mb(u.bytes)} MB in ${u.rows} copies, ceiling ${mb(o.maxTotalBytes)} MB / ${o.maxRows}): copies that grow are refused`)
      return fail(507, 'OV_GLOBAL_FULL', 'The cloud is full, try again later')
    }
    if (over) {
      logger.warn?.(`[Global cloud] refusing a save: a network's daily ${over.what} budget (${over.limit}) is spent`)
      return fail(429, 'OV_GLOBAL_QUOTA', 'Too much saved from this network today, try again later')
    }
    if (isNew && (u.bytes + newBytes > o.maxTotalBytes || u.rows + 1 > o.maxRows)) {
      const after = await evictFor(u, newBytes, creatorNetwork(ip))
      if (after) u = after
      if (!after || u.bytes + newBytes > o.maxTotalBytes || u.rows + 1 > o.maxRows) {
        alert('full', `the Global cloud is full (${mb(u.bytes)} MB in ${u.rows} copies, ceiling ${mb(o.maxTotalBytes)} MB / ${o.maxRows}): new copies are refused`)
        return fail(507, 'OV_GLOBAL_FULL', 'The cloud is full, try again later')
      }
    }
    return { headroom }
  }

  /** After the write: what it cost in WAL (as Postgres stores the columns it wrote), the budgets, the counts. */
  async function charged({ kh, isNew, newBytes, oldBytes, ip, headroom, pdfWritten }) {
    let stored = newBytes
    try {
      const { rows: [w] } = await q(`SELECT pg_column_size(bundle) + pg_column_size(summary) + CASE WHEN $2::boolean THEN coalesce(pg_column_size(pdf), 0) ELSE 0 END AS stored
        FROM public.global_matches WHERE key_hash = $1`, [kh, pdfWritten])
      if (w && Number.isFinite(Number(w.stored))) stored = Number(w.stored)
    } catch { /* counted as sent */ }
    writes.charge(ip, stored + WAL_ROW_BYTES)
    budget.charge(ip, { keys: isNew ? 1 : 0, bytes: Math.max(0, newBytes - oldBytes), headroom })
    noteCopy(kh, creatorNetwork(ip), newBytes, isNew)
    if (usage) {
      usage.bytes = Math.max(0, usage.bytes + newBytes - oldBytes)
      if (isNew) usage.rows++
      if (usage.bytes >= o.maxTotalBytes * o.alertShare || usage.rows >= o.maxRows * o.alertShare) {
        alert('half', `the Global cloud is over ${Math.round(o.alertShare * 100)}% full (${mb(usage.bytes)} MB in ${usage.rows} copies, ceiling ${mb(o.maxTotalBytes)} MB / ${o.maxRows})`)
      }
    }
  }

  // ---- SEC-30: wrong PINs ----
  // keyHash -> { nets: Map(network -> { n: wrong PINs since its last right
  // one, at }), proven: Map(network -> at of its last right PIN), full: when
  // a guesser found nets full (0: never), lockedUntil: the row's lock as last
  // seen (ms) }. Each entry counts a day at most. In Map order, least recently
  // used first; `entries` counts the networks held in all (GCS-R3).
  const guessers = new Map()
  const perKey = o.pinNetworksPerKey ?? PIN_NETWORKS_PER_KEY
  const maxEntries = o.pinMemoryEntries ?? PIN_MEMORY_ENTRIES
  let entries = 0
  const fresh = (at) => at > 0 && ms() - at < PIN_FAILURE_FORGET_MS
  const sizeOf = (e) => e.nets.size + e.proven.size
  function dropKey(kh) {
    const e = guessers.get(kh)
    if (!e) return
    entries -= sizeOf(e)
    guessers.delete(kh)
  }
  /** Room for n more networks: the least recently used unlocked copy goes first, a locked one only when none is near. */
  function makeRoom(n, keep) {
    while (entries + n > maxEntries && guessers.size) {
      let victim = null
      let seen = 0
      for (const [kh, e] of guessers) {
        if (kh === keep) continue
        victim ??= kh
        if (!(e.lockedUntil > ms())) { victim = kh; break }
        if (++seen >= 256) break
      }
      if (victim === null) return
      dropKey(victim)
    }
  }
  /** The entry of a copy (made when `create`), now the most recently used. */
  function entryOf(kh, create) {
    let e = guessers.get(kh)
    if (e) {
      guessers.delete(kh)
      guessers.set(kh, e)
      return e
    }
    if (!create) return null
    e = { nets: new Map(), proven: new Map(), full: 0, lockedUntil: 0 }
    guessers.set(kh, e)
    return e
  }
  function forgetOld(e) {
    for (const [net, g] of e.nets) if (!fresh(g.at)) { e.nets.delete(net); entries-- }
    for (const [net, at] of e.proven) if (!fresh(at)) { e.proven.delete(net); entries-- }
  }
  function guessedBy(kh, net) {
    const e = guessers.get(kh)?.nets.get(net)
    return e && fresh(e.at) ? e.n : 0
  }
  /** Is the network held off while the copy is locked: it guessed, or the copy's list is full and it never gave the right PIN. */
  function heldOff(kh, net) {
    if (guessedBy(kh, net) > 0) return true
    const e = guessers.get(kh)
    return !!e && fresh(e.full) && !fresh(e.proven.get(net) ?? 0)
  }
  function noteGuess(kh, net) {
    const e = entryOf(kh, true)
    const g = e.nets.get(net)
    if (g) {
      e.nets.set(net, { n: (fresh(g.at) ? g.n : 0) + 1, at: ms() })
      return
    }
    if (e.nets.size >= perKey) forgetOld(e)
    // a full list is never shortened by a new network (an evicted guesser
    // was a fresh one again: 65 networks in turn were never held off)
    if (e.nets.size >= perKey) { e.full = ms(); return }
    makeRoom(1, kh)
    e.nets.set(net, { n: 1, at: ms() })
    entries++
  }
  /** The right PIN from net: not a guesser any more, and one of the networks let through a full list's lock. */
  function noteRight(kh, net) {
    const e = entryOf(kh, true)
    if (e.nets.delete(net)) entries--
    if (e.proven.has(net)) e.proven.delete(net)
    else {
      if (e.proven.size >= PIN_PROVEN_PER_KEY) { e.proven.delete(e.proven.keys().next().value); entries-- }
      makeRoom(1, kh)
      entries++
    }
    e.proven.set(net, ms())
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
    const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : 0
    const lockedMs = lockedUntil ? lockedUntil - ms() : 0
    const known = guessers.get(kh)
    if (known) known.lockedUntil = lockedUntil
    if (lockedMs > 0 && heldOff(kh, net)) {
      return { ...fail(429, 'OV_GLOBAL_PIN_LOCKED', 'Too many wrong PINs, try again later'), retryAfter: Math.ceil(lockedMs / 1000) }
    }
    if (sameHash(row.pin_hash, pinHash(key, pin))) {
      noteRight(kh, net)
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
      const e = guessers.get(kh)
      if (e) e.lockedUntil = Math.max(e.lockedUntil, ms() + lockMs)
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
    const admitted = await admit({ isNew, newBytes, oldBytes, ip })
    if (admitted.status) return admitted
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
    // the first save set the PIN: its network gave the right one (GCS-R3)
    if (isNew) noteRight(kh, guesserNetwork(ip))
    await charged({ kh, isNew, newBytes, oldBytes, ip, headroom: admitted.headroom, pdfWritten: !keepPdf && !!pdfBuf })
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
    const r = await own(key, pin, `id, ${STORED_SQL} AS bytes`, ip)
    if (r.answer) return r.answer
    const { rowCount } = await q('DELETE FROM public.global_matches WHERE id = $1', [r.row.id])
    forgetCopy(keyHash(key))
    // kept up to date (a recount after every delete would let delete and save loops scan the table)
    if (rowCount && usage) {
      usage.rows = Math.max(0, usage.rows - 1)
      usage.bytes = Math.max(0, usage.bytes - (Number(r.row.bytes) || 0))
    }
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
    // copies whose last save is past the retention are gone now
    for (const [kh, c] of created) if (now().getTime() - c.last > RETENTION_DAYS * DAY_MS) forgetCopy(kh)
    return rowCount || 0
  }

  // at most hourly, after a save; failures only logged
  function maybeSweep() {
    if (now().getTime() - lastSweep < 60 * 60 * 1000) return
    sweepExpired().catch((err) => logger.warn?.('[Global cloud] sweep failed:', String(err?.code || err?.message || err).slice(0, 120)))
  }

  /** What the PIN memory holds (tests): copies and networks. */
  const pinMemory = () => ({ keys: guessers.size, entries })

  /** What the networks created since the start hold (tests). */
  const createdBy = (ip) => { const h = holdings.get(creatorNetwork(ip)); return h ? { rows: h.rows, bytes: h.bytes } : { rows: 0, bytes: 0 } }

  return { save, load, setShare, del, shared, sharedPdf, organizerList, organizerPdf, sweepExpired, usage: currentUsage, budget, writes, wal: walState, createdBy, pinMemory }
}
