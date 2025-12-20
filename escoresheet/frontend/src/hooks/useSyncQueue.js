import { useEffect, useCallback, useRef, useState } from 'react'
import { db } from '../db/db'
import { supabase } from '../lib/supabaseClient'

// Sync status types: 'offline' | 'online_no_supabase' | 'connecting' | 'syncing' | 'synced' | 'error'

// Resource processing order - dependencies must be synced first
const RESOURCE_ORDER = ['team', 'referee', 'scorer', 'match', 'player', 'set', 'event']

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
      // Try a simple query to check connection - use teams which has no RLS issues
      const { error } = await supabase.from('teams').select('id').limit(1)
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
      if (job.resource === 'team' && job.action === 'insert') {
        // Use upsert to handle existing teams
        const { error } = await supabase
          .from('teams')
          .upsert(job.payload, { onConflict: 'external_id' })
        if (error) {
          console.error('[SyncQueue] Team insert error:', error, job.payload)
          return false
        }
        return true
      }

      if (job.resource === 'referee' && job.action === 'insert') {
        const { data, error } = await supabase
          .from('referees')
          .upsert(job.payload, { onConflict: 'seed_key' })
          .select('id')

        if (error) {
          // Handle duplicate key gracefully
          if (error.code === '23505' || error.message?.includes('duplicate key')) {
            const externalId = Number(job.payload.external_id)
            if (!Number.isNaN(externalId)) {
              await db.referees.update(externalId, { synced: true })
            }
            return true
          }
          console.error('[SyncQueue] Referee insert error:', error, job.payload)
          return false
        }

        const externalId = Number(job.payload.external_id)
        if (!Number.isNaN(externalId)) {
          const inserted = Array.isArray(data) ? data[0] : data
          await db.referees.update(externalId, { synced: true, supabaseId: inserted?.id || null })
        }
        return true
      }

      if (job.resource === 'scorer' && job.action === 'insert') {
        const { data, error } = await supabase
          .from('scorers')
          .upsert(job.payload, { onConflict: 'seed_key' })
          .select('id')

        if (error) {
          // Handle duplicate key gracefully
          if (error.code === '23505' || error.message?.includes('duplicate key')) {
            const externalId = Number(job.payload.external_id)
            if (!Number.isNaN(externalId)) {
              await db.scorers.update(externalId, { synced: true })
            }
            return true
          }
          console.error('[SyncQueue] Scorer insert error:', error, job.payload)
          return false
        }

        const externalId = Number(job.payload.external_id)
        if (!Number.isNaN(externalId)) {
          const inserted = Array.isArray(data) ? data[0] : data
          await db.scorers.update(externalId, { synced: true, supabaseId: inserted?.id || null })
        }
        return true
      }

      if (job.resource === 'match' && job.action === 'insert') {
        // Resolve home_team_id and away_team_id from external_id
        let matchPayload = { ...job.payload }

        if (matchPayload.home_team_id && typeof matchPayload.home_team_id === 'string') {
          const { data: homeTeamData } = await supabase
            .from('teams')
            .select('id')
            .eq('external_id', matchPayload.home_team_id)
            .maybeSingle()
          matchPayload.home_team_id = homeTeamData?.id || null
        }

        if (matchPayload.away_team_id && typeof matchPayload.away_team_id === 'string') {
          const { data: awayTeamData } = await supabase
            .from('teams')
            .select('id')
            .eq('external_id', matchPayload.away_team_id)
            .maybeSingle()
          matchPayload.away_team_id = awayTeamData?.id || null
        }

        const { error } = await supabase
          .from('matches')
          .upsert(matchPayload, { onConflict: 'external_id' })
        if (error) {
          console.error('[SyncQueue] Match insert error:', error, matchPayload)
          return false
        }
        return true
      }

      if (job.resource === 'match' && job.action === 'update') {
        const { id, ...updateData } = job.payload
        const { error } = await supabase
          .from('matches')
          .update(updateData)
          .eq('external_id', id)
        if (error) {
          console.error('[SyncQueue] Match update error:', error, job.payload)
          return false
        }
        return true
      }

      if (job.resource === 'player' && job.action === 'insert') {
        // Resolve team_id from external_id
        let playerPayload = { ...job.payload }

        if (playerPayload.team_id && typeof playerPayload.team_id === 'string') {
          const { data: teamData } = await supabase
            .from('teams')
            .select('id')
            .eq('external_id', playerPayload.team_id)
            .maybeSingle()
          playerPayload.team_id = teamData?.id || null
        }

        const { error } = await supabase
          .from('players')
          .upsert(playerPayload, { onConflict: 'external_id' })
        if (error) {
          console.error('[SyncQueue] Player insert error:', error, playerPayload)
          return false
        }
        return true
      }

      if (job.resource === 'set' && job.action === 'insert') {
        // Resolve match_id from external_id
        let setPayload = { ...job.payload }

        if (setPayload.match_id && typeof setPayload.match_id === 'string') {
          const { data: matchData } = await supabase
            .from('matches')
            .select('id')
            .eq('external_id', setPayload.match_id)
            .maybeSingle()
          setPayload.match_id = matchData?.id || null
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
            // Match not yet synced - keep job queued for retry
            console.log('[SyncQueue] Event waiting for match to sync:', eventPayload.match_id)
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

      // Unknown resource/action
      console.warn('[SyncQueue] Unknown job type:', job.resource, job.action)
      return true // Mark as done to avoid infinite loop

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
            await db.sync_queue.update(job.id, { status: 'sent' })
          } else if (result === false) {
            await db.sync_queue.update(job.id, { status: 'error' })
            hasError = true
          } else if (result === null) {
            // Retry later - leave status as 'queued'
            hasRetry = true
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

  // Real-time sync - check every 2 seconds for new items
  useEffect(() => {
    if (!isOnline || syncStatus === 'offline' || syncStatus === 'online_no_supabase') return

    const interval = setInterval(() => {
      if (!busy.current) {
        flush()
      }
    }, 100) // Sync every 100ms for instantaneous updates

    return () => clearInterval(interval)
  }, [isOnline, syncStatus, flush])

  return { flush, syncStatus, isOnline }
}
