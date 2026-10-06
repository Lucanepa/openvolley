/**
 * manageApi — routing and role checks of the new endpoints
 * (docs/scorer-accounts-spec.md section 5). server.js authenticates the
 * caller, applies the rate limits, reads the body and resolves `access`
 * (lib/access.js, from the database); this module decides who may call what
 * and hands the request to lib/accounts.js / lib/savedTeams.js.
 *
 *   POST   /api/account/redeem-invite                 any signed-in account
 *   POST   /api/match/official-check                  canScore (else 403 OV_SCORER_REQUIRED)
 *   *      /api/admin/*                               isAdmin  (else 403 OV_FORBIDDEN)
 *   GET    /api/saved-teams                           canReadTeams
 *   POST/PATCH/DELETE/PUT /api/saved-teams/*         canManageTeams
 *
 * route() returns { status, body, changes? } and never throws (the handlers
 * never throw either).
 */

import { fail, notFound } from './accounts.js'

const FORBIDDEN = () => fail(403, 'OV_FORBIDDEN', 'You do not have access to this')
const SCORER_REQUIRED = () => fail(403, 'OV_SCORER_REQUIRED', 'Your account is not approved for official matches yet')
const METHOD_NOT_ALLOWED = () => fail(405, 'OV_METHOD_NOT_ALLOWED', 'Method not allowed')
const ID = '([0-9a-fA-F-]{36})'

/** Which family a path belongs to, or null (also used by server.js, before the module loads). */
export function manageFamilyOf (pathname) {
  if (pathname === '/api/account/redeem-invite') return 'account'
  if (pathname === '/api/match/official-check') return 'officialCheck'
  if (pathname.startsWith('/api/admin/')) return 'admin'
  if (pathname === '/api/saved-teams' || pathname.startsWith('/api/saved-teams/')) return 'savedTeams'
  return null
}

export function createManageApi ({ accounts, savedTeams }) {
  const q = (query, k) => {
    const v = query?.get?.(k)
    return v == null ? undefined : v
  }

  // [method, regex, need, handler(match, ctx)]
  const routes = [
    ['POST', /^\/api\/account\/redeem-invite$/, 'any', (m, c) => accounts.redeemInvite({ userId: c.user.id, code: c.body?.code })],
    ['POST', /^\/api\/match\/official-check$/, 'score', (m, c) => accounts.officialCheck({ userId: c.user.id, body: c.body })],

    ['GET', /^\/api\/admin\/accounts$/, 'admin', (m, c) => accounts.listAccounts({ filter: q(c.query, 'filter') || 'pending', q: q(c.query, 'q') ?? '', limit: q(c.query, 'limit') })],
    ['POST', new RegExp(`^/api/admin/accounts/${ID}/roles$`), 'admin', (m, c) => accounts.setRoles({ actor: { id: c.user.id, access: c.access }, userId: m[1], body: c.body })],
    ['GET', /^\/api\/admin\/invites$/, 'admin', () => accounts.listInvites()],
    ['POST', /^\/api\/admin\/invites$/, 'admin', (m, c) => accounts.createInvite({ actorId: c.user.id, body: c.body })],
    ['POST', new RegExp(`^/api/admin/invites/${ID}/revoke$`), 'admin', (m, c) => accounts.revokeInvite({ actorId: c.user.id, id: m[1] })],
    ['GET', /^\/api\/admin\/official-games$/, 'admin', (m, c) => accounts.listOfficialGames({ from: q(c.query, 'from'), to: q(c.query, 'to'), q: q(c.query, 'q') ?? '' })],
    ['GET', /^\/api\/admin\/matches$/, 'admin', (m, c) => accounts.listMatches({ state: q(c.query, 'state') || 'closed', q: q(c.query, 'q') ?? '', limit: q(c.query, 'limit') })],
    ['POST', new RegExp(`^/api/admin/matches/${ID}/reopen$`), 'admin', (m, c) => accounts.reopenMatch({ actorId: c.user.id, matchId: m[1], body: c.body })],
    ['POST', new RegExp(`^/api/admin/matches/${ID}/editors$`), 'admin', (m, c) => accounts.addMatchEditor({ actorId: c.user.id, matchId: m[1], body: c.body })],
    ['POST', new RegExp(`^/api/admin/matches/${ID}/release-game$`), 'admin', (m, c) => accounts.releaseGame({ actorId: c.user.id, matchId: m[1], body: c.body })],
    ['GET', /^\/api\/admin\/audit$/, 'admin', (m, c) => accounts.listAudit({ limit: q(c.query, 'limit'), before: q(c.query, 'before'), action: q(c.query, 'action') })],

    ['GET', /^\/api\/saved-teams$/, 'readTeams', () => savedTeams.getBundle()],
    ['POST', /^\/api\/saved-teams\/competitions$/, 'manageTeams', (m, c) => savedTeams.createCompetition({ actorId: c.user.id, body: c.body })],
    ['PATCH', new RegExp(`^/api/saved-teams/competitions/${ID}$`), 'manageTeams', (m, c) => savedTeams.updateCompetition({ id: m[1], body: c.body })],
    ['DELETE', new RegExp(`^/api/saved-teams/competitions/${ID}$`), 'manageTeams', (m) => savedTeams.deleteCompetition({ id: m[1] })],
    ['POST', /^\/api\/saved-teams\/teams$/, 'manageTeams', (m, c) => savedTeams.createTeam({ actorId: c.user.id, body: c.body })],
    ['PATCH', new RegExp(`^/api/saved-teams/teams/${ID}$`), 'manageTeams', (m, c) => savedTeams.updateTeam({ id: m[1], body: c.body })],
    ['DELETE', new RegExp(`^/api/saved-teams/teams/${ID}$`), 'manageTeams', (m) => savedTeams.deleteTeam({ id: m[1] })],
    ['PUT', new RegExp(`^/api/saved-teams/teams/${ID}/roster$`), 'manageTeams', (m, c) => savedTeams.putRoster({ id: m[1], body: c.body })]
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

  /** The role a whole family needs before anything about the path is revealed. */
  function familyRefusal (family, method, access) {
    if (family === 'admin') return refuse('admin', access)
    if (family === 'savedTeams') return refuse(method === 'GET' ? 'readTeams' : 'manageTeams', access)
    return null
  }

  async function route ({ method, pathname, query, body, user, access }) {
    const family = manageFamilyOf(pathname)
    if (!family) return notFound()
    const early = familyRefusal(family, method, access)
    if (early) return early
    let pathKnown = false
    for (const [m, re, need, handler] of routes) {
      const match = re.exec(pathname)
      if (!match) continue
      pathKnown = true
      if (m !== method) continue
      const refusal = refuse(need, access)
      if (refusal) return refusal
      // path ids are compared lower-case (uuid columns answer lower-case)
      const ids = match.map((v, i) => (i > 0 && typeof v === 'string' ? v.toLowerCase() : v))
      if (ids.slice(1).some((v) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v))) return notFound()
      return handler(ids, { user, access, body, query })
    }
    return pathKnown ? METHOD_NOT_ALLOWED() : notFound()
  }

  return { route }
}
