/**
 * The rally of a set: in play or not, from the set's events. One rule for the
 * scoring screen (which shows the point buttons, or Start rally) and for the
 * point and rally-start taps, which check it against the database: a tap on
 * a screen that has not caught up yet (a slow tablet) must not give a second
 * point for one rally or start a rally twice.
 */

const timeOf = (e) => (typeof e.ts === 'number' ? e.ts : new Date(e.ts).getTime())

// Recorded beside the play, not part of it: a remark and a bench member's
// injury. They take the next seq of the set like any event, so read as the
// set's last event they ended a rally in play (the Point buttons gave way to
// Start rally, or to Start set at a set's first rally) and hid the decision
// change on the last point.
const BOOKKEEPING_TYPES = new Set(['remark', 'bench_injury'])

/** True for an event recorded beside the play (a remark, a bench injury). */
export function isBookkeepingEvent(e) {
  return BOOKKEEPING_TYPES.has(e?.type)
}

/**
 * 'in_play' when the set's last event (by seq; by time for events without
 * one) is a rally_start, else 'idle' (a point or a replay ended the rally,
 * the set has not had a rally yet, or something was recorded since).
 * Bookkeeping events (isBookkeepingEvent) are not counted.
 * @param {Array<{ type: string, setIndex?: number, seq?: number, ts?: string|number }>} events
 * @param {number} setIndex
 * @returns {'in_play'|'idle'}
 */
export function rallyStatusOf(events, setIndex) {
  if (!events || events.length === 0 || setIndex == null) return 'idle'
  let last = null
  for (const e of events) {
    if (e.setIndex !== setIndex || isBookkeepingEvent(e)) continue
    if (!last) { last = e; continue }
    const a = e.seq || 0
    const b = last.seq || 0
    const later = (a !== 0 || b !== 0) ? a > b : timeOf(e) > timeOf(last)
    if (later) last = e
  }
  return last?.type === 'rally_start' ? 'in_play' : 'idle'
}

/**
 * True until the set's first rally is started: no set_start and no
 * rally_start in the set (and, for a set recorded before set_start existed,
 * no point that is not a penalty's). A penalty point before the first serve
 * does not end it: it used to, and the first rally then skipped the
 * signature gate, the libero reminder and the Set start time dialog (no
 * set_start, no start time).
 * @param {Array<{ type: string, setIndex?: number, payload?: object }>} events
 * @param {number} setIndex
 */
export function isFirstRallyOf(events, setIndex) {
  if (setIndex == null) return true
  return !(events || []).some(e => e && e.setIndex === setIndex && (
    e.type === 'set_start' || e.type === 'rally_start' ||
    (e.type === 'point' && e.payload?.penaltySeq == null)
  ))
}

/**
 * True when both teams' starting line-ups of the set are in: the first rally
 * of a set waits for them (an Easy match excepted).
 * @param {Array<{ type: string, setIndex?: number, payload?: object }>} events
 * @param {number} setIndex
 */
export function startingLineupsIn(events, setIndex) {
  const has = (team) => (events || []).some(e => e && e.type === 'lineup' && e.setIndex === setIndex &&
    e.payload?.team === team && e.payload?.isInitial)
  return has('home') && has('away')
}

/**
 * The set being played among a match's set rows: per index the newest row
 * (highest id), then the first one not finished, else the last.
 * @param {Array<{ id: number, index: number, finished?: boolean }>} sets
 */
export function currentSetOf(sets) {
  const byIndex = new Map()
  for (const set of sets || []) {
    const existing = byIndex.get(set.index)
    if (!existing || set.id > existing.id) byIndex.set(set.index, set)
  }
  const ordered = [...byIndex.values()].sort((a, b) => a.index - b.index)
  return ordered.find(s => !s.finished) || ordered[ordered.length - 1] || null
}
