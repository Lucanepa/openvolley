/**
 * accountRequests — what a new account asks for at sign-up, and who approves
 * it (db/025, docs/account-approval-spec.md section 8).
 *
 * Owner, 2026-11-09: at sign-up an account says what it does (scorer of one or
 * more clubs, referee, team manager / coach of teams of a club, club manager of
 * a club), "so that i just approve rather than that also add their roles and
 * clubs". Nothing is granted at sign-up. Each part is a row of
 * public.account_requests and goes when it is approved or rejected.
 *
 * Who decides which part (the cascade):
 *   admins          every part (POST /api/admin/accounts/:id/requests); they
 *                   may change a part's club or team before approving it
 *   club managers   the parts of their club: scorer, team manager of one of the
 *                   club's teams, club manager (POST /api/club/:id/requests/:userId);
 *                   a team manager part may move to another team of the club
 *   team managers   the team manager parts of their team, and so may the
 *                   club's managers (POST /api/team/:id/requests/:userId)
 *   referee parts   admins only (they have no club)
 * Each approver sees and decides its own parts only; the rest stays for the
 * others.
 *
 * Approving grants exactly what the admin tools grant:
 *   scorer        the indoor scorer role (profiles.roles, as setRoles, audited
 *                 account.roles) and the club (account_clubs, db/018)
 *   referee       the indoor referee role
 *   team_manager  a team_managers row (db/023)
 *   club_manager  a club_managers row (db/020)
 * Every approve and reject is audited (account.request_approve /
 * account.request_reject: the kind, the club and the team ids, never a name).
 * An account whose address is not confirmed yet gets nothing (409
 * OV_EMAIL_UNCONFIRMED, as a role grant); rejecting stays possible.
 *
 * Sign-up (lib/auth.js createAccount, in its transaction):
 *   parseSignUpRequests(raw, { app })   the body's `requests`, or { error }
 *   storeSignUpRequests(client, userId, rows)  checks the clubs and teams, inserts
 * Public (no account, no personal data, server.js rate-limits it per IP):
 *   publicClubs()                       GET /api/public/clubs: club ids and names
 *                                       with their teams' ids and names
 *
 * Every handler answers the { status, body } shape of lib/accounts.js and never
 * throws. A database without db/025 reads as "no requests" and stores none.
 */

import { fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'

export const REQUEST_KINDS = Object.freeze(['scorer', 'referee', 'team_manager', 'club_manager'])
// The most parts one sign-up may ask for, in all and per kind
export const MAX_REQUESTS = 20
export const MAX_PER_KIND = Object.freeze({ scorer: 5, referee: 1, team_manager: 10, club_manager: 3 })
// A decision names at most this many parts
const MAX_DECIDED = 40
// No db/018 / db/023 / db/025 yet: a relation or column that does not exist
const MISSING = new Set(['42P01', '42703'])
const nameSql = (alias) => `nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v)
const partKey = (r) => `${r.kind}|${r.club_id || ''}|${r.team_id || ''}`

/** A refusal that stops the sign-up transaction (lib/auth.js answers 422). */
export class SignUpRequestError extends Error {
  constructor (message) {
    super(message)
    this.signUpRequests = true
  }
}

/**
 * The `requests` of a sign-up body: [{ kind, club_id?, team_id? }]. Absent:
 * no rows. { rows: [{ kind, club_id, team_id }] } (deduplicated; a team
 * manager's club is the team's, filled in by storeSignUpRequests) or
 * { error } (the sign-up answers 422). `app` 'beach' (OpenBeach's sign-up)
 * asks for nothing: requests are OpenVolley's (indoor clubs).
 */
export function parseSignUpRequests (raw, { app = null } = {}) {
  if (raw === undefined || raw === null) return { rows: [] }
  if (!Array.isArray(raw)) return { error: 'requests: a list' }
  if (raw.length === 0) return { rows: [] }
  if (app === 'beach') return { error: 'requests: OpenVolley sign-ups only' }
  if (raw.length > MAX_REQUESTS) return { error: `requests: at most ${MAX_REQUESTS}` }
  const rows = []
  const seen = new Set()
  const counts = {}
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    if (!isPlainObject(r)) return { error: `requests[${i}]: an object` }
    const kind = r.kind
    if (!REQUEST_KINDS.includes(kind)) return { error: `requests[${i}].kind: ${REQUEST_KINDS.join(', ')}` }
    const club = r.club_id == null || r.club_id === '' ? null : r.club_id
    const team = r.team_id == null || r.team_id === '' ? null : r.team_id
    if (club !== null && !isUuid(club)) return { error: `requests[${i}].club_id: a club id` }
    if (team !== null && !isUuid(team)) return { error: `requests[${i}].team_id: a team id` }
    let row
    if (kind === 'referee') {
      if (club !== null || team !== null) return { error: `requests[${i}]: a referee names no club or team` }
      row = { kind, club_id: null, team_id: null }
    } else if (kind === 'team_manager') {
      if (team === null) return { error: `requests[${i}].team_id: required for a team manager` }
      row = { kind, club_id: lower(club), team_id: lower(team) }
    } else {
      if (club === null) return { error: `requests[${i}].club_id: required for a ${kind}` }
      if (team !== null) return { error: `requests[${i}].team_id: only for a team manager` }
      row = { kind, club_id: lower(club), team_id: null }
    }
    const k = `${row.kind}|${row.club_id || ''}|${row.team_id || ''}`
    if (seen.has(k)) continue
    seen.add(k)
    counts[kind] = (counts[kind] || 0) + 1
    if (counts[kind] > MAX_PER_KIND[kind]) return { error: `requests: at most ${MAX_PER_KIND[kind]} of kind ${kind}` }
    rows.push(row)
  }
  return { rows }
}

/** Does this database have db/025? */
async function hasTable (client) {
  const { rows: [r] } = await client.query("SELECT to_regclass('public.account_requests') IS NOT NULL AS ok")
  return r?.ok === true
}

/**
 * Store the parsed requests of a new account (inside the sign-up transaction).
 * Throws SignUpRequestError when a club or team does not exist (any more), or
 * a team is not of the club named with it. Without db/025 nothing is stored
 * (returns 0).
 */
export async function storeSignUpRequests (client, userId, rows, { logger = console } = {}) {
  if (!rows?.length) return 0
  if (!(await hasTable(client))) {
    logger.warn?.('[requests] db/025 is not applied: the sign-up requests were not stored')
    return 0
  }
  const teamIds = [...new Set(rows.map((r) => r.team_id).filter(Boolean))]
  const teams = new Map()
  if (teamIds.length) {
    const { rows: found } = await client.query('SELECT id, club_id FROM public.club_teams WHERE id = ANY($1::uuid[])', [teamIds])
    for (const t of found) teams.set(t.id, t.club_id)
  }
  const out = []
  for (const r of rows) {
    if (r.kind === 'team_manager') {
      const club = teams.get(r.team_id)
      if (!club) throw new SignUpRequestError('A team you picked does not exist any more. Reload the page and pick again.')
      if (r.club_id && r.club_id !== club) throw new SignUpRequestError('A team you picked is not of the club picked with it.')
      out.push({ ...r, club_id: club })
    } else {
      out.push(r)
    }
  }
  const clubIds = [...new Set(out.map((r) => r.club_id).filter(Boolean))]
  if (clubIds.length) {
    const { rows: found } = await client.query('SELECT id FROM public.clubs WHERE id = ANY($1::uuid[])', [clubIds])
    if (found.length !== clubIds.length) throw new SignUpRequestError('A club you picked does not exist any more. Reload the page and pick again.')
  }
  const { rowCount } = await client.query(
    `INSERT INTO public.account_requests (user_id, kind, club_id, team_id)
     SELECT $1, k, c, t FROM unnest($2::text[], $3::uuid[], $4::uuid[]) AS x(k, c, t)
     ON CONFLICT DO NOTHING`,
    [userId, out.map((r) => r.kind), out.map((r) => r.club_id), out.map((r) => r.team_id)])
  return rowCount
}

/**
 * The parts an approver decides: `approve` [{ id, club_id?, team_id? }] and
 * `reject` [id]. { approve, reject } or { error } (a 400 answer).
 */
export function decisionBody (body) {
  if (!isPlainObject(body)) return { error: 'body: must be an object' }
  const approve = body.approve ?? []
  const reject = body.reject ?? []
  if (!Array.isArray(approve) || !Array.isArray(reject)) return { error: 'approve, reject: lists' }
  if (approve.length + reject.length === 0) return { error: 'approve: approve or reject at least one request' }
  if (approve.length + reject.length > MAX_DECIDED) return { error: `approve, reject: at most ${MAX_DECIDED} requests` }
  const out = { approve: [], reject: [] }
  const ids = new Set()
  for (let i = 0; i < approve.length; i++) {
    const a = typeof approve[i] === 'string' ? { id: approve[i] } : approve[i]
    if (!isPlainObject(a) || !isUuid(a.id)) return { error: `approve[${i}].id: a request id` }
    const item = { id: a.id.toLowerCase() }
    for (const k of ['club_id', 'team_id']) {
      if (a[k] === undefined || a[k] === null || a[k] === '') continue
      if (!isUuid(a[k])) return { error: `approve[${i}].${k}: an id` }
      item[k] = a[k].toLowerCase()
    }
    if (ids.has(item.id)) return { error: `approve[${i}].id: named twice` }
    ids.add(item.id)
    out.approve.push(item)
  }
  for (let i = 0; i < reject.length; i++) {
    const id = reject[i]
    if (!isUuid(id)) return { error: `reject[${i}]: a request id` }
    if (ids.has(id.toLowerCase())) return { error: `reject[${i}]: named twice` }
    ids.add(id.toLowerCase())
    out.reject.push(id.toLowerCase())
  }
  return out
}

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {ReturnType<import('./accounts.js').createAccounts>} o.accounts  audit, addRolesIn, confirmationOf
 * @param {{ invalidate?: (userId: string) => void }} [o.access]
 */
export function createAccountRequests ({ pool, accounts, access = null, logger = console } = {}) {
  const log = logger

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
  const abort = (result) => Object.assign(new Error('abort'), { __result: result })
  async function guarded (where, fn) {
    try {
      return await fn()
    } catch (err) {
      if (err && err.__result) return err.__result
      log.error?.(`[requests] ${where} failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }

  const PART_SELECT = `
    SELECT r.id, r.user_id, r.kind, r.club_id, c.name AS club_name, r.team_id, ct.team_name, r.created_at
      FROM public.account_requests r
      LEFT JOIN public.clubs c ON c.id = r.club_id
      LEFT JOIN public.club_teams ct ON ct.id = r.team_id`
  const partOut = (r) => ({
    id: r.id,
    kind: r.kind,
    club_id: r.club_id ?? null,
    club_name: r.club_name ?? null,
    team_id: r.team_id ?? null,
    team_name: r.team_name ?? null,
    created_at: iso(r.created_at)
  })
  // the order an approver reads them in: scorer, referee, team manager, club manager
  const byKind = (a, b) => REQUEST_KINDS.indexOf(a.kind) - REQUEST_KINDS.indexOf(b.kind) ||
    String(a.club_name || '').localeCompare(String(b.club_name || '')) || String(a.team_name || '').localeCompare(String(b.team_name || ''))

  // ---------------------------------------------------------------- reads
  /** userId -> [part] for these accounts (the admin's account list). Empty without db/025. */
  async function requestsOfMany (client, userIds) {
    const ids = [...new Set((userIds || []).filter(isUuid))]
    const out = new Map()
    if (!ids.length) return out
    try {
      const { rows } = await (client || pool).query(`${PART_SELECT} WHERE r.user_id = ANY($1::uuid[])`, [ids])
      for (const r of rows) {
        if (!out.has(r.user_id)) out.set(r.user_id, [])
        out.get(r.user_id).push(partOut(r))
      }
      for (const list of out.values()) list.sort(byKind)
    } catch (err) {
      if (!MISSING.has(err?.code)) throw err
    }
    return out
  }

  /** The account's own open requests (GET /api/me). [] without db/025. */
  async function mine (client, userId) {
    if (!isUuid(userId)) return []
    return (await requestsOfMany(client, [userId])).get(userId) || []
  }

  /** The accounts with an open request: their ids (the admin's Pending list). Empty without db/025. */
  async function accountsWithRequests (client) {
    try {
      const { rows } = await (client || pool).query('SELECT DISTINCT user_id FROM public.account_requests')
      return rows.map((r) => r.user_id)
    } catch (err) {
      if (MISSING.has(err?.code)) return []
      throw err
    }
  }

  /**
   * The parts one approver may see: SQL condition on `r` and its values.
   * scope: { admin: true } | { clubId } | { teamId }.
   */
  function scopeSql (scope, p) {
    if (scope?.admin) return 'TRUE'
    if (scope?.clubId) return `(r.club_id = ${p(scope.clubId)} AND r.kind IN ('scorer', 'team_manager', 'club_manager'))`
    if (scope?.teamId) return `(r.team_id = ${p(scope.teamId)} AND r.kind = 'team_manager')`
    return 'FALSE'
  }

  /**
   * The accounts with parts in one approver's scope, each with those parts:
   * { requests: [{ user: { id, email, name, created_at, email_confirmed }, parts }] }.
   */
  async function listScoped (scope) {
    return guarded('list', async () => {
      const values = []
      const p = (v) => { values.push(v); return '$' + values.length }
      let rows
      try {
        ({ rows } = await pool.query(
          `SELECT r.id, r.user_id, r.kind, r.club_id, c.name AS club_name, r.team_id, ct.team_name, r.created_at,
                  u.email, ${nameSql('pr')} AS user_name, u.created_at AS user_created_at,
                  (to_jsonb(u) ->> 'email_confirmed_at') IS NOT NULL AS email_confirmed
             FROM public.account_requests r
             JOIN auth.users u ON u.id = r.user_id
             LEFT JOIN public.profiles pr ON pr.user_id = r.user_id
             LEFT JOIN public.clubs c ON c.id = r.club_id
             LEFT JOIN public.club_teams ct ON ct.id = r.team_id
            WHERE ${scopeSql(scope, p)}
            ORDER BY r.created_at, r.id
            LIMIT 2000`, values))
      } catch (err) {
        if (MISSING.has(err?.code)) return ok({ requests: [] })
        throw err
      }
      const byUser = new Map()
      for (const r of rows) {
        if (!byUser.has(r.user_id)) {
          byUser.set(r.user_id, {
            user: { id: r.user_id, email: r.email, name: r.user_name ?? null, created_at: iso(r.user_created_at), email_confirmed: r.email_confirmed === true },
            parts: []
          })
        }
        byUser.get(r.user_id).parts.push(partOut(r))
      }
      const list = [...byUser.values()]
      for (const x of list) x.parts.sort(byKind)
      return ok({ requests: list })
    })
  }

  /** GET /api/club/:id/requests: the parts of that club (a manager of it, or an admin). */
  async function listForClub ({ clubId } = {}) {
    if (!isUuid(clubId)) return notFound()
    return listScoped({ clubId })
  }

  /** GET /api/team/:id/requests: the team manager parts of that team. */
  async function listForTeam ({ teamId } = {}) {
    if (!isUuid(teamId)) return notFound()
    return listScoped({ teamId })
  }

  /**
   * GET /api/public/clubs: every club's id and name with its teams' ids and
   * names (club_teams), for the sign-up form. No account, no personal data, no
   * counts. { clubs: [] } without db/018 / db/023.
   */
  async function publicClubs () {
    return guarded('public-clubs', async () => {
      try {
        const { rows } = await pool.query(
          `SELECT c.id, c.name,
                  coalesce((SELECT json_agg(json_build_object('id', ct.id, 'name', ct.team_name) ORDER BY lower(ct.team_name))
                              FROM public.club_teams ct WHERE ct.club_id = c.id), '[]') AS teams
             FROM public.clubs c
            ORDER BY lower(c.name)
            LIMIT 2000`)
        return ok({ clubs: rows.map((r) => ({ id: r.id, name: r.name, teams: (r.teams || []).map((t) => ({ id: t.id, name: t.name })) })) })
      } catch (err) {
        if (MISSING.has(err?.code)) return ok({ clubs: [] })
        throw err
      }
    })
  }

  // ---------------------------------------------------------------- decisions
  /** May an approver of `scope` decide part `r` (a locked row)? */
  function inScope (scope, r) {
    if (scope?.admin) return true
    if (scope?.clubId) return r.club_id === scope.clubId && r.kind !== 'referee'
    if (scope?.teamId) return r.team_id === scope.teamId && r.kind === 'team_manager'
    return false
  }

  /**
   * The part as it will be granted: the approver's change of the club or the
   * team applied, within its scope. { part } or { answer }.
   */
  async function changedPart (client, scope, r, change) {
    let club = r.club_id
    let team = r.team_id
    if (r.kind === 'referee') {
      if (change.club_id || change.team_id) return { answer: invalid('approve: a referee request has no club or team') }
      return { part: { ...r } }
    }
    if (r.kind === 'team_manager') {
      if (change.team_id && change.team_id !== team) {
        if (scope.teamId) return { answer: invalid('approve: a team manager approves the team asked for') }
        const { rows: [t] } = await client.query('SELECT id, club_id FROM public.club_teams WHERE id = $1', [change.team_id])
        if (!t) return { answer: fail(404, 'OV_TEAM_NOT_FOUND', 'This team does not exist') }
        // a club's manager moves it to another team of the same club only
        if (scope.clubId && t.club_id !== scope.clubId) return { answer: fail(403, 'OV_FORBIDDEN', 'You do not have access to this') }
        team = t.id
        club = t.club_id
      }
      if (change.club_id && change.club_id !== club) return { answer: invalid('approve: a team manager request takes the club of its team') }
    } else {
      if (change.team_id) return { answer: invalid(`approve: a ${r.kind} request has no team`) }
      if (change.club_id && change.club_id !== club) {
        if (!scope.admin) return { answer: fail(403, 'OV_FORBIDDEN', 'You do not have access to this') }
        const { rows: [c] } = await client.query('SELECT id FROM public.clubs WHERE id = $1', [change.club_id])
        if (!c) return { answer: fail(404, 'OV_CLUB_NOT_FOUND', 'This club does not exist') }
        club = c.id
      }
    }
    return { part: { ...r, club_id: club, team_id: team, changed: club !== r.club_id || team !== r.team_id } }
  }

  /** Grant one approved part (inside the decision's transaction). */
  async function grant (client, { actorId, userId, part }) {
    const by = isUuid(actorId) ? actorId : null
    if (part.kind === 'scorer' || part.kind === 'referee') {
      await accounts.addRolesIn(client, { actorId, userId, roles: [part.kind] })
    }
    if (part.kind === 'scorer') {
      await client.query(
        `INSERT INTO public.account_clubs (user_id, club_id, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, club_id) DO NOTHING`, [userId, part.club_id, by])
    } else if (part.kind === 'team_manager') {
      await client.query(
        'INSERT INTO public.team_managers (team_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [part.team_id, userId, by])
    } else if (part.kind === 'club_manager') {
      await client.query(
        'INSERT INTO public.club_managers (club_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [part.club_id, userId, by])
    }
  }

  /**
   * Approve and reject parts of one account's request. `scope`: { admin: true }
   * (every part), { clubId } (the club's parts), { teamId } (the team's team
   * manager parts). A part outside the scope, or decided meanwhile, answers 409
   * OV_REQUEST_GONE and nothing changes. { approved, rejected, requests } with
   * the parts of the scope that are still open.
   */
  async function decide ({ actorId, userId, body, scope } = {}) {
    if (!isUuid(userId)) return notFound()
    const d = decisionBody(body)
    if (d.error) return invalid(d.error)
    const via = scope?.admin ? 'admin' : scope?.clubId ? 'club' : 'team'
    return guarded('decide', () => withTx(async (client) => {
      if (!(await hasTable(client))) throw abort(notFound())
      const u = await accounts.confirmationOf(client, userId)
      if (!u) throw abort(fail(404, 'OV_ACCOUNT_NOT_FOUND', 'This account does not exist (any more)'))
      const { rows: locked } = await client.query(
        'SELECT id, user_id, kind, club_id, team_id FROM public.account_requests WHERE user_id = $1 ORDER BY id FOR UPDATE', [userId])
      const byId = new Map(locked.filter((r) => inScope(scope, r)).map((r) => [r.id, r]))
      const gone = [...d.approve.map((a) => a.id), ...d.reject].filter((id) => !byId.has(id))
      if (gone.length) {
        throw abort(fail(409, 'OV_REQUEST_GONE', 'This request was decided meanwhile, or is not one you decide', gone.join(', ')))
      }
      if (d.approve.length && u.unconfirmed) {
        throw abort(fail(409, 'OV_EMAIL_UNCONFIRMED', 'Confirm your email address first: open the link we sent you, or send a new one from your profile'))
      }
      const granted = []
      for (const a of d.approve) {
        const c = await changedPart(client, scope || {}, byId.get(a.id), a)
        if (c.answer) throw abort(c.answer)
        granted.push(c.part)
      }
      for (const part of granted) {
        await grant(client, { actorId, userId, part })
        await accounts.audit(client, {
          actorId,
          action: 'account.request_approve',
          targetUserId: userId,
          details: { kind: part.kind, ...(part.club_id ? { club_id: part.club_id } : {}), ...(part.team_id ? { team_id: part.team_id } : {}), ...(part.changed ? { changed: true } : {}), via },
          app: 'indoor'
        })
      }
      for (const id of d.reject) {
        const r = byId.get(id)
        await accounts.audit(client, {
          actorId,
          action: 'account.request_reject',
          targetUserId: userId,
          details: { kind: r.kind, ...(r.club_id ? { club_id: r.club_id } : {}), ...(r.team_id ? { team_id: r.team_id } : {}), via },
          app: 'indoor'
        })
      }
      // The decided parts go, and so does any other open part a grant answers
      // (an admin who moved a scorer part to a club the account also asked for)
      const decided = [...d.approve.map((a) => a.id), ...d.reject]
      const answered = new Set(granted.map(partKey))
      const extra = locked.filter((r) => !decided.includes(r.id) && answered.has(partKey(r))).map((r) => r.id)
      await client.query('DELETE FROM public.account_requests WHERE id = ANY($1::uuid[])', [[...decided, ...extra]])
      const values = [userId]
      const p = (v) => { values.push(v); return '$' + values.length }
      const { rows: left } = await client.query(`${PART_SELECT} WHERE r.user_id = $1 AND ${scopeSql(scope, p)}`, values)
      return ok({ approved: granted.length, rejected: d.reject.length, requests: left.map(partOut).sort(byKind) })
    })).finally(() => access?.invalidate?.(userId))
  }

  return { publicClubs, mine, requestsOfMany, accountsWithRequests, listForClub, listForTeam, decide }
}
