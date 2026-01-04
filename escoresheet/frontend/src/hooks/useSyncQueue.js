import { useEffect, useCallback, useRef, useState } from 'react'
import { db } from '../db/db'
import { supabase } from '../lib/supabaseClient'

// Sync status types: 'offline' | 'online_no_supabase' | 'connecting' | 'syncing' | 'synced' | 'error'

// Resource processing order - matches must be synced before sets/events
const RESOURCE_ORDER = ['match', 'set', 'event']

// Max retries for jobs waiting on dependencies
const MAX_DEPENDENCY_RETRIES = 10

export function useSyncQueue() {
  const busy = useRef(false)
  const [syncStatus, setSyncStatus] = useState('offline')
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )
  // Cache connection state to avoid checking on every flush
  const connectionVerified = useRef(false)
  const lastConnectionCheck = useRef(0)
  const CONNECTION_CHECK_INTERVAL = 30000 // Only recheck every 30 seconds

  // Check Supabase connection (with caching)
  const checkSupabaseConnection = useCallback(async (forceCheck = false) => {
    if (!supabase) {
      setSyncStatus('online_no_supabase')
      return false
    }

    // Use cached result if recently verified and not forcing
    const now = Date.now()
    if (!forceCheck && connectionVerified.current && (now - lastConnectionCheck.current) < CONNECTION_CHECK_INTERVAL) {
      return true
    }

    try {
      // Only show 'connecting' on initial check, not during regular syncs
      if (!connectionVerified.current) {
        setSyncStatus('connecting')
      }
      // Try a simple query to check connection - use matches table
      const { error } = await supabase.from('matches').select('id').limit(1)
      if (error) {
        connectionVerified.current = false
        // If table doesn't exist (code 42P01), it's a setup issue, not a connection error
        if (error.code === '42P01' || error.message?.includes('relation') || error.message?.includes('does not exist')) {
          // Table doesn't exist - this is expected if tables aren't set up yet
          setSyncStatus('online_no_supabase')
          return false
        }
        // Check if using secret key instead of anon key
        if (error.message?.includes('secret API key') || error.message?.includes('Forbidden use of secret')) {
          setSyncStatus('error')
          return false
        }
        // Check for 401 Unauthorized (RLS or auth issues)
        if (error.message?.includes('401') || error.message?.includes('Unauthorized')) {
          setSyncStatus('error')
          return false
        }
        console.error('[SyncQueue] Connection check error:', error)
        setSyncStatus('error')
        return false
      }
      // Cache successful connection
      connectionVerified.current = true
      lastConnectionCheck.current = now
      return true
    } catch (err) {
      connectionVerified.current = false
      // Network errors might mean we're actually offline
      if (err.message?.includes('fetch') || err.message?.includes('network')) {
        setSyncStatus('offline')
        return false
      }
      console.error('[SyncQueue] Connection check exception:', err)
      setSyncStatus('error')
      return false
    }
  }, [])

  // Process a single job
  const processJob = useCallback(async (job) => {
    try {
      // ==================== MATCH ====================
      if (job.resource === 'match' && job.action === 'insert') {
        // All data is stored as JSONB in the match record - no FK resolution needed
        const matchPayload = { ...job.payload }

        console.log('[SyncQueue] Match insert payload:', matchPayload)
        const { error } = await supabase
          .from('matches')
          .upsert(matchPayload, { onConflict: 'external_id' })
        if (error) {
          console.error('[SyncQueue] Match insert error:', error, matchPayload)
          return false
        }
        console.log('[SyncQueue] Match insert successful')
        return true
      }

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
            console.error('[SyncQueue] Match fetch for merge error:', fetchError)
            // Continue with update anyway - worst case we overwrite
          }

          if (existingMatch) {
            // Merge JSONB columns
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

        console.log('[SyncQueue] Match update payload:', { id, ...finalUpdateData })
        const { error } = await supabase
          .from('matches')
          .update(finalUpdateData)
          .eq('external_id', id)
        if (error) {
          console.error('[SyncQueue] Match update error:', error, job.payload)
          return false
        }
        console.log('[SyncQueue] Match update successful')
        return true
      }

      if (job.resource === 'match' && job.action === 'delete') {
        const { id } = job.payload

        // First, look up the match to get its UUID
        const { data: matchData, error: lookupError } = await supabase
          .from('matches')
          .select('id')
          .eq('external_id', id)
          .maybeSingle()

        if (lookupError) {
          console.error('[SyncQueue] Match lookup error:', lookupError, job.payload)
          return false
        }

        if (!matchData) {
          // Match doesn't exist in Supabase, consider it successfully deleted
          console.log('[SyncQueue] Match not found in Supabase (already deleted?):', id)
          return true
        }

        const matchUuid = matchData.id

        // Delete events for this match
        const { error: eventsError } = await supabase
          .from('events')
          .delete()
          .eq('match_id', matchUuid)
        if (eventsError) {
          console.warn('[SyncQueue] Events delete error (continuing):', eventsError)
        }

        // Delete sets for this match
        const { error: setsError } = await supabase
          .from('sets')
          .delete()
          .eq('match_id', matchUuid)
        if (setsError) {
          console.warn('[SyncQueue] Sets delete error (continuing):', setsError)
        }

        // Delete match_live_state for this match (foreign key constraint - MUST succeed)
        // First check if it exists
        const { data: existingLiveState } = await supabase
          .from('match_live_state')
          .select('id')
          .eq('match_id', matchUuid)
          .maybeSingle()

        if (existingLiveState) {
          const { error: liveStateError } = await supabase
            .from('match_live_state')
            .delete()
            .eq('match_id', matchUuid)
          if (liveStateError) {
            console.error('[SyncQueue] match_live_state delete error (blocking):', liveStateError)
            return false
          }

          // Verify it's actually deleted
          const { data: stillExists } = await supabase
            .from('match_live_state')
            .select('id')
            .eq('match_id', matchUuid)
            .maybeSingle()
          if (stillExists) {
            console.error('[SyncQueue] match_live_state still exists after delete (RLS issue?):', matchUuid)
            return false
          }
          console.log('[SyncQueue] match_live_state deleted for match:', matchUuid)
        } else {
          console.log('[SyncQueue] No match_live_state found for match (ok):', matchUuid)
        }

        // Delete the match
        const { error: matchError } = await supabase
          .from('matches')
          .delete()
          .eq('id', matchUuid)
        if (matchError) {
          console.error('[SyncQueue] Match delete error:', matchError, job.payload)
          return false
        }

        console.log('[SyncQueue] Deleted match and related records from Supabase:', id)
        return true
      }

      // ==================== MATCH RESTORE ====================
      // Special action for backup restore: DELETE first, then UPSERT
      // SAFETY: Only deletes data for THIS SPECIFIC MATCH by external_id
      if (job.resource === 'match' && job.action === 'restore') {
        const { match, sets, events, liveState } = job.payload

        // SAFETY CHECK: external_id is required - identifies THIS specific match
        if (!match?.external_id) {
          console.error('[SyncQueue] Restore failed: missing external_id in match payload')
          return false
        }

        const externalId = match.external_id
        console.log('[SyncQueue] Processing restore job for match:', externalId)

        try {
          // Step 1: Look up existing match UUID by external_id (THIS MATCH ONLY)
          const { data: existingMatch, error: lookupError } = await supabase
            .from('matches')
            .select('id')
            .eq('external_id', externalId)
            .maybeSingle()

          if (lookupError) {
            console.error('[SyncQueue] Restore lookup error:', lookupError)
            return false
          }

          // Step 2: DELETE existing data for THIS MATCH ONLY (if it exists)
          if (existingMatch) {
            const matchUuid = existingMatch.id
            console.log('[SyncQueue] Deleting existing data for match UUID:', matchUuid)

            // Delete ONLY records with this specific match_id
            const { error: eventsDelErr } = await supabase.from('events').delete().eq('match_id', matchUuid)
            if (eventsDelErr) console.warn('[SyncQueue] Events delete warning:', eventsDelErr)

            const { error: setsDelErr } = await supabase.from('sets').delete().eq('match_id', matchUuid)
            if (setsDelErr) console.warn('[SyncQueue] Sets delete warning:', setsDelErr)

            const { error: liveStateDelErr } = await supabase.from('match_live_state').delete().eq('match_id', matchUuid)
            if (liveStateDelErr) console.warn('[SyncQueue] match_live_state delete warning:', liveStateDelErr)

            console.log('[SyncQueue] Deleted existing data for match:', externalId)
          } else {
            console.log('[SyncQueue] No existing match found in Supabase, will create new')
          }

          // Step 3: UPSERT match (creates or updates BY external_id)
          const { data: upsertedMatch, error: matchError } = await supabase
            .from('matches')
            .upsert(match, { onConflict: 'external_id' })
            .select('id')
            .single()

          if (matchError) {
            console.error('[SyncQueue] Match upsert failed:', matchError)
            return false
          }

          const matchUuid = upsertedMatch.id
          console.log('[SyncQueue] Match upserted, UUID:', matchUuid)

          // Step 4: INSERT all sets (with resolved match_id)
          if (sets?.length > 0) {
            for (const set of sets) {
              const setPayload = { ...set, match_id: matchUuid }
              const { error: setErr } = await supabase
                .from('sets')
                .upsert(setPayload, { onConflict: 'external_id' })
              if (setErr) {
                console.warn('[SyncQueue] Set upsert warning:', setErr, set.external_id)
              }
            }
            console.log('[SyncQueue] Upserted', sets.length, 'sets')
          }

          // Step 5: INSERT all events (with resolved match_id)
          if (events?.length > 0) {
            // Batch insert events for efficiency
            const eventsWithMatchId = events.map(e => ({ ...e, match_id: matchUuid }))
            const { error: eventsErr } = await supabase
              .from('events')
              .upsert(eventsWithMatchId, { onConflict: 'external_id' })
            if (eventsErr) {
              console.warn('[SyncQueue] Events batch upsert warning:', eventsErr)
              // Try individual inserts as fallback
              for (const event of eventsWithMatchId) {
                await supabase.from('events').upsert(event, { onConflict: 'external_id' })
              }
            }
            console.log('[SyncQueue] Upserted', events.length, 'events')
          }

          // Step 6: UPSERT match_live_state (keyed by match_id)
          if (liveState) {
            const liveStatePayload = { ...liveState, match_id: matchUuid }
            const { error: liveStateErr } = await supabase
              .from('match_live_state')
              .upsert(liveStatePayload, { onConflict: 'match_id' })
            if (liveStateErr) {
              console.warn('[SyncQueue] match_live_state upsert warning:', liveStateErr)
            } else {
              console.log('[SyncQueue] match_live_state upserted')
            }
          }

          console.log('[SyncQueue] Restore complete for match:', externalId)
          return true

        } catch (restoreErr) {
          console.error('[SyncQueue] Restore exception:', restoreErr)
          return false
        }
      }

      // ==================== SET ====================
      if (job.resource === 'set' && job.action === 'insert') {
        // Resolve match_id from external_id
        let setPayload = { ...job.payload }

        if (setPayload.match_id && typeof setPayload.match_id === 'string') {
          const { data: matchData } = await supabase
            .from('matches')
            .select('id')
            .eq('external_id', setPayload.match_id)
            .maybeSingle()

          if (!matchData) {
            // Match not yet synced - keep job queued for retry
            return null // null means "retry later"
          }
          setPayload.match_id = matchData.id
        }

        const { error } = await supabase
          .from('sets')
          .upsert(setPayload, { onConflict: 'external_id' })
        if (error) {
          console.error('[SyncQueue] Set insert error:', error, setPayload)
          return false
        }
        return true
      }

      if (job.resource === 'set' && job.action === 'update') {
        // Update set by external_id
        const { external_id, ...updateData } = job.payload

        const { error } = await supabase
          .from('sets')
          .update(updateData)
          .eq('external_id', external_id)
        if (error) {
          console.error('[SyncQueue] Set update error:', error, job.payload)
          return false
        }
        return true
      }

      // ==================== EVENT ====================
      if (job.resource === 'event' && job.action === 'insert') {
        // Resolve match_id from external_id
        let eventPayload = { ...job.payload }

        if (eventPayload.match_id && typeof eventPayload.match_id === 'string') {
          const { data: matchData } = await supabase
            .from('matches')
            .select('id')
            .eq('external_id', eventPayload.match_id)
            .maybeSingle()

          if (!matchData) {
            // Match not yet synced - keep job queued for retry (will be limited by MAX_DEPENDENCY_RETRIES)
            return null // null means "retry later"
          }
          eventPayload.match_id = matchData.id
        }

        // Use upsert with external_id to avoid duplicates on retry
        const { error } = await supabase
          .from('events')
          .upsert(eventPayload, { onConflict: 'external_id' })
        if (error) {
          console.error('[SyncQueue] Event insert error:', error, eventPayload)
          return false
        }
        return true
      }

      // Unknown resource/action - mark as done to avoid infinite loop
      console.warn('[SyncQueue] Unknown job type:', job.resource, job.action)
      return true

    } catch (err) {
      console.error('[SyncQueue] Job processing error:', err, job)
      return false
    }
  }, [])

  const flush = useCallback(async () => {
    if (busy.current) return
    if (!supabase) {
      setSyncStatus('online_no_supabase')
      return
    }

    const connected = await checkSupabaseConnection()
    if (!connected) return

    try {
      const queued = await db.sync_queue.where('status').equals('queued').toArray()

      if (queued.length === 0) {
        setSyncStatus('synced')
        return
      }

      busy.current = true
      setSyncStatus('syncing')
      console.log(`[SyncQueue] Processing ${queued.length} queued items`)

      let hasError = false
      let hasRetry = false

      // Group jobs by resource type for ordered processing
      const jobsByResource = {}
      for (const job of queued) {
        const resource = job.resource
        if (!jobsByResource[resource]) {
          jobsByResource[resource] = []
        }
        jobsByResource[resource].push(job)
      }

      // Process in dependency order
      for (const resource of RESOURCE_ORDER) {
        const jobs = jobsByResource[resource] || []

        for (const job of jobs) {
          const result = await processJob(job)

          if (result === true) {
            await db.sync_queue.update(job.id, { status: 'sent', retry_count: 0 })
          } else if (result === false) {
            await db.sync_queue.update(job.id, { status: 'error' })
            hasError = true
          } else if (result === null) {
            // Retry later - increment retry count
            const currentRetries = job.retry_count || 0
            if (currentRetries >= MAX_DEPENDENCY_RETRIES) {
              // Give up after max retries
              console.warn(`[SyncQueue] Job ${job.id} (${job.resource}) exceeded max retries, marking as error`)
              await db.sync_queue.update(job.id, { status: 'error', retry_count: currentRetries })
              hasError = true
            } else {
              await db.sync_queue.update(job.id, { retry_count: currentRetries + 1 })
              hasRetry = true
            }
          }
        }
      }

      if (hasError) {
        setSyncStatus('error')
      } else if (hasRetry) {
        // Some items need retry - will be processed next cycle
        setSyncStatus('syncing')
      } else {
        setSyncStatus('synced')
      }
    } catch (err) {
      console.error('[SyncQueue] Flush error:', err)
      setSyncStatus('error')
    } finally {
      busy.current = false
    }
  }, [checkSupabaseConnection, processJob])

  // Monitor online/offline status
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleOnline = () => {
      setIsOnline(true)
      connectionVerified.current = false // Reset cache when coming online
      // Check connection when coming online
      setTimeout(() => {
        if (supabase) {
          checkSupabaseConnection(true).then(connected => {
            if (connected) {
              flush()
            }
          })
        } else {
          setSyncStatus('online_no_supabase')
        }
      }, 500)
    }

    const handleOffline = () => {
      setIsOnline(false)
      setSyncStatus('offline')
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Initial check
    if (isOnline) {
      if (supabase) {
        checkSupabaseConnection(true).then(connected => {
          if (connected) {
            flush()
          }
        })
      } else {
        setSyncStatus('online_no_supabase')
      }
    } else {
      setSyncStatus('offline')
    }

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [isOnline, checkSupabaseConnection, flush])

  // Real-time sync - check every 1 second for new items
  useEffect(() => {
    if (!isOnline || syncStatus === 'offline' || syncStatus === 'online_no_supabase') return

    const interval = setInterval(() => {
      if (!busy.current) {
        flush()
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [isOnline, syncStatus, flush])

  return { flush, syncStatus, isOnline }
}
