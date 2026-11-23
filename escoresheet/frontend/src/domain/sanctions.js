/**
 * Pure sanction-escalation rules (FIVB 2025-2028 Rules 15.11 + 16) — no React,
 * no Dexie, no I/O. Unit-tested; the Scoreboard wires its sanction UI to these
 * so the delay ladder and improper-request escalation can't be bypassed.
 *
 * DELAY LADDER (Rule 16.2): the FIRST delay by a team in the match is a Delay
 * Warning (no point). Every SUBSEQUENT delay by the same team in the match is a
 * Delay Penalty (a point + service to the opponent). Only one warning per team
 * per match.
 *
 * IMPROPER REQUEST (Rule 15.11): the first improper request by a team is rejected
 * and recorded with no other consequence. A further improper request by the same
 * team constitutes a delay, and is then handled under the delay ladder above.
 */

/**
 * The rule-correct delay sanction for a team, given how many delay sanctions
 * (warnings + penalties) it has ALREADY received in the match.
 * @param {number} priorDelayCount
 * @returns {'delay_warning'|'delay_penalty'}
 */
export function nextDelaySanction(priorDelayCount = 0) {
  return priorDelayCount >= 1 ? 'delay_penalty' : 'delay_warning'
}

/**
 * Resolve what actually happens when a team is flagged for an improper request,
 * given how many improper requests it has ALREADY made and its prior delay count.
 *  - 1st improper request  -> recorded as 'improper_request' (no other consequence)
 *  - 2nd+ improper request -> a DELAY, resolved through the delay ladder
 * @param {number} priorImproperCount improper requests already recorded for the team
 * @param {number} priorDelayCount delay sanctions already recorded for the team
 * @returns {'improper_request'|'delay_warning'|'delay_penalty'}
 */
export function improperRequestConsequence(priorImproperCount = 0, priorDelayCount = 0) {
  if (priorImproperCount >= 1) return nextDelaySanction(priorDelayCount)
  return 'improper_request'
}

/**
 * Resolve the effective sanction type from what the scorer requested + the team's
 * sanction history, enforcing the ladder. Delays auto-escalate warning->penalty;
 * a repeated improper request becomes a delay.
 * @param {'improper_request'|'delay_warning'|'delay_penalty'} requestedType
 * @param {{priorDelayCount?:number, priorImproperCount?:number}} history
 * @returns {'improper_request'|'delay_warning'|'delay_penalty'}
 */
export function resolveSanction(requestedType, { priorDelayCount = 0, priorImproperCount = 0 } = {}) {
  if (requestedType === 'delay_warning' || requestedType === 'delay_penalty') {
    return nextDelaySanction(priorDelayCount)
  }
  if (requestedType === 'improper_request') {
    return improperRequestConsequence(priorImproperCount, priorDelayCount)
  }
  return requestedType
}

/**
 * A team's sanction history for the ladder: the delay sanctions (warnings +
 * penalties) and improper requests it already has in the match.
 * @param {Array} events
 * @param {'home'|'away'} team
 * @returns {{priorDelayCount:number, priorImproperCount:number}}
 */
export function teamSanctionCounts(events, team) {
  const own = (events || []).filter(e => e?.type === 'sanction' && e.payload?.team === team)
  return {
    priorDelayCount: own.filter(e => isDelaySanction(e.payload?.type)).length,
    priorImproperCount: own.filter(e => e.payload?.type === 'improper_request').length
  }
}

/** True for the two delay-ladder sanction types. */
export function isDelaySanction(type) {
  return type === 'delay_warning' || type === 'delay_penalty'
}

/** True if this effective sanction awards a point to the opponent (Rule 16.2.3 / 21.3). */
export function awardsPoint(type) {
  return type === 'delay_penalty' || type === 'penalty'
}

/**
 * The misconduct penalty or delay penalty a point was awarded for, when the
 * two were written in one action: the point carries the sanction's seq
 * (payload.penaltySeq). Undo takes them back together; one Undo used to take
 * back only the point and leave the penalty on the scoresheet without it.
 * A penalty point awarded later with the starting line-ups carries it too
 * (deferredPenaltyPoints). Null for a rally's point and for points written
 * before the link (2026-10; owed points until 2026-11).
 * @param {Array} events
 * @param {object} point
 * @returns {object|null} the sanction event
 */
