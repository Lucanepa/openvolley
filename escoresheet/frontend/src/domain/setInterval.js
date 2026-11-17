/**
 * The interval (break) between sets, per match (owner 2026-11-17).
 *
 * The interval between sets is 3 minutes. The competent body may extend the
 * one between set 2 and set 3 to 10 minutes (FIVB rules, intervals), so a match can
 * say so: the "10-minute interval after set 2" switch in Match setup and Edit
 * match info (match.longIntervalAfterSet2, off by default; on the server
 * match_info.long_interval_after_set2, domain/sheetInputs.js).
 *
 * When it is on, the break after set 2 is 10 minutes: the next set's proposed
 * start is set 2's end + 10 minutes, and its countdown runs 10 minutes. The
 * other breaks keep 3 minutes (and the countdown the device's Options setting).
 *
 * Keyed on the set that ENDED being set 2, not on the next set being set 3:
 * in a best-of-3 at 1-1 the set after set 2 is set 5 (the decider).
 */

/** Minutes between a set's end and the next set's start. */
export const INTERVAL_MINUTES = 3

/** Minutes of the extended interval after set 2. */
export const LONG_INTERVAL_MINUTES = 10

/** True when the match has the 10-minute interval after set 2. */
export function hasLongIntervalAfterSet2(match) {
  return match?.longIntervalAfterSet2 === true
}

/** True when the break after the set `endedSetIndex` is the 10-minute one. */
export function isLongInterval(match, endedSetIndex) {
  return hasLongIntervalAfterSet2(match) && Number(endedSetIndex) === 2
}

/**
 * Minutes of the break after the set `endedSetIndex` (for the next set's
 * proposed start): 10 after set 2 when the match says so, else 3.
 */
export function intervalMinutesAfter(match, endedSetIndex) {
  return isLongInterval(match, endedSetIndex) ? LONG_INTERVAL_MINUTES : INTERVAL_MINUTES
}

/**
 * Seconds the break countdown after the set `endedSetIndex` runs: 600 after
 * set 2 when the match says so, else `deviceSeconds` (the device's Options
 * setting, 180 by default).
 */
export function breakSecondsAfter(match, endedSetIndex, deviceSeconds = INTERVAL_MINUTES * 60) {
  if (isLongInterval(match, endedSetIndex)) return LONG_INTERVAL_MINUTES * 60
  const n = Number(deviceSeconds)
  return Number.isFinite(n) && n > 0 ? n : INTERVAL_MINUTES * 60
}

/**
 * The set whose end a break follows, on a tablet that knows the next set
 * (`currentSet`, a live state's current_set during the break): the set played
 * before it in `sets` (a best-of-3 decider: set 2 before set 5), else the
 * set a set_end push named (`namedSetIndex`, the live state's
 * last_event_data.setIndex), else the set before it by number.
 * @returns {number|null}
 */
export function endedSetBefore(currentSet, sets = [], namedSetIndex = null) {
  const current = Number(currentSet)
  if (!Number.isFinite(current) || current <= 1) return null
  let prev = null
  for (const s of sets || []) {
    if (s && s.index < current && (prev === null || s.index > prev)) prev = s.index
  }
  if (prev !== null) return prev
  const named = Number(namedSetIndex)
  if (Number.isFinite(named) && named >= 1 && named < current) return named
  return current - 1
}

/** True when an edit switched the 10-minute interval after set 2 on or off. */
export function longIntervalChanged(before, after) {
  return hasLongIntervalAfterSet2(before) !== hasLongIntervalAfterSet2(after)
}
