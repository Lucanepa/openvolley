/**
 * lib/auth.js — self-hosted replacement for Supabase GoTrue behind /api/auth/*.
 *
 * Users live in auth.users (Supabase UUIDs and bcrypt `encrypted_password`
 * carried over unchanged, so old passwords keep working). Sessions are opaque
 * random tokens; only their SHA-256 is stored, in auth.app_sessions
 * (db/002_app_sessions.sql). 30-day sliding expiry, 90-day absolute cap,
 * revoked on sign-out, password change and account deletion.
 *
 * Nothing here runs at import time: no DB access, no timers. server.js creates
 * one instance with createAuth({ pool }) once DATABASE_URL is known, and calls
 * auth.sweep() / auth.sweepExpiredSessions() from its own intervals.
 *
 * Schema-specific details are not hard-coded: table names come from options,
 * and the column sets of the users and profiles tables are read from
 * information_schema on first use (optional columns are used only if present).
 *
 * Public API (see README "Auth module" for wiring):
 *   createAuth(options) -> auth
 *     auth.handleAuthRequest(action, body, { ip, headers }) -> { status, headers, body }
 *     auth.verifyToken(req)            -> user | null   (throws on DB failure)
 *     auth.verifyAccessToken(token)    -> { user, session } | null (throws on DB failure)
 *     auth.requireUser(req, res)       -> user | null   (writes 401/503 itself)
 *     auth.setPassword(emailOrId, pw)  -> { userId, email, revokedSessions }
 *     auth.findUserId(emailOrId)       -> { id, email } (throws if not exactly one)
 *     auth.revokeUserSessions(userId)  -> number
 *     auth.sweepExpiredSessions()      -> number
 *     auth.sweepExpiredTokens()        -> number   (one-time email links, db/010)
 *     auth.settle()                    -> resolves when the background mail jobs are done (tests)
 *     auth.sweep()                     -> clears stale in-memory counters
 *     auth.limits / auth.lockout       -> the counters (inspect, reset, replace)
 *     auth.bcryptGate                  -> { active, queued, peak } of the bcrypt limiter
 *   sendAuthResult(res, result), createRateLimiter(opts), createLockout(opts),
 *   createConcurrencyGate(opts), ipBucketKey(ip), hashToken(token),
 *   generateToken(), isWellFormedToken(token), AUTH_ACTIONS
 *
 * Email links (db/010_auth_tokens.sql, lib/mailer.js; README "Account emails"):
 * with a mailer (SMTP configured) reset-password mails a one-time link
 * (60 min) and reset-password/confirm sets the new password; sign-up leaves
 * the address unconfirmed and mails a confirmation link (24 h) that
 * confirm-email redeems; resend-confirmation sends a fresh one. Without a
 * mailer reset-password answers 503 "temporarily unavailable" and sign-up
 * confirms the account at once, as before. Tokens are stored as SHA-256 only.
 *
 * Unconfirmed sign-in: requireConfirmedEmail refuses accounts whose
 * email_confirmed_at is NULL (GoTrue did too), EXCEPT accounts this server
 * created with a confirmation link (raw_app_meta_data.ov_email_confirmation =
 * 'link'). Those may sign in while unconfirmed, but get no role until the
 * address is confirmed: lib/accounts.js refuses redeem-invite and an admin's
 * role grant for them (409 OV_EMAIL_UNCONFIRMED), so a pending account cannot
 * become a scorer, referee or competition manager under an address it never
 * proved. The profile and the admin Accounts list show the address as
 * unconfirmed, and whoever owns the mailbox can take the account over with a
 * reset link at any time.
 *
 * Sign-up still answers 422 user_already_exists for a registered address (as
 * before): an unconfirmed account may sign in at once, so a uniform sign-up
 * answer would not hide whether an address is registered (sign up, then sign
 * in). reset-password alone gives nothing away.
 *
 * CPU guard: bcryptjs is pure JS and runs on the main event loop, which also
 * serves the live-scoring relay. Every bcrypt call goes through a small
 * concurrency gate (bcryptMaxConcurrent, bcryptMaxQueue); when the queue is
 * full the request gets 503 "auth_busy" at once instead of queueing. Sign-in
 * also has a global bucket (limits.signInGlobal) next to the per-IP one, and
 * per-IP buckets key IPv6 clients on their /64 (ipBucketKey).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'
import bcryptjs from 'bcryptjs'
import { authLink, describeMailError, disabledMailer, inboxKey, maskEmail, pickLang } from './mailer.js'

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60

export const AUTH_ACTIONS = Object.freeze([
  'sign-in', 'sign-up', 'sign-out', 'get-user', 'update-user',
  'delete-account', 'profile', 'reset-password', 'reset-password/confirm',
  'confirm-email', 'resend-confirmation'
])

// raw_app_meta_data marker of accounts created unconfirmed with a link.
export const EMAIL_CONFIRMATION_MARK = Object.freeze({ key: 'ov_email_confirmation', value: 'link' })

const DEFAULTS = Object.freeze({
  usersTable: 'auth.users',
  sessionsTable: 'auth.app_sessions',
  // One-time email links (db/010). Absent table: reset answers 503 and
  // sign-up confirms at once, as without a mailer.
  tokensTable: 'auth.app_tokens',
  // Best-effort audit entries (db/007) when the table exists.
  auditTable: 'public.audit_log',
  // lib/mailer.js mailer; null/disabled: no account emails (see header).
  mailer: null,
  resetTokenTtlSec: 60 * 60,
  confirmTokenTtlSec: 24 * 60 * 60,
  // Used or expired link rows are deleted this long after (sweepExpiredTokens).
  tokenRetentionSec: 7 * DAY,
  profilesTable: 'public.profiles',
  profileUserIdColumn: 'user_id',
  // Tables whose rows belong to a user and go with the account. Deleted
  // explicitly (in addition to any ON DELETE CASCADE) when they exist.
  ownedTables: [
    { table: 'public.profiles', column: 'user_id' },
    { table: 'public.user_matches', column: 'user_id' },
    { table: 'public.match_editors', column: 'user_id' }
  ],
  // Rows that stay when the account goes (club records: the matches it scored,
  // beach competition matches) but forget who it was: the column is set NULL
  // explicitly (in addition to the ON DELETE SET NULL foreign keys) when the
  // table and column exist. README "Deleting an account".
  detachedColumns: [
    { table: 'public.matches', column: 'created_by' },
    { table: 'public.beach_competition_matches', column: 'created_by' },
    { table: 'public.beach_competition_matches', column: 'claimed_by' }
  ],
  // async (userId) => counts: removes the account's files (server.js passes
  // lib/storage.js deleteUserData: backup/<user>/ and scoresheet owner
  // entries). Runs before the database rows go (a failure answers 503 and
  // deletes no row, so the user can retry) and once more after the commit
  // (an upload that was in flight). null: no files to remove.
  onAccountDeleted: null,
  // Mirrors handle_new_user() from frontend/src/db/migrations/001_auth_profiles.sql.
  // `roles` is never taken from the client: it always gets defaultRoles.
  // New accounts get no role: they are pending until an admin approves them
  // or they redeem an invite code (db/007, lib/accounts.js). Until then they
  // score test matches only.
  defaultRoles: [],
  defaultCountry: 'CHE',
  // Extra metadata keys copied verbatim into same-named profile columns when
  // that column exists (the live profiles table has sport_type, 001 did not).
  extraProfileFields: ['sport_type'],
  // Metadata keys a client may never set.
  strippedMetadataKeys: ['roles', 'role'],
  maxMetadataBytes: 4096,

  sessionTtlSec: 30 * DAY,
  slideThresholdSec: 15 * DAY,
  absoluteTtlSec: 90 * DAY,
  touchIntervalSec: 5 * 60, // write last_seen_at at most this often per session

  minPasswordLength: 6,
  bcryptCost: 10,
  maxBcryptCost: 15, // stored hashes above this are treated as invalid (DoS guard)
  // At most this many bcrypt operations run (interleaved) at once; up to
  // bcryptMaxQueue more wait, anything beyond gets 503 auth_busy.
  bcryptMaxConcurrent: 2,
  bcryptMaxQueue: 16,

  // Refuse sign-in for users whose email_confirmed_at is NULL (when the column
  // exists): GoTrue refused them too, and an unconfirmed row may belong to
  // someone who registered another person's address. Accounts this server
  // created with a confirmation link are exempt (see the header).
  requireConfirmedEmail: true,

  // Default: process.env.CONTACT_EMAIL, then the same fallback as server.js.
  contactEmail: null,

  // Maps a client IP to its per-IP bucket key (IPv6 -> /64). Replaceable.
  ipKey: null,

  limits: {
    signInIp: { max: 60, windowMs: 60 * 1000 },
    signInEmail: { max: 10, windowMs: 15 * 60 * 1000 },
    // All sign-ins together, whatever their source. A cost-10 compare is
    // ~60-150 ms of main-thread CPU; 5/s keeps bcrypt well under one core.
    signInGlobal: { max: 5, windowMs: 1000 },
    signUpIp: { max: 5, windowMs: 60 * 60 * 1000 },
    // Per delivered inbox (inboxKey: plus-tags removed, Gmail dots ignored,
    // so one mailbox cannot be probed or flooded from many IPs), and
    // all sign-ups together, so a spread-out burst cannot mass-create
    // accounts. The global budget counts created accounts only: requests for
    // existing addresses (or that fail) are refunded, so nobody can use it up
    // without creating that many accounts; it is set well above a tournament
    // morning's sign-ups.
    signUpEmail: { max: 3, windowMs: 60 * 60 * 1000 },
    signUpGlobal: { max: 300, windowMs: 60 * 60 * 1000 },
    sessionIp: { max: 300, windowMs: 60 * 1000 },
    // Reset links: per client and per delivered inbox (inboxKey: plus-tags
    // removed, Gmail dots ignored), whether or not the account exists (so
    // the answer never tells).
    resetIp: { max: 10, windowMs: 60 * 60 * 1000 },
    resetEmail: { max: 3, windowMs: 60 * 60 * 1000 },
    // Redeeming links (reset-password/confirm, confirm-email), per client.
    tokenIp: { max: 30, windowMs: 15 * 60 * 1000 },
    // resend-confirmation: per account and per client.
    resendUser: { max: 3, windowMs: 60 * 60 * 1000 },
    resendIp: { max: 10, windowMs: 60 * 60 * 1000 }
  },
  lockout: { maxFailures: 10, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 }
})

const TOKEN_BYTES = 32
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/ // base64url of 32 bytes, no padding
const BCRYPT_RE = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 32 random bytes, base64url (43 chars). Returned to the client once, never stored. */
export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** SHA-256 of the token as a Buffer (bytea). This is all the database ever sees. */
export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest()
}