export function penaltyOfPoint(events, point) {
  const seq = point?.type === 'point' ? point.payload?.penaltySeq : undefined
  if (seq === undefined || seq === null) return null
  return (events || []).find(e =>
    e && e.type === 'sanction' && e.seq === seq && e.setIndex === point.setIndex &&
    awardsPoint(e.payload?.type) && e.payload?.team !== point.payload?.team
  ) || null
}

const timeOf = (e) => (typeof e?.ts === 'number' ? e.ts : Date.parse(e?.ts || 0) || 0)
// a after b in the log: by seq, by time for rows without one
const isAfter = (a, b) => {
  const as = a?.seq || 0
  const bs = b?.seq || 0
  if (as !== 0 || bs !== 0) return as > bs
  return timeOf(a) > timeOf(b)
}

/**
 * The point a misconduct penalty or a delay penalty gave the opponent: the
 * point that names it (payload.penaltySeq; a going back may have cancelled
 * it, then the cancelled_point), else, for a penalty written before the link
 * or added on the correction board, the opponent's next point in its set
 * that names no other penalty. One rule for the sheet's circled point
 * (scoresheet_pdf setModel), the corrections and their check (audit LOG-05).
 * @param {Array} events
 * @param {object} sanction the sanction event
 * @returns {object|null} the point (or cancelled_point) event
 */
export function pointOfPenalty(events, sanction) {
  if (sanction?.type !== 'sanction' || !awardsPoint(sanction.payload?.type)) return null
  const team = sanction.payload?.team
  const opponent = team === 'home' ? 'away' : team === 'away' ? 'home' : null
  if (!opponent) return null
  const setIndex = sanction.setIndex ?? 1
  const inSet = (events || []).filter(e => e && (e.setIndex ?? 1) === setIndex)
  const linked = inSet.find(e => (e.type === 'point' || e.type === 'cancelled_point') &&
    e.payload?.penaltySeq != null && e.payload.penaltySeq === sanction.seq && e.payload?.team === opponent)
  if (linked) return linked
  let next = null
  for (const e of inSet) {
    if (e.type !== 'point' || e.payload?.team !== opponent || !isAfter(e, sanction) || penaltyOfPoint(events, e)) continue
    if (!next || isAfter(next, e)) next = e
  }
  return next
}

/**
 * The team-sanction flags shown on the scoreboard (match.sanctions), derived
 * from the sanction events — the single source of truth. The flags used to be
 * set once when the sanction was given and never cleared, so an undone or
 * deleted warning left the Improper Request button hidden and the Delay button
 * on "penalty".
 *  - improperRequest{Home,Away}: the team has an improper request on record
 *  - delayWarning{Home,Away}: the team has a delay sanction on record (its next
 *    delay is a penalty)
 * @param {Array} events
 * @returns {{improperRequestHome:boolean, improperRequestAway:boolean, delayWarningHome:boolean, delayWarningAway:boolean}}
 */
export function deriveTeamSanctionFlags(events) {
  const has = (team, pred) => (events || []).some(e =>
    e.type === 'sanction' && e.payload?.team === team && pred(e.payload?.type)
  )
  return {
    improperRequestHome: has('home', t => t === 'improper_request'),
    improperRequestAway: has('away', t => t === 'improper_request'),
    delayWarningHome: has('home', isDelaySanction),
    delayWarningAway: has('away', isDelaySanction)
  }
}

/**
 * Penalty points still owed at the start of a set. A misconduct penalty or a
 * delay penalty gives the opponent a point and the service (FIVB 21.3.1,
 * 16.2.3); one given before both starting line-ups of the set are in is
 * recorded first and its point awarded once the second line-up is saved.
 * Due only when both teams have a starting (isInitial) line-up in the set and
 * the set has no point yet (otherwise the points were already given).
 * @param {Array} events all events, INCLUDING the line-up just saved
 * @param {number} setIndex
 * @returns {Array<{ team: 'home'|'away', penaltySeq: number }>} the team to
 *   receive each point and the seq of its sanction (the point's penaltySeq:
 *   Undo takes the two back together), in sanction order
 */
