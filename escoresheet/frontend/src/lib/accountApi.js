/**
 * Account, admin and saved-team endpoints (spec section 5). One function per
 * endpoint; every one resolves to { data, error, status } and never throws.
 * The server enforces every rule: these calls only carry the request.
 */

import { apiRequest } from './apiClient'

const enc = encodeURIComponent

function query(params) {
  const parts = []
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    parts.push(`${enc(key)}=${enc(String(value))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

/** Normalise a typed invite code for display: uppercase, groups of four. */
export function formatInviteCode(raw) {
  const clean = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12)
  return clean.replace(/(.{4})(?=.)/g, '$1-')
}

// ── Account and match ──

/** POST /api/account/redeem-invite → { roles, role_granted, already_had } */
export function redeemInvite(code) {
  return apiRequest('POST', '/api/account/redeem-invite', { code: String(code || '').trim() }, { fallbackError: 'Invite code not accepted' })
}

/** POST /api/match/official-check → { taken: false } | { taken: true, claim } */
export function officialCheck({ game_n, scheduled_at = null, sport_type = 'indoor', external_id = null }, { timeoutMs } = {}) {
  return apiRequest('POST', '/api/match/official-check', { game_n, scheduled_at, sport_type, external_id }, timeoutMs ? { timeoutMs } : undefined)
}

// The courtesy check before creating a match: local-first creation never waits
// longer than this on a slow venue network (a timeout counts as "unknown").
export const OFFICIAL_CHECK_CONFIRM_TIMEOUT_MS = 3500

// ── Admin ──

export const admin = {
  listAccounts({ filter = 'pending', q, limit } = {}) {
    return apiRequest('GET', `/api/admin/accounts${query({ filter, q, limit })}`)
  },
  setRoles(userId, { add = [], remove = [] } = {}) {
    return apiRequest('POST', `/api/admin/accounts/${enc(userId)}/roles`, { add, remove })
  },
  listInvites() {
    return apiRequest('GET', '/api/admin/invites')
  },
  createInvite({ label, club = null, role = 'scorer', max_uses = 1, expires_at } = {}) {
    const body = { label, club, role, max_uses }
    if (expires_at !== undefined) body.expires_at = expires_at
    return apiRequest('POST', '/api/admin/invites', body)
  },
  revokeInvite(id) {
    return apiRequest('POST', `/api/admin/invites/${enc(id)}/revoke`, {})
  },
  listOfficialGames({ from, to, q } = {}) {
    return apiRequest('GET', `/api/admin/official-games${query({ from, to, q })}`)
  },
  listMatches({ state = 'closed', q, limit } = {}) {
    return apiRequest('GET', `/api/admin/matches${query({ state, q, limit })}`)
  },
  reopenMatch(matchId, { reason }) {
    return apiRequest('POST', `/api/admin/matches/${enc(matchId)}/reopen`, { reason })
  },
  addMatchEditor(matchId, { email }) {
    return apiRequest('POST', `/api/admin/matches/${enc(matchId)}/editors`, { email })
  },
  releaseGame(matchId, { reason }) {
    return apiRequest('POST', `/api/admin/matches/${enc(matchId)}/release-game`, { reason })
  },
  listAudit({ limit, before, action } = {}) {
    return apiRequest('GET', `/api/admin/audit${query({ limit, before, action })}`)
  }
}

// ── Saved teams ──

export const savedTeamsApi = {
  fetchBundle() {
    return apiRequest('GET', '/api/saved-teams')
  },
  createCompetition(body) {
    return apiRequest('POST', '/api/saved-teams/competitions', body)
  },
  updateCompetition(id, body) {
    return apiRequest('PATCH', `/api/saved-teams/competitions/${enc(id)}`, body)
  },
  deleteCompetition(id) {
    return apiRequest('DELETE', `/api/saved-teams/competitions/${enc(id)}`)
  },
  createTeam(body) {
    return apiRequest('POST', '/api/saved-teams/teams', body)
  },
  updateTeam(id, body) {
    return apiRequest('PATCH', `/api/saved-teams/teams/${enc(id)}`, body)
  },
  deleteTeam(id) {
    return apiRequest('DELETE', `/api/saved-teams/teams/${enc(id)}`)
  },
  putRoster(id, { players, staff }) {
    return apiRequest('PUT', `/api/saved-teams/teams/${enc(id)}/roster`, { players, staff })
  }
}

/**
 * The i18n key for an error from these endpoints, by error.code. Server
 * messages stay English; the UI shows the mapped text.
 */
export function errorKeyOf(error) {
  if (!error) return null
  if (error.network || error.status === 0) return 'manage.errors.offline'
  switch (error.code) {
    case 'OV_INVITE_INVALID': return 'access.errors.inviteInvalid'
    case 'OV_INVITE_EXPIRED': return 'access.errors.inviteExpired'
    case 'OV_INVITE_USED_UP': return 'access.errors.inviteUsedUp'
    case 'OV_TOO_MANY_ATTEMPTS': return 'access.errors.tooManyAttempts'
    case 'OV_SELF_DEMOTE': return 'manage.accounts.selfDemote'
    case 'OV_DUPLICATE': return 'savedTeams.duplicateTeam'
    case 'OV_FORBIDDEN': return 'manage.errors.forbidden'
    default:
      if (error.status === 401 || error.status === 403) return 'manage.errors.forbidden'
      return 'manage.errors.generic'
  }
}
