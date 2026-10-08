/**
 * The two match-row corrections of the live "Score and serve" card, moved
 * out of the Scoreboard's old Manual changes modal unchanged in effect:
 *  - switch sides: sets 1-4 swap the A/B designation (A is always on the left
 *    in set 1), set 5 flips set5LeftTeam;
 *  - change who serves first: sets 1-4 the match's first serve (with the A/B
 *    serve flags), set 5 its own coin toss result.
 * Both queue the cloud match update. They return the before/after for the
 * correction log; the caller records it and pushes the live state.
 */
import { swapTeamDesignation } from '../../domain/coinToss'
import { getSideAForSet, getLeftTeamLabelForSet } from '../../domain/rules'

/**
 * Which side Team A plays on in a set ('left' | 'right'), as the scoreboard
 * draws it: its own rule (getSideAForSet), set 5's change of courts at 8 and
 * its sides before the coin toss included.
 */
export function teamASide(match, setIndex) {
  return getSideAForSet(setIndex, match || {})
}

export async function switchSides({ db, matchId, match, setIndex }) {
  const teamAKey = match?.coinTossTeamA || 'home'
  if (setIndex === 5) {
    // The coin toss's left team; without one, the left team the court shows
    // before the change of courts (set 4's sides), not the home team
    const currentLeft = match.set5LeftTeam || getLeftTeamLabelForSet(5, { ...match, set5CourtSwitched: false })
    const newLeft = currentLeft === 'A' ? 'B' : 'A'
    await db.matches.update(matchId, { set5LeftTeam: newLeft })
    if (match?.seed_key && !match.test) {
      await db.sync_queue.add({
        resource: 'match', action: 'update',
        payload: { id: match.seed_key, set5LeftTeam: newLeft },
        ts: new Date().toISOString(), status: 'queued'
      })
    }
    return { before: `${currentLeft} left`, after: `${newLeft} left` }
  }
  const patch = swapTeamDesignation(match)
  await db.matches.update(matchId, patch)
  if (match?.seed_key && !match.test) {
    const firstServeTeam = patch.coinTossServeA ? patch.coinTossTeamA : patch.coinTossTeamB
    await db.sync_queue.add({
      resource: 'match', action: 'update',
      payload: {
        id: match.seed_key,
        coin_toss: { team_a: patch.coinTossTeamA, team_b: patch.coinTossTeamB, serve_a: patch.coinTossServeA, confirmed: true, first_serve: firstServeTeam }
      },
      ts: new Date().toISOString(), status: 'queued'
    })
  }
  return { before: `A=${teamAKey}`, after: `A=${patch.coinTossTeamA}` }
}

/** The team serving first in a set as the match row says (sets 1-4: firstServe; set 5: its toss). */
export function firstServerOf(match, setIndex) {
  if (setIndex === 5 && match?.set5FirstServe) {
    const a = match.coinTossTeamA || 'home'
    return match.set5FirstServe === 'A' ? a : (a === 'home' ? 'away' : 'home')
  }
  return match?.firstServe || 'home'
}

export async function switchFirstServe({ db, matchId, match, setIndex }) {
  if (setIndex === 5) {
    const current = match.set5FirstServe || 'A'
    const next = current === 'A' ? 'B' : 'A'
    await db.matches.update(matchId, { set5FirstServe: next })
    if (match?.seed_key && !match.test) {
      await db.sync_queue.add({
        resource: 'match', action: 'update',
        payload: { id: match.seed_key, set5FirstServe: next },
        ts: new Date().toISOString(), status: 'queued'
      })
    }
    return { before: current, after: next }
  }
  const old = match.firstServe || 'home'
  const newServe = old === 'home' ? 'away' : 'home'
  const teamA = match.coinTossTeamA || 'home'
  const teamB = teamA === 'home' ? 'away' : 'home'
  const coinTossServeA = newServe === teamA
  await db.matches.update(matchId, { firstServe: newServe, coinTossServeA, coinTossServeB: !coinTossServeA })
  if (match?.seed_key && !match.test) {
    await db.sync_queue.add({
      resource: 'match', action: 'update',
      payload: {
        id: match.seed_key,
        coin_toss: { team_a: teamA, team_b: teamB, serve_a: coinTossServeA, confirmed: true, first_serve: newServe }
      },
      ts: new Date().toISOString(), status: 'queued'
    })
  }
  return { before: old, after: newServe }
}
