/**
 * The one write path of the corrections screens (during the match and at
 * the match end): a plan from domain/manualCorrections goes to Dexie in ONE
 * transaction, together with everything that follows from it.
 *
 *  1. event rows: delete, update (payload, seq renumbering), add
 *  2. every affected set: its score re-derived from the point events (set
 *     row and, for a finished set, the set_end payload) — no score is ever
 *     typed in; set-time changes go to the set row
 *  3. match.sanctions re-derived from the sanction events; plan.matchPatch
 *     (coin toss, game captain ...) on the match row
 *  4. match.remarks: the plan's lines replaced in place (remarkReplace),
 *     removed / appended
 *  5. match.manualChanges: the correction-log entry (a human sentence)
 *  5b. plan.playerUpdates on the roster (a renumbered player, libero marks),
 *     and the team's roster to the cloud (players_home / players_away)
 *  6. sync jobs: event/insert (an upsert on external_id, so edited and
 *     renumbered rows are re-sent the same way), set/update, match/update —
 *     no direct API writes, corrections work offline. The match update
 *     carries cloud columns only (the server refuses an unknown column, and
 *     with it the whole update: the correction log, the coin toss ...) and,
 *     when a finished set's score changed, the match result as the set end
 *     and the match end write it (set_results; winner and final_score once
 *     the match is over: the final mail reads them)
 *  7. queued insert jobs of removed events are dropped (only inserts:
 *     domain/corrections syncJobsForEvents)
 *  8. at the match end, a change of the sheet clears the post-match
 *     signatures (they certified the old sheet), here and on the server
 *
 * The event history (db/eventHistory) is the one record of what the
 * correction removed or changed: its db.events hooks write an event_history
 * row and a void / edit revision job for every deleted or edited row, with
 * the reason 'correction' (withActivityContext below), inside this same
 * transaction (EVENT_HISTORY_SCOPE). The server keeps a removed event as a
 * voided row (POST /api/match/event-revisions); no event delete is sent.
 *
 * After the transaction the caller's hooks run (scoresheet refresh, and in
 * the match the referee / livescore push).
 */
import { scoreFromPointEvents } from '../../domain/rules'
import { deriveTeamSanctionFlags } from '../../domain/sanctions'
import { appendRemark, removeRemarkLine } from '../../domain/remarks'
import { syncJobsForEvents } from '../../domain/corrections'
import { clearedPostMatchSignatures, POST_MATCH_SIGNATURE_FIELDS, getMatchWinner, countSetsWon, isMatchOverStatus } from '../../domain/matchEnd'
import { signaturesPayload } from '../../domain/signatureEdits'
import { buildEventInsertJob } from '../../utils/eventSync'
import { toCloudPlayers, filterMatchPayload } from '../../db/matchRepository'
import { setExtId } from '../../utils/syncIds'
import { withActivityContext, EVENT_HISTORY_SCOPE, rememberSeedKey } from '../../db/eventHistory'
import { randomUuid } from '../../utils/deviceId'

/** The event history reason of every row a correction removes or edits. */
export const CORRECTION_REASON = 'correction'

/** True when the plan changes what the officials signed (anything but the log). */
export function planChangesSheet(plan) {
  return !!plan && (
    (plan.add?.length || 0) + (plan.update?.length || 0) + (plan.remove?.length || 0) +
    (plan.setUpdates?.length || 0) + (plan.remarkAdd?.length || 0) + (plan.remarkRemove?.length || 0) +
    (plan.remarksSet !== undefined ? 1 : 0) + (plan.remarkReplace?.length || 0) +
    Object.keys(plan.matchPatch || {}).length + (plan.playerUpdates?.length || 0)
  ) > 0
}

/** The correction-log entry stored in match.manualChanges. */
export function logEntryFor(plan, now = new Date()) {
  if (!plan?.log) return null
  const { action, setIndex = null, team = null, before = null, after = null, text } = plan.log
  return {
    ts: now.toISOString(),
    category: 'correction',
    action,
    setIndex,
    team,
    before,
    after,
    text,
    description: text,
    by: 'scorer'
  }
}

