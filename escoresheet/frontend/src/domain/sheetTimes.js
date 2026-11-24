/**
 * Set and match times: ONE set of rules for every place that shows them (owner
 * 2026-11-16, "the same logic everywhere"). The scoresheet and the in-app
 * "Match complete" card read them through scoresheet_pdf/utils/matchTimes.ts;
 * the server's public API (backend/lib/publicApi.js, set minutes) reads the
 * copy escoresheet/backend/lib/sheetTimes.js. The backend's Docker build sees
 * only escoresheet/backend, so the file is copied, byte for byte:
 * backend/tests/sheetTimes.test.js and the frontend's
 * src/utils/__tests__/sheetTimesParity.test.js fail when the two differ.
 * Change this file, then copy it over the backend's.
 *
 * Plain JavaScript, no imports, pure.
 *
 * Owner decisions (field-spec 16, 2026-10-07 and 2026-11-15):
 *  - Set start: the time the scorer confirmed in the "Set n start time" dialog
 *    (its set_start event; the dialog proposes the scheduled time for set 1 and
 *    the last set's end + 3 min for the others, + 10 after set 2 when the match
 *    has the 10-minute interval after set 2). A start corrected later
 *    (set.startTime other than the one the set_start event recorded) is the
 *    scorer's word and wins. Without a set_start event (older records): the
 *    first rally (rally_start events on the scoring device, set_start's
 *    firstRallyAt on a copy from the server), then set.startTime, then the
 *    set's first point.
 *  - Set end: the recorded set end (set.endTime), else the set's last point.
 *  - Times are taken to the minute (rounded down), so a duration is always the
 *    difference of the two printed times.
 *  - Match start = set 1's start; match end = the last finished set's end;
 *    match duration = end - start (intervals included). Never the schedule.
 *
 * A server copy of a match (cloud rows: set_index, start_time, end_time ...):
 * cloudSetTimes() applies rebuildSetStart() first, as the manager's Rebuild PDF
 * does (src/utils/scoresheetFromCloud.js), so the server's minutes are the
 * minutes printed on the sheet.
 */

/**
 * @typedef {{ index: number, startTime?: string|null, endTime?: string|null, finished?: boolean }} TimedSet
 * @typedef {{ type?: string, setIndex?: number, seq?: number, ts?: string|number|null,
 *   payload?: { startTime?: string|null, firstRallyAt?: string|null }|null }} TimedEvent
 */

/** @param {unknown} v @returns {number|null} */
const ms = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Date.parse(String(v))
  return Number.isFinite(n) ? n : null
}
/** @param {number} n */
const toMinute = (n) => Math.floor(n / 60000) * 60000
/** @param {unknown} v */
const minuteOf = (v) => {
  const n = ms(v)
  return n === null ? null : Math.floor(n / 60000)
}
const list = (v) => (Array.isArray(v) ? v : [])

/** @param {TimedEvent[]|undefined} events @param {number} setIndex @param {string} type */
const timesOf = (events, setIndex, type) => list(events)
  .filter(e => e && e.setIndex === setIndex && e.type === type)
  .map(e => ms(e.ts))
  .filter(n => n !== null)

/**
 * The set's start (ms, to the minute), or null when nothing tells it.
 * @param {TimedSet|null|undefined} set
 * @param {TimedEvent[]} [events]
 * @returns {number|null}
 */
export function setStartMs(set, events) {
  if (!set) return null
  const confirmed = ms(set.startTime)
  // the time the "Set n start time" dialog confirmed, as its set_start event recorded it
  const dialog = list(events)
    .filter(e => e && e.setIndex === set.index && e.type === 'set_start')
    .map(e => ms(e.payload?.startTime ?? e.ts))
    .find(n => n !== null) ?? null
  if (confirmed !== null && dialog !== null && toMinute(confirmed) !== toMinute(dialog)) return toMinute(confirmed)
  // Owner 2026-11-15: the time the scorer confirmed is the set's start, not the
  // clock of its first rally
  if (dialog !== null) return toMinute(dialog)
  // The rally starts stay on the scoring device: there they tell the start.
  // set_start's firstRallyAt is for a copy from the server, which has none
  const rallyStarts = timesOf(events, set.index, 'rally_start')
  const rallies = rallyStarts.length > 0
    ? rallyStarts
    : list(events)
      .filter(e => e && e.setIndex === set.index && e.type === 'set_start')
      .map(e => ms(e.payload?.firstRallyAt))
      .filter(n => n !== null)
  if (rallies.length > 0) return toMinute(Math.min(...rallies))
  if (confirmed !== null) return toMinute(confirmed)
  const points = timesOf(events, set.index, 'point')
  return points.length > 0 ? toMinute(Math.min(...points)) : null
}

/**
 * The set's end (ms, to the minute): the recorded end, else its last point.
 * @param {TimedSet|null|undefined} set
 * @param {TimedEvent[]} [events]
 * @returns {number|null}
 */
