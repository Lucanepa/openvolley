/**
 * The match-row correction of the live "Score and serve" card, moved out of
 * the Scoreboard's old Manual changes modal: switch sides, the teams change
 * courts. Sets 1-4: this set's side and the sides of the sets after it (they
 * still alternate from it) are pinned the other way round
 * (setLeftTeamOverrides); the sets played before keep theirs. Set 5 flips its
 * coin toss side (set5LeftTeam). It never re-labels the teams: that is "Swap
 * A/B" (domain/coinToss), which moves nothing (owner's decision, 2026-10-09).
 * Sets 1-4 used to do it by swapping A and B, so a coin toss correction and a
 * change of courts were the same thing.
 * The matches table has no column for the sides of any set: they reach the
 * cloud with the live state the caller pushes (and its snapshots), set 5's
 * too. Set 5 queued a set5LeftTeam column the server refuses: the job stayed
 * failed and the device showed a sync error for a day. Returns the
 * before/after for the correction log; the caller records it and pushes the
 * live state.
 */
import { getSideAForSet, getLeftTeamLabelForSet } from '../../domain/rules'
import { regularSetIndexes } from '../../domain/coinToss'

const flipLabel = (label) => (label === 'A' ? 'B' : 'A')

/**
 * Which side Team A plays on in a set ('left' | 'right'), as the scoreboard
 * draws it: its own rule (getSideAForSet), set 5's change of courts at 8 and
 * its sides before the coin toss included.
 */
export function teamASide(match, setIndex) {
  return getSideAForSet(setIndex, match || {})
}

/**
 * The setLeftTeamOverrides that move the teams to the other courts in set
 * `setIndex` (1-4) and in the sets after it; the sets before keep their sides.
 */
export function switchedSides(match, setIndex) {
  const out = { ...(match?.setLeftTeamOverrides || {}) }
  for (const set of regularSetIndexes(match)) {
    if (set >= setIndex) out[set] = flipLabel(getLeftTeamLabelForSet(set, match || {}))
  }
  return out
}

export async function switchSides({ db, matchId, match, setIndex }) {
  if (setIndex === 5) {
    // The coin toss's left team; without one, the left team the court shows
    // before the change of courts (set 4's sides), not the home team
    const currentLeft = match.set5LeftTeam || getLeftTeamLabelForSet(5, { ...match, set5CourtSwitched: false })
    const newLeft = currentLeft === 'A' ? 'B' : 'A'
    await db.matches.update(matchId, { set5LeftTeam: newLeft })
    return { before: `${currentLeft} left`, after: `${newLeft} left` }
  }
  const before = getLeftTeamLabelForSet(setIndex, match || {})
  await db.matches.update(matchId, { setLeftTeamOverrides: switchedSides(match, setIndex) })
  return { before: `${before} left`, after: `${flipLabel(before)} left` }
}

/** The team serving first in a set as the match row says (sets 1-4: firstServe; set 5: its toss). */
export function firstServerOf(match, setIndex) {
  if (setIndex === 5 && match?.set5FirstServe) {
    const a = match.coinTossTeamA || 'home'
    return match.set5FirstServe === 'A' ? a : (a === 'home' ? 'away' : 'home')
  }
  return match?.firstServe || 'home'
}
