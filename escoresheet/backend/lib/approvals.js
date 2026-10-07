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
 * Wrong PINs are counted per approver in auth.approval_pins under the row
 * lock of the approve transaction, and COMMITTED with the error answer: 5
 * failures lock the PIN for 15 minutes, 10 disable it until its owner sets a
 * new one with their password.
 */

import { randomBytes } from 'node:crypto'
import { AUDIT_ACTIONS, fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { ipBucketKey } from './auth.js'
import {
  KEY_ID, PIN_RE, RESULT_KEY_PREFIX, deriveKeys, deviceHash, ipHash, isCurrentPinRow, isWeakPin, macPin, resultHash,
  resultKey, shortId, triplesOf, verifyPin
} from './approvalPin.js'

export const SLOTS = Object.freeze(['referee1', 'referee2', 'scorer'])
const SLOT_ROLE = Object.freeze({ referee1: 'referee', referee2: 'referee', scorer: 'scorer' })
const APPROVAL_ROLES = Object.freeze(['referee', 'scorer'])
export const PIN_LOCK_EVERY = 5
export const PIN_LOCK_MINUTES = 15
export const PIN_DISABLE_AT = 10
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DUMMY_UUID = '00000000-0000-0000-0000-000000000000'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
const hex8 = (b) => (Buffer.isBuffer(b) ? b.toString('hex').slice(0, 8) : null)
const nameSql = (alias) => `nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`
// lib/approvalPin.js resultKey() in SQL (the admin lists, many matches at once)
const currentKeySql = (matchIdExpr) => `('${RESULT_KEY_PREFIX}' || coalesce((
    SELECT string_agg(coalesce(s.index, 0) || ':' || coalesce(s.home_points, 0) || ':' || coalesce(s.away_points, 0), ',' ORDER BY s.index)
      FROM public.sets s WHERE s.match_id = ${matchIdExpr} AND s.finished IS TRUE), ''))`
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
const PIN_LOCKED = (details) => fail(423, 'OV_APPROVAL_PIN_LOCKED', 'This approval PIN is locked after too many wrong attempts', details)
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
 * @param {object} [o.logger]
 */
export function createApprovals ({ pool, auth = null, secret = null, logger = console } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createApprovals: pool is required')
  const log = logger
  const keys = secret ? deriveKeys(secret) : null

  async function withTx (fn) {
    const client = await pool.connect()
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

  async function audit (client, { actorId = null, action, targetUserId = null, matchId = null, details = {} }) {
    if (!AUDIT_ACTIONS.includes(action)) throw new Error(`unknown audit action ${action}`)
    await (client || pool).query(
      'INSERT INTO public.audit_log (actor_id, action, target_user_id, match_id, details) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [isUuid(actorId) ? actorId : null, action, isUuid(targetUserId) ? targetUserId : null, isUuid(matchId) ? matchId : null, JSON.stringify(details || {})])
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
      `SELECT id, external_id, game_n, status, closed_at, created_by, sport_type::text AS sport_type
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

  /** The canonical result of the stored finished sets. */
  async function serverResultKey (q, matchId) {
    const { rows } = await q.query(
      'SELECT index, home_points, away_points, finished FROM public.sets WHERE match_id = $1 AND finished IS TRUE', [matchId])
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
  async function getPinStatus ({ userId } = {}) {
    const off = { available: false, eligible: false, set: false, set_at: null, locked_until: null, disabled: false }
    if (!keys) return ok(off)
    if (!isUuid(userId)) return NOT_SIGNED_IN()
    return guarded('pin-status', async () => {
      const me = await accountOf(pool, userId)
      if (!me) return NOT_SIGNED_IN()
      const { rows: [p] } = await pool.query(
        `SELECT key_id, salt, mac, set_at, disabled_at, CASE WHEN locked_until > now() THEN locked_until END AS locked_until
           FROM auth.approval_pins WHERE user_id = $1`, [userId])
      const current = isCurrentPinRow(p)
      return ok({
        available: true,
        eligible: !me.unconfirmed && APPROVAL_ROLES.some((r) => me.roles.includes(r)),
        set: current,
        set_at: current ? iso(p.set_at) : null,
        locked_until: current ? iso(p.locked_until) : null,
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
      if (!APPROVAL_ROLES.some((r) => me.roles.includes(r))) {
        return fail(403, 'OV_APPROVAL_ROLE_REQUIRED', 'An approval PIN needs the referee or scorer role', { roles: [...APPROVAL_ROLES] })
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
      `SELECT u.id,
              (to_jsonb(u) ->> 'deleted_at') IS NOT NULL
                OR coalesce((to_jsonb(u) ->> 'banned_until')::timestamptz > now(), false) AS blocked,
              ${UNCONFIRMED_SQL} AS unconfirmed,
              (SELECT p.roles FROM public.profiles p WHERE p.user_id = u.id LIMIT 1) AS roles,
              (SELECT trim(coalesce(p.last_name, '') || ' ' || coalesce(p.first_name, '')) FROM public.profiles p WHERE p.user_id = u.id LIMIT 1) AS name
         FROM auth.users u WHERE lower(u.email) = $1 LIMIT 2`, [email])
    if (rows.length !== 1 || rows[0].blocked) return null
    const u = rows[0]
    return { id: u.id, unconfirmed: u.unconfirmed === true, roles: rolesOf(u.roles), name: String(u.name || '').replace(/\s+/g, ' ').trim().slice(0, 160) }
  }

  /** A wrong PIN on an existing current row: count it, lock or disable (spec 1.2). */
  async function countFailure (client, { approver, row, callerId, match }) {
    const failures = Number(row.failed_attempts) + 1
    const lock = failures % PIN_LOCK_EVERY === 0
    const disable = failures >= PIN_DISABLE_AT
    const { rows: [r] } = await client.query(
      `UPDATE auth.approval_pins
          SET failed_attempts = $2, last_failed_at = now(),
              locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $5) ELSE locked_until END,
              disabled_at = CASE WHEN $4 THEN coalesce(disabled_at, now()) ELSE disabled_at END
        WHERE user_id = $1
        RETURNING locked_until`, [approver.id, failures, lock, disable, PIN_LOCK_MINUTES])
    if (lock || disable) {
      await audit(client, {
        actorId: callerId,
        action: 'approval_pin.locked',
        targetUserId: approver.id,
        matchId: match.id,
        details: { failures, locked_until: iso(r?.locked_until), disabled: disable }
      })
    }
  }

  async function approve ({ callerId, access, body, ip } = {}) {
    const v = approveBody(body)
    if (v.error) return v.error
    if (!keys) return APPROVAL_UNAVAILABLE()
    if (!isUuid(callerId)) return NOT_SIGNED_IN()
    const ipH = typeof ip === 'string' && ip ? ipHash(keys.ipKey, ipBucketKey(ip)) : null
    const devH = deviceHash(v.deviceId)
    // Every answer below is returned from inside the transaction, so it is
    // COMMITTED: the failure counter and its audit row survive an error answer.
    return guarded('approve', () => withTx(async (client) => {
      const m = await lockMatch(client, { externalId: v.externalId })
      if (!m) return notFound()
      if (m.sport_type === 'beach') return fail(409, 'OV_APPROVAL_UNSUPPORTED', 'Approval with an account is not available for beach matches')
      if (!(await mayWrite(client, m, callerId, access))) return fail(403, 'OV_NOT_MATCH_OWNER', 'You may not change this match')
      if (m.closed_at) return MATCH_CLOSED()
      if (m.status !== 'ended') return fail(409, 'OV_MATCH_NOT_ENDED', 'The match has not ended on the server', { status: m.status ?? null })
      const currentKey = await serverResultKey(client, m.id)
      if (currentKey === RESULT_KEY_PREFIX || currentKey !== resultKey(v.sets)) {
        return fail(409, 'OV_RESULT_NOT_SYNCED', 'The result on the server differs: sync and try again', { server: triplesOf(currentKey) })
      }

      // 9. Email and PIN. Both lookups always run; verifyPin always MACs once.
      const approver = await findApprover(client, v.email)
      const { rows: [pinRow] } = await client.query(
        `SELECT key_id, salt, mac, failed_attempts, disabled_at,
                CASE WHEN locked_until > now() THEN ceil(extract(epoch FROM locked_until - now()))::int END AS retry_after_sec
           FROM auth.approval_pins WHERE user_id = $1 FOR UPDATE`, [approver?.id ?? DUMMY_UUID])
      const row = approver && isCurrentPinRow(pinRow) ? pinRow : null
      if (row?.disabled_at) return PIN_LOCKED({ disabled: true })
      if (row?.retry_after_sec > 0) return PIN_LOCKED({ retry_after_sec: row.retry_after_sec })
      const good = verifyPin(keys.pinKey, row, approver?.id ?? null, v.pin)
      if (!good) {
        if (row) await countFailure(client, { approver, row, callerId, match: m })
        return PIN_INVALID()
      }
      await client.query(
        'UPDATE auth.approval_pins SET failed_attempts = 0, locked_until = NULL, last_used_at = now() WHERE user_id = $1', [approver.id])

      // 10. Eligibility, only after a correct PIN
      if (approver.unconfirmed) return EMAIL_UNCONFIRMED()
      const role = SLOT_ROLE[v.slot]
      if (!approver.roles.includes(role)) {
        return fail(403, 'OV_APPROVAL_ROLE_REQUIRED', `This account does not have the ${role} role`, { role })
      }
      if (v.slot === 'scorer' && !(await isOwnerOrEditor(client, m, approver.id))) {
        return fail(403, 'OV_APPROVAL_NOT_MATCH_SCORER', 'The scorer must be the account that scores this match, or one of its editors')
      }
      if (!approver.name) return fail(409, 'OV_APPROVAL_NAME_REQUIRED', 'The approving account has no name in its profile')

      // 11. Slots of this match
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

      // 12. The approval
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
        details: { slot: v.slot, short_id: record.short_id, external_id: m.external_id, game_n: m.game_n ?? null, result_key: currentKey }
      })
      return ok({ approval: record, already: false })
    }))
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
        approvals: m.sport_type === 'beach' ? [] : visible.sort(bySlot).map((r) => recordOf(r, currentKey, callerId))
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
        details: { slot: a.slot, short_id: shortId(a.id), external_id: m.external_id, reason: 'undo' }
      })
      return ok({ approval: recordOf(r, currentKey, callerId), already: false })
    }))
  }

  // ------------------------------------------------------------------ admin
  async function adminSearch ({ q = '', includeRevoked, limit } = {}) {
    if (typeof q !== 'string' || q.length > 200) return invalid('q: at most 200 characters')
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
      const term = q.trim()
      if (term) {
        const any = [`m.external_id = ${p(term)}`]
        if (/^[0-9a-f]{8}$/i.test(term)) any.push(`a.id::text ILIKE ${p(term.toLowerCase() + '%')}`)
        if (/^\d{1,9}$/.test(term)) any.push(`m.game_n = ${p(Number(term))}`)
        where.push('(' + any.join(' OR ') + ')')
      }
      const { rows } = await pool.query(
        `SELECT a.id, a.slot, a.user_id, a.display_name, a.approved_at, a.result_key, a.result_hash, a.ip_hash, a.device_hash,
                a.revoked_at, a.revoked_reason, u.email, ${nameSql('rp')} AS requested_by_name, ${nameSql('vp')} AS revoked_by_name,
                m.id AS m_id, m.external_id, m.game_n, m.home_team->>'name' AS home_name, m.away_team->>'name' AS away_name,
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

  return { enabled: !!keys, getPinStatus, setPin, removePin, approve, listForMatch, revoke, adminSearch, approvalsForMatches }
}
