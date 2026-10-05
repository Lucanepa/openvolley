import { apiFrom } from '../lib/apiClient'
import { formatTimeLocal } from './timeUtils'

/**
 * Cloud matches a team can still upload its roster for (Upload Roster app).
 *
 * The criterion is the match status: rosters are taken in Match Setup and
 * locked by the coin toss (status 'live' from then on), so only matches in
 * 'setup' are listed. It is NOT the referee connection: that is switched on in
 * the Scoreboard options, i.e. after the coin toss, so gating on it made a
 * pre-match upload impossible. Access is gated by the team's upload PIN,
 * checked by the backend (/api/match/validate-connection-pin); no PIN and no
 * connections column (pending rosters, signatures) is asked for here.
 */
export const ROSTER_UPLOAD_STATUSES = Object.freeze(['setup'])

/**
 * Listing window: from a day ago (a match running late, or set up the evening
 * before) to two weeks ahead, soonest first, at most ROSTER_UPLOAD_LIMIT rows.
 * Abandoned setup matches and ones without a date drop out instead of piling
 * up in every coach's picker.
 */
export const ROSTER_UPLOAD_WINDOW = Object.freeze({ pastMs: 24 * 60 * 60 * 1000, futureMs: 14 * 24 * 60 * 60 * 1000 })
export const ROSTER_UPLOAD_LIMIT = 200

/** Is a match (cloud row) open for a roster upload? */
export function isOpenForRosterUpload(row) {
  return !!row && ROSTER_UPLOAD_STATUSES.includes(row.status) && row.test !== true
}

function displayDateTime(scheduledAt) {
  if (!scheduledAt) return 'TBD'
  try {
    // A timestamp without zone is UTC
    const iso = /Z$|[+-]\d\d:?\d\d$/.test(scheduledAt) ? scheduledAt : `${scheduledAt}Z`
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return 'TBD'
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    return `${dateStr} ${formatTimeLocal(iso)}`
  } catch {
    return 'TBD'
  }
}

/** A cloud matches row in the shape the Upload Roster list uses. */
export function toRosterUploadMatch(m) {
  const homeTeamName = m.home_team?.name || 'Home'
  const awayTeamName = m.away_team?.name || 'Away'
  return {
    id: m.external_id || m.id,
    external_id: m.external_id, // the cloud write targets this
    gameNumber: m.game_n || m.external_id,
    homeTeam: homeTeamName,
    awayTeam: awayTeamName,
    homeTeamName,
    awayTeamName,
    scheduledAt: m.scheduled_at,
    dateTime: displayDateTime(m.scheduled_at),
    status: m.status
  }
}

/**
 * @returns {Promise<{ success: boolean, matches: object[], error?: string }>}
 */
export async function listRosterUploadMatches({ now = Date.now() } = {}) {
  try {
    const { data, error } = await apiFrom('matches')
      // Not connections: it carries the teams' pending rosters and signatures
      .select('id, external_id, game_n, status, scheduled_at, home_team, away_team, test')
      .in('status', [...ROSTER_UPLOAD_STATUSES])
      .gte('scheduled_at', new Date(now - ROSTER_UPLOAD_WINDOW.pastMs).toISOString())
      .lte('scheduled_at', new Date(now + ROSTER_UPLOAD_WINDOW.futureMs).toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(ROSTER_UPLOAD_LIMIT)
    if (error) {
      console.error('[listRosterUploadMatches] Error:', error)
      return { success: false, matches: [], error: error.message }
    }
    return { success: true, matches: (data || []).filter(isOpenForRosterUpload).map(toRosterUploadMatch) }
  } catch (error) {
    console.error('[listRosterUploadMatches] Exception:', error)
    return { success: false, matches: [], error: error.message }
  }
}
