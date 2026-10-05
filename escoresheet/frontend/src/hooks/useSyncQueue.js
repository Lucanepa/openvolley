import { useEffect, useCallback, useRef, useState } from 'react'
import { db } from '../db/db'
import { apiFrom } from '../lib/apiClient'
import { getApiUrl } from '../utils/backendConfig'
import { filterMatchPayload, JSONB_COLUMNS } from '../db/matchRepository'
import { parseExtId, resolveJobExternalId, jobMatchKey } from '../utils/syncIds'
import { buildConnectionPins } from '../utils/connectionPins'

/**
 * ============================================================================
 * SYNC ARCHITECTURE: IndexedDB + Supabase
 * ============================================================================
 *
 * This app uses a TWO-PATH write architecture:
 *
 * PATH 1: QUEUED SYNC (this hook)
 * --------------------------------
 * Used for: Events, Sets, Match metadata
 * Flow: IndexedDB write (immediate) → sync_queue → Supabase (async)
 *
 * Why queued?
 * - Offline-first: Works without internet, syncs when back online
 * - Dependency ordering: Matches must exist in Supabase before sets/events
 * - Retry safety: external_id enables idempotent upserts (no duplicates on retry)
 * - JSONB merging: Multiple components write different fields safely
 *
 * PATH 2: DIRECT SUPABASE (bypasses this queue)
 * --------------------------------
 * Used for: match_live_state table only
 * Flow: Direct Supabase upsert (no local queue)
 *
 * Why direct?
 * - Real-time latency: Spectators need sub-second updates
 * - Queuing adds 1000ms+ delay (polling interval)
 * - Acceptable tradeoff: live_state is ephemeral, can be reconstructed
 *
 * KEY DESIGN DECISIONS:
 * - external_id: Stable identifier across retries (immutable, unlike game_n).
 *   Sets/events use `${seed_key}:s:${id}` / `${seed_key}:e:${id}` (utils/syncIds).
 * - JSONB merging: Fetch existing + merge on update to prevent field overwrites.
 *   connection_pins is the exception: the proxy never returns it, so it is always
 *   sent whole, built from the local match.
 * - Per-entity FIFO: once a job fails in a pass, later jobs for the same entity
 *   (and, for match insert/restore/delete, the whole match) wait for the next pass.
 * - Retries: dependency waits retry up to MAX_DEPENDENCY_RETRIES per cycle;
 *   errored jobs come back with exponential backoff (never dropped).
 * - Rate limiting (429) and network failures stop the pass and leave jobs queued.
 * - Connection caching: Only recheck Supabase every 30 seconds; a failed probe is
 *   retried with backoff instead of stopping the poll.
 *
 * See also:
 * - db.js: sync_queue table schema
 * - Scoreboard.jsx: Event logging + live_state direct writes
 * ============================================================================
 */

// Sync status types: 'offline' | 'online_no_supabase' | 'connecting' | 'syncing' | 'synced' | 'error'

// Resource processing order - matches must be synced before sets/events (FK dependency)
const RESOURCE_ORDER = ['match', 'set', 'event']

// Max retries for jobs waiting on dependencies (e.g., event waiting for match to sync)
const MAX_DEPENDENCY_RETRIES = 10

// Auto-retry check interval for errored jobs (every 30 seconds when online)
const ERROR_RETRY_INTERVAL = 30000

// Backoff for errored jobs: 30s, 1m, 2m, 4m ... capped at 10 minutes. Jobs are
// never given up on (offline-first: the cloud copy must eventually catch up).
const ERROR_BACKOFF_BASE = 30000
const ERROR_BACKOFF_MAX = 10 * 60 * 1000

// Backoff for the connection probe after a failure: 5s, 10s, 20s ... capped at 60s
const PROBE_BACKOFF_BASE = 5000
const PROBE_BACKOFF_MAX = 60000

// A 'sending' job (claimed by useSequentialSync) older than this is assumed
// abandoned (tab closed mid-request) and handed back to the queue.
const SENDING_STALE_MS = 2 * 60 * 1000

// processJob result: stop this pass, leave the job queued untouched (rate limited)
export const STOP_PASS = 'stop'
// processJob result: the request itself failed (backend unreachable). Stops the
// pass like STOP_PASS; a job that keeps failing this way while the probe succeeds
// is parked as an error after MAX_NETWORK_STOPS so it cannot block the queue.
export const STOP_NETWORK = 'stop_network'
const MAX_NETWORK_STOPS = 10
// processJob result: job can never be sent (cannot be attributed to a match)
export const DROP_JOB = 'drop'

// VALID_MATCH_COLUMNS + filterMatchPayload now live in ../db/matchRepository
// (imported above) so useSyncQueue, useSequentialSync, and backupManager share
// one definition instead of drifting copies.

