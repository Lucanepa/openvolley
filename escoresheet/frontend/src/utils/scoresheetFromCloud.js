/**
 * The scoresheet's input (scoresheet_pdf/App_Scoresheet matchData) drawn from
 * the server's record of a match, without this device's database: an admin's
 * "Rebuild PDF" in the manager's Scoresheets tab (owner 2026-11-16) draws the
 * sheet again after the data changed on the server (Corrections, the Data
 * tab, the SQL tab).
 *
 * The same steps as taking the match over on a device (backupManager:
 * cloudDataFromServer, then importMatchFromSupabase's rows), kept in memory:
 * the match row (signatures as stored, the closing ones too), the teams, the
 * rosters with the log's libero re-designations, the sets, the events, and
 * the line-up rows an older log lacks rebuilt from its entries. The match's
 * manual-change log comes along (match.manualChanges), so the sheet keeps its
 * "Corrected after the match" remarks, and so do the officials' account
 * approvals (match.accountApprovals, read by the panel from GET
 * /api/approvals), so a slot approved with a PIN keeps its stamp.
 *
 * Set starts as the scorer's device printed them (rebuildSetStart): the
 * cloud's sets.start_time held the row's creation time (coin toss, end of the
 * previous set) before 983fdb500, and still does when its update was lost.
 */

import { cloudDataFromServer, localMatchRowFromCloud, rosterWithRedesignations } from './backupManager'
import { recomputeMatch } from '../domain/recompute'
import { approvalsBySlot } from '../domain/accountApproval'
import { normalizeMatchData } from '../../scoresheet_pdf/utils/matchData'
import { rebuildSetStart } from '../domain/sheetTimes'

const REBUILD_MATCH_ID = 1
const HOME_TEAM_ID = 1
const AWAY_TEAM_ID = 2

const playerRow = (teamId) => (p) => ({
  teamId,
  number: p.number,
  name: `${p.last_name || ''} ${p.first_name || ''}`.trim(),
  firstName: p.first_name,
  lastName: p.last_name,
  dob: p.dob,
  libero: p.libero,
  isCaptain: p.is_captain,
  isLfp: !!p.is_lfp
})

// The cloud-start rule lives with the other time rules (domain/sheetTimes,
// shared with the server's public API); re-exported for older imports
export { rebuildSetStart }

const teamRow = (id, team) => (team?.name
  ? { id, name: team.name, shortName: team.short_name, color: team.color }
  : null)

/**
 * @param {{ match: object, sets?: object[], events?: object[], liveState?: object|null, approvals?: object[] }} record
 *   GET /api/scoresheets/:id/match (lib/scoresheets.js matchForRebuild), with
 *   `approvals` from GET /api/approvals (the non-revoked records)
 * @returns {import('../../scoresheet_pdf/utils/matchData').MatchData}
 */
export function scoresheetDataFromCloud(record) {
  const cloud = cloudDataFromServer({ match: record.match, sets: record.sets || [], events: record.events || [], liveState: record.liveState ?? null })
  const { match: row, sets, events } = cloud
  const homeTeam = teamRow(HOME_TEAM_ID, row.home_team)
  const awayTeam = teamRow(AWAY_TEAM_ID, row.away_team)
  const manualChanges = Array.isArray(row.manual_changes) ? row.manual_changes : []
  const approvals = approvalsBySlot(record.approvals)
  const match = {
    ...localMatchRowFromCloud(cloud, { homeTeamId: homeTeam ? HOME_TEAM_ID : null, awayTeamId: awayTeam ? AWAY_TEAM_ID : null }),
    id: REBUILD_MATCH_ID,
    // the sheet's "Corrected after the match" remarks (scoresheet_pdf/utils/sheetRemarks)
    manualChanges,
    // the APPROVAL stamps of the slots approved with a PIN (FooterSection
    // prints each one only while it matches the result, as at the approval)
    accountApprovals: Object.keys(approvals).length ? approvals : null
  }
  const homePlayers = homeTeam ? rosterWithRedesignations(row.players_home, events, 'home').map(playerRow(HOME_TEAM_ID)) : []
  const awayPlayers = awayTeam ? rosterWithRedesignations(row.players_away, events, 'away').map(playerRow(AWAY_TEAM_ID)) : []
  const setRows = (sets || []).map((s, i) => ({
    id: i + 1,
    matchId: REBUILD_MATCH_ID,
    index: s.index,
    homePoints: s.home_points,
    awayPoints: s.away_points,
    finished: s.finished,
    startTime: rebuildSetStart(s, events, manualChanges),
    endTime: s.end_time,
    externalId: s.external_id
  }))
  const eventRows = (events || []).map((e, i) => ({
    id: i + 1,
    matchId: REBUILD_MATCH_ID,
    setIndex: e.set_index,
    type: e.type,
    payload: e.payload,
    ts: e.ts,
    seq: e.seq,
    externalId: e.external_id
  }))
  // The line-up after each substitution, libero replacement and rotation: a
  // log from an older version has the starting line-ups only (as on import)
  const cloudRows = eventRows.filter(e => e.externalId != null)
  const rebuilt = recomputeMatch(cloudRows, { match, matchId: REBUILD_MATCH_ID }).add
    .filter(r => r.type === 'lineup')
    .map((r, i) => ({ id: eventRows.length + i + 1, matchId: REBUILD_MATCH_ID, setIndex: r.setIndex, type: 'lineup', payload: r.payload, ts: r.ts, seq: r.seq }))
  // the one shape every renderer hands the sheet (scoresheet_pdf/utils/matchData):
  // events by seq as the device reads them (a missing seq last, not first)
  return normalizeMatchData({ match, homeTeam, awayTeam, homePlayers, awayPlayers, sets: setRows, events: [...eventRows, ...rebuilt] })
}
