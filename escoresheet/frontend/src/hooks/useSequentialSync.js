import { useState, useCallback } from 'react'
import { db } from '../db/db'
import { processJob, takeJobError, errorBackoffMs, DROP_JOB, AUTH_REQUIRED, PERMANENT_FAILURE, STOP_ERROR } from './useSyncQueue'

const TIMED_OUT = 'timed_out'

// Store the outcome of a direct processJob call on its sync_queue row and map it
// to the executeAndWait result.
async function settleJob(job, jobId, result) {
  // Why it failed (status/code/message, never the payload), stored on the row
  // so a parked set-end or match-end job can be explained
  const lastError = takeJobError(jobId)

  if (result === true) {
    await db.sync_queue.update(jobId, { status: 'sent', last_error: null })
    console.log(`[SequentialSync] ${job.resource} ${job.action} successful`)
    return { success: true, jobId }
  }

  if (result === DROP_JOB) {
    await db.sync_queue.update(jobId, { status: 'dropped' })
    return { success: false, error: 'Job cannot be attributed to a match', jobId }
  }

  if (result === PERMANENT_FAILURE) {
    // Refused by the backend (4xx): not retried automatically, shown in the
    // sync indicator with a manual retry
    console.error(`[SequentialSync] ${job.resource} ${job.action} refused by the backend`)
    await db.sync_queue.update(jobId, { status: 'failed', attempts: 1, failed_at: Date.now(), last_error: lastError })
    return { success: false, error: `${job.resource} ${job.action} refused`, jobId }
  }

  if (result === AUTH_REQUIRED) {
    // No session: saved locally, sent once the scorer signs in
    console.warn(`[SequentialSync] ${job.resource} ${job.action} needs a sign-in; left in the sync queue`)
    await db.sync_queue.update(jobId, { status: 'queued' })
    return { success: false, offline: true, authRequired: true, jobId }
  }

  if (result === false || result === STOP_ERROR) {
    // Failed (details logged by processJob), or a 4xx page from a proxy/WAF in
    // front of the backend: the background queue retries it with backoff
    console.error(`[SequentialSync] Cloud sync FAILED for ${job.resource} ${job.action}:`, lastError?.code || lastError?.status || '')
    await db.sync_queue.update(jobId, { status: 'error', attempts: 1, next_attempt_at: Date.now() + errorBackoffMs(1), last_error: lastError })
    return { success: false, error: `${job.resource} ${job.action} failed`, jobId }
  }

  // Retry later (match not in the cloud yet, 5xx), rate limited or unreachable:
  // the data is saved locally and the background queue sends it.
  console.warn(`[SequentialSync] ${job.resource} ${job.action} deferred to the sync queue:`, result)
  await db.sync_queue.update(jobId, { status: 'queued', ...(lastError ? { last_error: lastError } : {}) })
  return { success: false, offline: true, jobId }
}

async function settleException(job, jobId, error) {
  console.error(`[SequentialSync] Supabase sync EXCEPTION for ${job.resource}:`, {
    action: job.action,
    error: error?.message,
    stack: error?.stack,
    payload: job.payload
  })
  await db.sync_queue.update(jobId, { status: 'queued', error_message: error?.message })
  return { success: false, error: error?.message, jobId }
}

/**
 * Send one sync job now and wait for it (bounded by `timeout`).
 * Returns: { success: boolean, offline?: boolean, error?: string, jobId: number }
 *
 * The job is stored as 'sending' so the background queue (useSyncQueue) neither
 * picks it up nor lets newer jobs of the same entity overtake it while this
 * direct call is in flight. On timeout the caller gets { offline: true } at
 * once, but the row stays 'sending' until the original call settles: putting it
 * back to 'queued' earlier would let the background flush send it a second time
 * concurrently. useSyncQueue reclaims 'sending' rows abandoned by a closed tab.
 * Processing reuses useSyncQueue's processJob, so both paths send the same thing.
 */
