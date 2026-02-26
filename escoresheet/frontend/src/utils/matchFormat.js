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
