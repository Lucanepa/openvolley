/**
 * The coin toss page's choices (Team A, which team serves first) before
 * "Confirm coin toss result". They were React state only: Back to Match setup
 * (to correct a date of birth, owner 2026-11-15) unmounted the page and the
 * toss came back as Team A home, A serving. Each choice is kept on the match
 * row as `coinTossDraft` at once, as the page's signatures are; the confirmed
 * fields (coinTossTeamA/B, coinTossServeA/B, coinTossConfirmed) are written
 * by the confirm only: other code (App's continue, deviceMatches, backups)
 * reads them as a toss done. The confirm clears the draft. Pure, no React.
 */

const SIDES = ['home', 'away']
const other = (side) => (side === 'home' ? 'away' : 'home')

/** The draft to store for these choices. */
export function coinTossDraftOf(teamA, serveA) {
  return { teamA: teamA === 'away' ? 'away' : 'home', serveA: serveA !== false }
}

/**
 * The choices the page opens with: the draft of a toss not yet confirmed, else
 * the toss stored on the match, else Team A home, serving first.
 * @returns {{ teamA: 'home'|'away', teamB: 'home'|'away', serveA: boolean, serveB: boolean }}
 */
export function coinTossChoiceOf(match) {
  const draft = !match?.coinTossConfirmed ? match?.coinTossDraft : null
  if (draft && SIDES.includes(draft.teamA) && typeof draft.serveA === 'boolean') {
    return { teamA: draft.teamA, teamB: other(draft.teamA), serveA: draft.serveA, serveB: !draft.serveA }
  }
  if (SIDES.includes(match?.coinTossTeamA) && SIDES.includes(match?.coinTossTeamB)) {
    const serveA = typeof match.coinTossServeA === 'boolean' ? match.coinTossServeA : true
    const serveB = typeof match.coinTossServeB === 'boolean' ? match.coinTossServeB : !serveA
    return { teamA: match.coinTossTeamA, teamB: match.coinTossTeamB, serveA, serveB }
  }
  return { teamA: 'home', teamB: 'away', serveA: true, serveB: false }
}
