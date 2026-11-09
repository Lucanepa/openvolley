/**
 * The first starting line-up of a set stays hidden until the other team's is
 * recorded too (FIVB 7.3.2: the line-up is not shown to the other team before
 * the set): the scorer's court, the referee tablet and the bench tablet show
 * "Line-up set" over a team's court while only that team's line-up is in and
 * the set has not started. Pure. A UI rule: the relayed data still carries
 * the recorded line-up.
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
