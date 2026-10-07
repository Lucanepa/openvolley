/**
 * Pure substitution-legality checks (FIVB 2025-2028 Rule 15.5-15.6) computable
 * from the event history alone — no React, no Dexie. Used to validate manual
 * substitution entries (ManualAdjustments) which previously wrote raw events with
 * no checks, permitting a 7th sub, an illegal reverse pairing, or re-entering a
 * completed-cycle player.
 *
 * SENIOR 6-6 scope: max 6 regular substitutions per set (exceptional ones are
 * beyond the limit, see classifySubstitutionRequest). Each player may enter (playerIn)
 * at most once and be substituted out (playerOut) at most once per set; a player
 * who came on as a substitute may only be replaced by the starter he came in for
 * (one-in/one-out pairing, once per set).
 *
 * This is a subset of the full live-engine legality (it does not resolve libero
 * replacements or the rally-between-requests timing), but it closes the manual
 * corrections holes the audit flagged.
 */

/** Substitutions already recorded for a team in a set. */
export function getSetSubstitutions(events, teamKey, setIndex) {
  return (events || []).filter(e =>
    e.type === 'substitution' &&
    e.payload?.team === teamKey &&
    (e.setIndex ?? 1) === setIndex
  )
}

/** Max regular substitutions per team per set (FIVB 15.6, Swiss Volley senior 6-6). */
export const MAX_SUBSTITUTIONS_PER_SET = 6

/**
 * Regular substitutions a team has made in a set. Exceptional substitutions
 * (FIVB 15.7 / 15.8: injury, expulsion or disqualification when no legal one is
 * possible) are made beyond the limit and do not use one of the 6. Libero
 * replacements are other event types and never count.
 */
export function countRegularSubstitutions(events, teamKey, setIndex) {
  return getSetSubstitutions(events, teamKey, setIndex).filter(e => !e.payload?.isExceptional).length
}

/** True while the team still has a regular substitution left in the set. */
export function canMakeRegularSubstitution(events, teamKey, setIndex, { maxPerSet = MAX_SUBSTITUTIONS_PER_SET } = {}) {
  return countRegularSubstitutions(events, teamKey, setIndex) < maxPerSet
}

/**
 * How a substitution request has to be handled, from the count alone:
 *  - 'exceptional' when it is flagged exceptional, or when it replaces an
 *    injured / expelled / disqualified player and no regular substitution is
 *    left (FIVB 15.7, 15.8);
 *  - 'regular' while the team has a regular substitution left;
 *  - 'improper_request' otherwise: a request beyond the limit (FIVB 16.1.3).
 * @param {{isExceptional?: boolean, isInjury?: boolean, isExpelled?: boolean, isDisqualified?: boolean}} request
 * @returns {'regular'|'exceptional'|'improper_request'}
 */
export function classifySubstitutionRequest(events, teamKey, setIndex, request = {}, { maxPerSet = MAX_SUBSTITUTIONS_PER_SET } = {}) {
  if (request?.isExceptional) return 'exceptional'
  if (canMakeRegularSubstitution(events, teamKey, setIndex, { maxPerSet })) return 'regular'
  if (request?.isInjury || request?.isExpelled || request?.isDisqualified) return 'exceptional'
  return 'improper_request'
}

/**
 * Validate a proposed substitution against the set's history.
 * @returns {{legal: boolean, reason?: string}}
 */
export function validateManualSubstitution(events, teamKey, setIndex, playerOut, playerIn, { maxPerSet = MAX_SUBSTITUTIONS_PER_SET } = {}) {
  const out = Number(playerOut)
  const inn = Number(playerIn)
  if (!out || !inn) return { legal: false, reason: 'Select both the player going out and the player coming in.' }
  if (out === inn) return { legal: false, reason: 'A player cannot be substituted for themselves.' }

  const subs = getSetSubstitutions(events, teamKey, setIndex)
  if (!canMakeRegularSubstitution(events, teamKey, setIndex, { maxPerSet })) return { legal: false, reason: `Substitution limit reached (${maxPerSet} per set).` }

  // A player may be substituted in at most once per set.
  if (subs.some(s => Number(s.payload?.playerIn) === inn)) {
    return { legal: false, reason: `#${inn} has already been substituted in this set.` }
  }
  // A player may be substituted out at most once per set.
  if (subs.some(s => Number(s.payload?.playerOut) === out)) {
    return { legal: false, reason: `#${out} has already been substituted out this set.` }
  }
  // Reverse pairing: if the player going out came on earlier as a substitute, only
  // the starter he replaced may come back in for him (FIVB 15.6.2).
  const cameOnAs = subs.find(s => Number(s.payload?.playerIn) === out)
  if (cameOnAs && Number(cameOnAs.payload?.playerOut) !== inn) {
    return { legal: false, reason: `#${out} came on for #${cameOnAs.payload?.playerOut}; only that player may return for him.` }
  }

  return { legal: true }
}

