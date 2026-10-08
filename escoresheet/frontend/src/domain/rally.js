/**
 * The rally of a set: in play or not, from the set's events. One rule for the
 * scoring screen (which shows the point buttons, or Start rally) and for the
 * point and rally-start taps, which check it against the database: a tap on
 * a screen that has not caught up yet (a slow tablet) must not give a second
 * point for one rally or start a rally twice.
 */

const timeOf = (e) => (typeof e.ts === 'number' ? e.ts : new Date(e.ts).getTime())

/**
 * 'in_play' when the set's last event (by seq; by time for events without
 * one) is a rally_start, else 'idle' (a point or a replay ended the rally,
 * the set has not had a rally yet, or something was recorded since).
 * @param {Array<{ type: string, setIndex?: number, seq?: number, ts?: string|number }>} events
 * @param {number} setIndex
 * @returns {'in_play'|'idle'}
 */
export function rallyStatusOf(events, setIndex) {
  if (!events || events.length === 0 || setIndex == null) return 'idle'
  let last = null
  for (const e of events) {
    if (e.setIndex !== setIndex) continue
    if (!last) { last = e; continue }
    const a = e.seq || 0
    const b = last.seq || 0
    const later = (a !== 0 || b !== 0) ? a > b : timeOf(e) > timeOf(last)
    if (later) last = e
  }
  return last?.type === 'rally_start' ? 'in_play' : 'idle'
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
