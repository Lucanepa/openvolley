/**
 * Game-interruption requests (time-outs and substitutions) and when the
 * scorer has to be warned about one (FIVB 2025-2028 Rules 15, 15.2, 15.11,
 * 16.1; FIVB Casebook 2025 ch. 4; FIVB Refereeing Guidelines 2025). Pure: no
 * React, no Dexie. The Scoreboard (tablet and phone layouts) asks these
 * functions before it opens a time-out or substitution dialog.
 *
 * Terms (spec 2026-11-09, table B):
 *  - Completed rally: a `point` event of the set. A penalty point (delay
 *    penalty, misconduct penalty) is one too (CB 4.23, 4.25).
 *  - Interruption: everything after the set's latest point (R15: "the time
 *    between one completed rally and the 1st referee's whistle for the next
 *    service"). A rally that was started and then replayed does NOT end it:
 *    a request after the replay is a second request (CB 4.4).
 *  - Replay pending: the set's latest `replay` is newer than its latest
 *    point. No regular request is allowed then, only a forced substitution
 *    (GL R15 §8, CB 4.3, SSK Q264, Q194, Q178): it is rejected with no record.
 *  - Forced substitution: injury, expulsion, disqualification or an
 *    exceptional substitution. It neither opens nor closes a request
 *    (R15.2.3, R15.7, CB 4.9).
 *  - Same request: substitutions of a team recorded back to back, with only
 *    their lineup sub-events or libero events between them (R15.2.2, Q31).
 *
 * The owner's decisions (2026-11-09): a replay is a hard block (no improper
 * request); a time-out at 0:0 before the first service is allowed with no
 * warning; "Continue anyway" records nothing; 6 substitutions per set.
 * An improper request or a delay keeps no reason ("no reason, no need, same
 * for delays"): old events with payload.reason load and read as before.
 */

import { MAX_SUBSTITUTIONS_PER_SET, countRegularSubstitutions } from './substitutions'
import { TIMEOUTS_PER_SET } from './timeouts'
import { resolveSanction, teamSanctionCounts } from './sanctions'

const setOf = (e) => e?.setIndex ?? 1
const seqOf = (e) => e?.seq || 0

/** The events of one set, oldest first (by seq). */
export function setEventsInOrder(events, setIndex) {
  return (events || []).filter(e => e && setOf(e) === setIndex).sort((a, b) => seqOf(a) - seqOf(b))
}

/** True for a forced substitution: injury, expulsion, disqualification, exceptional. */
export function isForcedSubstitution(request) {
  const p = request?.payload ?? request
  return !!(p?.isInjury || p?.isExpelled || p?.isDisqualified || p?.isExceptional)
}

/** The seq of the set's latest completed rally (a point, penalty points too), or -Infinity. */
export function lastCompletedRallySeq(events, setIndex) {
  let last = -Infinity
  for (const e of events || []) {
    if (e?.type === 'point' && setOf(e) === setIndex && seqOf(e) > last) last = seqOf(e)
  }
  return last
}

/**
 * The events of the current interruption: everything after the set's latest
 * point, oldest first. At the start of a set (no point yet) the whole set.
 */
export function interruptionEvents(events, setIndex) {
  const since = lastCompletedRallySeq(events, setIndex)
  return setEventsInOrder(events, setIndex).filter(e => seqOf(e) > since)
}

/**
 * True while a replayed rally has not been followed by a completed rally:
 * the set's latest `replay` (the in-play replay, or the decision change
 * "replay the rally", which removes the point) is newer than its latest
 * point. Any other event after the replay (a delay warning, a forced
 * substitution, a remark) does not change that.
 */
export function isReplayPending(events, setIndex) {
  let lastReplay = -Infinity
  for (const e of events || []) {
    if (e?.type === 'replay' && setOf(e) === setIndex && seqOf(e) > lastReplay) lastReplay = seqOf(e)
  }
  return lastReplay > lastCompletedRallySeq(events, setIndex)
}

/**
 * Does `e` end a team's substitution request? Everything that is another
 * request, a sanction or a rally does; the team's own lineup sub-events,
 * libero events (either team), forced substitutions, remarks and other
 * bookkeeping do not.
 */
function separatesRequests(e, team) {
  switch (e?.type) {
    case 'timeout':
    case 'sanction':
    case 'rally_start':
    case 'replay':
      return true
    case 'substitution':
      return e.payload?.team !== team && !isForcedSubstitution(e)
    default:
      return false
  }
}

