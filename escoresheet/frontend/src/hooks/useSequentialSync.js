import { useState, useCallback } from 'react'
import { db } from '../db/db'
import { supabase } from '../lib/supabaseClient'

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

  /**
   * Process a single sync job directly (not via background queue)
   * Returns: { success: boolean, offline?: boolean, error?: string, jobId: number }
   */
  const executeAndWait = useCallback(async (job, timeout = 10000) => {
    // 1. Write to IndexedDB sync_queue first (for retry if app closes)
    const jobId = await db.sync_queue.add({
      ...job,
      ts: Date.now(),
      status: 'queued'
    })

    // 2. If offline, return warning (data saved locally)
    if (!navigator.onLine) {
      console.warn('[SequentialSync] Offline - job queued for later:', job.resource, job.action)
      return { success: false, offline: true, jobId }
    }

    // 3. Check if Supabase is configured
    if (!supabase) {
      console.warn('[SequentialSync] Supabase not configured - job queued for later')
      return { success: false, offline: true, jobId }
    }

    // 4. Execute Supabase call directly
    try {
      const result = await processJobDirect(job)

      if (result.success) {
        await db.sync_queue.update(jobId, { status: 'sent' })
        console.log(`[SequentialSync] ${job.resource} ${job.action} successful`)
        return { success: true, jobId }
      } else {
        // LOG THE ERROR with full details
        console.error(`[SequentialSync] Supabase sync FAILED for ${job.resource}:`, {
          action: job.action,
          error: result.error?.message || result.error,
          code: result.error?.code,
          details: result.error?.details,
          hint: result.error?.hint,
          payload: job.payload
        })

        await db.sync_queue.update(jobId, {
          status: 'error',
          error_message: result.error?.message || String(result.error),
          error_code: result.error?.code
        })

        return { success: false, error: result.error?.message || String(result.error), jobId }
      }
    } catch (error) {
      // LOG THE ERROR with full details
      console.error(`[SequentialSync] Supabase sync EXCEPTION for ${job.resource}:`, {
        action: job.action,
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
        stack: error.stack,
        payload: job.payload
      })

      await db.sync_queue.update(jobId, {
        status: 'error',
        error_message: error.message,
        error_code: error.code
      })

      return { success: false, error: error.message, jobId }
    }
  }, [])

  /**
   * Process a job directly to Supabase (similar to useSyncQueue.processJob but synchronous)
   */
  const processJobDirect = async (job) => {
    try {
      // ==================== SET UPDATE ====================
      if (job.resource === 'set' && job.action === 'update') {
        const { external_id, ...updateData } = job.payload

        const { error } = await supabase
          .from('sets')
          .update({ ...updateData, sport_type: 'indoor' })
          .eq('external_id', external_id)

        if (error) {
          return { success: false, error }
        }
        return { success: true }
      }

      // ==================== SET INSERT ====================
      if (job.resource === 'set' && job.action === 'insert') {
        let setPayload = { ...job.payload }

        // Resolve match_id from external_id if needed
        if (setPayload.match_id && typeof setPayload.match_id === 'string') {
          const { data: matchData, error: lookupError } = await supabase
            .from('matches')
            .select('id')
            .eq('external_id', setPayload.match_id)
            .maybeSingle()

          if (lookupError) {
            return { success: false, error: lookupError }
          }

          if (!matchData) {
            return { success: false, error: { message: 'Match not found in Supabase', code: 'MATCH_NOT_FOUND' } }
          }

          setPayload.match_id = matchData.id
        }

        const { error } = await supabase
          .from('sets')
          .upsert({ ...setPayload, sport_type: 'indoor' }, { onConflict: 'external_id' })

        if (error) {
          return { success: false, error }
        }
        return { success: true }
      }

      // ==================== EVENT INSERT ====================
      if (job.resource === 'event' && job.action === 'insert') {
        let eventPayload = { ...job.payload }

        // Resolve match_id from external_id if needed
        if (eventPayload.match_id && typeof eventPayload.match_id === 'string') {
          const { data: matchData, error: lookupError } = await supabase
            .from('matches')
            .select('id')
            .eq('external_id', eventPayload.match_id)
            .maybeSingle()

          if (lookupError) {
            return { success: false, error: lookupError }
          }

          if (!matchData) {
            return { success: false, error: { message: 'Match not found in Supabase', code: 'MATCH_NOT_FOUND' } }
          }

          eventPayload.match_id = matchData.id
        }

        const { error } = await supabase
          .from('events')
          .upsert({ ...eventPayload, sport_type: 'indoor' }, { onConflict: 'external_id' })

        if (error) {
          return { success: false, error }
        }
        return { success: true }
      }

      // ==================== MATCH UPDATE ====================
      if (job.resource === 'match' && job.action === 'update') {
        const { id, ...updateData } = job.payload

        // JSONB columns that need to be merged instead of replaced
        const jsonbColumns = ['connections', 'connection_pins', 'team_a', 'team_b', 'officials', 'coin_toss', 'set_results', 'sanctions']
        const hasJsonbColumns = jsonbColumns.some(col => updateData[col] !== undefined)

        let finalUpdateData = { ...updateData }

        // If updating JSONB columns, fetch existing values and merge
        if (hasJsonbColumns) {
          const columnsToFetch = jsonbColumns.filter(col => updateData[col] !== undefined)
          const { data: existingMatch, error: fetchError } = await supabase
            .from('matches')
            .select(columnsToFetch.join(','))
            .eq('external_id', id)
            .maybeSingle()

          if (fetchError) {
            console.warn('[SequentialSync] Match fetch for merge error:', fetchError)
            // Continue with update anyway
          }

          if (existingMatch) {
            for (const col of columnsToFetch) {
              if (updateData[col] && typeof updateData[col] === 'object' && !Array.isArray(updateData[col])) {
                finalUpdateData[col] = {
                  ...(existingMatch[col] || {}),
                  ...updateData[col]
                }
              }
            }
          }
        }

        const { error } = await supabase
          .from('matches')
          .update(finalUpdateData)
          .eq('external_id', id)

        if (error) {
          return { success: false, error }
        }
        return { success: true }
      }

      // Unknown resource/action
      console.warn('[SequentialSync] Unknown job type:', job.resource, job.action)
      return { success: true }

    } catch (err) {
      return { success: false, error: err }
    }
  }

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
