/**
 * approvals — the 1st referee, the 2nd referee and the scorer approve a match
 * result with their account and a personal approval PIN, next to the drawn
 * signatures (docs/account-approval-spec.md sections 1 to 3, db/011).
 *
 *   GET  /api/account/approval-pin          getPinStatus
 *   POST /api/account/approval-pin          setPin     (password required)
 *   POST /api/account/approval-pin/remove   removePin  (password required)
 *   POST /api/approvals                     approve
 *   GET  /api/approvals?external_id=        listForMatch
 *   GET  /api/account/approvals             listMine   (the official's own approvals)
 *   DELETE /api/approvals/:id               revoke (undo)
 *   GET  /api/admin/approvals               adminSearch
 *   approvalsForMatches(ids)                the admin lists' attachment
 *
 * Every handler returns { status, body, headers? } and never throws (a
 * database error is 503 OV_DB_UNAVAILABLE, retryable). Without OV_PIN_SECRET
 * (secret = null) every handler answers 503 OV_APPROVAL_UNAVAILABLE, except
 * getPinStatus ({ available: false }) and approvalsForMatches.
 *
 * Never logged, audited or returned: the PIN, the password, the MAC, the
 * salt, the approver's email (admins see it through adminSearch only), and the
 * IP and device hashes (admins see their first 8 hex characters).
 *
 * Only an official of the match may be named: a referee slot takes the
 * address stored with the match for that referee (matches.officials, typed in
 * the match setup; nothing is looked up or counted for another address), the
 * scorer slot the match's creator or one of its editors. The approval keeps
 * the approving account's own profile name next to the slot. The stored
 * address is the scoring side's own entry: it binds the slot to the account
 * the match setup names, not to a league appointment (who may vouch for a
 * referee's address is the owner's decision, account-approval-spec R11).
 * OpenBeach stores no referee address yet: a beach referee slot without one
 * keeps the older rule (any account with the role, not on the scoring side)
 * until the module is created with `beachOfficialAddressRequired: true`.
 *
 * Wrong PINs are counted per approver in auth.approval_pins and per approver
 * and caller in the audit log (approval_pin.failed), under the row lock of
 * the approve transaction, and COMMITTED with the error answer. The counts
 * are rolling: a right PIN does not clear them, the approver's restarts only
 * after 30 days without a failure, a caller's covers the last 30 days, and a
 * new PIN restarts both. Every 5th failure of one caller locks the PIN for
 * that caller for 15 minutes, its 10th until those 30 days pass. The
 * approver's count is the higher ceiling: its 20th failure disables the PIN
 * until its owner sets a new one with their password, and only when the
 * failures came from at least two callers (one caller never disables it;
 * two accounts that each name the official on a match of their own can). A
 * locked or disabled PIN answers exactly like a wrong one (no oracle for
 * whose address has a PIN); its owner sees the state in the profile (a lock
 * for one caller too) and gets an email (with a mailer).
 *
 * With a mailer (lib/mailer.js) the official gets an email for every approval
 * made with their PIN and when it is locked or disabled. The mails go out
 * after COMMIT, in the background; settle() waits for them (tests).
 *
 * Sports (db/012, lib/access.js, ~/ov-ops/openbeach-separation-tournaments-PLAN.md
 * 1.3): every role check uses the sport of the MATCH. A referee slot needs
 * `referee` on an indoor match and `beach:referee` on a beach match, the
 * scorer slot `scorer` / `beach:scorer`, and the scoring table sending the
 * approval one of the two of that sport (or admin). The audit entries of
 * approvals, undos, PIN lockouts on a match and voids (db/012's trigger)
 * carry the match's app. Beach matches answer 409 OV_APPROVAL_UNSUPPORTED
 * (account-approval-spec D3) unless the module is created with
 * `beachApprovals: true` (server.js does since OpenBeach approves with
 * accounts); then the beach roles above apply and also make an account
 * eligible for an approval PIN. A beach match's result key reads its sets'
 * team1_points / team2_points (team 1 in the "home" place), as OpenBeach's
 * resultKey does; an indoor match's home_points / away_points.
 */

import { randomBytes } from 'node:crypto'
import { AUDIT_ACTIONS, fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { ipBucketKey } from './auth.js'
import { describeMailError, maskEmail, pickLang } from './mailer.js'
import { roleFor, sportOf } from './access.js'
import {
  KEY_ID, PIN_RE, RESULT_KEY_PREFIX, deriveKeys, deviceHash, ipHash, isCurrentPinRow, isWeakPin, macPin, resultHash,
  resultKey, shortId, triplesOf, verifyPin
} from './approvalPin.js'
import { connectClient } from './pgClient.js'

export const SLOTS = Object.freeze(['referee1', 'referee2', 'scorer'])
// The plain role of each slot; approvalRoleFor() names it in the match's sport
const SLOT_ROLE = Object.freeze({ referee1: 'referee', referee2: 'referee', scorer: 'scorer' })
const APPROVAL_ROLES = Object.freeze(['referee', 'scorer'])
// Per approver and caller: every 5th wrong PIN locks it for that caller for
// 15 minutes, the 10th until the window has passed (or a new PIN)
export const PIN_LOCK_EVERY = 5
export const PIN_LOCK_MINUTES = 15
export const PIN_CALLER_MAX = 10
// Per approver, from at least two callers: the 20th disables the PIN
export const PIN_DISABLE_AT = 20
export const PIN_FAILURE_WINDOW_DAYS = 30
// The match.officials entries of the referee slots (frontend
// domain/officials.js OFFICIAL_ROLES; OpenBeach writes '1st referee' /
// '2nd referee' too; `key`: the older object keyed by role)
const SLOT_OFFICIAL = Object.freeze({
  referee1: Object.freeze({ key: 'ref1', roles: ['1st referee', 'ref1', '1st_referee'] }),
  referee2: Object.freeze({ key: 'ref2', roles: ['2nd referee', 'ref2', '2nd_referee'] })
})
// Who may send an approval: a scorer or referee account (the scoring table),
// or an admin. A pending self-registered account may not, even on its own
// test match: it could otherwise lock any official's PIN by address.
const CALLER_ROLES = Object.freeze(['scorer', 'referee'])

/** The role an official needs for `slot` on a match of `sport` ('referee' / 'beach:referee', 'scorer' / 'beach:scorer'). */
export function approvalRoleFor (slot, sport) {
  return SLOT_ROLE[slot] ? roleFor(sportOf(sport), SLOT_ROLE[slot]) : null
}
/** The roles of `sport` that may send an approval from the scoring table (admin aside). */
export function callerRolesFor (sport) {
  return CALLER_ROLES.map((r) => roleFor(sportOf(sport), r))
}
/** The match's app for audit_log.app: 'beach', or null (indoor, as every older entry). */
const auditAppOf = (m) => (sportOf(m?.sport_type) === 'beach' ? 'beach' : null)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DUMMY_UUID = '00000000-0000-0000-0000-000000000000'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))

