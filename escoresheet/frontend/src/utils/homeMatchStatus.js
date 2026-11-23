/**
 * The current match's status for the header's match chip and Home's actions
 * (App matchStatus): 'Match ended', 'Match recording', 'Coin toss', 'Setup',
 * 'No data', or null for a restarted test match (one set, no events, no
 * signatures). The same rules as the querier it replaces (App.jsx before the
 * performance pass, 22.11).
 *
 * Cheap enough to run in a live query while scoring: the match's events are
 * read only when the status can depend on them (not ended, not live, no set
 * under way, ready for play), and then only up to the first set_start,
 * rally_start or point. A live match's status reads sets and roster counts
 * only, so a tap no longer re-reads (and deep-clones) every event of the
 * match. The teams are not needed for the status.
 */
import { isStaleClosedCopy } from './matchReopen'

// Events that show the match is being played
const ACTIVITY = new Set(['set_start', 'rally_start', 'point'])

/**
 * @param {import('dexie').Dexie} db
 * @param {object|null|undefined} match the match row
 * @returns {Promise<string|null>}
 */
export async function readHomeMatchStatus(db, match) {
  if (!match) return null

  const [sets, homePlayers, awayPlayers] = await Promise.all([
    db.sets.where('matchId').equals(match.id).toArray(),
    match.homeTeamId ? db.players.where('teamId').equals(match.homeTeamId).count() : 0,
    match.awayTeamId ? db.players.where('teamId').equals(match.awayTeamId).count() : 0
  ])

  // A test match that has been restarted (no signatures, only the initial
  // set, no events): no status
  if (match.test === true) {
    const hasSignatures = match.homeCoachSignature ||
      match.homeCaptainSignature ||
      match.awayCoachSignature ||
      match.awayCaptainSignature
    if (!hasSignatures && sets.length === 1 && !(await db.events.where('matchId').equals(match.id).first())) {
      return null
    }
  }

  const signaturesComplete = Boolean(
    match.homeCoachSignature &&
    match.homeCaptainSignature &&
    match.awayCoachSignature &&
    match.awayCaptainSignature
  )

  const infoConfigured = Boolean(
    (match.scheduledAt && String(match.scheduledAt).trim() !== '') ||
    (match.city && String(match.city).trim() !== '') ||
    (match.hall && String(match.hall).trim() !== '') ||
    (match.league && String(match.league).trim() !== '')
  )

  const rostersReady = homePlayers >= 6 && awayPlayers >= 6
  const matchReadyForPlay = infoConfigured && signaturesComplete && rostersReady

  const hasActiveSet = sets.some(set => Boolean(
    set.finished ||
    set.startTime ||
    set.homePoints > 0 ||
    set.awayPoints > 0
  ))

  // A copy the server has closed is no match being recorded: the header
  // does not say so, and New match warns instead of doing nothing
  const ended = match.status === 'final' || (sets.length > 0 && sets.every(s => s.finished)) || isStaleClosedCopy(match)
  if (ended) return 'Match ended'

  // The events only decide when nothing else says the match is under way
  const underWay = match.status === 'live' || hasActiveSet ||
    (matchReadyForPlay && !!(await db.events.where('matchId').equals(match.id).filter(e => ACTIVITY.has(e.type)).first()))
  if (underWay && matchReadyForPlay) return 'Match recording'

  if (homePlayers > 0 || awayPlayers > 0 || match.homeCoachSignature || match.awayCoachSignature) {
    return signaturesComplete ? 'Coin toss' : 'Setup'
  }
  return 'No data'
}
