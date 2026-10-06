// The referee footer's "Last action" line.
//
// It used to be set only from a pushed match_live_state row, stamped with the
// time the push arrived. A referee that missed a push (offline, reconnect)
// kept the stale line, and after a reload it showed "–" until the next action.
// These helpers derive the line from any data the referee loads (a relay
// bundle's events or a live-state row), stamped with the scorer's time, and
// keep whichever is newest.

export const DISPLAYABLE_EVENTS = [
  'point', 'timeout', 'substitution', 'libero_entry', 'libero_exit', 'libero_exchange',
  'libero_redesignation', 'set_end', 'sanction', 'court_captain_designation'
]

const toMs = (ts) => {
  if (ts == null || ts === '') return null
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null
  if (ts instanceof Date) return Number.isFinite(ts.getTime()) ? ts.getTime() : null
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : null
}

/** Last action from a match_live_state row (pushed or fetched), or null. */
export function lastEventFromLiveState(state, { fallbackTs = null } = {}) {
  if (!state || !DISPLAYABLE_EVENTS.includes(state.last_event_type)) return null
  const timestamp = toMs(state.last_event_ts) ?? toMs(state.updated_at) ?? toMs(fallbackTs)
  if (timestamp == null) return null
  return {
    type: state.last_event_type,
    team: state.last_event_team || null,
    data: state.last_event_data || null,
    timestamp
  }
}

// Sub-events carry a decimal sequence (7.1); they belong to their parent.
const isSubEvent = (e) => {
  const seq = Number(e?.seq)
  return Number.isFinite(seq) && seq !== Math.floor(seq)
}

/** Last displayable action in an event list (highest seq, else newest ts), or null. */
export function lastEventFromEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return null
  let best = null
  let bestKey = null
  for (const e of events) {
    if (!e || !DISPLAYABLE_EVENTS.includes(e.type) || isSubEvent(e)) continue
    const ts = toMs(e.ts)
    const seq = Number(e.seq)
    const key = [Number.isFinite(seq) ? seq : -Infinity, ts ?? -Infinity]
    if (!best || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = e
      bestKey = key
    }
  }
  if (!best) return null
  const timestamp = toMs(best.ts)
  if (timestamp == null) return null
  const payload = best.payload || {}
  return {
    type: best.type,
    team: payload.team || null,
    data: { ...payload, setIndex: payload.setIndex ?? best.setIndex },
    timestamp
  }
}

/** Newest of a loaded match's live-state row and its events, or null. */
export function lastEventFromMatchData({ liveState = null, events = null } = {}) {
  return pickNewerLastEvent(lastEventFromLiveState(liveState), lastEventFromEvents(events))
}

/** The newer of two last-action entries (the candidate wins a tie). */
export function pickNewerLastEvent(current, candidate) {
  if (!candidate) return current || null
  if (!current) return candidate
  return candidate.timestamp >= current.timestamp ? candidate : current
}
