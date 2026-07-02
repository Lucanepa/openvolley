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

/** True for the two delay-ladder sanction types. */
export function isDelaySanction(type) {
  return type === 'delay_warning' || type === 'delay_penalty'
}

/** True if this effective sanction awards a point to the opponent (Rule 16.2.3 / 21.3). */
export function awardsPoint(type) {
  return type === 'delay_penalty' || type === 'penalty'
}
