/**
 * Sign-up requests (db/025, backend lib/accountRequests.js): what a new
 * OpenVolley account says it does, so that an approver only approves.
 *
 *   scorer        one or more clubs (it scores their home games)
 *   referee       no club
 *   team_manager  a club, then one or more of its teams
 *   club_manager  a club
 *
 * Competition manager cannot be asked for (an admin gives it). Nothing is
 * granted at sign-up: an admin approves any part, a club's managers the parts
 * of their club, a team's managers the team manager parts of their team.
 */

export const REQUEST_KINDS = Object.freeze(['scorer', 'referee', 'team_manager', 'club_manager'])

/** The form's empty choice: nothing ticked (the account stays pending, as before). */
export function emptyRequestChoice() {
  return {
    scorer: { on: false, clubIds: [] },
    referee: { on: false },
    team_manager: { on: false, clubId: '', teamIds: [] },
    club_manager: { on: false, clubId: '' }
  }
}

/**
 * The form's choice as the sign-up body's `requests`:
 * [{ kind, club_id?, team_id? }], one per part. Unticked kinds give nothing.
 */
export function signUpRequestsOf(choice) {
  const c = choice || emptyRequestChoice()
  const out = []
  if (c.scorer?.on) for (const id of new Set(c.scorer.clubIds || [])) out.push({ kind: 'scorer', club_id: id })
  if (c.referee?.on) out.push({ kind: 'referee' })
  if (c.team_manager?.on) {
    for (const id of new Set(c.team_manager.teamIds || [])) out.push({ kind: 'team_manager', club_id: c.team_manager.clubId || undefined, team_id: id })
  }
  if (c.club_manager?.on && c.club_manager.clubId) out.push({ kind: 'club_manager', club_id: c.club_manager.clubId })
  return out
}

/**
 * What is missing in a ticked kind: { kind, key } (an i18n key under
 * access.requests) or null when the choice can be sent.
 */
export function requestChoiceProblem(choice) {
  const c = choice || emptyRequestChoice()
  if (c.scorer?.on && !(c.scorer.clubIds || []).length) return { kind: 'scorer', key: 'access.requests.needScorerClub' }
  if (c.team_manager?.on && !c.team_manager.clubId) return { kind: 'team_manager', key: 'access.requests.needTeamClub' }
  if (c.team_manager?.on && !(c.team_manager.teamIds || []).length) return { kind: 'team_manager', key: 'access.requests.needTeam' }
  if (c.club_manager?.on && !c.club_manager.clubId) return { kind: 'club_manager', key: 'access.requests.needManagedClub' }
  return null
}

/**
 * One part as a line: "Scorer · VBC Musterdorf", "Team manager / coach ·
 * VBC Musterdorf H1", "Referee". `t` is i18next's.
 */
export function requestPartLabel(part, t) {
  const kind = t ? t(`access.requests.kinds.${part?.kind}`) : String(part?.kind || '')
  const where = part?.kind === 'team_manager' ? (part.team_name || part.club_name) : part?.club_name
  return where ? `${kind} · ${where}` : kind
}

/** The parts in the order an approver reads them (scorer, referee, team manager, club manager). */
export function sortRequestParts(parts) {
  return [...(parts || [])].sort((a, b) => REQUEST_KINDS.indexOf(a.kind) - REQUEST_KINDS.indexOf(b.kind) ||
    String(a.club_name || '').localeCompare(String(b.club_name || '')) || String(a.team_name || '').localeCompare(String(b.team_name || '')))
}