/** Cheap shape check so old Supabase JWTs and junk never reach the database. */
export function isWellFormedToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token)
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

function splitQualified(qualified) {
  const parts = String(qualified).split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`auth: table name must be schema-qualified, got "${qualified}"`)
  }
  return parts
}

function qualify(qualified) {
  return splitQualified(qualified).map(quoteIdent).join('.')
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

/** Bearer token from an Authorization header, or null (pure; used by server.js logs). */
export function bearerFromHeaders(headers) {
  const h = headers?.authorization || headers?.Authorization
  if (typeof h !== 'string') return null
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim())
  return m ? m[1] : null
}

function utf8Length(s) {
  return Buffer.byteLength(s, 'utf8')
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Eight 16-bit groups of a valid IPv6 address (validated by the caller). */
function ipv6Groups(addr) {
  let s = addr
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) { // embedded IPv4, e.g. ::ffff:1.2.3.4
    const [a, b, c, d] = tail.split('.').map(Number)
    s = s.slice(0, lastColon + 1) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const parse = (part) => (part ? part.split(':') : []).map(h => parseInt(h, 16))
  const dbl = s.indexOf('::')
  if (dbl < 0) return parse(s)
  const head = parse(s.slice(0, dbl))
  const rest = parse(s.slice(dbl + 2))
  return [...head, ...new Array(8 - head.length - rest.length).fill(0), ...rest]
}

/**
 * Per-IP bucket key: IPv4 as is, IPv4-mapped IPv6 as the IPv4 address, any
 * other IPv6 address as its /64 prefix. One subscriber usually holds a whole
 * /64, so keying on the full address would let a single client rotate through
 * 2^64 buckets.
 */
export function ipBucketKey(ip) {
  if (typeof ip !== 'string') return 'unknown'
  let s = ip.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (isIPv4(s)) return s
  if (!isIPv6(s)) return s || 'unknown'
  const g = ipv6Groups(s)
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.')
  }
  return g.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64'
}

// ---------------------------------------------------------------------------
// Counters (exported so server.js can size buckets or plug in its own)
// ---------------------------------------------------------------------------

/**
 * Fixed-window counter. hit(key) counts one request and says whether the key
 * is over its budget. No timers: call sweep() from an existing interval.
 */
export function createRateLimiter({ max, windowMs, now = Date.now } = {}) {
  if (!(max > 0) || !(windowMs > 0)) throw new Error('createRateLimiter: max and windowMs are required')
  const entries = new Map()
  return {
    max,
    windowMs,
    hit(key) {
      const t = now()
      let e = entries.get(key)
      if (!e || t - e.windowStart >= windowMs) {
        e = { count: 0, windowStart: t }
        entries.set(key, e)
      }
      e.count++
      const limited = e.count > max
      return {
        limited,
        remaining: Math.max(0, max - e.count),
        retryAfterSec: limited ? Math.max(1, Math.ceil((e.windowStart + windowMs - t) / 1000)) : 0
      }
    },
    /** Take one request back (it turned out not to use the budget). */
    refund(key) {
      const e = entries.get(key)
      if (e && e.count > 0) e.count--
    },
    reset(key) { entries.delete(key) },
    clear() { entries.clear() },
    sweep() {
      const t = now()
      for (const [k, e] of entries) if (t - e.windowStart >= windowMs) entries.delete(k)
    },
    get size() { return entries.size }
  }
}

/**
 * Limits how many async jobs run at once. run(fn) starts fn when a slot is
 * free, waits in a FIFO queue of at most maxQueue otherwise, and rejects at
 * once with err.code === 'AUTH_BUSY' when the queue is full.
 */
export function createConcurrencyGate({ maxConcurrent, maxQueue = 0 } = {}) {
  if (!(maxConcurrent > 0) || !(maxQueue >= 0)) {
    throw new Error('createConcurrencyGate: maxConcurrent (> 0) and maxQueue (>= 0) are required')
  }
  let active = 0
  let peak = 0
  const waiting = []
  const release = () => {
    const next = waiting.shift()
    if (next) next() // the slot passes straight to the next job
    else active--
  }
  return {
    maxConcurrent,
    maxQueue,
    async run(fn) {
      if (active < maxConcurrent) {
        active++
      } else if (waiting.length < maxQueue) {
        await new Promise(resolve => waiting.push(resolve))
      } else {
        throw Object.assign(new Error('auth: bcrypt queue is full'), { code: 'AUTH_BUSY' })
      }
      if (active > peak) peak = active
      try {
        return await fn()
      } finally {
        release()
      }
    },
    get active() { return active },
    get queued() { return waiting.length },
    get peak() { return peak },
    resetPeak() { peak = active }
  }
}

