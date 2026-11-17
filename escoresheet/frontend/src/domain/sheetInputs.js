/**
 * The two inputs of a match's scoresheet that used to come from the drawing
 * device (owner 2026-11-16, "the same scoresheet everywhere"):
 *  - LFP tracking (lfpTracking): the scorer's setting at the coin toss. The
 *    sheet prints LFP marks, and the scoreboard / referee track LFP, by the
 *    match's value; only a match without one (older matches) falls back to the
 *    device's Options setting (localStorage.lfpTrackingEnabled).
 *  - Time zone (tz, IANA): the zone the match's clocks read, set when the
 *    match is created from the tool: Zürich in the Swiss tool, the device's
 *    own in the Global tool (ui/format currentTz). Every clock on the sheet,
 *    the Match complete card and the referee view reads it (ui/useMatchTz).
 * On the server both travel in match_info (lfp_tracking, tz).
 *
 * Also the 10-minute interval after set 2 (longIntervalAfterSet2, owner
 * 2026-11-17, domain/setInterval.js): a per-match switch, in match_info as
 * long_interval_after_set2. A false travels too (switched off after the coin
 * toss): the server replaces match_info whole and a missing key never
 * overwrites a device's value.
 */

/** An IANA time zone this engine knows (a string Intl accepts). */
export function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * LFP tracking for a match: its own value (set at the coin toss), else the
 * device's setting (older matches). Never in a Global match (a Swiss league rule).
 * @param {object|null|undefined} match local match
 * @param {boolean} deviceSetting the device's Options setting
 */
export function matchLfpTracking(match, deviceSetting) {
  if (match?.global === true) return false
  if (typeof match?.lfpTracking === 'boolean') return match.lfpTracking
  return deviceSetting === true
}

/** The device's LFP setting (Options), false when unreadable. */
export function deviceLfpSetting() {
  try {
    return localStorage.getItem('lfpTrackingEnabled') === 'true'
  } catch {
    return false
  }
}

/** The match_info keys for the two inputs (only those the match has). */
export function sheetInputsToMatchInfo(m) {
  const out = {}
  if (typeof m?.lfpTracking === 'boolean') out.lfp_tracking = m.lfpTracking
  if (validTz(m?.tz)) out.tz = m.tz
  if (typeof m?.longIntervalAfterSet2 === 'boolean') out.long_interval_after_set2 = m.longIntervalAfterSet2
  return out
}

/** The local fields from match_info (only the keys the server has). */
export function sheetInputsFromMatchInfo(info) {
  const out = {}
  if (typeof info?.lfp_tracking === 'boolean') out.lfpTracking = info.lfp_tracking
  if (validTz(info?.tz)) out.tz = info.tz
  if (typeof info?.long_interval_after_set2 === 'boolean') out.longIntervalAfterSet2 = info.long_interval_after_set2
  return out
}
