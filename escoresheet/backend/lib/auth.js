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
 *     auth.verifyPassword(userId, pw, { ip }?) -> { ok } | { locked, retryAfterSec } (throws AUTH_BUSY)
 *     auth.findUserId(emailOrId)       -> { id, email } (throws if not exactly one)
 *     auth.revokeUserSessions(userId)  -> number
 *     auth.eraseAccount(userId, { inTransaction }) -> { deleted } (delete-account's
 *                                       deletion, also for the admin console; throws on failure)
 *     auth.sweepExpiredSessions()      -> number
 *     auth.sweepExpiredTokens()        -> number   (one-time email links, db/010)
 *     auth.settle()                    -> resolves when the background mail jobs are done (tests)
 *     auth.sweep()                     -> clears stale in-memory counters
 *     auth.limits / auth.lockout       -> the counters (inspect, reset, replace)
 *     auth.bcryptGate                  -> { active, queued, peak, rejected, lanes } of the bcrypt limiter
 *     auth.bcryptStats()               -> the worker threads' state, or null (main thread)
 *     auth.close()                     -> stops the bcrypt worker threads
 *     auth.sweepSignInFailures()       -> number (db/057 rows past their window; also run by sweepExpiredSessions)
 *   sendAuthResult(res, result), createRateLimiter(opts), createLockout(opts),
 *   createConcurrencyGate(opts), createFairGate(opts), ipBucketKey(ip),
 *   ipLaneKey(ip), hashToken(token), generateToken(), isWellFormedToken(token),
 *   AUTH_ACTIONS
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
 * Brands (OpenVolley 'indoor', OpenBeach 'beach'; plan 1.5): sign-up,
 * reset-password, reset-password/confirm and resend-confirmation take an
 * optional `app` (lib/mailer.js mailApp: 'beach', anything else indoor). It
 * chooses the mail's brand and its link host (the mailer's brand table, never
 * a URL from the client), and on sign-up the account's first membership
 * (auth.app_memberships, db/012, joined_via 'signup'). Without `app`, sign-up
 * writes no membership: an account without one counts as indoor (lib/accounts.js),
 * so OpenVolley 2.1/2.2 clients get exactly what they got before. `app` is
 * never an authorisation: it grants no role. confirm-email accepts it and
 * ignores it (no mail, no membership).
 *
 * Sign-up of a registered address: with mail on, the same answer a new
 * account gets, and the owner is mailed a reset link instead; without mail,
 * 422 user_already_exists (as before). The confirmation of an account created
 * with a link keeps the password, sessions and passkeys of whoever signed up
 * only when the clicker gives that password (confirmEmailLink). Otherwise,
 * and whenever a reset link's new password confirms an address, the owner
 * keeps or drops each detail the sign-up gave (name, licence number,
 * requests: reset-password/details, reset-password/confirm `keep`), and the
 * approvers are told after that (audit 2611 SEC-15).
 *
 * CPU guard: bcryptjs is pure JS. With bcryptWorkers (server.js) it runs in
 * worker threads (lib/bcryptPool.js), off the event loop that also serves the
 * live-scoring relay; otherwise on the main thread as before. Every bcrypt
 * call goes through a gate that is fair between clients (createFairGate,
 * audit 2611 SEC-03): one job at a time per client lane (an IPv6 /48 or an
 * IPv4 address, ipLaneKey), the lane served least recently first, a source
 * that signed in to the account before ahead of the rest (one waiting job
 * per lane and per account, so priority cannot be stacked), a short wait
 * (bcryptMaxWaitMs), and 503 "auth_busy" at once when there is no place; an
 * ops alert when that goes on (onGateSaturated). Sign-in also has a global
 * bucket (limits.signInGlobal) next to the per-IP one, charged only to
 * sources that failed lately, and per-IP buckets key IPv6 clients on their
 * /64 (ipBucketKey). The lockout is per account and source (DEFAULTS.lockout),
 * with an account-wide ceiling that a source which signed in before passes
 * (DEFAULTS.accountLockout), and a ceiling per address in the database that
 * survives a restart (db/057, DEFAULTS.accountCeiling, audit 2611 SEC-13).
 */

import { createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'
import bcryptjs from 'bcryptjs'
import { authLink, describeMailError, disabledMailer, inboxKey, mailApp, maskEmail, MAIL_BRANDS, pickLang } from './mailer.js'
import { cleanTransports, createPasskeyCeremonies, passkeyConfig, passkeyDeviceLabel, PasskeyError, PASSKEYS_PER_USER_MAX } from './passkeys.js'
import { connectClient } from './pgClient.js'
import { EMAIL_RE } from './emailAddress.js'
import { accessFromRoles } from './access.js'
import { createBcryptPool } from './bcryptPool.js'

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60

export const AUTH_ACTIONS = Object.freeze([
  'sign-in', 'sign-up', 'sign-out', 'get-user', 'update-user',
  'delete-account', 'profile', 'reset-password', 'reset-password/confirm',
  'reset-password/details', 'confirm-email', 'resend-confirmation',
  // passkeys (lib/passkeys.js): sign-in with the device's fingerprint or face
  'passkey/login-options', 'passkey/login', 'passkey/register-options',
  'passkey/register', 'passkey/list', 'passkey/delete',
  // the account's own security: confirm it is you (password or passkey) for
  // the sensitive actions, a new password, the sessions, sign out everywhere
  'reauth', 'change-password', 'session/list', 'sign-out-everywhere'
])

// A confirmation (password or passkey) holds this long for the session that
// gave it: deleting the account, removing passkeys (reauth, below).
export const REAUTH_FRESH_MS = 5 * 60 * 1000

// raw_app_meta_data marker of accounts created unconfirmed with a link.
export const EMAIL_CONFIRMATION_MARK = Object.freeze({ key: 'ov_email_confirmation', value: 'link' })

const DEFAULTS = Object.freeze({
  usersTable: 'auth.users',
  sessionsTable: 'auth.app_sessions',
  // One-time email links (db/010). Absent table: reset answers 503 and
  // sign-up confirms at once, as without a mailer.
  tokensTable: 'auth.app_tokens',
  // db/022 (optional): passkeys; null disables them
  passkeysTable: 'auth.passkeys',
  // Best-effort audit entries (db/007) when the table exists.
  auditTable: 'public.audit_log',
  // Per-app memberships (db/012). A sign-up with `app` adds its membership
  // when the table exists; absent table: nothing (the account counts as indoor).
  membershipsTable: 'auth.app_memberships',
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
    { table: 'public.match_editors', column: 'user_id' },
    // db/025: an open sign-up request (also ON DELETE CASCADE)
    { table: 'public.account_requests', column: 'user_id' },
    // db/050: the error reports sent while signed in
    { table: 'public.error_events', column: 'account_id' }
  ],
  // Rows that stay when the account goes (club records: the matches it scored,
  // beach competition matches) but forget who it was: the column is set NULL
  // explicitly (in addition to the ON DELETE SET NULL foreign keys) when the
  // table and column exist. README "Deleting an account".
  detachedColumns: [
    { table: 'public.matches', column: 'created_by' },
    { table: 'public.beach_competition_matches', column: 'created_by' },
    { table: 'public.beach_competition_matches', column: 'claimed_by' },
    // db/011: approvals keep the official's name snapshot (club records)
    { table: 'public.match_approvals', column: 'user_id' },
    { table: 'public.match_approvals', column: 'requested_by' },
    { table: 'public.match_approvals', column: 'revoked_by' },
    // db/015: the history of undone / edited events stays with its match
    { table: 'public.events', column: 'voided_by' },
    { table: 'public.event_revisions', column: 'actor_id' },
    // db/016: match activity stays (club record) without the account
    { table: 'public.activity_log', column: 'account_id' },
    { table: 'public.activity_log', column: 'uploader_id' },
    // db/056: a referee the account added stays in the directory
    { table: 'public.referee_database', column: 'created_by' }
  ],
  // Rows of a table that go with the account under a condition (the table's
  // other rows stay, detached above). db/016: the account's device and app
  // activity (no match) is deleted.
  ownedRows: [
    { table: 'public.activity_log', column: 'account_id', where: 'match_external_id IS NULL', needs: 'match_external_id' }
  ],
  // async (userId) => counts: removes the account's files (server.js passes
  // lib/storage.js deleteUserData: backup/<user>/ and scoresheet owner
  // entries). Runs before the database rows go (a failure answers 503 and
  // deletes no row, so the user can retry) and once more after the commit
  // (an upload that was in flight). null: no files to remove.
  onAccountDeleted: null,
  // async (client, userId) => void: the account's own delete-account runs it
  // first in the deletion's transaction (server.js: lib/accounts.js
  // selfDeleteIn, the locks, the last-super-admin refusal and the audit
  // entry of the admin path). A thrown error with `__result` ({ status, body })
  // is the answer and nothing is deleted. null: no checks.
  selfDelete: null,
  // db/025 (lib/accountRequests.js): what a new account asks for at sign-up
  // (the body's `requests`: scorer, referee, team or club manager, with the
  // club and team), stored in the sign-up's transaction; nothing is granted.
  // { parse(raw, { app }) -> { rows } | { error }, store(client, userId, rows),
  // list?(client, userId) -> [{ id, kind, club_id, club_name, team_id, team_name }] }
  // (store throws an error with `signUpRequests` set for a club or team that
  // is gone: the sign-up answers 422; list names the parts for
  // reset-password/details, else they come without names). null: `requests`
  // is ignored.
  signUpRequests: null,
  // Mirrors handle_new_user() from frontend/src/db/migrations/001_auth_profiles.sql.
  // `roles` is never taken from the client: it always gets defaultRoles.
  // New accounts get no role: they are pending until an admin approves them
  // or they redeem an invite code (db/007, lib/accounts.js). Until then they
  // score test matches only.
  defaultRoles: [],
  defaultCountry: 'CHE',
  // Sign-up needs the licence number (owner 23.11.2026: "have registered
  // people insert their licence n in registration"). server.js turns it on
  // unless OV_SIGNUP_LICENCE=optional; off, it stays optional (db/048).
  licenceRequired: false,
  // Extra metadata keys copied verbatim into same-named profile columns when
  // that column exists (the live profiles table has sport_type, 001 did not).
  extraProfileFields: ['sport_type'],
  // Metadata keys a client may never set. dob: no date of birth is kept
  // (db/048, owner 2026-11-19); an older app's is dropped at sign-up and
  // never answered.
  strippedMetadataKeys: ['roles', 'role', 'dob'],
  maxMetadataBytes: 4096,

  sessionTtlSec: 30 * DAY,
  slideThresholdSec: 15 * DAY,
  absoluteTtlSec: 90 * DAY,
  touchIntervalSec: 5 * 60, // write last_seen_at at most this often per session

  // New passwords (sign-up, reset, scripts): at least this long; an account
  // with the admin role needs adminMinPasswordLength. Existing passwords keep
  // working.
  minPasswordLength: 10,
  adminMinPasswordLength: 14,
  bcryptCost: 10,
  maxBcryptCost: 15, // stored hashes above this are treated as invalid (DoS guard)
  // Worker threads for bcrypt (lib/bcryptPool.js, audit 2611 SEC-03): 0 runs
  // it on the main thread (bcryptjs's async API, as before); server.js sets
  // OV_BCRYPT_WORKERS (default 1). Without bcryptjs on disk (the bundled hall
  // server) it stays on the main thread.
  bcryptWorkers: 0,
  // At most this many bcrypt operations run at once (default: 2 on the main
  // thread, one per worker thread), at most bcryptLaneConcurrent of one
  // client (ipLaneKey: an IPv6 /48 or an IPv4 address); up to bcryptMaxQueue
  // more wait (fairly: createFairGate), at most bcryptMaxWaitMs, anything
  // beyond gets 503 auth_busy at once.
  bcryptMaxConcurrent: 2,
  bcryptMaxQueue: 16,
  bcryptMaxWaitMs: 3000,
  bcryptLaneConcurrent: 1,
  // A source that signed in to the account before goes ahead of the rest,
  // but a lane (or an account) at most once per bcryptPriorityGapMs, with at
  // most one such job waiting (createFairGate): known sources of an
  // attacker's own accounts cannot keep everyone else waiting (SEC-03).
  bcryptPriorityGapMs: 5000,
  // Ops alert (options.onGateSaturated, server.js: the error tracker) when
  // sign-ins keep being turned away (auth_busy, the gate at capacity) for
  // bcryptSaturatedMs; at most once per bcryptAlertCooldownMs.
  bcryptSaturatedMs: 30 * 1000,
  bcryptAlertCooldownMs: 15 * 60 * 1000,

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
    // Per account and source (address bucket): a stranger's attempts on an
    // address never use up its owner's.
    signInEmail: { max: 10, windowMs: 15 * 60 * 1000 },
    // All sign-ins together from sources that failed a sign-in in the last
    // 15 minutes. A cost-10 compare is ~60-150 ms of main-thread CPU; 5/s
    // keeps bcrypt well under one core. A source without a recent failure is
    // not charged (the bcrypt gate still bounds the CPU), so made-up sign-ins
    // from many addresses cannot turn every real sign-in away.
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
    resendIp: { max: 10, windowMs: 60 * 60 * 1000 },
    // passkeys: the sign-in options and answers need no session (per address);
    // setting one up does (per account, so a hall behind one NAT does not
    // share a budget), and each finished set-up mails the account
    passkeyIp: { max: 60, windowMs: 5 * 60 * 1000 },
    passkeyUser: { max: 20, windowMs: 15 * 60 * 1000 },
    passkeyAddedUser: { max: 5, windowMs: 60 * 60 * 1000 }
  },
  // Per account and source: 10 failures lock that source out of that
  // account. accountLockout is the account-wide ceiling: past it, a source
  // that signed in to the account before still gets in, and any other source
  // gets newSourceTries tries per window (so the owner on a new network, or
  // after a restart, can still type the password).
  lockout: { maxFailures: 10, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 },
  accountLockout: { maxFailures: 100, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000, newSourceTries: 3 },
  // db/057 (audit 2611 SEC-13): the failed sign-ins of each address, in the
  // database (a restart forgets nothing; signInFailuresTable, null = off).
  // Past maxFailures within windowMs, a source that signed in to the account
  // before still gets in as usual; all other sources together get one try per
  // newSourceIntervalMs, doubling with each further maxFailures failures, at
  // most maxIntervalMs (429 account_locked meanwhile). The account is mailed
  // and the admins told (options.onSignInAttack) once per window.
  // slots: 'account' = all new sources of the address share that one try
  // (a botnet guesses no faster than one source; the owner on a new network
  // waits with the guessers); 'lane' = one try per client lane (ipLaneKey:
  // an IPv6 /48, an IPv4 address) and interval, so the owner's network keeps
  // its own while a botnet guesses once per lane (review I-2: the owner
  // decides; 'account' until then).
  accountCeiling: { maxFailures: 100, windowMs: 24 * 60 * 60 * 1000, newSourceIntervalMs: 60 * 1000, maxIntervalMs: 60 * 60 * 1000, slots: 'account' },
  signInFailuresTable: 'auth.sign_in_failures',
  // db/057: the sources that signed in to an address, so the way past the
  // ceiling for the owner's own survives a restart (review I-2). Written
  // only with signInSourceSecret (server.js: OV_PIN_SECRET, at least 32
  // characters): the rows are HMACs keyed with a key derived from it.
  signInSourcesTable: 'auth.sign_in_sources',
  signInSourceSecret: null,
  // db/025: what an account asked for at sign-up (when a reset link's new
  // password confirms the address, only the parts its owner keeps stay)
  accountRequestsTable: 'public.account_requests'
})
const FAILED_SOURCE_MS = 15 * 60 * 1000
const KNOWN_SOURCE_MS = 60 * DAY * 1000
const KNOWN_SOURCES_MAX = 50_000
const KNOWN_SOURCES_PER_ADDRESS = 20
// createFairGate: how many lanes it remembers the last start of (idle ones too)
const SERVED_LANES_MAX = 10_000
// accountCeiling.slots 'lane': how many address and lane slots are kept
const LANE_SLOTS_MAX = 100_000

