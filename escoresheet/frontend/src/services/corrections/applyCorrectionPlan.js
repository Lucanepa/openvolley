/**
 * The one write path of the corrections screens (during the match and at
 * the match end): a plan from domain/manualCorrections goes to Dexie in ONE
 * transaction, together with everything that follows from it.
 *
 *  1. event rows: delete, update (payload, seq renumbering), add
 *  2. every affected set: its score re-derived from the point events (set
 *     row and, for a finished set, the set_end payload) — no score is ever
 *     typed in; set-time changes go to the set row
 *  3. match.sanctions re-derived from the sanction events
 *  4. match.remarks: the plan's lines removed / appended
 *  5. match.manualChanges: the correction-log entry (a human sentence)
 *  6. sync jobs: event/insert (an upsert on external_id, so edited and
 *     renumbered rows are re-sent the same way), event/delete for removed
 *     rows, set/update, match/update — no direct API writes, corrections
 *     work offline
 *  7. queued insert jobs of removed events are dropped
 *  8. at the match end, a change of the sheet clears the post-match
 *     signatures (they certified the old sheet)
 *
 * After the transaction the caller's hooks run (scoresheet refresh, and in
 * the match the referee / livescore push).
 */
import { scoreFromPointEvents } from '../../domain/rules'
import { deriveTeamSanctionFlags } from '../../domain/sanctions'
import { appendRemark, removeRemarkLine } from '../../domain/remarks'
import { syncJobsForEvents } from '../../domain/corrections'
import { clearedPostMatchSignatures, POST_MATCH_SIGNATURE_FIELDS } from '../../domain/matchEnd'
import { buildEventInsertJob } from '../../utils/eventSync'
import { eventExtId, setExtId } from '../../utils/syncIds'

/** True when the plan changes what the officials signed (anything but the log). */
export function planChangesSheet(plan) {
  return !!plan && (
    (plan.add?.length || 0) + (plan.update?.length || 0) + (plan.remove?.length || 0) +
    (plan.setUpdates?.length || 0) + (plan.remarkAdd?.length || 0) + (plan.remarkRemove?.length || 0)
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
  let out = remarks || ''
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
export async function applyCorrectionPlan(plan, { matchId, db, mode = 'live', hooks = {}, now = new Date() } = {}) {
  if (!plan || plan.error) throw new Error(plan?.error || 'No plan')
  const result = { addedIds: [], signaturesCleared: false }

  await db.transaction('rw', db.events, db.sets, db.matches, db.sync_queue, async () => {
    const match = await db.matches.get(matchId)
    if (!match) throw new Error('Match not found')
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
    for (const setIndex of plan.affectedSets || []) {
      const row = sets.find(s => s.index === setIndex)
      if (!row) continue
      const score = scoreFromPointEvents(events, setIndex)
      await db.sets.update(row.id, score)
      changedSets.set(row.id, { ...row, ...score })
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
    const patch = {}
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

    // 6-7. sync jobs (official matches only)
    if (match.seed_key && !match.test) {
      const ts = now.toISOString()
      if (removeIds.length) {
        const queued = await db.sync_queue.where('status').equals('queued').toArray()
        const stale = syncJobsForEvents(queued, removeIds)
        if (stale.length) await db.sync_queue.bulkDelete(stale.map(j => j.id))
        for (const id of removeIds) {
          await db.sync_queue.add({
            resource: 'event',
            action: 'delete',
            payload: { external_id: eventExtId(match.seed_key, id), match_id: match.seed_key },
            ts,
            status: 'queued'
          })
        }
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
      const matchPayload = { id: match.seed_key }
      if (patch.manualChanges) matchPayload.manual_changes = patch.manualChanges
      if (patch.sanctions) matchPayload.sanctions = patch.sanctions
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
