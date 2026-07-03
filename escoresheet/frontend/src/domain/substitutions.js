/**
 * Pure substitution-legality checks (FIVB 2025-2028 Rule 15.5-15.6) computable
 * from the event history alone — no React, no Dexie. Used to validate manual
 * substitution entries (ManualAdjustments) which previously wrote raw events with
 * no checks, permitting a 7th sub, an illegal reverse pairing, or re-entering a
 * completed-cycle player.
 *
 * SENIOR 6-6 scope: max 6 substitutions per set. Each player may enter (playerIn)
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

/**
 * Validate a proposed substitution against the set's history.
 * @returns {{legal: boolean, reason?: string}}
 */
export function validateManualSubstitution(events, teamKey, setIndex, playerOut, playerIn, { maxPerSet = 6 } = {}) {
  const out = Number(playerOut)
  const inn = Number(playerIn)
  if (!out || !inn) return { legal: false, reason: 'Select both the player going out and the player coming in.' }
  if (out === inn) return { legal: false, reason: 'A player cannot be substituted for themselves.' }

  const subs = getSetSubstitutions(events, teamKey, setIndex)
  if (subs.length >= maxPerSet) return { legal: false, reason: `Substitution limit reached (${maxPerSet} per set).` }

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
