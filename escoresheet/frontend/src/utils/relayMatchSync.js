/**
 * The match a scorer device keeps on its relay from every view (App.jsx): ONE
 * match, read whole from IndexedDB by its id. App.jsx publishes the open match
 * (its Match setup, Coin toss and Match end; an open Scoreboard syncs it
 * itself as well), on Home the newest unfinished one (utils/currentMatch.js).
 * It used to take the room key, the match row, the teams and the rosters from
 * the newest unfinished match and the sets and events from the open one: with
 * two unfinished matches on the device (an easy or test match next to an
 * official one) one match's room got the other's sets and events.
 */
import { relayMatchKey, relayPeoplePayload, relayTeamPayload } from './serverDataSync'
import { mayPublishMatchData, relayEvents } from './relayPublisher'
import { isScorerMoved } from './matchHandover'
import { isStaleClosedCopy } from './matchReopen'

/**
 * The bundle of match `matchId` for sync-match-data / match-data-response, or
 * null when it is not published on `relayUrl`: no such match, a final one (as
 * Home's current match), no room key yet (relayMatchKey), a test match on the
 * cloud relay (mayPublishMatchData), one another device scores now
 * (isScorerMoved) or a copy the server has closed (isStaleClosedCopy).
 * Teams and players as the relay may hand them on (relayTeamPayload,
 * relayPeoplePayload), events without the undo snapshots (relayEvents).
 * `match` is the stored row: the caller makes the relay's copy of it
 * (relayMatchPayload, through the connection's PIN tracker).
 * @param {import('dexie').Dexie} database
 * @param {number|null|undefined} matchId
 * @param {{ relayUrl?: string|null }} [options]
 * @returns {Promise<null|{ relayKey: string, match: object, homeTeam: object|null, awayTeam: object|null, homePlayers: object[], awayPlayers: object[], sets: object[], events: object[] }>}
 */
export async function relayMatchBundle(database, matchId, { relayUrl = null } = {}) {
  if (matchId == null) return null
  const match = await database.matches.get(matchId)
  if (!match || match.status === 'final') return null
  const relayKey = relayMatchKey(match)
  if (!relayKey || !mayPublishMatchData(match, relayUrl)) return null
  if (isScorerMoved(match) || isStaleClosedCopy(match)) return null
  const [homeTeam, awayTeam, sets, events, homePlayers, awayPlayers] = await Promise.all([
    match.homeTeamId ? database.teams.get(match.homeTeamId) : null,
    match.awayTeamId ? database.teams.get(match.awayTeamId) : null,
    database.sets.where('matchId').equals(match.id).sortBy('index'),
    database.events.where('matchId').equals(match.id).toArray(),
    match.homeTeamId ? database.players.where('teamId').equals(match.homeTeamId).sortBy('number') : [],
    match.awayTeamId ? database.players.where('teamId').equals(match.awayTeamId).sortBy('number') : []
  ])
  return {
    relayKey,
    match,
    homeTeam: relayTeamPayload(homeTeam),
    awayTeam: relayTeamPayload(awayTeam),
    homePlayers: relayPeoplePayload(homePlayers),
    awayPlayers: relayPeoplePayload(awayPlayers),
    sets,
    events: relayEvents(events)
  }
}

// What the tablets wait for on the relay: who may connect, with which PIN
const RELAY_ACCESS_FIELDS = [
  'refereeConnectionEnabled', 'homeTeamConnectionEnabled', 'awayTeamConnectionEnabled',
  'refereePin', 'homeTeamPin', 'awayTeamPin'
]

/**
 * What makes App sync a match to its relay at once, as one string (a live
 * query of it re-renders nothing while it stays the same): its room key
 * (relayMatchKey; a blank match gets one with Create Match) and who may
 * connect with which PIN. null without a match.
 * @param {object|null|undefined} match
 * @returns {string|null}
 */
export function relaySyncTrigger(match) {
  if (!match) return null
  return [relayMatchKey(match), ...RELAY_ACCESS_FIELDS.map((k) => match[k])].map((v) => String(v ?? '')).join('|')
}
