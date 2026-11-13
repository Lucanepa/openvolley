/**
 * Account, admin and saved-team endpoints (spec section 5). One function per
 * endpoint; every one resolves to { data, error, status } and never throws.
 * The server enforces every rule: these calls only carry the request.
 */

import { apiRequest, apiDownload } from './apiClient'
import { getCloudApiUrl } from '../utils/backendConfig'

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

/**
 * POST /api/account/invite-preview → what redeeming the code would do for the
 * signed-in account, nothing kept: { role_granted, already_had, team?, club?,
 * preview: true } and the redeem's own refusals (the manager asks "Manage
 * <team> with <account>?" before it redeems a team or club manager link). An
 * older server answers 404 without an OV_INVITE_* code.
 */
export function previewInvite(code) {
  return apiRequest('POST', '/api/account/invite-preview', { code: String(code || '').trim() }, { fallbackError: 'Invite code not accepted' })
}

/**
 * GET /api/me -> { roles, ...indoor flags, apps: { indoor: {member, ...}, beach: {member, ...} } }
 * (the OpenBeach manager reads apps.beach.member).
 */
export function fetchMe() {
  return apiRequest('GET', '/api/me')
}

/**
 * GET /api/public/clubs (db/025): every club's id and name with its teams'
 * ids and names, for the sign-up form's "What do you do?". No account needed,
 * no personal data. -> { clubs: [{ id, name, teams: [{ id, name }] }] }
 */
export function fetchPublicClubs({ timeoutMs } = {}) {
  return apiRequest('GET', '/api/public/clubs', undefined, timeoutMs ? { timeoutMs } : undefined)
}

/** POST /api/account/join { app } -> { app, member: true, already_member }: "Join OpenBeach with your existing password". */
export function joinApp(app) {
  return apiRequest('POST', '/api/account/join', { app })
}

/** POST /api/match/official-check → { taken: false } | { taken: true, claim } */
export function officialCheck({ game_n, scheduled_at = null, sport_type = 'indoor', external_id = null }, { timeoutMs } = {}) {
  return apiRequest('POST', '/api/match/official-check', { game_n, scheduled_at, sport_type, external_id }, timeoutMs ? { timeoutMs } : undefined)
}

/**
 * GET /api/games/today -> { day, clubs: [name], games: [svrz_games row + club, claim: { mine, closed } | null] }:
 * today's home games of the account's clubs (the home screen's Official game).
 */
export function fetchTodayGames({ timeoutMs } = {}) {
  return apiRequest('GET', '/api/games/today', undefined, timeoutMs ? { timeoutMs } : undefined)
}

// The courtesy check before creating a match: local-first creation never waits
// longer than this on a slow venue network (a timeout counts as "unknown").
export const OFFICIAL_CHECK_CONFIRM_TIMEOUT_MS = 3500

// ── Admin ──
// `app` ('indoor' | 'beach'): the lists of one app (the OpenBeach manager
// sends 'beach'); left out, the server answers as before (OpenVolley's console).

// ── Clubs (db/018): scorers score the home games of their own club ──
export const clubsApi = {
  /** Clubs with their VolleyManager teams and scorer count, and the rule { enabled }. */
  list() {
    return apiRequest('GET', '/api/admin/clubs')
  },
  create({ name, teams = [] } = {}) {
    return apiRequest('POST', '/api/admin/clubs', { name, teams })
  },
  /** { name?, teams? } (teams: the whole list) */
  update(id, body) {
    return apiRequest('PATCH', `/api/admin/clubs/${enc(id)}`, body)
  },
  remove(id) {
    return apiRequest('DELETE', `/api/admin/clubs/${enc(id)}`)
  },
  /** VolleyManager team names (home and away), each with its club. */
  vmTeams({ q } = {}) {
    return apiRequest('GET', `/api/admin/club-teams${query({ q })}`)
  },
  setRule(enabled) {
    return apiRequest('PUT', '/api/admin/club-rule', { enabled })
  },
  /** db/020: the club's managers (the whole list), each an account linked to the club. */
  setManagers(id, userIds = []) {
    return apiRequest('PUT', `/api/admin/clubs/${enc(id)}/managers`, { user_ids: userIds })
  },
  /** The accounts linked to the club: { candidates: [{ id, email, name, via: ['scorer' | 'team_manager' | 'club_manager'] }] } */
  managerCandidates(id) {
    return apiRequest('GET', `/api/admin/clubs/${enc(id)}/manager-candidates`)
  },
  /** db/029: a club manager link mailed to `email` -> { invite, link, code, mailed } */
  inviteManager(id, { email, lang } = {}) {
    return apiRequest('POST', `/api/admin/clubs/${enc(id)}/manager-invites`, { email, ...(lang ? { lang } : {}) })
  }
}

