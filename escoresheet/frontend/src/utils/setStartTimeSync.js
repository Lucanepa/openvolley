/**
 * Cloud copy of a confirmed set start time.
 *
 * The cloud sets row is inserted before the set starts (set 1 at the coin
 * toss, set n+1 at the end of set n) with start_time = the moment the row was
 * created. The scorer then confirms the real start in the "Set N start time"
 * dialog, which only changed the local set and the set_start event, so the
 * cloud kept the creation time (exports, scoresheet restores and set
 * durations read sets.start_time). This queues a set update carrying the
 * confirmed time; an older, still queued start-time-only update of the same
 * set is dropped first (a re-confirm sends one update).
 *
 * The set's own insert job may still be waiting (queued, or errored / failed
 * and retried later). The update would then match no cloud row and count as
 * sent, and the insert would write the creation time afterwards: so the
 * confirmed time is also written into any insert job of that set not sent yet.
 *
 * Offline-first like the other sync jobs: an ordinary sync_queue row. Test
 * matches and matches without a seed_key get none. Never throws into the
 * scoring flow.
 */
import { setExtId } from './syncIds'

const START_ONLY_KEYS = new Set(['external_id', 'start_time'])

// Insert jobs that will still run (not sent, superseded or dropped)
const UNSENT_STATUSES = new Set(['queued', 'error', 'failed'])

const isUnsentSetInsert = (job, externalId) =>
  job?.resource === 'set' && job.action === 'insert' && UNSENT_STATUSES.has(job.status) &&
  job.payload?.external_id === externalId

const isStartOnlySetUpdate = (job, externalId) =>
  job?.resource === 'set' && job.action === 'update' && job.status === 'queued' &&
  job.payload?.external_id === externalId &&
  Object.keys(job.payload).every((k) => START_ONLY_KEYS.has(k))

/**
 * @param {object} db  Dexie database (matches, sync_queue)
 * @param {{matchId: number, setId: number, startTime: string}} p  startTime: ISO, as confirmed
 * @returns {Promise<boolean>} true when a job was queued
 */
export async function queueSetStartTimeSync(db, { matchId, setId, startTime }) {
  try {
    if (setId == null || !startTime) return false
    const match = await db.matches.get(matchId)
    if (!match || match.test || !match.seed_key) return false
    const externalId = setExtId(match.seed_key, setId)
    const stale = await db.sync_queue.where('status').equals('queued')
      .and((j) => isStartOnlySetUpdate(j, externalId))
      .toArray()
    if (stale.length > 0) await db.sync_queue.bulkDelete(stale.map((j) => j.id))
    const inserts = await db.sync_queue.where('resource').equals('set')
      .and((j) => isUnsentSetInsert(j, externalId))
      .toArray()
    for (const job of inserts) {
      await db.sync_queue.update(job.id, { payload: { ...job.payload, start_time: startTime } })
    }
    await db.sync_queue.add({
      resource: 'set',
      action: 'update',
      payload: { external_id: externalId, start_time: startTime },
      ts: new Date().toISOString(),
      status: 'queued'
    })
    return true
  } catch (err) {
    console.warn('[setStartTimeSync] could not queue the set start time', matchId, setId, err?.message)
    return false
  }
}