/** Backoff before an errored job is auto-retried, by number of failed attempts. */
export function errorBackoffMs(attempts) {
  const n = Math.max(1, attempts || 1)
  return Math.min(ERROR_BACKOFF_BASE * 2 ** (n - 1), ERROR_BACKOFF_MAX)
}

/** Network failure or rate limit: nothing a later job in this pass can do better. */
export function isStopError(error) {
  if (!error) return false
  if (error.network) return true
  return (error.status ?? 0) === 429
}

// fetch() rejection messages: Chrome, Firefox, Safari, Node/undici, React Native
const NETWORK_ERROR_MESSAGE = /failed to fetch|networkerror|load failed|fetch failed|network request failed|network unavailable/i

/** Worth retrying later (426 upgrade required, 5xx, timeouts) rather than an error. */
export function isTransientError(error) {
  if (!error) return false
  const status = error.status ?? 0
  return status === 408 || status === 426 || (status >= 500 && status < 600)
}

// apiFrom rejects (throws) when fetch itself fails. Matched on the message only:
// a programming TypeError must not be mistaken for being offline.
function isNetworkException(err) {
  return NETWORK_ERROR_MESSAGE.test(err?.message || '')
}

// Map an apiFrom error to a processJob result
function failureResult(error) {
  if (error?.network) return STOP_NETWORK
  if (isStopError(error)) return STOP_PASS
  if (isTransientError(error)) return null
  return false
}

/**
 * Does `newer` carry every field of `older` (recursively for JSON objects)? If a
 * newer match update with the same fields has been sent, an older errored one is
 * stale and must not be replayed over it.
 */
export function payloadCovers(newer, older) {
  if (!newer || !older) return false
  for (const [key, value] of Object.entries(older)) {
    if (key === 'id') continue
    if (!(key in newer)) return false
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const n = newer[key]
      if (!n || typeof n !== 'object' || Array.isArray(n)) return false
      for (const sub of Object.keys(value)) {
        if (!(sub in n)) return false
      }
    }
  }
  return true
}

// Local Dexie match for a seed_key (no index on seed_key; a device holds few matches)
async function findLocalMatchBySeed(seedKey) {
  if (!seedKey) return null
  try {
    return await db.matches.filter(m => m.seed_key === seedKey).first()
  } catch {
    return null
  }
}

// Replace a partial connection_pins with the full object from the local match
async function withFullConnectionPins(seedKey, payload) {
  if (!payload || payload.connection_pins === undefined) return payload
  const localMatch = await findLocalMatchBySeed(seedKey)
  if (!localMatch) return payload
  return {
    ...payload,
    connection_pins: { ...(payload.connection_pins || {}), ...buildConnectionPins(localMatch) }
  }
}

/**
 * The part of an older match update that no newer (already sent) update has
 * written: top-level fields, and keys inside JSON object fields. Replaying the
 * rest would put old values back over newer ones.
 */
export function remainingAfterNewer(older, newer) {
  const remaining = {}
  for (const [key, value] of Object.entries(older)) {
    if (key === 'id') { remaining.id = value; continue }
    if (!(key in newer)) { remaining[key] = value; continue }
    const n = newer[key]
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
    if (isObj(value) && isObj(n)) {
      const rest = Object.fromEntries(Object.entries(value).filter(([sub]) => !(sub in n)))
      if (Object.keys(rest).length > 0) remaining[key] = rest
    }
    // otherwise the newer update replaced the whole field
  }
  return remaining
}

/**
 * Errored match updates vs newer updates of the same match that were already
 * sent: fields the newer ones wrote are removed from the stale job, and a job
 * left with nothing to write is marked 'superseded'.
 * @returns {Promise<Set<number>>} ids of the superseded jobs
 */
export async function supersedeStaleMatchUpdates(errorJobs) {
  const superseded = new Set()
  const stale = errorJobs.filter(j => j.resource === 'match' && j.action === 'update' && j.payload?.id)
  if (stale.length === 0) return superseded
  const sentUpdates = await db.sync_queue
    .where('resource').equals('match')
    .and(j => j.status === 'sent' && j.action === 'update')
    .toArray()
  for (const job of stale) {
    const newer = sentUpdates.filter(s => s.id > job.id && s.payload?.id === job.payload.id)
    if (newer.length === 0) continue
    let remaining = job.payload
    for (const s of newer) remaining = remainingAfterNewer(remaining, s.payload)
    if (Object.keys(remaining).length <= 1) {
      await db.sync_queue.update(job.id, { status: 'superseded' })
      superseded.add(job.id)
    } else if (!payloadCovers(remaining, job.payload)) {
      await db.sync_queue.update(job.id, { payload: remaining, superseded_fields: true })
    }
  }
  return superseded
}