/**
 * The address stored with the match for the official of a referee slot
 * (matches.officials: the array of { role, email, ... }, or the older object
 * keyed by role), lower-cased; null when there is none or it is no address.
 */
export function officialAddressOf (officials, slot) {
  const spec = SLOT_OFFICIAL[slot]
  if (!spec) return null
  let list = officials
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { return null }
  }
  const entry = Array.isArray(list)
    ? list.find((o) => isPlainObject(o) && spec.roles.includes(String(o.role ?? '').trim().toLowerCase()))
    : (isPlainObject(list) && isPlainObject(list[spec.key]) ? list[spec.key] : null)
  const email = typeof entry?.email === 'string' ? entry.email.trim().toLowerCase() : ''
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null
}

/**
 * An admin lookup term as typed or pasted: "ID 6F1C2A9B" (as the PDF prints
 * it), "#6F1C2A9B" or "#1234" become the bare short ID or game number;
 * anything else (an external_id) stays as it is, trimmed.
 */
export function normalizeApprovalQuery (q) {
  const t = String(q ?? '').trim()
  const m = /^(?:id\s*[:#]?\s*|#\s*)([0-9a-f]{8}|\d{1,9})$/i.exec(t)
  return m ? m[1] : t
}

/** "dd.mm.yyyy hh:mm" on the Swiss clock (the mails), '' without a value. */
function formatZurich (value) {
  const d = value instanceof Date ? value : new Date(value)
  if (!value || Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(d)
  const at = (type) => parts.find((p) => p.type === type)?.value ?? ''
  return `${at('day')}.${at('month')}.${at('year')} ${at('hour')}:${at('minute')}`
}
const hex8 = (b) => (Buffer.isBuffer(b) ? b.toString('hex').slice(0, 8) : null)
const nameSql = (alias) => `nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`
// The points of a set in the result key, by the sport of its MATCH: an indoor
// set stores home_points / away_points, a beach set (OpenBeach) team1_points /
// team2_points (team 1 first, as OpenBeach's resultKey). The other pair keeps
// its column default (0), so a coalesce of the two would read the 0s.
const IS_BEACH_SQL = (matchAlias) => `${matchAlias}.sport_type IS NOT DISTINCT FROM 'beach'`
const pointsSql = (setAlias, matchAlias) => ({
  home: `CASE WHEN ${IS_BEACH_SQL(matchAlias)} THEN ${setAlias}.team1_points ELSE ${setAlias}.home_points END`,
  away: `CASE WHEN ${IS_BEACH_SQL(matchAlias)} THEN ${setAlias}.team2_points ELSE ${setAlias}.away_points END`
})
const SET_POINTS = pointsSql('s', 'sm')
// The team names of a match for the mails and lists, by its sport: an indoor
// match's home_team / away_team, a beach match's team1_data / team2_data
// (OpenBeach leaves home_team / away_team empty). `alias` null: no table prefix.
const teamNamesSql = (alias) => {
  const a = alias ? `${alias}.` : ''
  const beach = `${a}sport_type IS NOT DISTINCT FROM 'beach'`
  return `CASE WHEN ${beach} THEN ${a}team1_data->>'name' ELSE ${a}home_team->>'name' END AS home_name, ` +
    `CASE WHEN ${beach} THEN ${a}team2_data->>'name' ELSE ${a}away_team->>'name' END AS away_name`
}
// lib/approvalPin.js resultKey() in SQL (the admin lists, many matches at once)
const currentKeySql = (matchIdExpr) => `('${RESULT_KEY_PREFIX}' || coalesce((
    SELECT string_agg(coalesce(s.index, 0) || ':' || coalesce(${SET_POINTS.home}, 0) || ':' || coalesce(${SET_POINTS.away}, 0), ',' ORDER BY s.index)
      FROM public.sets s JOIN public.matches sm ON sm.id = s.match_id
     WHERE s.match_id = ${matchIdExpr} AND s.finished IS TRUE), ''))`
const SLOT_ORDER_SQL = (alias) => `array_position(ARRAY['referee1', 'referee2', 'scorer']::text[], ${alias}.slot)`
// An address is unconfirmed when the users table tracks confirmation and it is NULL.
const UNCONFIRMED_SQL = `((to_jsonb(u) ? 'email_confirmed_at') AND (to_jsonb(u) ->> 'email_confirmed_at') IS NULL)`
const rolesOf = (raw) => (Array.isArray(raw) ? raw.map((r) => String(r).trim().toLowerCase()) : [])

// ------------------------------------------------------------------ answers
const APPROVAL_UNAVAILABLE = () => fail(503, 'OV_APPROVAL_UNAVAILABLE', 'Approval with an account is not available on this server')
const NOT_SIGNED_IN = () => fail(401, 'invalid_token', 'Not signed in')
const EMAIL_UNCONFIRMED = () => fail(409, 'OV_EMAIL_UNCONFIRMED',
  'Confirm your email address first: open the link we sent you, or send a new one from your profile')
const PASSWORD_INVALID = () => fail(403, 'OV_PASSWORD_INVALID', 'The password is not correct')
const PIN_INVALID = () => fail(403, 'OV_APPROVAL_PIN_INVALID', 'Email or PIN not accepted')
const MATCH_CLOSED = () => fail(409, 'OV_MATCH_CLOSED', 'This match is closed. Only an admin can reopen it.')
const FORBIDDEN = () => fail(403, 'OV_FORBIDDEN', 'You do not have access to this')
const SLOT_TAKEN = (details) => fail(409, 'OV_APPROVAL_SLOT_TAKEN', 'This slot is already approved by someone else', details)
function tooMany (retryAfterSec) {
  const r = fail(429, 'OV_TOO_MANY_ATTEMPTS', 'Too many attempts. Please wait a few minutes.')
  return { ...r, headers: { 'Retry-After': String(Math.max(1, Math.ceil(Number(retryAfterSec) || 900))) } }
}
function authBusy () {
  const r = fail(503, 'auth_busy', 'Sign-in is busy right now. Please try again in a few seconds.')
  return { ...r, headers: { 'Retry-After': '2' } }
}

/** A Postgres error message without the quoted values it may carry. */
const safeMessage = (err) => String(err?.message || err).replace(/"[^"]*"/g, '"…"').slice(0, 160)

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {object} [o.auth]    lib/auth.js instance (verifyPassword)
 * @param {string|null} o.secret  OV_PIN_SECRET; null = the feature is off
 * @param {object} [o.mailer]  lib/mailer.js mailer; none or disabled: no notification mails
 * @param {object} [o.logger]
 * @param {boolean} [o.beachApprovals]  beach matches are approved with accounts (OpenBeach)
 * @param {boolean} [o.beachOfficialAddressRequired]  a beach referee slot needs a stored
 *   address, as an indoor one does (once an OpenBeach release stores them)
 */
export function createApprovals ({ pool, auth = null, secret = null, mailer = null, logger = console, beachApprovals = false, beachOfficialAddressRequired = false } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createApprovals: pool is required')
  const log = logger
  // Who may hold an approval PIN: a referee or scorer of a sport that is approved with an account
  const pinRoles = beachApprovals ? [...APPROVAL_ROLES, ...APPROVAL_ROLES.map((r) => roleFor('beach', r))] : [...APPROVAL_ROLES]
  const beachRefused = (m) => !beachApprovals && sportOf(m.sport_type) === 'beach'
  // OpenBeach's match setup stores no referee address (MatchSetup_beach
  // buildOfficialsArray): until it does, a beach referee slot without one is
  // not bound, so its installed apps keep approving
  const addressOptional = (m) => !beachOfficialAddressRequired && sportOf(m.sport_type) === 'beach'
  const keys = secret ? deriveKeys(secret) : null
  const mails = mailer && mailer.enabled && typeof mailer.send === 'function' ? mailer : null

  // Notification mails run after the answer; they never fail a request.
  const pending = new Set()
  function sendLater (kind, to, lang, vars) {
    if (!mails || typeof to !== 'string' || !to.includes('@')) return
    const job = (async () => {
      try {
        await mails.send(kind, { to, lang, vars, link: mails.managerUrl })
      } catch (err) {
        log.warn?.(`[approvals] ${kind} mail to ${maskEmail(to)} failed: ${describeMailError(err)}`)
      }
    })()
    pending.add(job)
    job.finally(() => pending.delete(job))
  }
  /** Resolves when the notification mails sent so far are done (tests). */
  const settle = () => Promise.allSettled([...pending]).then(() => undefined)

  async function withTx (fn) {
    const client = await connectClient(pool, log)
    try {
      await client.query('BEGIN')
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* connection already gone */ }
      throw err
    } finally {
      client.release()
    }
  }

  /** Run a handler; a database error is a 503 (the closed lock a 409). */
  async function guarded (where, fn, { missingTable = APPROVAL_UNAVAILABLE } = {}) {
    try {
      return await fn()
    } catch (err) {
      if (err?.code === 'OVC01') return MATCH_CLOSED()
      if (err?.code === 'OVA01') return fail(409, 'OV_APPROVAL_IMMUTABLE', 'An approval cannot be changed.')
      if (err?.code === '42P01') {
        log.error?.(`[approvals] ${where}: db/011 is missing (run db/011_account_approvals.sql)`)
        return missingTable()
      }
      log.error?.(`[approvals] ${where} failed: ${err?.code || ''} ${safeMessage(err)}`)
      return unavailable()
    }
  }

  /** One audit entry; `app` 'beach' for a beach match's entry, else NULL (indoor; db/012). */
  async function audit (client, { actorId = null, action, targetUserId = null, matchId = null, details = {}, app = null }) {
    if (!AUDIT_ACTIONS.includes(action)) throw new Error(`unknown audit action ${action}`)
    await (client || pool).query(
      'INSERT INTO public.audit_log (actor_id, action, target_user_id, match_id, details, app) VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
      [isUuid(actorId) ? actorId : null, action, isUuid(targetUserId) ? targetUserId : null, isUuid(matchId) ? matchId : null, JSON.stringify(details || {}),
        app === 'beach' ? 'beach' : null])
  }

  // ------------------------------------------------------------------ shared reads
  /** The caller's own account: { unconfirmed, roles } or null (gone). */
  async function accountOf (q, userId) {
    const { rows: [u] } = await q.query(
      `SELECT ${UNCONFIRMED_SQL} AS unconfirmed,
              (SELECT p.roles FROM public.profiles p WHERE p.user_id = u.id LIMIT 1) AS roles
         FROM auth.users u WHERE u.id = $1`, [userId])
    return u ? { unconfirmed: u.unconfirmed === true, roles: rolesOf(u.roles) } : null
  }

  /** The match row of external_id, locked for the transaction. */
  async function lockMatch (client, { externalId, id }) {
    const { rows: [m] } = await client.query(
      `SELECT id, external_id, game_n, status, closed_at, created_by, sport_type::text AS sport_type, officials,
              ${teamNamesSql(null)}
         FROM public.matches WHERE ${externalId ? 'external_id' : 'id'} = $1 LIMIT 1 FOR UPDATE`, [externalId || id])
    return m || null
  }

  /** The creator or an editor of the match. */
  async function isOwnerOrEditor (q, m, userId) {
    if (!isUuid(userId)) return false
    if (m.created_by && m.created_by === userId) return true
    const { rows } = await q.query('SELECT 1 FROM public.match_editors WHERE match_id = $1 AND user_id = $2 LIMIT 1', [m.id, userId])
    return rows.length > 0
  }
  /** Who may write the match (as pgQuery's ownership): owner, editor or admin. */
  const mayWrite = async (q, m, userId, access) => access?.isAdmin === true || isOwnerOrEditor(q, m, userId)

  /** The canonical result of the stored finished sets (a beach match's team1 / team2 points). */
  async function serverResultKey (q, matchId) {
    const { rows } = await q.query(
      `SELECT s.index, ${SET_POINTS.home} AS home_points, ${SET_POINTS.away} AS away_points, s.finished
         FROM public.sets s JOIN public.matches sm ON sm.id = s.match_id
        WHERE s.match_id = $1 AND s.finished IS TRUE`, [matchId])
    return resultKey(rows)
  }

  /** An approval record (spec 3.2): no user ids, emails or hashes. */
  function recordOf (r, currentKey, callerId) {
    const rec = {
      id: r.id,
      short_id: shortId(r.id),
      slot: r.slot,
      name: r.display_name,
      approved_at: iso(r.approved_at),
      result_key: r.result_key,
      result_matches: Buffer.isBuffer(r.result_hash) && r.result_hash.equals(resultHash(currentKey)),
      mine: isUuid(callerId) && r.user_id === callerId
    }
    if (r.revoked_at) {
      rec.revoked_at = iso(r.revoked_at)
      rec.revoked_reason = r.revoked_reason
    }
    return rec
  }
  const APPROVAL_COLUMNS = 'id, match_id, slot, user_id, display_name, approved_at, result_key, result_hash, revoked_at, revoked_reason'
  const bySlot = (a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot)

  /** null when the password is right, else the answer (403, 429, 503). */
  async function passwordRefusal (userId, password) {
    if (!auth || typeof auth.verifyPassword !== 'function') return unavailable()
    let r
    try {
      r = await auth.verifyPassword(userId, password)
    } catch (err) {
      if (err?.code === 'AUTH_BUSY') return authBusy()
      throw err
    }
    if (r?.locked) return tooMany(r.retryAfterSec)
    return r?.ok === true ? null : PASSWORD_INVALID()
  }

  const passwordBodyInvalid = (body, { withPin }) => {
    if (!isPlainObject(body)) return invalid('body: must be an object')
    if (typeof body.password !== 'string' || Buffer.byteLength(body.password, 'utf8') > 72) return invalid('password: a string of at most 72 bytes')
    if (withPin && typeof body.pin !== 'string') return invalid('pin: a string of 4 to 6 digits')
    return null
  }

  // ------------------------------------------------------------------ approval PIN
  /**
   * The approval PIN's state for its owner's profile. locked_until: until
   * when it is locked, for every caller (locked_scope 'all', the older
   * per-approver lock) or for one scoring table (locked_scope 'caller', 1.2:
   * the latest such lock of the current PIN that still holds).
   */
  async function getPinStatus ({ userId } = {}) {
    const off = { available: false, eligible: false, set: false, set_at: null, locked_until: null, locked_scope: null, disabled: false }
    if (!keys) return ok(off)
    if (!isUuid(userId)) return NOT_SIGNED_IN()
    return guarded('pin-status', async () => {
      const me = await accountOf(pool, userId)
      if (!me) return NOT_SIGNED_IN()
      const { rows: [p] } = await pool.query(
        `SELECT key_id, salt, mac, set_at, disabled_at, CASE WHEN locked_until > now() THEN locked_until END AS locked_until
           FROM auth.approval_pins WHERE user_id = $1`, [userId])
      const current = isCurrentPinRow(p)
      let lockedUntil = current ? p.locked_until : null
      let scope = lockedUntil ? 'all' : null
      if (current && !lockedUntil && p.disabled_at == null) {
        const { rows: [c] } = await pool.query(
          `SELECT max(until) AS until FROM (
             SELECT CASE WHEN details->>'locked_until' ~ '^[0-9]{4}-' THEN (details->>'locked_until')::timestamptz END AS until
               FROM public.audit_log
              WHERE action = 'approval_pin.locked' AND target_user_id = $1 AND at >= $2::timestamptz AND details->>'scope' = 'caller'
           ) l WHERE until > now()`, [userId, p.set_at])
        if (c?.until) {
          lockedUntil = c.until
          scope = 'caller'
        }
      }
      return ok({
        available: true,
        eligible: !me.unconfirmed && pinRoles.some((r) => me.roles.includes(r)),
        set: current,
        set_at: current ? iso(p.set_at) : null,
        locked_until: iso(lockedUntil),
        locked_scope: scope,
        disabled: current && p.disabled_at != null
      })
    }, { missingTable: () => ok(off) })
  }

  async function setPin ({ userId, body } = {}) {
    const bad = passwordBodyInvalid(body, { withPin: true })
    if (bad) return bad
    if (!keys) return APPROVAL_UNAVAILABLE()
    if (!PIN_RE.test(body.pin)) return fail(400, 'OV_APPROVAL_PIN_FORMAT', 'The approval PIN must be 4 to 6 digits')
    if (isWeakPin(body.pin)) return fail(400, 'OV_APPROVAL_PIN_WEAK', 'This PIN is too easy to guess: no repeated digit and no sequence')
    if (!isUuid(userId)) return NOT_SIGNED_IN()
    return guarded('set-pin', async () => {
      const me = await accountOf(pool, userId)
      if (!me) return NOT_SIGNED_IN()
      if (me.unconfirmed) return EMAIL_UNCONFIRMED()
      if (!pinRoles.some((r) => me.roles.includes(r))) {
        return fail(403, 'OV_APPROVAL_ROLE_REQUIRED', 'An approval PIN needs the referee or scorer role', { roles: [...pinRoles] })
      }
      const refusal = await passwordRefusal(userId, body.password)
      if (refusal) return refusal
      const salt = randomBytes(16)
      const mac = macPin(keys.pinKey, salt, userId, body.pin)
      return withTx(async (client) => {
        const { rows: had } = await client.query('SELECT 1 FROM auth.approval_pins WHERE user_id = $1 FOR UPDATE', [userId])
        const { rows: [r] } = await client.query(
          `INSERT INTO auth.approval_pins (user_id, key_id, salt, mac, set_at, failed_attempts, last_failed_at, locked_until, disabled_at)
           VALUES ($1, $2, $3, $4, now(), 0, NULL, NULL, NULL)
           ON CONFLICT (user_id) DO UPDATE
              SET key_id = EXCLUDED.key_id, salt = EXCLUDED.salt, mac = EXCLUDED.mac, set_at = now(),
                  failed_attempts = 0, last_failed_at = NULL, locked_until = NULL, disabled_at = NULL
           RETURNING set_at`, [userId, KEY_ID, salt, mac])
        await audit(client, { actorId: userId, action: 'approval_pin.set', targetUserId: userId, details: { changed: had.length > 0 } })
        return ok({ set: true, set_at: iso(r.set_at) })
      })
    })
  }

  async function removePin ({ userId, body } = {}) {
    const bad = passwordBodyInvalid(body, { withPin: false })
    if (bad) return bad
    if (!keys) return APPROVAL_UNAVAILABLE()
    if (!isUuid(userId)) return NOT_SIGNED_IN()
    return guarded('remove-pin', async () => {
      const refusal = await passwordRefusal(userId, body.password)
      if (refusal) return refusal
      return withTx(async (client) => {
        const { rowCount } = await client.query('DELETE FROM auth.approval_pins WHERE user_id = $1', [userId])
        if (rowCount) await audit(client, { actorId: userId, action: 'approval_pin.remove', targetUserId: userId, details: {} })
        return ok({ set: false })
      })
    })
  }

  // ------------------------------------------------------------------ approvals
  function approveBody (body) {
    if (!isPlainObject(body)) return { error: invalid('body: must be an object') }
    const { external_id: ext, slot, email, pin, result, device_id: deviceId } = body
    if (typeof ext !== 'string' || ext.length < 1 || ext.length > 200) return { error: invalid('external_id: 1 to 200 characters') }
    if (!SLOTS.includes(slot)) return { error: invalid('slot: referee1, referee2 or scorer') }
    if (typeof email !== 'string' || email.trim().length > 254 || !EMAIL_RE.test(email.trim())) return { error: invalid('email: an email address') }
    if (typeof pin !== 'string') return { error: invalid('pin: a string') }
    // A malformed PIN can never be right: refused before any lookup, so a slip
    // (three digits) is not counted against the official.
    if (!PIN_RE.test(pin)) return { error: fail(400, 'OV_APPROVAL_PIN_FORMAT', 'The approval PIN must be 4 to 6 digits') }
    const sets = isPlainObject(result) ? result.sets : undefined
    const triple = (t) => Array.isArray(t) && t.length === 3 && t.every(Number.isInteger) &&
      t[0] >= 1 && t[0] <= 5 && t[1] >= 0 && t[1] <= 99 && t[2] >= 0 && t[2] <= 99
    if (!Array.isArray(sets) || sets.length > 5 || !sets.every(triple)) return { error: invalid('result.sets: at most 5 [index, home, away] integer triples') }
    if (deviceId != null && !isUuid(deviceId)) return { error: invalid('device_id: a uuid') }
    return { externalId: ext, slot, email: email.trim().toLowerCase(), pin, sets, deviceId: deviceId ?? null }
  }

  /** The approver by address: null when unknown, ambiguous, deleted or banned. */
  async function findApprover (client, email) {
    const { rows } = await client.query(
      `SELECT u.id, u.email,
              (to_jsonb(u) ->> 'deleted_at') IS NOT NULL
                OR coalesce((to_jsonb(u) ->> 'banned_until')::timestamptz > now(), false) AS blocked,
              ${UNCONFIRMED_SQL} AS unconfirmed,
              (SELECT p.roles FROM public.profiles p WHERE p.user_id = u.id LIMIT 1) AS roles,
              (SELECT trim(coalesce(p.last_name, '') || ' ' || coalesce(p.first_name, '')) FROM public.profiles p WHERE p.user_id = u.id LIMIT 1) AS name
         FROM auth.users u WHERE lower(u.email) = $1 LIMIT 2`, [email])
    if (rows.length !== 1 || rows[0].blocked) return null
    const u = rows[0]
    // email: only for the notification mail, never returned, logged or audited
    return { id: u.id, email: u.email, unconfirmed: u.unconfirmed === true, roles: rolesOf(u.roles), name: String(u.name || '').replace(/\s+/g, ' ').trim().slice(0, 160) }
  }

  // The wrong PINs of the current PIN within the window, in the audit log
  const FAILURES_SINCE_SQL = `action = 'approval_pin.failed' AND target_user_id = $1
     AND at > greatest(now() - make_interval(days => $2), $3::timestamptz)`

  /**
   * The wrong PINs one caller typed for this approver's current PIN in the
   * window: { failures, paused } (paused: every PIN_LOCK_EVERY-th locks that
   * caller for PIN_LOCK_MINUTES, PIN_CALLER_MAX blocks it for the window).
   */
  async function callerFailures (client, { approver, row, callerId }) {
    const { rows: [r] } = await client.query(
      `SELECT count(*)::int AS n, min(at) AS first_at,
              coalesce(max(at) > now() - make_interval(mins => $5), false) AS recent
         FROM public.audit_log WHERE ${FAILURES_SINCE_SQL} AND actor_id = $4`,
      [approver.id, PIN_FAILURE_WINDOW_DAYS, row.set_at, callerId, PIN_LOCK_MINUTES])
    const failures = Number(r?.n || 0)
    const paused = failures >= PIN_CALLER_MAX || (failures > 0 && failures % PIN_LOCK_EVERY === 0 && r.recent === true)
    return { failures, paused, firstAt: r?.first_at ?? null }
  }

  /**
   * A wrong PIN on an existing current row: count it for the approver and for
   * this caller, lock it for the caller or disable it (spec 1.2). The counts
   * are rolling: they restart only after PIN_FAILURE_WINDOW_DAYS without a
   * failure (the approver's) or cover that window (the caller's), never on a
   * right PIN, so one caller gets at most PIN_CALLER_MAX tries per official
   * and window however often the official approves, and cannot disable the
   * PIN alone. Returns { lockedUntil, disabled } when this failure locked the
   * PIN for the caller or disabled it.
   */
  async function countFailure (client, { approver, row, callerId, match, before }) {
    const { rows: [r] } = await client.query(
      `UPDATE auth.approval_pins
          SET failed_attempts = CASE WHEN last_failed_at IS NULL OR last_failed_at < now() - make_interval(days => $2)
                                     THEN 1 ELSE failed_attempts + 1 END,
              last_failed_at = now()
        WHERE user_id = $1
        RETURNING failed_attempts`, [approver.id, PIN_FAILURE_WINDOW_DAYS])
    const total = Number(r?.failed_attempts ?? Number(row.failed_attempts) + 1)
    const failures = before.failures + 1
    const app = auditAppOf(match)
    await audit(client, {
      actorId: callerId, action: 'approval_pin.failed', targetUserId: approver.id, matchId: match.id, details: { failures }, app
    })
    const lock = failures % PIN_LOCK_EVERY === 0 || failures >= PIN_CALLER_MAX
    let disable = false
    if (total >= PIN_DISABLE_AT) {
      const { rows: [c] } = await client.query(
        `SELECT count(DISTINCT actor_id)::int AS n FROM public.audit_log WHERE ${FAILURES_SINCE_SQL}`,
        [approver.id, PIN_FAILURE_WINDOW_DAYS, row.set_at])
      disable = Number(c?.n || 0) >= 2
    }
    if (!lock && !disable) return null
    if (disable) await client.query('UPDATE auth.approval_pins SET disabled_at = coalesce(disabled_at, now()) WHERE user_id = $1', [approver.id])
    // Until when this caller may not try again: 15 minutes, or (blocked) until
    // its oldest failure in the window leaves it
    const first = before.firstAt ? new Date(before.firstAt).getTime() : Date.now()
    const lockedUntil = disable
      ? null
      : new Date(failures >= PIN_CALLER_MAX ? first + PIN_FAILURE_WINDOW_DAYS * 86400000 : Date.now() + PIN_LOCK_MINUTES * 60000)
    await audit(client, {
      actorId: callerId,
      action: 'approval_pin.locked',
      targetUserId: approver.id,
      matchId: match.id,
      details: { failures, total, locked_until: iso(lockedUntil), disabled: disable, scope: disable ? 'all' : 'caller' },
      app
    })
    return { lockedUntil, disabled: disable }
  }

  /** "Home – Away" and the game number of a match row, for the mails. */
  const gameText = (m) => {
    const teams = [m.home_name, m.away_name].map((n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '–').join(' – ')
    return m.game_n != null ? `#${m.game_n} ${teams}` : teams
  }
  const resultText = (key) => triplesOf(key).map(([, h, a]) => `${h}:${a}`).join(', ')

  async function approve ({ callerId, access, body, ip, lang } = {}) {
    const v = approveBody(body)
    if (v.error) return v.error
    if (!keys) return APPROVAL_UNAVAILABLE()
    if (!isUuid(callerId)) return NOT_SIGNED_IN()
    const ipH = typeof ip === 'string' && ip ? ipHash(keys.ipKey, ipBucketKey(ip)) : null
    const devH = deviceHash(v.deviceId)
    // The mail language: the app's language sent with the request, else the browser's
    const mailLang = pickLang(typeof body?.lang === 'string' ? body.lang.slice(0, 16) : null, lang)
    const after = [] // mails, sent once the transaction is committed
    // Every answer below is returned from inside the transaction, so it is
    // COMMITTED: the failure counter and its audit row survive an error answer.
    const out = await guarded('approve', () => withTx(async (client) => {
      const m = await lockMatch(client, { externalId: v.externalId })
      if (!m) return notFound()
      if (beachRefused(m)) return fail(409, 'OV_APPROVAL_UNSUPPORTED', 'Approval with an account is not available for beach matches')
      if (!(await mayWrite(client, m, callerId, access))) return fail(403, 'OV_NOT_MATCH_OWNER', 'You may not change this match')
      // 5b. The scoring table: a scorer or referee account of the match's
      // sport, or an admin (not a pending account on its own test match)
      const callerRoles = callerRolesFor(m.sport_type)
      if (!(access?.isAdmin === true || callerRoles.some((r) => rolesOf(access?.roles).includes(r)))) {
        return fail(403, 'OV_APPROVAL_CALLER_ROLE', 'Approval with an account needs a scorer or referee account on this device', { roles: callerRoles })
      }
      if (m.closed_at) return MATCH_CLOSED()
      if (m.status !== 'ended') return fail(409, 'OV_MATCH_NOT_ENDED', 'The match has not ended on the server', { status: m.status ?? null })
      const currentKey = await serverResultKey(client, m.id)
      if (currentKey === RESULT_KEY_PREFIX || currentKey !== resultKey(v.sets)) {
        return fail(409, 'OV_RESULT_NOT_SYNCED', 'The result on the server differs: sync and try again', { server: triplesOf(currentKey) })
      }

      // 9. Only an official of this match is named: nothing is looked up or
      // counted for any other address. A referee slot takes the address
      // stored with the match for that referee (typed in the match setup), so
      // the approving account is the one the match setup names, by its
      // confirmed address, whatever name it gives itself. A beach match
      // without one: the older rule (addressOptional).
      if (v.slot !== 'scorer') {
        const stored = officialAddressOf(m.officials, v.slot)
        if (!stored && !addressOptional(m)) {
          return fail(409, 'OV_APPROVAL_OFFICIAL_EMAIL_MISSING', 'The match has no email for this referee: enter it in the match setup first')
        }
        if (stored && stored !== v.email) {
          return fail(403, 'OV_APPROVAL_NOT_MATCH_OFFICIAL', 'This email is not the one entered for this official of the match')
        }
      }

      // 10. Email and PIN. The lookups always run; verifyPin always MACs once.
      // The scorer slot is the match's creator or an editor (an unknown
      // address answers the same). A locked or disabled PIN, or one locked
      // for this caller, answers like a wrong one and is not counted: only its
      // owner learns the state (profile, mail).
      const approver = await findApprover(client, v.email)
      const ownerOrEditor = !!approver && await isOwnerOrEditor(client, m, approver.id)
      if (v.slot === 'scorer' && !ownerOrEditor) {
        return fail(403, 'OV_APPROVAL_NOT_MATCH_SCORER', 'The scorer must be the account that scores this match, or one of its editors')
      }
      const { rows: [pinRow] } = await client.query(
        `SELECT key_id, salt, mac, set_at, failed_attempts, disabled_at,
                CASE WHEN locked_until > now() THEN ceil(extract(epoch FROM locked_until - now()))::int END AS retry_after_sec
           FROM auth.approval_pins WHERE user_id = $1 FOR UPDATE`, [approver?.id ?? DUMMY_UUID])
      const current = approver && isCurrentPinRow(pinRow) ? pinRow : null
      const before = await callerFailures(client, { approver: approver ?? { id: DUMMY_UUID }, row: current ?? {}, callerId })
      const paused = !!current && (current.disabled_at != null || current.retry_after_sec > 0 || before.paused)
      const row = paused ? null : current
      const good = verifyPin(keys.pinKey, row, approver?.id ?? null, v.pin)
      if (!good) {
        if (row) {
          const locked = await countFailure(client, { approver, row, callerId, match: m, before })
          if (locked) {
            after.push(() => sendLater('approval_pin_locked', approver.email, mailLang, {
              game: gameText(m),
              until: locked.disabled ? '' : formatZurich(locked.lockedUntil),
              disabled: locked.disabled
            }))
          }
        }
        return PIN_INVALID()
      }
      await client.query('UPDATE auth.approval_pins SET last_used_at = now() WHERE user_id = $1', [approver.id])

      // 11. Eligibility, only after a correct PIN
      if (approver.unconfirmed) return EMAIL_UNCONFIRMED()
      // the role of the slot in the match's sport (beach:referee on a beach match)
      const role = approvalRoleFor(v.slot, m.sport_type)
      if (!approver.roles.includes(role)) {
        return fail(403, 'OV_APPROVAL_ROLE_REQUIRED', `This account does not have the ${role} role`, { role })
      }
      // A referee is never the scoring side of the same match: not the
      // account that sends the approval, not its creator, not an editor.
      if (v.slot !== 'scorer' && (ownerOrEditor || approver.id === callerId)) {
        return fail(403, 'OV_APPROVAL_SCORER_NOT_REFEREE', 'The account that scores this match cannot approve as a referee')
      }
      // The account's own name is what the slot keeps (display_name), never
      // the name typed for the official
      if (!approver.name) return fail(409, 'OV_APPROVAL_NAME_REQUIRED', 'The approving account has no name in its profile')

      // 12. Slots of this match
      const { rows: active } = await client.query(
        `SELECT ${APPROVAL_COLUMNS} FROM public.match_approvals WHERE match_id = $1 AND revoked_at IS NULL`, [m.id])
      const currentHash = resultHash(currentKey)
      const valid = (r) => r.result_hash.equals(currentHash)
      const revokeStale = (r) => client.query(
        `UPDATE public.match_approvals SET revoked_at = now(), revoked_by = $2, revoked_reason = 'result_changed'
          WHERE id = $1 AND revoked_at IS NULL`, [r.id, callerId])
      const revoked = new Set()
      for (const r of active.filter((a) => a.user_id === approver.id)) {
        if (!valid(r)) {
          await revokeStale(r)
          revoked.add(r.id)
        } else if (r.slot === v.slot) {
          return ok({ approval: recordOf(r, currentKey, callerId), already: true })
        } else {
          return fail(409, 'OV_APPROVAL_ONE_SLOT', 'This account already approved another role of this match', { slot: r.slot })
        }
      }
      const holder = active.find((a) => a.slot === v.slot && !revoked.has(a.id))
      if (holder) {
        if (valid(holder)) return SLOT_TAKEN({ name: holder.display_name, approved_at: iso(holder.approved_at) })
        await revokeStale(holder)
      }

      // 13. The approval
      await client.query("SELECT set_config('ov.user_id', $1, true)", [callerId])
      await client.query('SAVEPOINT approve_insert')
      let inserted
      try {
        const { rows: [r] } = await client.query(
          `INSERT INTO public.match_approvals
             (match_id, slot, user_id, display_name, requested_by, ip_hash, device_hash, match_status, result_key, result_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'ended', $8, $9)
           RETURNING ${APPROVAL_COLUMNS}`,
          [m.id, v.slot, approver.id, approver.name, callerId, ipH, devH, currentKey, currentHash])
        inserted = r
      } catch (err) {
        if (err?.code !== '23505') throw err
        await client.query('ROLLBACK TO SAVEPOINT approve_insert')
        return SLOT_TAKEN()
      }
      const record = recordOf(inserted, currentKey, callerId)
      await audit(client, {
        actorId: callerId,
        action: 'match.approve',
        targetUserId: approver.id,
        matchId: m.id,
        details: { slot: v.slot, short_id: record.short_id, external_id: m.external_id, game_n: m.game_n ?? null, result_key: currentKey },
        app: auditAppOf(m)
      })
      // The official hears of every approval made with their PIN
      const { rows: [sender] } = await client.query(
        `SELECT ${nameSql('p')} AS name FROM public.profiles p WHERE p.user_id = $1 LIMIT 1`, [callerId])
      after.push(() => sendLater('approval', approver.email, mailLang, {
        slot: v.slot,
        game: gameText(m),
        result: resultText(currentKey),
        id: record.short_id,
        time: formatZurich(inserted.approved_at),
        sender: approver.id === callerId ? '' : String(sender?.name || '').slice(0, 160)
      }))
      return ok({ approval: record, already: false })
    }))
    if (out?.status < 500) for (const fn of after) fn()
    return out
  }

  async function listForMatch ({ callerId, access, externalId } = {}) {
    if (typeof externalId !== 'string' || externalId.length < 1 || externalId.length > 200) return invalid('external_id: 1 to 200 characters')
    if (!keys) return APPROVAL_UNAVAILABLE()
    if (!isUuid(callerId)) return NOT_SIGNED_IN()
    return guarded('list', async () => {
      const { rows: [m] } = await pool.query(
        `SELECT id, status, closed_at, created_by, sport_type::text AS sport_type
           FROM public.matches WHERE external_id = $1 LIMIT 1`, [externalId])
      if (!m) return notFound()
      const writer = await mayWrite(pool, m, callerId, access)
      const { rows } = await pool.query(
        `SELECT ${APPROVAL_COLUMNS} FROM public.match_approvals WHERE match_id = $1 AND revoked_at IS NULL`, [m.id])
      const visible = writer ? rows : rows.filter((r) => r.user_id === callerId)
      if (!writer && !visible.length) return FORBIDDEN()
      const currentKey = await serverResultKey(pool, m.id)
      return ok({
        match: { status: m.status ?? null, closed_at: iso(m.closed_at), result_key: currentKey },
        approvals: beachRefused(m) ? [] : visible.sort(bySlot).map((r) => recordOf(r, currentKey, callerId))
      })
    })
  }

  /**
   * GET /api/account/approvals: the caller's own approvals (as the official),
   * newest first, active and revoked, with the match and who sent each one,
   * so an official sees every use of their PIN and can undo it while the
   * match is open (DELETE /api/approvals/:id allows the approver).
   */
  async function listMine ({ callerId, limit } = {}) {
    let lim = 30
    if (limit != null && limit !== '') {
      lim = Number(limit)
      if (!Number.isInteger(lim) || lim < 1 || lim > 100) return invalid('limit: 1 to 100')
    }
    if (!keys) return APPROVAL_UNAVAILABLE()
    if (!isUuid(callerId)) return NOT_SIGNED_IN()
    return guarded('list-mine', async () => {
      const { rows } = await pool.query(
        `SELECT ${APPROVAL_COLUMNS.split(', ').map((c) => 'a.' + c).join(', ')}, ${nameSql('rp')} AS requested_by_name,
                m.external_id, m.game_n, ${teamNamesSql('m')},
                m.status, m.closed_at, m.test, ${currentKeySql('a.match_id')} AS current_key
           FROM public.match_approvals a
           JOIN public.matches m ON m.id = a.match_id
           LEFT JOIN public.profiles rp ON rp.user_id = a.requested_by
          WHERE a.user_id = $1
          ORDER BY a.approved_at DESC, a.id
          LIMIT ${lim}`, [callerId])
      return ok({
        approvals: rows.map((r) => ({
          ...recordOf(r, r.current_key, callerId),
          requested_by_name: r.requested_by_name ?? null,
          match: {
            external_id: r.external_id,
            game_n: r.game_n ?? null,
            home_name: r.home_name ?? null,
            away_name: r.away_name ?? null,
            status: r.status ?? null,
            closed_at: iso(r.closed_at),
            test: r.test === true
          }
        }))
      })
    })
  }

  async function revoke ({ callerId, access, id } = {}) {
    if (!isUuid(id)) return notFound()
    if (!keys) return APPROVAL_UNAVAILABLE()
    if (!isUuid(callerId)) return NOT_SIGNED_IN()
    return guarded('revoke', () => withTx(async (client) => {
      // The match first, then the approval: the same lock order as approve.
      const { rows: [pre] } = await client.query('SELECT match_id FROM public.match_approvals WHERE id = $1', [id])
      if (!pre) return notFound()
      const m = await lockMatch(client, { id: pre.match_id })
      const { rows: [a] } = await client.query(`SELECT ${APPROVAL_COLUMNS} FROM public.match_approvals WHERE id = $1 FOR UPDATE`, [id])
      if (!m || !a) return notFound()
      if (!(a.user_id === callerId || await mayWrite(client, m, callerId, access))) return FORBIDDEN()
      if (m.closed_at) return MATCH_CLOSED()
      const currentKey = await serverResultKey(client, m.id)
      if (a.revoked_at) return ok({ approval: recordOf(a, currentKey, callerId), already: true })
      const { rows: [r] } = await client.query(
        `UPDATE public.match_approvals SET revoked_at = now(), revoked_by = $2, revoked_reason = 'undo'
          WHERE id = $1 RETURNING ${APPROVAL_COLUMNS}`, [id, callerId])
      await audit(client, {
        actorId: callerId,
        action: 'match.approval_revoke',
        targetUserId: a.user_id,
        matchId: m.id,
        details: { slot: a.slot, short_id: shortId(a.id), external_id: m.external_id, reason: 'undo' },
        app: auditAppOf(m)
      })
      return ok({ approval: recordOf(r, currentKey, callerId), already: false })
    }))
  }

  // ------------------------------------------------------------------ admin
  async function adminSearch ({ q = '', includeRevoked, limit, app } = {}) {
    if (typeof q !== 'string' || q.length > 200) return invalid('q: at most 200 characters')
    if (app != null && app !== '' && app !== 'indoor' && app !== 'beach') return invalid('app: indoor or beach')
    const inc = includeRevoked == null || includeRevoked === '' ? '0' : String(includeRevoked)
    if (!['0', '1'].includes(inc)) return invalid('include_revoked: 0 or 1')
    let lim = 50
    if (limit != null && limit !== '') {
      lim = Number(limit)
      if (!Number.isInteger(lim) || lim < 1 || lim > 200) return invalid('limit: 1 to 200')
    }
    return guarded('admin-search', async () => {
      const values = []
      const p = (val) => { values.push(val); return '$' + values.length }
      const where = []
      if (inc === '0') where.push('a.revoked_at IS NULL')
      // ?app=: the approvals of one app's matches (none: both, as before)
      if (app === 'beach') where.push("m.sport_type IS NOT DISTINCT FROM 'beach'")
      if (app === 'indoor') where.push("m.sport_type IS DISTINCT FROM 'beach'")
      const term = normalizeApprovalQuery(q)
      if (term) {
        const any = [`m.external_id = ${p(term)}`]
        if (/^[0-9a-f]{8}$/i.test(term)) any.push(`a.id::text ILIKE ${p(term.toLowerCase() + '%')}`)
        if (/^\d{1,9}$/.test(term)) any.push(`m.game_n = ${p(Number(term))}`)
        where.push('(' + any.join(' OR ') + ')')
      }
      const { rows } = await pool.query(
        `SELECT a.id, a.slot, a.user_id, a.display_name, a.approved_at, a.result_key, a.result_hash, a.ip_hash, a.device_hash,
                a.revoked_at, a.revoked_reason, u.email, ${nameSql('rp')} AS requested_by_name, ${nameSql('vp')} AS revoked_by_name,
                m.id AS m_id, m.external_id, m.game_n, ${teamNamesSql('m')},
                m.status, m.closed_at, ${currentKeySql('a.match_id')} AS current_key
           FROM public.match_approvals a
           JOIN public.matches m ON m.id = a.match_id
           LEFT JOIN auth.users u ON u.id = a.user_id
           LEFT JOIN public.profiles rp ON rp.user_id = a.requested_by
           LEFT JOIN public.profiles vp ON vp.user_id = a.revoked_by
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY a.approved_at DESC, a.id
          LIMIT ${lim}`, values)
      return ok({
        approvals: rows.map((r) => ({
          id: r.id,
          short_id: shortId(r.id),
          slot: r.slot,
          name: r.display_name,
          approved_at: iso(r.approved_at),
          result_key: r.result_key,
          result_matches: r.result_hash.equals(resultHash(r.current_key)),
          user_id: r.user_id ?? null,
          email: r.email ?? null,
          requested_by_name: r.requested_by_name ?? null,
          ip_hash8: hex8(r.ip_hash),
          device_hash8: hex8(r.device_hash),
          revoked_at: iso(r.revoked_at),
          revoked_reason: r.revoked_reason ?? null,
          revoked_by_name: r.revoked_by_name ?? null,
          match: {
            id: r.m_id,
            external_id: r.external_id,
            game_n: r.game_n ?? null,
            home_name: r.home_name ?? null,
            away_name: r.away_name ?? null,
            status: r.status ?? null,
            closed_at: iso(r.closed_at)
          }
        }))
      })
    }, { missingTable: () => ok({ approvals: [] }) })
  }

  /**
   * The active approvals of many matches, for the admin lists (one query):
   * Map(match id -> [{ slot, name, approved_at, short_id, result_matches }]).
   * An absent table (a database without 011) gives an empty map. Throws on
   * other database errors (the caller's handler answers 503).
   */
  async function approvalsForMatches (matchIds) {
    const ids = [...new Set((matchIds || []).filter(isUuid))]
    const out = new Map()
    if (!ids.length) return out
    let rows
    try {
      ({ rows } = await pool.query(
        `SELECT a.match_id, a.id, a.slot, a.display_name, a.approved_at, a.result_hash, ${currentKeySql('a.match_id')} AS current_key
           FROM public.match_approvals a
          WHERE a.match_id = ANY($1::uuid[]) AND a.revoked_at IS NULL
          ORDER BY a.match_id, ${SLOT_ORDER_SQL('a')}`, [ids]))
    } catch (err) {
      if (err?.code === '42P01') return out
      throw err
    }
    for (const r of rows) {
      if (!out.has(r.match_id)) out.set(r.match_id, [])
      out.get(r.match_id).push({
        slot: r.slot,
        name: r.display_name,
        approved_at: iso(r.approved_at),
        short_id: shortId(r.id),
        result_matches: r.result_hash.equals(resultHash(r.current_key))
      })
    }
    return out
  }

  return { enabled: !!keys, getPinStatus, setPin, removePin, approve, listForMatch, listMine, revoke, adminSearch, approvalsForMatches, settle }
}
