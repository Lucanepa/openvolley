/**
 * Bench requests, the apps' side (the relay's is backend/lib/benchRequests.js):
 * a bench tablet sends its team's starting line-up before each set, a
 * time-out request or a prepared substitution; the scorer accepts or declines.
 * Like a DataProject e-scoresheet's bench app, it is an aid: the coach asks
 * as always (FIVB 15.4, 15.5 "requested by the coach"), the scorer records
 * only what the referee granted, through the scorer's own dialogs and checks.
 * Pure: no React, no Dexie, no sockets.
 *
 *  - When the bench may send what (benchLineupAvailability,
 *    benchTimeoutAvailability, benchSubstitutionAvailability): the rules of
 *    domain/interruptionRequests.js the scorer is warned with, so the bench
 *    never sends what the scorer would have to refuse.
 *  - The bench's line-up editor (benchLineupCheck): six different roster
 *    players, no libero (7.3.4: liberos are not in the line-up), and a game
 *    captain when the team captain is not among the six (5.2).
 *  - The prepared substitution (benchSubstitutionChoices): who may go off,
 *    who may come on for whom, why not (substituteInIllegalReason).
 *  - The bench's requests (benchRequestsReducer) and the scorer's queue
 *    (scorerQueueReducer).
 */
import { LINEUP_POSITIONS, lineupEntryErrors, lineupCaptainStatus, gameCaptainOptions, teamCaptainNumber } from './lineupEntry'
import { timeoutRequestIssues, substitutionRequestIssues, substituteInIllegalReason, entryWithoutCompletedRally, isSentOff } from './interruptionRequests'
import { countRegularSubstitutions, MAX_SUBSTITUTIONS_PER_SET } from './substitutions'

export const COURT_ORDER = ['I', 'II', 'III', 'IV', 'V', 'VI']
const str = (v) => (v === undefined || v === null ? '' : String(v).trim())
const num = (v) => (str(v) === '' ? null : Number(v))
const isLibero = (p) => !!(p?.libero && p.libero !== '')