/**
 * Internal helper: Reset errored jobs to queued (non-hook function)
 * This can be called from within useEffect without dependency issues.
 * Automatic retries respect each job's backoff; `force` (manual retry, back
 * online) requeues every errored job now.
 */
export async function retryErrorsInternal({ force = false } = {}) {
  try {
    const now = Date.now()

    // Hand back 'sending' jobs abandoned by useSequentialSync (tab closed mid-call)
    const sending = await db.sync_queue.where('status').equals('sending').toArray()
    let reclaimed = 0
    for (const job of sending) {
      if (!job.sending_since || now - job.sending_since > SENDING_STALE_MS) {
        await db.sync_queue.update(job.id, { status: 'queued' })
        reclaimed++
      }
    }

    const errorJobs = await db.sync_queue.where('status').equals('error').toArray()
    if (errorJobs.length === 0) return reclaimed > 0

    const superseded = await supersedeStaleMatchUpdates(errorJobs)
    const due = errorJobs.filter(job => !superseded.has(job.id) && (force || !job.next_attempt_at || job.next_attempt_at <= now))
    if (due.length === 0) return reclaimed > 0

    console.log(`[SyncQueue] Auto-retrying ${due.length} errored jobs${superseded.size ? ` (${superseded.size} superseded)` : ''}`)
    for (const job of due) {
      await db.sync_queue.update(job.id, { status: 'queued', retry_count: 0 })
    }
    return true
  } catch (err) {
    console.error('[SyncQueue] Auto-retry errors failed:', err)
    return false
  }
}

// Auto-notify when items are added to sync_queue via Dexie creating hook.
// This dispatches a custom event that the debounced flush listener picks up.
// The hook is installed once at module level so it works for all callers.
let _syncQueueHookInstalled = false
function installSyncQueueHook() {
  if (_syncQueueHookInstalled) return
  _syncQueueHookInstalled = true
  db.sync_queue.hook('creating', function () {
    // Dispatch after the current microtask completes (Dexie hooks run inside transaction)
    setTimeout(() => window.dispatchEvent(new Event('sync-queue-write')), 0)
  })
}
installSyncQueueHook()

/**
 * Process a single job.
 * Returns true (sent), false (error), null (retry later), STOP_PASS or DROP_JOB.
 */