/** The new remarks text after the plan's removals and additions. */
export function remarksAfter(remarks, plan) {
  // remarksSet: the whole text, when one line was edited in place
  let out = plan?.remarksSet !== undefined ? String(plan.remarksSet) : (remarks || '')
  // a line rewritten where it stands (a renumbered player's remark)
  for (const { from, to } of plan?.remarkReplace || []) {
    if (!from || from === to) continue
    out = out.split('\n').map(l => (l === from ? to : l)).join('\n')
  }
  for (const line of plan?.remarkRemove || []) out = removeRemarkLine(out, line)
  for (const line of plan?.remarkAdd || []) out = appendRemark(out, line)
  return out
}

/**
 * Write a correction plan.
 * @param {object} plan from domain/manualCorrections (never one with `error`)
 * @param {{ matchId:any, db:object, mode?:'live'|'review', hooks?:object, now?:Date }} opts
 * @returns {Promise<{ addedIds:Array, signaturesCleared:boolean }>}
 */
export async function applyCorrectionPlan(plan, opts = {}) {
  if (!plan || plan.error) throw new Error(plan?.error || 'No plan')
  return withActivityContext({ reason: CORRECTION_REASON, actionId: randomUuid() }, () => writePlan(plan, opts))
}

async function writePlan(plan, { matchId, db, mode = 'live', hooks = {}, now = new Date() } = {}) {
  const result = { addedIds: [], signaturesCleared: false }
  // The history tables the database has (all of them in the app)
  const historyTables = EVENT_HISTORY_SCOPE.map(name => db[name]).filter(Boolean)
  const playerTables = db.players ? [db.players] : []

  await db.transaction('rw', [db.events, db.sets, db.matches, db.sync_queue, ...playerTables, ...historyTables], async () => {
    const match = await db.matches.get(matchId)
    if (!match) throw new Error('Match not found')
    // the history hooks queue the revision jobs in this transaction when they know the match's key
    rememberSeedKey(matchId, match.seed_key ?? null, match.test === true)
    const before = await db.events.where('matchId').equals(matchId).toArray()
    const byId = new Map(before.map(e => [e.id, e]))

    // 1. event rows
    const removeIds = [...new Set(plan.remove || [])].filter(id => byId.has(id))
    const removing = new Set(removeIds)
    if (removeIds.length) await db.events.bulkDelete(removeIds)
    const touched = new Set()
    for (const u of plan.update || []) {
      if (!byId.has(u.id) || removing.has(u.id)) continue
      await db.events.update(u.id, u.changes)
      touched.add(u.id)
    }
    for (const row of plan.add || []) {
      // eslint-disable-next-line no-unused-vars
      const { tempKey, id, ...clean } = row
      const newId = await db.events.add({ ...clean, matchId })
      result.addedIds.push(newId)
      touched.add(newId)
    }

    const events = await db.events.where('matchId').equals(matchId).toArray()
    const sets = await db.sets.where('matchId').equals(matchId).toArray()
    const changedSets = new Map()

    // 2. set scores from the point events; set times
    let set5Back = false
    for (const setIndex of plan.affectedSets || []) {
      const row = sets.find(s => s.index === setIndex)
      if (!row) continue
      const score = scoreFromPointEvents(events, setIndex)
      await db.sets.update(row.id, score)
      changedSets.set(row.id, { ...row, ...score })
      // The deciding set's court switch (at 8 points) is undone when a removed
      // point takes the set being played back below 8, as Undo does
      if (setIndex === 5 && !row.finished && match.set5CourtSwitched && Math.max(score.homePoints, score.awayPoints) < 8) set5Back = true
      const end = events.find(e => e.type === 'set_end' && (e.setIndex ?? 1) === setIndex)
      if (end) {
        const payload = { ...end.payload, homePoints: score.homePoints, awayPoints: score.awayPoints }
        await db.events.update(end.id, { payload })
        end.payload = payload
        touched.add(end.id)
      }
    }
    for (const su of plan.setUpdates || []) {
      const row = sets.find(s => s.index === su.setIndex)
      if (!row) continue
      await db.sets.update(row.id, su.changes)
      changedSets.set(row.id, { ...(changedSets.get(row.id) || row), ...su.changes })
    }

    // 3-5, 8. the match row
    const patch = { ...(plan.matchPatch || {}) }
    if (set5Back) patch.set5CourtSwitched = false
    const flags = deriveTeamSanctionFlags(events)
    const sanctions = { ...(match.sanctions || {}), ...flags }
    if (JSON.stringify(sanctions) !== JSON.stringify(match.sanctions || {})) patch.sanctions = sanctions
    const remarks = remarksAfter(match.remarks, plan)
    if (remarks !== (match.remarks || '')) patch.remarks = remarks
    const entry = logEntryFor(plan, now)
    if (entry) patch.manualChanges = [...(match.manualChanges || []), entry]
    if (mode === 'review' && planChangesSheet(plan) && POST_MATCH_SIGNATURE_FIELDS.some(f => match[f])) {
      Object.assign(patch, clearedPostMatchSignatures())
      result.signaturesCleared = true
    }
    if (Object.keys(patch).length) await db.matches.update(matchId, patch)

    // 5b. the roster (a renumbered player, a libero mark)
    const rosterTeams = new Set()
    for (const pu of plan.playerUpdates || []) {
      if (!db.players || pu?.id == null) continue
      const row = await db.players.get(pu.id)
      if (!row) continue
      await db.players.update(pu.id, pu.changes)
      if (row.teamId != null && row.teamId === match.homeTeamId) rosterTeams.add('home')
      else if (row.teamId != null && row.teamId === match.awayTeamId) rosterTeams.add('away')
    }

    // 6-7. sync jobs (official matches only)
    if (match.seed_key && !match.test) {
      const ts = now.toISOString()
      if (removeIds.length) {
        // An insert still waiting for a removed row is dropped; the void job
        // the deletion queued (event history) stays and voids the server copy
        const queued = await db.sync_queue.where('status').equals('queued').toArray()
        const stale = syncJobsForEvents(queued, removeIds)
        if (stale.length) await db.sync_queue.bulkDelete(stale.map(j => j.id))
      }
      for (const id of touched) {
        const ev = events.find(e => e.id === id)
        if (ev) await db.sync_queue.add(buildEventInsertJob(ev, match))
      }
      for (const s of changedSets.values()) {
        const payload = {
          external_id: setExtId(match.seed_key, s.id),
          home_points: Number(s.homePoints) || 0,
          away_points: Number(s.awayPoints) || 0
        }
        if (s.startTime !== undefined) payload.start_time = s.startTime ?? null
        if (s.endTime !== undefined) payload.end_time = s.endTime ?? null
        await db.sync_queue.add({ resource: 'set', action: 'update', payload, ts, status: 'queued' })
      }
      const matchPayload = { id: match.seed_key, ...filterMatchPayload(plan.cloudMatch || {}) }
      if (patch.manualChanges) matchPayload.manual_changes = patch.manualChanges
      // a finished set's score changed: the result the set end / match end sent is stale
      if ([...changedSets.values()].some(s => s.finished)) {
        const nowSets = sets.map(s => (changedSets.has(s.id) ? changedSets.get(s.id) : s))
        const finished = nowSets.filter(s => s.finished).sort((a, b) => a.index - b.index)
        matchPayload.set_results = finished.map(s => ({ set: s.index, home: Number(s.homePoints) || 0, away: Number(s.awayPoints) || 0 }))
        if (isMatchOverStatus(match.status)) {
          const won = countSetsWon(finished)
          matchPayload.winner = getMatchWinner(finished, match.bestOf, { forfeitTeam: match.forfeitTeam })
          matchPayload.final_score = `${won.home}-${won.away}`
        }
      }
      if (patch.sanctions) matchPayload.sanctions = patch.sanctions
      // the whole roster of a team whose players changed (the arrays replace the stored ones)
      for (const team of rosterTeams) {
        const teamId = team === 'home' ? match.homeTeamId : match.awayTeamId
        const list = await db.players.where('teamId').equals(teamId).sortBy('number')
        matchPayload[team === 'home' ? 'players_home' : 'players_away'] = toCloudPlayers(list)
      }
      // 8. the cleared signatures on the server too, as Reopen last set does
      // (the server kept them all, attached to the corrected sheet): the whole
      // object, it replaces the column, so the pre-match ones travel along
      if (result.signaturesCleared) matchPayload.signatures = signaturesPayload({ ...match, ...patch })
      if (Object.keys(matchPayload).length > 1) {
        await db.sync_queue.add({ resource: 'match', action: 'update', payload: matchPayload, ts, status: 'queued' })
      }
    }
  })

  try { window.dispatchEvent(new Event('sync-queue-write')) } catch { /* no window */ }
  for (const hook of ['notifyScoresheetUpdate', 'syncToReferee', 'syncLiveState']) {
    try { await hooks[hook]?.(plan, result) } catch (err) { console.warn(`[corrections] ${hook} failed`, err?.message) }
  }
  return result
}