/** A request id: unique, URL-safe, also on a LAN page (no crypto.randomUUID outside a secure context). */
export function newBenchRequestId(rand = (n) => {
  const a = new Uint8Array(n)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(a)
  else for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256)
  return a
}) {
  return 'br-' + [...rand(12)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The events of a set (setIndex, default 1). */
const inSet = (events, setIndex) => (events || []).filter((e) => (e?.setIndex ?? 1) === setIndex)

/** Has the set started: a rally started or a point scored in it? */
export function setHasStarted(events, setIndex) {
  return inSet(events, setIndex).some((e) => e.type === 'rally_start' || e.type === 'point')
}

/** The team's latest line-up of the set (the court now), or null. */
export function latestLineup(events, setIndex, team) {
  let best = null
  for (const e of inSet(events, setIndex)) {
    if (e.type !== 'lineup' || e.payload?.team !== team || !e.payload?.lineup) continue
    if (!best || (e.seq || 0) >= (best.seq || 0)) best = e
  }
  return best?.payload?.lineup || null
}

/** Shirt number of a line-up position (rich { number } or a plain number). */
export const lineupNumber = (v) => (v && typeof v === 'object' && v.number !== undefined ? v.number : v)

/**
 * The set a bench sends for now, and the set its header shows: the match's
 * first unfinished set, else (the interval between sets, before the next
 * set's line-up creates it) the set the scorer's live state names, else the
 * one after the last. `sets` as the relay hands them ({ index, finished });
 * `liveState` the bundle's (current_set: the coming set in the interval, a
 * best-of-3 decider 5). The header showed "SET 1" through the 1-2 interval.
 */
export function benchSetIndex(sets, liveState = null) {
  let open = null
  let last = 0
  for (const s of sets || []) {
    const i = Number(s?.index)
    if (!Number.isInteger(i)) continue
    if (i > last) last = i
    if (!s.finished && (open === null || i < open)) open = i
  }
  if (open !== null) return open
  const live = Number(liveState?.current_set)
  if (Number.isInteger(live) && live > last && live <= 5) return live
  return last > 0 ? last + 1 : 1
}

/**
 * May the bench send its starting line-up for `setIndex` now?
 * reason: 'no_coin_toss' | 'match_over' | 'set_started' | 'lineup_entered' (the
 * scorer has one already: changes only through the scorer).
 */
export function benchLineupAvailability({ match, events, setIndex, team, matchOver = false }) {
  if (matchOver) return { allowed: false, reason: 'match_over' }
  if (match?.coinTossConfirmed !== true) return { allowed: false, reason: 'no_coin_toss' }
  if (setHasStarted(events, setIndex)) return { allowed: false, reason: 'set_started' }
  if (latestLineup(events, setIndex, team)) return { allowed: false, reason: 'lineup_entered' }
  return { allowed: true, reason: null }
}

/**
 * May the bench ask for a time-out now? The scorer's own warnings decide:
 * no line-up yet, a set interval, a replay pending, after a delay warning in
 * this interruption, both time-outs used (FIVB 15.1, 15.2.4, 15.11.1.4, 18.1).
 */
export function benchTimeoutAvailability({ events, setIndex, team, intervalRunning = false, matchOver = false }) {
  if (matchOver) return { allowed: false, reason: 'match_over' }
  if (!latestLineup(events, setIndex, team)) return { allowed: false, reason: 'no_lineup' }
  const issue = timeoutRequestIssues(events, setIndex, team, { intervalRunning })[0]
  return issue ? { allowed: false, reason: issue.reason } : { allowed: true, reason: null }
}

/**
 * May the bench prepare a substitution now? no line-up yet, a replay
 * pending, after a delay warning, 6 used, a second request in this
 * interruption (FIVB 15.2.3, 15.6, 15.11.1.3).
 */
export function benchSubstitutionAvailability({ events, setIndex, team, intervalRunning = false, matchOver = false }) {
  if (matchOver) return { allowed: false, reason: 'match_over' }
  if (!latestLineup(events, setIndex, team)) return { allowed: false, reason: 'no_lineup' }
  if (intervalRunning) return { allowed: false, reason: 'set_interval' }
  const issue = substitutionRequestIssues(events, setIndex, team)[0]
  return issue ? { allowed: false, reason: issue.reason } : { allowed: true, reason: null }
}

/**
 * The bench's line-up editor: what is wrong and what may be sent.
 * @param {{ lineup: Record<'I'|'II'|'III'|'IV'|'V'|'VI', string|number>, players: object[], events?: object[], team: string, gameCaptain?: string|number|null }} args
 * @returns {{ errors: Record<string,string>, complete: boolean, captainStatus: string,
 *   needsGameCaptain: boolean, gameCaptainChoices: string[], canSend: boolean, payload: object|null }}
 *   errors: position -> lineupEntryErrors code; payload: { lineup, gameCaptain? } once it can be sent
 */
export function benchLineupCheck({ lineup = {}, players = [], events = [], team, gameCaptain = null }) {
  const list = LINEUP_POSITIONS.map((pos) => str(lineup[pos]))
  const byIndex = lineupEntryErrors({ lineup: list, players, events, team })
  const errors = {}
  for (const [i, code] of Object.entries(byIndex)) errors[LINEUP_POSITIONS[Number(i)]] = code
  const complete = list.every((v) => v !== '')
  const captainStatus = lineupCaptainStatus({ lineup: list, players })
  const gameCaptainChoices = gameCaptainOptions({ lineup: list, players, events, team })
  const needsGameCaptain = complete && captainStatus === 'offCourt'
  const gc = str(gameCaptain) !== '' ? String(Number(gameCaptain)) : ''
  const gameCaptainOk = !needsGameCaptain || gameCaptainChoices.includes(gc)
  const canSend = complete && Object.keys(errors).length === 0 && gameCaptainOk
  const payload = canSend
    ? {
        lineup: Object.fromEntries(COURT_ORDER.map((pos) => [pos, Number(lineup[pos])])),
        ...(needsGameCaptain ? { gameCaptain: Number(gc) } : {})
      }
    : null
  return { errors, complete, captainStatus, needsGameCaptain, gameCaptainChoices, canSend, payload }
}

// Sent off for good or for this set (expelled this set, disqualified, or
// substituted exceptionally): the scorer's substitution rule asks it too
export { isSentOff }

/**
 * Who may go off and come on in a prepared substitution, with why not.
 * @param {{ events, setIndex, team, players, pairs?: Array<{out,in}> }} args
 *   players: the team's roster ({ number, libero, isCaptain })
 * @returns {{ onCourt: Array<{ number, position, isLibero, reason: string|null }>,
 *   remaining: number,
 *   candidatesFor: (out) => Array<{ number, reason: string|null }>,
 *   pairIssue: (pair) => string|null,
 *   captainGoesOff: boolean, gameCaptainChoices: string[] }}
 *   reason codes: 'libero' | 'no_rally_since_entry' | 'paired' (already in a pair)
 *   and substituteInIllegalReason's ('libero', 'sent_off', 'wrong_partner',
 *   'played_out', 'no_rally_since_out') | 'replaced_by_libero' | 'limit'
 */
export function benchSubstitutionChoices({ events = [], setIndex, team, players = [], pairs = [] }) {
  const lineup = latestLineup(events, setIndex, team) || {}
  const findPlayer = (n) => (players || []).find((p) => str(p.number) === str(n))
  const replacedByLibero = new Set()
  const onCourt = []
  for (const pos of COURT_ORDER) {
    const v = lineup[pos]
    const n = num(lineupNumber(v))
    if (n === null) continue
    const p = findPlayer(n)
    const libero = isLibero(p) || (v && typeof v === 'object' && v.isLibero === true)
    if (libero && v && typeof v === 'object' && v.replacedNumber != null) replacedByLibero.add(str(v.replacedNumber))
    onCourt.push({ number: n, position: pos, isLibero: libero })
  }
  const used = countRegularSubstitutions(events, team, setIndex)
  const remaining = Math.max(0, MAX_SUBSTITUTIONS_PER_SET - used - pairs.length)
  const pairedOut = new Set(pairs.map((p) => str(p.out)))
  const pairedIn = new Set(pairs.map((p) => str(p.in)))
  const onCourtNumbers = new Set(onCourt.map((p) => str(p.number)))
  for (const c of onCourt) {
    c.reason = c.isLibero
      ? 'libero'
      : pairedOut.has(str(c.number))
        ? 'paired'
        : entryWithoutCompletedRally(events, setIndex, team, c.number)
          ? 'no_rally_since_entry'
          : null
  }
  const benchPlayers = (players || []).filter((p) => str(p.number) !== '' && !onCourtNumbers.has(str(p.number)))
  const inReason = (out, p) => {
    if (pairedIn.has(str(p.number))) return 'paired'
    if (isLibero(p)) return 'libero'
    if (replacedByLibero.has(str(p.number))) return 'replaced_by_libero'
    return substituteInIllegalReason(events, setIndex, team, out, p.number, { isLibero: false, sentOff: isSentOff(events, team, p.number, setIndex) })
  }
  const candidatesFor = (out) => benchPlayers
    .map((p) => ({ number: Number(p.number), reason: inReason(out, p) }))
    .sort((a, b) => a.number - b.number)
  const pairIssue = (pair) => {
    const c = onCourt.find((p) => str(p.number) === str(pair.out))
    if (!c) return 'not_on_court'
    if (c.isLibero) return 'libero'
    if (entryWithoutCompletedRally(events, setIndex, team, pair.out)) return 'no_rally_since_entry'
    const p = findPlayer(pair.in)
    if (!p || onCourtNumbers.has(str(pair.in))) return 'not_on_bench'
    if (isLibero(p)) return 'libero'
    if (replacedByLibero.has(str(p.number))) return 'replaced_by_libero'
    return substituteInIllegalReason(events, setIndex, team, pair.out, pair.in, { sentOff: isSentOff(events, team, pair.in, setIndex) })
  }
  // FIVB 5.2: the court captain going off needs a game captain on court
  const captain = teamCaptainNumber(players)
  const courtCaptain = courtCaptainOf(events, setIndex, team, players)
  const after = new Set([...onCourt.filter((c) => !c.isLibero && !pairedOut.has(str(c.number))).map((c) => str(c.number)), ...pairedIn])
  // the team captain coming back on is the game captain again (5.1.2)
  const captainGoesOff = !!courtCaptain && pairedOut.has(courtCaptain) && !(captain && after.has(captain))
  const gameCaptainChoices = captainGoesOff ? [...after].sort((a, b) => Number(a) - Number(b)) : []
  return { onCourt, remaining, candidatesFor, pairIssue, captainGoesOff, gameCaptainChoices, used }
}

/**
 * Who leads the team on court now: the team captain when on court, else the
 * game captain the scorer recorded last in the set (court_captain_designation).
 */
export function courtCaptainOf(events, setIndex, team, players) {
  const lineup = latestLineup(events, setIndex, team) || {}
  const onCourt = new Set(Object.values(lineup).map((v) => str(lineupNumber(v))).filter(Boolean))
  const captain = teamCaptainNumber(players)
  if (captain && onCourt.has(captain)) return captain
  let gc = null
  for (const e of (events || [])) {
    if (e.type === 'court_captain_designation' && e.payload?.team === team && (e.setIndex ?? 1) <= setIndex) gc = e
  }
  const n = str(gc?.payload?.playerNumber)
  return n && onCourt.has(n) ? n : null
}

// ─────────────────────────── the bench's requests ───────────────────────────

/** Final states of a request on the bench (nothing more comes for it). */
export const FINAL_STATUSES = ['accepted', 'declined', 'cancelled', 'refused', 'not_sent']

/**
 * The bench's requests by id: { [id]: { id, kind, setIndex, status, reason?,
 * delivered?, request?, at } }. status: 'sending' (sent, no ack yet) |
 * 'pending' | 'seen' | 'accepted' | 'declined' | 'cancelled' | 'superseded'
 * | 'refused' (the relay said no: reason) | 'not_sent' (no connection).
 * Actions: sent, notSent, noAck (no answer in time), ack, refused, response,
 * state (after a reconnect).
 */
export function benchRequestsReducer(state, action) {
  const put = (id, patch) => ({ ...state, [id]: { ...(state[id] || { id }), ...patch } })
  switch (action.type) {
    case 'sent': {
      const r = action.request
      return put(r.id, { id: r.id, kind: r.kind, setIndex: r.setIndex, status: 'sending', reason: null, request: r, at: action.at ?? Date.now() })
    }
    case 'notSent': {
      const r = action.request
      return put(r.id, { id: r.id, kind: r.kind, setIndex: r.setIndex, status: 'not_sent', reason: action.reason || 'no_connection', request: r, at: action.at ?? Date.now() })
    }
    case 'ack': {
      const m = action.message
      let next = state
      for (const old of m.superseded || []) if (next[old]) next = { ...next, [old]: { ...next[old], status: 'superseded' } }
      if (m.cancelId && next[m.cancelId]) next = { ...next, [m.cancelId]: { ...next[m.cancelId], status: 'cancelled' } }
      if (m.status === 'cancelled') {
        const { [m.id]: _cancelRequest, ...rest } = next
        return rest
      }
      if (!next[m.id]) return next
      return { ...next, [m.id]: { ...next[m.id], status: next[m.id].status === 'sending' ? 'pending' : next[m.id].status, delivered: m.delivered } }
    }
    case 'noAck': {
      // sent on a socket that did not answer: not sent (a cancel just goes)
      const r = state[action.id]
      if (!r || r.status !== 'sending') return state
      if (r.kind === 'cancel') {
        const { [action.id]: _gone, ...rest } = state
        return rest
      }
      return put(action.id, { status: 'not_sent', reason: 'no_answer' })
    }
    case 'refused': {
      const m = action.message
      if (!m.id || !state[m.id]) return state
      if (state[m.id].kind === undefined) return state
      return put(m.id, { status: 'refused', reason: m.reason || null })
    }
    case 'response': {
      const m = action.message
      return put(m.id, { kind: state[m.id]?.kind ?? m.kind, setIndex: state[m.id]?.setIndex ?? m.setIndex, status: m.status, reason: m.reason || null })
    }
    case 'state': {
      // The relay's word after a (re)subscribe: its requests of this team
      let next = { ...state }
      const known = new Set()
      for (const r of action.message.requests || []) {
        known.add(r.id)
        next[r.id] = { ...(next[r.id] || {}), id: r.id, kind: r.kind, setIndex: r.setIndex, status: r.status, reason: r.reason || null }
      }
      // what the relay no longer holds (its set is over, or it was dropped) and was still open here
      for (const [id, r] of Object.entries(next)) {
        if (!known.has(id) && (r.status === 'pending' || r.status === 'seen' || r.status === 'sending')) next[id] = { ...r, status: 'expired' }
      }
      return next
    }
    default:
      return state
  }
}

/** The newest request of a kind (for a set), or null. */
export function latestBenchRequest(state, kind, setIndex = null) {
  let best = null
  for (const r of Object.values(state || {})) {
    if (r.kind !== kind || r.status === 'superseded' || r.status === 'expired') continue
    if (setIndex !== null && r.setIndex !== setIndex) continue
    if (!best || (r.at || 0) >= (best.at || 0)) best = r
  }
  return best
}

export const isOpenStatus = (s) => s === 'sending' || s === 'pending' || s === 'seen'

// ─────────────────────────── the scorer's queue ───────────────────────────

/**
 * The scorer's open bench requests: [{ team, request, status, at }], at most
 * one per team and kind (line-ups per set). Actions: the relay's
 * bench-request (a cancel removes), a bench-response another of the match's
 * scoreboards sent ('answered'), and 'answered' here.
 */
export function scorerQueueReducer(state, action) {
  switch (action.type) {
    case 'bench-request': {
      const { team, request } = action.message || {}
      if ((team !== 'home' && team !== 'away') || !request?.id || !request.kind) return state
      if (request.kind === 'cancel') return state.filter((e) => !(e.team === team && e.request.id === request.cancelId))
      const same = (e) => e.team === team && (e.request.id === request.id ||
        (e.request.kind === request.kind && (request.kind !== 'lineup' || e.request.setIndex === request.setIndex)))
      return [...state.filter((e) => !same(e)), { team, request, status: action.message.status || 'pending', at: action.message.at ?? Date.now() }]
    }
    case 'answered':
      return state.filter((e) => !(e.team === action.team && e.request.id === action.id))
    case 'prune':
      // a set that is over: its requests go
      return state.filter((e) => e.request.setIndex >= action.setIndex)
    default:
      return state
  }
}
