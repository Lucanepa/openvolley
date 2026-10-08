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
