/**
 * The referee's TO / SUB counters from the scorer's live state (pure;
 * Referee.jsx stats).
 *
 * timeouts_a / timeouts_b and subs_a / subs_b are the lists of the set the
 * snapshot was taken in (Scoreboard captureFullStateSnapshot), or a number
 * from an older scorer. A substitution entry is { playerIn, playerOut,
 * position, exceptional, ts }. SUB shows every substitution of the set,
 * exceptional ones included (owner 22.11.2026: "SUB shall count exceptional
 * substitutions"), as the scorer's SUB box and the bench tablet do
 * (domain/substitutions countAllSubstitutions). Its colour follows the
 * regular ones, the 6 of the rule (FIVB 15.6; an exceptional substitution,
 * 15.7 / 15.8, is made beyond them): `regularSubstitutions`.
 */
import { regularSubstitutionCount } from '../../domain/livePublicFields'

const listCount = (value) => {
  if (Array.isArray(value)) return value.length
  if (typeof value === 'number') return value
  return 0
}

// The list (PIN view), else an older scorer's number, else the public count
// (subs_count_a / subs_count_b, every substitution), else none. The regular
// ones only from the list; a number stands for both.
const substitutionCounts = (list, publicCount) => {
  if (Array.isArray(list)) return { all: list.length, regular: regularSubstitutionCount(list) }
  if (typeof list === 'number') return { all: list, regular: list }
  if (typeof publicCount === 'number' && Number.isFinite(publicCount)) return { all: publicCount, regular: publicCount }
  return { all: 0, regular: 0 }
}

const teamCounters = (timeouts, subs, publicCount) => {
  const s = substitutionCounts(subs, publicCount)
  return { timeouts: listCount(timeouts), substitutions: s.all, regularSubstitutions: s.regular }
}

/**
 * @param {object|null|undefined} liveState  a match_live_state row / relay live state
 * @param {boolean} teamAIsHome  the live state's Team A is the home team
 * @returns {{ home: { timeouts: number, substitutions: number, regularSubstitutions: number }, away: { timeouts: number, substitutions: number, regularSubstitutions: number } }}
 */
export function liveStateCounters(liveState, teamAIsHome = true) {
  const a = teamCounters(liveState?.timeouts_a, liveState?.subs_a, liveState?.subs_count_a)
  const b = teamCounters(liveState?.timeouts_b, liveState?.subs_b, liveState?.subs_count_b)
  return teamAIsHome ? { home: a, away: b } : { home: b, away: a }
}

/**
 * The same counters from the events (a relay bundle or the device's own
 * log), for the set being played.
 * @param {Array<object>} setEvents  the events of the current set
 * @returns {{ home: object, away: object }}
 */
export function eventCounters(setEvents) {
  const of = (team) => {
    const subs = (setEvents || []).filter(e => e?.type === 'substitution' && e.payload?.team === team)
    return {
      timeouts: (setEvents || []).filter(e => e?.type === 'timeout' && e.payload?.team === team).length,
      substitutions: subs.length,
      regularSubstitutions: subs.filter(e => !e.payload?.isExceptional).length
    }
  }
  return { home: of('home'), away: of('away') }
}

/** The SUB counter's warning state, from the regular substitutions. */
export function subCounterTone(stats) {
  const regular = stats?.regularSubstitutions ?? stats?.substitutions ?? 0
  return regular >= 6 ? 'max' : regular >= 5 ? 'near' : null
}
