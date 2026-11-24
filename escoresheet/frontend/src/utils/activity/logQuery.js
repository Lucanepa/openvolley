import { gameNumberOf } from './activeMatch'

/**
 * The comprehensiveLogger match query of a local match: its id, its game
 * number, and the time it was open (created .. closed / now) for entries
 * written before the match context was set.
 */
export function diagnosticLogQuery(matchId, match) {
  const from = match?.createdAt ?? match?.created_at ?? null
  const to = match?.closedAt ?? match?.closed_at ?? null
  return { matchId: matchId ?? match?.id ?? null, gameN: gameNumberOf(match), from, to }
}
