/**
 * accounts — approved scorers, invite codes, the admin console and the audit
 * log (docs/scorer-accounts-spec.md 4.6 and 5.3/5.4, db/007).
 *
 * Every handler returns { status, body } (plus `changes` for the realtime
 * write-through where a match changed) and never throws: a database error is
 * 503 OV_DB_UNAVAILABLE (retryable). Who may call what is decided by the
 * server (lib/access.js); the handlers only enforce the rules that depend on
 * the data (super_admin targets, self-demotion).
 *
 * Invite codes: 12 characters of the Crockford alphabet (60 bits) from
 * crypto.randomInt, shown once as XXXX-XXXX-XXXX. Only sha256('ov-invite:' +
 * code) and the last 4 characters are stored; the plaintext is never stored
 * or logged.
 *
 * Unconfirmed addresses: an account lib/auth.js created with a confirmation
 * link (raw_app_meta_data.ov_email_confirmation = 'link') may sign in before
 * it confirms its address, but gets no role until it has: redeem-invite and
 * an admin's role grant answer 409 OV_EMAIL_UNCONFIRMED. Removing roles stays
 * possible.
 *
 * Apps (db/012; ~/ov-ops/openbeach-separation-tournaments-PLAN.md 1.3):
 * OpenVolley ('indoor') and OpenBeach ('beach') share the login but keep
 * their own membership (auth.app_memberships) and roles (lib/access.js). A
 * member of an app: a membership row of it, or a role of it, or the global
 * admin; an account with no membership row at all counts as indoor (one
 * created after db/012 by an older backend, or by sign-up before it records
 * the app). Adding the first membership of another app to such an account
 * first writes its indoor one, so it never stops being indoor. "Pending" in
 * an app: a member without a role of that app. Invite codes belong to one
 * sport (a beach code grants beach:<role>). Audit entries carry the app
 * (audit_log.app: 'beach', NULL = indoor); an entry about a match takes the
 * match's sport. The admin lists take ?app=indoor|beach; without it they
 * answer as before (every account, code, match and entry).
 */

import { createHash, randomInt } from 'node:crypto'
import { ADMIN_ROLES, API_GRANTABLE_ROLES, INDOOR_ROLES, SPORTS, SPORT_ROLES, accessForSport, accessFromRoles, normalizeRoles, roleFor, sportOfRole } from './access.js'
import { findClaim, officialRowsOf, publicClaim, seasonOf, sportOf } from './officialGame.js'
import { EMAIL_CONFIRMATION_MARK } from './auth.js'

export const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const INVITE_ROLES = Object.freeze(['scorer', 'referee', 'competition_manager'])
export const AUDIT_ACTIONS = Object.freeze([
  'account.roles',
  // written by lib/auth.js (email links, db/010)
  'account.password_reset_requested', 'account.password_reset', 'account.email_confirmed',
  'invite.create', 'invite.revoke', 'invite.redeem',
  'match.claim_game', 'match.claim_pin', 'match.game_taken',
  'match.close',
  'match.reopen', 'match.editor_add', 'match.release_game',
  // lib/approvals.js (db/011); match.approval_void is written by the trigger
  'approval_pin.set', 'approval_pin.remove', 'approval_pin.locked',
  'match.approve', 'match.approval_revoke', 'match.approval_void',
  // db/012: an existing account joined another app (POST /api/account/join)
  'account.join',
  // db/014: OpenBeach tournaments (lib/beachTournaments.js, app 'beach')
  'tournament.create', 'tournament.update', 'tournament.delete', 'tournament.managers',
  'tournament.draw', 'tournament.entry', 'tournament.schedule', 'tournament.result',
  // T2: an Excel/CSV import applied (lib/beachTournaments.js importTournament)
  'tournament.import'
])
export const APPS = SPORTS
// How a membership came about (auth.app_memberships.joined_via)
const JOINED_VIA = Object.freeze(['backfill', 'signup', 'join', 'invite', 'admin'])
const INVITE_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000
const INVITE_DEFAULT_TTL_MS = 30 * DAY_MS
const GAME_TAKEN_DEDUP = '24 hours'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const withoutUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
// The columns of the official-game key a matches update may change (created_at is server-only)
const OFFICIAL_KEY_COLUMNS = ['game_n', 'scheduled_at', 'sport_type', 'test']
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)

export function ok (data, status = 200) {
  return { status, body: { data, error: null } }
}
export function fail (status, code, message, details) {
  const error = { message, code }
  if (details) error.details = details
  return { status, body: { data: null, error } }
}
export const invalid = (details) => fail(400, 'OV_INVALID_REQUEST', 'Invalid request', details)
export const notFound = (details) => fail(404, 'OV_NOT_FOUND', 'Not found', details)
export function unavailable () {
  return { status: 503, body: { data: null, error: { message: 'Service unavailable', code: 'OV_DB_UNAVAILABLE', retryable: true } } }
}

/** Uppercase, no spaces/dashes, O->0 and I/L->1; null unless it is a well-formed code. */
export function normalizeInviteCode (raw) {
  if (typeof raw !== 'string') return null
  const s = raw.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return INVITE_CODE_RE.test(s) ? s : null
}

/** sha256('ov-invite:' + normalized code), 32 bytes. */
export function hashInviteCode (normalized) {
  return createHash('sha256').update('ov-invite:' + normalized, 'utf8').digest()
}

/** A fresh code: { code: 'XXXX-XXXX-XXXX', normalized }. */
export function generateInviteCode () {
  let s = ''
  for (let i = 0; i < 12; i++) s += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]
  return { normalized: s, code: `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}` }
}

