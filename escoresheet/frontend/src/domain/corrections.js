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
import { parseExtId } from '../utils/syncIds'

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
 * Queued (not yet sent) sync jobs that carry one of the given events — to be
 * dropped when the events are deleted locally, so the cloud never receives a
 * phantom row. Event ids are local Dexie ids; the jobs carry them namespaced
 * (`${seedKey}:e:${id}`) or, when queued before that, bare.
 * @param {Array} queuedJobs sync_queue rows with status 'queued'
 * @param {Iterable} eventIds
 * @returns {Array} the jobs to delete
 */
export function syncJobsForEvents(queuedJobs, eventIds) {
  const ids = new Set([...(eventIds || [])].map(String))
  return (queuedJobs || []).filter(j => {
    if (!j || j.resource !== 'event') return false
    const localId = localIdOfExtId(j.payload?.external_id, 'event')
    return localId != null && ids.has(localId)
  })
}

/**
 * Queued (not yet sent) sync jobs of the given local sets (insert or update) —
 * to be dropped when the sets are deleted locally.
 * @param {Array} queuedJobs sync_queue rows with status 'queued'
 * @param {Iterable} setIds
 * @returns {Array} the jobs to delete
 */
export function syncJobsForSets(queuedJobs, setIds) {
  const ids = new Set([...(setIds || [])].map(String))
  return (queuedJobs || []).filter(j => {
    if (!j || j.resource !== 'set') return false
    const localId = localIdOfExtId(j.payload?.external_id, 'set')
    return localId != null && ids.has(localId)
  })
}
