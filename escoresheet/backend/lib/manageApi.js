/**
 * manageApi — routing and role checks of the new endpoints
 * (docs/scorer-accounts-spec.md section 5). server.js authenticates the
 * caller, applies the rate limits, reads the body and resolves `access`
 * (lib/access.js, from the database); this module decides who may call what
 * and hands the request to lib/accounts.js / lib/savedTeams.js.
 *
 *   GET    /api/me                                    any signed-in account (roles, flags per app)
 *   POST   /api/account/join { app }                  any signed-in account (joins indoor|beach)
 *   POST   /api/account/redeem-invite                 any signed-in account
 *   POST   /api/match/official-check                  canScore in body.sport_type (else 403 OV_SCORER_REQUIRED)
 *   *      /api/admin/*[?app=indoor|beach]            isAdmin  (else 403 OV_FORBIDDEN)
 *   GET    /api/saved-teams[?sport=indoor|beach|all]  canReadTeams of that sport (no sport = indoor;
 *                                                     all = the sports the account may read)
 *   POST/PATCH/DELETE/PUT /api/saved-teams/*         canManageTeams of the competition's sport
 *   *      /api/beach/*                               beach canReadTeams (beach:scorer, beach:competition_manager,
 *                                                     admin); lib/beachTournaments.js decides the rest (T1)
 *   GET/POST /api/account/approval-pin[/remove]      any signed-in account (lib/approvals.js)
 *   GET    /api/account/approvals                    any signed-in account: its own approvals
 *   POST/GET /api/approvals, DELETE /api/approvals/:id  any signed-in account; the
 *                                                    handlers check match ownership and the
 *                                                    official's role in the match's sport
 *   GET    /api/admin/approvals[?app=indoor|beach]   isAdmin
 *   GET    /api/admin/matches/:id/revisions          isAdmin: undone / edited events (db/015)
 *
 * Sports (db/012, lib/access.js): every check uses the sport of the ROW (the
 * body's sport_type, the competition of a saved team, the match of an
 * approval), never the app the client says it is. Only the global admin
 * administers both apps (v1).
 *
 * route() returns { status, body, changes? } and never throws (the handlers
 * never throw either).
 */

import { fail, notFound } from './accounts.js'
import { SPORTS, accessForSport, sportsWith } from './access.js'

// Before lib/approvals.js is wired (or on a server built without it)
const APPROVALS_OFF = () => fail(503, 'OV_APPROVAL_UNAVAILABLE', 'Approval with an account is not available on this server')

const FORBIDDEN = () => fail(403, 'OV_FORBIDDEN', 'You do not have access to this')
const SCORER_REQUIRED = () => fail(403, 'OV_SCORER_REQUIRED', 'Your account is not approved for official matches yet')
const METHOD_NOT_ALLOWED = () => fail(405, 'OV_METHOD_NOT_ALLOWED', 'Method not allowed')
const ID = '([0-9a-fA-F-]{36})'

/** Which family a path belongs to, or null (also used by server.js, before the module loads). */
export function manageFamilyOf (pathname) {
  if (pathname === '/api/me') return 'me'
  if (pathname === '/api/account/join') return 'join'
  if (pathname === '/api/account/redeem-invite') return 'account'
  if (pathname === '/api/match/official-check') return 'officialCheck'
  if (pathname.startsWith('/api/admin/')) return 'admin'
  if (pathname === '/api/saved-teams' || pathname.startsWith('/api/saved-teams/')) return 'savedTeams'
  if (pathname.startsWith('/api/beach/')) return 'beach'
  if (pathname === '/api/account/approval-pin' || pathname === '/api/account/approval-pin/remove') return 'approvalPin'
  if (pathname === '/api/approvals' || pathname.startsWith('/api/approvals/') || pathname === '/api/account/approvals') return 'approvals'
  return null
}