/** Europe/Zurich calendar day of `d` as YYYY-MM-DD. */
function zurichDay (d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
function addDays (day, n) {
  const t = new Date(`${day}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}
function validDay (s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
const likePattern = (q) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
const nameSql = (alias) => `nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`
// The roles that make an account a member of `app` (its own and the admin roles)
const appRoles = (app) => [...Object.values(SPORT_ROLES[app]), ...ADMIN_ROLES]
// SQL: the roles column `rolesExpr` holds one of the roles in bind parameter `param` (text[])
const hasRoleSql = (rolesExpr, param) =>
  `EXISTS (SELECT 1 FROM unnest(coalesce(${rolesExpr}, '{}'::text[])) AS r(role) WHERE lower(trim(r.role)) = ANY(${param}::text[]))`
// SQL: account `uid` has a membership row of `app` (a bind parameter), or none at all (indoor only)
const membershipSql = (uid, app, appParam) => app === 'indoor'
  ? `(EXISTS (SELECT 1 FROM auth.app_memberships am WHERE am.user_id = ${uid} AND am.app = ${appParam})
      OR NOT EXISTS (SELECT 1 FROM auth.app_memberships am WHERE am.user_id = ${uid}))`
  : `EXISTS (SELECT 1 FROM auth.app_memberships am WHERE am.user_id = ${uid} AND am.app = ${appParam})`

/** ?app= of an admin list: undefined when absent (the lists answer as before), null when invalid. */
export function appParam (raw) {
  if (raw == null || raw === '') return undefined
  return APPS.includes(raw) ? raw : null
}

/** Integer query/body value within [min, max]; `fallback` when absent; undefined when invalid. */
function intIn (raw, min, max, fallback) {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

function trimmedText (raw, { min = 0, max }) {
  if (typeof raw !== 'string') return undefined
  const s = raw.trim()
  return s.length >= min && s.length <= max ? s : undefined
}

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {ReturnType<import('./pgQuery.js').createPgQuery>} o.db
 * @param {ReturnType<import('./matchRestore.js').createMatchRestore>} o.restore
 * @param {ReturnType<import('./access.js').createAccessResolver>} o.access
 * @param {(ids: string[]) => Promise<Map<string, object[]>>} [o.approvalsForMatches]
 *   lib/approvals.js approvalsForMatches: the active account approvals the
 *   admin lists attach to each match (none without it)
 */
export function createAccounts ({ pool, db, restore, access, approvalsForMatches = null, logger = console } = {}) {
  const log = logger
  /** Active approvals per match id (empty without lib/approvals.js). Throws on a DB error. */
  const approvalsOf = async (ids) => (typeof approvalsForMatches === 'function' ? approvalsForMatches(ids) : new Map())

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

  /** Run a handler: a thrown result object is the answer, any other error a 503. */
  async function guarded (where, fn) {
    try {
      return await fn()
    } catch (err) {
      if (err && err.__result) return err.__result
      log.error?.(`[accounts] ${where} failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }
  const abort = (result) => Object.assign(new Error('abort'), { __result: result })

  // ------------------------------------------------------------------ audit
  /**
   * Insert one audit row. Throws on a database error (inside a transaction it must roll back).
   * `app` ('indoor' | 'beach'): the entry's app (beach is stored as 'beach', indoor as NULL);
   * without it an entry about a match takes the match's sport, any other is indoor.
   */
  async function audit (clientOrPool, { actorId = null, action, targetUserId = null, matchId = null, details = {}, app }) {
    if (!AUDIT_ACTIONS.includes(action)) throw new Error(`unknown audit action ${action}`)
    if (app !== undefined && !APPS.includes(app)) throw new Error(`unknown audit app ${app}`)
    const mid = isUuid(matchId) ? matchId : null
    await (clientOrPool || pool).query(
      `INSERT INTO public.audit_log (actor_id, action, target_user_id, match_id, details, app)
       VALUES ($1, $2, $3, $4, $5::jsonb,
               CASE WHEN $7::boolean
                    THEN (SELECT CASE WHEN m.sport_type IS NOT DISTINCT FROM 'beach' THEN 'beach' END
                            FROM public.matches m WHERE m.id = $4::uuid)
                    ELSE $6::text END)`,
      [isUuid(actorId) ? actorId : null, action, isUuid(targetUserId) ? targetUserId : null, mid, JSON.stringify(details || {}),
        app === 'beach' ? 'beach' : null, app === undefined && mid !== null])
  }

  /** Best-effort audit for request paths that already succeeded: logs instead of throwing. */
  async function auditQuietly (entry) {
    try {
      await audit(pool, entry)
    } catch (err) {
      log.warn?.(`[accounts] audit ${entry?.action} failed: ${err?.code || err?.message}`)
    }
  }

  // ------------------------------------------------------------------ confirmation
  const EMAIL_UNCONFIRMED = () => fail(409, 'OV_EMAIL_UNCONFIRMED',
    'Confirm your email address first: open the link we sent you, or send a new one from your profile')
  /**
   * The auth.users row of userId (locked) with `unconfirmed`: true for an
   * account created with a confirmation link that has not confirmed yet.
   * to_jsonb, so a users table without these columns reads as confirmed.
   */
  async function confirmationOf (client, userId) {
    const { rows: [u] } = await client.query(
      `SELECT u.id,
              (to_jsonb(u) ->> 'email_confirmed_at') IS NULL
                AND (to_jsonb(u) -> 'raw_app_meta_data' ->> $2) = $3 AS unconfirmed
         FROM auth.users u WHERE u.id = $1 FOR SHARE`,
      [userId, EMAIL_CONFIRMATION_MARK.key, EMAIL_CONFIRMATION_MARK.value])
    return u ? { id: u.id, unconfirmed: u.unconfirmed === true } : null
  }

  // ------------------------------------------------------------------ memberships
  /**
   * Make `userId` a member of `app` (idempotent). An account without any
   * membership counts as indoor: that one is written first, so joining
   * OpenBeach never ends an indoor membership. Returns true when the
   * membership is new.
   */
  async function addMembership (client, userId, app, via) {
    if (!APPS.includes(app) || !JOINED_VIA.includes(via)) throw new Error(`addMembership: ${app} / ${via}`)
    if (app !== 'indoor') {
      await client.query(
        `INSERT INTO auth.app_memberships (user_id, app, joined_via)
         SELECT $1, 'indoor', 'backfill'
          WHERE NOT EXISTS (SELECT 1 FROM auth.app_memberships WHERE user_id = $1)
         ON CONFLICT DO NOTHING`, [userId])
    }
    const r = await client.query(
      'INSERT INTO auth.app_memberships (user_id, app, joined_via) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [userId, app, via])
    return r.rowCount === 1
  }

  /** { indoor, beach }: is `userId` a member (see the header)? `access` from lib/access.js. */
  async function membershipsOf (client, userId, access) {
    const { rows } = await client.query('SELECT app FROM auth.app_memberships WHERE user_id = $1', [userId])
    const have = new Set(rows.map((r) => r.app))
    const out = {}
    for (const app of APPS) {
      const flags = accessForSport(access, app)
      out[app] = have.has(app) || (app === 'indoor' && have.size === 0) || flags.roles.length > 0 || !!access?.isAdmin
    }
    return out
  }

  /**
   * POST /api/account/join { app }: the signed-in account joins OpenVolley or
   * OpenBeach ("Join OpenBeach with your existing password"). Grants no role:
   * the account is pending in that app until an invite code or an admin gives
   * one. Says nothing about any other account.
   */
  async function joinApp ({ userId, body } = {}) {
    if (!isUuid(userId)) return fail(401, 'invalid_token', 'Not signed in')
    const app = isPlainObject(body) ? body.app : undefined
    if (!APPS.includes(app)) return invalid('app: indoor or beach')
    return guarded('join', () => withTx(async (client) => {
      const joined = await addMembership(client, userId, app, 'join')
      if (joined) await audit(client, { actorId: userId, action: 'account.join', targetUserId: userId, details: { app }, app })
      return ok({ app, member: true, already_member: !joined })
    }))
  }

  /**
   * GET /api/me: the caller's roles and flags. The top-level flags are the
   * indoor ones (as lib/access.js, for OpenVolley 2.1/2.2); `apps` holds both
   * apps' flags with `member`. `access` is the server's (from the database).
   */
  async function me ({ userId, access } = {}) {
    if (!isUuid(userId)) return fail(401, 'invalid_token', 'Not signed in')
    return guarded('me', async () => {
      const member = await membershipsOf(pool, userId, access)
      const apps = {}
      for (const app of APPS) {
        const f = accessForSport(access, app)
        apps[app] = { member: member[app], roles: f.roles, canScore: f.canScore, canManageTeams: f.canManageTeams, canReadTeams: f.canReadTeams, isPending: f.isPending }
      }
      return ok({
        id: userId,
        roles: access?.roles ?? [],
        isAdmin: !!access?.isAdmin,
        isSuperAdmin: !!access?.isSuperAdmin,
        canScore: !!access?.canScore,
        canManageTeams: !!access?.canManageTeams,
        canReadTeams: !!access?.canReadTeams,
        isPending: !!access?.isPending,
        apps
      })
    })
  }

  // ------------------------------------------------------------------ invites
  const INVITE_SELECT = `
    SELECT i.id, i.code_hint, i.label, i.club, i.role, i.sport, i.max_uses, i.uses, i.expires_at, i.revoked_at, i.created_at,
           ${nameSql('p')} AS created_by_name,
           CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                WHEN i.expires_at IS NOT NULL AND i.expires_at <= now() THEN 'expired'
                WHEN i.max_uses IS NOT NULL AND i.uses >= i.max_uses THEN 'used_up'
                ELSE 'active' END AS state
      FROM public.invite_codes i
      LEFT JOIN public.profiles p ON p.user_id = i.created_by`
  const inviteOut = (r) => ({
    id: r.id,
    code_hint: r.code_hint,
    label: r.label,
    club: r.club ?? null,
    role: r.role,
    sport: r.sport === 'beach' ? 'beach' : 'indoor',
    max_uses: r.max_uses ?? null,
    uses: r.uses,
    expires_at: iso(r.expires_at),
    revoked_at: iso(r.revoked_at),
    created_at: iso(r.created_at),
    created_by_name: r.created_by_name ?? null,
    state: r.state
  })

  async function redeemInvite ({ userId, code } = {}) {
    if (!isUuid(userId)) return fail(401, 'invalid_token', 'Not signed in')
    if (typeof code !== 'string' || code.length > 64) return invalid('code: required')
    const normalized = normalizeInviteCode(code)
    if (!normalized) return fail(404, 'OV_INVITE_INVALID', 'This invite code is not valid')
    return guarded('redeem-invite', () => withTx(async (client) => {
      // Before the code is looked at: an unconfirmed account learns nothing
      // about the code and does not use it up.
      if ((await confirmationOf(client, userId))?.unconfirmed) throw abort(EMAIL_UNCONFIRMED())
      const { rows: [inv] } = await client.query(
        `SELECT id, label, role, sport, max_uses, uses, revoked_at,
                (expires_at IS NOT NULL AND expires_at <= now()) AS expired
           FROM public.invite_codes WHERE code_hash = $1 FOR UPDATE`, [hashInviteCode(normalized)])
      if (!inv || inv.revoked_at) throw abort(fail(404, 'OV_INVITE_INVALID', 'This invite code is not valid'))
      if (inv.expired) throw abort(fail(410, 'OV_INVITE_EXPIRED', 'This invite code has expired'))
      // The role in the code's sport: a beach code grants beach:<role> (db/012)
      const sport = inv.sport === 'beach' ? 'beach' : 'indoor'
      const role = roleFor(sport, inv.role)
      if (!role) throw abort(fail(404, 'OV_INVITE_INVALID', 'This invite code is not valid'))
      const beachOnly = sport === 'beach' ? { sport } : {}
      const { rows: [prof] } = await client.query('SELECT roles FROM public.profiles WHERE user_id = $1 LIMIT 1 FOR UPDATE', [userId])
      const before = normalizeRoles(prof?.roles)
      const { rows: [again] } = await client.query('SELECT 1 FROM public.invite_redemptions WHERE invite_id = $1 AND user_id = $2', [inv.id, userId])
      // Idempotent: a code redeemed before, or a role the account already has,
      // is not counted (a single-use code is not wasted).
      if (again || before.includes(role)) {
        await addMembership(client, userId, sport, 'invite')
        return ok({ roles: before, role_granted: role, already_had: true, ...beachOnly })
      }
      if (inv.max_uses != null && inv.uses >= inv.max_uses) throw abort(fail(409, 'OV_INVITE_USED_UP', 'This invite code has been used up'))
      await client.query('INSERT INTO public.invite_redemptions (invite_id, user_id) VALUES ($1, $2)', [inv.id, userId])
      await client.query('UPDATE public.invite_codes SET uses = uses + 1 WHERE id = $1', [inv.id])
      const after = [...before, role]
      await writeRoles(client, userId, after, !!prof)
      await addMembership(client, userId, sport, 'invite')
      await audit(client, { actorId: userId, action: 'invite.redeem', targetUserId: userId, details: { invite_id: inv.id, label: inv.label, role, ...beachOnly }, app: sport })
      return ok({ roles: after, role_granted: role, already_had: false, ...beachOnly })
    })).finally(() => access?.invalidate(userId))
  }

  /** profiles.roles of one account; inserts the profile row when there is none. */
  async function writeRoles (client, userId, roles, hasProfile) {
    if (hasProfile) {
      await client.query('UPDATE public.profiles SET roles = $2::text[] WHERE user_id = $1', [userId, roles])
    } else {
      // No ON CONFLICT: the production profiles table may lack a unique index on user_id.
      await client.query(
        `INSERT INTO public.profiles (user_id, roles) SELECT $1, $2::text[]
          WHERE NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = $1)`, [userId, roles])
    }
  }

  /** POST /api/admin/invites: body.sport (else ?app=, else indoor) is the code's sport. */
  async function createInvite ({ actorId, body, app } = {}) {
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const sport = body.sport ?? app ?? 'indoor'
    if (!APPS.includes(sport)) return invalid('sport: indoor or beach')
    if (app && body.sport != null && body.sport !== app) return invalid('sport: not the app of this console')
    const label = trimmedText(body.label, { min: 1, max: 120 })
    if (label === undefined) return invalid('label: 1 to 120 characters')
    let club = null
    if (body.club != null && body.club !== '') {
      club = trimmedText(body.club, { max: 120 })
      if (club === undefined) return invalid('club: at most 120 characters')
      club = club || null
    }
    const role = body.role == null ? 'scorer' : body.role
    if (!INVITE_ROLES.includes(role)) return fail(400, 'OV_INVALID_ROLE', 'This role cannot be given by an invite code', 'role: scorer, referee or competition_manager')
    let maxUses = 1
    if ('max_uses' in body) {
      maxUses = body.max_uses === null ? null : intIn(body.max_uses, 1, 10000, undefined)
      if (maxUses === undefined) return invalid('max_uses: 1 to 10000, or null')
    }
    let expiresAt = new Date(Date.now() + INVITE_DEFAULT_TTL_MS)
    if ('expires_at' in body) {
      if (body.expires_at === null) expiresAt = null
      else {
        const d = typeof body.expires_at === 'string' ? new Date(body.expires_at) : null
        if (!d || Number.isNaN(d.getTime())) return invalid('expires_at: an ISO date-time, or null')
        if (d.getTime() <= Date.now()) return invalid('expires_at: must be in the future')
        expiresAt = d
      }
    }
    return guarded('create-invite', async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { code, normalized } = generateInviteCode()
        try {
          return await withTx(async (client) => {
            const { rows: [row] } = await client.query(
              `INSERT INTO public.invite_codes (code_hash, code_hint, label, club, role, max_uses, expires_at, created_by, sport)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
              [hashInviteCode(normalized), normalized.slice(-4), label, club, role, maxUses, expiresAt, isUuid(actorId) ? actorId : null, sport])
            await audit(client, { actorId, action: 'invite.create', details: { invite_id: row.id, label, role, ...(sport === 'beach' ? { sport } : {}) }, app: sport })
            const { rows: [inv] } = await client.query(`${INVITE_SELECT} WHERE i.id = $1`, [row.id])
            return ok({ invite: inviteOut(inv), code }, 201)
          })
        } catch (err) {
          if (err?.code === '23505' && attempt < 2) continue // a 60-bit collision: draw again
          throw err
        }
      }
      return unavailable()
    })
  }

  /** GET /api/admin/invites[?app=indoor|beach]: the codes of one sport (all without ?app=). */
  async function listInvites ({ app } = {}) {
    const a = appParam(app)
    if (a === null) return invalid('app: indoor or beach')
    return guarded('list-invites', async () => {
      const { rows } = a
        ? await pool.query(`${INVITE_SELECT} WHERE i.sport = $1 ORDER BY i.created_at DESC, i.id LIMIT 500`, [a])
        : await pool.query(`${INVITE_SELECT} ORDER BY i.created_at DESC, i.id LIMIT 500`)
      return ok({ invites: rows.map(inviteOut) })
    })
  }

  async function revokeInvite ({ actorId, id } = {}) {
    if (!isUuid(id)) return notFound()
    return guarded('revoke-invite', () => withTx(async (client) => {
      const { rows: [cur] } = await client.query('SELECT id, label, sport, revoked_at FROM public.invite_codes WHERE id = $1 FOR UPDATE', [id])
      if (!cur) throw abort(notFound())
      if (!cur.revoked_at) {
        await client.query('UPDATE public.invite_codes SET revoked_at = now() WHERE id = $1', [id])
        await audit(client, { actorId, action: 'invite.revoke', details: { invite_id: id, label: cur.label }, app: cur.sport === 'beach' ? 'beach' : 'indoor' })
      }
      const { rows: [inv] } = await client.query(`${INVITE_SELECT} WHERE i.id = $1`, [id])
      return ok({ invite: inviteOut(inv) })
    }))
  }

  // ------------------------------------------------------------------ accounts
  /**
   * GET /api/admin/accounts?filter=pending|all&q=&limit=[&app=indoor|beach].
   * With ?app=: the members of that app, pending = without a role of it.
   * Without: every account, pending = without an indoor role (as before).
   */
  async function listAccounts ({ filter = 'pending', q = '', limit, app } = {}) {
    if (!['pending', 'all'].includes(filter || 'pending')) return invalid('filter: pending or all')
    if (typeof q !== 'string' || q.length > 80) return invalid('q: at most 80 characters')
    const lim = intIn(limit, 1, 500, 200)
    if (lim === undefined) return invalid('limit: 1 to 500')
    const a = appParam(app)
    if (a === null) return invalid('app: indoor or beach')
    return guarded('list-accounts', async () => {
      const where = []
      const values = []
      const p = (v) => { values.push(v); return '$' + values.length }
      const own = a ? p(appRoles(a)) : null
      if (a) where.push(`(${membershipSql('u.id', a, p(a))} OR ${hasRoleSql('p.roles', own)})`)
      if ((filter || 'pending') === 'pending') {
        where.push(`NOT ${hasRoleSql('p.roles', own ?? p([...INDOOR_ROLES, ...ADMIN_ROLES]))}`)
      }
      const term = q.trim()
      if (term) {
        const pat = p(likePattern(term))
        where.push(`(u.email ILIKE ${pat} OR p.first_name ILIKE ${pat} OR p.last_name ILIKE ${pat})`)
      }
      const { rows } = await pool.query(
        `SELECT u.id, u.email, p.first_name, p.last_name, p.roles, u.created_at, u.last_sign_in_at,
                (to_jsonb(u) ->> 'email_confirmed_at') IS NOT NULL AS email_confirmed
           FROM auth.users u
           LEFT JOIN public.profiles p ON p.user_id = u.id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY u.created_at DESC, u.id
          LIMIT ${lim}`, values)
      return ok({
        accounts: rows.map((r) => {
          const acc = accessFromRoles(r.roles)
          return {
            id: r.id,
            email: r.email,
            first_name: r.first_name ?? null,
            last_name: r.last_name ?? null,
            roles: acc.roles,
            pending: a ? acc.apps[a].isPending : acc.isPending,
            created_at: iso(r.created_at),
            last_sign_in_at: iso(r.last_sign_in_at),
            email_confirmed: r.email_confirmed === true
          }
        })
      })
    })
  }

  /**
   * POST /api/admin/accounts/:userId/roles. `actor` = { id, access }.
   */
  async function setRoles ({ actor, userId, body } = {}) {
    if (!isUuid(userId)) return notFound()
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const lists = {}
    for (const k of ['add', 'remove']) {
      const v = body[k] ?? []
      if (!Array.isArray(v) || v.length > 4 || !v.every((r) => typeof r === 'string')) return invalid(`${k}: an array of at most 4 roles`)
      const norm = [...new Set(v.map((r) => r.trim().toLowerCase()))]
      const bad = norm.find((r) => !API_GRANTABLE_ROLES.includes(r))
      if (bad !== undefined) {
        return fail(400, 'OV_INVALID_ROLE', 'This role cannot be changed here', `${k}: ${bad.slice(0, 40)} is not one of ${API_GRANTABLE_ROLES.join(', ')}`)
      }
      lists[k] = norm
    }
    if (lists.add.length + lists.remove.length === 0) return invalid('add: add or remove at least one role')
    if (lists.add.some((r) => lists.remove.includes(r))) return invalid('remove: a role cannot be added and removed at once')
    if (actor?.id === userId && lists.remove.includes('admin')) {
      return fail(409, 'OV_SELF_DEMOTE', 'You cannot remove your own admin role')
    }
    const res = await guarded('set-roles', () => withTx(async (client) => {
      const u = await confirmationOf(client, userId)
      if (!u) throw abort(notFound())
      if (u.unconfirmed && lists.add.length) throw abort(EMAIL_UNCONFIRMED())
      const { rows: [prof] } = await client.query('SELECT roles FROM public.profiles WHERE user_id = $1 LIMIT 1 FOR UPDATE', [userId])
      const before = normalizeRoles(prof?.roles)
      if (before.includes('super_admin') && !actor?.access?.isSuperAdmin) {
        throw abort(fail(403, 'OV_FORBIDDEN', 'Only a super admin can change the roles of a super admin'))
      }
      const added = lists.add.filter((r) => !before.includes(r))
      const removed = lists.remove.filter((r) => before.includes(r))
      const after = [...before.filter((r) => !removed.includes(r)), ...added]
      if (added.length || removed.length || !prof) {
        await writeRoles(client, userId, after, !!prof)
        // A role of an app makes the account a member of it
        for (const app of new Set(added.map(sportOfRole).filter(Boolean))) await addMembership(client, userId, app, 'admin')
        // One entry per app whose roles changed (admin counts as indoor, as before)
        const appOf = (r) => sportOfRole(r) || 'indoor'
        const apps = [...new Set([...added, ...removed].map(appOf))]
        for (const app of apps.length ? apps : ['indoor']) {
          const details = { added: added.filter((r) => appOf(r) === app), removed: removed.filter((r) => appOf(r) === app), before, after }
          await audit(client, { actorId: actor?.id, action: 'account.roles', targetUserId: userId, details, app })
        }
      }
      return ok({ id: userId, roles: after })
    }))
    access?.invalidate(userId)
    return res
  }

  // ------------------------------------------------------------------ official games
  async function listOfficialGames ({ from, to, q = '' } = {}) {
    const today = zurichDay()
    const f = from || addDays(today, -1)
    const t = to || addDays(today, 14)
    if (!validDay(f)) return invalid('from: YYYY-MM-DD')
    if (!validDay(t)) return invalid('to: YYYY-MM-DD')
    if (t < f) return invalid('to: before from')
    if ((Date.parse(t) - Date.parse(f)) / DAY_MS > 120) return invalid('to: at most 120 days after from')
    if (typeof q !== 'string' || q.length > 80) return invalid('q: at most 80 characters')
    return guarded('official-games', async () => {
      const values = [f, addDays(t, 1)]
      let search = ''
      if (q.trim()) {
        values.push(likePattern(q.trim()))
        search = ` AND (g.game_number ILIKE $3 OR g.team_home ILIKE $3 OR g.team_away ILIKE $3 OR g.league ILIKE $3 OR g.hall ILIKE $3 OR g.city ILIKE $3)`
      }
      const { rows: games } = await pool.query(
        `SELECT g.game_number, g.datetime, g.date, g.time, g.league, g.gender, g.team_home, g.team_away, g.hall, g.city
           FROM public.svrz_games g
          WHERE g.datetime >= $1 AND g.datetime < $2${search}
          ORDER BY g.datetime, g.game_number
          LIMIT 1000`, values)
      const numbers = [...new Set(games.map((g) => Number(g.game_number)).filter((n) => Number.isInteger(n) && n > 0))]
      const claims = new Map()
      if (numbers.length) {
        const { rows } = await pool.query(
          `SELECT m.id, m.external_id, m.game_n, m.status, m.closed_at, m.updated_at, m.scheduled_at, m.created_at,
                  ${nameSql('p')} AS scorer_name, u.email AS scorer_email,
                  (SELECT count(*)::int FROM public.match_editors e WHERE e.match_id = m.id) AS editors
             FROM public.matches m
             LEFT JOIN public.profiles p ON p.user_id = m.created_by
             LEFT JOIN auth.users u ON u.id = m.created_by
            WHERE m.test IS NOT TRUE AND NOT m.official_game_exempt AND m.game_n = ANY($1::int[])
              AND (m.sport_type IS NOT DISTINCT FROM 'beach') IS NOT TRUE`, [numbers])
        for (const m of rows) {
          const key = `${m.game_n}|${seasonOf(m.scheduled_at || m.created_at)}`
          if (!claims.has(key)) claims.set(key, m)
        }
      }
      const approvals = await approvalsOf([...claims.values()].map((m) => m.id))
      return ok({
        games: games.map((g) => {
          const m = claims.get(`${Number(g.game_number)}|${seasonOf(g.datetime)}`)
          return {
            game_number: g.game_number,
            datetime: g.datetime,
            date: g.date ?? null,
            time: g.time ?? null,
            league: g.league ?? null,
            gender: g.gender ?? null,
            team_home: g.team_home ?? null,
            team_away: g.team_away ?? null,
            hall: g.hall ?? null,
            city: g.city ?? null,
            claim: m
              ? {
                  match_id: m.id,
                  external_id: m.external_id,
                  status: m.status ?? null,
                  scorer_name: m.scorer_name ?? null,
                  scorer_email: m.scorer_email ?? null,
                  editors: m.editors,
                  closed_at: iso(m.closed_at),
                  updated_at: iso(m.updated_at),
                  approvals: approvals.get(m.id) || []
                }
              : null
          }
        })
      })
    })
  }

  // ------------------------------------------------------------------ matches
  /** GET /api/admin/matches?state=&q=&limit=[&app=indoor|beach] (every sport without ?app=). */
  async function listMatches ({ state = 'closed', q = '', limit, app } = {}) {
    const st = state || 'closed'
    if (!['closed', 'open', 'all'].includes(st)) return invalid('state: closed, open or all')
    if (typeof q !== 'string' || q.length > 80) return invalid('q: at most 80 characters')
    const lim = intIn(limit, 1, 500, 100)
    if (lim === undefined) return invalid('limit: 1 to 500')
    const a = appParam(app)
    if (a === null) return invalid('app: indoor or beach')
    return guarded('list-matches', async () => {
      const values = []
      const p = (v) => { values.push(v); return '$' + values.length }
      const where = ['m.test IS NOT TRUE']
      if (a === 'beach') where.push("m.sport_type IS NOT DISTINCT FROM 'beach'")
      if (a === 'indoor') where.push("m.sport_type IS DISTINCT FROM 'beach'")
      if (st === 'closed') where.push('m.closed_at IS NOT NULL')
      if (st === 'open') where.push('m.closed_at IS NULL')
      const term = q.trim()
      if (/^\d{1,9}$/.test(term)) where.push(`m.game_n = ${p(Number(term))}`)
      else if (term) {
        const pat = p(likePattern(term))
        where.push(`((m.home_team->>'name') ILIKE ${pat} OR (m.away_team->>'name') ILIKE ${pat})`)
      }
      const { rows } = await pool.query(
        `SELECT m.id, m.external_id, m.game_n, m.status, m.scheduled_at,
                m.home_team->>'name' AS home_name, m.away_team->>'name' AS away_name, m.match_info->>'league' AS league,
                ${nameSql('p')} AS scorer_name, u.email AS scorer_email,
                (SELECT count(*)::int FROM public.match_editors e WHERE e.match_id = m.id) AS editors,
                m.closed_at, ${nameSql('cp')} AS closed_by_name, m.official_game_exempt, m.updated_at,
                (m.sport_type IS NOT DISTINCT FROM 'beach') AS is_beach
           FROM public.matches m
           LEFT JOIN public.profiles p ON p.user_id = m.created_by
           LEFT JOIN auth.users u ON u.id = m.created_by
           LEFT JOIN public.profiles cp ON cp.user_id = m.closed_by
          WHERE ${where.join(' AND ')}
          ORDER BY coalesce(m.closed_at, m.updated_at) DESC NULLS LAST, m.id
          LIMIT ${lim}`, values)
      const approvals = await approvalsOf(rows.map((r) => r.id))
      return ok({
        matches: rows.map((r) => ({
          id: r.id,
          external_id: r.external_id,
          game_n: r.game_n ?? null,
          status: r.status ?? null,
          scheduled_at: iso(r.scheduled_at),
          home_name: r.home_name ?? null,
          away_name: r.away_name ?? null,
          league: r.league ?? null,
          scorer_name: r.scorer_name ?? null,
          scorer_email: r.scorer_email ?? null,
          editors: r.editors,
          closed_at: iso(r.closed_at),
          closed_by_name: r.closed_by_name ?? null,
          official_game_exempt: r.official_game_exempt === true,
          updated_at: iso(r.updated_at),
          sport: r.is_beach === true ? 'beach' : 'indoor',
          approvals: approvals.get(r.id) || []
        }))
      })
    })
  }

  /**
   * One admin change of a match in its own transaction with ov.allow_closed
   * (the only way past db/007's lock): the row is locked, `check` may refuse,
   * `data` is the update, `details` the audit entry.
   */
  async function adminMatchUpdate ({ where, actorId, matchId, check, data, action, details }) {
    const changes = []
    const res = await guarded(where, () => withTx(async (client) => {
      await client.query("SELECT set_config('ov.allow_closed', 'on', true)")
      if (isUuid(actorId)) await client.query("SELECT set_config('ov.user_id', $1, true)", [actorId])
      const { rows: [m] } = await client.query(
        'SELECT id, external_id, game_n, status, closed_at, official_game_exempt FROM public.matches WHERE id = $1 FOR UPDATE', [matchId])
      if (!m) throw abort(notFound())
      const refusal = check?.(m)
      if (refusal) throw abort(refusal)
      const cat = await db.ensureCatalog()
      const cols = cat.tables.get('matches')?.columns
      const row = Object.fromEntries(Object.entries(data(m)).filter(([k]) => cols?.has(k)))
      const r = await db.runQuery({ table: 'matches', action: 'update', params: { data: row, filters: [{ type: 'eq', column: 'id', value: matchId }] } },
        { internal: true, client, collectChanges: true })
      if (r.body.error) throw Object.assign(new Error(`update failed: ${r.body.error.code}`), { code: r.body.error.code })
      if (r.changes) changes.push(...r.changes)
      await audit(client, { actorId, action, matchId, details: details(m) })
      return { match: m }
    }))
    // res is { match } on success, else the error result
    return { res, changes }
  }

  async function reopenMatch ({ actorId, matchId, body } = {}) {
    if (!isUuid(matchId)) return notFound()
    const reason = trimmedText(isPlainObject(body) ? body.reason : undefined, { min: 3, max: 500 })
    if (reason === undefined) return invalid('reason: 3 to 500 characters')
    const { res, changes } = await adminMatchUpdate({
      where: 'reopen',
      actorId,
      matchId,
      check: (m) => (m.closed_at ? null : fail(409, 'OV_NOT_CLOSED', 'This match is not closed')),
      data: () => ({ status: 'ended', approval: null, closed_at: null, closed_by: null }),
      action: 'match.reopen',
      details: (m) => ({ reason, from_status: m.status, external_id: m.external_id, game_n: m.game_n })
    })
    if (!res.match) return res
    const m = res.match
    return { ...ok({ match: { id: m.id, external_id: m.external_id, status: 'ended', closed_at: null } }), changes }
  }

  async function releaseGame ({ actorId, matchId, body } = {}) {
    if (!isUuid(matchId)) return notFound()
    const reason = trimmedText(isPlainObject(body) ? body.reason : undefined, { min: 3, max: 500 })
    if (reason === undefined) return invalid('reason: 3 to 500 characters')
    const { res, changes } = await adminMatchUpdate({
      where: 'release-game',
      actorId,
      matchId,
      data: () => ({ official_game_exempt: true }),
      action: 'match.release_game',
      details: (m) => ({ reason, game_n: m.game_n, external_id: m.external_id })
    })
    if (!res.match) return res
    return { ...ok({ match: { id: res.match.id, official_game_exempt: true } }), changes }
  }

  async function addMatchEditor ({ actorId, matchId, body } = {}) {
    if (!isUuid(matchId)) return notFound()
    const email = trimmedText(isPlainObject(body) ? body.email : undefined, { min: 3, max: 254 })
    if (email === undefined || !email.includes('@')) return invalid('email: an email address')
    return guarded('add-editor', async () => {
      const { rows: [m] } = await pool.query('SELECT id FROM public.matches WHERE id = $1', [matchId])
      if (!m) return notFound('match')
      const { rows: [u] } = await pool.query('SELECT id FROM auth.users WHERE lower(email) = lower($1) LIMIT 1', [email])
      if (!u) return notFound('account')
      const role = await restore.addEditor(matchId, u.id, 'admin')
      if (!role) return unavailable()
      await audit(pool, { actorId, action: 'match.editor_add', targetUserId: u.id, matchId, details: { email } })
      return ok({ role })
    })
  }

  // ------------------------------------------------------------------ audit log
  /** GET /api/admin/audit?limit=&before=&action=[&app=indoor|beach] (every app without ?app=). */
  async function listAudit ({ limit, before, action, app } = {}) {
    const lim = intIn(limit, 1, 200, 100)
    if (lim === undefined) return invalid('limit: 1 to 200')
    const bef = intIn(before, 1, Number.MAX_SAFE_INTEGER, null)
    if (bef === undefined) return invalid('before: an entry id')
    if (action != null && action !== '' && !AUDIT_ACTIONS.includes(action)) return invalid('action: unknown action')
    const ap = appParam(app)
    if (ap === null) return invalid('app: indoor or beach')
    return guarded('list-audit', async () => {
      const values = []
      const p = (v) => { values.push(v); return '$' + values.length }
      const where = []
      if (bef != null) where.push(`a.id < ${p(bef)}`)
      if (action) where.push(`a.action = ${p(action)}`)
      if (ap === 'beach') where.push("a.app = 'beach'")
      if (ap === 'indoor') where.push("a.app IS DISTINCT FROM 'beach'")
      const { rows } = await pool.query(
        `SELECT a.id, a.at, a.action, a.match_id, a.details, a.app,
                ${nameSql('ap')} AS actor_name, au.email AS actor_email,
                ${nameSql('tp')} AS target_name, tu.email AS target_email
           FROM public.audit_log a
           LEFT JOIN public.profiles ap ON ap.user_id = a.actor_id
           LEFT JOIN auth.users au ON au.id = a.actor_id
           LEFT JOIN public.profiles tp ON tp.user_id = a.target_user_id
           LEFT JOIN auth.users tu ON tu.id = a.target_user_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY a.id DESC
          LIMIT ${lim + 1}`, values)
      const more = rows.length > lim
      const page = rows.slice(0, lim)
      return ok({
        entries: page.map((r) => ({
          id: Number(r.id),
          at: iso(r.at),
          action: r.action,
          actor_name: r.actor_name ?? null,
          actor_email: r.actor_email ?? null,
          target_name: r.target_name ?? null,
          target_email: r.target_email ?? null,
          match_id: r.match_id ?? null,
          details: r.details ?? {},
          app: r.app === 'beach' ? 'beach' : 'indoor'
        })),
        next_before: more && page.length ? Number(page[page.length - 1].id) : null
      })
    })
  }

  // ------------------------------------------------------------------ official-game claims
  /**
   * The friendly pre-check of a match insert/upsert: the first row whose
   * official game another match already holds. Returns null or the full claim
   * (with match_id; send publicClaim() to the client). Throws on a DB error.
   */
  async function findTakenGame ({ userId, rows, sports }) {
    const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && typeof r === 'object').slice(0, 50)
    // A partial upsert keeps the stored values of the columns it leaves out,
    // so the key is the stored row's with the payload over it.
    const exts = [...new Set(list.map((r) => r.external_id).filter((v) => typeof v === 'string' && v && v.length <= 200))]
    const stored = new Map()
    if (exts.length) {
      const { rows: found } = await pool.query(
        `SELECT external_id, game_n, scheduled_at, created_at, sport_type::text AS sport_type, test
           FROM public.matches WHERE external_id = ANY($1::text[])`, [exts])
      for (const r of found) stored.set(r.external_id, r)
    }
    for (const payload of list) {
      const old = typeof payload.external_id === 'string' ? stored.get(payload.external_id) : undefined
      const row = old ? { ...old, ...withoutUndefined(payload) } : payload
      if (officialRowsOf([row]).length === 0) continue
      // Only the sports the caller can score in (the others are refused by pgQuery first)
      if (Array.isArray(sports) && !sports.includes(sportOf(row.sport_type))) continue
      const ext = typeof row.external_id === 'string' ? row.external_id : null
      // The season the index sees: scheduled_at, else created_at, else now
      const declaredAt = row.scheduled_at ?? row.created_at ?? null
      const claim = await findClaim(pool, {
        gameN: row.game_n,
        scheduledAt: declaredAt,
        sportType: row.sport_type,
        excludeExternalId: ext,
        callerId: userId
      })
      if (claim) return claim
      const real = await vmSeasonClaim({ userId, row, old, declaredAt, ext })
      if (real) return real
    }
    return null
  }

  /**
   * The client declares the season (scheduled_at; created_at is server-only on
   * /api/db). For an indoor game VolleyManager knows (svrz_games), a match
   * that takes a NEW key in another season than VolleyManager's kick-off is
   * also checked against the game's real season, so shifting the date cannot
   * open a second cloud match for a claimed game. A stored match whose key
   * does not change (an old season's match re-synced after its number was
   * reused) is left alone. A friendly check, not a database guarantee.
   */
  async function vmSeasonClaim ({ userId, row, old, declaredAt, ext }) {
    if (sportOf(row.sport_type) !== 'indoor') return null
    const n = Number(row.game_n)
    const declaredSeason = seasonOf(declaredAt ?? new Date())
    if (old && old.test !== true && Number(old.game_n) === n && sportOf(old.sport_type) === 'indoor' &&
        seasonOf(old.scheduled_at ?? old.created_at ?? new Date()) === declaredSeason) return null
    let vmAt
    try {
      const { rows: games } = await pool.query(
        'SELECT datetime FROM public.svrz_games WHERE game_number = $1 AND datetime IS NOT NULL ORDER BY id DESC LIMIT 1', [String(n)])
      vmAt = games[0]?.datetime
    } catch (err) {
      // no VolleyManager table (a LAN or test database): the declared key only
      if (err?.code === '42P01' || err?.code === '42703') return null
      throw err
    }
    const vmSeason = seasonOf(vmAt)
    if (vmSeason == null || vmSeason === declaredSeason) return null
    return findClaim(pool, { gameN: n, scheduledAt: new Date(vmAt).toISOString(), sportType: 'indoor', excludeExternalId: ext, callerId: userId })
  }

  /**
   * The friendly pre-check of a matches update that touches the official-game
   * key (game_n, scheduled_at, sport_type, test): the stored rows the filters
   * match, with the update over them. Throws on a DB error.
   */
  async function findTakenGameForUpdate ({ userId, filters, data, sports }) {
    if (!isPlainObject(data) || !OFFICIAL_KEY_COLUMNS.some((c) => c in data)) return null
    const r = await db.runQuery({
      table: 'matches',
      action: 'select',
      params: { columns: 'external_id', filters, limit: 50 }
    }, { internal: true })
    if (r.body.error) return null // a bad filter: the update itself answers it
    const rows = (r.body.data || []).filter((m) => typeof m.external_id === 'string')
      .map((m) => ({ ...data, external_id: m.external_id }))
    return rows.length ? findTakenGame({ userId, rows, sports }) : null
  }

  /** POST /api/match/official-check (the caller can score). */
  async function officialCheck ({ userId, body } = {}) {
    if (!isPlainObject(body)) return invalid('body: must be an object')
    const gameN = intIn(body.game_n, 1, 2147483647, undefined)
    if (gameN === undefined) return invalid('game_n: a positive integer')
    let scheduledAt = null
    if (body.scheduled_at != null && body.scheduled_at !== '') {
      if (typeof body.scheduled_at !== 'string' || Number.isNaN(new Date(body.scheduled_at).getTime())) return invalid('scheduled_at: an ISO date-time or null')
      scheduledAt = body.scheduled_at
    }
    const sportType = body.sport_type == null ? 'indoor' : body.sport_type
    if (!['indoor', 'beach'].includes(sportType)) return invalid('sport_type: indoor or beach')
    let externalId = null
    if (body.external_id != null && body.external_id !== '') {
      if (typeof body.external_id !== 'string' || body.external_id.length > 200) return invalid('external_id: a string or null')
      externalId = body.external_id
    }
    return guarded('official-check', async () => {
      const claim = await findClaim(pool, { gameN, scheduledAt, sportType, excludeExternalId: externalId, callerId: userId })
      return ok(claim ? { taken: true, claim: publicClaim(claim) } : { taken: false })
    })
  }

  /** Audit match.game_taken at most once per actor, game and season in 24 h. Never throws. */
  async function auditGameTaken ({ actorId, claim }) {
    if (!claim) return
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM public.audit_log
          WHERE action = 'match.game_taken' AND actor_id = $1 AND details->>'game_n' = $2 AND details->>'season' = $3
            AND details->>'sport' = $4 AND at > now() - interval '${GAME_TAKEN_DEDUP}' LIMIT 1`,
        [actorId, String(claim.game_n), String(claim.season), claim.sport])
      if (rows.length) return
      await audit(pool, { actorId, action: 'match.game_taken', matchId: claim.match_id, details: { game_n: claim.game_n, season: claim.season, sport: claim.sport } })
    } catch (err) {
      log.warn?.(`[accounts] audit match.game_taken failed: ${err?.code || err?.message}`)
    }
  }

  /** Audit match.claim_game for every new non-test match with a game number in `changes`. Never throws. */
  async function auditClaimedGames ({ actorId, changes }) {
    for (const c of Array.isArray(changes) ? changes : []) {
      const row = c?.row
      if (c?.table !== 'matches' || c.eventType !== 'INSERT' || !row || row.test === true || !(Number(row.game_n) > 0)) continue
      await auditQuietly({ actorId, action: 'match.claim_game', matchId: row.id, details: { external_id: row.external_id ?? null, game_n: row.game_n, season: seasonOf(row.scheduled_at || row.created_at), sport: sportOf(row.sport_type) } })
    }
  }

  /** Audit match.claim_pin (a take-over by game PIN). Never throws. */
  async function auditClaimPin ({ actorId, matchId, via, role }) {
    await auditQuietly({ actorId, action: 'match.claim_pin', targetUserId: actorId, matchId, details: { via, ...(role ? { role } : {}) } })
  }

  return {
    audit,
    auditQuietly,
    joinApp,
    me,
    membershipsOf,
    redeemInvite,
    createInvite,
    listInvites,
    revokeInvite,
    listAccounts,
    setRoles,
    listOfficialGames,
    listMatches,
    reopenMatch,
    releaseGame,
    addMatchEditor,
    listAudit,
    findTakenGame,
    findTakenGameForUpdate,
    officialCheck,
    auditGameTaken,
    auditClaimedGames,
    auditClaimPin
  }
}
