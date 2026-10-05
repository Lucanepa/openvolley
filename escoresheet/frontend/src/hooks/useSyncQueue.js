import { useEffect, useCallback, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { apiFrom, apiMatchRestore, AUTH_TOKEN_CHANGE_EVENT, AUTH_TOKEN_STORAGE_KEY } from '../lib/apiClient'
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
 *   errored jobs come back with exponential backoff (capped at 10 min, never
 *   dropped). The due ones are requeued at the start of every flush.
 * - Refused by the backend (4xx: validation, scoping, permission) -> 'failed':
 *   resending the same payload cannot succeed, so it is not auto-retried. It is
 *   counted in the sync indicator and retried by hand ("Retry All") or after a
 *   sign-in.
 * - 401 (no or expired session): every cloud write needs an account. The job
 *   stays queued without counting an attempt, the status becomes
 *   'auth_required' and the queue waits for a sign-in (re-probed every 5 min).
 * - Rate limiting (429) and network failures stop the pass and leave jobs queued.
 * - Connection caching: Only recheck Supabase every 30 seconds; a failed probe is
 *   retried with backoff instead of stopping the poll.
 *
 * See also:
 * - db.js: sync_queue table schema
 * - Scoreboard.jsx: Event logging + live_state direct writes
 * ============================================================================
 */

// Sync status types: 'offline' | 'online_no_supabase' | 'connecting' | 'syncing' | 'synced' | 'error' | 'auth_required'

// Resource processing order - matches must be synced before sets/events (FK dependency)
const RESOURCE_ORDER = ['match', 'set', 'event']

// Max retries for jobs waiting on dependencies (e.g., event waiting for match to sync)
const MAX_DEPENDENCY_RETRIES = 10

// While the backend asks for a sign-in (401), a pass is retried only this often
// (in case the session was refreshed elsewhere); a sign-in retries at once.
const AUTH_RECHECK_MS = 5 * 60 * 1000

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
// processJob result: the backend wants a session (401). The job stays queued
// untouched and the pass stops: every other write would get the same answer.
export const AUTH_REQUIRED = 'auth_required'
// processJob result: the backend refused the request itself (4xx validation,
// scoping, permission). Parked as 'failed', never retried automatically.
export const PERMANENT_FAILURE = 'permanent'

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

const AUTH_ERROR_CODES = new Set(['missing_token', 'invalid_token', 'session_expired', 'not_authenticated'])

/** No session, or the session was rejected: the user has to sign in. */
export function isAuthError(error) {
  if (!error || error.network) return false
  return (error.status ?? 0) === 401 || AUTH_ERROR_CODES.has(error.code)
}

/**
 * The backend refused the request itself (400 validation such as
 * OV_UNSCOPED_EXTERNAL_ID, 403, 404, 406, 409, 413, 422 ...). Sending the same
 * payload again gives the same answer.
 */
export function isPermanentError(error) {
  if (!error || error.network) return false
  const status = error.status ?? 0
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 426 && status !== 429
}

// The reason of the last failure inside processJob, stored on the job so a
// parked job can be explained. Never carries the payload (PINs).
let lastJobError = null
function summarizeError(error) {
  if (!error) return null
  return {
    status: error.status ?? null,
    code: typeof error.code === 'string' ? error.code : null,
    message: String(error.message || '').slice(0, 200)
  }
}

const SECRET_LOG_KEY = /pin/i
/** A match payload for the console: PINs and connection_pins left out. */
export function redactForLog(payload) {
  if (!payload || typeof payload !== 'object') return payload
  return Object.fromEntries(Object.entries(payload).filter(([k]) => !SECRET_LOG_KEY.test(k)))
}

// apiFrom rejects (throws) when fetch itself fails. Matched on the message only:
// a programming TypeError must not be mistaken for being offline.
function isNetworkException(err) {
  return NETWORK_ERROR_MESSAGE.test(err?.message || '')
}

// Map an apiFrom error to a processJob result
function failureResult(error) {
  lastJobError = summarizeError(error)
  if (error?.network) return STOP_NETWORK
  if (isStopError(error)) return STOP_PASS
  if (isAuthError(error)) return AUTH_REQUIRED
  if (isTransientError(error)) return null
  if (isPermanentError(error)) return PERMANENT_FAILURE
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

// The payload field that identifies the row an update job writes
const UPDATE_IDENTITY = { match: 'id', set: 'external_id' }

// remainingAfterNewer keeps `id`; also keep the identity of non-match rows
function remainingFields(older, newer, idField) {
  const remaining = remainingAfterNewer(older, newer)
  if (idField in older) remaining[idField] = older[idField]
  return remaining
}

/**
 * Errored match/set updates vs newer updates of the same row that were already
 * sent: fields the newer ones wrote are removed from the stale job, and a job
 * left with nothing to write is marked 'superseded'.
 * @returns {Promise<Set<number>>} ids of the superseded jobs
 */
export async function supersedeStaleUpdates(errorJobs) {
  const superseded = new Set()
  for (const [resource, idField] of Object.entries(UPDATE_IDENTITY)) {
    const stale = errorJobs.filter(j => j.resource === resource && j.action === 'update' && j.payload?.[idField])
    if (stale.length === 0) continue
    const sentUpdates = await db.sync_queue
      .where('resource').equals(resource)
      .and(j => j.status === 'sent' && j.action === 'update')
      .toArray()
    // Fields that never carry data of their own
    const meta = new Set([idField, 'id', 'match_id', 'sport_type'])
    for (const job of stale) {
      const newer = sentUpdates.filter(s => s.id > job.id && s.payload?.[idField] === job.payload[idField])
      if (newer.length === 0) continue
      let remaining = job.payload
      for (const s of newer) remaining = remainingFields(remaining, s.payload, idField)
      if (Object.keys(remaining).every(k => meta.has(k))) {
        await db.sync_queue.update(job.id, { status: 'superseded' })
        superseded.add(job.id)
      } else if (!payloadCovers(remaining, job.payload)) {
        await db.sync_queue.update(job.id, { payload: remaining, superseded_fields: true })
      }
    }
  }
  return superseded
}

/**
 * Internal helper: Reset errored jobs to queued (non-hook function)
 * This can be called from within useEffect without dependency issues.
 * Automatic retries respect each job's backoff; `force` (manual retry, back
 * online) requeues every errored job now. `includeFailed` (manual retry,
 * sign-in) also requeues jobs the backend refused ('failed').
 */
export async function retryErrorsInternal({ force = false, includeFailed = false } = {}) {
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

    const errorJobs = await db.sync_queue.where('status').anyOf(includeFailed ? ['error', 'failed'] : ['error']).toArray()
    if (errorJobs.length === 0) return reclaimed > 0

    const superseded = await supersedeStaleUpdates(errorJobs)
    const due = errorJobs.filter(job => !superseded.has(job.id) &&
      (job.status === 'failed' || force || !job.next_attempt_at || job.next_attempt_at <= now))
    if (due.length === 0) return reclaimed > 0

    console.log(`[SyncQueue] ${force ? 'Retrying' : 'Auto-retrying'} ${due.length} errored jobs${superseded.size ? ` (${superseded.size} superseded)` : ''}`)
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

// Set when the backend answered 401: no pass runs (no request churn) until a
// sign-in, or until AUTH_RECHECK_MS has passed. Module level like
// flushInProgress, shared by every hook instance.
let authBlockedAt = 0
export function isAuthBlocked(now = Date.now()) {
  return authBlockedAt > 0 && now - authBlockedAt < AUTH_RECHECK_MS
}
export function clearAuthBlock() {
  authBlockedAt = 0
}

/**
 * A session appeared (sign-in here or in another tab): the queue may write
 * again. Everything parked because of the missing session, and the jobs the
 * backend refused (a 403 may have been the wrong account), is requeued now.
 */
export async function resumeAfterSignIn() {
  clearAuthBlock()
  const requeued = await retryErrorsInternal({ force: true, includeFailed: true })
  console.log(`[SyncQueue] Signed in - resuming sync${requeued ? ' (requeued parked jobs)' : ''}`)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('sync-queue-write'))
}

let _authListenerInstalled = false
function installAuthListener() {
  if (_authListenerInstalled || typeof window === 'undefined') return
  _authListenerInstalled = true
  const onSession = (session) => { if (session) resumeAfterSignIn() }
  window.addEventListener(AUTH_TOKEN_CHANGE_EVENT, (e) => onSession(e.detail))
  window.addEventListener('storage', (e) => {
    if (e.key === AUTH_TOKEN_STORAGE_KEY && e.newValue) onSession(e.newValue)
  })
}
installAuthListener()

/**
 * Process a single job.
 * Returns true (sent), false (error), null (retry later), STOP_PASS or DROP_JOB.
 */
export async function processJob(job) {
  lastJobError = null
  try {
    // Jobs queued before set/event ids were namespaced (or by a call site that
    // still sends the bare Dexie id) are rewritten before they reach the cloud.
    if (job.resource === 'set' || job.resource === 'event') {
      const resolved = await resolveJobExternalId(job, { sets: db.sets, matches: db.matches, events: db.events })
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

      console.log('[SyncQueue] Match insert payload:', redactForLog(matchPayload))
      const { error } = await apiFrom('matches')
        .upsert(matchPayload, { onConflict: 'external_id' })
      if (error) {
        console.error('[SyncQueue] Match insert error:', error, redactForLog(matchPayload))
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

      console.log('[SyncQueue] Match update payload:', redactForLog({ id, ...finalUpdateData }))
      const { error } = await apiFrom('matches')
        .update(finalUpdateData)
        .eq('external_id', id)
      if (error) {
        console.error('[SyncQueue] Match update error:', error, redactForLog(job.payload))
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
    // Backup restore: POST /api/match/restore runs it server-side in ONE
    // transaction (upsert the match BY external_id, replace THIS match's sets,
    // events and live state). Nothing half-restored is ever left behind; a
    // failure rolls back and the job is retried (local IndexedDB stays the source).
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
        // Old backup formats carry fields that are not columns; the server drops
        // unknown keys too, this keeps the payload small.
        const { data, error } = await apiMatchRestore({
          match: filterMatchPayload(match),
          sets: Array.isArray(sets) ? sets : [],
          events: Array.isArray(events) ? events : [],
          liveState: liveState || null
        })
        if (error) {
          console.error('[SyncQueue] Restore failed:', error.code || error.status, error.message, error.details || '')
          // 426 (old bundle), 429, 5xx and network errors: retry later
          return failureResult(error)
        }
        console.log('[SyncQueue] Restore complete for match:', externalId, data?.counts || '')
        if (data?.dropped && Object.keys(data.dropped).length) {
          console.warn('[SyncQueue] Restore: server dropped unknown keys:', data.dropped)
        }
        return true
      } catch (restoreErr) {
        console.error('[SyncQueue] Restore exception:', restoreErr)
        lastJobError = summarizeError(restoreErr)
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
    console.error('[SyncQueue] Job processing error:', err, job.resource, job.action)
    lastJobError = summarizeError(err)
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

// Match creation/replacement jobs: nothing else of that match may overtake them.
function blocksWholeMatch(job) {
  return job.resource === 'match' && job.action !== 'update'
}

/**
 * Per-entity FIFO across passes. Jobs parked as 'error' (waiting out their
 * backoff) or claimed as 'sending' (useSequentialSync, in flight) are not in
 * this pass, but newer queued jobs of the same entity must still wait for them:
 * otherwise a set update runs before its failed insert (0 rows), and the insert
 * retried later writes 0-0 over the real score.
 *
 * Errored *updates* only hold back newer jobs while 'sending'; once parked as
 * 'error' or 'failed' they are trimmed against newer sent updates on retry
 * (supersedeStaleUpdates), so a permanently failing update cannot stall the
 * entity forever. A 'failed' insert keeps holding its entity back: what comes
 * after it has nothing to attach to in the cloud.
 *
 * @returns {Map<string, number>} entity key -> id of the oldest pending job;
 *   queued jobs with a higher id are held back.
 */
export function pendingEntityBlocks(pendingJobs) {
  const blocks = new Map()
  const add = (key, id) => {
    if (!blocks.has(key) || blocks.get(key) > id) blocks.set(key, id)
  }
  for (const job of pendingJobs) {
    if ((job.status === 'error' || job.status === 'failed') && job.action === 'update') continue
    add(entityKey(job), job.id)
    const matchKey = jobMatchKey(job)
    if (matchKey && blocksWholeMatch(job)) add(`whole:${matchKey}`, job.id)
  }
  return blocks
}

/**
 * One pass over the queued jobs, in dependency order.
 * @returns {Promise<{ processed: number, sent: number, hasError: boolean, hasFailed: boolean, hasRetry: boolean, stopped: boolean, authRequired: boolean }>}
 */
export async function runQueuePass() {
  const queued = await db.sync_queue.where('status').equals('queued').toArray()
  const outcome = { processed: queued.length, sent: 0, hasError: false, hasFailed: false, hasRetry: false, stopped: false, authRequired: false }
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

  // Failures in this pass block unconditionally; older jobs still waiting as
  // 'error'/'sending' block only queued jobs newer than themselves.
  const blocked = new Set()
  let pendingBlocks = new Map()
  try {
    const pending = await db.sync_queue.where('status').anyOf('error', 'failed', 'sending').toArray()
    pendingBlocks = pendingEntityBlocks(pending)
  } catch (err) {
    console.warn('[SyncQueue] Could not read pending jobs for ordering:', err?.message)
  }
  const isHeldBack = (key, jobId) => blocked.has(key) || (pendingBlocks.has(key) && pendingBlocks.get(key) < jobId)

  // Process in dependency order
  for (const resource of RESOURCE_ORDER) {
    const jobs = (jobsByResource[resource] || []).sort((a, b) => a.id - b.id)

    for (const job of jobs) {
      const key = entityKey(job)
      const matchKey = jobMatchKey(job)
      if (isHeldBack(key, job.id) || (matchKey && isHeldBack(`whole:${matchKey}`, job.id))) {
        // An earlier job for this entity/match failed or is still pending: keep order
        outcome.hasRetry = true
        continue
      }

      const result = await processJob(job)

      if (result === true) {
        await db.sync_queue.update(job.id, { status: 'sent', retry_count: 0, network_stops: 0, last_error: null })
        outcome.sent++
        continue
      }

      if (result === AUTH_REQUIRED) {
        // No session: every write gets the same 401. Leave the job queued as it
        // is (no attempt counted) and wait for a sign-in.
        outcome.stopped = true
        outcome.hasRetry = true
        outcome.authRequired = true
        return outcome
      }

      if (result === DROP_JOB) {
        await db.sync_queue.update(job.id, { status: 'dropped' })
        continue
      }

      // Everything below leaves the entity unsynced: block its later jobs. A
      // set/event that must wait (match not in the cloud yet) holds back the
      // rest of its match too, instead of every job repeating the same lookup.
      blocked.add(key)
      if (matchKey && (blocksWholeMatch(job) || (job.resource !== 'match' && result === null))) {
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

      if (result === PERMANENT_FAILURE) {
        // Refused by the backend: the same payload would be refused again
        console.warn(`[SyncQueue] Job ${job.id} (${job.resource} ${job.action}) refused by the backend, not retried automatically:`, lastJobError?.code || lastJobError?.status)
        await db.sync_queue.update(job.id, {
          status: 'failed',
          attempts: (job.attempts || 0) + 1,
          failed_at: Date.now(),
          last_error: lastJobError
        })
        outcome.hasError = true
        outcome.hasFailed = true
      } else if (result === false) {
        const attempts = (job.attempts || 0) + 1
        await db.sync_queue.update(job.id, {
          status: 'error',
          attempts,
          next_attempt_at: Date.now() + errorBackoffMs(attempts),
          last_error: lastJobError
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
        // Request never reached the backend (offline, timeout)
        if (error.network) return probeFailed('offline')
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

      // Waiting for a sign-in: no request until then (or the periodic recheck)
      if (isAuthBlocked()) {
        setSyncStatus('auth_required')
        return
      }

      // Errored jobs whose backoff has passed go back into this pass. Done here,
      // inside the flush claim: a separate timer always found a flush running
      // (its 30 s period was a multiple of the 5 s poll) and never retried.
      await retryErrorsInternal()

      const outcome = await runQueuePass()

      if (outcome.authRequired) {
        authBlockedAt = Date.now()
        setSyncStatus('auth_required')
        return
      }
      clearAuthBlock()

      if (outcome.sent > 0 && !outcome.stopped && typeof window !== 'undefined') {
        // Consumers that push state outside the queue (match_live_state) catch up
        window.dispatchEvent(new CustomEvent('sync-queue-drained', { detail: { sent: outcome.sent, pending: outcome.hasRetry } }))
      }

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

  // Errored jobs are retried by flush() itself (every poll, each on its own
  // backoff); see the comment there.

  /**
   * Manual retry: reset all 'error' and 'failed' jobs to 'queued' for immediate
   * reprocessing, and probe for a session again.
   */
  const retryErrors = useCallback(async () => {
    connectionVerified.current = false
    probeFailures.current = 0
    nextProbeAt.current = 0
    clearAuthBlock()
    await retryErrorsInternal({ force: true, includeFailed: true })
    // Flush even with nothing requeued: a queue waiting for a sign-in resumes too
    flush()
  }, [flush])

  return { flush, retryErrors, syncStatus, isOnline }
}

/**
 * Counts for the sync indicator: pending (queued or in flight), error (failed,
 * retried with backoff) and failed (refused by the backend, needs a manual
 * retry). Test matches never enter the queue.
 */
export async function getSyncQueueStats() {
  const [pending, error, failed] = await Promise.all([
    db.sync_queue.where('status').anyOf('queued', 'sending').count(),
    db.sync_queue.where('status').equals('error').count(),
    db.sync_queue.where('status').equals('failed').count()
  ])
  return { pending, error, failed }
}

const EMPTY_STATS = { pending: 0, error: 0, failed: 0 }

/** Live sync queue counts (see getSyncQueueStats); zeros until the first read. */
export function useSyncQueueStats() {
  return useLiveQuery(() => getSyncQueueStats().catch(() => EMPTY_STATS), [], EMPTY_STATS)
}
