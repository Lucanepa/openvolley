import { useState, useCallback } from 'react'
import { db } from '../db/db'

// How often the queue rows of the writes being waited for are read
const POLL_MS = 150

// Queue rows that will not be sent soon: the wait for them is over
const SETTLED = new Set(['sent', 'superseded', 'failed', 'error', 'dropped'])

// How long the set end waits for its writes, all of them together. The
// whole scoreboard is behind the "Syncing to cloud..." overlay meanwhile:
// with 10 s per write it stayed there up to 21.5 s on a hung backend (12 s
// at 2 s latency), and a scorer who thinks the app froze reloads or taps
// around. Everything is saved on the device first, and the queue delivers
// what is not sent by then.
export const SET_END_WAIT_MS = 2000

// How long a set end only slower than SET_END_WAIT_MS (online, still queued)
// gets before the scoreboard downloads its backup after all
// (setEndBackupPlan 'later', setEndStillUndelivered)
export const SET_END_DOWNLOAD_GRACE_MS = 30000

// Delivered: sent, or replaced by a newer write of the same row. A row no
// longer in the queue was pruned, which only happens to delivered ones (and
// set-aside ones, long after).
const DELIVERED = new Set(['sent', 'superseded'])

/**
 * The set end's backup download ("Download backup at set end", on by
 * default): 'now' when the set end is not reaching the cloud (offline,
 * refused, set aside for another scoring device, not synced at all), 'later'
 * when it was only slower than the set end's wait (online, its writes still
 * queued: download only if they are still not delivered after
 * SET_END_DOWNLOAD_GRACE_MS), 'none' when it was delivered. With one 2 s
 * budget for all the writes, a slow hall link ended more set ends as a
 * warning, and each downloaded the match: a prompt at every set end on a
 * mobile browser, while the queue was delivering it.
 * @param {{ success: boolean, hasWarning: boolean, waitingJobIds?: number[], setAside?: boolean }|null} syncResult
 * @param {{ online: boolean }} state
 * @returns {'now'|'later'|'none'}
 */
export function setEndBackupPlan(syncResult, { online }) {
  if (!online || !syncResult?.success) return 'now'
  if (!syncResult.hasWarning) return 'none'
  return !syncResult.setAside && syncResult.waitingJobIds?.length > 0 ? 'later' : 'now'
}

/** Is one of these queued writes still not delivered (setEndBackupPlan 'later')? */
export async function setEndStillUndelivered(jobIds) {
  const rows = await db.sync_queue.bulkGet(jobIds || [])
  return rows.some(row => row && !DELIVERED.has(row.status))
}

/**
 * Ask the background queue (useSyncQueue) to send what it holds now, even
 * while a failed connection probe is backing off: the cloud may be back
 * without the browser telling (no 'online' event while the Wi-Fi stays up).
 */
export function requestQueueFlush() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('sync-queue-flush-now'))
}

// The outcome of one queued write for the set-end progress modal
function outcomeOf(row) {
  switch (row?.status) {
    case 'sent':
    case 'superseded':
      return { success: true }
    case 'failed':
      // Refused by the backend (4xx): shown in the sync indicator with a manual retry
      return { success: false, error: `${row.resource} ${row.action} refused` }
    case 'error':
      return { success: false, error: `${row.resource} ${row.action} failed` }
    case 'dropped':
      // Another device scores the match (utils/matchHandover) or it cannot be
      // attributed: kept with the match's other writes, a warning
      return { success: false, offline: true, setAside: true }
    default:
      // Still queued (backend unreachable, waiting for older writes, no
      // session): saved locally, the background queue sends it
      return { success: false, offline: true }
  }
}

/**
 * Queue writes the scorer waits for (the set end) and wait for them, at most
 * `timeout` ms in total.
 *
 * They are written to sync_queue together, in one transaction, as ordinary
 * 'queued' jobs, and the background queue sends them: behind every older job
 * of the same set and match (runQueuePass keeps them in order per entity).
 * They were once sent directly, past the queue: after a cloud outage the set
 * end reached the server before the queued insert of its own set (0 rows
 * updated, counted as sent), the insert then wrote the set as unfinished for
 * good, and the previous set end's match update, still queued, rolled
 * current_set and set_results back. Written one by one at the moment they were
 * sent, the match update of a set end was lost when the page died during the
 * set update (stress test 2026-10-25).
 *
 * @param {Array<{resource: string, action: string, payload: object}>} jobs in sending order
 * @returns {Promise<Array<{ success: boolean, offline?: boolean, setAside?: boolean, error?: string, jobId: number }>>}
 */