// ── Settings (db/021): the app's switches, admins and competition managers ──
/**
 * db/028: the account's own notices in one manager (the header's bell):
 * list(app) -> { notifications: [{ id, kind, created_at, read, target, user:
 * { id, email, name }, parts: [{ kind, club, team }], open }], unread };
 * markRead(app, { ids } | { all: true }) -> { unread }
 */
export const notificationsApi = {
  list(app) {
    return apiRequest('GET', `/api/notifications${query({ app })}`)
  },
  markRead(app, { ids, all } = {}) {
    return apiRequest('POST', `/api/notifications/read${query({ app })}`, all ? { all: true } : { ids: ids || [] })
  }
}

export const settingsApi = {
  /** { settings: { send_final_email, changed_at }, mail: the server can send email } */
  get() {
    return apiRequest('GET', '/api/settings')
  },
  setFinalEmail(on) {
    return apiRequest('PUT', '/api/settings', { send_final_email: !!on })
  }
}

/** A Blob's bytes as base64 (no data: prefix). */
async function blobBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/**
 * POST /api/scoresheet/test-mail: a test match's PDF to the signed-in
 * scorer's own address (never stored on the server) -> { sent, to }.
 */
export async function sendTestScoresheet(pdfBlob, { teams = '', result = '' } = {}) {
  return apiRequest('POST', '/api/scoresheet/test-mail', { pdf: await blobBase64(pdfBlob), teams, result }, { timeoutMs: 30000 })
}

// ── My club (db/020): what a club manager (or an admin) does for one club ──
export const clubApi = {
  /** The club with its teams, contact address, managers and scorer count. */
  get(clubId) {
    return apiRequest('GET', `/api/club/${enc(clubId)}`)
  },
  /** Where the club's final scoresheets go; null clears it. */
  setContact(clubId, contactEmail) {
    return apiRequest('PATCH', `/api/club/${enc(clubId)}`, { contact_email: contactEmail || null })
  },
  members(clubId) {
    return apiRequest('GET', `/api/club/${enc(clubId)}/members`)
  },
  /** Takes the account off the club only: it keeps its account and roles. */
  removeMember(clubId, userId) {
    return apiRequest('DELETE', `/api/club/${enc(clubId)}/members/${enc(userId)}`)
  },
  listInvites(clubId) {
    return apiRequest('GET', `/api/club/${enc(clubId)}/invites`)
  },
  /** { label, role: scorer|referee, max_uses <= 50, expires_at <= 90 days }; the club is the path's. */
  createInvite(clubId, { label, role = 'scorer', max_uses = 1, expires_at } = {}) {
    const body = { label, role, max_uses }
    if (expires_at) body.expires_at = expires_at
    return apiRequest('POST', `/api/club/${enc(clubId)}/invites`, body)
  },
  revokeInvite(clubId, inviteId) {
    return apiRequest('POST', `/api/club/${enc(clubId)}/invites/${enc(inviteId)}/revoke`, {})
  },
  /** db/023: the club's teams with ids, their team managers and open links. */
  teams(clubId) {
    return apiRequest('GET', `/api/club/${enc(clubId)}/teams`)
  },
  /** A team link: { max_uses <= 10, expires_at <= 90 days } -> { invite, code } (the code is shown once). */
  createTeamLink(clubId, teamId, { max_uses, expires_at } = {}) {
    const body = {}
    if (max_uses) body.max_uses = max_uses
    if (expires_at) body.expires_at = expires_at
    return apiRequest('POST', `/api/club/${enc(clubId)}/teams/${enc(teamId)}/invites`, body)
  },
  /** Takes the account off the team only. */
  removeTeamManager(clubId, teamId, userId) {
    return apiRequest('DELETE', `/api/club/${enc(clubId)}/teams/${enc(teamId)}/managers/${enc(userId)}`)
  },
  /**
   * db/025: the sign-up requests of the club (scorer, team manager of its
   * teams, club manager) -> { requests: [{ user: { id, email, name, created_at,
   * email_confirmed }, parts: [{ id, kind, club_id, club_name, team_id, team_name }] }] }
   */
  requests(clubId) {
    return apiRequest('GET', `/api/club/${enc(clubId)}/requests`)
  },
  /** { approve: [{ id, team_id? }], reject: [id] } -> { approved, rejected, requests } */
  decideRequests(clubId, userId, { approve = [], reject = [] } = {}) {
    return apiRequest('POST', `/api/club/${enc(clubId)}/requests/${enc(userId)}`, { approve, reject })
  },
  /**
   * db/024: the club's licence lists -> { season, lists: { players|scorers|coaches:
   * { count, imported_at, imported_by_name } }, people: [{ sv_number, last_name,
   * first_name, dob, gender, lists, teams: [{ id, name }] }] }
   */
  licences(clubId) {
    return apiRequest('GET', `/api/club/${enc(clubId)}/licences`)
  },
  /**
   * Replaces one list (players | scorers | coaches) with `people`: the five
   * fields of utils/vmLicenceExport.js only (the server refuses any other). -> { list, count, imported_at }
   */
  putLicences(clubId, list, people) {
    const only = (people || []).map(({ sv_number, last_name, first_name, dob, gender }) => ({ sv_number, last_name, first_name, dob, gender }))
    return apiRequest('PUT', `/api/club/${enc(clubId)}/licences/${enc(list)}`, { people: only }, { timeoutMs: 30000 })
  }
}