/**
 * The team's regular substitution request in the current interruption, if
 * it has made one: its first and last substitution and whether that request
 * is closed (something else came between it and now, so a further
 * substitution would be a second request).
 * @returns {null | { firstSeq:number, lastSeq:number, closed:boolean, closedBy:object|null }}
 */
export function substitutionRequestThisInterruption(events, setIndex, team) {
  const window = interruptionEvents(events, setIndex)
  const regular = window.filter(e => e.type === 'substitution' && e.payload?.team === team && !isForcedSubstitution(e))
  if (regular.length === 0) return null
  const first = regular[0]
  const last = regular[regular.length - 1]
  const closedBy = window.find(e => seqOf(e) > seqOf(last) && separatesRequests(e, team)) || null
  return { firstSeq: seqOf(first), lastSeq: seqOf(last), closed: !!closedBy, closedBy }
}

/**
 * True when a regular substitution by `team` now would be a second request
 * in the same interruption (R15.2.3, 15.11.1.3; CB 4.28, Q160, Q122).
 */
export function isSecondSubstitutionRequest(events, setIndex, team) {
  return !!substitutionRequestThisInterruption(events, setIndex, team)?.closed
}

/**
 * True when `team` was given a delay warning in the current interruption: a
 * further request is rejected with nothing recorded (R15.2.4, CB 4.30.1,
 * Q94). A delay penalty gives a point, so the interruption is over then.
 */
export function delayWarnedThisInterruption(events, setIndex, team) {
  return interruptionEvents(events, setIndex).some(e =>
    e.type === 'sanction' && e.payload?.team === team && e.payload?.type === 'delay_warning'
  )
}

/**
 * The substitution that brought `playerNumber` in, when no rally has been
 * completed since (he cannot go out again yet, R15.2.3 / 15.6.2), else null.
 */
export function entryWithoutCompletedRally(events, setIndex, team, playerNumber) {
  const entries = setEventsInOrder(events, setIndex).filter(e =>
    e.type === 'substitution' && e.payload?.team === team && String(e.payload?.playerIn) === String(playerNumber)
  )
  const entry = entries[entries.length - 1]
  if (!entry) return null
  return lastCompletedRallySeq(events, setIndex) > seqOf(entry) ? null : entry
}

/**
 * What a warning offers (the dialog's buttons, in order):
 *  improper   record an improper request (FIVB 15.11.2/15.11.3 ladder)
 *  delay      the game was delayed: a delay sanction (16.1, 16.2 ladder)
 *  timeoutStarted the 3rd time-out was already granted: a delay sanction (CB 4.29, Q40)
 *  illegal    an illegal substitution was requested: reject + delay sanction (16.1.3)
 *  continue   go on with the request; nothing is recorded
 *  cancel     nothing happens
 */
export const REQUEST_ISSUES = {
  set_interval: { kind: 'block', rule: '18.1', options: [] },
  replay_pending: { kind: 'block', rule: '15', options: [] },
  after_delay_warning: { kind: 'notice', rule: '15.2.4', options: ['cancel', 'continue'] },
  substitution_limit: { kind: 'warn', rule: '15.11.1.4', options: ['improper', 'delay', 'cancel'] },
  third_timeout: { kind: 'warn', rule: '15.11.1.4', options: ['improper', 'timeoutStarted', 'cancel'] },
  second_substitution_request: { kind: 'warn', rule: '15.2.3', options: ['improper', 'delay', 'cancel', 'continue'] },
  no_rally_since_entry: { kind: 'warn', rule: '15.2.3', options: ['improper', 'delay', 'cancel', 'continue'] },
  illegal_substitution: { kind: 'warn', rule: '16.1.3', options: ['illegal', 'cancel'] }
}

const issue = (reason, extra = {}) => ({ reason, ...REQUEST_ISSUES[reason], ...extra })

/**
 * Everything to tell the scorer about a substitution request by `team`, most
 * serious first. Empty: go ahead. A 'block' issue stops the request (the
 * button is disabled); otherwise the dialog shows the first issue and
 * "Continue anyway" moves on to the next one.
 *
 * A forced substitution (injury, expulsion, disqualification, exceptional)
 * has no issues: it must be made, whatever came before.
 *
 * @param {Array} events all match events
 * @param {number} setIndex
 * @param {'home'|'away'} team
 * @param {{isInjury?:boolean,isExpelled?:boolean,isDisqualified?:boolean,isExceptional?:boolean,playerOut?:any}} [request]
 * @param {{maxPerSet?:number}} [opts]
 * @returns {Array<{reason:string, kind:'block'|'notice'|'warn', rule:string, options:string[], playerIn?:any}>}
 */
