/**
 * Pure match-end rules — no React, no Dexie, no I/O.
 *
 * Consolidates the match-end decisions that were re-derived in App.finishSet,
 * Scoreboard (set end, forfeit, stop match), MatchEnd and the reopen paths, each
 * with slightly different rules (winner on a sets tie, which statuses mean "over",
 * which signature fields to clear).
 *
 * FORFEIT (FIVB 2025-2028 Rule 6.4): a team declared INCOMPLETE / in default loses
 * the match. The opponent is given the points needed to win the current set and
 * the sets needed to win the match; the forfeiting team keeps the points and sets
 * it already has. Sets are created lazily in this app, so the sets still needed
 * must be CREATED, following the same index sequence as a played match (best-of-3
 * at 1-1 jumps 2 -> 5, see matchFormat.getNextSetIndex).
 *
 * STATUS LIFECYCLE: live -> ended (scoreboard, match over) -> approved (MatchEnd
 * signatures) -> final (closed). Any of the last three means the match is over.
 */
import { setsToWin, getNextSetIndex } from '../utils/matchFormat'
import { isDecidingSet } from './rules'

/** Match statuses that mean "no more rallies will be played". */
export const MATCH_OVER_STATUSES = Object.freeze(['ended', 'approved', 'final'])

/** True for ended / approved / final. */
export function isMatchOverStatus(status) {
  return MATCH_OVER_STATUSES.includes(status)
}

/**
 * Post-match signature fields on the match row (MatchEnd signing order). These
 * certify the RESULT, so they must all be cleared when the result is reopened
 * for correction. Pre-match coach/captain signatures (homeCoachSignature, ...)
 * are not included: they certify the roster, which a result correction does
 * not change.
 */
export const POST_MATCH_SIGNATURE_FIELDS = Object.freeze([
  'homePostGameCaptainSignature',
  'awayPostGameCaptainSignature',
  'asstScorerSignature',
  'scorerSignature',
  'ref2Signature',
  'ref1Signature'
])

/** An update object that nulls every post-match signature. */
export function clearedPostMatchSignatures() {
  return Object.fromEntries(POST_MATCH_SIGNATURE_FIELDS.map(f => [f, null]))
}

const otherTeam = (teamKey) => (teamKey === 'home' ? 'away' : 'home')
const pointsKey = (teamKey) => (teamKey === 'home' ? 'homePoints' : 'awayPoints')

/** Sets won by each team, counting finished sets only. */
export function countSetsWon(sets) {
  let home = 0
  let away = 0
  for (const s of sets || []) {
    if (!s?.finished) continue
    const h = s.homePoints || 0
    const a = s.awayPoints || 0
    if (h > a) home++
    else if (a > h) away++
  }
  return { home, away }
}

/**
 * The match winner, or null when the match is undecided (e.g. stopped for
 * impossibility to resume with no team having reached the sets needed).
 * @param {Array} sets set rows ({index, homePoints, awayPoints, finished})
 * @param {number} [bestOf=5]
 * @param {{forfeitTeam?: 'home'|'away'|null}} [opts] team that forfeited, if any
 * @returns {'home'|'away'|null}
 */
export function getMatchWinner(sets, bestOf = 5, { forfeitTeam = null } = {}) {
  if (forfeitTeam === 'home' || forfeitTeam === 'away') return otherTeam(forfeitTeam)
  const { home, away } = countSetsWon(sets)
  const needed = setsToWin(bestOf)
  if (home >= needed && home > away) return 'home'
  if (away >= needed && away > home) return 'away'
  return null
}

/**
 * The set played before `currentIndex`: the highest-index set below it. Works
 * for the best-of-3 decider (index 5 follows index 2) where `index - 1` does not.
 * @returns {object|null}
 */
export function findPreviousSet(sets, currentIndex) {
  let prev = null
  for (const s of sets || []) {
    if (s.index < currentIndex && (!prev || s.index > prev.index)) prev = s
  }
  return prev
}

/**
 * Points the opponent of a forfeiting team must reach to win a set: the set
 * target (25, or 15 in the deciding set) with a 2-point lead over the
 * forfeiting team, never fewer than it already has.
 */
export function forfeitSetPoints(forfeitingTeamPoints, opponentPoints, setIndex) {
  const target = isDecidingSet(setIndex) ? 15 : 25
  return Math.max(target, (forfeitingTeamPoints || 0) + 2, opponentPoints || 0)
}

/**
 * Plan the set rows a forfeit writes.
 * @param {object} args
 * @param {Array} args.sets all set rows of the match
 * @param {'home'|'away'} args.forfeitingTeam
 * @param {number} args.currentSetIndex index of the set in progress
 * @param {number} [args.bestOf=5]
 * @returns {{winner:'home'|'away', sets:Array<{index:number, id:any, homePoints:number,
 *   awayPoints:number, awardedPoints:number, isCurrent:boolean}>}}
 *   `id` is the existing row id or null for a set that must be created;
 *   `awardedPoints` is how many points the opponent gains in that set.
 */
export function planForfeit({ sets, forfeitingTeam, currentSetIndex, bestOf = 5 }) {
  const opponent = otherTeam(forfeitingTeam)
  const needed = setsToWin(bestOf)
  const byIndex = new Map((sets || []).map(s => [s.index, s]))
  const won = countSetsWon(sets)
  const planned = []

  const award = (index, existing, isCurrent) => {
    const teamPts = existing ? (existing[pointsKey(forfeitingTeam)] || 0) : 0
    const oppBefore = existing ? (existing[pointsKey(opponent)] || 0) : 0
    const oppPts = forfeitSetPoints(teamPts, oppBefore, index)
    planned.push({
      index,
      id: existing?.id ?? null,
      [pointsKey(forfeitingTeam)]: teamPts,
      [pointsKey(opponent)]: oppPts,
      awardedPoints: oppPts - oppBefore,
      isCurrent
    })
    won[opponent]++
  }

  let lastIndex = currentSetIndex
  const current = byIndex.get(currentSetIndex)
  if (current && !current.finished && won[opponent] < needed) {
    award(currentSetIndex, current, true)
  } else if (!current || current.finished) {
    // No set in progress: continue after the last finished set.
    const finished = (sets || []).filter(s => s.finished)
    lastIndex = finished.length ? Math.max(...finished.map(s => s.index)) : 0
  }

  while (won[opponent] < needed) {
    const next = lastIndex === 0 ? 1 : getNextSetIndex(lastIndex, won.home, won.away, bestOf)
    if (next > 5) break // defensive: never plan beyond the deciding set
    const existing = byIndex.get(next)
    if (existing?.finished) { lastIndex = next; continue }
    award(next, existing, false)
    lastIndex = next
  }

  return { winner: opponent, sets: planned }
}
