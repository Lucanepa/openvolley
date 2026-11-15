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
 * How near "now" a test match's scheduled time of day must be to count as its
 * schedule (either side). See startScheduleOf.
 */
export const TEST_SCHEDULE_WINDOW_MS = 30 * 60 * 1000

/**
 * The schedule set 1's start is proposed from: the match's scheduledAt.
 *
 * A test match's scheduledAt is a made-up next 20:00 kickoff (testSeeds
 * getNextTestMatchStartTime: a test scored at 15:00 was proposed 20:00, and
 * any real start became an "Actual start time" remark, 2026-10-08), unless the
 * scorer set a real one (a schedule game loaded, the time typed): a test
 * match used for a real 14:00 game started 14:06 was proposed 14:06 (owner
 * 2026-11-15: "not 14:00 as suggestion as = to scheduled time"). So a test
 * match's scheduled time counts only within 30 minutes of now; the made-up
 * kickoff hours away stays no schedule. An Easy match has none: its
 * scheduledAt is the moment it was created.
 *
 * @param {{ scheduledAt?: string|null, test?: boolean, easy?: boolean }|null|undefined} match
 * @param {Date} [now]
 * @returns {string|null}
 */
export function startScheduleOf(match, now = new Date()) {
  if (!match || match.easy === true) return null
  const scheduledAt = match.scheduledAt || null
  if (match.test !== true) return scheduledAt
  const onDay = scheduledStartOnDay(scheduledAt, now)
  if (!onDay) return null
  return Math.abs(new Date(onDay).getTime() - now.getTime()) <= TEST_SCHEDULE_WINDOW_MS ? scheduledAt : null
}

/**
 * Set 1's start is no longer proposed from the schedule (owner 2026-11-15:
 * the match's actual start), so nothing is "from the schedule" any more.
 * Kept for the callers that pass the flag along.
 */
export function startsFromSchedule() {
  return false
}

/** Minutes between a set's end and the next set's proposed start (the interval). */
export const INTERVAL_MINUTES = 3

/**
 * Default time offered by the "Set N start time" dialog (owner 2026-11-15).
 *
 * Set 1: the match's actual start, now (to the minute, rounded down).
 * Set 2..5: the end of the last set already played + 3 minutes.
 * The scorer's confirmed time is the set's start on the sheet and the result
 * card (utils matchTimes), whatever the first rally's clock said.
 *
 * @param {{ setIndex: number, sets?: Array<{index: number, endTime?: string}>, now?: Date }} args
 * @returns {string} ISO timestamp with zeroed seconds
 */
export function defaultSetStartTime({ setIndex, sets = [], now = new Date() }) {
  let lastEnd = null
  for (const s of sets) {
    if (!s || !(s.index < setIndex) || !s.endTime) continue
    const end = new Date(s.endTime).getTime()
    if (Number.isFinite(end) && (lastEnd === null || end > lastEnd)) lastEnd = end
  }
  if (setIndex === 1 || lastEnd === null) return roundToMinute(now.toISOString())
  return roundToMinute(new Date(lastEnd + INTERVAL_MINUTES * 60000).toISOString())
}

/**
 * The remark for set 1's start: "Actual start time: HH:MM" when the scorer
 * confirmed a time of day other than the scheduled one, else null (the
 * scheduled time kept, a later set, or no schedule).
 *
 * @param {{ setIndex: number, scheduledAt?: string|null, startTime?: string|null }} args
 * @returns {string|null}
 */
export function actualStartRemark({ setIndex, scheduledAt, startTime }) {
  if (setIndex !== 1 || !startTime || !scheduledStartOnDay(scheduledAt)) return null
  const confirmed = new Date(startTime)
  if (Number.isNaN(confirmed.getTime())) return null
  if (remarkClock(confirmed) === remarkClock(new Date(scheduledAt))) return null
  return actualStartLine(confirmed) || null
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
