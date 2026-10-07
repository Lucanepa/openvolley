/**
 * GET /api/match/list on a relay lists every match a scorer publishes there,
 * whatever its connections: display devices (the point-hub LedBox bridge)
 * pick their match from it and need no PIN. People do: the referee and bench
 * apps offer only the rows they can join, as they did when the relays listed
 * only matches with the referee connection on.
 *
 * Neither offers an abandoned match (isStalePickerMatch: a relay that still
 * holds a match set up or started long ago and never finished).
 */

import { isStalePickerMatch } from './pickerMatches'

const rowsOf = (rows) => (Array.isArray(rows) ? rows.filter((m) => m && typeof m === 'object') : [])

/**
 * Rows a referee can join: the scorer switched the referee connection on (a
 * rehearsal match included: the scorer switched it on to rehearse with one),
 * and not stale.
 * @param {Array<object>} rows
 * @param {number} [now]
 */
export function refereeJoinableMatches(rows, now = Date.now()) {
  return rowsOf(rows).filter((m) => m.refereeConnectionEnabled === true && !isStalePickerMatch(m, now))
}

/**
 * Rows a bench tablet can join: the scorer switched the home or the away
 * bench connection on, and not stale.
 * @param {Array<object>} rows
 * @param {number} [now]
 */
export function benchJoinableMatches(rows, now = Date.now()) {
  return rowsOf(rows).filter((m) => (m.homeTeamConnectionEnabled === true || m.awayTeamConnectionEnabled === true) &&
    !isStalePickerMatch(m, now))
}
