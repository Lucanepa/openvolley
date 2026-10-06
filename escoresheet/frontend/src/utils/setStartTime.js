import { roundToMinute } from './timeUtils'

/**
 * Default time offered by the "Set N start time" dialog. The dialog opens when
 * the set's first rally starts, so the set starts now (to the minute, rounded
 * down so it is never after the set's own rallies).
 *
 * The match's scheduled time is not the start of set 1 (matches start late),
 * and "previous set end + 3 min" put a set's start after its own end whenever
 * the interval was ended early. The default is never before the end of the
 * last set already played (a device clock behind the stored end time); for the
 * best-of-3 deciding set (internal index 5) that is set 2.
 *
 * @param {{ setIndex: number, sets?: Array<{index: number, endTime?: string}>, now?: Date }} args
 * @returns {string} ISO timestamp with zeroed seconds
 */
export function defaultSetStartTime({ setIndex, sets = [], now = new Date() }) {
  let start = now.getTime()
  for (const s of sets) {
    if (!s || !(s.index < setIndex) || !s.endTime) continue
    const end = new Date(s.endTime).getTime()
    if (Number.isFinite(end) && end > start) start = end
  }
  return roundToMinute(new Date(start).toISOString())
}
