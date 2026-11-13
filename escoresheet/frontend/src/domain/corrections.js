/**
 * Pure helpers for scorer corrections (decision change, manual deletes) — no
 * React, no Dexie.
 *
 * DECISION CHANGE (point swap): the referee reverses the point. The swap
 * edits the point event in place (payload.team), removes what the point wrote
 * for the old team as sub-events (sideout rotation, auto libero_exit) and
 * writes the new team's rotation as sub-events of the point. None of that is
 * covered by the event snapshots (the point's snapshot predates the swap), so
 * the decision_change event itself carries the undo record:
 *   payload.pointEventId        id of the swapped point
 *   payload.pointPayloadBefore  the point payload before the swap
 *   payload.removedSubEvents    full rows of the old team's deleted sub-events
 *   payload.createdSubEventIds  ids of the new team's sub-events the swap wrote
 */
import { scoreFromPointEvents } from './rules'
import { parseExtId, setExtId } from '../utils/syncIds'

/**
 * The undo record to store on a decision_change event.
 * @param {object} pointEvent the point before the swap
 * @param {Array} removedSubEvents rows the swap deleted
 * @param {Array} createdSubEventIds ids of rows the swap added
 */
export function decisionChangeUndoRecord(pointEvent, removedSubEvents = [], createdSubEventIds = []) {
  return {
    pointEventId: pointEvent?.id ?? null,
    pointPayloadBefore: pointEvent?.payload ? { ...pointEvent.payload } : null,
    removedSubEvents: (removedSubEvents || []).map(e => ({ ...e })),
    createdSubEventIds: [...(createdSubEventIds || [])]
  }
}

/**
 * Plan the undo of a decision change.
 * @param {object} decisionEvent the decision_change event
 * @param {Array} events all events of the match (before the undo)
 * @returns {null | {
 *   pointEventId:any, pointPayload:object, setIndex:number,
 *   deleteEventIds:Array, restoreEvents:Array,
 *   score:{homePoints:number, awayPoints:number}
 * }} null when the event carries no undo record (written before it existed)
 *    or the swapped point is gone.
 */
export function planDecisionChangeReversal(decisionEvent, events) {
  const p = decisionEvent?.payload || {}
  if (p.pointEventId == null || !p.pointPayloadBefore) return null
  const all = events || []
  const point = all.find(e => e.id === p.pointEventId)
  if (!point) return null

  const existingIds = new Set(all.map(e => e.id))
  const deleteEventIds = [decisionEvent.id, ...(p.createdSubEventIds || []).filter(id => existingIds.has(id))]
  const deleted = new Set(deleteEventIds)
  const restoreEvents = (p.removedSubEvents || []).filter(e => e && !existingIds.has(e.id))

  const setIndex = point.setIndex
  const after = all
    .filter(e => !deleted.has(e.id))
    .map(e => (e.id === point.id ? { ...e, payload: p.pointPayloadBefore } : e))
    .concat(restoreEvents)

  return {
    pointEventId: point.id,
    pointPayload: p.pointPayloadBefore,
    setIndex,
    deleteEventIds,
    restoreEvents,
    score: scoreFromPointEvents(after, setIndex)
  }
}

/**
 * Plan taking back a point (recorded in error, or a rally to be replayed): the
 * point and every sub-event it wrote (seq N.x: the side-out rotation lineup,
 * an automatic libero_exit), and the set score from the point events left.
 * Deleting only the newest event row is wrong: after a side-out that row is the
 * rotation sub-event and the point stays.
 * @param {Array} events all events of the match
 * @param {object|null} pointEvent the point; null takes the newest point of opts.setIndex
 * @param {{setIndex?:number, includeRallyStart?:boolean}} [opts]
 *   includeRallyStart: also remove the rally_start that opened that rally (Undo)
 * @returns {null | {pointEventId:any, setIndex:number, deleteEventIds:Array,
 *   score:{homePoints:number, awayPoints:number}}}
 */
export function planPointRemoval(events, pointEvent, { setIndex, includeRallyStart = false } = {}) {
  const all = (events || []).filter(Boolean)
  const point = pointEvent || all
    .filter(e => e.type === 'point' && e.setIndex === setIndex)
    .sort((a, b) => (b.seq || 0) - (a.seq || 0))[0]
  if (!point || point.type !== 'point') return null

  const pointSeq = point.seq || 0
  const baseSeq = Math.floor(pointSeq)
  const rows = all.filter(e => e.id === point.id || (pointSeq > 0 && Math.floor(e.seq || 0) === baseSeq))

  if (includeRallyStart) {
    const rallyStart = all
      .filter(e => e.type === 'rally_start' && e.setIndex === point.setIndex && (e.seq || 0) < baseSeq)
      .sort((a, b) => (b.seq || 0) - (a.seq || 0))[0]
    if (rallyStart && !rows.includes(rallyStart)) rows.push(rallyStart)
  }

  const deleted = new Set(rows.map(e => e.id))
  return {
    pointEventId: point.id,
    setIndex: point.setIndex,
    deleteEventIds: rows.map(e => e.id),
    score: scoreFromPointEvents(all.filter(e => !deleted.has(e.id)), point.setIndex)
  }
}