/**
 * Per-account lockout: maxFailures failed attempts within windowMs lock the key
 * for lockMs. Keyed by normalized email, so unknown emails lock exactly like
 * real ones and the lockout cannot be used to probe for accounts.
 *
 * begin(key) also counts attempts that are still being checked: failures plus
 * in-flight attempts may never exceed maxFailures, so parallel requests cannot
 * all pass the check before the first failure is recorded. Call fail() or
 * succeed() with the outcome, then release() on the returned ticket.
 */
export function createLockout({ maxFailures, windowMs, lockMs, now = Date.now } = {}) {
  if (!(maxFailures > 0) || !(windowMs > 0) || !(lockMs > 0)) {
    throw new Error('createLockout: maxFailures, windowMs and lockMs are required')
  }
  const entries = new Map()
  const inFlight = new Map()
  const NOOP_RELEASE = () => {}
  const current = (key, t) => {
    const e = entries.get(key)
    if (!e) return null
    if (e.lockedUntil && t >= e.lockedUntil) { entries.delete(key); return null }
    if (!e.lockedUntil && t - e.firstFailure >= windowMs) { entries.delete(key); return null }
    return e
  }
  const api = {
    maxFailures,
    windowMs,
    lockMs,
    check(key) {
      const t = now()
      const e = current(key, t)
      if (e?.lockedUntil) return { locked: true, retryAfterSec: Math.max(1, Math.ceil((e.lockedUntil - t) / 1000)) }
      return { locked: false, retryAfterSec: 0, failures: e?.failures || 0, inFlight: inFlight.get(key) || 0 }
    },
    begin(key) {
      const c = api.check(key)
      if (c.locked) return { ...c, release: NOOP_RELEASE }
      if (c.failures + c.inFlight >= maxFailures) {
        // Enough attempts are already being checked to reach the lock.
        return { locked: true, retryAfterSec: 5, release: NOOP_RELEASE }
      }
      inFlight.set(key, c.inFlight + 1)
      let released = false
      return {
        ...c,
        release() {
          if (released) return
          released = true
          const n = (inFlight.get(key) || 1) - 1
          if (n > 0) inFlight.set(key, n)
          else inFlight.delete(key)
        }
      }
    },
    fail(key) {
      const t = now()
      let e = current(key, t)
      if (!e) { e = { failures: 0, firstFailure: t, lockedUntil: 0 }; entries.set(key, e) }
      e.failures++
      if (e.failures >= maxFailures && !e.lockedUntil) e.lockedUntil = t + lockMs
      return { locked: !!e.lockedUntil, failures: e.failures }
    },
    succeed(key) { entries.delete(key) },
    reset(key) { entries.delete(key) },
    clear() { entries.clear() },
    sweep() {
      const t = now()
      for (const k of [...entries.keys()]) current(k, t)
    },
    get size() { return entries.size }
  }
  return api
}

function resolveLimiter(spec) {
  if (!spec) return null // false/null disables the bucket (server.js handles it)
  if (typeof spec.hit === 'function') return spec
  return createRateLimiter(spec)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function result(status, body, headers) {
  return { status, body, headers: headers || {} }
}

function ok(data) {
  return result(200, { data, error: null })
}

function fail(status, message, code, headers) {
  return result(status, { data: null, error: code ? { message, code } : { message } }, headers)
}

function rateLimited(retryAfterSec, code = 'rate_limited', message = 'Too many requests. Please try again later.') {
  return fail(429, message, code, { 'Retry-After': String(retryAfterSec || 60) })
}

const INVALID_TOKEN = () => fail(401, 'Invalid or expired session. Please sign in again.', 'invalid_token')
const MISSING_TOKEN = () => fail(401, 'Authentication required', 'missing_token')
const UNAVAILABLE = () => fail(503, 'Authentication service unavailable. Please try again.', 'auth_unavailable', { 'Retry-After': '5' })
const BUSY = () => fail(503, 'Sign-in is busy right now. Please try again in a few seconds.', 'auth_busy', { 'Retry-After': '2' })
const INVALID_CREDENTIALS = () => fail(400, 'Invalid login credentials', 'invalid_credentials')
const INVALID_LINK = () => fail(400, 'This link is invalid, was already used or has expired. Please request a new one.', 'invalid_link')

/** Writes a result from handleAuthRequest (or any auth helper) to a node:http response. */
export function sendAuthResult(res, r) {
  res.writeHead(r.status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(r.headers || {})
  })
  res.end(JSON.stringify(r.body))
}

// ---------------------------------------------------------------------------
// createAuth
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {import('pg').Pool} options.pool  anything with query() and connect()
 * @param {object} [options.bcrypt]  { compare, hash } (defaults to bcryptjs async API)
 * @param {object} [options.logger]  console-like
 * Everything else: see DEFAULTS above.
 */
