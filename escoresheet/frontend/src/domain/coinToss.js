/**
 * Pure team-designation (A/B) helpers — no React, no Dexie.
 *
 * The coin toss assigns the labels A and B to the home/away teams
 * (coinTossTeamA / coinTossTeamB) and records which of them serves first
 * (coinTossServeA / coinTossServeB, plus the physical `firstServe` home/away).
 * Several later fields store A/B LABELS rather than home/away keys
 * (set5LeftTeam, set5FirstServe, setLeftTeamOverrides values).
 *
 * "Swap A/B" corrects the coin toss only (owner's decision, 2026-10-09, as
 * OpenBeach): it changes which team is A and which is B, nothing else.
 * Nothing moves on the court, the same team serves first, points / sets /
 * time-outs / sanctions stay with their team. All the A/B-labelled fields
 * therefore change together: otherwise A and B can end up being the same
 * team, the first server silently changes, a set-5 choice made for one team
 * is applied to the other, or the teams change courts. Moving the teams is
 * "Switch sides" (corrections/liveActions switchSides), never this.
 */
import { getLeftTeamLabelForSet } from './rules'

const flipLabel = (label) => (label === 'A' ? 'B' : label === 'B' ? 'A' : label)
const isLabel = (v) => v === 'A' || v === 'B'

/** The sets 1-4 of a match (best-of-3: 1-2): the ones whose sides follow the set number. */
export function regularSetIndexes(match = {}) {
  return Number(match?.bestOf) === 3 ? [1, 2] : [1, 2, 3, 4]
}

/**
 * `setLeftTeamOverrides` after A and B are swapped: every set 1-4 pinned to
 * the team the court has on its left now, in the new labels. A set without an
 * override takes its side from the set number (A left in odd sets): flipping
 * only the saved ones put the new A on the left there, i.e. the teams moved.
 * Any other saved side (an older match's set 5) is flipped too.
 * @param {object} match  the match before the swap
 * @returns {object}
 */
export function swappedSides(match = {}) {
  const out = {}
  const saved = match.setLeftTeamOverrides
  if (saved && typeof saved === 'object') {
    for (const [set, v] of Object.entries(saved)) if (isLabel(v)) out[set] = flipLabel(v)
  }
  for (const set of regularSetIndexes(match)) out[set] = flipLabel(getLeftTeamLabelForSet(set, match))
  return out
}

/**
 * The match fields to write when swapping which team is A and which is B.
 * The physical facts stay the same: the team that serves first (`firstServe`,
 * written: home when the match has none, as the device plays it), the team
 * on each side in every set (`swappedSides`; set 5's toss side, written once
 * set 5 is played; its change of courts at 8 is a fact about the courts and
 * stays), and the team each A/B-labelled field refers to.
 * @param {object} match
 * @param {{ currentSetIndex?: number }} [opts]  the set being played (or the
 *   last one): set 5 gets its toss side written even when it has none yet
 * @returns {object} a patch for db.matches.update
 */
export function swapTeamDesignation(match = {}, { currentSetIndex = null } = {}) {
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
    coinTossServeB: firstServe === newTeamB,
    setLeftTeamOverrides: swappedSides(match)
  }

  if (isLabel(match.set5LeftTeam)) {
    patch.set5LeftTeam = flipLabel(match.set5LeftTeam)
  } else if (Number(currentSetIndex) === 5) {
    // Set 5 under way without its toss side: the side it started on (before
    // the change of courts at 8), written in the new labels
    patch.set5LeftTeam = flipLabel(getLeftTeamLabelForSet(5, { ...match, set5CourtSwitched: false }))
  }
  if (isLabel(match.set5FirstServe)) patch.set5FirstServe = flipLabel(match.set5FirstServe)
  return patch
}

/**
 * The live row's own Team A ('home' / 'away'), from its team names against
 * the match's. The live row (match_live_state) names its A/B fields (side_a,
 * points_a, sets_won_a, lineup_a, ...) by the Team A it was written with: a
 * "Swap A/B" made after it (Manual adjustments at the match end) changes the
 * match's Team A, not that row. null when the names do not tell (missing, or
 * the same on both teams).
 * @param {object|null} liveState  { team_a_name, team_b_name }
 * @param {string|null|undefined} homeName
 * @param {string|null|undefined} awayName
 * @returns {'home'|'away'|null}
 */
export function liveRowTeamA(liveState, homeName, awayName) {
  const a = liveState?.team_a_name
  const b = liveState?.team_b_name
  if (!homeName || !awayName || homeName === awayName || !a || !b) return null
  if (a === homeName && b === awayName) return 'home'
  if (a === awayName && b === homeName) return 'away'
  return null
}
