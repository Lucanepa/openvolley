import { useEffect, useCallback, useRef, useState } from 'react'
import { db } from '../db/db'
import { supabase } from '../lib/supabaseClient'

// Sync status types: 'offline' | 'online_no_supabase' | 'connecting' | 'syncing' | 'synced' | 'error'
export function useSyncQueue() {
  const busy = useRef(false)
  const [syncStatus, setSyncStatus] = useState('offline')
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )

  // Check Supabase connection
  const checkSupabaseConnection = useCallback(async () => {
    if (!supabase) {
      setSyncStatus('online_no_supabase')
      return false
    }

    try {
      setSyncStatus('connecting')
      // Try a simple query to check connection
      // Use a table that should exist, or just check auth status
      const { error } = await supabase.from('events').select('id').limit(1)
      if (error) {
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
        setSyncStatus('error')
        return false
      }
      return true
    } catch (err) {
      // Network errors might mean we're actually offline
      if (err.message?.includes('fetch') || err.message?.includes('network')) {
        setSyncStatus('offline')
        return false
      }
      setSyncStatus('error')
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

    busy.current = true
    setSyncStatus('syncing')
    
    try {
      const queued = await db.sync_queue.where('status').equals('queued').toArray()
      
      if (queued.length === 0) {
        setSyncStatus('synced')
        busy.current = false
        return
      }

      let hasError = false
      for (const job of queued) {
        try {
          if (job.resource === 'event' && job.action === 'insert') {
            // Resolve match_id from external_id if it's a string
            let eventPayload = { ...job.payload }
            if (eventPayload.match_id && typeof eventPayload.match_id === 'string') {
              const { data: matchData } = await supabase
                .from('matches')
                .select('id')
                .eq('external_id', eventPayload.match_id)
                .maybeSingle()
              eventPayload.match_id = matchData?.id || null
            }
            
            const { error } = await supabase.from('events').insert(eventPayload)
            if (error) {
              await db.sync_queue.update(job.id, { status: 'error' })
              hasError = true
            } else {
              await db.sync_queue.update(job.id, { status: 'sent' })
            }
          } else if (job.resource === 'match' && job.action === 'insert') {
            // Resolve home_team_id and away_team_id from external_id if they're strings
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
            
            // Use upsert to handle existing matches (e.g., test match recreations)
            const { error } = await supabase
              .from('matches')
              .upsert(matchPayload, { onConflict: 'external_id' })
            if (error) {
              await db.sync_queue.update(job.id, { status: 'error' })
              hasError = true
            } else {
              await db.sync_queue.update(job.id, { status: 'sent' })
            }
          } else if (job.resource === 'team' && job.action === 'insert') {
            // Use upsert to handle existing teams (e.g., test match recreations)
            const { error } = await supabase
              .from('teams')
              .upsert(job.payload, { onConflict: 'external_id' })
            if (error) {
              await db.sync_queue.update(job.id, { status: 'error' })
              hasError = true
            } else {
              await db.sync_queue.update(job.id, { status: 'sent' })
            }
          } else if (job.resource === 'player' && job.action === 'insert') {
            // Resolve team_id from external_id if it's a string (local Dexie ID)
            let playerPayload = { ...job.payload }
            if (playerPayload.team_id && typeof playerPayload.team_id === 'string') {
              // Look up the Supabase team ID using external_id
              const { data: teamData } = await supabase
                .from('teams')
                .select('id')
                .eq('external_id', playerPayload.team_id)
                .maybeSingle()
              
              // If team not found, set team_id to null
              playerPayload.team_id = teamData?.id || null
            }
            
            // Use upsert to handle existing players (e.g., test match recreations)
            const { error } = await supabase
              .from('players')
              .upsert(playerPayload, { onConflict: 'external_id' })
            if (error) {
              await db.sync_queue.update(job.id, { status: 'error' })
              hasError = true
            } else {
              await db.sync_queue.update(job.id, { status: 'sent' })
            }
          } else if (job.resource === 'set' && job.action === 'insert') {
            // Resolve match_id from external_id if it's a string
            let setPayload = { ...job.payload }
            if (setPayload.match_id && typeof setPayload.match_id === 'string') {
              const { data: matchData } = await supabase
                .from('matches')
                .select('id')
                .eq('external_id', setPayload.match_id)
                .maybeSingle()
              setPayload.match_id = matchData?.id || null
            }
            
            // Use upsert to handle existing sets (e.g., test match recreations)
            const { error } = await supabase
              .from('sets')
              .upsert(setPayload, { onConflict: 'external_id' })
            if (error) {
              await db.sync_queue.update(job.id, { status: 'error' })
              hasError = true
            } else {
              await db.sync_queue.update(job.id, { status: 'sent' })
            }
          } else if (job.resource === 'match' && job.action === 'update') {
            const { id, ...updateData } = job.payload
            const { error } = await supabase.from('matches').update(updateData).eq('external_id', id)
            if (error) {
              await db.sync_queue.update(job.id, { status: 'error' })
              hasError = true
            } else {
              await db.sync_queue.update(job.id, { status: 'sent' })
            }
          } else if (job.resource === 'referee' && job.action === 'insert') {
            const { data, error } = await supabase
              .from('referees')
              .insert(job.payload)
              .select('id')

            if (error) {
              if (
                error.code === '23505' ||
                error.code === '409' ||
                error.message?.includes('duplicate key')
              ) {
                await db.sync_queue.update(job.id, { status: 'sent' })
                const externalId = Number(job.payload.external_id)
                if (!Number.isNaN(externalId)) {
                  await db.referees.update(externalId, { synced: true })
                }
              } else {
                await db.sync_queue.update(job.id, { status: 'error' })
                hasError = true
              }
            } else {
              await db.sync_queue.update(job.id, { status: 'sent' })
              const externalId = Number(job.payload.external_id)
              if (!Number.isNaN(externalId)) {
                const inserted = Array.isArray(data) ? data[0] : data
                await db.referees.update(externalId, { synced: true, supabaseId: inserted?.id || null })
              }
            }
          } else if (job.resource === 'scorer' && job.action === 'insert') {
            const { data, error } = await supabase
              .from('scorers')
              .insert(job.payload)
              .select('id')

            if (error) {
              if (
                error.code === '23505' ||
                error.code === '409' ||
                error.message?.includes('duplicate key')
              ) {
                await db.sync_queue.update(job.id, { status: 'sent' })
                const externalId = Number(job.payload.external_id)
                if (!Number.isNaN(externalId)) {
                  await db.scorers.update(externalId, { synced: true })
                }
              } else {
                await db.sync_queue.update(job.id, { status: 'error' })
                hasError = true
              }
            } else {
              await db.sync_queue.update(job.id, { status: 'sent' })
              const externalId = Number(job.payload.external_id)
              if (!Number.isNaN(externalId)) {
                const inserted = Array.isArray(data) ? data[0] : data
                await db.scorers.update(externalId, { synced: true, supabaseId: inserted?.id || null })
              }
            }
          }
        } catch (err) {
          await db.sync_queue.update(job.id, { status: 'error' })
          hasError = true
        }
      }
      
      if (hasError) {
        setSyncStatus('error')
      } else {
        setSyncStatus('synced')
      }
    } catch (err) {
      setSyncStatus('error')
    } finally {
      busy.current = false
    }
  }, [checkSupabaseConnection])

  // Monitor online/offline status
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleOnline = () => {
      setIsOnline(true)
      // Check connection when coming online
      setTimeout(() => {
        if (supabase) {
          checkSupabaseConnection().then(connected => {
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
        checkSupabaseConnection().then(connected => {
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

  // Periodically check sync status when online and connected
  useEffect(() => {
    if (!isOnline || syncStatus === 'offline' || syncStatus === 'online_no_supabase') return

    const interval = setInterval(() => {
      if (!busy.current) {
        flush()
      }
    }, 10000) // Check every 10 seconds

    return () => clearInterval(interval)
  }, [isOnline, syncStatus, flush])

  return { flush, syncStatus, isOnline }
}