/**
 * The local Dexie id a sync job's external_id stands for: the namespaced form
 * `${seedKey}:e:${id}` / `${seedKey}:s:${id}` (utils/syncIds), or a bare id
 * queued before ids were namespaced. Null for anything else.
 * @param {*} externalId
 * @param {'event'|'set'} kind
 * @returns {string|null}
 */
export function localIdOfExtId(externalId, kind) {
  if (externalId == null) return null
  const parsed = parseExtId(externalId)
  if (parsed) return parsed.kind === kind ? String(parsed.localId) : null
  const bare = String(externalId)
  return /^\d+$/.test(bare) ? bare : null
}

/**
 * Does the job's external_id name one of `ids` (local Dexie ids of `kind`)
 * of the match `seedKey`? Matched by the whole id, never by the local number
 * alone: local ids are unique on a device only until a restore by game PIN
 * keeps the cloud's, and the unsent jobs of another match (closed here, its
 * rows gone) can carry the same numbers. A bare id (queued before ids were
 * namespaced) only when the job names that match.
 */
function namesLocalRowOf(job, kind, ids, seedKey) {
  if (!seedKey) return false
  const externalId = job.payload?.external_id
  const parsed = parseExtId(externalId)
  if (parsed) return parsed.kind === kind && parsed.seedKey === seedKey && ids.has(String(parsed.localId))
  const bare = localIdOfExtId(externalId, kind)
  return bare != null && job.payload?.match_id === seedKey && ids.has(bare)
}

/**
 * Queued (not yet sent) INSERT jobs of the given events of the match
 * `seedKey` — to be dropped when the events are deleted locally, so the
 * cloud never receives a phantom row. Event ids are local Dexie ids; the
 * jobs carry them namespaced (`${seedKey}:e:${id}`) or, when queued before
 * that, bare with the match key in match_id.
 * Only inserts: the void / edit / restore jobs the deletion itself queued
 * (db/eventHistory) carry the event's history to the server and must stay.
 * @param {Array} queuedJobs sync_queue rows with status 'queued'
 * @param {Iterable} eventIds
 * @param {string} seedKey the match's seed_key (none: nothing is picked)
 * @returns {Array} the jobs to delete
 */
export function syncJobsForEvents(queuedJobs, eventIds, seedKey) {
  const ids = new Set([...(eventIds || [])].map(String))
  return (queuedJobs || []).filter(j =>
    !!j && j.resource === 'event' && j.action === 'insert' && namesLocalRowOf(j, 'event', ids, seedKey))
}

/**
 * Queued (not yet sent) sync jobs of the given local sets of the match
 * `seedKey` (insert or update) — to be dropped when the sets are deleted
 * locally.
 * @param {Array} queuedJobs sync_queue rows with status 'queued'
 * @param {Iterable} setIds
 * @param {string} seedKey the match's seed_key (none: nothing is picked)
 * @returns {Array} the jobs to delete
 */
export function syncJobsForSets(queuedJobs, setIds, seedKey) {
  const ids = new Set([...(setIds || [])].map(String))
  return (queuedJobs || []).filter(j =>
    !!j && j.resource === 'set' && j.action !== 'delete' && namesLocalRowOf(j, 'set', ids, seedKey))
}

/**
 * sync_queue jobs that send corrected set scores to the server (Manual
 * adjustments): one set update per changed set, keyed like the scoreboard's
 * own set jobs (setExtId). The server binds account approvals to these rows,
 * so a correction that stays local could never be approved with an account.
 */
export function setScoreSyncJobs(seedKey, changedSets, ts = new Date().toISOString()) {
  if (!seedKey) return []
  return (Array.isArray(changedSets) ? changedSets : [])
    .filter(s => s && s.id != null)
    .map(s => ({
      resource: 'set',
      action: 'update',
      payload: {
        external_id: setExtId(seedKey, s.id),
        home_points: Number(s.homePoints) || 0,
        away_points: Number(s.awayPoints) || 0,
        finished: s.finished === true
      },
      ts,
      status: 'queued'
    }))
}

/**
 * The set score after an Undo removed its events: always the point events
 * that remain (seq order does not matter for a count). The stateSnapshot of
 * the previous event is NOT used for the score — it is stale as soon as a
 * correction added or removed events before it (e.g. an old point deleted,
 * then a time-out undone would put the deleted point back on the scoreboard).
 * @returns {{homePoints:number, awayPoints:number}}
 */
export function scoreAfterUndo(remainingEvents, setIndex) {
  return scoreFromPointEvents(remainingEvents, setIndex)
}
