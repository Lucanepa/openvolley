/**
 * Returns the number of sets a team needs to win to win the match.
 * @param {number} bestOf - 3 or 5 (defaults to 5)
 * @returns {number} - 2 for best-of-3, 3 for best-of-5
 */
export function setsToWin(bestOf = 5) {
  return bestOf === 3 ? 2 : 3
}

/**
 * Checks if the match is finished (either team has won enough sets).
 * @param {number} homeSetsWon
 * @param {number} awaySetsWon
 * @param {number} bestOf - 3 or 5 (defaults to 5)
 * @returns {boolean}
 */
export function isMatchFinished(homeSetsWon, awaySetsWon, bestOf = 5) {
  const needed = setsToWin(bestOf)
  return homeSetsWon >= needed || awaySetsWon >= needed
}

/**
 * Returns the index for the next set.
 * For best-of-3: if tied 1-1 after set 2, jumps to set 5 (tiebreak).
 * Otherwise, normal sequential indexing.
 * @param {number} currentSetIndex - The index of the set that just ended
 * @param {number} homeSetsWon - After the current set is counted
 * @param {number} awaySetsWon - After the current set is counted
 * @param {number} bestOf - 3 or 5 (defaults to 5)
 * @returns {number} - The index for the next set
 */
export function getNextSetIndex(currentSetIndex, homeSetsWon, awaySetsWon, bestOf = 5) {
  if (bestOf === 3 && currentSetIndex === 2 && homeSetsWon === 1 && awaySetsWon === 1) {
    return 5
  }
  return currentSetIndex + 1
}

/**
 * The set number people see for an internal set index. A best-of-3 decider
 * is stored in the tie-break slot, index 5 (getNextSetIndex), but it is the
 * match's third set and is shown as set 3. Every other index is its number.
 * Display only: never use the result as a set index.
 * @param {number} setIndex - internal index (1-5)
 * @param {number|string} bestOf - 3 or 5 (defaults to 5)
 * @returns {number}
 */
export function displaySetNumber(setIndex, bestOf = 5) {
  return Number(bestOf) === 3 && Number(setIndex) === 5 ? 3 : setIndex
}

/**
 * True when a live-state push between sets / after the match must still add
 * the finished set to the snapshot's counts (setsWonWithFinishedSet).
 * A set_end push always does: it runs before the set is marked finished, on
 * the last point's snapshot. Any other push (match_end, end_interval, undo,
 * manual_*, court_switch...) does only when its snapshot predates the finish,
 * i.e. counts fewer sets than are finished: a snapshot captured afterwards
 * already counts them (they come from the finished sets), and adding its
 * current set's winner again turned a 1:2 into 1:3.
 * @param {{setScoreA?: number, setScoreB?: number}|null} snapshot
 * @param {number} finishedSetCount - sets marked finished in the database now
 * @param {string} [eventType]
 * @returns {boolean}
 */
export function finishedSetMissingFromSnapshot(snapshot, finishedSetCount, eventType) {
  if (eventType === 'set_end') return true
  const counted = (Number(snapshot?.setScoreA) || 0) + (Number(snapshot?.setScoreB) || 0)
  return counted < (Number(finishedSetCount) || 0)
}

/**
 * Sets won by Team A and Team B once the set described by `snapshot` counts.
 * The live-state push at a set end (and at the match end) carries the set
 * counts from before that set; its winner is added here: `winner`
 * ('home'/'away', from the set_end event) or, without it, the team with more
 * points in the snapshot. Team B is the team that is not Team A (snapshots
 * only carry teamAKey).
 * @param {{teamAKey?: string, setScoreA?: number, setScoreB?: number, pointsA?: number, pointsB?: number}} snapshot
 * @param {string|null|undefined} winner - 'home' | 'away'
 * @param {boolean} countSet - true when the snapshot does not count that set
 *   yet (finishedSetMissingFromSnapshot)
 * @returns {{a: number, b: number}}
 */
export function setsWonWithFinishedSet(snapshot, winner, countSet) {
  const a = Number(snapshot?.setScoreA) || 0
  const b = Number(snapshot?.setScoreB) || 0
  if (!countSet) return { a, b }
  const teamAKey = snapshot?.teamAKey === 'away' ? 'away' : 'home'
  const teamBKey = teamAKey === 'home' ? 'away' : 'home'
  const pointsA = Number(snapshot?.pointsA) || 0
  const pointsB = Number(snapshot?.pointsB) || 0
  const setWinner = winner || (pointsA > pointsB ? teamAKey : pointsB > pointsA ? teamBKey : null)
  if (setWinner === teamAKey) return { a: a + 1, b }
  if (setWinner === teamBKey) return { a, b: b + 1 }
  return { a, b }
}
