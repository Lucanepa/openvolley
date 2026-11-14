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

/**
 * Points a set is played to: 25 (regular) and 15 (deciding), FIVB. A Global
 * match may set shorter ones (match.setTargets = { regular, deciding }, e.g.
 * 21/15 or 15/10 for a school tournament); anything missing or out of range
 * falls back to the default, so a Swiss match is never affected.
 */
export const DEFAULT_SET_TARGETS = Object.freeze({ regular: 25, deciding: 15 })
export function setTargetsOf(match) {
  const t = match?.setTargets || {}
  const ok = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi
  return {
    regular: ok(t.regular, 5, 50) ? t.regular : DEFAULT_SET_TARGETS.regular,
    deciding: ok(t.deciding, 5, 50) ? t.deciding : DEFAULT_SET_TARGETS.deciding
  }
}
/** The target of one set. */
export const pointsToWinFor = (setIndex, targets = DEFAULT_SET_TARGETS) => (setIndex === 5 ? targets.deciding : targets.regular)
/** Where the teams change courts in the deciding set: 8 of 15, half the target rounded up. */
export const courtSwitchPointOf = (targets = DEFAULT_SET_TARGETS) => Math.ceil(targets.deciding / 2)

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

const sideOfLabel = (label) => (label === 'A' ? 'left' : 'right')
const isLabel = (v) => v === 'A' || v === 'B'

/**
 * Which side Team A (coin-toss winner) is on in a set: the one rule of the
 * scorer's court (Scoreboard leftIsHome), also used by the state snapshot
 * (the live state's side_a), the set end's live state, the referee without a
 * live state, the bench tablet and the corrections card.
 * setLeftTeamOverrides[setIndex] and set5LeftTeam store the LEFT team as 'A'/'B'.
 *  - Sets 1-4: the set's override, else odd sets A left, even sets A right
 *    (A is on the left in set 1; the teams change sides after every set).
 *  - Deciding set (index 5, both formats): its coin toss (set5LeftTeam, which
 *    every set 5 setup writes), else an older match's override [5], else the
 *    side the set before ended on (4; best-of-3: 2), the default the set end
 *    proposes; the change of courts at 8 (set5CourtSwitched) flips it.
 *
 * @param {number} setIndex 1-based
 * @param {object} match
 * @returns {'left'|'right'}
 */
export function getSideAForSet(setIndex, match = {}) {
  const override = (match.setLeftTeamOverrides || {})[setIndex]
  if (setIndex !== 5) {
    if (isLabel(override)) return sideOfLabel(override)
    return setIndex % 2 === 1 ? 'left' : 'right'
  }
  let sideA
  if (isLabel(match.set5LeftTeam)) sideA = sideOfLabel(match.set5LeftTeam)
  else if (isLabel(override)) sideA = sideOfLabel(override)
  else sideA = getSideAForSet(Number(match.bestOf) === 3 ? 2 : 4, match)
  if (match.set5CourtSwitched) sideA = sideA === 'left' ? 'right' : 'left'
  return sideA
}

/** The LEFT team of a set as the label the match's side fields store ('A' | 'B'). */
export function getLeftTeamLabelForSet(setIndex, match = {}) {
  return getSideAForSet(setIndex, match) === 'left' ? 'A' : 'B'
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
 * @param {{regular:number,deciding:number}} [opts.targets] points to win (setTargetsOf(match))
 * @returns {{winner:'home'|'away'|null, isSetWon:boolean, pointsToWin:number, isMatchEnd:boolean}}
 */
export function getSetResult(homePoints, awayPoints, setIndex, opts = {}) {
  const { bestOf = 5, homeSetsWon = 0, awaySetsWon = 0, targets = DEFAULT_SET_TARGETS } = opts
  const h = homePoints || 0
  const a = awayPoints || 0
  const pointsToWin = pointsToWinFor(setIndex, targets)
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

/**
 * A set's score as recorded by its point events (every rally point, delay
 * penalty point and forfeit-awarded point is logged as a 'point' event). Used to
 * keep sets.homePoints/awayPoints in step after a point event is edited or
 * deleted by hand.
 * @param {Array} events
 * @param {number} setIndex
 * @returns {{homePoints:number, awayPoints:number}}
 */
/**
 * Which team serves now in a set: the team that won the last rally, unless
 * the game went back since (domain/rectify): then the team the rectification
 * gave the serve to. A point set by hand when the game went back
 * (payload.scoreAdjusted) won no rally and passes no serve. One rule for the
 * scorer's screen, the Point path (who rotates), the referee and the rebuild.
 * @returns {string} 'home' | 'away' (the set's first server before any rally)
 */
export function servingTeamFromLog(events, setIndex, match = {}) {
  const team = (t) => t === 'home' || t === 'away'
  const later = (a, b) => {
    const as = a.seq || 0
    const bs = b.seq || 0
    if (as !== bs) return as > bs
    return Date.parse(a.ts || 0) > Date.parse(b.ts || 0)
  }
  let last = null
  for (const e of events || []) {
    if ((e?.setIndex ?? 1) !== setIndex) continue
    const counts = (e.type === 'point' && e.payload?.scoreAdjusted !== true && team(e.payload?.team)) ||
      (e.type === 'rectification' && team(e.payload?.serve))
    if (counts && (!last || later(e, last))) last = e
  }
  if (!last) return getFirstServeForSet(setIndex, match || {})
  return last.type === 'rectification' ? last.payload.serve : last.payload.team
}

export function scoreFromPointEvents(events, setIndex) {
  let homePoints = 0
  let awayPoints = 0
  for (const e of events || []) {
    if (e.type !== 'point' || (e.setIndex ?? 1) !== setIndex) continue
    if (e.payload?.team === 'home') homePoints++
    else if (e.payload?.team === 'away') awayPoints++
  }
  return { homePoints, awayPoints }
}
