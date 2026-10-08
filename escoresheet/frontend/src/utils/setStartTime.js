import { roundToMinute } from './timeUtils'
import { actualStartLine, remarkClock } from '../domain/remarks'

const HOUR = 3600 * 1000

/**
 * The match's scheduled time of day (local HH:MM) on the day it is played:
 * `now`'s local date, never the scheduled DATE (a match scheduled 12.03.2025
 * 12:30 and played today starts today at 12:30, not in 2025: that gave set
 * durations of 827890 minutes). When today's occurrence is more than 12 hours
 * ahead (a 23:30 match confirmed at 00:10) it is the day before.
 *
 * @param {string|null|undefined} scheduledAt ISO
 * @param {Date} [now]
 * @returns {string|null} ISO timestamp with zeroed seconds, or null without a valid schedule
 */
export function scheduledStartOnDay(scheduledAt, now = new Date()) {
  if (!scheduledAt) return null
  const scheduled = new Date(scheduledAt)
  if (Number.isNaN(scheduled.getTime())) return null
  const day = new Date(now.getTime())
  day.setHours(scheduled.getHours(), scheduled.getMinutes(), 0, 0)
  if (day.getTime() - now.getTime() > 12 * HOUR) day.setDate(day.getDate() - 1)
  return day.toISOString()
}

/** True when the set's start is proposed from the schedule: set 1 of a match with a scheduled time. */
export function startsFromSchedule({ setIndex, scheduledAt }) {
  return setIndex === 1 && scheduledStartOnDay(scheduledAt) !== null
}

/**
 * Default time offered by the "Set N start time" dialog.
 *
 * Set 1 of a match with a scheduled time: the scheduled time of day, on the
 * day played (owner 2026-10-08: "the proposed should be the scheduled time";
 * a different time the scorer confirms goes to the remarks, actualStartRemark).
 *
 * Any other set (and set 1 without a schedule, e.g. a test match): the dialog
 * opens when the set's first rally starts, so the set starts now (to the
 * minute, rounded down so it is never after the set's own rallies).
 * "Previous set end + 3 min" put a set's start after its own end whenever the
 * interval was ended early. The default is never before the end of the last
 * set already played (a device clock behind the stored end time); for the
 * best-of-3 deciding set (internal index 5) that is set 2.
 *
 * @param {{ setIndex: number, sets?: Array<{index: number, endTime?: string}>, now?: Date, scheduledAt?: string|null }} args
 * @returns {string} ISO timestamp with zeroed seconds
 */
export function defaultSetStartTime({ setIndex, sets = [], now = new Date(), scheduledAt = null }) {
  if (setIndex === 1) {
    const scheduled = scheduledStartOnDay(scheduledAt, now)
    if (scheduled) return scheduled
  }
  let start = now.getTime()
  for (const s of sets) {
    if (!s || !(s.index < setIndex) || !s.endTime) continue
    const end = new Date(s.endTime).getTime()
    if (Number.isFinite(end) && end > start) start = end
  }
  return roundToMinute(new Date(start).toISOString())
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