export async function queueAndWait(jobs, timeout = 10000) {
  const ts = Date.now()
  const jobIds = await db.transaction('rw', db.sync_queue, async () => {
    const ids = []
    for (const job of jobs) ids.push(await db.sync_queue.add({ ...job, ts, status: 'queued' }))
    return ids
  })

  // Offline: saved locally, nothing to wait for
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    console.warn('[SequentialSync] Offline - queued for later:', jobs.map(j => `${j.resource} ${j.action}`).join(', '))
    return jobIds.map(jobId => ({ success: false, offline: true, jobId }))
  }

  requestQueueFlush()
  const deadline = Date.now() + timeout
  let rows = []
  for (;;) {
    rows = await db.sync_queue.bulkGet(jobIds)
    if (rows.every(row => !row || SETTLED.has(row.status))) break
    const left = deadline - Date.now()
    if (left <= 0) {
      console.warn(`[SequentialSync] not sent within ${timeout} ms; the sync queue sends it in the background`)
      break
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(POLL_MS, left)))
  }
  return rows.map((row, i) => ({ ...outcomeOf(row), jobId: jobIds[i] }))
}

/**
 * useSequentialSync - set end sync with progress feedback
 *
 * The set-end writes go through the background sync queue (queueAndWait):
 * this hook queues them, waits a bounded time for them and reports the steps
 * to the progress modal.
 */
export function useSequentialSync() {
  const [syncState, setSyncState] = useState(null)

  /**
   * Main function: Sync set end with UI progress
   *
   * @param {Object} params
   * @param {Object|null} params.lastPointPayload - Event payload for last point (or null if no point to sync)
   * @param {Object} params.setPayload - Set update payload
   * @param {Object|null} params.matchPayload - Match update payload (current_set, set_results; the result at the match end)
   * @returns {Promise<{ success: boolean, hasWarning: boolean, waitingJobIds?: number[], setAside?: boolean }>}
   *   with a warning: the writes still waiting in the queue (not refused, not
   *   set aside) and whether one was set aside for another scoring device
   *   (setEndBackupPlan)
   */
  const syncSetEnd = useCallback(async ({ lastPointPayload, setPayload, matchPayload }) => {
    const steps = [
      { id: 'point', label: 'syncingLastPoint', status: 'pending' },
      { id: 'set', label: 'syncingSetCompletion', status: 'pending' },
      { id: 'done', label: 'done', status: 'pending' }
    ]
    const publish = (isComplete = false) => setSyncState({
      steps: [...steps],
      hasError: steps.some(s => s.status === 'error'),
      hasWarning: steps.some(s => s.status === 'warning'),
      isComplete
    })

    steps[0].status = 'in_progress'
    steps[1].status = 'in_progress'
    publish()

    // All of them queued at once: a page that dies now still sends them all
    const jobs = [
      ...(lastPointPayload ? [{ resource: 'event', action: 'insert', payload: lastPointPayload }] : []),
      { resource: 'set', action: 'update', payload: setPayload },
      ...(matchPayload ? [{ resource: 'match', action: 'update', payload: matchPayload }] : [])
    ]
    const results = await queueAndWait(jobs, SET_END_WAIT_MS)
    const stepOf = (list) => list.some(r => !r.success && !r.offline) ? 'error'
      : list.some(r => !r.success) ? 'warning' : 'done'
    // (no point to sync: the set's last point went with its rally)
    steps[0].status = lastPointPayload ? stepOf(results.slice(0, 1)) : 'done'
    steps[1].status = stepOf(lastPointPayload ? results.slice(1) : results)
    steps[2].status = 'done'
    publish(true)

    const hasError = steps.some(s => s.status === 'error')
    const hasWarning = steps.some(s => s.status === 'warning')
    if (!hasWarning) return { success: !hasError, hasWarning }
    return {
      success: !hasError,
      hasWarning,
      waitingJobIds: results.filter(r => !r.success && r.offline && !r.setAside).map(r => r.jobId),
      setAside: results.some(r => r.setAside === true)
    }
  }, [])

  /**
   * Reset sync state (call when modal closes)
   */
  const resetSyncState = useCallback(() => {
    setSyncState(null)
  }, [])

  return { syncState, setSyncState, syncSetEnd, resetSyncState }
}