export function deferredPenaltyPoints(events, setIndex) {
  const inSet = (events || []).filter(e => e && e.setIndex === setIndex)
  const hasStartingLineup = (team) => inSet.some(e => e.type === 'lineup' && e.payload?.team === team && e.payload?.isInitial)
  if (!hasStartingLineup('home') || !hasStartingLineup('away')) return []
  if (inSet.some(e => e.type === 'point')) return []
  return inSet
    .filter(e => e.type === 'sanction' && awardsPoint(e.payload?.type) && (e.payload?.team === 'home' || e.payload?.team === 'away'))
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .map(e => ({ team: e.payload.team === 'home' ? 'away' : 'home', penaltySeq: e.seq }))
}

const hasNumber = (n) => n !== undefined && n !== null && n !== '' && n !== '?'

/**
 * The misconduct sanctions of a team member, lightest first: the sanctioning
 * scale (FIVB 21.3). Delays and improper requests are team sanctions and
 * have their own ladder (resolveSanction).
 */
export const MEMBER_SANCTION_SCALE = ['warning', 'penalty', 'expulsion', 'disqualification']

const scaleLevel = (type) => MEMBER_SANCTION_SCALE.indexOf(type)

/**
 * The shirt number a misconduct sanction counts against: the player's own,
 * or for a team official who also plays (a playing coach,
 * domain/playerOfficials) the number recorded with it (`plays`). An
 * expulsion or disqualification of the coach keeps #7 off the court too.
 * Null for an official who does not play and for a team sanction.
 * @param {object} payload a sanction event's payload
 * @returns {any|null}
 */
export function sanctionedPlayerNumber(payload) {
  if (hasNumber(payload?.playerNumber)) return payload.playerNumber
  if (hasNumber(payload?.plays) && payload.plays !== false) return payload.plays
  return null
}

/**
 * The member's misconduct sanctions among the events: a player by number, an
 * official by role. One person in two roles (domain/playerOfficials
 * sanctionMember) is one member: a player with `alsoRoles` (the official
 * roles he holds) also has those roles' sanctions, an official with `plays`
 * (the number he plays with) also that number's; an official's sanction that
 * recorded the number (`plays`) is that player's too.
 */
function memberSanctions(events, { team, playerNumber, role, plays, alsoRoles } = {}) {
  const numbers = new Set()
  const roles = new Set()
  if (hasNumber(playerNumber)) {
    numbers.add(String(playerNumber))
    for (const r of alsoRoles || []) if (r) roles.add(r)
  } else if (role) {
    roles.add(role)
    if (hasNumber(plays) && plays !== false) numbers.add(String(plays))
  }
  const sameMember = (e) => {
    const p = e.payload || {}
    if (hasNumber(p.playerNumber)) return numbers.has(String(p.playerNumber))
    return (!!p.role && roles.has(p.role)) || (hasNumber(p.plays) && p.plays !== false && numbers.has(String(p.plays)))
  }
  return (events || []).filter(e => e?.type === 'sanction' && e.payload?.team === team && sameMember(e))
}

/**
 * The heaviest misconduct sanction a team member (player, libero or bench
 * official; a playing coach in both roles) has in the match, or null.
 * @param {Array} events
 * @param {{team:'home'|'away', playerNumber?:any, role?:string, plays?:any, alsoRoles?:string[]}} member
 * @returns {'warning'|'penalty'|'expulsion'|'disqualification'|null}
 */
export function heaviestMemberSanction(events, member) {
  let level = -1
  for (const e of memberSanctions(events, member)) level = Math.max(level, scaleLevel(e.payload?.type))
  return level >= 0 ? MEMBER_SANCTION_SCALE[level] : null
}