export async function sendJobNow(job, timeout = 10000) {
  // 1. Write to IndexedDB sync_queue first (for retry if app closes)
  const jobId = await db.sync_queue.add({
    ...job,
    ts: Date.now(),
    status: 'sending',
    sending_since: Date.now()
  })

  // 2. If offline, return warning (data saved locally)
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await db.sync_queue.update(jobId, { status: 'queued' })
    console.warn('[SequentialSync] Offline - job queued for later:', job.resource, job.action)
    return { success: false, offline: true, jobId }
  }

  // 3. Execute API call directly; the set-end modal waits at most `timeout`
  const inFlight = Promise.resolve()
    .then(() => processJob({ ...job, id: jobId }))
    .then(
      (result) => settleJob(job, jobId, result),
      (error) => settleException(job, jobId, error)
    )
    .catch((err) => {
      console.error('[SequentialSync] Could not store the sync outcome:', err)
      return { success: false, error: err?.message, jobId }
    })

  let timer = null
  const timedOut = new Promise(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeout)
  })
  try {
    const outcome = await Promise.race([inFlight, timedOut])
    if (outcome === TIMED_OUT) {
      console.warn(`[SequentialSync] ${job.resource} ${job.action} still in flight after ${timeout} ms; continuing in the background`)
      return { success: false, offline: true, jobId }
    }
    return outcome
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * useSequentialSync - Hook for sequential sync operations at set end
 *
 * Unlike the background sync queue (useSyncQueue), this hook:
 * - Executes sync operations directly and waits for completion
 * - Provides step-by-step progress feedback
 * - Logs detailed errors when sync fails
 */
export function useSequentialSync() {
  const [syncState, setSyncState] = useState(null)

  /** See sendJobNow. */
  const executeAndWait = useCallback((job, timeout = 10000) => sendJobNow(job, timeout), [])

  /**
   * Main function: Sync set end sequentially with UI progress
   *
   * @param {Object} params
   * @param {Object|null} params.lastPointPayload - Event payload for last point (or null if no point to sync)
   * @param {Object} params.setPayload - Set update payload
   * @param {Object|null} params.matchPayload - Match update payload (if match end)
   * @returns {Promise<{ success: boolean, hasWarning: boolean }>}
   */
  const syncSetEnd = useCallback(async ({ lastPointPayload, setPayload, matchPayload }) => {
    const steps = [
      { id: 'point', label: 'syncingLastPoint', status: 'pending' },
      { id: 'set', label: 'syncingSetCompletion', status: 'pending' },
      { id: 'done', label: 'done', status: 'pending' }
    ]

    setSyncState({ steps: [...steps], hasError: false, hasWarning: false, isComplete: false })

    // Step 1: Sync last point
    steps[0].status = 'in_progress'
    setSyncState({ steps: [...steps], hasError: false, hasWarning: false, isComplete: false })

    if (lastPointPayload) {
      const result = await executeAndWait({ resource: 'event', action: 'insert', payload: lastPointPayload })
      steps[0].status = result.success ? 'done' : (result.offline ? 'warning' : 'error')
    } else {
      // No point to sync (e.g., set already synced)
      steps[0].status = 'done'
    }

    setSyncState({ steps: [...steps], hasError: steps[0].status === 'error', hasWarning: steps[0].status === 'warning', isComplete: false })

    // Step 2: Sync set completion (+ match if match end)
    steps[1].status = 'in_progress'
    setSyncState({ steps: [...steps], hasError: steps[0].status === 'error', hasWarning: steps[0].status === 'warning', isComplete: false })

    const setResult = await executeAndWait({ resource: 'set', action: 'update', payload: setPayload })
    steps[1].status = setResult.success ? 'done' : (setResult.offline ? 'warning' : 'error')

    // If match end, also sync match update
    if (matchPayload) {
      const matchResult = await executeAndWait({ resource: 'match', action: 'update', payload: matchPayload })
      if (!matchResult.success && !matchResult.offline) {
        steps[1].status = 'error'
      } else if (!matchResult.success && matchResult.offline && steps[1].status !== 'error') {
        steps[1].status = 'warning'
      }
    }

    // Step 3: Done
    steps[2].status = 'done'
    const hasError = steps.some(s => s.status === 'error')
    const hasWarning = steps.some(s => s.status === 'warning')

    setSyncState({ steps: [...steps], hasError, hasWarning, isComplete: true })

    return { success: !hasError, hasWarning }
  }, [executeAndWait])

  /**
   * Reset sync state (call when modal closes)
   */
  const resetSyncState = useCallback(() => {
    setSyncState(null)
  }, [])

  return { syncState, setSyncState, syncSetEnd, executeAndWait, resetSyncState }
}
