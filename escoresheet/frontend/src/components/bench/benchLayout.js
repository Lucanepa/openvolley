/**
 * Pure helpers of the bench's live view (MatchEntry): the counters' state,
 * their pips and the short team name the score card shows.
 */

/** Time-outs and substitutions a team has per set (FIVB 15.1). */
export const TIMEOUT_LIMIT = 2
export const SUBSTITUTION_LIMIT = 6

/**
 * The state of a TO / SUB counter: 'max' when the limit is used up, 'near'
 * one before it (only where that warns of something: the fifth substitution),
 * else null.
 * @param {number} used
 * @param {number} limit
 * @param {{ warnNear?: boolean }} [opts]
 * @returns {'max'|'near'|null}
 */
export function counterTone(used, limit, { warnNear = false } = {}) {
  const n = Number(used) || 0
  if (n >= limit) return 'max'
  if (warnNear && n === limit - 1) return 'near'
  return null
}

/**
 * One pip per allowed request, filled for each used: [true, false] for one
 * time-out of two. More used than allowed (a correction) fills them all.
 * @param {number} used
 * @param {number} limit
 * @returns {boolean[]}
 */
export function counterPips(used, limit) {
  const n = Math.max(0, Number(used) || 0)
  return Array.from({ length: limit }, (_, i) => i < n)
}

/**
 * The short name of a team on the score card: the match's short name, the
 * team's, else its name (the card truncates a long one).
 * @param {'home'|'away'} key
 * @param {object|null} match
 * @param {object|null} team
 * @returns {string}
 */
export function benchShortName(key, match, team) {
  const short = key === 'home' ? match?.homeShortName : match?.awayShortName
  return String(short || team?.shortName || team?.short_name || team?.name || '').trim()
}