export function createAuth(options = {}) {
  const { pool } = options
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new Error('createAuth: options.pool (pg.Pool) is required')
  }
  const cfg = {
    ...DEFAULTS,
    ...options,
    limits: { ...DEFAULTS.limits, ...(options.limits || {}) },
    lockout: options.lockout && typeof options.lockout.check === 'function'
      ? options.lockout
      : { ...DEFAULTS.lockout, ...(options.lockout || {}) }
  }
  if (cfg.sessionTtlSec > cfg.absoluteTtlSec) throw new Error('createAuth: sessionTtlSec exceeds absoluteTtlSec')
  cfg.contactEmail = cfg.contactEmail || process.env.CONTACT_EMAIL || 'support@openvolley.app'
  const ipKey = typeof cfg.ipKey === 'function' ? cfg.ipKey : ipBucketKey
  const rawBcrypt = options.bcrypt || { compare: bcryptjs.compare, hash: bcryptjs.hash }
  const bcryptGate = createConcurrencyGate({ maxConcurrent: cfg.bcryptMaxConcurrent, maxQueue: cfg.bcryptMaxQueue })
  const bcrypt = {
    compare: (password, hash) => bcryptGate.run(() => rawBcrypt.compare(password, hash)),
    hash: (password, cost) => bcryptGate.run(() => rawBcrypt.hash(password, cost))
  }
  const log = options.logger || console
  const mailer = cfg.mailer && typeof cfg.mailer.send === 'function' ? cfg.mailer : disabledMailer()

  const T = {
    users: qualify(cfg.usersTable),
    sessions: qualify(cfg.sessionsTable),
    profiles: cfg.profilesTable ? qualify(cfg.profilesTable) : null,
    tokens: cfg.tokensTable ? qualify(cfg.tokensTable) : null,
    audit: cfg.auditTable ? qualify(cfg.auditTable) : null
  }

  const limits = {
    signInIp: resolveLimiter(cfg.limits.signInIp),
    signInEmail: resolveLimiter(cfg.limits.signInEmail),
    signInGlobal: resolveLimiter(cfg.limits.signInGlobal),
    signUpIp: resolveLimiter(cfg.limits.signUpIp),
    signUpEmail: resolveLimiter(cfg.limits.signUpEmail),
    signUpGlobal: resolveLimiter(cfg.limits.signUpGlobal),
    sessionIp: resolveLimiter(cfg.limits.sessionIp),
    resetIp: resolveLimiter(cfg.limits.resetIp),
    resetEmail: resolveLimiter(cfg.limits.resetEmail),
    tokenIp: resolveLimiter(cfg.limits.tokenIp),
    resendUser: resolveLimiter(cfg.limits.resendUser),
    resendIp: resolveLimiter(cfg.limits.resendIp)
  }
  const lockout = typeof cfg.lockout.check === 'function' ? cfg.lockout : createLockout(cfg.lockout)

  // --- catalog (lazy, cached only once a table is found) --------------------
  const catalog = new Map()
  async function columnsOf(qualified, client = pool) {
    if (catalog.has(qualified)) return catalog.get(qualified)
    const [schema, table] = splitQualified(qualified)
    const { rows } = await client.query(
      `SELECT column_name, data_type, udt_name, is_generated, is_identity
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2`,
      [schema, table]
    )
    const cols = new Map(rows.map(r => [r.column_name, r]))
    if (cols.size) catalog.set(qualified, cols)
    return cols
  }
  async function usersColumns(client) {
    const cols = await columnsOf(cfg.usersTable, client)
    for (const c of ['id', 'email', 'encrypted_password']) {
      if (!cols.has(c)) throw new Error(`auth: ${cfg.usersTable} has no column "${c}"`)
    }
    return cols
  }
  // Generated/identity columns can never be written.
  const writable = (cols, name) => {
    const c = cols.get(name)
    return !!c && c.is_generated !== 'ALWAYS' && c.is_identity !== 'YES'
  }

  // --- password hashing --------------------------------------------------------
  let dummyHashPromise = null
  const dummyHash = () => {
    if (!dummyHashPromise) {
      dummyHashPromise = bcrypt.hash(randomBytes(18).toString('base64'), cfg.bcryptCost)
      dummyHashPromise.catch(() => { dummyHashPromise = null })
    }
    return dummyHashPromise
  }

  /**
   * The stored hash if it is a well-formed $2a$/$2b$/$2y$ bcrypt hash with a
   * sane cost, else null. (bcryptjs answers malformed hashes instantly, which
   * would be a timing tell, so those go to the dummy hash instead.)
   */
  function usableHash(stored) {
    if (typeof stored !== 'string') return null
    const m = BCRYPT_RE.exec(stored)
    if (!m) return null
    const cost = Number(m[1])
    if (cost < 4 || cost > cfg.maxBcryptCost) return null
    return stored
  }

  /**
   * Always runs exactly one bcrypt comparison, against the real hash when it is
   * usable and against a same-cost dummy hash otherwise (unknown email, user
   * without password, malformed hash), so response time does not tell them apart.
   */
  async function checkPassword(password, storedHash) {
    const real = usableHash(storedHash)
    const target = real || await dummyHash()
    let match = false
    try {
      match = await bcrypt.compare(password, target)
    } catch (err) {
      if (err?.code === 'AUTH_BUSY') throw err // overload, not a wrong password
      match = false
    }
    return !!real && match === true
  }

  function validateNewPassword(password) {
    if (typeof password !== 'string' || password.length < cfg.minPasswordLength) {
      return `Password should be at least ${cfg.minPasswordLength} characters.`
    }
    if (utf8Length(password) > 72) return 'Password cannot be longer than 72 bytes.'
    return null
  }

  function hashPassword(password) {
    return bcrypt.hash(password, cfg.bcryptCost)
  }

  // --- users -------------------------------------------------------------------
  function isUserBlocked(u) {
    if (!u) return true
    if (u.deleted_at) return true
    if (u.banned_until && new Date(u.banned_until).getTime() > Date.now()) return true
    return false
  }

  /** Created by this server unconfirmed, with a confirmation link (may sign in). */
  function confirmsByLink(u) {
    const m = u?.raw_app_meta_data
    return isPlainObject(m) && m[EMAIL_CONFIRMATION_MARK.key] === EMAIL_CONFIRMATION_MARK.value
  }

  /**
   * True when sign-in must be refused because the address was never
   * confirmed: the users table tracks confirmation, this user never confirmed,
   * and the account is not one this server created with a confirmation link.
   */
  function isUnconfirmed(u, cols) {
    return cfg.requireConfirmedEmail && cols.has('email_confirmed_at') && u?.email_confirmed_at == null && !confirmsByLink(u)
  }

  function stripMetadata(meta) {
    const out = isPlainObject(meta) ? { ...meta } : {}
    for (const k of cfg.strippedMetadataKeys) delete out[k]
    return out
  }

  /** Supabase-shaped user object. Never includes the password hash. */
  function publicUser(u) {
    return {
      id: u.id,
      aud: u.aud || 'authenticated',
      role: u.role || 'authenticated',
      email: u.email,
      email_confirmed_at: u.email_confirmed_at ?? null,
      last_sign_in_at: u.last_sign_in_at ?? null,
      created_at: u.created_at ?? null,
      updated_at: u.updated_at ?? null,
      app_metadata: isPlainObject(u.raw_app_meta_data) && Object.keys(u.raw_app_meta_data).length
        ? u.raw_app_meta_data
        : { provider: 'email', providers: ['email'] },
      user_metadata: stripMetadata(u.raw_user_meta_data)
    }
  }

  async function findUserByEmail(email, client = pool) {
    await usersColumns(client)
    const { rows } = await client.query(
      `SELECT to_jsonb(u) AS u FROM ${T.users} u WHERE lower(u.email) = $1 LIMIT 2`,
      [email]
    )
    if (rows.length > 1) {
      log.error('[auth] more than one user for one lower-cased email; refusing sign-in')
      return null
    }
    return rows[0]?.u || null
  }

  // --- sessions --------------------------------------------------------------
  /**
   * Creates a session only if the user still has the password hash that was
   * just verified. FOR SHARE makes this wait for a concurrent setPassword()
   * transaction and then re-check the new row, so a sign-in that passed bcrypt
   * with the old password cannot leave a session behind after "set password
   * and revoke all sessions" (or account deletion) has run. Returns null when
   * the hash changed or the user is gone.
   */
  async function createSession(userId, verifiedHash, client = pool) {
    const token = generateToken()
    const { rows } = await client.query(
      `INSERT INTO ${T.sessions} (token_hash, user_id, created_at, expires_at, last_seen_at)
       SELECT $1, u.id, now(), now() + make_interval(secs => $3), now()
         FROM ${T.users} u
        WHERE u.id = $2 AND u.encrypted_password = $4
          FOR SHARE OF u
       RETURNING floor(extract(epoch FROM expires_at))::bigint AS expires_at`,
      [hashToken(token), userId, Math.min(cfg.sessionTtlSec, cfg.absoluteTtlSec), verifiedHash]
    )
    if (!rows[0]) return null
    const expiresAt = Number(rows[0].expires_at)
    return { token, expiresAt }
  }

  /**
   * Looks a token up, enforces expiry and the absolute cap, and slides the
   * expiry forward when less than slideThresholdSec is left.
   * Returns { user, session:{ expires_at, expires_in } } or null. Throws on DB errors.
   */
  async function verifyAccessToken(token) {
    if (!isWellFormedToken(token)) return null
    await usersColumns()
    const tokenHash = hashToken(token)
    const { rows } = await pool.query(
      `SELECT to_jsonb(u) AS u,
              (s.expires_at > now() AND s.created_at + make_interval(secs => $2) > now()) AS valid,
              (s.expires_at < now() + make_interval(secs => $3)) AS needs_slide,
              (s.last_seen_at IS NULL OR s.last_seen_at < now() - make_interval(secs => $4)) AS needs_touch,
              floor(extract(epoch FROM s.expires_at))::bigint AS expires_at,
              floor(extract(epoch FROM now()))::bigint AS now
         FROM ${T.sessions} s
         JOIN ${T.users} u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [tokenHash, cfg.absoluteTtlSec, cfg.slideThresholdSec, cfg.touchIntervalSec]
    )
    const row = rows[0]
    if (!row) return null
    if (!row.valid || isUserBlocked(row.u)) {
      await pool.query(`DELETE FROM ${T.sessions} WHERE token_hash = $1`, [tokenHash])
      return null
    }
    let expiresAt = Number(row.expires_at)
    let now = Number(row.now)
    if (row.needs_slide || row.needs_touch) {
      const upd = await pool.query(
        `UPDATE ${T.sessions}
            SET last_seen_at = now(),
                expires_at = CASE WHEN expires_at < now() + make_interval(secs => $3)
                                  THEN least(now() + make_interval(secs => $2),
                                             created_at + make_interval(secs => $4))
                                  ELSE expires_at END
          WHERE token_hash = $1
          RETURNING floor(extract(epoch FROM expires_at))::bigint AS expires_at,
                    floor(extract(epoch FROM now()))::bigint AS now`,
        [tokenHash, cfg.sessionTtlSec, cfg.slideThresholdSec, cfg.absoluteTtlSec]
      )
      if (!upd.rows[0]) return null // revoked concurrently
      expiresAt = Number(upd.rows[0].expires_at)
      now = Number(upd.rows[0].now)
    }
    return {
      user: publicUser(row.u),
      session: { expires_at: expiresAt, expires_in: Math.max(0, expiresAt - now) }
    }
  }

  /** Bearer token from the Authorization header -> user or null. Throws on DB errors. */
  async function verifyToken(req) {
    const token = bearerFromHeaders(req?.headers)
    if (!token) return null
    const v = await verifyAccessToken(token)
    return v ? v.user : null
  }

  /**
   * For protected routes: returns the user, or writes 401 (missing/invalid
   * token, code "invalid_token" when a token was presented) or 503 (database
   * trouble, never 401 so clients keep their session) and returns null.
   */
  async function requireUser(req, res) {
    const token = bearerFromHeaders(req?.headers)
    if (!token) { sendAuthResult(res, MISSING_TOKEN()); return null }
    try {
      const v = await verifyAccessToken(token)
      if (!v) { sendAuthResult(res, INVALID_TOKEN()); return null }
      return v.user
    } catch (err) {
      log.error('[auth] verifyToken failed:', err.message)
      sendAuthResult(res, UNAVAILABLE())
      return null
    }
  }

  async function revokeSession(token) {
    if (!isWellFormedToken(token)) return 0
    const { rowCount } = await pool.query(`DELETE FROM ${T.sessions} WHERE token_hash = $1`, [hashToken(token)])
    return rowCount
  }

  async function revokeUserSessions(userId, client = pool) {
    const { rowCount } = await client.query(`DELETE FROM ${T.sessions} WHERE user_id = $1`, [userId])
    return rowCount
  }

  async function sweepExpiredSessions() {
    const { rowCount } = await pool.query(
      `DELETE FROM ${T.sessions}
        WHERE expires_at <= now() OR created_at + make_interval(secs => $1) <= now()`,
      [cfg.absoluteTtlSec]
    )
    return rowCount
  }

  async function withTransaction(fn) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* connection already broken */ }
      throw err
    } finally {
      client.release()
    }
  }

  /** Resolves an email (case-insensitive) or UUID to { id, email }. Throws if not exactly one. */
  async function findUserId(emailOrId, { client = pool, forUpdate = false } = {}) {
    await usersColumns(client)
    const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(emailOrId))
    const { rows } = await client.query(
      `SELECT id, lower(email) AS email FROM ${T.users}
        WHERE ${byId ? 'id = $1::uuid' : 'lower(email) = $1'}${forUpdate ? ' FOR UPDATE' : ''}`,
      [byId ? emailOrId : normalizeEmail(emailOrId)]
    )
    if (rows.length !== 1) throw new Error(rows.length ? 'More than one user matches' : 'User not found')
    return rows[0]
  }

  /**
   * Sets a user's password (identified by email or UUID) and revokes all of
   * their sessions, in one transaction. Used by scripts/set-password.mjs and,
   * later, by a password-change endpoint.
   */
  async function setPassword(emailOrId, newPassword, { skipPolicy = false, confirmEmail = false } = {}) {
    if (!skipPolicy) {
      const problem = validateNewPassword(newPassword)
      if (problem) throw new Error(problem)
    }
    const hash = await hashPassword(newPassword)
    const out = await withTransaction((client) => setPasswordIn(client, emailOrId, hash, { confirmEmail }))
    lockout.reset(out.email)
    return out
  }

  /**
   * The body of setPassword inside the caller's transaction: new hash, all
   * sessions revoked, every open reset link of the user spent (and its open
   * confirmation links when the address is confirmed now).
   */
  async function setPasswordIn(client, emailOrId, hash, { confirmEmail = false } = {}) {
    const cols = await usersColumns(client)
    const { id, email } = await findUserId(emailOrId, { client, forUpdate: true })
    const tracksConfirm = cols.has('email_confirmed_at')
    let set = 'encrypted_password = $2'
    if (writable(cols, 'updated_at')) set += ', updated_at = now()'
    if (confirmEmail && writable(cols, 'email_confirmed_at')) {
      set += ', email_confirmed_at = coalesce(email_confirmed_at, now())'
    }
    const upd = await client.query(
      `UPDATE ${T.users} SET ${set} WHERE id = $1
       RETURNING ${tracksConfirm ? 'email_confirmed_at IS NOT NULL' : 'true'} AS confirmed`,
      [id, hash]
    )
    const revokedSessions = await revokeUserSessions(id, client)
    const emailConfirmed = upd.rows[0].confirmed === true
    if (await tokensAvailable(client)) {
      await client.query(
        `UPDATE ${T.tokens} SET used_at = now()
          WHERE user_id = $1 AND used_at IS NULL AND (purpose = 'reset' OR ($2 AND purpose = 'confirm'))`,
        [id, emailConfirmed]
      )
    }
    return { userId: id, email, revokedSessions, emailConfirmed }
  }

  // --- one-time email links (db/010) -----------------------------------------
  async function tokensAvailable(client = pool) {
    if (!cfg.tokensTable) return false
    return (await columnsOf(cfg.tokensTable, client)).size > 0
  }

  /** New link token for userId; older open tokens of the same purpose are spent. */
  async function issueToken(client, userId, purpose) {
    const ttl = purpose === 'reset' ? cfg.resetTokenTtlSec : cfg.confirmTokenTtlSec
    const token = generateToken()
    await client.query(
      `UPDATE ${T.tokens} SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
      [userId, purpose]
    )
    await client.query(
      `INSERT INTO ${T.tokens} (hash, purpose, user_id, created_at, expires_at)
       VALUES ($1, $2, $3, now(), now() + make_interval(secs => $4))`,
      [hashToken(token), purpose, userId, ttl]
    )
    return token
  }

  /**
   * Locks the token row and marks it used when it is valid.
   * -> { state: 'ok' | 'used' | 'expired' | 'unknown', userId }
   */
  async function consumeToken(client, token, purpose) {
    const { rows } = await client.query(
      `SELECT user_id, used_at IS NOT NULL AS used, expires_at <= now() AS expired
         FROM ${T.tokens} WHERE hash = $1 AND purpose = $2 FOR UPDATE`,
      [hashToken(token), purpose]
    )
    const row = rows[0]
    if (!row) return { state: 'unknown', userId: null }
    if (row.used) return { state: 'used', userId: row.user_id }
    if (row.expired) return { state: 'expired', userId: row.user_id }
    await client.query(`UPDATE ${T.tokens} SET used_at = now() WHERE hash = $1`, [hashToken(token)])
    return { state: 'ok', userId: row.user_id }
  }

  async function sweepExpiredTokens() {
    if (!(await tokensAvailable())) return 0
    const { rowCount } = await pool.query(
      `DELETE FROM ${T.tokens} WHERE coalesce(used_at, expires_at) <= now() - make_interval(secs => $1)`,
      [cfg.tokenRetentionSec]
    )
    return rowCount
  }

  /** Best-effort audit entry (never fails the request). */
  async function audit(action, targetUserId, details = {}) {
    if (!T.audit) return
    try {
      if (!(await columnsOf(cfg.auditTable)).size) return
      await pool.query(
        `INSERT INTO ${T.audit} (actor_id, action, target_user_id, details) VALUES ($1, $2, $1, $3::jsonb)`,
        [targetUserId, action, JSON.stringify(details)]
      )
    } catch (err) {
      log.warn?.(`[auth] audit ${action} failed: ${err?.code || err?.message}`)
    }
  }

  // Mail jobs run after the answer went out (so its timing never depends on
  // whether the account exists); settle() waits for them (tests, shutdown).
  const pending = new Set()
  function background(what, fn) {
    const p = (async () => {
      // describeMailError: an SMTP reply quotes the recipient; log it masked.
      try { await fn() } catch (err) { log.error(`[auth] ${what} failed: ${describeMailError(err)}`) }
    })()
    pending.add(p)
    p.finally(() => pending.delete(p))
  }
  async function settle() {
    while (pending.size) await Promise.allSettled([...pending])
  }

  function mailLang(body, ctx) {
    return pickLang(body.lang, ctx.headers?.['accept-language'])
  }

  // --- action handlers ---------------------------------------------------------
  // The per-address sign-up and reset buckets count delivered inboxes:
  // name+tag@domain is name@domain, and n.a.m.e@googlemail.com is
  // name@gmail.com (lib/mailer.js inboxKey).
  const mailboxKey = inboxKey

  function limit(bucket, key) {
    const l = limits[bucket]
    if (!l) return null
    const r = l.hit(key)
    return r.limited ? rateLimited(r.retryAfterSec) : null
  }

  async function signIn(body, ctx) {
    const blocked = limit('signInIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const email = normalizeEmail(body.email)
    const password = body.password
    if (!email || typeof password !== 'string' || !password) {
      return fail(400, 'Missing email or password', 'validation_failed')
    }
    if (email.length > 254 || password.length > 1024) return INVALID_CREDENTIALS()

    // Counts this attempt as in flight before any await, so parallel requests
    // cannot all slip past the lockout before the first failure is recorded.
    const attempt = typeof lockout.begin === 'function' ? lockout.begin(email) : lockout.check(email)
    if (attempt.locked) {
      const mins = Math.max(1, Math.ceil(attempt.retryAfterSec / 60))
      return rateLimited(attempt.retryAfterSec, 'account_locked',
        `Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`)
    }
    try {
      const blockedEmail = limit('signInEmail', email)
      if (blockedEmail) return blockedEmail
      // Last, so requests refused above never use up the global budget.
      if (limits.signInGlobal?.hit('*').limited) return BUSY()

      const cols = await usersColumns()
      const user = await findUserByEmail(email)
      const passwordOk = await checkPassword(password, user?.encrypted_password)
      if (!passwordOk || isUserBlocked(user) || isUnconfirmed(user, cols)) {
        lockout.fail(email)
        return INVALID_CREDENTIALS()
      }
      const session = await createSession(user.id, user.encrypted_password)
      if (!session) { // password changed or account deleted while we were checking
        lockout.fail(email)
        return INVALID_CREDENTIALS()
      }
      lockout.succeed(email)
      return await finishSignIn(user, cols, session)
    } finally {
      attempt.release?.()
    }
  }

  async function finishSignIn(user, cols, { token, expiresAt }) {
    if (writable(cols, 'last_sign_in_at')) {
      const r = await pool.query(
        `UPDATE ${T.users} AS u SET last_sign_in_at = now() WHERE u.id = $1 RETURNING to_jsonb(u) AS u`,
        [user.id]
      )
      if (r.rows[0]) Object.assign(user, r.rows[0].u)
    }
    const pub = publicUser(user)
    const nowSec = Math.floor(Date.now() / 1000)
    return ok({
      user: pub,
      session: {
        access_token: token,
        token_type: 'bearer',
        expires_in: Math.max(0, expiresAt - nowSec),
        expires_at: expiresAt,
        user: pub
      }
    })
  }

  async function signUp(body, ctx) {
    const blocked = limit('signUpIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const email = normalizeEmail(body.email)
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      return fail(422, 'Unable to validate email address: invalid format', 'email_address_invalid')
    }
    const pwProblem = validateNewPassword(body.password)
    if (pwProblem) return fail(422, pwProblem, 'weak_password')
    const blockedEmail = limit('signUpEmail', mailboxKey(email))
    if (blockedEmail) return blockedEmail
    // Last, so requests refused above never use up the global budget; and
    // refunded below unless an account is created.
    const blockedGlobal = limit('signUpGlobal', '*')
    if (blockedGlobal) return blockedGlobal
    let created = false
    try {
      const out = await createAccount(body, email, ctx)
      created = out.status === 200
      return out
    } finally {
      if (!created) limits.signUpGlobal?.refund?.('*')
    }
  }

  async function createAccount(body, email, ctx) {
    const meta = stripMetadata(body.metadata ?? body.data)
    if (utf8Length(JSON.stringify(meta)) > cfg.maxMetadataBytes) {
      return fail(422, 'User metadata is too large', 'validation_failed')
    }
    if (meta.dob != null && meta.dob !== '' && (typeof meta.dob !== 'string' || !DATE_RE.test(meta.dob))) {
      return fail(422, 'Invalid date of birth', 'validation_failed')
    }
    if (meta.dob === '') meta.dob = null

    const hash = await hashPassword(body.password)
    const id = randomUUID()
    // With a mailer and db/010 the address stays unconfirmed and gets a link;
    // otherwise the account is confirmed at once (as before).
    const linkPossible = mailer.enabled && await tokensAvailable()
    let confirmToken = null

    try {
      const user = await withTransaction(async (client) => {
        const ucols = await usersColumns(client)
        const exists = await client.query(`SELECT 1 FROM ${T.users} WHERE lower(email) = $1 LIMIT 1`, [email])
        if (exists.rows.length) return null
        const byLink = linkPossible && writable(ucols, 'email_confirmed_at') && writable(ucols, 'raw_app_meta_data')

        // auth.users row, using only the columns this table actually has.
        const values = { id, email, encrypted_password: hash }
        if (writable(ucols, 'raw_user_meta_data')) values.raw_user_meta_data = meta
        if (writable(ucols, 'raw_app_meta_data')) {
          values.raw_app_meta_data = { provider: 'email', providers: ['email'] }
          if (byLink) values.raw_app_meta_data[EMAIL_CONFIRMATION_MARK.key] = EMAIL_CONFIRMATION_MARK.value
        }
        if (writable(ucols, 'aud')) values.aud = 'authenticated'
        if (writable(ucols, 'role')) values.role = 'authenticated'
        const nowCols = [...(byLink ? [] : ['email_confirmed_at']), 'created_at', 'updated_at'].filter(c => writable(ucols, c))
        const userCols = [...Object.keys(values), ...nowCols]
        const nowJson = nowCols.length
          ? ` || jsonb_build_object(${nowCols.map(c => `'${c}', now()`).join(', ')})`
          : ''
        const ins = await client.query(
          `INSERT INTO ${T.users} AS u (${userCols.map(quoteIdent).join(', ')})
           SELECT ${userCols.map(c => 'r.' + quoteIdent(c)).join(', ')}
             FROM jsonb_populate_record(NULL::${T.users}, $1::jsonb${nowJson}) r
           RETURNING to_jsonb(u) AS u`,
          [JSON.stringify(values)]
        )

        // profiles row: the handle_new_user() field mapping, done here instead
        // of in a trigger. Skipped if a profile already exists (e.g. a restored
        // trigger fired) or the table is absent.
        if (T.profiles) {
          const pcols = await columnsOf(cfg.profilesTable, client)
          if (pcols.size) {
            const text = (v) => (v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v)))
            const prof = { [cfg.profileUserIdColumn]: id }
            const put = (col, v) => { if (writable(pcols, col)) prof[col] = v }
            put('first_name', text(meta.first_name))
            put('last_name', text(meta.last_name))
            put('country', text(meta.country) ?? cfg.defaultCountry)
            put('dob', meta.dob ?? null)
            put('roles', [...cfg.defaultRoles])
            for (const f of cfg.extraProfileFields) {
              if (meta[f] != null && !(f in prof)) put(f, text(meta[f]))
            }
            const pc = Object.keys(prof)
            const uid = quoteIdent(cfg.profileUserIdColumn)
            await client.query(
              `INSERT INTO ${T.profiles} (${pc.map(quoteIdent).join(', ')})
               SELECT ${pc.map(c => 'r.' + quoteIdent(c)).join(', ')}
                 FROM jsonb_populate_record(NULL::${T.profiles}, $1::jsonb) r
                WHERE NOT EXISTS (SELECT 1 FROM ${T.profiles} p WHERE p.${uid} = $2)`,
              [JSON.stringify(prof), id]
            )
          }
        }
        if (byLink) confirmToken = await issueToken(client, id, 'confirm')
        return ins.rows[0].u
      })
      if (!user) {
        return fail(422, 'A user with this email address has already been registered', 'user_already_exists')
      }
      if (confirmToken) {
        const lang = mailLang(body, ctx)
        const link = authLink(mailer.managerUrl, 'confirm', confirmToken, lang)
        background('sign-up confirmation mail', async () => {
          const r = await mailer.send('confirm', { to: user.email, lang, link })
          if (r?.sent) log.log?.(`[auth] confirmation link sent to ${maskEmail(user.email)}`)
        })
        // email_confirmation: 'sent' tells the app it may sign in right away.
        return ok({ user: publicUser(user), email_confirmation: 'sent' })
      }
      return ok({ user: publicUser(user) })
    } catch (err) {
      if (err.code === '23505') {
        return fail(422, 'A user with this email address has already been registered', 'user_already_exists')
      }
      // invalid_text_representation / datetime / invalid enum label etc. in metadata
      if (err.code === '22007' || err.code === '22008' || err.code === '22P02' || err.code === '22023') {
        return fail(422, 'Invalid profile data', 'validation_failed')
      }
      throw err
    }
  }

  async function signOut(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const token = typeof body.access_token === 'string' ? body.access_token : bearerFromHeaders(ctx.headers)
    if (token) await revokeSession(token)
    return ok(null)
  }

  async function sessionFromBody(body, ctx) {
    const token = typeof body.access_token === 'string' && body.access_token
      ? body.access_token
      : bearerFromHeaders(ctx.headers)
    if (!token) return { error: MISSING_TOKEN() }
    const v = await verifyAccessToken(token)
    if (!v) return { error: INVALID_TOKEN() }
    return v
  }

  async function getUser(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    return ok({ user: v.user, session: v.session })
  }

  async function deleteAccount(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    const userId = v.user.id
    // Files first: when they cannot be removed nothing is deleted (503), so
    // the account is never gone while its backups stay behind.
    if (typeof cfg.onAccountDeleted === 'function') await cfg.onAccountDeleted(userId)
    await withTransaction(async (client) => {
      await revokeUserSessions(userId, client)
      for (const { table, column } of cfg.ownedTables) {
        const cols = await columnsOf(table, client)
        if (!cols.has(column)) continue
        await client.query(`DELETE FROM ${qualify(table)} WHERE ${quoteIdent(column)} = $1`, [userId])
      }
      for (const { table, column } of cfg.detachedColumns) {
        const cols = await columnsOf(table, client)
        if (!cols.has(column)) continue
        await client.query(`UPDATE ${qualify(table)} SET ${quoteIdent(column)} = NULL WHERE ${quoteIdent(column)} = $1`, [userId])
      }
      await client.query(`DELETE FROM ${T.users} WHERE id = $1`, [userId])
    })
    lockout.reset(normalizeEmail(v.user.email))
    // Second pass: an upload that passed its session check before the
    // sessions were revoked may have landed in between. Best effort.
    if (typeof cfg.onAccountDeleted === 'function') {
      try {
        await cfg.onAccountDeleted(userId)
      } catch (err) {
        log.error('[auth] delete-account: file clean-up after the commit failed:', err.message)
      }
    }
    return ok(null)
  }

  async function profile(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    // Read only. `body.updates` is ignored on purpose: profile writes go
    // through /api/db with the owner scoping and the roles denylist.
    if (!T.profiles) return ok(null)
    const pcols = await columnsOf(cfg.profilesTable)
    if (!pcols.size) return result(200, { data: null, error: { message: 'Profile not found', code: 'PGRST116' } })
    const { rows } = await pool.query(
      `SELECT to_jsonb(p) AS p FROM ${T.profiles} p WHERE p.${quoteIdent(cfg.profileUserIdColumn)} = $1 LIMIT 2`,
      [v.user.id]
    )
    if (rows.length !== 1) {
      return result(200, { data: null, error: { message: 'Profile not found', code: 'PGRST116' } })
    }
    return ok(rows[0].p)
  }

  const RESET_UNAVAILABLE = () => fail(503,
    `Password reset is temporarily unavailable. Contact ${cfg.contactEmail}.`,
    'reset_unavailable')
  const CONFIRM_UNAVAILABLE = () => fail(503,
    'Email confirmation is temporarily unavailable. Please try again later.',
    'confirm_unavailable', { 'Retry-After': '60' })
  // One answer for every valid request, whether or not the account exists.
  const RESET_REQUESTED = () => ok({ requested: true })

  /**
   * POST reset-password { email, lang }. Rate-limited per client and per
   * address, then always the same 200 answer; the lookup, the link and the
   * mail happen after the answer (background), and only for an existing,
   * not blocked account.
   */
  async function requestPasswordReset(body, ctx) {
    if (!mailer.enabled) {
      const blocked = limit('sessionIp', ipKey(ctx.ip))
      if (blocked) return blocked
      return RESET_UNAVAILABLE()
    }
    const blocked = limit('resetIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const email = normalizeEmail(body.email)
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      return fail(422, 'Unable to validate email address: invalid format', 'email_address_invalid')
    }
    const blockedEmail = limit('resetEmail', mailboxKey(email))
    if (blockedEmail) return blockedEmail
    if (!(await tokensAvailable())) {
      log.error('[auth] reset-password: auth.app_tokens is missing (run db/010_auth_tokens.sql)')
      return RESET_UNAVAILABLE()
    }
    const lang = mailLang(body, ctx)
    background('reset-password mail', async () => {
      const user = await findUserByEmail(email)
      if (!user || isUserBlocked(user)) return
      const token = await withTransaction((client) => issueToken(client, user.id, 'reset'))
      await audit('account.password_reset_requested', user.id, {})
      const r = await mailer.send('reset', { to: user.email, lang, link: authLink(mailer.managerUrl, 'reset', token, lang) })
      if (r?.sent) log.log?.(`[auth] reset link sent to ${maskEmail(user.email)}`)
    })
    return RESET_REQUESTED()
  }

  /**
   * POST reset-password/confirm { token, password, lang }: the new password
   * (policy enforced), the address confirmed (the link proves it), all
   * sessions revoked, the link spent; then a "password changed" notice.
   */
  async function confirmPasswordReset(body, ctx) {
    const blocked = limit('tokenIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const token = body.token
    if (!isWellFormedToken(token)) return INVALID_LINK()
    const pwProblem = validateNewPassword(body.password)
    if (pwProblem) return fail(422, pwProblem, 'weak_password')
    if (!(await tokensAvailable())) return RESET_UNAVAILABLE()
    // Cheap check first, so junk tokens cost no bcrypt.
    const pre = await pool.query(
      `SELECT 1 FROM ${T.tokens} WHERE hash = $1 AND purpose = 'reset' AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token)]
    )
    if (!pre.rows.length) return INVALID_LINK()
    const hash = await hashPassword(body.password)
    const out = await withTransaction(async (client) => {
      const t = await consumeToken(client, token, 'reset')
      if (t.state !== 'ok') return null
      return setPasswordIn(client, t.userId, hash, { confirmEmail: true })
    })
    if (!out) return INVALID_LINK()
    lockout.reset(out.email)
    await audit('account.password_reset', out.userId, { sessions_revoked: out.revokedSessions })
    if (mailer.enabled) {
      const lang = mailLang(body, ctx)
      background('password-changed mail', () => mailer.send('password_changed', { to: out.email, lang }))
    }
    return ok({ password_updated: true })
  }

  /** POST confirm-email { token }: marks the address confirmed. */
  async function confirmEmailLink(body, ctx) {
    const blocked = limit('tokenIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const token = body.token
    if (!isWellFormedToken(token)) return INVALID_LINK()
    if (!(await tokensAvailable())) return CONFIRM_UNAVAILABLE()
    const out = await withTransaction(async (client) => {
      const cols = await usersColumns(client)
      const t = await consumeToken(client, token, 'confirm')
      if (t.state === 'unknown') return null
      if (!cols.has('email_confirmed_at')) return { userId: t.userId, already: true }
      if (t.state !== 'ok') {
        // A spent or expired link of an address that is confirmed by now:
        // tell its holder so, instead of "invalid".
        const { rows } = await client.query(`SELECT email_confirmed_at IS NOT NULL AS confirmed FROM ${T.users} WHERE id = $1`, [t.userId])
        return rows[0]?.confirmed ? { userId: t.userId, already: true } : null
      }
      let set = 'email_confirmed_at = coalesce(email_confirmed_at, now())'
      if (writable(cols, 'updated_at')) set += ', updated_at = now()'
      await client.query(`UPDATE ${T.users} SET ${set} WHERE id = $1`, [t.userId])
      await client.query(
        `UPDATE ${T.tokens} SET used_at = now() WHERE user_id = $1 AND purpose = 'confirm' AND used_at IS NULL`,
        [t.userId]
      )
      return { userId: t.userId, already: false }
    })
    if (!out) return INVALID_LINK()
    if (!out.already) await audit('account.email_confirmed', out.userId, {})
    return ok({ confirmed: true, already_confirmed: out.already })
  }

  /** POST resend-confirmation { access_token, lang }: a fresh link for the signed-in, unconfirmed account. */
  async function resendConfirmation(body, ctx) {
    const blocked = limit('resendIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    if (v.user.email_confirmed_at) return ok({ sent: false, already_confirmed: true })
    if (!mailer.enabled || !(await tokensAvailable())) return CONFIRM_UNAVAILABLE()
    const blockedUser = limit('resendUser', v.user.id)
    if (blockedUser) return blockedUser
    const token = await withTransaction((client) => issueToken(client, v.user.id, 'confirm'))
    const lang = mailLang(body, ctx)
    try {
      const r = await mailer.send('confirm', { to: v.user.email, lang, link: authLink(mailer.managerUrl, 'confirm', token, lang) })
      if (!r?.sent) return CONFIRM_UNAVAILABLE()
    } catch (err) {
      log.error(`[auth] resend-confirmation mail failed: ${describeMailError(err)}`)
      return CONFIRM_UNAVAILABLE()
    }
    return ok({ sent: true, already_confirmed: false })
  }

  /**
   * Dispatches one /api/auth/<action> request.
   * @param {string} action  path segment after /api/auth/
   * @param {object} body    parsed JSON body ({} if empty)
   * @param {{ip:string, headers?:object}} ctx  client IP (server.js getClientIp) and request headers
   * @returns {Promise<{status:number, headers:object, body:object}>}
   * Never throws: database failures become 503 "auth_unavailable" (not 401, so
   * clients do not drop their session on a backend hiccup).
   */
  async function handleAuthRequest(action, body, ctx = {}) {
    const b = isPlainObject(body) ? body : {}
    const c = { ip: ctx.ip || 'unknown', headers: ctx.headers || {} }
    try {
      switch (action) {
        case 'sign-in': return await signIn(b, c)
        case 'sign-up': return await signUp(b, c)
        case 'sign-out': return await signOut(b, c)
        case 'get-user': return await getUser(b, c)
        case 'delete-account': return await deleteAccount(b, c)
        case 'profile': return await profile(b, c)
        case 'update-user':
          return fail(501, 'Email change is not available yet.', 'not_implemented')
        case 'reset-password': return await requestPasswordReset(b, c)
        case 'reset-password/confirm': return await confirmPasswordReset(b, c)
        case 'confirm-email': return await confirmEmailLink(b, c)
        case 'resend-confirmation': return await resendConfirmation(b, c)
        default:
          return fail(404, 'Invalid request', 'not_found')
      }
    } catch (err) {
      if (err?.code === 'AUTH_BUSY') return BUSY() // expected under load; not logged per request
      log.error(`[auth] ${String(action).slice(0, 40)} failed:`, err.message)
      return UNAVAILABLE()
    }
  }

  function sweep() {
    for (const l of Object.values(limits)) l?.sweep?.()
    lockout.sweep?.()
  }

  return {
    handleAuthRequest,
    verifyToken,
    verifyAccessToken,
    requireUser,
    setPassword,
    findUserId,
    revokeSession,
    revokeUserSessions,
    sweepExpiredSessions,
    sweepExpiredTokens,
    settle,
    mailer,
    sweep,
    limits,
    lockout,
    bcryptGate,
    config: Object.freeze(Object.fromEntries(Object.entries(cfg).filter(
      ([k]) => !['pool', 'bcrypt', 'logger', 'limits', 'lockout', 'ipKey', 'onAccountDeleted', 'mailer'].includes(k)))),
    /** Drops the cached column lists (after a restore or migration). */
    refreshCatalog() { catalog.clear() },
    // exposed for tests and scripts
    _checkPassword: checkPassword,
    _hashPassword: hashPassword
  }
}
