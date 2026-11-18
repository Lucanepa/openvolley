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
 * (`currentSet`, a live state's current_set during the break). Sets 1 to 4
 * are played in order in every format, so before set 2, 3 or 4 it is the set
 * before by number. Before set 5 it is set 2 in a best-of-3 (its decider is
 * stored as set 5, utils/matchFormat getNextSetIndex) and set 4 in a
 * best-of-5; with the format unknown, the latest of the set played before it
 * in `sets` and the set a set_end push named (`namedSetIndex`, the live
 * state's last_event_data.setIndex), else set 4.
 *
 * `sets` may be old (a referee that loaded the match before the coin toss
 * holds set 1 only), so it never decides before sets 2-4.
 * @returns {number|null}
 */
export function endedSetBefore(currentSet, sets = [], namedSetIndex = null, bestOf = null) {
  const current = Number(currentSet)
  if (!Number.isFinite(current) || current <= 1) return null
  if (current < 5) return current - 1
  if (current === 5 && Number(bestOf) === 3) return 2
  if (current === 5 && Number(bestOf) === 5) return 4
  let prev = null
  for (const s of sets || []) {
    if (s && s.index < current && (prev === null || s.index > prev)) prev = s.index
  }
  const named = Number(namedSetIndex)
  if (namedSetIndex != null && Number.isFinite(named) && named >= 1 && named < current && (prev === null || named > prev)) prev = named
  return prev !== null ? prev : current - 1
}

/**
 * The length (s) of a running break countdown after the 10-minute switch
 * changed while it runs (Edit match info): it keeps its start, so its end is
 * the start + the new length. `length` is the countdown's length counted from
 * its anchor (on the scorer the time left when it started counting, on a
 * tablet the whole break), `before` / `after` the break's length with the
 * old and the new value of the switch. Never below 0 (0: the shorter break is
 * over by now, the countdown ends).
 */
export function retimedBreakLength(length, before, after) {
  const n = Number(length)
  const b = Number(before)
  const a = Number(after)
  if (!Number.isFinite(n) || !Number.isFinite(b) || !Number.isFinite(a)) return length
  return Math.max(0, n + (a - b))
}

/** True when an edit switched the 10-minute interval after set 2 on or off. */
export function longIntervalChanged(before, after) {
  return hasLongIntervalAfterSet2(before) !== hasLongIntervalAfterSet2(after)
}