/**
 * db/023 (lib/teams.js): what a team manager does for its team. The game
 * number is a query parameter.
 */
export const teamApi = {
  get(teamId) {
    return apiRequest('GET', `/api/team/${enc(teamId)}`)
  },
  /** -> { team, season, squad: saved team | null } */
  squad(teamId) {
    return apiRequest('GET', `/api/team/${enc(teamId)}/squad`)
  },
  /** The saved team's whole roster { players, staff }; the first save creates the saved team. */
  putSquad(teamId, { players, staff }) {
    return apiRequest('PUT', `/api/team/${enc(teamId)}/squad`, { players, staff })
  },
  /** -> { team, games: [{ game_number, datetime, league, hall, city, team_home, team_away, side, locked, roster }] } */
  games(teamId) {
    return apiRequest('GET', `/api/team/${enc(teamId)}/games`)
  },
  roster(teamId, game) {
    return apiRequest('GET', `/api/team/${enc(teamId)}/roster?game=${enc(game)}`)
  },
  /** { players, staff, coach_signature?, captain_signature? } (signed ahead if they want to) */
  putRoster(teamId, game, { players, staff, coach_signature = null, captain_signature = null }) {
    return apiRequest('PUT', `/api/team/${enc(teamId)}/roster?game=${enc(game)}`, { players, staff, coach_signature, captain_signature })
  },
  deleteRoster(teamId, game) {
    return apiRequest('DELETE', `/api/team/${enc(teamId)}/roster?game=${enc(game)}`)
  },
  /**
   * db/024: the team's club for "Add from club" -> { team, gender: 'm' | 'f' |
   * null, players (the players list), people (everyone of the club's lists
   * once, with `lists`; missing from a server before it) }
   */
  clubPlayers(teamId) {
    return apiRequest('GET', `/api/team/${enc(teamId)}/club-players`)
  },
  /**
   * db/026: people typed by hand into the squad, kept in the club's lists
   * (until an upload of that list has them) -> { added, already }.
   * people: [{ list, sv_number, last_name, first_name, dob, gender }], at most 30
   */
  addClubPeople(teamId, people) {
    return apiRequest('POST', `/api/team/${enc(teamId)}/club-people`, { people })
  },
  /** db/025: the team manager requests of the team (the shape of clubApi.requests) */
  requests(teamId) {
    return apiRequest('GET', `/api/team/${enc(teamId)}/requests`)
  },
  /** { approve: [{ id }], reject: [id] } -> { approved, rejected, requests } */
  decideRequests(teamId, userId, { approve = [], reject = [] } = {}) {
    return apiRequest('POST', `/api/team/${enc(teamId)}/requests/${enc(userId)}`, { approve, reject })
  }
}

/**
 * GET /api/club-licences (db/024): the licence lists of the scorer's clubs,
 * kept on the tablet for Match Setup (db/clubPlayers.js).
 * -> { fetched_at, clubs: [{ club_id, club_name, team_names, team_genders, players, people }] }
 */
export function fetchClubLicences({ timeoutMs } = {}) {
  return apiRequest('GET', '/api/club-licences', undefined, timeoutMs ? { timeoutMs } : undefined)
}

/**
 * GET /api/game-rosters[?games=1,2]: the rosters teams sent for upcoming
 * games, which the scoring tablet keeps (db/gameRosters.js).
 * -> { fetched_at, games: [{ game_number, season }], rosters: [...] }
 */
