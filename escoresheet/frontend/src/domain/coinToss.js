/**
 * Pure team-designation (A/B) helpers — no React, no Dexie.
 *
 * The coin toss assigns the labels A and B to the home/away teams
 * (coinTossTeamA / coinTossTeamB) and records which of them serves first
 * (coinTossServeA / coinTossServeB, plus the physical `firstServe` home/away).
 * Several later fields store A/B LABELS rather than home/away keys
 * (set5LeftTeam, set5FirstServe, setLeftTeamOverrides values).
 *
 * Re-assigning A and B (a corrected coin toss / "Switch Sides" in sets 1-4) must
 * therefore change all of these together: otherwise A and B can end up being
 * the same team, the first server silently changes, or a set-5 choice made for
 * one team is applied to the other.
 */

const flipLabel = (label) => (label === 'A' ? 'B' : label === 'B' ? 'A' : label)

/**
 * The match fields to write when swapping which team is A and which is B.
 * The physical facts stay the same: the team that serves first (`firstServe`,
 * written: home when the match has none, as the device plays it) and the
 * team each A/B-labelled field refers to.
 * @param {object} match
 * @returns {object} a patch for db.matches.update
 */
export function swapTeamDesignation(match = {}) {
  const currentA = match.coinTossTeamA || 'home'
  const newTeamA = currentA === 'home' ? 'away' : 'home'
  const newTeamB = newTeamA === 'home' ? 'away' : 'home'

  // Keep the team that serves first as the device plays it (the scoreboard
  // and the referee: firstServe, home without one), and write it: derived
  // from the old A/B serve flag, the cloud got the other team than the
  // device plays when firstServe was missing
  const firstServe = match.firstServe || 'home'
  const patch = {
    coinTossTeamA: newTeamA,
    coinTossTeamB: newTeamB,
    firstServe,
    coinTossServeA: firstServe === newTeamA,
    coinTossServeB: firstServe === newTeamB
  }

  if (match.set5LeftTeam === 'A' || match.set5LeftTeam === 'B') patch.set5LeftTeam = flipLabel(match.set5LeftTeam)
  if (match.set5FirstServe === 'A' || match.set5FirstServe === 'B') patch.set5FirstServe = flipLabel(match.set5FirstServe)
  if (match.setLeftTeamOverrides && typeof match.setLeftTeamOverrides === 'object') {
    patch.setLeftTeamOverrides = Object.fromEntries(
      Object.entries(match.setLeftTeamOverrides).map(([k, v]) => [k, flipLabel(v)])
    )
  }
  return patch
}