/**
 * Misconduct checks for one team member (player, libero or official), the
 * rules the live sanction flow applies (Scoreboard confirmPlayerSanction and
 * its sanction menus):
 *  - a member cannot receive the same sanction type twice in the match;
 *    a player who is also a team official (a playing coach) is one member
 *    in both roles (memberSanctions: `alsoRoles`, `plays`);
 *  - repeated misconduct of the same member in the match is sanctioned
 *    progressively (FIVB 21.4.2): a member's next sanction must be heavier
 *    than his heaviest earlier one (warning < penalty < expulsion <
 *    disqualification; an expulsion or disqualification needs no earlier
 *    sanction, 21.4.3);
 *  - a (formal) warning cannot be given once the team has been warned —
 *    only one warning per team per match (FIVB 21.1 / 21.3.1): the next
 *    minor misconduct of any member is a penalty, which the menus offer.
 * Delays and improper requests are team sanctions and are not checked here
 * (resolveSanction does).
 * Live entry BLOCKS what this refuses (owner decision 12, 23.11.2026: the
 * blocks stay, and follow the FIVB scale exactly; the table of cases is
 * domain/__tests__/sanctions.scale.test.js). The corrections record what the
 * referee decided and only warn (manualCorrections, recompute).
 * @param {Array} priorEvents events BEFORE the sanction (any set of the match)
 * @param {{team:'home'|'away', playerNumber?:any, role?:string, plays?:any, alsoRoles?:string[], type:string}} sanction
 * @returns {{legal:boolean, reason?:'sameSanctionTwice'|'lighterSanction'|'teamAlreadyWarned', heaviest?:string}}
 *   heaviest: with 'lighterSanction', the member's heaviest earlier sanction
 */
export function validateMemberSanction(priorEvents, { type, ...member } = {}) {
  const own = memberSanctions(priorEvents, member)
  if (own.some(e => e.payload?.type === type)) {
    return { legal: false, reason: 'sameSanctionTwice' }
  }
  const heaviest = heaviestMemberSanction(own, member)
  if (heaviest && scaleLevel(type) >= 0 && scaleLevel(type) < scaleLevel(heaviest)) {
    return { legal: false, reason: 'lighterSanction', heaviest }
  }
  if (type === 'warning' && (priorEvents || []).some(e => e?.type === 'sanction' && e.payload?.team === member.team && e.payload?.type === 'warning')) {
    return { legal: false, reason: 'teamAlreadyWarned' }
  }
  return { legal: true }
}

/**
 * The misconduct sanctions the scorer's menus offer a team member now, in
 * scale order, each with validateMemberSanction's verdict: the court
 * player, bench player and sanction menus (the phone's too) all read it.
 * @param {Array} events all events of the match so far
 * @param {{team:'home'|'away', playerNumber?:any, role?:string, plays?:any, alsoRoles?:string[]}} member
 * @returns {Record<'warning'|'penalty'|'expulsion'|'disqualification', {legal:boolean, reason?:string}>}
 */
export function memberSanctionOptions(events, member) {
  return Object.fromEntries(MEMBER_SANCTION_SCALE.map(type => [type, validateMemberSanction(events, { ...member, type })]))
}

/**
 * Is the member out now: 'disqualified' (any set, for the match), 'expelled'
 * (in `setIndex`, for the set), else null (FIVB 21.3.2-21.3.3). A playing
 * coach in either role (memberSanctions): expelled as #7 he is out as the
 * coach for the set too, disqualified as the coach out as #7 for the match.
 * @param {Array} events
 * @param {{team:'home'|'away', playerNumber?:any, role?:string, plays?:any, alsoRoles?:string[]}} member
 * @param {number} setIndex the set being played
 * @returns {'disqualified'|'expelled'|null}
 */
export function memberSentOff(events, member, setIndex) {
  const own = memberSanctions(events, member)
  if (own.some(e => e.payload?.type === 'disqualification')) return 'disqualified'
  if (own.some(e => e.payload?.type === 'expulsion' && (e.setIndex ?? 1) === setIndex)) return 'expelled'
  return null
}