export async function processJob(job) {
  try {
    // Jobs queued before set/event ids were namespaced (or by a call site that
    // still sends the bare Dexie id) are rewritten before they reach the cloud.
    if (job.resource === 'set' || job.resource === 'event') {
      const resolved = await resolveJobExternalId(job, { sets: db.sets, matches: db.matches })
      if (resolved?.drop) {
        console.warn('[SyncQueue] Dropping job that cannot be attributed to a match:', job.resource, job.payload?.external_id)
        return DROP_JOB
      }
      if (resolved?.external_id) {
        job = { ...job, payload: { ...job.payload, external_id: resolved.external_id } }
        await db.sync_queue.update(job.id, { payload: job.payload })
      }
    }

    // ==================== MATCH ====================
    if (job.resource === 'match' && job.action === 'insert') {
      // All data is stored as JSONB in the match record - no FK resolution needed
      // Filter to valid columns only - handles old backup formats with invalid fields
      const matchPayload = filterMatchPayload(await withFullConnectionPins(job.payload?.external_id, job.payload))

      console.log('[SyncQueue] Match insert payload:', matchPayload)
      const { error } = await apiFrom('matches')
        .upsert(matchPayload, { onConflict: 'external_id' })
      if (error) {
        console.error('[SyncQueue] Match insert error:', error, matchPayload)
        return failureResult(error)
      }
      console.log('[SyncQueue] Match insert successful')
      return true
    }

    if (job.resource === 'match' && job.action === 'update') {
      const { id, ...rawUpdateData } = job.payload
      const updateData = await withFullConnectionPins(id, rawUpdateData)

      // JSONB columns that need to be merged instead of replaced (shared list).
      // connection_pins is excluded: the proxy redacts it on read (the merge
      // would start from nothing) and it is already complete, see above.
      const jsonbColumns = JSONB_COLUMNS.filter(col => col !== 'connection_pins')
      const hasJsonbColumns = jsonbColumns.some(col => updateData[col] !== undefined)

      let finalUpdateData = { ...updateData }

      // If updating JSONB columns, fetch existing values and merge
      if (hasJsonbColumns) {
        const columnsToFetch = jsonbColumns.filter(col => updateData[col] !== undefined)
        const { data: existingMatch, error: fetchError } = await apiFrom('matches')
          .select(columnsToFetch.join(','))
          .eq('external_id', id)
          .maybeSingle()

        if (fetchError) {
          console.error('[SyncQueue] Match fetch for merge error:', fetchError)
          // Do not overwrite JSON columns blind when the backend is struggling
          if (isStopError(fetchError) || isTransientError(fetchError)) return failureResult(fetchError)
          // Otherwise continue with update anyway - worst case we overwrite
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
      const { error } = await apiFrom('matches')
        .update(finalUpdateData)
        .eq('external_id', id)
      if (error) {
        console.error('[SyncQueue] Match update error:', error, job.payload)
        return failureResult(error)
      }
      console.log('[SyncQueue] Match update successful')
      return true
    }

    if (job.resource === 'match' && job.action === 'delete') {
      const { id } = job.payload
      console.log('[SyncQueue] 🗑️ Starting match delete for external_id:', id)

      // First, look up the match to get its UUID
      const { data: matchData, error: lookupError } = await apiFrom('matches')
        .select('id')
        .eq('external_id', id)
        .maybeSingle()

      if (lookupError) {
        console.error('[SyncQueue] Match lookup error:', lookupError, job.payload)
        return failureResult(lookupError)
      }

      if (!matchData) {
        // Match doesn't exist in Supabase, consider it successfully deleted
        console.log('[SyncQueue] Match not found in Supabase (already deleted?):', id)
        return true
      }

      const matchUuid = matchData.id
      console.log('[SyncQueue] 🔍 Found match UUID:', matchUuid)

      // Count records before deletion for debugging
      const { count: eventsCountBefore } = await apiFrom('events')
        .select('*', { count: 'exact', head: true })
        .eq('match_id', matchUuid)
      const { count: setsCountBefore } = await apiFrom('sets')
        .select('*', { count: 'exact', head: true })
        .eq('match_id', matchUuid)
      const { count: liveStateCountBefore } = await apiFrom('match_live_state')
        .select('*', { count: 'exact', head: true })
        .eq('match_id', matchUuid)
      console.log('[SyncQueue] 📊 Records before delete:', {
        events: eventsCountBefore,
        sets: setsCountBefore,
        match_live_state: liveStateCountBefore
      })

      // Delete events for this match
      console.log('[SyncQueue] 🗑️ Deleting events...')
      const { error: eventsError } = await apiFrom('events')
        .delete()
        .eq('match_id', matchUuid)
        .select('*', { count: 'exact', head: true })
      if (eventsError) {
        console.warn('[SyncQueue] Events delete error (continuing):', eventsError)
      } else {
        console.log('[SyncQueue] ✅ Events deleted')
      }

      // Delete sets for this match
      console.log('[SyncQueue] 🗑️ Deleting sets...')
      const { error: setsError } = await apiFrom('sets')
        .delete()
        .eq('match_id', matchUuid)
      if (setsError) {
        console.warn('[SyncQueue] Sets delete error (continuing):', setsError)
      } else {
        console.log('[SyncQueue] ✅ Sets deleted')
      }

      // Delete match_live_state for this match
      console.log('[SyncQueue] 🗑️ Deleting match_live_state...')
      const { error: liveStateError } = await apiFrom('match_live_state')
        .delete()
        .eq('match_id', matchUuid)
      if (liveStateError) {
        console.warn('[SyncQueue] match_live_state delete error (continuing):', liveStateError)
      } else {
        console.log('[SyncQueue] ✅ match_live_state deleted')
      }

      // Verify all related records are deleted before deleting match
      const { count: eventsCountAfter } = await apiFrom('events')
        .select('*', { count: 'exact', head: true })
        .eq('match_id', matchUuid)
      const { count: setsCountAfter } = await apiFrom('sets')
        .select('*', { count: 'exact', head: true })
        .eq('match_id', matchUuid)
      const { count: liveStateCountAfter } = await apiFrom('match_live_state')
        .select('*', { count: 'exact', head: true })
        .eq('match_id', matchUuid)
      console.log('[SyncQueue] 📊 Records after delete:', {
        events: eventsCountAfter,
        sets: setsCountAfter,
        match_live_state: liveStateCountAfter
      })

      // If any records remain, warn but continue
      if (eventsCountAfter > 0 || setsCountAfter > 0 || liveStateCountAfter > 0) {
        console.warn('[SyncQueue] ⚠️ Some records were not deleted (RLS issue?). Attempting match delete anyway...')
      }

      // Delete the match
      console.log('[SyncQueue] 🗑️ Deleting match...')
      const { error: matchError } = await apiFrom('matches')
        .delete()
        .eq('id', matchUuid)
      if (matchError) {
        console.error('[SyncQueue] Match delete error:', matchError, job.payload)
        return failureResult(matchError)
      }

      console.log('[SyncQueue] ✅ Deleted match and related records from Supabase:', id)
      return true
    }

    // ==================== MATCH RESTORE ====================
    // Special action for backup restore: UPSERT match, DELETE its children, re-UPSERT them
    // SAFETY: Only deletes data for THIS SPECIFIC MATCH by external_id
    // Any failed step fails the job (it is retried; local IndexedDB stays the source).
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
        // Step 1: UPSERT match (creates or updates BY external_id)
        // Filter to valid columns only - handles old backup formats with invalid fields
        const filteredMatch = filterMatchPayload(match)
        const { data: upserted, error: matchError } = await apiFrom('matches')
          .upsert(filteredMatch, { onConflict: 'external_id' })
          .select('id')

        if (matchError) {
          console.error('[SyncQueue] Match upsert failed:', matchError)
          return failureResult(matchError)
        }

        // The proxy may not return written rows: look the UUID up (THIS MATCH ONLY)
        let matchUuid = Array.isArray(upserted) ? upserted[0]?.id : upserted?.id
        if (!matchUuid) {
          const { data: existingMatch, error: lookupError } = await apiFrom('matches')
            .select('id')
            .eq('external_id', externalId)
            .maybeSingle()
          if (lookupError) {
            console.error('[SyncQueue] Restore lookup error:', lookupError)
            return failureResult(lookupError)
          }
          matchUuid = existingMatch?.id
        }
        if (!matchUuid) {
          console.error('[SyncQueue] Restore: match row not found after upsert:', externalId)
          return null
        }
        console.log('[SyncQueue] Match upserted, UUID:', matchUuid)

        // Step 2: DELETE existing children for THIS MATCH ONLY
        for (const table of ['events', 'sets']) {
          const { error: delErr } = await apiFrom(table).delete().eq('match_id', matchUuid)
          if (delErr) {
            console.error(`[SyncQueue] Restore: ${table} delete failed:`, delErr)
            return failureResult(delErr)
          }
        }
        console.log('[SyncQueue] Deleted existing sets/events for match:', externalId)

        // Step 3: UPSERT all sets (with resolved match_id)
        if (sets?.length > 0) {
          for (const set of sets) {
            const setPayload = { ...set, match_id: matchUuid, sport_type: 'indoor' }
            const { error: setErr } = await apiFrom('sets')
              .upsert(setPayload, { onConflict: 'external_id' })
            if (setErr) {
              console.error('[SyncQueue] Restore: set upsert failed:', setErr, set.external_id)
              return failureResult(setErr)
            }
          }
          console.log('[SyncQueue] Upserted', sets.length, 'sets')
        }

        // Step 4: UPSERT all events (with resolved match_id)
        if (events?.length > 0) {
          // Batch upsert events for efficiency
          const eventsWithMatchId = events.map(e => ({ ...e, match_id: matchUuid, sport_type: 'indoor' }))
          const { error: eventsErr } = await apiFrom('events')
            .upsert(eventsWithMatchId, { onConflict: 'external_id' })
          if (eventsErr) {
            if (isStopError(eventsErr)) return failureResult(eventsErr)
            console.warn('[SyncQueue] Events batch upsert failed, trying one by one:', eventsErr)
            for (const event of eventsWithMatchId) {
              const { error: oneErr } = await apiFrom('events').upsert(event, { onConflict: 'external_id' })
              if (oneErr) {
                console.error('[SyncQueue] Restore: event upsert failed:', oneErr, event.external_id)
                return failureResult(oneErr)
              }
            }
          }
          console.log('[SyncQueue] Upserted', events.length, 'events')
        }

        // Step 5: UPSERT match_live_state (keyed by match_id). Live state is
        // ephemeral and rewritten by the next scoreboard update, so a failure
        // here does not fail the restore.
        if (liveState) {
          const liveStatePayload = { ...liveState, match_id: matchUuid }
          const { error: liveStateErr } = await apiFrom('match_live_state')
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
        return isNetworkException(restoreErr) ? STOP_NETWORK : false
      }
    }

    // ==================== SET ====================
    if (job.resource === 'set' && job.action === 'insert') {
      // Resolve match_id from external_id
      let setPayload = { ...job.payload, sport_type: 'indoor' }

      if (setPayload.match_id && typeof setPayload.match_id === 'string') {
        const { data: matchData, error: lookupError } = await apiFrom('matches')
          .select('id')
          .eq('external_id', setPayload.match_id)
          .maybeSingle()

        if (lookupError) return failureResult(lookupError)
        if (!matchData) {
          // Match not yet synced - keep job queued for retry
          return null // null means "retry later"
        }
        setPayload.match_id = matchData.id
      }

      const { error } = await apiFrom('sets')
        .upsert(setPayload, { onConflict: 'external_id' })
      if (error) {
        console.error('[SyncQueue] Set insert error:', error, setPayload)
        return failureResult(error)
      }
      return true
    }

    if (job.resource === 'set' && job.action === 'update') {
      // Update set by external_id, scoped to its match
      // eslint-disable-next-line no-unused-vars
      const { external_id, match_id: _matchId, ...updateData } = job.payload

      let query = apiFrom('sets').update({ ...updateData, sport_type: 'indoor' })
      const parsed = parseExtId(external_id)
      if (parsed) {
        const { data: matchData, error: lookupError } = await apiFrom('matches')
          .select('id')
          .eq('external_id', parsed.seedKey)
          .maybeSingle()
        if (lookupError) return failureResult(lookupError)
        if (!matchData) return null // match not in the cloud yet - retry later
        // Also match the row a set insert created before ids were namespaced;
        // the match scope keeps that bare id from touching other matches.
        query = query
          .eq('match_id', matchData.id)
          .in('external_id', [external_id, String(parsed.localId)])
      } else {
        query = query.eq('external_id', external_id)
      }

      const { error } = await query
      if (error) {
        console.error('[SyncQueue] Set update error:', error, job.payload)
        return failureResult(error)
      }
      return true
    }

    // ==================== EVENT ====================
    if (job.resource === 'event' && job.action === 'insert') {
      // Resolve match_id from external_id
      let eventPayload = { ...job.payload, sport_type: 'indoor' }

      if (eventPayload.match_id && typeof eventPayload.match_id === 'string') {
        const { data: matchData, error: lookupError } = await apiFrom('matches')
          .select('id')
          .eq('external_id', eventPayload.match_id)
          .maybeSingle()

        if (lookupError) return failureResult(lookupError)
        if (!matchData) {
          // Match not yet synced - keep job queued for retry (will be limited by MAX_DEPENDENCY_RETRIES)
          return null // null means "retry later"
        }
        eventPayload.match_id = matchData.id
      }

      // Use upsert with external_id to avoid duplicates on retry
      const { error } = await apiFrom('events')
        .upsert(eventPayload, { onConflict: 'external_id' })
      if (error) {
        console.error('[SyncQueue] Event insert error:', error, eventPayload)
        return failureResult(error)
      }
      return true
    }

    // Unknown resource/action - mark as done to avoid infinite loop
    console.warn('[SyncQueue] Unknown job type:', job.resource, job.action)
    return true

  } catch (err) {
    console.error('[SyncQueue] Job processing error:', err, job)
    return isNetworkException(err) ? STOP_NETWORK : false
  }
}

// Keys a failed job blocks for the rest of the pass (per-entity FIFO). A failed
// match insert/restore/delete blocks every job of that match; a failed update
// only blocks later updates of the same entity.
function entityKey(job) {
  if (job.resource === 'match') return `match:${jobMatchKey(job)}`
  return `${job.resource}:${job.payload?.external_id}`
}

/**
 * One pass over the queued jobs, in dependency order.
 * @returns {Promise<{ processed: number, hasError: boolean, hasRetry: boolean, stopped: boolean }>}
 */
export async function runQueuePass() {
  const queued = await db.sync_queue.where('status').equals('queued').toArray()
  const outcome = { processed: queued.length, hasError: false, hasRetry: false, stopped: false }
  if (queued.length === 0) return outcome

  console.log(`[SyncQueue] Processing ${queued.length} queued items`)

  // Group jobs by resource type for ordered processing
  const jobsByResource = {}
  for (const job of queued) {
    const resource = job.resource
    if (!jobsByResource[resource]) {
      jobsByResource[resource] = []
    }
    jobsByResource[resource].push(job)
  }

  const blocked = new Set()

  // Process in dependency order
  for (const resource of RESOURCE_ORDER) {
    const jobs = (jobsByResource[resource] || []).sort((a, b) => a.id - b.id)

    for (const job of jobs) {
      const key = entityKey(job)
      const matchKey = jobMatchKey(job)
      if (blocked.has(key) || (matchKey && blocked.has(`whole:${matchKey}`))) {
        // An earlier job for this entity/match failed in this pass: keep order
        outcome.hasRetry = true
        continue
      }

      const result = await processJob(job)

      if (result === true) {
        await db.sync_queue.update(job.id, { status: 'sent', retry_count: 0, network_stops: 0 })
        continue
      }

      if (result === DROP_JOB) {
        await db.sync_queue.update(job.id, { status: 'dropped' })
        continue
      }

      // Everything below leaves the entity unsynced: block its later jobs. A
      // set/event that must wait (match not in the cloud yet) holds back the
      // rest of its match too, instead of every job repeating the same lookup.
      blocked.add(key)
      if (matchKey && ((job.resource === 'match' && job.action !== 'update') || (job.resource !== 'match' && result === null))) {
        blocked.add(`whole:${matchKey}`)
      }

      if (result === STOP_PASS || result === STOP_NETWORK) {
        // Rate limited or backend unreachable: leave the job queued as it is
        outcome.stopped = true
        outcome.hasRetry = true
        if (result === STOP_NETWORK) {
          const stops = (job.network_stops || 0) + 1
          if (stops >= MAX_NETWORK_STOPS) {
            const attempts = (job.attempts || 0) + 1
            await db.sync_queue.update(job.id, { status: 'error', network_stops: 0, attempts, next_attempt_at: Date.now() + errorBackoffMs(attempts) })
            outcome.hasError = true
          } else {
            await db.sync_queue.update(job.id, { network_stops: stops })
          }
        }
        return outcome
      }

      if (result === false) {
        const attempts = (job.attempts || 0) + 1
        await db.sync_queue.update(job.id, {
          status: 'error',
          attempts,
          next_attempt_at: Date.now() + errorBackoffMs(attempts)
        })
        outcome.hasError = true
      } else {
        // null: retry later - increment retry count
        const currentRetries = job.retry_count || 0
        if (currentRetries >= MAX_DEPENDENCY_RETRIES) {
          // Park as error; the auto-retry brings it back with backoff
          console.warn(`[SyncQueue] Job ${job.id} (${job.resource}) exceeded max retries, marking as error`)
          const attempts = (job.attempts || 0) + 1
          await db.sync_queue.update(job.id, {
            status: 'error',
            retry_count: currentRetries,
            attempts,
            next_attempt_at: Date.now() + errorBackoffMs(attempts)
          })
          outcome.hasError = true
        } else {
          await db.sync_queue.update(job.id, { retry_count: currentRetries + 1 })
          outcome.hasRetry = true
        }
      }
    }
  }

  return outcome
}

// One flusher per page. App, Scoreboard and Referee each mount this hook; a
// per-instance flag let two instances process the same queued rows at once
// (restore/delete are not idempotent).
let flushInProgress = false

// Sync status is shared by every mounted instance: whichever instance runs the
// flush publishes it, so the Scoreboard indicator stays current even when the
// App instance did the work.
let currentSyncStatus = 'offline'
const syncStatusListeners = new Set()
function publishSyncStatus(status) {
  currentSyncStatus = status
  for (const listener of syncStatusListeners) listener(status)
}

export function useSyncQueue() {
  const [syncStatus, setLocalSyncStatus] = useState(currentSyncStatus)
  const setSyncStatus = publishSyncStatus
  useEffect(() => {
    syncStatusListeners.add(setLocalSyncStatus)
    setLocalSyncStatus(currentSyncStatus)
    return () => { syncStatusListeners.delete(setLocalSyncStatus) }
  }, [])
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )
  // Cache connection state to avoid checking on every flush
  const connectionVerified = useRef(false)
  const lastConnectionCheck = useRef(0)
  // Failed probes back off instead of stopping the poll for good
  const probeFailures = useRef(0)
  const nextProbeAt = useRef(0)
  const CONNECTION_CHECK_INTERVAL = 30000 // Only recheck every 30 seconds

  // Check backend/Supabase connection (with caching)
  const hasBackend = () => !!getApiUrl('/api/db')
  const checkSupabaseConnection = useCallback(async (forceCheck = false) => {
    if (!hasBackend()) {
      setSyncStatus('online_no_supabase')
      return false
    }

    // Use cached result if recently verified and not forcing
    const now = Date.now()
    if (!forceCheck && connectionVerified.current && (now - lastConnectionCheck.current) < CONNECTION_CHECK_INTERVAL) {
      return true
    }
    // After a failed probe, wait out the backoff before probing again
    if (!forceCheck && !connectionVerified.current && now < nextProbeAt.current) {
      return false
    }

    const probeFailed = (status) => {
      connectionVerified.current = false
      probeFailures.current += 1
      nextProbeAt.current = Date.now() + Math.min(PROBE_BACKOFF_BASE * 2 ** (probeFailures.current - 1), PROBE_BACKOFF_MAX)
      setSyncStatus(status)
      return false
    }

    try {
      // Only show 'connecting' on initial check, not during regular syncs
      if (!connectionVerified.current && probeFailures.current === 0) {
        setSyncStatus('connecting')
      }
      // Try a simple query to check connection - use matches table
      const { error } = await apiFrom('matches').select('id').limit(1)
      if (error) {
        // If table doesn't exist (code 42P01), it's a setup issue, not a connection error
        if (error.code === '42P01' || error.message?.includes('relation') || error.message?.includes('does not exist')) {
          // Table doesn't exist - this is expected if tables aren't set up yet
          return probeFailed('online_no_supabase')
        }
        console.error('[SyncQueue] Connection check error:', error)
        return probeFailed('error')
      }
      // Cache successful connection
      connectionVerified.current = true
      lastConnectionCheck.current = now
      probeFailures.current = 0
      nextProbeAt.current = 0
      return true
    } catch (err) {
      // Network errors might mean we're actually offline
      if (isNetworkException(err)) {
        return probeFailed('offline')
      }
      console.error('[SyncQueue] Connection check exception:', err)
      return probeFailed('error')
    }
  }, [])

  const flush = useCallback(async () => {
    if (flushInProgress) return
    // Claim the flush BEFORE any await so two concurrent callers cannot both
    // pass the guard and double-process the same jobs (restore/delete are not
    // idempotent). Reset happens in the finally below.
    flushInProgress = true
    try {
      if (!hasBackend()) {
        setSyncStatus('online_no_supabase')
        return
      }

      const connected = await checkSupabaseConnection()
      if (!connected) return

      const outcome = await runQueuePass()

      if (outcome.processed === 0) {
        setSyncStatus('synced')
        return
      }

      if (outcome.stopped) {
        // Re-probe (with backoff) before the next pass
        connectionVerified.current = false
        setSyncStatus('syncing')
      } else if (outcome.hasError) {
        setSyncStatus('error')
      } else if (outcome.hasRetry) {
        // Some items need retry - will be processed next cycle
        setSyncStatus('syncing')
      } else {
        setSyncStatus('synced')
      }
    } catch (err) {
      console.error('[SyncQueue] Flush error:', err)
      setSyncStatus('error')
    } finally {
      flushInProgress = false
    }
  }, [checkSupabaseConnection])

  // Monitor online/offline status
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleOnline = () => {
      setIsOnline(true)
      connectionVerified.current = false // Reset cache when coming online
      probeFailures.current = 0
      nextProbeAt.current = 0
      // Check connection when coming online
      setTimeout(async () => {
        if (hasBackend()) {
          const connected = await checkSupabaseConnection(true)
          if (connected) {
            // When coming back online, retry errored jobs first, then flush queued
            console.log('[SyncQueue] Back online - retrying errored jobs and flushing queue')
            await retryErrorsInternal({ force: true })
            flush()
          }
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
      if (hasBackend()) {
        checkSupabaseConnection(true).then(async (connected) => {
          if (connected) {
            // On initial load, retry errored jobs if any
            await retryErrorsInternal({ force: true })
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

  // Debounced flush - triggers 200ms after a sync_queue write, with 5s fallback poll.
  // Gated on the browser being online only: a failed probe ('offline'/'error')
  // must not stop the poll, otherwise sync stalls until a reload when the wifi is
  // up but the backend was briefly unreachable. Probes back off on their own.
  const flushTimerRef = useRef(null)

  useEffect(() => {
    if (!isOnline) return

    // Listen for 'sync-queue-write' custom event (dispatched when items are added to the queue)
    const handleQueueWrite = () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      flushTimerRef.current = setTimeout(() => {
        if (!flushInProgress) flush()
      }, 200)
    }
    window.addEventListener('sync-queue-write', handleQueueWrite)

    // Fallback poll every 5s to catch any missed items (e.g., tab focus, retries)
    const interval = setInterval(() => {
      if (!flushInProgress) flush()
    }, 5000)

    return () => {
      window.removeEventListener('sync-queue-write', handleQueueWrite)
      clearInterval(interval)
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
    }
  }, [isOnline, flush])

  // Auto-retry errored jobs (each on its own backoff) every 30 seconds when online
  useEffect(() => {
    if (!isOnline) return

    const interval = setInterval(async () => {
      if (!flushInProgress) {
        const hadErrors = await retryErrorsInternal()
        if (hadErrors) {
          // Trigger a flush to process the retried jobs
          flush()
        }
      }
    }, ERROR_RETRY_INTERVAL)

    return () => clearInterval(interval)
  }, [isOnline, flush])

  /**
   * Manual retry: reset all 'error' status jobs to 'queued' for immediate reprocessing
   */
  const retryErrors = useCallback(async () => {
    connectionVerified.current = false
    probeFailures.current = 0
    nextProbeAt.current = 0
    const hadErrors = await retryErrorsInternal({ force: true })
    if (hadErrors) {
      // Trigger a flush immediately
      flush()
    }
  }, [flush])

  return { flush, retryErrors, syncStatus, isOnline }
}
