/**
 * GET /api/match/list on a relay lists every match a scorer publishes there,
 * whatever its connections: display devices (the point-hub LedBox bridge)
 * pick their match from it and need no PIN. People do: the referee and bench
 * apps offer only the rows they can join, as they did when the relays listed
 * only matches with the referee connection on.
 */

const rowsOf = (rows) => (Array.isArray(rows) ? rows.filter((m) => m && typeof m === 'object') : [])

/**
 * Rows a referee can join: the scorer switched the referee connection on (a
 * rehearsal match included: the scorer switched it on to rehearse with one).
 * @param {Array<object>} rows
 */
export function refereeJoinableMatches(rows) {
  return rowsOf(rows).filter((m) => m.refereeConnectionEnabled === true)
}

/**
 * Rows a bench tablet can join: the scorer switched the home or the away
 * bench connection on.
 * @param {Array<object>} rows
 */
export function benchJoinableMatches(rows) {
  return rowsOf(rows).filter((m) => m.homeTeamConnectionEnabled === true || m.awayTeamConnectionEnabled === true)
}
