/**
 * The first starting line-up of a set stays hidden until the other team's is
 * recorded too (FIVB 7.3.2: the line-up is not shown to the other team before
 * the set): the scorer's court, the referee tablet and the bench tablet show
 * "Line-up set" over a team's court while only that team's line-up is in and
 * the set has not started. Pure. Off the screens too: the scorer's live state
 * carries a covered line-up as null (coveredLineupTeamsOf), and the cloud
 * relay leaves the covered team's events of the set out of the other bench's
 * bundle (backend/lib/publicColumns.js relayBundleView).
 *
 * @param {{ setStarted: boolean, ownEntered: boolean, otherEntered: boolean }} args
 *   setStarted: a point was scored in the set (the scorer's isFirstRally is false)
 * @returns {boolean} true while this team's line-up is to be hidden
 */
export function lineupHiddenUntilBoth({ setStarted, ownEntered, otherEntered }) {
  return !setStarted && !!ownEntered && !otherEntered
}

/**
 * The teams whose line-up is covered now: [] or ['home'] / ['away'].
 * @param {{ setStarted: boolean, homeEntered: boolean, awayEntered: boolean }} args
 */
export function coveredLineupTeams({ setStarted, homeEntered, awayEntered }) {
  const out = []
  if (lineupHiddenUntilBoth({ setStarted, ownEntered: homeEntered, otherEntered: awayEntered })) out.push('home')
  if (lineupHiddenUntilBoth({ setStarted, ownEntered: awayEntered, otherEntered: homeEntered })) out.push('away')
  return out
}

/**
 * The events without those of a covered team in the set (its line-up, its
 * game captain): what a recent-actions list or "Last action" line may show.
 */
export function withoutCoveredTeamEvents(events, coveredTeams, setIndex) {
  if (!coveredTeams?.length || !Array.isArray(events)) return events
  return events.filter((e) => !(coveredTeams.includes(e?.payload?.team) && (e.setIndex ?? 1) === setIndex))
}

/**
 * The teams whose line-up of set `setIndex` is covered, from the recorded
 * events (the scorer's rule: a team's line-up is in with its initial
 * 'lineup' event, the set has started with its first point): [] or
 * ['home'] / ['away'].
 * @param {Array<object>} events
 * @param {number} setIndex
 */
export function coveredLineupTeamsOf(events, setIndex) {
  const inSet = (Array.isArray(events) ? events : []).filter((e) => e && (e.setIndex ?? 1) === setIndex)
  const entered = (team) => inSet.some((e) => e.type === 'lineup' && e.payload?.team === team && e.payload?.isInitial)
  return coveredLineupTeams({ setStarted: inSet.some((e) => e.type === 'point'), homeEntered: entered('home'), awayEntered: entered('away') })
}

/**
 * A live-state row (match_live_state shape: Team A / B) as it may leave the
 * scorer while `coveredTeams` (coveredLineupTeamsOf) have a covered line-up:
 * that team's line-up null (with it the number of its server), and no
 * numbers of its last action (a game captain, a libero) in last_event_data.
 * The row goes to the relay room, the livescore and the database, which
 * every viewer reads without a PIN. `teamAKey`: the team that is Team A.
 * @param {object} row
 * @param {string[]} coveredTeams
 * @param {'home'|'away'} teamAKey
 */
export function withCoveredLiveLineups(row, coveredTeams, teamAKey) {
  if (!row || !coveredTeams?.length) return row
  const teamA = teamAKey === 'away' ? 'away' : 'home'
  const teamB = teamA === 'home' ? 'away' : 'home'
  const out = { ...row }
  if (coveredTeams.includes(teamA)) out.lineup_a = null
  if (coveredTeams.includes(teamB)) out.lineup_b = null
  const data = out.last_event_data
  if (data != null && coveredTeams.includes(out.last_event_team)) {
    out.last_event_data = null
  } else if (data?.lastAction && coveredTeams.includes(data.lastAction.team)) {
    out.last_event_data = { ...data, lastAction: { ...data.lastAction, data: {} } }
  }
  return out
}