export function setEndMs(set, events) {
  if (!set) return null
  const recorded = ms(set.endTime)
  if (recorded !== null) return toMinute(recorded)
  if (!set.finished) return null
  const points = timesOf(events, set.index, 'point')
  return points.length > 0 ? toMinute(Math.max(...points)) : null
}

/**
 * Whole minutes from the set's start to its end, or null (unfinished, unknown,
 * or not after the start).
 * @param {TimedSet|null|undefined} set
 * @param {TimedEvent[]} [events]
 * @returns {number|null}
 */
export function setDurationMinutes(set, events) {
  if (!set?.finished) return null
  const start = setStartMs(set, events)
  const end = setEndMs(set, events)
  if (start === null || end === null || end < start) return null
  return Math.floor((end - start) / 60000)
}

/**
 * Match start (set 1's start), end (the last finished set's end) and duration
 * in minutes. `skip` leaves out sets that had no rally (a set awarded by
 * default). The end and duration exist only once a set has ended.
 * @param {TimedSet[]|undefined} sets
 * @param {TimedEvent[]} [events]
 * @param {{ skip?: (set: TimedSet) => boolean }} [opts]
 * @returns {{ startMs: number|null, endMs: number|null, durationMinutes: number|null }}
 */
export function matchTimes(sets, events, { skip } = {}) {
  const played = list(sets).filter(s => s && !(skip && skip(s)))
  const first = played.filter(s => s.index === 1)[0] ?? [...played].sort((a, b) => a.index - b.index)[0]
  const startMs = setStartMs(first, events)
  const ends = played.filter(s => s.finished).map(s => setEndMs(s, events)).filter(n => n !== null)
  const endMs = ends.length > 0 ? Math.max(...ends) : null
  const durationMinutes = startMs !== null && endMs !== null && endMs >= startMs ? Math.floor((endMs - startMs) / 60000) : null
  return { startMs, endMs, durationMinutes }
}

/** ISO string of a time in ms (for the local-time formatters), '' for null. @param {number|null} n */
export const isoOf = (n) => (n === null ? '' : new Date(n).toISOString())

/**
 * The start a cloud set row prints with, as the scorer's device printed it.
 *
 * On the device set.startTime is the time the "Set n start time" dialog
 * confirmed, or a later correction. In the cloud it can still be the time the
 * row was created (set 1 at the coin toss, set n+1 at the end of set n): the
 * column was not updated before 983fdb500 (2026-10-06), nor when that update
 * was lost. So the cloud value counts only where it can be the scorer's word:
 *  - it is the confirmed start (the same minute), or nothing else is known;
 *  - a correction of the set's times is recorded with it (the log's
 *    `setTimes` entry, or the set_end event Corrections rewrites);
 *  - it is later than the confirmed start (a creation time never is).
 * Otherwise the confirmed start, from the set_start event.
 *
 * @param {{ index: number, start_time?: string|null }} set  a cloud sets row
 * @param {object[]} [events]  the cloud events (set_index, type, payload, ts)
 * @param {object[]} [manualChanges]  the match's manual_changes
 * @returns {string|null}
 */
export function rebuildSetStart(set, events = [], manualChanges = []) {
  const cloud = set?.start_time ?? null
  const ofSet = list(events).filter(e => e && e.set_index === set?.index)
  const opened = ofSet.find(e => e.type === 'set_start' && minuteOf(e.payload?.startTime ?? e.ts) !== null)
  const confirmed = opened ? (opened.payload?.startTime ?? opened.ts) : null
  const c = minuteOf(cloud)
  const d = minuteOf(confirmed)
  if (c === null || d === null || c === d) return cloud
  const logged = list(manualChanges)
    .some(ch => ch?.action === 'setTimes' && ch.setIndex === set.index && minuteOf(ch.after?.startTime) === c)
  const endSays = ofSet.some(e => e.type === 'set_end' && minuteOf(e.payload?.startTime) === c)
  if (logged || endSays || c > d) return cloud
  const at = typeof confirmed === 'number' ? confirmed : Date.parse(String(confirmed))
  return new Date(at).toISOString()
}

/**
 * Each cloud set's times as the sheet prints them (the server's copy of a
 * match: rows of `sets` and `events`, the match's manual_changes).
 * @param {object[]} sets  rows { index, start_time, end_time, finished }
 * @param {object[]} [events]  rows { set_index, type, payload, ts } (payload parsed)
 * @param {object[]} [manualChanges]
 * @returns {{ index: number, startMs: number|null, endMs: number|null, minutes: number|null }[]}
 */
export function cloudSetTimes(sets, events = [], manualChanges = []) {
  const timed = list(events).filter(Boolean).map(e => ({ setIndex: e.set_index, type: e.type, payload: e.payload ?? null, ts: e.ts ?? null }))
  return list(sets).filter(Boolean).map(s => {
    const set = { index: s.index, startTime: rebuildSetStart(s, events, manualChanges), endTime: s.end_time ?? null, finished: s.finished === true }
    return { index: s.index, startMs: setStartMs(set, timed), endMs: setEndMs(set, timed), minutes: setDurationMinutes(set, timed) }
  })
}
