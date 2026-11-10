// The referee footer's "Last action" line.
//
// It used to be set only from a pushed match_live_state row, stamped with the
// time the push arrived. A referee that missed a push (offline, reconnect)
// kept the stale line, and after a reload it showed "–" until the next action.
// These helpers derive the line from any data the referee loads (a relay
// bundle's events or a live-state row), stamped with the scorer's time.
//
// Newest alone was not enough: an Undo (or a decision change, a Go back)
// leaves an older action last, and the undone time-out, newer, stayed on the
// footer for good. The line follows the current log instead (nextLastEvent):
// a full relay bundle's events are the log as it is now, and a push that
// rewrote the log names the action now last itself (lastAction).

export const DISPLAYABLE_EVENTS = [
  'point', 'timeout', 'substitution', 'libero_entry', 'libero_exit', 'libero_exchange',
  'libero_redesignation', 'set_end', 'sanction', 'court_captain_designation'
]

// Scorer pushes after which the last action can be another, older one or none
// (undone, swapped to the other team, replayed, rebuilt by a Go back or a
// correction). The scorer's live state of these carries the action now last
// in last_event_data.lastAction (liveStateLastAction), null when there is none.
export const LOG_REWRITE_EVENTS = [
  'undo', 'decision_change', 'replay', 'rectification', 'manual_correction', 'manual_reopen_set'
]

// The fields the footer line reads (refereeEventLabel): last_event_data is
// public (the livescore reads the row), so no whole payload goes out with it
const FOOTER_DATA_FIELDS = ['team', 'setIndex', 'playerOut', 'playerIn', 'type', 'playerNumber', 'role', 'playerType', 'liberoNumber']

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

/**
 * What the scorer writes as last_event_data.lastAction on a LOG_REWRITE_EVENTS
 * push: the action now last in `events` (its own events after the undo), with
 * only the fields the footer reads, or null when none is left.
 */
export function liveStateLastAction(events) {
  const last = lastEventFromEvents(events)
  if (!last) return null
  const data = {}
  for (const key of FOOTER_DATA_FIELDS) {
    if (last.data?.[key] != null) data[key] = last.data[key]
  }
  return { type: last.type, team: last.team, data, ts: new Date(last.timestamp).toISOString() }
}

/**
 * A live-state row of a push that rewrote the log, with the action it names
 * as last: { at, lastEvent } (`at`: when the push was made; `lastEvent`: the
 * footer entry, null when nothing is left). Null for any other row, and for a
 * scorer that does not name it (older version): then nothing is known.
 */
export function liveStateRewrite(state) {
  if (!state || !LOG_REWRITE_EVENTS.includes(state.last_event_type)) return null
  const named = state.last_event_data
  if (!named || typeof named !== 'object' || !Object.prototype.hasOwnProperty.call(named, 'lastAction')) return null
  const at = toMs(state.last_event_ts) ?? toMs(state.updated_at)
  if (at == null) return null
  const action = named.lastAction
  const timestamp = toMs(action?.ts)
  const lastEvent = action && DISPLAYABLE_EVENTS.includes(action.type) && timestamp != null
    ? { type: action.type, team: action.team || null, data: action.data || null, timestamp }
    : null
  return { at, lastEvent }
}

/**
 * The footer's next entry after the referee loaded or was pushed match data.
 * - `eventsAreCurrent`: `events` are the scorer's whole log as it is now (a
 *   full relay bundle not older than the live state it brings): its last
 *   action is shown, also when it is older than the shown one or there is
 *   none (everything undone: "–").
 * - Otherwise the newer of the shown entry, the events' and the row's (a push
 *   can arrive before the bundle), and a row that rewrote the log after the
 *   shown action replaces it with the action it names (liveStateRewrite).
 * @param {object|null} current - the shown entry
 * @param {{ events?: Array|null, liveState?: object|null, eventsAreCurrent?: boolean, fallbackTs?: number|null }} input
 */