export function createManageApi ({ accounts, savedTeams, beach = null, approvals = null, revisions = null, activity = null }) {
  // approvals?.x, or 503 when the module is not there
  const ap = (name) => (args) => (approvals && typeof approvals[name] === 'function' ? approvals[name](args) : APPROVALS_OFF())
  const q = (query, k) => {
    const v = query?.get?.(k)
    return v == null ? undefined : v
  }
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

  // Role checks of one sport: an async need(ids, ctx) answers null (allowed)
  // or the refusal; a target the sport of which is unknown (no such row, a
  // bad body) is left to the handler (404 / 400).
  const scoreInBodySport = (m, c) =>
    accessForSport(c.access, c.body?.sport_type === 'beach' ? 'beach' : 'indoor').canScore ? null : SCORER_REQUIRED()
  const manageTeamsOf = (resolve) => async (m, c) => {
    const r = await resolve(m, c)
    if (r?.error) return r.error
    if (!r?.sport) return null
    return accessForSport(c.access, r.sport).canManageTeams ? null : FORBIDDEN()
  }
  const competitionSport = (id) => savedTeams.sportOf({ competitionId: id })
  const teamSport = (id) => savedTeams.sportOf({ teamId: id })
  const newCompetitionSport = (m, c) => {
    const sport = isPlainObject(c.body) ? (c.body.sport ?? 'indoor') : null
    return { sport: SPORTS.includes(sport) ? sport : null }
  }
  const newTeamSport = (m, c) => (isPlainObject(c.body) && typeof c.body.competition_id === 'string'
    ? competitionSport(c.body.competition_id.toLowerCase())
    : { sport: null })
  // GET ?sport=: that sport's read right; 'all' is the sports the account may read
  const readTeams = (m, c) => {
    const sport = q(c.query, 'sport') || 'indoor'
    if (sport === 'all') return sportsWith(c.access, 'canReadTeams').length ? null : FORBIDDEN()
    if (!SPORTS.includes(sport)) return null // the handler answers 400
    return accessForSport(c.access, sport).canReadTeams ? null : FORBIDDEN()
  }

  // [method, regex, need, handler(match, ctx)]
  const routes = [
    ['GET', /^\/api\/me$/, 'any', (m, c) => accounts.me({ userId: c.user.id, access: c.access })],
    ['POST', /^\/api\/account\/join$/, 'any', (m, c) => accounts.joinApp({ userId: c.user.id, body: c.body })],
    ['POST', /^\/api\/account\/redeem-invite$/, 'any', (m, c) => accounts.redeemInvite({ userId: c.user.id, code: c.body?.code })],
    ['POST', /^\/api\/match\/official-check$/, scoreInBodySport, (m, c) => accounts.officialCheck({ userId: c.user.id, body: c.body })],

    ['GET', /^\/api\/admin\/accounts$/, 'admin', (m, c) => accounts.listAccounts({ filter: q(c.query, 'filter') || 'pending', q: q(c.query, 'q') ?? '', limit: q(c.query, 'limit'), app: q(c.query, 'app') })],
    ['POST', new RegExp(`^/api/admin/accounts/${ID}/roles$`), 'admin', (m, c) => accounts.setRoles({ actor: { id: c.user.id, access: c.access }, userId: m[1], body: c.body })],
    ['GET', /^\/api\/admin\/invites$/, 'admin', (m, c) => accounts.listInvites({ app: q(c.query, 'app') })],
    ['POST', /^\/api\/admin\/invites$/, 'admin', (m, c) => accounts.createInvite({ actorId: c.user.id, body: c.body, app: q(c.query, 'app') })],
    ['POST', new RegExp(`^/api/admin/invites/${ID}/revoke$`), 'admin', (m, c) => accounts.revokeInvite({ actorId: c.user.id, id: m[1] })],
    ['GET', /^\/api\/admin\/official-games$/, 'admin', (m, c) => accounts.listOfficialGames({ from: q(c.query, 'from'), to: q(c.query, 'to'), q: q(c.query, 'q') ?? '' })],
    ['GET', /^\/api\/admin\/matches$/, 'admin', (m, c) => accounts.listMatches({ state: q(c.query, 'state') || 'closed', q: q(c.query, 'q') ?? '', limit: q(c.query, 'limit'), app: q(c.query, 'app') })],
    ['POST', new RegExp(`^/api/admin/matches/${ID}/reopen$`), 'admin', (m, c) => accounts.reopenMatch({ actorId: c.user.id, matchId: m[1], body: c.body })],
    ['POST', new RegExp(`^/api/admin/matches/${ID}/editors$`), 'admin', (m, c) => accounts.addMatchEditor({ actorId: c.user.id, matchId: m[1], body: c.body })],
    ['POST', new RegExp(`^/api/admin/matches/${ID}/release-game$`), 'admin', (m, c) => accounts.releaseGame({ actorId: c.user.id, matchId: m[1], body: c.body })],
    // Undone / edited events of a match (db/015, lib/eventRevisions.js)
    ['GET', new RegExp(`^/api/admin/matches/${ID}/revisions$`), 'admin', (m) => (revisions ? revisions.listForMatch({ matchId: m[1] }) : notFound())],
    ['GET', /^\/api\/admin\/audit$/, 'admin', (m, c) => accounts.listAudit({ limit: q(c.query, 'limit'), before: q(c.query, 'before'), action: q(c.query, 'action'), app: q(c.query, 'app') })],
    ['GET', /^\/api\/admin\/approvals$/, 'admin', (m, c) => ap('adminSearch')({ q: q(c.query, 'q') ?? '', includeRevoked: q(c.query, 'include_revoked'), limit: q(c.query, 'limit'), app: q(c.query, 'app') })],

    // Account approvals (docs/account-approval-spec.md section 3)
    ['GET', /^\/api\/account\/approval-pin$/, 'any', (m, c) => ap('getPinStatus')({ userId: c.user.id })],
    ['POST', /^\/api\/account\/approval-pin$/, 'any', (m, c) => ap('setPin')({ userId: c.user.id, body: c.body })],
    ['POST', /^\/api\/account\/approval-pin\/remove$/, 'any', (m, c) => ap('removePin')({ userId: c.user.id, body: c.body })],
    ['POST', /^\/api\/approvals$/, 'any', (m, c) => ap('approve')({ callerId: c.user.id, access: c.access, body: c.body, ip: c.ip, lang: c.lang })],
    ['GET', /^\/api\/account\/approvals$/, 'any', (m, c) => ap('listMine')({ callerId: c.user.id, limit: q(c.query, 'limit') })],
    ['GET', /^\/api\/approvals$/, 'any', (m, c) => ap('listForMatch')({ callerId: c.user.id, access: c.access, externalId: q(c.query, 'external_id') })],
    ['DELETE', new RegExp(`^/api/approvals/${ID}$`), 'any', (m, c) => ap('revoke')({ callerId: c.user.id, access: c.access, id: m[1] })],

    ['GET', /^\/api\/saved-teams$/, readTeams, (m, c) => savedTeams.getBundle({ sport: q(c.query, 'sport'), sports: sportsWith(c.access, 'canReadTeams') })],
    ['POST', /^\/api\/saved-teams\/competitions$/, manageTeamsOf(newCompetitionSport), (m, c) => savedTeams.createCompetition({ actorId: c.user.id, body: c.body })],
    ['PATCH', new RegExp(`^/api/saved-teams/competitions/${ID}$`), manageTeamsOf((m) => competitionSport(m[1])), (m, c) => savedTeams.updateCompetition({ id: m[1], body: c.body })],
    ['DELETE', new RegExp(`^/api/saved-teams/competitions/${ID}$`), manageTeamsOf((m) => competitionSport(m[1])), (m) => savedTeams.deleteCompetition({ id: m[1] })],
    ['POST', /^\/api\/saved-teams\/teams$/, manageTeamsOf(newTeamSport), (m, c) => savedTeams.createTeam({ actorId: c.user.id, body: c.body })],
    ['PATCH', new RegExp(`^/api/saved-teams/teams/${ID}$`), manageTeamsOf((m) => teamSport(m[1])), (m, c) => savedTeams.updateTeam({ id: m[1], body: c.body })],
    ['DELETE', new RegExp(`^/api/saved-teams/teams/${ID}$`), manageTeamsOf((m) => teamSport(m[1])), (m) => savedTeams.deleteTeam({ id: m[1] })],
    ['PUT', new RegExp(`^/api/saved-teams/teams/${ID}/roster$`), manageTeamsOf((m) => teamSport(m[1])), (m, c) => savedTeams.putRoster({ id: m[1], body: c.body })]
  ]

  /** The role check of a route: null when allowed, else the 403 answer. */
  function refuse (need, access) {
    switch (need) {
      case 'any': return null
      case 'score': return access?.canScore ? null : SCORER_REQUIRED()
      case 'admin': return access?.isAdmin ? null : FORBIDDEN()
      case 'readTeams': return access?.canReadTeams ? null : FORBIDDEN()
      case 'manageTeams': return access?.canManageTeams ? null : FORBIDDEN()
      default: return FORBIDDEN()
    }
  }

  /** The role a whole family needs before anything about the path is revealed (saved teams: in some sport). */
  function familyRefusal (family, method, access) {
    if (family === 'admin') return refuse('admin', access)
    if (family === 'savedTeams') return sportsWith(access, method === 'GET' ? 'canReadTeams' : 'canManageTeams').length ? null : FORBIDDEN()
    // tournaments (lib/beachTournaments.js): some beach right first
    if (family === 'beach') return accessForSport(access, 'beach').canReadTeams ? null : FORBIDDEN()
    return null
  }

  async function route ({ method, pathname, query, body, user, access, ip, lang }) {
    const family = manageFamilyOf(pathname)
    if (!family) return notFound()
    const early = familyRefusal(family, method, access)
    if (early) return early
    if (family === 'beach') return beach ? beach.route({ method, pathname, query, body, user, access }) : notFound()
    let pathKnown = false
    for (const [m, re, need, handler] of routes) {
      const match = re.exec(pathname)
      if (!match) continue
      pathKnown = true
      if (m !== method) continue
      if (typeof need !== 'function') {
        const refusal = refuse(need, access)
        if (refusal) return refusal
      }
      // path ids are compared lower-case (uuid columns answer lower-case)
      const ids = match.map((v, i) => (i > 0 && typeof v === 'string' ? v.toLowerCase() : v))
      if (ids.slice(1).some((v) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v))) return notFound()
      const ctx = { user, access, body, query, ip, lang }
      if (typeof need === 'function') {
        const refusal = await need(ids, ctx)
        if (refusal) return refusal
      }
      return handler(ids, ctx)
    }
    return pathKnown ? METHOD_NOT_ALLOWED() : notFound()
  }

  return { route }
}
