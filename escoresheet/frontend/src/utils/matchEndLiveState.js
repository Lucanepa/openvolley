/**
 * The match end in the cloud live state (match_live_state), from Match End.
 *
 * The scoreboard pushes the 'match_end' live state as the last step of the
 * match end (Scoreboard confirmSetEndTime), after the set-end sync and its
 * pause, and never queues it. An app killed in that window (battery,
 * Android swiping it away, a crash) reopens on Match End, which pushed no
 * live state: the public livescore kept the game as running, in the last set
 * at its last score with one set too few, for good (stress test 2026-10-25,
 * 180 s watched). Match End now makes sure the live state says 'ended'.
 */
import { apiFrom } from '../lib/apiClient'
import { liveStateNow } from './serverDataSync'
import { isLiveStateRefusal } from './eventSync'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The live-state fields the match end sets, from the local match and its
 * sets: status ended, the sets won and the last set's points by team A/B (the
 * coin toss's team A, as the scoreboard's pushes), no interval, no time-out.
 * null when no set is finished.
 */
export function matchEndLiveStatePatch(match, sets, now = Date.now()) {
  const finished = (sets || []).filter(s => s?.finished).sort((a, b) => a.index - b.index)
  const last = finished[finished.length - 1]
  if (!last) return null
  const teamA = match?.coinTossTeamA === 'away' ? 'away' : 'home'
  const won = (team) => finished.filter(s => (team === 'home' ? s.homePoints > s.awayPoints : s.awayPoints > s.homePoints)).length
  const pointsOf = (team) => (team === 'home' ? last.homePoints : last.awayPoints) ?? 0
  const teamB = teamA === 'home' ? 'away' : 'home'
  return {
    match_status: 'ended',
    current_set: last.index,
    sets_won_a: won(teamA),
    sets_won_b: won(teamB),
    points_a: pointsOf(teamA),
    points_b: pointsOf(teamB),
    timeout_active: false,
    timeout_started_at: null,
    set_interval_active: false,
    set_interval_started_at: null,
    last_event_type: 'match_end',
    last_event_ts: new Date(now).toISOString(),
    // the match's live-state clock (serverDataSync liveStateNow), as every push
    updated_at: new Date(liveStateNow(match, now)).toISOString()
  }
}

/**
 * Write the match end to the cloud live state of an official match when it
 * does not say 'ended' yet. Only that row's update: a live state already
 * ended (the scoreboard's push got through) is left as it is, so opening the
 * Match End of an old match never brings it back into the livescore's list.
 * @returns {Promise<boolean>} true when done (written, already ended, no live
 *   state, nothing to write, or refused for good); false: try again later
 *   (offline, the match not in the cloud yet)
 */
export async function publishMatchEndLiveState(match, sets) {
  if (!match?.seed_key || match.test === true) return true
  const patch = matchEndLiveStatePatch(match, sets)
  if (!patch) return true
  try {
    let cloudId = UUID_RE.test(String(match.externalId || '')) ? match.externalId : null
    if (!cloudId) {
      const { data, error } = await apiFrom('matches').select('id').eq('external_id', match.seed_key).maybeSingle()
      if (error || !data?.id) return false
      cloudId = data.id
    }
    const { error } = await apiFrom('match_live_state')
      .update(patch)
      .eq('match_id', cloudId)
      .neq('match_status', 'ended')
    if (error) return isLiveStateRefusal(error)
    return true
  } catch {
    return false
  }
}