export function substitutionRequestIssues(events, setIndex, team, request = {}, { maxPerSet = MAX_SUBSTITUTIONS_PER_SET } = {}) {
  if (isForcedSubstitution(request)) return []
  if (isReplayPending(events, setIndex)) return [issue('replay_pending')]
  const issues = []
  if (delayWarnedThisInterruption(events, setIndex, team)) issues.push(issue('after_delay_warning'))
  if (countRegularSubstitutions(events, team, setIndex) >= maxPerSet) {
    issues.push(issue('substitution_limit'))
    return issues // a limit warning has no "Continue anyway": nothing after it
  }
  const entry = request?.playerOut !== undefined && request?.playerOut !== null
    ? entryWithoutCompletedRally(events, setIndex, team, request.playerOut)
    : null
  if (entry) {
    issues.push(issue('no_rally_since_entry', { playerIn: entry.payload?.playerOut }))
  } else if (isSecondSubstitutionRequest(events, setIndex, team)) {
    issues.push(issue('second_substitution_request'))
  }
  return issues
}

/**
 * Everything to tell the scorer about a time-out request by `team`, most
 * serious first (see substitutionRequestIssues).
 *  - set interval: not an interruption, it would count in the next set (R15, 18.1);
 *  - replay pending: no time-out (Q194, Q178);
 *  - after a delay warning in this interruption: reject, nothing recorded (15.2.4);
 *  - a 3rd time-out: an improper request (15.11.1.4), or a delay when it was
 *    already granted (CB 4.29, Q40).
 * A time-out at 0:0 before the first service is allowed (owner 2026-11-09);
 * a second time-out in the same interruption is legal (15.2.1, Q161).
 * @param {{intervalRunning?:boolean, perSet?:number}} [opts]
 */
export function timeoutRequestIssues(events, setIndex, team, { intervalRunning = false, perSet = TIMEOUTS_PER_SET } = {}) {
  if (intervalRunning) return [issue('set_interval')]
  if (isReplayPending(events, setIndex)) return [issue('replay_pending')]
  const issues = []
  if (delayWarnedThisInterruption(events, setIndex, team)) issues.push(issue('after_delay_warning'))
  const used = (events || []).filter(e => e?.type === 'timeout' && e.payload?.team === team && setOf(e) === setIndex).length
  if (used >= perSet) issues.push(issue('third_timeout'))
  return issues
}

/**
 * Why a team's regular time-out or substitution button is disabled now, or
 * null when it is open: 'replay_pending' or (time-outs) 'set_interval'.
 * @param {'timeout'|'substitution'} kind
 */
export function requestBlockReason(events, setIndex, team, kind, { intervalRunning = false } = {}) {
  const issues = kind === 'timeout'
    ? timeoutRequestIssues(events, setIndex, team, { intervalRunning })
    : substitutionRequestIssues(events, setIndex, team)
  return issues[0]?.kind === 'block' ? issues[0].reason : null
}

/**
 * Why a bench player may not come in for `playerOut` in a regular
 * substitution (R15.6, 15.7, 15.8, 19.3.1.3), or null when he may. An
 * illegal substitution requested is a delay sanction, not an improper
 * request (R16.1.3, CB 4.15, Q72):
 *  - 'libero': a libero is never substituted in;
 *  - 'sent_off': expelled this set, disqualified, or left exceptionally (`blocked`);
 *  - 'wrong_partner': the player came out for someone else, or `playerOut`
 *    came in for someone else (the starter-substitute pairing, 15.6.2);
 *  - 'played_out': he already entered and left this set (once per set);
 *  - 'no_rally_since_out': he went out with no completed rally since.
 * @param {{isLibero?:boolean, sentOff?:boolean}} [player]
 */
