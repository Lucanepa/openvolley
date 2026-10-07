/**
 * Set and match times, one source for the scoresheet (set headers, RESULT table)
 * and the in-app "Match complete" card (MatchEnd.jsx). Pure.
 *
 * Owner decision 2026-10-07 (field-spec 16): the times are the ACTUAL ones.
 *  - Set start: the real start of the set's first rally, the `rally_start`
 *    event Scoreboard logs with the device clock when the first rally starts.
 *    The "Set n start time" dialog value (set.startTime) can be the scheduled
 *    time typed or kept by the scorer (a match planned 14:30 that started 16:05
 *    printed "Match Start 14:30" and a 104' first set); it is used only when a
 *    set has no rally_start (older records), then the set's first point.
 *  - Set end: the recorded set end (set.endTime), else the set's last point.
 *  - Times are taken to the minute (rounded down), so a duration is always the
 *    difference of the two printed times.
 *  - Match start = set 1's actual start; match end = the last set's end;
 *    match duration = end - start (intervals included). Never the schedule.
 */

export interface TimedSet {
  index: number
  startTime?: string | null
  endTime?: string | null
  finished?: boolean
}

export interface TimedEvent {
  type?: string
  setIndex?: number
  seq?: number
  ts?: string | number | null
}

const ms = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Date.parse(String(v))
  return Number.isFinite(n) ? n : null
}
const toMinute = (n: number): number => Math.floor(n / 60000) * 60000

const timesOf = (events: TimedEvent[] | undefined, setIndex: number, type: string): number[] =>
  (Array.isArray(events) ? events : [])
    .filter(e => e && e.setIndex === setIndex && e.type === type)
    .map(e => ms(e.ts))
    .filter((n): n is number => n !== null)

/** The set's actual start (ms, to the minute), or null when nothing tells it. */
export function setStartMs(set: TimedSet | null | undefined, events?: TimedEvent[]): number | null {
  if (!set) return null
  const rallies = timesOf(events, set.index, 'rally_start')
  if (rallies.length > 0) return toMinute(Math.min(...rallies))
  const confirmed = ms(set.startTime)
  if (confirmed !== null) return toMinute(confirmed)
  const points = timesOf(events, set.index, 'point')
  return points.length > 0 ? toMinute(Math.min(...points)) : null
}

/** The set's end (ms, to the minute): the recorded end, else its last point. */
export function setEndMs(set: TimedSet | null | undefined, events?: TimedEvent[]): number | null {
  if (!set) return null
  const recorded = ms(set.endTime)
  if (recorded !== null) return toMinute(recorded)
  if (!set.finished) return null
  const points = timesOf(events, set.index, 'point')
  return points.length > 0 ? toMinute(Math.max(...points)) : null
}

/** Whole minutes from the set's actual start to its end, or null (unfinished / unknown / not after the start). */
export function setDurationMinutes(set: TimedSet | null | undefined, events?: TimedEvent[]): number | null {
  if (!set?.finished) return null
  const start = setStartMs(set, events)
  const end = setEndMs(set, events)
  if (start === null || end === null || end < start) return null
  return Math.floor((end - start) / 60000)
}

/**
 * Match start (set 1's actual start), end (the last finished set's end) and
 * duration in minutes. `skip` leaves out sets that had no rally (a set awarded
 * by default). The end and duration exist only once a set has ended.
 */
export function matchTimes(
  sets: TimedSet[] | undefined,
  events?: TimedEvent[],
  { skip }: { skip?: (set: TimedSet) => boolean } = {}
): { startMs: number | null; endMs: number | null; durationMinutes: number | null } {
  const played = (Array.isArray(sets) ? sets : []).filter(s => s && !(skip && skip(s)))
  const first = played.filter(s => s.index === 1)[0] ?? [...played].sort((a, b) => a.index - b.index)[0]
  const startMs = setStartMs(first, events)
  const ends = played.filter(s => s.finished).map(s => setEndMs(s, events)).filter((n): n is number => n !== null)
  const endMs = ends.length > 0 ? Math.max(...ends) : null
  const durationMinutes = startMs !== null && endMs !== null && endMs >= startMs ? Math.floor((endMs - startMs) / 60000) : null
  return { startMs, endMs, durationMinutes }
}

/** ISO string of a time in ms (for the local-time formatters), '' for null. */
export const isoOf = (n: number | null): string => (n === null ? '' : new Date(n).toISOString())
