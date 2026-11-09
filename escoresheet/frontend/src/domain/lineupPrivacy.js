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