/**
 * Plan the event changes that remove ONE substitution from the record (manual
 * correction). The live engine stores the substitution's lineup as a sub-event
 * of it (seq N.x with fromSubstitution), so that is the lineup to delete — not
 * "the team's latest lineup", which may belong to a later rotation, substitution
 * or libero replacement. Every later lineup / libero event of that team in the
 * set is then corrected by player NUMBER (the substitute is replaced by the
 * player he came on for, wherever rotations have moved him), not by the
 * position recorded at substitution time.
 *
 * Refused when a later substitution of that team in the set involves either
 * player (e.g. the return substitution): removing only the first would leave
 * the record inconsistent; the later one has to be deleted first.
 *
 * @param {Array} events all events of the match
 * @param {object} subEvent the substitution event to delete
 * @returns {{blocked: true, reason: string} | {blocked: false, deleteIds: Array, updates: Array<{id:any, payload:object}>}}
 */
export function planSubstitutionDeletion(events, subEvent) {
  const team = subEvent?.payload?.team
  const setIndex = subEvent?.setIndex ?? 1
  const seq = subEvent?.seq || 0
  const baseSeq = Math.floor(seq)
  const playerIn = String(subEvent?.payload?.playerIn)
  const playerOut = subEvent?.payload?.playerOut

  const later = (events || []).filter(e =>
    e.id !== subEvent.id &&
    e.payload?.team === team &&
    (e.setIndex ?? 1) === setIndex &&
    (e.seq || 0) > seq
  )

  const involved = (n) => n !== undefined && n !== null && (String(n) === playerIn || String(n) === String(playerOut))
  const conflicting = later.find(e =>
    e.type === 'substitution' && (involved(e.payload?.playerIn) || involved(e.payload?.playerOut))
  )
  if (conflicting) {
    return {
      blocked: true,
      reason: `#${playerOut} / #${playerIn} take part in a later substitution (#${conflicting.payload?.playerOut} -> #${conflicting.payload?.playerIn}). Delete that one first.`
    }
  }

  // Keep the stored value's type (numbers vs strings) when swapping numbers back.
  const restore = (value) => (typeof value === 'number' ? Number(playerOut) : String(playerOut))
  const deleteIds = [subEvent.id]
  const updates = []

  for (const e of later) {
    if (e.type === 'lineup') {
      if (Math.floor(e.seq || 0) === baseSeq && e.payload?.fromSubstitution) {
        deleteIds.push(e.id) // the lineup this substitution created
        continue
      }
      let changed = false
      const lineup = { ...(e.payload?.lineup || {}) }
      for (const pos of Object.keys(lineup)) {
        if (String(lineup[pos]) === playerIn) { lineup[pos] = restore(lineup[pos]); changed = true }
      }
      const payload = { ...e.payload, lineup }
      const ls = e.payload?.liberoSubstitution
      if (ls && String(ls.playerNumber) === playerIn) {
        payload.liberoSubstitution = { ...ls, playerNumber: restore(ls.playerNumber) }
        changed = true
      }
      if (changed) updates.push({ id: e.id, payload })
    } else if (e.type === 'libero_entry' && String(e.payload?.playerOut) === playerIn) {
      updates.push({ id: e.id, payload: { ...e.payload, playerOut: restore(e.payload.playerOut) } })
    } else if (e.type === 'libero_exit' && String(e.payload?.playerIn) === playerIn) {
      updates.push({ id: e.id, payload: { ...e.payload, playerIn: restore(e.payload.playerIn) } })
    }
  }

  return { blocked: false, deleteIds, updates }
}

/**
 * Validate a manually added timeout: max 2 regular timeouts per team per set
 * (FIVB 15.4.1), the same limit the live Scoreboard enforces.
 * @returns {{legal: boolean, reason?: string}}
 */
export function validateManualTimeout(events, teamKey, setIndex, { maxPerSet = 2 } = {}) {
  const used = (events || []).filter(e =>
    e.type === 'timeout' &&
    e.payload?.team === teamKey &&
    (e.setIndex ?? 1) === setIndex
  ).length
  if (used >= maxPerSet) return { legal: false, reason: `Timeout limit reached (${maxPerSet} per team per set).` }
  return { legal: true }
}
