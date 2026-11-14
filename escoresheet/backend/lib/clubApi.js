/**
 * clubApi — the club's API (db/032, docs/club-api.md): tokens a club manager
 * makes in the manager console, and /api/club/v1/* that those tokens call.
 *
 * A token belongs to one club (optionally one team) and carries scopes:
 *   read             the club, its teams, their games, licence lists, the club's matches
 *   rosters:write    PUT / DELETE the roster of a game
 *   teams:write      PUT a team's squad (its saved team)
 *   licences:write   PUT a licence list (players, scorers, coaches)
 * It acts as the manager who made it: every route calls the same functions the
 * manager console uses (lib/teams.js, lib/licences.js, lib/clubs.js), which
 * hold all the rules (the team must be the club's, the game the team's, the
 * gender rule, limits). Nothing here re-implements them. Games are read-only:
 * official games come from the VolleyManager schedule.
 *
 * Manager console (a session; server.js -> lib/manageApi.js):
 *   list({ clubId })                      the club's tokens (never the secret)
 *   create({ actorId, clubId, body })     { label, scopes, team_id?, expires_in_days?, password } -> the token, once
 *                                         a token with a write scope needs the manager's password
 *   revoke({ actorId, clubId, id })
 * API (a token; server.js):
 *   authenticate(raw)                     the principal, or { error } (401 / 403)
 *   handle({ principal, method, pathname, query, body })   { status, body }
 *
 * Answers are { status, body } like lib/accounts.js; nothing throws. Personal
 * data (rosters, licence lists) flows only to a token of that club.
 */
import { createHash, randomBytes } from 'node:crypto'
import { fail, invalid, isUuid, notFound, ok, unavailable } from './accounts.js'
import { LICENCE_LISTS } from './licences.js'

export const SCOPES = Object.freeze(['read', 'rosters:write', 'teams:write', 'licences:write'])
export const WRITE_SCOPES = Object.freeze(['rosters:write', 'teams:write', 'licences:write'])
export const TOKEN_PREFIX = 'ovk_'
export const MAX_TOKENS_PER_CLUB = 20
export const MAX_EXPIRY_DAYS = 730
const TOKEN_RE = /^ovk_[A-Za-z0-9_-]{43}$/
const MISSING = new Set(['42P01', '42703'])
const DAY_MS = 86400000
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))
export const hashToken = (raw) => createHash('sha256').update(String(raw)).digest()

const UNAUTH = () => fail(401, 'OV_TOKEN_INVALID', 'Missing, unknown, revoked or expired API token')
const NEEDS_SCOPE = (s) => fail(403, 'OV_SCOPE_REQUIRED', `This token has no ${s} scope`)
const OWN_TEAM_ONLY = () => fail(403, 'OV_TOKEN_TEAM_ONLY', 'This token is limited to one team')
const MANAGER_GONE = () => fail(403, 'OV_TOKEN_OWNER', 'The manager who made this token no longer manages the club')
const PASSWORD_NEEDED = () => fail(403, 'OV_PASSWORD_REQUIRED', 'A token that can write needs your account password')
const PASSWORD_INVALID = () => fail(403, 'OV_PASSWORD_INVALID', 'Wrong password')