/**
 * POST /api/game-rosters/used: this version was accepted in Match Setup, the
 * server deletes its content (owner 2026-11-08). -> { used } or { used: false, reason }
 */
export function markGameRosterUsed({ game_number, side, season, updated_at }) {
  return apiRequest('POST', '/api/game-rosters/used', { game_number, side, season, updated_at })
}

export function fetchGameRosters({ games, timeoutMs } = {}) {
  const path = games?.length ? `/api/game-rosters?games=${games.map(enc).join(',')}` : '/api/game-rosters'
  return apiRequest('GET', path, undefined, timeoutMs ? { timeoutMs } : undefined)
}

export const admin = {
  /** The activity log (db/016): filters match (game no. or external id), account (id), kind (prefix), level, from, to, app, before, limit. */
  listActivity({ match, account, kind, level, from, to, app, before, limit } = {}) {
    return apiRequest('GET', `/api/admin/activity${query({ match, account, kind, level, from, to, app, before, limit })}`)
  },
  /** CSV / NDJSON of the same filters (at most 50,000 rows). */
  exportActivity({ format = 'csv', ...filters } = {}) {
    const { match, account, kind, level, from, to, app } = filters
    return apiDownload(`/api/admin/activity/export${query({ match, account, kind, level, from, to, app, format })}`)
  },
  /** Delete on request: every entry of a match or an account (audited). */
  deleteActivity({ match, account } = {}) {
    return apiRequest('DELETE', `/api/admin/activity${query({ match, account, confirm: 'yes' })}`)
  },
  /** Undone / deleted / edited events of a match (db/015). */
  listRevisions(matchId) {
    return apiRequest('GET', `/api/admin/matches/${enc(matchId)}/revisions`)
  },
  listAccounts({ filter = 'pending', q, limit, app } = {}) {
    return apiRequest('GET', `/api/admin/accounts${query({ filter, q, limit, app })}`)
  },
  setRoles(userId, { add = [], remove = [] } = {}) {
    return apiRequest('POST', `/api/admin/accounts/${enc(userId)}/roles`, { add, remove })
  },
  /** An account's name and address ({ first_name?, last_name?, email? }; 409 OV_EMAIL_TAKEN). */
  updateAccount(userId, fields = {}) {
    return apiRequest('PATCH', `/api/admin/accounts/${enc(userId)}`, fields)
  },
  /**
   * Deletes the account and its personal data; the match records stay
   * (backend lib/accounts.js deleteAccount). `email`: the account's address,
   * typed by the admin as the confirmation. A server without it answers 404
   * OV_NOT_FOUND (its accounts list has no can_delete). The account's backup
   * files go first, so it may take longer than a list.
   */
  deleteAccount(userId, { email } = {}) {
    return apiRequest('POST', `/api/admin/accounts/${enc(userId)}/delete`, { email }, { timeoutMs: 60000 })
  },
  /**
   * Deactivate: the account can no longer sign in and its sessions end;
   * nothing is deleted. Reactivate undoes it. A server without them answers
   * 404 OV_NOT_FOUND (its accounts list has no can_deactivate).
   */
  deactivateAccount(userId) {
    return apiRequest('POST', `/api/admin/accounts/${enc(userId)}/deactivate`, {})
  },
  reactivateAccount(userId) {
    return apiRequest('POST', `/api/admin/accounts/${enc(userId)}/reactivate`, {})
  },
  /** The same for a sign-up without any role (audited as a rejection). */
  rejectAccount(userId, { email } = {}) {
    return apiRequest('POST', `/api/admin/accounts/${enc(userId)}/reject`, { email }, { timeoutMs: 60000 })
  },
  /**
   * db/025: approve / reject parts of the account's sign-up request; a part's
   * club or team may be changed first ({ id, club_id?, team_id? }).
   * -> { approved, rejected, requests }
   */
  decideRequests(userId, { approve = [], reject = [] } = {}) {
    return apiRequest('POST', `/api/admin/accounts/${enc(userId)}/requests`, { approve, reject })
  },
  /** db/018: the clubs an account scores for (the whole list). */
  setAccountClubs(userId, clubIds = []) {
    return apiRequest('PUT', `/api/admin/accounts/${enc(userId)}/clubs`, { club_ids: clubIds })
  },
  listInvites({ app } = {}) {
    return apiRequest('GET', `/api/admin/invites${query({ app })}`)
  },
  /** sport 'beach': a code that grants beach:<role> (left out: indoor, as before). */
  createInvite({ label, club = null, club_id = null, role = 'scorer', max_uses = 1, expires_at, sport } = {}) {
    const body = { label, club, role, max_uses }
    // db/018: the club whoever redeems the code joins (indoor)
    if (club_id) body.club_id = club_id
    if (expires_at !== undefined) body.expires_at = expires_at
    if (sport) body.sport = sport
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
  listAudit({ limit, before, action, app } = {}) {
    return apiRequest('GET', `/api/admin/audit${query({ limit, before, action, app })}`)
  },
  /** Approval lookup by short ID, game number or external_id (spec 3.3); `app` 'beach': OpenBeach's matches only. */
  listApprovals({ q, include_revoked, limit, app } = {}) {
    return apiRequest('GET', `/api/admin/approvals${query({ q, include_revoked: include_revoked ? 1 : undefined, limit, app })}`)
  }
}

// ── Approval with an account (docs/account-approval-spec.md section 3) ──
// The PIN and the password only ever travel in these request bodies: never
// log them, never store them.

export const approvalPinApi = {
  /** GET → { available, eligible, set, set_at, locked_until, disabled } */
  status() {
    return apiRequest('GET', '/api/account/approval-pin')
  },
  /** Set or change the personal approval PIN; the password confirms it. */
  set({ password, pin }) {
    return apiRequest('POST', '/api/account/approval-pin', { password, pin })
  },
  remove({ password }) {
    return apiRequest('POST', '/api/account/approval-pin/remove', { password })
  }
}

export const approvalsApi = {
  /** POST → { approval, already } */
  approve({ external_id, slot, email, pin, result, device_id, lang }) {
    const body = { external_id, slot, email, pin, result }
    if (device_id) body.device_id = device_id
    if (typeof lang === 'string' && lang) body.lang = lang
    return apiRequest('POST', '/api/approvals', body)
  },
  /** GET → { approvals: [record + requested_by_name + match] }: the signed-in official's own */
  mine({ limit } = {}) {
    return apiRequest('GET', `/api/account/approvals${query({ limit })}`)
  },
  /** GET → { match: { status, closed_at, result_key }, approvals: [record] } */
  list(external_id) {
    return apiRequest('GET', `/api/approvals?external_id=${enc(external_id)}`)
  },
  /** DELETE (undo) → { approval, already } */
  undo(id) {
    return apiRequest('DELETE', `/api/approvals/${enc(id)}`)
  }
}

// Approval error codes -> approval.errors.<key> (spec 3.4)
const APPROVAL_ERROR_KEYS = {
  OV_APPROVAL_PIN_INVALID: 'pinInvalid',
  OV_APPROVAL_PIN_FORMAT: 'pinFormat',
  OV_APPROVAL_PIN_WEAK: 'pinWeak',
  OV_PASSWORD_INVALID: 'passwordInvalid',
  OV_APPROVAL_ROLE_REQUIRED: 'roleRequired',
  OV_APPROVAL_NOT_MATCH_SCORER: 'notMatchScorer',
  OV_APPROVAL_SCORER_NOT_REFEREE: 'scorerNotReferee',
  OV_APPROVAL_CALLER_ROLE: 'callerRole',
  OV_APPROVAL_NAME_REQUIRED: 'nameRequired',
  OV_APPROVAL_ONE_SLOT: 'oneSlot',
  OV_APPROVAL_SLOT_TAKEN: 'slotTaken',
  OV_MATCH_CLOSED: 'matchClosed',
  OV_MATCH_NOT_ENDED: 'matchNotEnded',
  OV_RESULT_NOT_SYNCED: 'resultNotSynced',
  OV_APPROVAL_UNSUPPORTED: 'unsupported',
  OV_APPROVAL_UNAVAILABLE: 'unavailable'
}

/** The approval feature is switched off on this server (no OV_PIN_SECRET, or no database). */
export function isApprovalUnavailable(error) {
  return error?.code === 'OV_APPROVAL_UNAVAILABLE' || error?.code === 'OV_DB_NOT_CONFIGURED'
}

// ── Saved teams ──

// ── Scoresheets (the manager's Scoresheets tab) ──
// Admins and the sport's competition managers: a sport's matches with their
// stored PDF, and the PDF itself (every open is in the audit log).

export const scoresheetsApi = {
  /** GET /api/scoresheets: `app` 'indoor' | 'beach', `state` 'closed' | 'open' | 'all'. */
  list({ app = 'indoor', state = 'all', q, limit } = {}) {
    return apiRequest('GET', `/api/scoresheets${query({ app, state, q, limit })}`)
  },
  /** The stored PDF of a match: { blob, filename } or { error }. */
  pdf(matchId, { download = false } = {}) {
    return apiDownload(`/api/scoresheets/${enc(matchId)}/pdf${query({ download: download ? 1 : undefined })}`)
  },
  /**
   * POST /api/scoresheets/:id/view: a short-lived link to the stored PDF that the
   * browser's own viewer opens in a tab (it shows and saves the file under its
   * name; a blob: URL saved as "<uuid>.pdf"). { url, filename } or { error, status }.
   */
  async viewLink(matchId) {
    const r = await apiRequest('POST', `/api/scoresheets/${enc(matchId)}/view`, {})
    if (r.error || !r.data?.path) return { error: r.error || { message: 'No link' }, status: r.status }
    return { url: getCloudApiUrl(r.data.path), filename: r.data.filename || null }
  }
}

export const savedTeamsApi = {
  /** sport: 'indoor' | 'beach' | 'all'; none = the server's default (indoor only). */
  fetchBundle({ sport } = {}) {
    return apiRequest('GET', sport ? `/api/saved-teams?sport=${encodeURIComponent(sport)}` : '/api/saved-teams')
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
  },
  /**
   * The schedule's team names (svrz_games home and away), each with its club:
   * the team editor's VolleyManager name. -> { teams: [{ name, club_id, club_name }] }
   */
  vmTeams({ q } = {}) {
    return apiRequest('GET', `/api/saved-teams/vm-teams${query({ q })}`)
  }
}

/**
 * The i18n key for an error from these endpoints, by error.code. Server
 * messages stay English; the UI shows the mapped text. context 'approval'
 * reads OV_EMAIL_UNCONFIRMED as the official's address (approve dialog).
 */
export function errorKeyOf(error, { context } = {}) {
  if (!error) return null
  if (error.network || error.status === 0) return 'manage.errors.offline'
  if (APPROVAL_ERROR_KEYS[error.code]) return `approval.errors.${APPROVAL_ERROR_KEYS[error.code]}`
  // An approval names the official's account, not the signed-in one
  if (context === 'approval' && error.code === 'OV_EMAIL_UNCONFIRMED') return 'approval.errors.emailUnconfirmed'
  switch (error.code) {
    case 'OV_INVITE_INVALID': return 'access.errors.inviteInvalid'
    case 'OV_INVITE_EXPIRED': return 'access.errors.inviteExpired'
    case 'OV_INVITE_USED_UP': return 'access.errors.inviteUsedUp'
    // db/036: taken off the club or team the code was for; a club manager link of another address
    case 'OV_INVITE_REMOVED': return 'access.errors.inviteRemoved'
    case 'OV_INVITE_OTHER_ACCOUNT': return 'access.errors.inviteOtherAccount'
    case 'OV_TOO_MANY_ATTEMPTS': return 'access.errors.tooManyAttempts'
    case 'OV_SELF_DEMOTE': return 'manage.accounts.selfDemote'
    // deleting an account (admin.deleteAccount / rejectAccount)
    case 'OV_SELF_DELETE': return 'manage.accounts.selfDelete'
    case 'OV_LAST_SUPER_ADMIN': return 'manage.accounts.lastSuperAdmin'
    case 'OV_NOT_PENDING': return 'manage.accounts.notPending'
    case 'OV_CONFIRM_MISMATCH': return 'manage.accounts.confirmMismatch'
    // redeem-invite of an account whose address is not confirmed yet
    case 'OV_EMAIL_UNCONFIRMED': return 'access.errors.emailUnconfirmed'
    case 'OV_DUPLICATE': return 'savedTeams.duplicateTeam'
    case 'OV_FORBIDDEN': return 'manage.errors.forbidden'
    case 'OV_SCORESHEET_NOT_FOUND': return 'manage.scoresheets.noPdf'
    // db/023: a team's game roster
    case 'OV_GAME_NOT_YOURS': return 'manage.myTeams.notYourGame'
    // db/024: a player of the club's list with the other gender than the team's
    case 'OV_WRONG_GENDER': return 'manage.licences.wrongGender'
    // db/025: a sign-up request decided meanwhile (or not this approver's)
    case 'OV_REQUEST_GONE': return 'manage.requests.gone'
    default:
      if (error.status === 401 || error.status === 403) return 'manage.errors.forbidden'
      return 'manage.errors.generic'
  }
}
