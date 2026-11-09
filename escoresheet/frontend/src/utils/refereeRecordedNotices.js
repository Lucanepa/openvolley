// The referee tablets' "Recorded by the scorer" popup: every time-out,
// substitution (exceptional ones included) and sanction the scorer records
// opens it on every referee tablet, with an OK button; it closes by itself
// 10 s after the last entry came in. Entries recorded while it is open are
// added to it, so the referee reads one summary of everything.
//
// The entries come from the event list the referee already loads (a relay
// bundle's events, or the ones built from a match_live_state row), not from
// the relay's actions: a tablet on the database alone gets them too, and a
// reconnect's refetch shows what was recorded while it was offline.

import { compareBySeq, displaySetNumber, formatScore, otherTeam, sanctionLabel, sanctionTarget, scoreBeforeEvent, teamLabel, tr } from '../domain/describe.js'

/** The event types the popup announces. */
export const NOTICE_TYPES = Object.freeze(['timeout', 'substitution', 'sanction'])

/** The popup closes by itself this long after its last entry came in. */
export const NOTICE_AUTO_DISMISS_MS = 10000

const toMs = (ts) => {
  if (ts == null || ts === '') return ''
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : ''
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : ''
}

// An event's identity across reloads of the same list. No set index: the
// events built from a live-state row all carry the current set, and that
// row's sanctions are the whole match's (a set change would re-announce them).
function contentKey(e) {
  const p = e.payload || {}
  const seq = Number(e.seq)
  return [
    e.type, p.team ?? '', Number.isFinite(seq) ? seq : '', toMs(e.ts),
    p.playerIn ?? '', p.playerOut ?? '',
    p.type ?? p.sanctionType ?? '', p.playerNumber ?? '', p.playerType ?? '', p.role ?? ''
  ].join('|')
}

/** The announced events of a list by identity (equal ones numbered: "#0", "#1"). */
export function noticeKeys(events) {
  const out = new Map()
  if (!Array.isArray(events)) return out
  const seen = new Map()
  for (const e of events) {
    if (!e || !NOTICE_TYPES.includes(e.type)) continue
    const base = contentKey(e)
    const n = seen.get(base) || 0
    seen.set(base, n + 1)
    out.set(`${base}#${n}`, e)
  }
  return out
}

/**
 * Which announced events are new since the last list seen.
 *
 * The first list of a scope (a match, read from one source: relay bundle or
 * live-state row) is the baseline and announces nothing: a referee opening
 * the match, or reloading, is not shown what was recorded before. A change of
 * source starts a new baseline too (the two key the same event differently).
 * An empty list is no information (a partial load) and is skipped.
 *
 * `removed` are the keys gone from the list (an undo): the popup drops them.
 * None are given when the set changed, where a live-state row empties its
 * substitutions and time-outs for the new set.
 */
export function createRecordedNoticeTracker() {
  let known = null
  let scope = null
  let setIndex = null
  return {
    reset() { known = null; scope = null; setIndex = null },
    update(events, { scope: nextScope = null, setIndex: nextSet = null } = {}) {
      if (!Array.isArray(events) || events.length === 0) return { added: [], removed: [] }
      const next = noticeKeys(events)
      if (known === null || nextScope !== scope) {
        known = next
        scope = nextScope
        setIndex = nextSet
        return { added: [], removed: [] }
      }
      const added = []
      for (const [key, event] of next) if (!known.has(key)) added.push({ key, event })
      const setChanged = nextSet !== setIndex
      const removed = setChanged ? [] : [...known.keys()].filter(k => !next.has(k))
      known = next
      setIndex = nextSet
      added.sort((a, b) => compareBySeq(a.event, b.event))
      return { added, removed }
    }
  }
}

// The badge of a sanction: the card it is shown with
const SANCTION_TONE = {
  warning: 'yellow',
  delay_warning: 'yellow',
  penalty: 'red',
  delay_penalty: 'red',
  expulsion: 'redYellow',
  disqualification: 'redYellowApart',
  improper_request: 'neutral'
}

/**
 * One popup entry.
 * @param {string} key from noticeKeys
 * @param {object} event the recorded event
 * @param {object[]} events the whole list (the score before the event)
 * @param {{ t?: Function, match?: object, homeTeam?: object, awayTeam?: object,
 *   score?: {home:number, away:number}|null }} ctx `score` is the current
 *   one, used when the list holds no points (a live-state row's list)
 * @returns {{ key: string, kind: string, title: string, detail: string,
 *   team: object|null, setLabel: string, score: string, tone: string, exceptional: boolean }}
 */
export function describeNotice(key, event, events, ctx = {}) {
  const { t } = ctx
  const p = event?.payload || {}
  const team = teamLabel(p.team, ctx)
  const setIndex = event?.setIndex ?? p.setIndex ?? 1
  const setLabel = tr(t, 'corrections.term.set', 'Set {{n}}', { n: displaySetNumber(setIndex, ctx.match) })
  const hasPoints = Array.isArray(events) && events.some(e => e?.type === 'point')
  const scoreValue = hasPoints ? scoreBeforeEvent(events, event) : (ctx.score || null)
  const concerned = p.team === 'home' || p.team === 'away' ? p.team : null
  const score = scoreValue ? formatScore(scoreValue, concerned, ctx) : ''
  const num = (n) => (n !== undefined && n !== null && n !== '' ? n : '?')

  let title = ''
  let detail = ''
  let tone = 'neutral'
  let exceptional = false
  switch (event?.type) {
    case 'timeout':
      title = tr(t, 'corrections.term.timeout', 'Time-out')
      tone = 'timeout'
      break
    case 'substitution':
      // relay events: isExceptional; the ones built from a live-state row: exceptional
      exceptional = p.isExceptional === true || p.exceptional === true
      title = exceptional
        ? tr(t, 'corrections.term.exceptionalSubstitution', 'Exceptional substitution')
        : tr(t, 'corrections.term.substitution', 'Substitution')
      detail = tr(t, 'corrections.describe.subInFor', '#{{in}} in for #{{out}}', { in: num(p.playerIn), out: num(p.playerOut) })
      tone = exceptional ? 'exceptional' : 'substitution'
      break
    case 'sanction': {
      const type = p.type || p.sanctionType
      title = sanctionLabel(type, t)
      const target = sanctionTarget(p, t)
      const parts = target.kind === 'team' ? [] : [target.label]
      if ((type === 'penalty' || type === 'delay_penalty') && concerned) {
        const opp = teamLabel(otherTeam(concerned), ctx)
        parts.push(tr(t, 'corrections.describe.pointTo', '+1 point to {{team}}', { team: opp?.name || '?' }))
      }
      detail = parts.join(' · ')
      tone = SANCTION_TONE[type] || 'neutral'
      break
    }
    default:
      return null
  }
  return { key, kind: event.type, title, detail, team, setLabel, score, tone, exceptional }
}