const TOKEN_BYTES = 32
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/ // base64url of 32 bytes, no padding
const BCRYPT_RE = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/
// one strict address (lib/emailAddress.js)
// profiles.license_number (db/048); lib/accounts.js checks an admin's edit with it
export const LICENSE_RE = /^[0-9]{4,7}$/

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
    resetPrefix(prefix) { for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k) },
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
 * once with err.code === 'AUTH_BUSY' when the queue is full. With maxWaitMs a
 * job that waited that long in the queue rejects with 'AUTH_BUSY' too. A job
 * run with { abandoned } whose abandoned() is true once its slot comes (its
 * caller left while it waited) is not run: it rejects with 'GATE_ABANDONED'
 * and the slot goes on.
 */
export function createConcurrencyGate({ maxConcurrent, maxQueue = 0, maxWaitMs = 0 } = {}) {
  if (!(maxConcurrent > 0) || !(maxQueue >= 0)) {
    throw new Error('createConcurrencyGate: maxConcurrent (> 0) and maxQueue (>= 0) are required')
  }
  let active = 0
  let peak = 0
  const waiting = [] // { resolve, timer }
  const release = () => {
    const next = waiting.shift()
    if (next) {
      // the slot passes straight to the next job
      clearTimeout(next.timer)
      next.resolve()
    } else active--
  }
  const busy = () => Object.assign(new Error('auth: bcrypt queue is full'), { code: 'AUTH_BUSY' })
  return {
    maxConcurrent,
    maxQueue,
    async run(fn, { abandoned } = {}) {
      if (active < maxConcurrent) {
        active++
      } else if (waiting.length < maxQueue) {
        await new Promise((resolve, reject) => {
          const entry = { resolve, timer: null }
          if (maxWaitMs > 0) {
            entry.timer = setTimeout(() => {
              const i = waiting.indexOf(entry)
              if (i === -1) return
              waiting.splice(i, 1)
              reject(busy())
            }, maxWaitMs)
            entry.timer.unref?.()
          }
          waiting.push(entry)
        })
      } else {
        throw busy()
      }
      if (typeof abandoned === 'function' && abandoned()) {
        release()
        throw Object.assign(new Error('gate: the caller left while queued'), { code: 'GATE_ABANDONED' })
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
 * The fairness lane of a client (the bcrypt gate, createFairGate): IPv4 as is,
 * IPv4-mapped IPv6 as the IPv4 address, any other IPv6 address as its /48. A
 * /48 is what one site (and one free tunnel account) gets: rotating through
 * its 65536 /64s gives a fresh per-IP bucket each time (ipBucketKey), but one
 * lane (audit 2611 SEC-03).
 */
export function ipLaneKey(ip) {
  const k = ipBucketKey(ip)
  if (!k.endsWith('::/64')) return k
  return k.split(':').slice(0, 3).join(':') + '::/48'
}

/**
 * A concurrency gate that is fair between clients (audit 2611 SEC-03), for the
 * bcrypt work of sign-in. run(fn, { lane, priority, account, abandoned }):
 *   - at most maxConcurrent jobs run; at most laneConcurrent of one lane (a
 *     client, ipLaneKey); a job without a lane (scripts, the dummy hash) has
 *     no lane limit;
 *   - waiting jobs start priority first, then the lane served least recently
 *     (remembered for the last SERVED_LANES_MAX lanes, also once a lane is
 *     idle), then in arrival order: a flood from one lane cannot keep another
 *     client's job waiting behind it;
 *   - priority (a source that signed in to the account before) is fair too:
 *     at most one waiting job per lane and one per `account` keeps it, and a
 *     lane or an account that started a waiting priority job less than
 *     priorityGapMs ago gets none; any further one waits as a normal job (one
 *     lane, or one account from many lanes, can neither fill the queue with
 *     jobs nobody may push out nor keep the other lanes' jobs waiting);
 *   - when the queue (maxQueue) is full, a newcomer whose lane waits with at
 *     least two jobs fewer than the longest lane (all its jobs counted) takes
 *     the place of that lane's newest normal job, and a priority newcomer
 *     the place of a normal job of the longest lane; otherwise a newcomer
 *     takes the place of a job (a priority newcomer: also a priority job)
 *     whose lane waits with more jobs than its own and was served more
 *     recently (victimFor); the job pushed out, or a newcomer that finds no
 *     place, rejects at once with err.code === 'AUTH_BUSY';
 *   - a job that waited maxWaitMs rejects with 'AUTH_BUSY' (a quick 503
 *     instead of a long wait);
 *   - `abandoned` as in createConcurrencyGate.
 * onReject(reason): 'full' | 'evicted' | 'timeout', for the saturation alert.
 */
export function createFairGate({ maxConcurrent, maxQueue = 0, maxWaitMs = 0, laneConcurrent = 1, priorityGapMs = 0, onReject = null } = {}) {
  if (!(maxConcurrent > 0) || !(maxQueue >= 0) || !(laneConcurrent > 0)) {
    throw new Error('createFairGate: maxConcurrent (> 0), laneConcurrent (> 0) and maxQueue (>= 0) are required')
  }
  let active = 0
  let peak = 0
  let rejected = 0
  let served = 0
  const lanes = new Map() // lane -> { active, queued, prio }
  const accountPrio = new Map() // account -> its waiting priority jobs (0 or 1)
  const lastServed = new Map() // lane -> number of its last start, most recent last
  const prioStarted = new Map() // lane or account -> when it last started a waiting priority job
  const waiting = [] // { lane, account, priority, resolve, reject, timer }
  const busy = () => Object.assign(new Error('auth: bcrypt queue is full'), { code: 'AUTH_BUSY' })
  const laneOf = (lane) => {
    let s = lanes.get(lane)
    if (!s) { s = { active: 0, queued: 0, prio: 0 }; lanes.set(lane, s) }
    return s
  }
  const tidy = (lane) => {
    const s = lanes.get(lane)
    if (s && !s.active && !s.queued) lanes.delete(lane)
  }
  const canStart = (lane) => lane == null || (lanes.get(lane)?.active || 0) < laneConcurrent
  const servedOf = (lane) => (lane == null ? 0 : lastServed.get(lane) || 0)
  const refuse = (reason) => {
    rejected++
    try { onReject?.(reason) } catch { /* an alert must never fail a sign-in */ }
    return busy()
  }
  function start(lane) {
    active++
    if (active > peak) peak = active
    if (lane != null) {
      laneOf(lane).active++
      lastServed.delete(lane) // re-inserted: most recent last
      lastServed.set(lane, ++served)
      if (lastServed.size > SERVED_LANES_MAX) lastServed.delete(lastServed.keys().next().value)
    }
  }
  const prioKey = (kind, k) => `${kind}\u0000${k}`
  const recentPrio = (kind, k, t) => k != null && priorityGapMs > 0 && t - (prioStarted.get(prioKey(kind, k)) ?? -Infinity) < priorityGapMs
  function notePrio(kind, k, t) {
    if (k == null || !(priorityGapMs > 0)) return
    const key = prioKey(kind, k)
    prioStarted.delete(key) // re-inserted: most recent last
    prioStarted.set(key, t)
    if (prioStarted.size > 2 * SERVED_LANES_MAX) prioStarted.delete(prioStarted.keys().next().value)
  }
  /** May a priority job of `lane` and `account` wait as one now? */
  function keepsPriority(lane, account) {
    if (lane != null && (lanes.get(lane)?.prio || 0) > 0) return false
    if (account != null && (accountPrio.get(account) || 0) > 0) return false
    const t = Date.now()
    if (recentPrio('lane', lane, t) || recentPrio('account', account, t)) return false
    return true
  }
  function enqueue(e) {
    if (e.lane != null) {
      const s = laneOf(e.lane)
      s.queued++
      if (e.priority) s.prio++
    }
    if (e.priority && e.account != null) accountPrio.set(e.account, (accountPrio.get(e.account) || 0) + 1)
    waiting.push(e)
  }
  function unqueue(e) {
    clearTimeout(e.timer)
    if (e.lane != null) {
      const s = lanes.get(e.lane)
      if (s) { s.queued--; if (e.priority) s.prio-- }
    }
    if (e.priority && e.account != null) {
      const n = (accountPrio.get(e.account) || 0) - 1
      if (n > 0) accountPrio.set(e.account, n)
      else accountPrio.delete(e.account)
    }
  }
  function pick() {
    let best = -1
    for (let i = 0; i < waiting.length; i++) {
      const e = waiting[i]
      if (!canStart(e.lane)) continue
      if (best === -1) { best = i; continue }
      const b = waiting[best]
      if (e.priority !== b.priority) { if (e.priority) best = i; continue }
      if (servedOf(e.lane) < servedOf(b.lane)) best = i
    }
    return best
  }
  function pump() {
    while (active < maxConcurrent) {
      const i = pick()
      if (i === -1) return
      const [e] = waiting.splice(i, 1)
      unqueue(e)
      start(e.lane)
      if (e.priority) {
        const t = Date.now()
        notePrio('lane', e.lane, t)
        notePrio('account', e.account, t)
      }
      e.resolve()
    }
  }
  function release(lane) {
    active--
    if (lane != null) {
      const s = lanes.get(lane)
      if (s) s.active--
      tidy(lane)
    }
    pump()
  }
  /**
   * Index of the waiting job a newcomer of `lane` may push out, or -1. The
   * candidate: a normal job before a priority one (which only a priority
   * newcomer may push out), then the lane waiting with the most jobs (all its
   * jobs counted), then the lane served most recently, then the newest; never
   * one of the newcomer's own lane. It gives way when its lane waits with at
   * least two jobs more than the newcomer's (to a priority newcomer: any
   * normal job), or when its lane waits with more jobs than the newcomer's and
   * was served more recently (lanes that one client keeps busy make room for
   * one it has not served lately).
   */
  function victimFor(lane, priority) {
    const keyOf = (e) => e.lane ?? e // a job without a lane is a lane of its own
    const counts = new Map()
    for (const e of waiting) counts.set(keyOf(e), (counts.get(keyOf(e)) || 0) + 1)
    const mine = lane == null ? 0 : (counts.get(lane) || 0)
    let best = -1
    for (let i = waiting.length - 1; i >= 0; i--) {
      const e = waiting[i]
      if (e.priority && !priority) continue
      if (lane != null && e.lane === lane) continue
      if (best === -1) { best = i; continue }
      const b = waiting[best]
      if (e.priority !== b.priority) { if (!e.priority) best = i; continue }
      const ce = counts.get(keyOf(e))
      const cb = counts.get(keyOf(b))
      if (ce !== cb) { if (ce > cb) best = i; continue }
      if (servedOf(e.lane) > servedOf(b.lane)) best = i
    }
    if (best === -1) return -1
    const v = waiting[best]
    const n = counts.get(keyOf(v))
    if (!v.priority && (priority || n > mine + 1)) return best
    if (n > mine && servedOf(v.lane) > servedOf(lane)) return best
    return -1
  }
  return {
    maxConcurrent,
    maxQueue,
    laneConcurrent,
    async run(fn, { lane = null, priority = false, account = null, abandoned } = {}) {
      if (active < maxConcurrent && canStart(lane)) {
        start(lane)
      } else {
        const prio = !!priority && keepsPriority(lane, account)
        if (waiting.length >= maxQueue) {
          const v = maxQueue > 0 ? victimFor(lane, prio) : -1
          if (v === -1) throw refuse('full')
          const [out] = waiting.splice(v, 1)
          unqueue(out)
          tidy(out.lane)
          out.reject(refuse('evicted'))
        }
        await new Promise((resolve, reject) => {
          const entry = { lane, account, priority: prio, resolve, reject, timer: null }
          if (maxWaitMs > 0) {
            entry.timer = setTimeout(() => {
              const i = waiting.indexOf(entry)
              if (i === -1) return
              waiting.splice(i, 1)
              unqueue(entry)
              tidy(lane)
              reject(refuse('timeout'))
            }, maxWaitMs)
            entry.timer.unref?.()
          }
          enqueue(entry)
        })
      }
      if (typeof abandoned === 'function' && abandoned()) {
        release(lane)
        throw Object.assign(new Error('gate: the caller left while queued'), { code: 'GATE_ABANDONED' })
      }
      try {
        return await fn()
      } finally {
        release(lane)
      }
    },
    get active() { return active },
    get queued() { return waiting.length },
    get peak() { return peak },
    get rejected() { return rejected },
    get lanes() { return lanes.size },
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
    /** Forgets every key that starts with `prefix` (all sources of one account). */
    resetPrefix(prefix) { for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k) },
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
      : { ...DEFAULTS.lockout, ...(options.lockout || {}) },
    accountCeiling: options.accountCeiling === null || options.accountCeiling === false
      ? null
      : { ...DEFAULTS.accountCeiling, ...(options.accountCeiling || {}) }
  }
  if (cfg.sessionTtlSec > cfg.absoluteTtlSec) throw new Error('createAuth: sessionTtlSec exceeds absoluteTtlSec')
  cfg.contactEmail = cfg.contactEmail || process.env.CONTACT_EMAIL || 'support@openvolley.app'
  const ipKey = typeof cfg.ipKey === 'function' ? cfg.ipKey : ipBucketKey
  const laneKey = typeof cfg.laneKey === 'function' ? cfg.laneKey : ipLaneKey
  const log = options.logger || console
  // bcrypt off the main thread when the server asks for worker threads
  // (lib/bcryptPool.js; null without bcryptjs on disk). An injected
  // options.bcrypt (tests) is used as it is.
  const bcryptPool = !options.bcrypt && cfg.bcryptWorkers > 0 ? createBcryptPool({ size: cfg.bcryptWorkers, logger: log }) : null
  const rawBcrypt = options.bcrypt || bcryptPool || { compare: bcryptjs.compare, hash: bcryptjs.hash }
  const gateWatch = { streakStart: 0, last: 0, rejected: 0, alertedAt: 0 }
  const bcryptGate = createFairGate({
    maxConcurrent: options.bcryptMaxConcurrent ?? (bcryptPool ? bcryptPool.size : DEFAULTS.bcryptMaxConcurrent),
    maxQueue: cfg.bcryptMaxQueue,
    maxWaitMs: cfg.bcryptMaxWaitMs,
    laneConcurrent: cfg.bcryptLaneConcurrent,
    priorityGapMs: cfg.bcryptPriorityGapMs,
    onReject: () => noteGateBusy()
  })
  // o: { lane, priority } of the request (createFairGate)
  const bcrypt = {
    compare: (password, hash, o) => bcryptGate.run(() => rawBcrypt.compare(password, hash), o),
    hash: (password, cost, o) => bcryptGate.run(() => rawBcrypt.hash(password, cost), o)
  }
  /**
   * The gate turned a job away. Turn-aways that keep coming (gaps under 5 s)
   * for bcryptSaturatedMs are a flood, or a server too small for its load:
   * the ops alert, at most once per bcryptAlertCooldownMs.
   */
  function noteGateBusy() {
    const t = Date.now()
    if (!gateWatch.last || t - gateWatch.last > 5000) { gateWatch.streakStart = t; gateWatch.rejected = 0 }
    gateWatch.last = t
    gateWatch.rejected++
    if (t - gateWatch.streakStart < cfg.bcryptSaturatedMs) return
    if (gateWatch.alertedAt && t - gateWatch.alertedAt < cfg.bcryptAlertCooldownMs) return
    gateWatch.alertedAt = t
    const info = {
      seconds: Math.round((t - gateWatch.streakStart) / 1000),
      rejected: gateWatch.rejected,
      active: bcryptGate.active,
      queued: bcryptGate.queued,
      lanes: bcryptGate.lanes,
      maxConcurrent: bcryptGate.maxConcurrent
    }
    log.error(`[auth] sign-in gate at capacity for ${info.seconds} s: ${info.rejected} requests answered auth_busy (${info.active} running, ${info.queued} waiting, ${info.lanes} clients)`)
    if (typeof cfg.onGateSaturated === 'function') {
      try { cfg.onGateSaturated(info) } catch { /* an alert must never fail a request */ }
    }
  }
  const mailer = cfg.mailer && typeof cfg.mailer.send === 'function' ? cfg.mailer : disabledMailer()

  const T = {
    users: qualify(cfg.usersTable),
    sessions: qualify(cfg.sessionsTable),
    profiles: cfg.profilesTable ? qualify(cfg.profilesTable) : null,
    tokens: cfg.tokensTable ? qualify(cfg.tokensTable) : null,
    audit: cfg.auditTable ? qualify(cfg.auditTable) : null,
    passkeys: cfg.passkeysTable ? qualify(cfg.passkeysTable) : null,
    memberships: cfg.membershipsTable ? qualify(cfg.membershipsTable) : null,
    failures: cfg.signInFailuresTable ? qualify(cfg.signInFailuresTable) : null,
    sources: cfg.signInSourcesTable ? qualify(cfg.signInSourcesTable) : null,
    requests: cfg.accountRequestsTable ? qualify(cfg.accountRequestsTable) : null
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
    resendIp: resolveLimiter(cfg.limits.resendIp),
    passkeyIp: resolveLimiter(cfg.limits.passkeyIp),
    passkeyUser: resolveLimiter(cfg.limits.passkeyUser),
    passkeyAddedUser: resolveLimiter(cfg.limits.passkeyAddedUser)
  }
  const lockout = typeof cfg.lockout.check === 'function' ? cfg.lockout : createLockout(cfg.lockout)
  const accountLockout = cfg.accountLockout ? createLockout(cfg.accountLockout) : null
  // Tries a new source still gets while the ceiling is reached (per account+source)
  const newSourceLockout = cfg.accountLockout
    ? createLockout({ ...cfg.accountLockout, maxFailures: cfg.accountLockout.newSourceTries ?? 3 })
    : null
  // Sources (address buckets) whose last sign-in failed, for the global budget
  const failedSources = new Map() // bucket -> time of the last failure
  // email -> Map(bucket -> time of the last success): who gets past the ceiling
  const knownSources = new Map()
  const lockKey = (email, bucket) => `${email}|${bucket}`
  /** Forgets the failures of every source of one account (a new password). */
  function clearLocks(email) {
    if (!email) return
    lockout.reset?.(email) // verifyPassword's key
    lockout.resetPrefix?.(`${email}|`)
    accountLockout?.reset(email)
    newSourceLockout?.resetPrefix(`${email}|`)
    limits.signInEmail?.resetPrefix?.(`${email}|`)
    for (const k of laneSlots.keys()) if (k.startsWith(`${email}|`)) laneSlots.delete(k)
  }
  /** -> the time this source was remembered before, or undefined. */
  function rememberSource(email, bucket, at = Date.now()) {
    let m = knownSources.get(email)
    if (m) knownSources.delete(email) // re-inserted: most recent last
    else m = new Map()
    const before = m.get(bucket)
    m.delete(bucket)
    m.set(bucket, at)
    if (m.size > KNOWN_SOURCES_PER_ADDRESS) m.delete(m.keys().next().value)
    knownSources.set(email, m)
    while (knownSources.size > KNOWN_SOURCES_MAX) knownSources.delete(knownSources.keys().next().value)
    return before
  }
  function knownSource(email, bucket) {
    const t = knownSources.get(email)?.get(bucket)
    return t != null && Date.now() - t < KNOWN_SOURCE_MS
  }
  // db/057 auth.sign_in_sources: the known sources in the database too, so a
  // restart (a deploy) does not lock the owner out with the guessers past
  // the ceiling (review I-2). Keyed HMAC of the address and the source.
  const sourceSecret = typeof cfg.signInSourceSecret === 'string' && cfg.signInSourceSecret.length >= 32 ? cfg.signInSourceSecret : null
  const sourceMacKey = sourceSecret
    ? Buffer.from(hkdfSync('sha256', Buffer.from(sourceSecret, 'utf8'), Buffer.alloc(0), Buffer.from('ov-sign-in-source-v1', 'utf8'), 32))
    : null
  const sourceKey = (email, bucket) => createHmac('sha256', sourceMacKey).update(`${email}\u0000${bucket}`, 'utf8').digest()
  let sourcesCheckedAt = 0
  async function sourcesAvailable(client = pool) {
    if (!sourceMacKey || !T.sources) return false
    if (catalog.has(cfg.signInSourcesTable)) return true
    // absent (db/057 not run yet): looked up again at most once a minute
    if (Date.now() - sourcesCheckedAt < 60 * 1000) return false
    sourcesCheckedAt = Date.now()
    return (await columnsOf(cfg.signInSourcesTable, client)).size > 0
  }
  /** A sign-in succeeded from `bucket`: remembered, and written at most once a day per source. */
  async function noteKnownSource(email, bucket) {
    const before = rememberSource(email, bucket)
    if (before != null && Date.now() - before < DAY * 1000) return
    try {
      if (!(await sourcesAvailable())) return
      const ek = failureKey(email)
      const { rows } = await pool.query(
        `INSERT INTO ${T.sources} AS s (email_key, source_key, last_ok_at) VALUES ($1, $2, now())
         ON CONFLICT (email_key, source_key) DO UPDATE SET last_ok_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [ek, sourceKey(email, bucket)])
      if (rows[0]?.inserted) {
        await pool.query(
          `DELETE FROM ${T.sources} WHERE email_key = $1 AND source_key IN (
             SELECT source_key FROM ${T.sources} WHERE email_key = $1 ORDER BY last_ok_at DESC OFFSET $2)`,
          [ek, KNOWN_SOURCES_PER_ADDRESS])
      }
    } catch (err) {
      failuresTrouble('remember source', err)
    }
  }
  /** Past the ceiling: did `bucket` sign in to `email` before (memory, else the database)? */
  async function knownSourceStored(email, bucket) {
    if (knownSource(email, bucket)) return true
    try {
      if (!(await sourcesAvailable())) return false
      const { rows } = await pool.query(
        `SELECT extract(epoch FROM last_ok_at) * 1000 AS at FROM ${T.sources}
          WHERE email_key = $1 AND source_key = $2 AND last_ok_at > now() - make_interval(secs => $3)`,
        [failureKey(email), sourceKey(email, bucket), KNOWN_SOURCE_MS / 1000])
      if (!rows[0]) return false
      rememberSource(email, bucket, Number(rows[0].at))
      return true
    } catch (err) {
      failuresTrouble('known source', err)
      return false
    }
  }
  // accountCeiling.slots 'lane': `${email}|${lane}` -> when that lane may try again
  const laneSlots = new Map()

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
  async function checkPassword(password, storedHash, gateOptions) {
    const real = usableHash(storedHash)
    const target = real || await dummyHash()
    let match = false
    try {
      match = await bcrypt.compare(password, target, gateOptions)
    } catch (err) {
      if (err?.code === 'AUTH_BUSY') throw err // overload, not a wrong password
      match = false
    }
    return !!real && match === true
  }

  function validateNewPassword(password, min = cfg.minPasswordLength) {
    if (typeof password !== 'string' || password.length < min) {
      return `Password should be at least ${min} characters.`
    }
    if (utf8Length(password) > 72) return 'Password cannot be longer than 72 bytes.'
    return null
  }

  /**
   * The shortest new password one account may set: longer for an admin, the
   * super admin included (lib/access.js accessFromRoles isAdmin, audit 2611
   * SEC-36). Existing passwords keep working: sign-in checks no length.
   */
  async function minPasswordFor(userId, client = pool) {
    if (!T.profiles || !userId) return cfg.minPasswordLength
    try {
      const { rows } = await client.query(
        `SELECT p.roles FROM ${T.profiles} p WHERE p.${quoteIdent(cfg.profileUserIdColumn)} = $1`, [userId])
      const admin = rows.some((r) => accessFromRoles(r.roles).isAdmin)
      return admin ? Math.max(cfg.minPasswordLength, cfg.adminMinPasswordLength || 0) : cfg.minPasswordLength
    } catch (err) {
      if (err.code === '42P01' || err.code === '42703') return cfg.minPasswordLength // no profiles table / roles column
      throw err
    }
  }

  /** gateOptions: the request's { lane } for the bcrypt gate (createFairGate). */
  function hashPassword(password, gateOptions) {
    return bcrypt.hash(password, cfg.bcryptCost, gateOptions)
  }

  /**
   * The bcrypt gate's options of a request from `ip`; `account` (the address
   * signing in) for the gate's one waiting priority job per account.
   */
  const gateFor = (ip, priority = false, account = null) => ({ lane: laneKey(ip), priority, account })

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
    await sweepSignInFailures()
    return rowCount
  }

  /**
   * db/057: an address's failures go once their window is over, its known
   * sources after KNOWN_SOURCE_MS without a sign-in (with the hourly session
   * sweep). -> the failure rows removed.
   */
  async function sweepSignInFailures() {
    let removed = 0
    try {
      if (await failuresAvailable()) {
        const { rowCount } = await pool.query(
          `DELETE FROM ${T.failures} WHERE window_start <= now() - make_interval(secs => $1)`,
          [cfg.accountCeiling.windowMs / 1000])
        removed = rowCount
      }
    } catch (err) {
      failuresTrouble('sweep', err)
    }
    try {
      if (await sourcesAvailable()) {
        await pool.query(`DELETE FROM ${T.sources} WHERE last_ok_at <= now() - make_interval(secs => $1)`, [KNOWN_SOURCE_MS / 1000])
      }
    } catch (err) {
      failuresTrouble('sweep sources', err)
    }
    return removed
  }

  async function withTransaction(fn) {
    const client = await connectClient(pool, log)
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
      const { id } = await findUserId(emailOrId)
      const adminProblem = validateNewPassword(newPassword, await minPasswordFor(id))
      if (adminProblem) throw new Error(adminProblem)
    }
    const hash = await hashPassword(newPassword)
    const out = await withTransaction((client) => setPasswordIn(client, emailOrId, hash, { confirmEmail }))
    await clearAllLocks(out.email)
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
    // A new password is the "I lost control of this account" button: the
    // passkeys go with the sessions, or a key someone else added would
    // outlive it (lib/passkeys.js).
    if (await passkeysAvailable(client)) await client.query(`DELETE FROM ${T.passkeys} WHERE user_id = $1`, [id])
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

  /**
   * Re-checks the password of a signed-in account (lib/approvals.js: set or
   * remove the approval PIN). Exactly one bcrypt comparison through the gate
   * (a dummy hash when the account or its hash is missing), counted in the
   * sign-in lockout of the account's address, so a stolen session cannot
   * guess the password here faster than at sign-in.
   * -> { ok: true } | { ok: false } | { locked: true, retryAfterSec }.
   * Throws AUTH_BUSY when the bcrypt queue is full, and on a database error.
   */
  async function verifyPassword(userId, password, { ip } = {}) {
    await usersColumns()
    const byId = typeof userId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)
    const { rows } = byId
      ? await pool.query(`SELECT to_jsonb(u) AS u FROM ${T.users} u WHERE u.id = $1`, [userId])
      : { rows: [] }
    const user = rows[0]?.u || null
    const key = normalizeEmail(user?.email) || `id:${String(userId).slice(0, 64)}`
    const attempt = typeof lockout.begin === 'function' ? lockout.begin(key) : lockout.check(key)
    if (attempt.locked) return { locked: true, retryAfterSec: attempt.retryAfterSec }
    try {
      const pw = typeof password === 'string' && password.length <= 1024 ? password : ''
      const match = await checkPassword(pw, user?.encrypted_password, ip ? gateFor(ip) : undefined)
      if (!match || isUserBlocked(user)) {
        lockout.fail(key)
        return { ok: false }
      }
      lockout.succeed(key)
      return { ok: true }
    } finally {
      attempt.release?.()
    }
  }

  // --- one-time email links (db/010) -----------------------------------------
  async function passkeysAvailable(client = pool) {
    if (!cfg.passkeysTable) return false
    return (await columnsOf(cfg.passkeysTable, client)).size > 0
  }

  async function tokensAvailable(client = pool) {
    if (!cfg.tokensTable) return false
    return (await columnsOf(cfg.tokensTable, client)).size > 0
  }

  // --- the account-wide sign-in ceiling (db/057, audit 2611 SEC-13) ----------
  // One row per address with failed sign-ins (known or not, so the answers
  // never tell whether an account exists): the failures of its window, the
  // next try a new source may have past the ceiling, and when the account
  // was told. The key is a SHA-256 of the address: the table holds none.
  const failureKey = (email) => createHash('sha256').update(`ov-sign-in-failures:${email}`, 'utf8').digest()
  let failuresCheckedAt = 0
  let failuresWarnedAt = 0
  async function failuresAvailable(client = pool) {
    if (!T.failures || !cfg.accountCeiling) return false
    if (catalog.has(cfg.signInFailuresTable)) return true
    // absent (db/057 not run yet): looked up again at most once a minute
    if (Date.now() - failuresCheckedAt < 60 * 1000) return false
    failuresCheckedAt = Date.now()
    return (await columnsOf(cfg.signInFailuresTable, client)).size > 0
  }
  /** The ceiling never fails a sign-in: the in-memory lockouts still hold. */
  function failuresTrouble(what, err) {
    const t = Date.now()
    if (t - failuresWarnedAt < 60 * 1000) return
    failuresWarnedAt = t
    log.warn?.(`[auth] sign-in ceiling (db/057) ${what} failed: ${err?.code || err?.message}`)
  }

  /**
   * Before the password check: null to go on, { claim } to go on with the
   * try it took (returnClaim gives it back when the check does not run), or
   * { retryAfterSec } when the address is past its ceiling and no try is
   * free for this source now. A source that signed in to the account before
   * (`known`, in memory or in db/057 auth.sign_in_sources) always goes on.
   * slots 'account': all other sources share one try per interval; 'lane':
   * one per client lane (`lane`, ipLaneKey) and interval.
   */
  async function ceilingCheck(email, known, { bucket, lane } = {}) {
    const c = cfg.accountCeiling
    try {
      if (!(await failuresAvailable())) return null
      const key = failureKey(email)
      const perLane = c.slots === 'lane'
      const { rows } = await pool.query(
        `SELECT failures, greatest(0, ceil(extract(epoch FROM next_try_at - now())))::int AS wait
           FROM ${T.failures}
          WHERE email_key = $1 AND window_start > now() - make_interval(secs => $2)`,
        [key, c.windowMs / 1000])
      const r = rows[0]
      if (!r || r.failures < c.maxFailures || known) return null
      if (bucket != null && await knownSourceStored(email, bucket)) return null
      const steps = Math.min(20, Math.floor((r.failures - c.maxFailures) / c.maxFailures))
      const intervalSec = Math.max(1, Math.ceil(Math.min(c.maxIntervalMs, c.newSourceIntervalMs * 2 ** steps) / 1000))
      if (perLane) {
        const slot = `${email}|${lane}`
        const t = Date.now()
        const until = laneSlots.get(slot)
        if (until != null && until > t) return { retryAfterSec: Math.max(1, Math.ceil((until - t) / 1000)) }
        laneSlots.delete(slot) // re-inserted: most recent last
        laneSlots.set(slot, t + intervalSec * 1000)
        while (laneSlots.size > LANE_SLOTS_MAX) laneSlots.delete(laneSlots.keys().next().value)
        return { claim: { lane: slot, until: t + intervalSec * 1000 } }
      }
      if (r.wait > 0) return { retryAfterSec: r.wait }
      // one new source takes the try; the others wait for the next one
      const claim = await pool.query(
        `UPDATE ${T.failures} SET next_try_at = now() + make_interval(secs => $2)
          WHERE email_key = $1 AND (next_try_at IS NULL OR next_try_at <= now())
          RETURNING next_try_at::text AS at`,
        [key, intervalSec])
      return claim.rows.length ? { claim: { key, at: claim.rows[0].at } } : { retryAfterSec: intervalSec }
    } catch (err) {
      failuresTrouble('check', err)
      return null
    }
  }

  /**
   * The try a sign-in took past the ceiling, given back because its password
   * was never checked (the bcrypt gate answered auth_busy, the database
   * failed): the next request may have it (review I-2). Best effort.
   */
  async function returnClaim(claim) {
    if (!claim) return
    if (claim.lane) {
      if (laneSlots.get(claim.lane) === claim.until) laneSlots.delete(claim.lane)
      return
    }
    try {
      await pool.query(
        `UPDATE ${T.failures} SET next_try_at = NULL WHERE email_key = $1 AND next_try_at = $2::timestamptz`,
        [claim.key, claim.at])
    } catch (err) {
      failuresTrouble('return a try', err)
    }
  }

  /** A failed sign-in of `email`: counted; the first one past the ceiling tells the account. */
  async function recordFailure(email) {
    const c = cfg.accountCeiling
    try {
      if (!(await failuresAvailable())) return
      const key = failureKey(email)
      const { rows } = await pool.query(
        `INSERT INTO ${T.failures} AS f (email_key, window_start, failures, updated_at)
         VALUES ($1, now(), 1, now())
         ON CONFLICT (email_key) DO UPDATE SET
           failures = CASE WHEN f.window_start > now() - make_interval(secs => $2) THEN f.failures + 1 ELSE 1 END,
           next_try_at = CASE WHEN f.window_start > now() - make_interval(secs => $2) THEN f.next_try_at END,
           window_start = CASE WHEN f.window_start > now() - make_interval(secs => $2) THEN f.window_start ELSE now() END,
           updated_at = now()
         RETURNING failures, (alerted_at IS NOT NULL AND alerted_at >= window_start) AS alerted`,
        [key, c.windowMs / 1000])
      const r = rows[0]
      if (!r || r.failures < c.maxFailures || r.alerted) return
      const claim = await pool.query(
        `UPDATE ${T.failures} SET alerted_at = now()
          WHERE email_key = $1 AND (alerted_at IS NULL OR alerted_at < window_start)
          RETURNING failures`, [key])
      if (claim.rows[0]) background('sign-in attempts notice', () => tellOfAttempts(email, claim.rows[0].failures))
    } catch (err) {
      failuresTrouble('count', err)
    }
  }

  /**
   * Forgets the failures of an address (a new password, the account deleted):
   * after the commit, best effort (a database without db/057, or without its
   * grant yet, still sets the password).
   */
  async function forgetFailures(email) {
    if (!email) return
    try {
      if (!(await failuresAvailable())) return
      await pool.query(`DELETE FROM ${T.failures} WHERE email_key = $1`, [failureKey(normalizeEmail(email))])
    } catch (err) {
      failuresTrouble('reset', err)
    }
  }
  /** The account is gone: its known sources too (memory and db/057). Best effort. */
  async function forgetSources(email) {
    if (!email) return
    knownSources.delete(email)
    for (const k of laneSlots.keys()) if (k.startsWith(`${email}|`)) laneSlots.delete(k)
    try {
      if (!sourceMacKey || !T.sources || !(await columnsOf(cfg.signInSourcesTable)).size) return
      await pool.query(`DELETE FROM ${T.sources} WHERE email_key = $1`, [failureKey(email)])
    } catch (err) {
      failuresTrouble('forget sources', err)
    }
  }
  /** clearLocks and the database counter: every lock of the address goes. */
  async function clearAllLocks(email) {
    clearLocks(email)
    await forgetFailures(email)
  }

  /**
   * The address is past its ceiling: its account (if there is one) is mailed
   * and the admins are told (options.onSignInAttack: server.js, the error
   * tracker), once per window. An address without an account tells nobody.
   */
  async function tellOfAttempts(email, failures) {
    const user = await findUserByEmail(email)
    if (!user || isUserBlocked(user)) return
    const hours = Math.round(cfg.accountCeiling.windowMs / 3600000)
    log.warn?.(`[auth] ${failures} failed sign-ins for ${maskEmail(user.email)} within ${hours} h: new sources are slowed down, the account and the admins are told`)
    if (typeof cfg.onSignInAttack === 'function') {
      try { await cfg.onSignInAttack({ userId: user.id, failures, windowHours: hours }) } catch (err) { log.error(`[auth] sign-in attempts alert failed: ${err?.message}`) }
    }
    if (!mailer.enabled) return
    // the brand of its memberships, as audit() does: OpenBeach only gives 'beach'
    let app = 'indoor'
    if (T.memberships && (await columnsOf(cfg.membershipsTable)).size) {
      const { rows } = await pool.query(`SELECT app FROM ${T.memberships} WHERE user_id = $1`, [user.id])
      if (rows.length && rows.every((m) => m.app === 'beach')) app = 'beach'
    }
    const lang = pickLang(isPlainObject(user.raw_user_meta_data) ? user.raw_user_meta_data.mail_lang : null)
    await mailer.send('sign_in_attempts', { to: user.email, lang, app, vars: { count: failures } })
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

  /**
   * Best-effort audit entry (never fails the request). With db/012 the entry
   * carries the app whose audit lists it (audit_log.app: 'beach', NULL =
   * indoor), taken from the account's memberships: a member of OpenBeach only
   * gives 'beach'; a member of both gives the request's `app` (requestApp);
   * any other account (no membership row counts as indoor) stays indoor. The
   * tag only sorts the entry into an admin list, it never authorises anything.
   */
  async function audit(action, targetUserId, details = {}, requestedApp = 'indoor') {
    if (!T.audit) return
    try {
      const cols = await columnsOf(cfg.auditTable)
      if (!cols.size) return
      if (cols.has('app') && T.memberships && (await columnsOf(cfg.membershipsTable)).size) {
        await pool.query(
          `INSERT INTO ${T.audit} (actor_id, action, target_user_id, details, app)
           VALUES ($1, $2, $1, $3::jsonb,
                   (SELECT CASE WHEN EXISTS (SELECT 1 FROM ${T.memberships} m WHERE m.user_id = $1::uuid AND m.app = 'beach')
                                 AND ($4::text = 'beach'
                                      OR NOT EXISTS (SELECT 1 FROM ${T.memberships} m WHERE m.user_id = $1::uuid AND m.app <> 'beach'))
                                THEN 'beach' END))`,
          [targetUserId, action, JSON.stringify(details), requestedApp === 'beach' ? 'beach' : 'indoor']
        )
        return
      }
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
  // db/028: a new account's address is confirmed: its admins and approvers
  // are told (lib/signupNotices.js, options.onAccountConfirmed), never awaited
  function accountConfirmed(userId) {
    if (typeof cfg.onAccountConfirmed !== 'function') return
    background('sign-up notice', () => cfg.onAccountConfirmed(userId))
  }
  async function settle() {
    while (pending.size) await Promise.allSettled([...pending])
  }

  function mailLang(body, ctx) {
    return pickLang(body.lang, ctx.headers?.['accept-language'])
  }

  /** The brand of a request (`app`): 'indoor' (also when absent or unknown) or 'beach'. */
  function requestApp(body) {
    return mailApp(body.app)
  }

  /** The link base of a brand: the mailer's table (a test stand-in without one: the brand default for beach). */
  function managerUrlFor(app) {
    if (typeof mailer.managerUrlFor === 'function') return mailer.managerUrlFor(app)
    return app === 'beach' ? MAIL_BRANDS.beach.managerUrl : mailer.managerUrl
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

    // Locks are per account AND source (address bucket): wrong passwords from
    // elsewhere do not lock the owner out. Counts this attempt as in flight
    // before any await, so parallel requests cannot all slip past the lockout
    // before the first failure is recorded.
    const source = ipKey(ctx.ip)
    const key = lockKey(email, source)
    const locked = (retryAfterSec) => {
      const mins = Math.max(1, Math.ceil(retryAfterSec / 60))
      return rateLimited(retryAfterSec, 'account_locked',
        `Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`)
    }
    const ceiling = accountLockout?.check(email)
    const pastCeiling = ceiling?.locked && !knownSource(email, source)
    const newSourceTry = pastCeiling ? newSourceLockout.begin(key) : null
    if (newSourceTry?.locked) return locked(ceiling.retryAfterSec)
    const attempt = typeof lockout.begin === 'function' ? lockout.begin(key) : lockout.check(key)
    if (attempt.locked) { newSourceTry?.release?.(); return locked(attempt.retryAfterSec) }
    const failed = async () => {
      lockout.fail(key)
      if (newSourceTry) newSourceLockout.fail(key)
      accountLockout?.fail(email)
      failedSources.set(source, Date.now())
      await recordFailure(email) // db/057: counted for the address, known or not
      return INVALID_CREDENTIALS()
    }
    try {
      const blockedEmail = limit('signInEmail', key)
      if (blockedEmail) return blockedEmail
      // Last, so requests refused above never use up the global budget; and
      // only for sources that failed lately (see DEFAULTS.limits.signInGlobal).
      const lastFail = failedSources.get(source)
      const failedLately = lastFail != null && Date.now() - lastFail < FAILED_SOURCE_MS
      if (failedLately && limits.signInGlobal?.hit('*').limited) return BUSY()
      // db/057: past the address's ceiling only a source that signed in to it
      // before goes on as usual (SEC-13)
      const known = knownSource(email, source)
      const ceilingLock = await ceilingCheck(email, known, { bucket: source, lane: laneKey(ctx.ip) })
      if (ceilingLock?.retryAfterSec) return locked(ceilingLock.retryAfterSec)

      let cols, user, passwordOk
      try {
        cols = await usersColumns()
        user = await findUserByEmail(email)
        // The bcrypt gate is fair between clients, and a source that signed in
        // to this account before (and did not fail since) goes first: a flood
        // of made-up sign-ins cannot turn its owner away (SEC-03)
        passwordOk = await checkPassword(password, user?.encrypted_password, gateFor(ctx.ip, known && !failedLately, email))
      } catch (err) {
        // the password was not checked (auth_busy, the database): the try goes back
        await returnClaim(ceilingLock?.claim)
        throw err
      }
      if (!passwordOk || isUserBlocked(user) || isUnconfirmed(user, cols)) return await failed()
      const session = await createSession(user.id, user.encrypted_password)
      if (!session) return await failed() // password changed or account deleted while we were checking
      lockout.succeed(key)
      await noteKnownSource(email, source)
      return await finishSignIn(user, cols, session)
    } finally {
      attempt.release?.()
      newSourceTry?.release?.()
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
    // The licence number (db/048): 4 to 7 digits; '' or null is none, which
    // a server with licenceRequired refuses (owner 23.11.2026)
    if (meta.license_number === '' || meta.license_number === null) delete meta.license_number
    if (meta.license_number === undefined) {
      if (cfg.licenceRequired) return fail(422, 'A licence number is required (4 to 7 digits)', 'licence_required')
    } else {
      const lic = typeof meta.license_number === 'number' && Number.isInteger(meta.license_number) ? String(meta.license_number)
        : (typeof meta.license_number === 'string' ? meta.license_number.trim() : null)
      if (lic === null || !LICENSE_RE.test(lic)) return fail(422, 'Invalid licence number (4 to 7 digits)', 'validation_failed')
      meta.license_number = lic
    }
    // db/025: what the account asks for (checked before the password is hashed)
    const asked = cfg.signUpRequests ? cfg.signUpRequests.parse(body.requests, { app: requestApp(body) }) : { rows: [] }
    if (asked.error) return fail(422, asked.error, 'validation_failed')
    // The language picked at sign-up: the account's later mails (the final
    // scoresheet, lib/finalMail.js) go out in it, as the confirmation does
    meta.mail_lang = mailLang(body, ctx)

    const hash = await hashPassword(body.password, gateFor(ctx.ip))
    const id = randomUUID()
    // With a mailer and db/010 the address stays unconfirmed and gets a link;
    // otherwise the account is confirmed at once (as before).
    const linkPossible = mailer.enabled && await tokensAvailable()
    let confirmToken = null
    const app = requestApp(body)
    const signUpApp = body.app === undefined || body.app === null ? null : app

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
            // names: one line, at most 80 characters (they reach other people's mails)
            const name = (v) => { const t = text(v); return t == null ? null : t.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) }
            put('first_name', name(meta.first_name))
            put('last_name', name(meta.last_name))
            put('country', text(meta.country) ?? cfg.defaultCountry)
            put('license_number', meta.license_number ?? null)
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
        // The app it signed up in (only when the client named one: without,
        // no row, which counts as indoor, as for every older client)
        if (signUpApp && T.memberships && (await columnsOf(cfg.membershipsTable, client)).size) {
          await client.query(
            `INSERT INTO ${T.memberships} (user_id, app, joined_via) VALUES ($1, $2, 'signup') ON CONFLICT DO NOTHING`,
            [id, signUpApp])
        }
        // db/025: its requests, in the same transaction (granted later by an approver)
        if (asked.rows.length) await cfg.signUpRequests.store(client, id, asked.rows)
        if (byLink) confirmToken = await issueToken(client, id, 'confirm')
        return ins.rows[0].u
      })
      if (!user) return await alreadyRegistered(email, body, ctx, { linkPossible, meta })
      if (confirmToken) {
        const lang = mailLang(body, ctx)
        const link = authLink(managerUrlFor(app), 'confirm', confirmToken, lang)
        // email_confirmation: 'sent' tells the app it may sign in right away;
        // 'queued' that it may too, but the hourly budget holds the mail back
        // until its window ends (older apps read it as "check your email").
        if (confirmBudgetFull()) {
          queueConfirmation({ to: user.email, lang, link, app })
          return ok({ user: publicUser(user), email_confirmation: 'queued' })
        }
        background('sign-up confirmation mail', async () => {
          const r = await mailer.send('confirm', { to: user.email, lang, link, app })
          if (r?.sent) log.log?.(`[auth] confirmation link sent to ${maskEmail(user.email)}`)
          else if (r?.skipped === 'budget') queueConfirmation({ to: user.email, lang, link, app })
        })
        return ok({ user: publicUser(user), email_confirmation: 'sent' })
      }
      // Confirmed at once (no mailer or no db/010): the approvers hear of it now
      accountConfirmed(user.id)
      return ok({ user: publicUser(user) })
    } catch (err) {
      // db/025: a club or team asked for is gone (the form was loaded before)
      if (err?.signUpRequests) return fail(422, err.message, 'validation_failed')
      if (err.code === '23505') return await alreadyRegistered(email, body, ctx, { linkPossible, meta })
      // invalid_text_representation / datetime / invalid enum label etc. in metadata
      if (err.code === '22007' || err.code === '22008' || err.code === '22P02' || err.code === '22023') {
        return fail(422, 'Invalid profile data', 'validation_failed')
      }
      throw err
    }
  }

  /**
   * Sign-up of an address that has an account. With mail on, the answer is
   * the one a new account gets (no address oracle) and the owner is mailed a
   * reset link instead (per inbox limit resetEmail); without mail, 422
   * user_already_exists as before (the account would be confirmed at once,
   * so a uniform answer would hide nothing).
   */
  async function alreadyRegistered(email, body, ctx, { linkPossible, meta }) {
    if (!linkPossible) return fail(422, 'A user with this email address has already been registered', 'user_already_exists')
    const app = requestApp(body)
    const lang = mailLang(body, ctx)
    if (!limits.resetEmail || !limits.resetEmail.hit(mailboxKey(email)).limited) {
      background('sign-up of a known address: reset mail', async () => {
        const user = await findUserByEmail(email)
        if (!user || isUserBlocked(user)) return
        const token = await withTransaction((client) => issueToken(client, user.id, 'reset'))
        await audit('account.password_reset_requested', user.id, { via: 'sign-up' }, app)
        await mailer.send('reset', { to: user.email, lang, app, link: authLink(managerUrlFor(app), 'reset', token, lang) })
      })
    }
    // The user object a new account gets, to the byte (audit 2611 SEC-14):
    // the row createAccount would insert, as Postgres gives it back (to_jsonb:
    // timestamps with microseconds and the offset, metadata in jsonb's key
    // order) and with the same app metadata (the link mark), without
    // inserting it. Old apps read the user object, so it stays.
    const ucols = await usersColumns()
    const byLink = writable(ucols, 'email_confirmed_at') && writable(ucols, 'raw_app_meta_data')
    const values = { id: randomUUID(), email }
    if (writable(ucols, 'raw_user_meta_data')) values.raw_user_meta_data = meta
    if (writable(ucols, 'raw_app_meta_data')) {
      values.raw_app_meta_data = { provider: 'email', providers: ['email'] }
      if (byLink) values.raw_app_meta_data[EMAIL_CONFIRMATION_MARK.key] = EMAIL_CONFIRMATION_MARK.value
    }
    if (writable(ucols, 'aud')) values.aud = 'authenticated'
    if (writable(ucols, 'role')) values.role = 'authenticated'
    const nowCols = [...(byLink ? [] : ['email_confirmed_at']), 'created_at', 'updated_at'].filter(c => writable(ucols, c))
    const nowJson = nowCols.length ? ` || jsonb_build_object(${nowCols.map(c => `'${c}', now()`).join(', ')})` : ''
    const { rows } = await pool.query(
      `SELECT to_jsonb(r) AS u FROM jsonb_populate_record(NULL::${T.users}, $1::jsonb${nowJson}) r`,
      [JSON.stringify(values)])
    return ok({ user: publicUser(rows[0].u), email_confirmation: confirmBudgetFull() ? 'queued' : 'sent' })
  }

  // Confirmation mails the hourly budget held back: sent when the window
  // ends (the links stay valid 24 h). In memory: after a restart the account
  // asks for a new one (resend-confirmation).
  const CONFIRM_QUEUE_MAX = 2000
  const confirmQueue = []
  let confirmTimer = null
  function confirmBudgetFull() {
    const b = mailer.budgets?.confirm
    return !!b && b.used >= b.max
  }
  function queueConfirmation(mail) {
    if (confirmQueue.length >= CONFIRM_QUEUE_MAX) {
      const lost = confirmQueue.shift()
      log.error(`[auth] confirmation queue full; the held-back mail to ${maskEmail(lost.to)} is dropped (it can be sent again from the profile)`)
    }
    confirmQueue.push(mail)
    scheduleConfirmations()
  }
  function scheduleConfirmations() {
    if (confirmTimer || !confirmQueue.length) return
    const wait = Math.min(60 * 60 * 1000, (mailer.budgets?.confirm?.resetsInMs ?? 60_000) + 1000)
    confirmTimer = setTimeout(() => { confirmTimer = null; flushConfirmations() }, wait)
    confirmTimer.unref?.()
  }
  function flushConfirmations() {
    background('held-back confirmation mails', async () => {
      while (confirmQueue.length) {
        const mail = confirmQueue[0]
        const r = await mailer.send('confirm', mail)
        if (r?.skipped === 'budget') break
        confirmQueue.shift()
        if (r?.sent) log.log?.(`[auth] held-back confirmation link sent to ${maskEmail(mail.to)}`)
      }
      scheduleConfirmations()
    })
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

  /**
   * POST delete-account { access_token, password | passkey }: the session
   * alone is not enough (reauth). The admin path's rules apply in the
   * deletion's transaction (cfg.selfDelete): never the last super admin (409
   * OV_LAST_SUPER_ADMIN), an account.delete audit entry.
   */
  async function deleteAccount(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    const token = bearerOf(body, ctx)
    const denied = await confirmIdentity(body, token, v.user.id, ctx)
    if (denied) return denied
    const userId = v.user.id
    try {
      await eraseAccount(userId, { inTransaction: typeof cfg.selfDelete === 'function' ? (client) => cfg.selfDelete(client, userId) : null })
    } catch (err) {
      if (err?.__result) return result(err.__result.status, err.__result.body)
      throw err
    }
    forgetFresh(token)
    return ok(null)
  }

  /**
   * Deletes an account and its personal data and keeps the match records
   * (README "Deleting an account"). One code path for both ways in: the
   * account's own delete-account and an admin's delete or reject in the
   * manager (lib/accounts.js deleteAccount, POST /api/admin/accounts/:id/delete|reject).
   *
   * One transaction: `inTransaction(client)` first (the caller's locks,
   * refusal rules and audit entry; whatever it throws rolls everything back
   * and is thrown on), so a refusal (403, 409) leaves the account with all it
   * had, its files included. Then the files, while those locks are held: when
   * they cannot be removed nothing is deleted (throws, 503), so the account is
   * never gone while its backups stay behind. Then the sessions, the owned
   * rows, the detached columns, the users row.
   * Throws on a database error. Returns { deleted: false } when there was no
   * such users row (nothing was deleted but the files), else { deleted: true }.
   */
  async function eraseAccount(userId, { inTransaction = null } = {}) {
    if (typeof userId !== 'string' || !userId) throw new Error('eraseAccount: a user id is required')
    const email = await withTransaction(async (client) => {
      if (typeof inTransaction === 'function') await inTransaction(client)
      if (typeof cfg.onAccountDeleted === 'function') await cfg.onAccountDeleted(userId)
      await revokeUserSessions(userId, client)
      for (const { table, column } of cfg.ownedTables) {
        const cols = await columnsOf(table, client)
        if (!cols.has(column)) continue
        await client.query(`DELETE FROM ${qualify(table)} WHERE ${quoteIdent(column)} = $1`, [userId])
      }
      for (const { table, column, where, needs } of cfg.ownedRows || []) {
        const cols = await columnsOf(table, client)
        if (!cols.has(column) || (needs && !cols.has(needs))) continue
        await client.query(`DELETE FROM ${qualify(table)} WHERE ${quoteIdent(column)} = $1 AND ${where}`, [userId])
      }
      for (const { table, column } of cfg.detachedColumns) {
        const cols = await columnsOf(table, client)
        if (!cols.has(column)) continue
        await client.query(`UPDATE ${qualify(table)} SET ${quoteIdent(column)} = NULL WHERE ${quoteIdent(column)} = $1`, [userId])
      }
      const { rows } = await client.query(`DELETE FROM ${T.users} WHERE id = $1 RETURNING email`, [userId])
      return rows.length ? (rows[0].email ?? '') : null
    })
    if (email) {
      await clearAllLocks(normalizeEmail(email))
      await forgetSources(normalizeEmail(email))
    }
    // Second pass: an upload that passed its session check before the
    // sessions were revoked may have landed in between. Best effort.
    if (typeof cfg.onAccountDeleted === 'function') {
      try {
        await cfg.onAccountDeleted(userId)
      } catch (err) {
        log.error('[auth] delete-account: file clean-up after the commit failed:', err.message)
      }
    }
    return { deleted: email !== null }
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
   * POST reset-password { email, lang, app }. Rate-limited per client and per
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
    const app = requestApp(body)
    background('reset-password mail', async () => {
      const user = await findUserByEmail(email)
      if (!user || isUserBlocked(user)) return
      const token = await withTransaction((client) => issueToken(client, user.id, 'reset'))
      await audit('account.password_reset_requested', user.id, {}, app)
      const r = await mailer.send('reset', { to: user.email, lang, app, link: authLink(managerUrlFor(app), 'reset', token, lang) })
      if (r?.sent) log.log?.(`[auth] reset link sent to ${maskEmail(user.email)}`)
    })
    return RESET_REQUESTED()
  }

  /**
   * POST reset-password/confirm { token, password, lang, app }: the new password
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
      `SELECT user_id FROM ${T.tokens} WHERE hash = $1 AND purpose = 'reset' AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token)]
    )
    if (!pre.rows.length) return INVALID_LINK()
    const adminProblem = validateNewPassword(body.password, await minPasswordFor(pre.rows[0].user_id))
    if (adminProblem) return fail(422, adminProblem, 'weak_password')
    const hash = await hashPassword(body.password, gateFor(ctx.ip))
    const out = await withTransaction(async (client) => {
      const t = await consumeToken(client, token, 'reset')
      if (t.state !== 'ok') return null
      // An address nobody confirmed yet (a sign-up, maybe with someone else's
      // address, SEC-15): this password confirms it, and of what the sign-up
      // gave only what the body keeps stays (`keep`; none without it)
      const unconfirmed = await addressUnconfirmedIn(client, t.userId, { forUpdate: true })
      const kept = unconfirmed ? await keepSignUpDetailsIn(client, t.userId, keptDetails(body.keep)) : null
      const r = await setPasswordIn(client, t.userId, hash, { confirmEmail: true })
      return { ...r, confirmedNow: unconfirmed && r.emailConfirmed, kept }
    })
    if (!out) return INVALID_LINK()
    await clearAllLocks(out.email)
    await audit('account.password_reset', out.userId, { sessions_revoked: out.revokedSessions }, requestApp(body))
    if (out.confirmedNow) {
      // the approvers hear of the sign-up now, of what its owner kept
      await audit('account.email_confirmed', out.userId, { with_password_reset: true, ...out.kept }, requestApp(body))
      accountConfirmed(out.userId)
    }
    if (mailer.enabled) {
      const lang = mailLang(body, ctx)
      const app = requestApp(body)
      background('password-changed mail', () => mailer.send('password_changed', { to: out.email, lang, app }))
    }
    return ok({ password_updated: true })
  }

  /** Is the address of `userId` unconfirmed (the users table tracks it, and it is NULL)? */
  async function addressUnconfirmedIn(client, userId, { forUpdate = false } = {}) {
    const cols = await usersColumns(client)
    if (!cols.has('email_confirmed_at')) return false
    const { rows } = await client.query(
      `SELECT email_confirmed_at IS NULL AS open FROM ${T.users} WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [userId])
    return rows[0]?.open === true
  }

  /**
   * What the sign-up of an address nobody confirmed yet gave (audit 2611
   * SEC-15, review I-3): the profile's name and licence number and the open
   * requests (db/025, also those a team manager proposed since). Whoever
   * signed up may not own the address: the owner keeps or drops each part
   * with the password that confirms it (reset-password/confirm `keep`).
   * -> null (confirmed, or nothing given) or { first_name, last_name,
   * license_number, requests: [{ id, kind, club_id, club_name, team_id, team_name }] }.
   */
  async function signUpDetailsIn(client, userId) {
    if (!(await addressUnconfirmedIn(client, userId))) return null
    const text = (v) => (typeof v === 'string' && v.trim() ? v : null)
    const out = { first_name: null, last_name: null, license_number: null, requests: [] }
    if (T.profiles) {
      const pcols = await columnsOf(cfg.profilesTable, client)
      const want = ['first_name', 'last_name', 'license_number'].filter((c) => pcols.has(c))
      if (want.length) {
        const { rows } = await client.query(
          `SELECT ${want.map(quoteIdent).join(', ')} FROM ${T.profiles} WHERE ${quoteIdent(cfg.profileUserIdColumn)} = $1 LIMIT 1`, [userId])
        for (const c of want) out[c] = text(rows[0]?.[c] == null ? null : String(rows[0][c]))
      }
    }
    let parts = []
    if (typeof cfg.signUpRequests?.list === 'function') {
      parts = await cfg.signUpRequests.list(client, userId)
    } else if (T.requests && (await columnsOf(cfg.accountRequestsTable, client)).has('user_id')) {
      parts = (await client.query(`SELECT id, kind, club_id, team_id FROM ${T.requests} WHERE user_id = $1 ORDER BY created_at, id`, [userId])).rows
    }
    out.requests = (parts || []).map((r) => ({
      id: r.id, kind: r.kind, club_id: r.club_id ?? null, club_name: r.club_name ?? null, team_id: r.team_id ?? null, team_name: r.team_name ?? null
    }))
    if (!out.first_name && !out.last_name && !out.license_number && !out.requests.length) return null
    return out
  }

  /** The `keep` of a reset-password/confirm body; absent or malformed: keep nothing. */
  function keptDetails(keep) {
    if (!isPlainObject(keep)) return { name: false, licence: false, requests: [] }
    const ids = Array.isArray(keep.requests)
      ? [...new Set(keep.requests.filter((id) => typeof id === 'string' && UUID_RE.test(id)).map((id) => id.toLowerCase()))].slice(0, 100)
      : []
    return { name: keep.name === true, licence: keep.licence === true, requests: ids }
  }

  /**
   * In the caller's transaction: of what the sign-up gave only `keep`
   * (keptDetails) stays; the name, the licence number and every request not
   * kept go. -> { name, licence, requests_kept, requests_dropped }
   */
  async function keepSignUpDetailsIn(client, userId, keep) {
    const out = { name: keep.name, licence: keep.licence, requests_kept: 0, requests_dropped: 0 }
    if (T.profiles) {
      const pcols = await columnsOf(cfg.profilesTable, client)
      const clear = [...(keep.name ? [] : ['first_name', 'last_name']), ...(keep.licence ? [] : ['license_number'])].filter((c) => writable(pcols, c))
      if (clear.length) {
        const set = clear.map((c) => `${quoteIdent(c)} = NULL`)
        if (writable(pcols, 'updated_at')) set.push('updated_at = now()')
        await client.query(`UPDATE ${T.profiles} SET ${set.join(', ')} WHERE ${quoteIdent(cfg.profileUserIdColumn)} = $1`, [userId])
      }
    }
    const rcols = T.requests ? await columnsOf(cfg.accountRequestsTable, client) : new Map()
    if (rcols.has('user_id') && rcols.has('id')) {
      const { rowCount } = await client.query(
        `DELETE FROM ${T.requests} WHERE user_id = $1 AND NOT (id = ANY($2::uuid[]))`, [userId, keep.requests])
      out.requests_dropped = rowCount
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${T.requests} WHERE user_id = $1`, [userId])
      out.requests_kept = rows[0].n
    }
    return out
  }

  /**
   * POST reset-password/details { token }: what the sign-up of a not yet
   * confirmed address gave, for the reset link's page (the link proves the
   * inbox, as it does for the new password). Spends nothing.
   * 200 { signup_details: null | {...} } (signUpDetailsIn); 400 invalid_link.
   */
  async function resetLinkDetails(body, ctx) {
    const blocked = limit('tokenIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const token = body.token
    if (!isWellFormedToken(token)) return INVALID_LINK()
    if (!(await tokensAvailable())) return RESET_UNAVAILABLE()
    const { rows } = await pool.query(
      `SELECT user_id FROM ${T.tokens} WHERE hash = $1 AND purpose = 'reset' AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token)])
    if (!rows.length) return INVALID_LINK()
    return ok({ signup_details: await signUpDetailsIn(pool, rows[0].user_id) })
  }

  /**
   * POST confirm-email { token, password? } (an `app` is ignored): marks the
   * address confirmed. An account created with a link may have been made by
   * someone else with this address: unless the clicker gives the account's
   * password, whoever signed up loses the account (password, sessions and
   * passkeys go) and the answer carries set_password_token, a reset link
   * token for the clicker to choose a password (the click proved the inbox,
   * as a reset link does). That password confirms the address
   * (confirmPasswordReset): the clicker sees what the sign-up gave (the
   * name, the licence number, the requests: reset-password/details) and
   * keeps what is theirs, and only then are the approvers told (SEC-15,
   * review I-3). Until then the address stays unconfirmed, so nothing of it
   * can be approved.
   */
  async function confirmEmailLink(body, ctx) {
    const blocked = limit('tokenIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const token = body.token
    if (!isWellFormedToken(token)) return INVALID_LINK()
    if (!(await tokensAvailable())) return CONFIRM_UNAVAILABLE()
    // The password check runs before the transaction (bcrypt holds no lock)
    let passwordOk = false
    if (typeof body.password === 'string' && body.password && body.password.length <= 1024) {
      const { rows } = await pool.query(
        `SELECT u.encrypted_password FROM ${T.tokens} t JOIN ${T.users} u ON u.id = t.user_id
          WHERE t.hash = $1 AND t.purpose = 'confirm' AND t.used_at IS NULL AND t.expires_at > now()`, [hashToken(token)])
      if (rows[0]) passwordOk = await checkPassword(body.password, rows[0].encrypted_password, gateFor(ctx.ip))
    }
    let setPasswordToken = null
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
      const { rows: urows } = await client.query(`SELECT to_jsonb(u) AS u FROM ${T.users} u WHERE u.id = $1 FOR UPDATE`, [t.userId])
      if (confirmsByLink(urows[0]?.u) && urows[0].u.email_confirmed_at == null && !passwordOk) {
        // Not shown to be the one who signed up: their password, sessions
        // and passkeys go; the address is confirmed with the clicker's new
        // password, which keeps what the clicker keeps of the details
        // (confirmPasswordReset, SEC-15)
        const r = await setPasswordIn(client, t.userId, `!unset:${generateToken()}`)
        setPasswordToken = await issueToken(client, t.userId, 'reset')
        return { userId: t.userId, already: false, reset: true, revokedSessions: r.revokedSessions }
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
    if (out.reset) {
      // confirmed (and the approvers told) with the clicker's new password
      await audit('account.password_reset', out.userId, { password_cleared: true, sessions_revoked: out.revokedSessions })
    } else if (!out.already) {
      await audit('account.email_confirmed', out.userId, {})
      accountConfirmed(out.userId)
    }
    if (setPasswordToken) await clearAllLocks(normalizeEmail((await findUserId(out.userId)).email))
    return ok({ confirmed: true, already_confirmed: out.already, ...(setPasswordToken ? { set_password_token: setPasswordToken } : {}) })
  }

  /** POST resend-confirmation { access_token, lang, app }: a fresh link for the signed-in, unconfirmed account. */
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
    const app = requestApp(body)
    try {
      const r = await mailer.send('confirm', { to: v.user.email, lang, app, link: authLink(managerUrlFor(app), 'confirm', token, lang) })
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
  // --- passkeys (lib/passkeys.js) ---------------------------------------------
  // Sign-in with the device's fingerprint, face or PIN, for an account that
  // has a password. Setting one up needs the password (a stolen session must
  // not be able to add its own key), a new password removes them all
  // (setPasswordIn), and every set-up is mailed to the account's address.
  const ceremonies = createPasskeyCeremonies(cfg.passkeyConfig || passkeyConfig())
  const PASSKEYS_UNAVAILABLE = () => fail(503, 'Passkeys are not available on this server.', 'passkeys_unavailable')
  const PASSKEY_EXPIRED = () => fail(400, 'That took too long. Please try again.', 'passkey_expired')
  const PASSKEY_UNKNOWN = () => fail(401, 'This passkey is not, or no longer, known here.', 'passkey_unknown')
  const PASSKEY_INVALID = (status = 401) => fail(status, 'The passkey could not be verified.', 'passkey_invalid')
  const PASSKEY_LIMIT = () => fail(400, `This account already has ${PASSKEYS_PER_USER_MAX} passkeys. Remove one first.`, 'passkey_limit')
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  function passkeyRow(r) {
    return { id: r.id, userId: r.user_id, credentialId: r.credential_id, publicKey: r.public_key, counter: Number(r.counter) || 0, transports: cleanTransports(r.transports) }
  }

  function bearerOf(body, ctx) {
    return typeof body.access_token === 'string' && body.access_token ? body.access_token : bearerFromHeaders(ctx.headers)
  }

  /**
   * A session for an account that just proved a passkey, made only while the
   * key row still stands: FOR SHARE waits for a concurrent new password (which
   * deletes the keys), a removal of the key or the account's deletion, and
   * then re-checks. Returns null when the key is gone.
   */
  async function createPasskeySession(userId, passkeyId, client = pool) {
    const token = generateToken()
    const { rows } = await client.query(
      `INSERT INTO ${T.sessions} (token_hash, user_id, created_at, expires_at, last_seen_at)
       SELECT $1, u.id, now(), now() + make_interval(secs => $3), now()
         FROM ${T.users} u
         JOIN ${T.passkeys} p ON p.user_id = u.id AND p.id = $4
        WHERE u.id = $2
          FOR SHARE OF u, p
       RETURNING floor(extract(epoch FROM expires_at))::bigint AS expires_at`,
      [hashToken(token), userId, Math.min(cfg.sessionTtlSec, cfg.absoluteTtlSec), passkeyId]
    )
    if (!rows[0]) return null
    return { token, expiresAt: Number(rows[0].expires_at) }
  }

  async function passkeyLoginOptions(body, ctx) {
    const blocked = limit('passkeyIp', ipKey(ctx.ip))
    if (blocked) return blocked
    if (!(await passkeysAvailable())) return PASSKEYS_UNAVAILABLE()
    return ok(await ceremonies.authenticationOptions({ bucket: ipKey(ctx.ip) }))
  }

  async function passkeyLogin(body, ctx) {
    const blocked = limit('passkeyIp', ipKey(ctx.ip))
    if (blocked) return blocked
    if (!(await passkeysAvailable())) return PASSKEYS_UNAVAILABLE()
    let verified
    try {
      verified = await ceremonies.finishAuthentication({
        challengeId: typeof body.challengeId === 'string' ? body.challengeId : '',
        response: isPlainObject(body.response) ? body.response : {},
        lookup: async (credentialId) => {
          const { rows } = await pool.query(`SELECT * FROM ${T.passkeys} WHERE credential_id = $1`, [credentialId])
          return rows[0] ? passkeyRow(rows[0]) : null
        }
      })
    } catch (err) {
      if (!(err instanceof PasskeyError)) throw err
      if (err.code === 'challenge') return PASSKEY_EXPIRED()
      if (err.code === 'unknown') return PASSKEY_UNKNOWN()
      log.warn?.(`[auth] passkey sign-in refused: ${err.code}`)
      return PASSKEY_INVALID()
    }
    const { passkey, newCounter } = verified
    const cols = await usersColumns()
    const { rows } = await pool.query(`SELECT to_jsonb(u) AS u FROM ${T.users} u WHERE u.id = $1`, [passkey.userId])
    const user = rows[0]?.u
    if (!user || isUserBlocked(user)) return PASSKEY_INVALID()
    await pool.query(`UPDATE ${T.passkeys} SET counter = $2, last_used_at = now() WHERE id = $1`, [passkey.id, newCounter])
    const session = await createPasskeySession(user.id, passkey.id)
    if (!session) return PASSKEY_UNKNOWN() // removed (or a new password set) while we were checking
    return await finishSignIn(user, cols, session)
  }

  async function passkeyRegisterOptions(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    if (!(await passkeysAvailable())) return PASSKEYS_UNAVAILABLE()
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    const userId = v.user.id
    const blockedUser = limit('passkeyUser', userId)
    if (blockedUser) return blockedUser
    const password = typeof body.password === 'string' ? body.password : ''
    if (!password || password.length > 1024) return fail(400, 'Your password is needed to add a passkey.', 'password_required')
    const check = await verifyPassword(userId, password, ctx)
    if (check.locked) {
      const mins = Math.max(1, Math.ceil(check.retryAfterSec / 60))
      return rateLimited(check.retryAfterSec, 'account_locked', `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`)
    }
    if (!check.ok) return fail(401, 'Wrong password.', 'invalid_password')
    const { rows } = await pool.query(`SELECT credential_id, transports FROM ${T.passkeys} WHERE user_id = $1`, [userId])
    if (rows.length >= PASSKEYS_PER_USER_MAX) return PASSKEY_LIMIT()
    return ok(await ceremonies.registrationOptions({
      userId,
      email: v.user.email,
      existing: rows.map((r) => ({ credentialId: r.credential_id, transports: cleanTransports(r.transports) }))
    }))
  }

  async function passkeyRegister(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    if (!(await passkeysAvailable())) return PASSKEYS_UNAVAILABLE()
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    const userId = v.user.id
    const blockedUser = limit('passkeyUser', userId)
    if (blockedUser) return blockedUser
    let added
    try {
      // The challenge was issued only after the password was checked, and to
      // this account only.
      added = await ceremonies.finishRegistration({
        challengeId: typeof body.challengeId === 'string' ? body.challengeId : '',
        userId,
        response: isPlainObject(body.response) ? body.response : {}
      })
    } catch (err) {
      if (!(err instanceof PasskeyError)) throw err
      if (err.code === 'challenge' || err.code === 'mismatch') return PASSKEY_EXPIRED()
      log.warn?.(`[auth] passkey set-up refused: ${err.code}`)
      return PASSKEY_INVALID(400)
    }
    const blockedAdded = limit('passkeyAddedUser', userId)
    if (blockedAdded) return blockedAdded
    const label = passkeyDeviceLabel(ctx.headers?.['user-agent']).slice(0, 80)
    const token = bearerOf(body, ctx)
    const outcome = await withTransaction(async (client) => {
      // The account and THIS session still stand: FOR SHARE waits for a
      // concurrent new password or deletion (both delete the sessions) and
      // then finds nothing, so no key is filed after either.
      const live = await client.query(
        `SELECT 1 FROM ${T.users} u JOIN ${T.sessions} s ON s.user_id = u.id AND s.token_hash = $2
          WHERE u.id = $1 FOR SHARE OF u, s`,
        [userId, hashToken(token)]
      )
      if (!live.rows[0]) return { gone: true }
      const count = await client.query(`SELECT count(*)::int AS n FROM ${T.passkeys} WHERE user_id = $1`, [userId])
      if (count.rows[0].n >= PASSKEYS_PER_USER_MAX) return { limit: true }
      const ins = await client.query(
        `INSERT INTO ${T.passkeys} (user_id, credential_id, public_key, counter, transports, backed_up, label)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (credential_id) DO NOTHING
         RETURNING id, label, created_at`,
        [userId, added.credentialId, added.publicKey, added.counter, added.transports, added.backedUp, label]
      )
      return ins.rows[0] ? { row: ins.rows[0] } : { duplicate: true }
    })
    if (outcome.gone) return INVALID_TOKEN()
    if (outcome.limit) return PASSKEY_LIMIT()
    if (outcome.duplicate) return fail(409, 'This passkey is already set up.', 'passkey_duplicate')
    const app = requestApp(body)
    await audit('account.passkey_added', userId, { label }, app)
    const lang = mailLang(body, ctx)
    background('passkey-added mail', () => mailer.send('passkey_added', { to: v.user.email, lang, app, vars: { device: label } }))
    return ok({ passkey: publicPasskey({ ...outcome.row, credential_id: added.credentialId, last_used_at: null }) })
  }

  function publicPasskey(r) {
    return { id: r.id, label: r.label || '', created_at: r.created_at, last_used_at: r.last_used_at ?? null, credential_id: r.credential_id }
  }

  async function passkeyList(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    if (!(await passkeysAvailable())) return PASSKEYS_UNAVAILABLE()
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    const { rows } = await pool.query(
      `SELECT id, label, created_at, last_used_at, credential_id FROM ${T.passkeys} WHERE user_id = $1 ORDER BY created_at`,
      [v.user.id]
    )
    return ok({ passkeys: rows.map(publicPasskey) })
  }

  async function passkeyDelete(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    if (!(await passkeysAvailable())) return PASSKEYS_UNAVAILABLE()
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    const id = typeof body.id === 'string' ? body.id : ''
    if (!UUID_RE.test(id)) return fail(400, 'Invalid passkey id', 'validation_failed')
    const token = bearerOf(body, ctx)
    const denied = await confirmIdentity(body, token, v.user.id, ctx)
    if (denied) return denied
    const out = await withTransaction(async (client) => {
      // The account filter is the ownership check.
      const { rows } = await client.query(`DELETE FROM ${T.passkeys} WHERE id = $1 AND user_id = $2 RETURNING label`, [id, v.user.id])
      if (!rows[0]) return null
      // A session does not record the key it was made with: every other
      // session of the account ends (the removed device's among them), this
      // one stays. The removed device then signs in with the password.
      const revoked = await client.query(`DELETE FROM ${T.sessions} WHERE user_id = $1 AND token_hash <> $2`, [v.user.id, hashToken(token)])
      return { label: rows[0].label, revokedSessions: revoked.rowCount }
    })
    if (!out) return fail(404, 'No such passkey', 'not_found')
    await audit('account.passkey_removed', v.user.id, { label: out.label, sessions_revoked: out.revokedSessions }, requestApp(body))
    return ok({ removed: true, revoked_sessions: out.revokedSessions })
  }

  // --- the account's own security --------------------------------------------
  // Deleting the account, removing a passkey and removing every passkey with
  // "sign out everywhere" need more than the session (a tablet left signed
  // in, a copied token): the request carries the account's password or a
  // passkey answer, or the session gave one within REAUTH_FRESH_MS (the
  // reauth action, or an earlier such request), so a person removing two
  // keys confirms once. In this process only: a restart asks once more.
  const freshSessions = new Map() // token hash (hex) -> until (ms)
  const FRESH_SESSIONS_MAX = 10_000
  const freshKey = (token) => hashToken(token).toString('hex')
  function markFresh(token) {
    const key = freshKey(token)
    freshSessions.delete(key)
    freshSessions.set(key, Date.now() + REAUTH_FRESH_MS)
    while (freshSessions.size > FRESH_SESSIONS_MAX) freshSessions.delete(freshSessions.keys().next().value)
  }
  function isFresh(token) {
    const until = freshSessions.get(freshKey(token))
    return until != null && until > Date.now()
  }
  function forgetFresh(token) { freshSessions.delete(freshKey(token)) }

  const REAUTH_REQUIRED = () => fail(403, 'Confirm it is you: enter your password or use your passkey.', 'reauth_required')

  /**
   * The confirmation of a sensitive action by the account `userId` whose
   * session is `token`: `body.password`, or `body.passkey` ({ challengeId,
   * response }: the answer to passkey/login-options with a key of this
   * account), or a recent one of this session. A success marks the session
   * fresh. Returns null when confirmed, else the answer (403 reauth_required,
   * 401 invalid_password, 429 account_locked, 401 passkey_*).
   */
  async function confirmIdentity(body, token, userId, ctx = {}) {
    const password = typeof body.password === 'string' ? body.password : ''
    if (isPlainObject(body.passkey)) {
      if (!(await passkeysAvailable())) return PASSKEYS_UNAVAILABLE()
      let verified
      try {
        verified = await ceremonies.finishAuthentication({
          challengeId: typeof body.passkey.challengeId === 'string' ? body.passkey.challengeId : '',
          response: isPlainObject(body.passkey.response) ? body.passkey.response : {},
          lookup: async (credentialId) => {
            const { rows } = await pool.query(`SELECT * FROM ${T.passkeys} WHERE credential_id = $1 AND user_id = $2`, [credentialId, userId])
            return rows[0] ? passkeyRow(rows[0]) : null
          }
        })
      } catch (err) {
        if (!(err instanceof PasskeyError)) throw err
        if (err.code === 'challenge') return PASSKEY_EXPIRED()
        if (err.code === 'unknown') return PASSKEY_UNKNOWN()
        log.warn?.(`[auth] passkey confirmation refused: ${err.code}`)
        return PASSKEY_INVALID()
      }
      await pool.query(`UPDATE ${T.passkeys} SET counter = $2, last_used_at = now() WHERE id = $1`, [verified.passkey.id, verified.newCounter])
    } else if (password) {
      if (password.length > 1024) return fail(401, 'Wrong password.', 'invalid_password')
      const check = await verifyPassword(userId, password, ctx)
      if (check.locked) {
        const mins = Math.max(1, Math.ceil(check.retryAfterSec / 60))
        return rateLimited(check.retryAfterSec, 'account_locked', `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`)
      }
      if (!check.ok) return fail(401, 'Wrong password.', 'invalid_password')
    } else if (isFresh(token)) {
      return null
    } else {
      return REAUTH_REQUIRED()
    }
    markFresh(token)
    return null
  }

  /** POST reauth { access_token, password | passkey } -> { fresh_until } (ms). */
  async function reauth(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    if (!isPlainObject(body.passkey) && !(typeof body.password === 'string' && body.password)) return REAUTH_REQUIRED()
    const token = bearerOf(body, ctx)
    const denied = await confirmIdentity(body, token, v.user.id, ctx)
    if (denied) return denied
    return ok({ fresh_until: freshSessions.get(freshKey(token)) })
  }

  /**
   * POST change-password { access_token, password, new_password }: the
   * current password, then the new one as a reset sets it (lib setPasswordIn:
   * every session and every passkey of the account go). This device gets a
   * new session, returned like a sign-in's.
   */
  async function changePassword(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    const userId = v.user.id
    const current = typeof body.password === 'string' ? body.password : ''
    if (!current || current.length > 1024) return fail(400, 'Your current password is needed.', 'password_required')
    const next = typeof body.new_password === 'string' ? body.new_password : ''
    const pwProblem = validateNewPassword(next) || validateNewPassword(next, await minPasswordFor(userId))
    if (pwProblem) return fail(422, pwProblem, 'weak_password')
    const check = await verifyPassword(userId, current, ctx)
    if (check.locked) {
      const mins = Math.max(1, Math.ceil(check.retryAfterSec / 60))
      return rateLimited(check.retryAfterSec, 'account_locked', `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`)
    }
    if (!check.ok) return fail(401, 'Wrong password.', 'invalid_password')
    const hash = await hashPassword(next, gateFor(ctx.ip))
    const out = await withTransaction(async (client) => {
      const r = await setPasswordIn(client, userId, hash)
      const session = await createSession(userId, hash, client)
      const { rows } = await client.query(`SELECT to_jsonb(u) AS u FROM ${T.users} u WHERE u.id = $1`, [userId])
      return { ...r, session, user: rows[0]?.u }
    })
    await clearAllLocks(out.email)
    if (!out.session || !out.user) return INVALID_TOKEN()
    await audit('account.password_changed', userId, { sessions_revoked: out.revokedSessions }, requestApp(body))
    return await finishSignIn(out.user, await usersColumns(), out.session)
  }

  /**
   * POST session/list { access_token } -> { sessions: [{ id, created_at,
   * last_seen_at, expires_at, current }] }: where the account is signed in
   * (a session records no device). `id` is a short digest, nothing to sign
   * in with.
   */
  async function sessionList(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    const { rows } = await pool.query(
      `SELECT encode(substring(token_hash from 1 for 8), 'hex') AS id, created_at, last_seen_at, expires_at,
              token_hash = $2 AS current
         FROM ${T.sessions}
        WHERE user_id = $1 AND expires_at > now() AND created_at + make_interval(secs => $3) > now()
        ORDER BY coalesce(last_seen_at, created_at) DESC
        LIMIT 100`,
      [v.user.id, hashToken(bearerOf(body, ctx)), cfg.absoluteTtlSec]
    )
    return ok({ sessions: rows.map((r) => ({ id: r.id, created_at: r.created_at, last_seen_at: r.last_seen_at, expires_at: r.expires_at, current: r.current === true })) })
  }

  /**
   * POST sign-out-everywhere { access_token, remove_passkeys?, password |
   * passkey }: every other session of the account ends; with
   * `remove_passkeys` (confirmed, reauth) every passkey goes too, so a lost
   * or shared device that holds one cannot sign straight back in. This device
   * stays signed in.
   */
  async function signOutEverywhere(body, ctx) {
    const blocked = limit('sessionIp', ipKey(ctx.ip))
    if (blocked) return blocked
    const v = await sessionFromBody(body, ctx)
    if (v.error) return v.error
    const token = bearerOf(body, ctx)
    const removePasskeys = body.remove_passkeys === true
    if (removePasskeys) {
      const denied = await confirmIdentity(body, token, v.user.id, ctx)
      if (denied) return denied
    }
    const out = await withTransaction(async (client) => {
      const s = await client.query(`DELETE FROM ${T.sessions} WHERE user_id = $1 AND token_hash <> $2`, [v.user.id, hashToken(token)])
      let removed = 0
      if (removePasskeys && await passkeysAvailable(client)) {
        removed = (await client.query(`DELETE FROM ${T.passkeys} WHERE user_id = $1`, [v.user.id])).rowCount
      }
      return { revokedSessions: s.rowCount, removedPasskeys: removed }
    })
    await audit('account.signed_out_everywhere', v.user.id, { sessions_revoked: out.revokedSessions, passkeys_removed: out.removedPasskeys }, requestApp(body))
    return ok({ revoked_sessions: out.revokedSessions, removed_passkeys: out.removedPasskeys })
  }

  /**
   * Signs an account out everywhere (scripts/set-password.mjs --revoke-only):
   * every session and, unless `keepPasskeys`, every passkey, in one
   * transaction. -> { revokedSessions, removedPasskeys }.
   */
  async function revokeUserAccess(userId, { keepPasskeys = false } = {}) {
    return withTransaction(async (client) => {
      const revokedSessions = await revokeUserSessions(userId, client)
      let removedPasskeys = 0
      if (!keepPasskeys && await passkeysAvailable(client)) {
        removedPasskeys = (await client.query(`DELETE FROM ${T.passkeys} WHERE user_id = $1`, [userId])).rowCount
      }
      return { revokedSessions, removedPasskeys }
    })
  }

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
        case 'reset-password/details': return await resetLinkDetails(b, c)
        case 'confirm-email': return await confirmEmailLink(b, c)
        case 'resend-confirmation': return await resendConfirmation(b, c)
        case 'passkey/login-options': return await passkeyLoginOptions(b, c)
        case 'passkey/login': return await passkeyLogin(b, c)
        case 'passkey/register-options': return await passkeyRegisterOptions(b, c)
        case 'passkey/register': return await passkeyRegister(b, c)
        case 'passkey/list': return await passkeyList(b, c)
        case 'passkey/delete': return await passkeyDelete(b, c)
        case 'reauth': return await reauth(b, c)
        case 'change-password': return await changePassword(b, c)
        case 'session/list': return await sessionList(b, c)
        case 'sign-out-everywhere': return await signOutEverywhere(b, c)
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
    accountLockout?.sweep()
    const t = Date.now()
    for (const [k, at] of failedSources) if (t - at >= FAILED_SOURCE_MS) failedSources.delete(k)
    ceremonies.sweep()
    for (const [k, until] of freshSessions) if (until <= t) freshSessions.delete(k)
    for (const [k, until] of laneSlots) if (until <= t) laneSlots.delete(k)
  }

  return {
    handleAuthRequest,
    verifyToken,
    verifyAccessToken,
    requireUser,
    setPassword,
    verifyPassword,
    findUserId,
    revokeSession,
    revokeUserSessions,
    revokeUserAccess,
    eraseAccount,
    sweepExpiredSessions,
    sweepExpiredTokens,
    settle,
    mailer,
    sweep,
    limits,
    lockout,
    accountLockout,
    bcryptGate,
    /** The worker threads' state (null: bcrypt on the main thread). */
    bcryptStats: () => bcryptPool?.stats() ?? null,
    /** Stops the bcrypt worker threads (shutdown, tests); later jobs run on the main thread. */
    close: async () => { await bcryptPool?.close() },
    sweepSignInFailures,
    config: Object.freeze(Object.fromEntries(Object.entries(cfg).filter(
      ([k]) => !['pool', 'bcrypt', 'logger', 'limits', 'lockout', 'ipKey', 'onAccountDeleted', 'selfDelete', 'mailer'].includes(k)))),
    /** Drops the cached column lists (after a restore or migration). */
    refreshCatalog() { catalog.clear() },
    // exposed for tests and scripts
    _checkPassword: checkPassword,
    _hashPassword: hashPassword
  }
}