export function createClubApi ({ pool, audit, clubs, teams, licences = null, publicApi = null, auth = null, logger = console } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createClubApi: pool is required')

  async function guarded (where, fn) {
    try {
      return await fn()
    } catch (err) {
      if (MISSING.has(err?.code)) return unavailable()
      logger.error?.(`[club-api] ${where} failed:`, err?.message)
      return unavailable()
    }
  }

  // token row and its audit row together: no token without its audit entry (never shown, never usable)
  async function withTx (fn) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  const tokenOut = (r) => ({
    id: r.id, label: r.label, prefix: r.prefix, scopes: r.scopes, team_id: r.team_id ?? null,
    created_at: iso(r.created_at), last_used_at: iso(r.last_used_at), expires_at: iso(r.expires_at), revoked_at: iso(r.revoked_at)
  })

  // ------------------------------------------------------------ manager console
  async function list ({ clubId } = {}) {
    if (!isUuid(clubId)) return notFound()
    return guarded('list', async () => {
      const { rows } = await pool.query(
        `SELECT id, label, prefix, scopes, team_id, created_at, last_used_at, expires_at, revoked_at
           FROM public.club_api_tokens WHERE club_id = $1 ORDER BY created_at DESC LIMIT 100`, [clubId])
      return ok({ tokens: rows.map(tokenOut) })
    })
  }

  async function create ({ actorId, clubId, body } = {}) {
    if (!isUuid(clubId)) return notFound()
    if (!isObj(body)) return invalid('body: must be an object')
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (label.length < 1 || label.length > 60) return invalid('label: 1 to 60 characters')
    const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes)] : null
    if (!scopes || !scopes.length || scopes.some((s) => !SCOPES.includes(s))) return invalid(`scopes: any of ${SCOPES.join(', ')}`)
    if (WRITE_SCOPES.some((s) => scopes.includes(s)) && !scopes.includes('read')) scopes.unshift('read')
    const teamId = body.team_id ?? null
    if (teamId !== null && !isUuid(teamId)) return invalid('team_id: a team id or null')
    let expires = null
    if (body.expires_in_days != null) {
      const d = Number(body.expires_in_days)
      if (!Number.isInteger(d) || d < 1 || d > MAX_EXPIRY_DAYS) return invalid(`expires_in_days: 1 to ${MAX_EXPIRY_DAYS}`)
      expires = new Date(Date.now() + d * DAY_MS)
    }
    const writes = WRITE_SCOPES.some((s) => scopes.includes(s))
    if (writes) {
      if (typeof body.password !== 'string' || !body.password) return PASSWORD_NEEDED()
      if (!auth || typeof auth.verifyPassword !== 'function') return unavailable()
      let r
      try {
        r = await auth.verifyPassword(actorId, body.password)
      } catch (err) {
        if (err?.code === 'AUTH_BUSY') return fail(503, 'OV_BUSY', 'Busy, try again')
        throw err
      }
      if (r?.locked) return fail(429, 'OV_TOO_MANY_ATTEMPTS', 'Too many attempts. Please wait a few minutes.')
      if (r?.ok !== true) return PASSWORD_INVALID()
    }
    return guarded('create', async () => {
      if (teamId && !(await teams.teamOfClub(clubId, teamId))) return notFound()
      const { rows: [n] } = await pool.query(
        'SELECT count(*)::int AS n FROM public.club_api_tokens WHERE club_id = $1 AND revoked_at IS NULL', [clubId])
      if (n.n >= MAX_TOKENS_PER_CLUB) return fail(409, 'OV_TOKEN_LIMIT', `At most ${MAX_TOKENS_PER_CLUB} active tokens per club: revoke one first`)
      const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url')
      const row = await withTx(async (client) => {
        const { rows: [r] } = await client.query(
          `INSERT INTO public.club_api_tokens (club_id, created_by, team_id, label, prefix, token_hash, scopes, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, label, prefix, scopes, team_id, created_at, last_used_at, expires_at, revoked_at`,
          [clubId, actorId, teamId, label, raw.slice(0, 8), hashToken(raw), scopes, expires])
        await audit(client, { actorId, action: 'club_api.token', details: { club_id: clubId, token_id: r.id, scopes, team_id: teamId, created: true } })
        return r
      })
      return { status: 201, body: { data: { token: raw, ...tokenOut(row) }, error: null } }
    })
  }

  async function revoke ({ actorId, clubId, id } = {}) {
    if (!isUuid(clubId) || !isUuid(id)) return notFound()
    return guarded('revoke', async () => {
      const found = await withTx(async (client) => {
        const { rows: [row] } = await client.query(
          `UPDATE public.club_api_tokens SET revoked_at = coalesce(revoked_at, now())
            WHERE id = $1 AND club_id = $2 RETURNING id`, [id, clubId])
        if (!row) return false
        await audit(client, { actorId, action: 'club_api.token', details: { club_id: clubId, token_id: id, revoked: true } })
        return true
      })
      if (!found) return notFound()
      return ok({ revoked: true })
    })
  }

  // ------------------------------------------------------------ token auth
  const lastTouch = new Map() // token id -> ms of the last last_used_at write
  async function authenticate (raw) {
    if (typeof raw !== 'string' || !TOKEN_RE.test(raw)) return { error: UNAUTH() }
    try {
      const { rows: [t] } = await pool.query(
        `SELECT id, club_id, created_by, team_id, scopes FROM public.club_api_tokens
          WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [hashToken(raw)])
      if (!t) return { error: UNAUTH() }
      // acts as its manager: gone when they no longer manage the club (an admin made it: admins always may)
      const stillManager = await clubs.isManager(t.created_by, t.club_id) || await isAdmin(t.created_by)
      if (!stillManager) return { error: MANAGER_GONE() }
      const now = Date.now()
      if (now - (lastTouch.get(t.id) || 0) > 60000) {
        lastTouch.set(t.id, now)
        if (lastTouch.size > 5000) lastTouch.clear()
        pool.query('UPDATE public.club_api_tokens SET last_used_at = now() WHERE id = $1', [t.id]).catch(() => {})
      }
      return { principal: { tokenId: t.id, clubId: t.club_id, userId: t.created_by, teamId: t.team_id, scopes: t.scopes } }
    } catch (err) {
      if (MISSING.has(err?.code)) return { error: UNAUTH() }
      logger.error?.('[club-api] authenticate failed:', err?.message)
      return { error: unavailable() }
    }
  }
  async function isAdmin (userId) {
    const { rows } = await pool.query(`SELECT 1 FROM public.profiles WHERE user_id = $1 AND 'admin' = ANY(roles)`, [userId])
    return rows.length > 0
  }

  // ------------------------------------------------------------ the API
  const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
  const GAME = '([0-9]{1,12})'
  const MATCH = '([A-Za-z0-9_.:-]{1,200})'
  const q = (query, k) => { const v = query?.get?.(k); return v == null ? undefined : v }

  // the club's team names (what matches carry as home / away)
  async function teamNames (clubId, teamId = null) {
    const { rows } = await pool.query(
      `SELECT team_name FROM public.club_teams WHERE club_id = $1 ${teamId ? 'AND id = $2' : ''}`, teamId ? [clubId, teamId] : [clubId])
    return rows.map((r) => r.team_name)
  }

  // [method, regex, scope, handler(match, ctx)]; ctx = { p: principal, query, body }
  // team routes check the team is the club's (and the token's team); the module does the rest
  const ownTeam = (fn) => async (m, c) => {
    if (c.p.teamId && c.p.teamId !== m[1]) return OWN_TEAM_ONLY()
    if (!(await teams.teamOfClub(c.p.clubId, m[1]))) return notFound()
    return fn(m, c)
  }
  const clubWide = (fn) => (m, c) => (c.p.teamId ? OWN_TEAM_ONLY() : fn(m, c))
  const routes = [
    ['GET', /^\/club$/, 'read', clubWide((m, c) => clubs.clubDetail({ id: c.p.clubId }))],
    ['GET', /^\/teams$/, 'read', async (m, c) => {
      const r = await teams.clubTeams({ clubId: c.p.clubId })
      if (r.status !== 200) return r
      // ids and names only: the team managers' accounts are not the API's business
      return ok({ teams: r.body.data.teams.filter((t) => !c.p.teamId || t.id === c.p.teamId).map((t) => ({ id: t.id, name: t.name })) })
    }],
    ['GET', new RegExp(`^/teams/${ID}/games$`), 'read', ownTeam((m) => teams.games({ teamId: m[1] }))],
    ['GET', new RegExp(`^/teams/${ID}/games/${GAME}/roster$`), 'read', ownTeam((m) => teams.getRoster({ teamId: m[1], game: m[2] }))],
    ['PUT', new RegExp(`^/teams/${ID}/games/${GAME}/roster$`), 'rosters:write', ownTeam((m, c) => teams.putRoster({ actorId: c.p.userId, teamId: m[1], game: m[2], body: c.body }))],
    ['DELETE', new RegExp(`^/teams/${ID}/games/${GAME}/roster$`), 'rosters:write', ownTeam((m, c) => teams.deleteRoster({ actorId: c.p.userId, teamId: m[1], game: m[2] }))],
    ['GET', new RegExp(`^/teams/${ID}/squad$`), 'read', ownTeam((m) => teams.squad({ teamId: m[1] }))],
    ['PUT', new RegExp(`^/teams/${ID}/squad$`), 'teams:write', ownTeam((m, c) => teams.putSquad({ actorId: c.p.userId, teamId: m[1], body: c.body }))],
    ['GET', /^\/licences$/, 'read', clubWide((m, c) => (licences ? licences.clubList({ clubId: c.p.clubId }) : notFound()))],
    ...LICENCE_LISTS.map((list) => ['PUT', new RegExp(`^/licences/${list}$`), 'licences:write',
      clubWide((m, c) => (licences ? licences.putList({ clubId: c.p.clubId, list, people: isObj(c.body) ? c.body.people : undefined, userId: c.p.userId }) : notFound()))]),
    // the club's games from today, all teams (a list of the per-team schedules)
    ['GET', /^\/games$/, 'read', async (m, c) => {
      const { rows } = await pool.query('SELECT id FROM public.club_teams WHERE club_id = $1 ' + (c.p.teamId ? 'AND id = $2' : '') + ' ORDER BY lower(team_name)', c.p.teamId ? [c.p.clubId, c.p.teamId] : [c.p.clubId])
      const out = []
      for (const t of rows.slice(0, 60)) {
        const r = await teams.games({ teamId: t.id })
        if (r.status === 200) for (const g of r.body.data.games) out.push({ team_id: t.id, ...g })
      }
      out.sort((a, b) => String(a.datetime ?? '').localeCompare(String(b.datetime ?? '')))
      return ok({ games: out })
    }],
    // the club's matches as the public API shows them (no names), filtered to the club's teams
    ['GET', /^\/matches$/, 'read', async (m, c) => {
      if (!publicApi) return notFound()
      const names = await teamNames(c.p.clubId, c.p.teamId)
      return publicApi.list({ from: q(c.query, 'from'), to: q(c.query, 'to'), status: q(c.query, 'status'), limit: q(c.query, 'limit'), teams: names })
    }],
    ['GET', new RegExp(`^/matches/${MATCH}(?:/(live|stats))?$`), 'read', async (m, c) => {
      if (!publicApi) return notFound()
      const names = await teamNames(c.p.clubId, c.p.teamId)
      if (!(await publicApi.involves(m[1], names))) return notFound()
      return m[2] === 'live' ? publicApi.live(m[1]) : m[2] === 'stats' ? publicApi.stats(m[1]) : publicApi.info(m[1])
    }]
  ]

  /** { status, body } for one call of a token; writes are audited with the token id. */
  async function handle ({ principal, method, pathname, query, body } = {}) {
    const sub = String(pathname || '').replace(/^\/api\/club\/v1/, '') || '/'
    let hit = null
    let methodOk = false
    for (const r of routes) {
      const m = r[1].exec(sub)
      if (!m) continue
      if (r[0] !== method) { methodOk = true; continue }
      hit = { r, m }
      break
    }
    if (!hit) return methodOk ? fail(405, 'OV_METHOD_NOT_ALLOWED', 'Method not allowed') : notFound()
    const [, , scope, fn] = hit.r
    if (!principal.scopes.includes(scope)) return NEEDS_SCOPE(scope)
    let out
    try {
      out = await fn(hit.m, { p: principal, query, body })
    } catch (err) {
      logger.error?.('[club-api] handler failed:', err?.message)
      out = unavailable()
    }
    if (method !== 'GET') {
      audit(pool, { actorId: principal.userId, action: 'club_api.call', details: { token_id: principal.tokenId, club_id: principal.clubId, method, route: hit.r[1].source.slice(0, 80), status: out.status } }).catch(() => {})
    }
    return out
  }

  return { list, create, revoke, authenticate, handle }
}