export function substituteInIllegalReason(events, setIndex, team, playerOut, playerIn, { isLibero = false, sentOff = false } = {}) {
  if (isLibero) return 'libero'
  if (sentOff) return 'sent_off'
  const subs = setEventsInOrder(events, setIndex).filter(e => e.type === 'substitution' && e.payload?.team === team)
  const same = (a, b) => String(a) === String(b)
  // playerOut came on as a substitute: only the starter he replaced may return for him
  const outEntry = [...subs].reverse().find(s => same(s.payload?.playerIn, playerOut))
  if (outEntry && !same(outEntry.payload?.playerOut, playerIn)) return 'wrong_partner'
  const inEntries = subs.filter(s => same(s.payload?.playerIn, playerIn))
  const inExits = subs.filter(s => same(s.payload?.playerOut, playerIn))
  if (inEntries.length > 0) return 'played_out' // he came in this set and is back on the bench
  if (inExits.length > 0) {
    const exit = inExits[inExits.length - 1]
    if (!same(exit.payload?.playerIn, playerOut)) return 'wrong_partner'
    if (lastCompletedRallySeq(events, setIndex) < seqOf(exit)) return 'no_rally_since_out'
  }
  return null
}

// ───────────── a late request stopped the rally (row 10) ─────────────

/**
 * A request made during the rally or at or after the whistle to serve
 * (R15.11.1.1) that made the referees stop the rally: the game was delayed,
 * so it is a delay sanction, not an improper request (Q182, Q224, Q159; the
 * first late request that stopped nothing is an improper request recorded
 * after the rally, CB 4.20, Q191). What the scorer's "Replay rally" records
 * for it, through the delay ladder (16.2):
 *  - delay warning: the rally is replayed (a `replay`), and while it waits
 *    no regular request is allowed (row 7, isReplayPending);
 *  - delay penalty: no replay; the penalty gives the point and the service
 *    to the opponent (16.2.3), and that point is the completed rally.
 * @param {Array} events all match events
 * @param {'home'|'away'} team the team that made the late request
 * @returns {{ sanction: 'delay_warning'|'delay_penalty', replay: boolean }}
 */
export function lateRequestOutcome(events, team) {
  const sanction = resolveSanction('delay_warning', teamSanctionCounts(events, team))
  return { sanction, replay: sanction !== 'delay_penalty' }
}

// ───────────── decision change after a substitution or time-out (row 19) ─────────────

const baseSeqOf = (e) => Math.floor(seqOf(e))

/**
 * The requests to take back before a decision change on the set's last point,
 * when time-outs or substitutions were recorded after it: the referee
 * reverses his decision after a team asked for a time-out or substitution
 * because of it. The substitution is reversed and not counted (FIVB casebook
 * 8.5, Q5, Q169); a time-out taken because of the reversed decision is
 * cancelled (SSK News 26-1). The scorer then no longer has to Undo them first.
 *
 * Offered only when everything recorded after the point is a regular
 * substitution (with its own line-up rows, N.x) or a time-out. A forced
 * substitution (an injured or sanctioned player must be replaced whatever
 * the decision), a libero replacement, a sanction, a started rally or
 * anything else after the point: null (Undo, as before).
 *
 * @param {Array} events all match events
 * @param {number} setIndex
 * @returns {null | { point: object, requests: Array }} requests: the time-out and
 *   substitution events to take back, newest first (the order Undo takes them)
 */
export function decisionChangeTakeBack(events, setIndex) {
  const inSet = setEventsInOrder(events, setIndex)
  const lastPointSeq = lastCompletedRallySeq(events, setIndex)
  if (lastPointSeq === -Infinity) return null
  const point = inSet.find(e => e.type === 'point' && seqOf(e) === lastPointSeq)
  if (!point) return null
  const after = inSet.filter(e => baseSeqOf(e) > baseSeqOf(point))
  if (after.length === 0) return null
  const heads = after.filter(e => seqOf(e) === baseSeqOf(e))
  const isRequest = (e) => e.type === 'timeout' || (e.type === 'substitution' && !isForcedSubstitution(e))
  if (heads.length === 0 || !heads.every(isRequest)) return null
  // the rows written with a request: a substitution's own line-up (N.x)
  const headOf = new Map(heads.map(h => [baseSeqOf(h), h]))
  const ownRow = (e) => {
    const head = headOf.get(baseSeqOf(e))
    return !!head && e.type === 'lineup' && head.type === 'substitution' && e.payload?.team === head.payload?.team
  }
  if (!after.every(e => headOf.get(baseSeqOf(e)) === e || ownRow(e))) return null
  return { point, requests: [...heads].sort((a, b) => seqOf(b) - seqOf(a)) }
}
