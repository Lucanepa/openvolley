/**
 * Pure libero helpers (FIVB 2025-2028 Rule 19) — no React, no Dexie.
 *
 * What the scoreboard records for a libero replacement (FIVB 19.3.2):
 *   libero_entry     { team, position, playerOut, liberoIn }
 *   libero_exchange  { team, position, liberoOut, liberoIn, playerNumber }
 *   lineup sub-event { team, lineup, liberoSubstitution: { position, liberoNumber, playerNumber } }
 * The lineup's liberoSubstitution is carried on by every rotation with the
 * libero's new position, so it is matched by libero NUMBER, never by position.
 */

const same = (a, b) => a != null && b != null && String(a) === String(b)
const bySeqDesc = (a, b) => (b.seq || 0) - (a.seq || 0)
const asNumber = (n) => (n == null || n === '' ? null : (Number.isNaN(Number(n)) ? n : Number(n)))

/**
 * The player a libero currently on court replaced: the only player who may
 * take the libero's place (FIVB 19.3.2.1), e.g. when the libero is expelled
 * or disqualified (19.4.1, 21.3.2-21.3.3) and must leave the court.
 * @param {Array} events all events of the match
 * @param {'home'|'away'} teamKey
 * @param {number} setIndex
 * @param {number|string} liberoNumber
 * @returns {number|string|null} the replaced player's number, or null when unknown
 */
export function playerReplacedByLibero(events, teamKey, setIndex, liberoNumber) {
  const ofTeam = (events || []).filter(e => e && e.setIndex === setIndex && e.payload?.team === teamKey)

  // The lineup's liberoSubstitution (kept current through rotations and exchanges)
  const lineup = ofTeam
    .filter(e => e.type === 'lineup' && same(e.payload?.liberoSubstitution?.liberoNumber, liberoNumber))
    .sort(bySeqDesc)[0]
  if (lineup && lineup.payload.liberoSubstitution.playerNumber != null) {
    return asNumber(lineup.payload.liberoSubstitution.playerNumber)
  }

  // Older data without it: the libero's latest entry or exchange event
  const replacement = ofTeam
    .filter(e => (e.type === 'libero_entry' || e.type === 'libero_exchange') && same(e.payload?.liberoIn, liberoNumber))
    .sort(bySeqDesc)[0]
  if (!replacement) return null
  const replaced = replacement.type === 'libero_entry' ? replacement.payload.playerOut : replacement.payload.playerNumber
  return asNumber(replaced)
}
