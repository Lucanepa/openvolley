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

const minuteOf = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Date.parse(String(v))
  return Number.isFinite(n) ? Math.floor(n / 60000) : null
}

/**
 * The start a cloud set row prints with, as the scorer's device printed it
 * (scoresheet_pdf/utils/matchTimes setStartMs: a set.startTime other than the
 * one the set_start event recorded wins there, as a correction).
 *
 * On the device set.startTime is the time the "Set n start time" dialog
 * confirmed, or a later correction. In the cloud it can still be the time the
 * row was created (set 1 at the coin toss, set n+1 at the end of set n): the
 * column was not updated before 983fdb500 (2026-10-06), nor when that update
 * was lost. So the cloud value counts only where it can be the scorer's word:
 *  - it is the confirmed start (the same minute), or nothing else is known;
 *  - a correction of the set's times is recorded with it (the log's
 *    `setTimes` entry, or the set_end event Corrections rewrites);
 *  - it is later than the confirmed start (a creation time never is).
 * Otherwise the confirmed start, from the set_start event.
 *
 * @param {{ index: number, start_time?: string|null }} set  a cloud sets row
 * @param {object[]} events  the cloud events (set_index, type, payload, ts)
 * @param {object[]} manualChanges  the match's manual_changes
 * @returns {string|null}
 */
export function rebuildSetStart(set, events = [], manualChanges = []) {
  const cloud = set?.start_time ?? null
  const ofSet = (Array.isArray(events) ? events : []).filter(e => e && e.set_index === set?.index)
  const opened = ofSet.find(e => e.type === 'set_start' && minuteOf(e.payload?.startTime ?? e.ts) !== null)
  const confirmed = opened ? (opened.payload?.startTime ?? opened.ts) : null
  const c = minuteOf(cloud)
  const d = minuteOf(confirmed)
  if (c === null || d === null || c === d) return cloud
  const logged = (Array.isArray(manualChanges) ? manualChanges : [])
    .some(ch => ch?.action === 'setTimes' && ch.setIndex === set.index && minuteOf(ch.after?.startTime) === c)
  const endSays = ofSet.some(e => e.type === 'set_end' && minuteOf(e.payload?.startTime) === c)
  if (logged || endSays || c > d) return cloud
  return new Date(typeof confirmed === 'number' ? confirmed : Date.parse(String(confirmed))).toISOString()
}

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
