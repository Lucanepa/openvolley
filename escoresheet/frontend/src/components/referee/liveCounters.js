/**
 * The referee's TO / SUB counters from the scorer's live state (pure;
 * Referee.jsx stats).
 *
 * timeouts_a / timeouts_b and subs_a / subs_b are the lists of the set the
 * snapshot was taken in (Scoreboard captureFullStateSnapshot), or a number
 * from an older scorer. A substitution entry is { playerIn, playerOut,
 * position, exceptional, ts }: an exceptional substitution (FIVB 15.7) is
 * beyond the 6 of a set (15.6), so SUB counts the regular ones only, as the
 * scorer's SUB box and the bench tablet do (domain/substitutions
 * countRegularSubstitutions). Counting every entry, the referee showed SUB 7
 * where the scorer and the bench showed 6 (full-match test 21.11.2026).
 */
import { regularSubstitutionCount } from '../../domain/livePublicFields'

const timeoutCount = (value) => {
  if (Array.isArray(value)) return value.length
  if (typeof value === 'number') return value
  return 0
}

// The list (PIN view), else an older scorer's number, else the public
// regular count (subs_count_a / subs_count_b), else none
const substitutionCount = (list, publicCount) => {
  if (Array.isArray(list)) return regularSubstitutionCount(list)
  if (typeof list === 'number') return list
  if (typeof publicCount === 'number' && Number.isFinite(publicCount)) return publicCount
  return 0
}

/**
 * @param {object|null|undefined} liveState  a match_live_state row / relay live state
 * @param {boolean} teamAIsHome  the live state's Team A is the home team
 * @returns {{ home: { timeouts: number, substitutions: number }, away: { timeouts: number, substitutions: number } }}
 */
export function liveStateCounters(liveState, teamAIsHome = true) {
  const a = {
    timeouts: timeoutCount(liveState?.timeouts_a),
    substitutions: substitutionCount(liveState?.subs_a, liveState?.subs_count_a)
  }
  const b = {
    timeouts: timeoutCount(liveState?.timeouts_b),
    substitutions: substitutionCount(liveState?.subs_b, liveState?.subs_count_b)
  }
  return teamAIsHome ? { home: a, away: b } : { home: b, away: a }
}