export function nextLastEvent(current, { events = null, liveState = null, eventsAreCurrent = false, fallbackTs = null } = {}) {
  if (eventsAreCurrent) return lastEventFromEvents(events)
  let next = pickNewerLastEvent(current, lastEventFromEvents(events))
  next = pickNewerLastEvent(next, lastEventFromLiveState(liveState, { fallbackTs }))
  const rewrite = liveStateRewrite(liveState)
  if (rewrite && (!next || rewrite.at >= next.timestamp)) return rewrite.lastEvent
  return next
}

/**
 * The score as the referee sees the court: the left team first, each side
 * with its letter ("A 20 : 16 B"), as on the scorer screen. It was printed
 * "(20-16)", left-right with no letters (parity with OpenBeach a237c69).
 */
export function courtScore({ leftLabel, rightLabel, leftPoints, rightPoints }) {
  return `${leftLabel || ''} ${leftPoints ?? 0} : ${rightPoints ?? 0} ${rightLabel || ''}`.trim()
}

const SANCTION_SHORT = {
  improper_request: 'IR',
  delay_warning: 'DW',
  delay_penalty: 'DP',
  warning: 'W',
  penalty: 'P',
  expulsion: 'EXP',
  disqualification: 'DQ'
}

/**
 * The footer's "Last action" text.
 * @param {{ type: string, team?: 'home'|'away'|null, data?: object }|null} lastEvent
 * @param {{ homeLabel: string, awayLabel: string, homeShort: string, awayShort: string,
 *   leftLabel: string, rightLabel: string, leftPoints: number, rightPoints: number,
 *   setLabel?: (setIndex: number) => (number|string), t: Function }} ctx
 */
export function refereeEventLabel(lastEvent, ctx) {
  if (!lastEvent) return ''
  const t = typeof ctx.t === 'function' ? ctx.t : (key) => key
  const team = lastEvent.team
  const teamLbl = team === 'home' ? ctx.homeLabel : team === 'away' ? ctx.awayLabel : ''
  const teamShort = team === 'home' ? ctx.homeShort : team === 'away' ? ctx.awayShort : ''
  const teamInfo = teamLbl ? [teamLbl, teamShort, `(${courtScore(ctx)})`].filter(Boolean).join(' ') : ''
  const data = lastEvent.data || {}
  const withTeam = (text) => [text, teamInfo].filter(Boolean).join(' ')

  switch (lastEvent.type) {
    case 'point': return withTeam(t('refereeDashboard.events.point'))
    case 'timeout': return withTeam(t('refereeDashboard.events.timeout'))
    case 'substitution': return `${withTeam(t('refereeDashboard.events.substitution'))}: #${data.playerOut} → #${data.playerIn}`
    case 'libero_entry': return withTeam(t('refereeDashboard.events.liberoIn'))
    case 'libero_exit': return withTeam(t('refereeDashboard.events.liberoOut'))
    case 'libero_exchange': return withTeam(t('refereeDashboard.events.liberoExchange'))
    case 'libero_redesignation': return withTeam(t('refereeDashboard.events.liberoRedesignation'))
    case 'set_end': {
      const set = data.setIndex ? (typeof ctx.setLabel === 'function' ? ctx.setLabel(data.setIndex) : data.setIndex) : ''
      return t('refereeDashboard.events.setEnd', { set })
    }
    case 'sanction': {
      const short = SANCTION_SHORT[data.type] || data.type || ''
      // delay and improper request: no member
      const isDelayOrIR = ['delay_warning', 'delay_penalty', 'improper_request'].includes(data.type)
      let memberInfo = ''
      if (!isDelayOrIR) {
        if (data.playerNumber) memberInfo = `#${data.playerNumber}`
        else if (data.role) memberInfo = data.role // officials: coach, assistant coach ...
        else if (data.playerType) memberInfo = data.playerType
      }
      return [short, teamInfo, memberInfo].filter(Boolean).join(' ')
    }
    case 'court_captain_designation':
      return `${withTeam(t('refereeDashboard.events.courtCaptainDesignation'))} #${data.playerNumber || '?'}`
    default:
      return ''
  }
}
