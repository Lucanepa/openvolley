import { roundToMinute } from './timeUtils'
import { zonedParts, zurichWallTimeMs } from '../ui/format'
import { actualStartLine, remarkClock } from '../domain/remarks'

const HOUR = 3600 * 1000

/**
 * The match's scheduled time of day (Zürich HH:MM) on the day it is played:
 * `now`'s Zürich date, never the scheduled DATE (a match scheduled 12.03.2025
 * 12:30 and played today starts today at 12:30, not in 2025: that gave set
 * durations of 827890 minutes). When today's occurrence is more than 12 hours
 * ahead (a 23:30 match confirmed at 00:10) it is the day before.
 *
 * Zürich, the gym's clock, on a device in any zone: the device's getHours put
 * a 10:20 kick-off at 11:20 on a laptop left on GMT+2 (stress test 2026-10-25).
 *
 * A date without a time is no scheduled time: a bare "YYYY-MM-DD", or the
 * Zürich midnight MatchSetup's createScheduledAt stores for a date entered
 * without a time (set 1 would otherwise be proposed at 00:00). A match
 * really scheduled at midnight is proposed now, as OpenBeach does.
 *
 * @param {string|null|undefined} scheduledAt ISO
 * @param {Date} [now]
 * @returns {string|null} ISO timestamp with zeroed seconds, or null without a valid schedule
 */
export function scheduledStartOnDay(scheduledAt, now = new Date()) {
  if (!scheduledAt) return null
  if (typeof scheduledAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(scheduledAt.trim())) return null
  const scheduled = zonedParts(scheduledAt)
  const today = zonedParts(now)
  if (!scheduled.valid || !scheduled.timed || !today.valid) return null
  if (scheduled.hour === 0 && scheduled.minute === 0) return null
  const onDay = (offset) => zurichWallTimeMs(today.year, today.month, today.day + offset, scheduled.hour, scheduled.minute)
  let day = onDay(0)
  if (day - now.getTime() > 12 * HOUR) day = onDay(-1)
  return new Date(day).toISOString()
}

/**
 * The schedule set 1's start is proposed from: the match's scheduledAt, for
 * every match but an Easy one (its scheduledAt is the moment it was created).
 *
 * A test match too (owner 2026-11-17, "super important": "when starting the
 * game, the suggestion MUST always be the scheduled time"): a test match
 * scheduled 21:00 and started at 16:21 is proposed 21:00, not 16:21. Before,
 * a test match's schedule only counted within 30 minutes of now (2026-11-15)
 * or never (2026-10-08), so its set 1 was proposed now. A different time the
 * scorer confirms goes to the remarks with the reason, as for any match.
 *
 * @param {{ scheduledAt?: string|null, test?: boolean, easy?: boolean }|null|undefined} match
 * @returns {string|null}
 */
export function startScheduleOf(match) {
  if (!match || match.easy === true) return null
  return match.scheduledAt || null
}

/** True when the set's start is proposed from the schedule: set 1 of a match with a scheduled time. */
export function startsFromSchedule({ setIndex, scheduledAt }) {
  return setIndex === 1 && scheduledStartOnDay(scheduledAt) !== null
}

/** Minutes between a set's end and the next set's proposed start (the interval). */
export const INTERVAL_MINUTES = 3

/**
 * Default time offered by the "Set N start time" dialog (owner 2026-11-15).
 *
 * Set 1 of a match with a scheduled time: the scheduled time of day, on the
 * day played. A minor delay does not move it (the rules: a 15:02 start of a
 * 15:00 match is 15:00); a different time the scorer confirms has to be
 * explained, so it goes to the remarks ("Actual game start: HH:MM",
 * actualStartRemark), with the scorer's reason. How early or late the scorer
 * starts does not matter (owner 2026-11-17: scheduled 21:00, started 16:21:
 * proposed 21:00). Without a scheduled time (none, a date without a time, an
 * Easy match): now, and the dialog says so.
 *
 * Sets 2..5: the end of the last set already played + 3 minutes (now when no
 * set has an end).
 *
 * The confirmed time is the start printed on the scoresheet and the result
 * card (matchTimes), whatever the clock of the first rally said.
 *
 * @param {{ setIndex: number, sets?: Array<{index: number, endTime?: string}>, now?: Date, scheduledAt?: string|null }} args
 * @returns {string} ISO timestamp with zeroed seconds
 */
export function defaultSetStartTime({ setIndex, sets = [], now = new Date(), scheduledAt = null }) {
  if (setIndex === 1) {
    const scheduled = scheduledStartOnDay(scheduledAt, now)
    if (scheduled) return scheduled
    return roundToMinute(now.toISOString())
  }
  let lastEnd = null
  for (const s of sets) {
    if (!s || !(s.index < setIndex) || !s.endTime) continue
    const end = new Date(s.endTime).getTime()
    if (Number.isFinite(end) && (lastEnd === null || end > lastEnd)) lastEnd = end
  }
  if (lastEnd === null) return roundToMinute(now.toISOString())
  return roundToMinute(new Date(lastEnd + INTERVAL_MINUTES * 60000).toISOString())
}

/**
 * The remark for set 1's start: "Actual game start: HH:MM (reason)" when the
 * scorer confirmed a time of day other than the scheduled one, else null (the
 * scheduled time kept, a later set, or no schedule). The reason is the
 * scorer's explanation (owner 2026-11-17: a change must say why); without
 * one the line is "Actual game start: HH:MM", as before.
 *
 * @param {{ setIndex: number, scheduledAt?: string|null, startTime?: string|null, reason?: string|null }} args
 * @returns {string|null}
 */
export function actualStartRemark({ setIndex, scheduledAt, startTime, reason = null }) {
  if (setIndex !== 1 || !startTime || !scheduledStartOnDay(scheduledAt)) return null
  const confirmed = new Date(startTime)
  if (Number.isNaN(confirmed.getTime())) return null
  if (remarkClock(confirmed) === remarkClock(new Date(scheduledAt))) return null
  return actualStartLine(confirmed, reason) || null
}

/**
 * The start the "Set N start time" dialog confirms: the typed Zürich HH:MM on
 * the day nearest to the proposed time (within 12 hours of it). The dialog
 * shows only HH:MM; taking the proposal's date put a typed time a day off
 * whenever the proposal is on the day before (a 23:30 match confirmed at
 * 00:10 is proposed yesterday 23:30: a typed 00:12 became yesterday 00:12, a
 * set of over 24 hours) or the typed time is across midnight from it.
 *
 * @param {string} proposedIso the dialog's default (ISO)
 * @param {string} clock typed "HH:MM"
 * @returns {string|null} ISO, or null for an invalid time
 */
export function typedStartNear(proposedIso, clock) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(clock || '').trim())
  const ref = new Date(proposedIso)
  if (!m || Number.isNaN(ref.getTime()) || Number(m[1]) > 23 || Number(m[2]) > 59) return null
  const p = zonedParts(ref)
  const onDay = (offset) => zurichWallTimeMs(p.year, p.month, p.day + offset, Number(m[1]), Number(m[2]))
  let d = onDay(0)
  const diff = d - ref.getTime()
  if (diff > 12 * HOUR) d = onDay(-1)
  else if (diff < -12 * HOUR) d = onDay(1)
  return new Date(d).toISOString()
}
