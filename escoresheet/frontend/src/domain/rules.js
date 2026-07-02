/**
 * Pure volleyball scoring/rotation rules — no React, no Dexie, no I/O.
 *
 * Consolidates logic duplicated across Scoreboard.jsx (first-serve alternation
 * ~7×, set-win + match-end detection ~2×). Pure + deterministic, so unit-tested
 * and used as the safety net for Scoreboard refactors.
 *
 * SET-INDEX CONVENTION (important): this app slots the DECIDING set at index 5
 * for BOTH formats. A tied best-of-3 jumps set 2 -> set 5 (see
 * matchFormat.getNextSetIndex), so sets 3/4 never exist in best-of-3. The
 * deciding set is therefore `index === 5` regardless of bestOf, and is played to
 * 15; every other set is played to 25. This module is bestOf-aware for match-end
 * (which genuinely depends on the format) and documents the index-5 convention.
 */
import { setsToWin } from '../utils/matchFormat'

/** The deciding "short" set is always index 5 in this app (bo3 and bo5). */
export function isDecidingSet(setIndex) {
  return setIndex === 5
}

/**
 * Which team serves first in a given set.
 *  - Set 1: `firstServe`
 *  - Odd sets (1,3): same as set 1; even sets (2,4): opposite
 *  - Deciding set (index 5, both formats): separate coin toss `set5FirstServe`
 *    ('A'|'B' -> coin-toss team keys); falls back to set 1's server if absent.
 *
 * @param {number} setIndex 1-based
 * @param {object} match
 * @returns {string} serving team key ('home'/'away' or the coin-toss keys)
 */
export function getFirstServeForSet(setIndex, match = {}) {
  const firstServe = match.firstServe || 'home'
  if (setIndex === 5 && match.set5FirstServe) {
    const teamAKey = match.coinTossTeamA || 'home'
    const teamBKey = match.coinTossTeamB || 'away'
    return match.set5FirstServe === 'A' ? teamAKey : teamBKey
  }
  if (setIndex === 5) return firstServe
  return setIndex % 2 === 1 ? firstServe : (firstServe === 'home' ? 'away' : 'home')
}

/**
 * Set result + (optionally) whether winning this set ends the match.
 *
 * @param {number} homePoints
 * @param {number} awayPoints
 * @param {number} setIndex 1-based (5 = deciding set, to 15)
 * @param {object} [opts]
 * @param {number} [opts.bestOf=5] 3 or 5
 * @param {number} [opts.homeSetsWon=0] sets home has won BEFORE this set
 * @param {number} [opts.awaySetsWon=0] sets away has won BEFORE this set
 * @returns {{winner:'home'|'away'|null, isSetWon:boolean, pointsToWin:number, isMatchEnd:boolean}}
 */
export function getSetResult(homePoints, awayPoints, setIndex, opts = {}) {
  const { bestOf = 5, homeSetsWon = 0, awaySetsWon = 0 } = opts
  const h = homePoints || 0
  const a = awayPoints || 0
  const pointsToWin = isDecidingSet(setIndex) ? 15 : 25
  const homeWon = h >= pointsToWin && h - a >= 2
  const awayWon = a >= pointsToWin && a - h >= 2
  const winner = homeWon ? 'home' : awayWon ? 'away' : null

  const needed = setsToWin(bestOf)
  const isMatchEnd = winner === 'home'
    ? (homeSetsWon + 1) >= needed
    : winner === 'away'
      ? (awaySetsWon + 1) >= needed
      : false

  return { winner, isSetWon: !!winner, pointsToWin, isMatchEnd }
}
