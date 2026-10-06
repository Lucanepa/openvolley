import { useEffect, useCallback, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { apiFrom, apiMatchRestore, apiMatchClaim, AUTH_TOKEN_CHANGE_EVENT, AUTH_TOKEN_STORAGE_KEY } from '../lib/apiClient'
import { getApiUrl } from '../utils/backendConfig'
import { filterMatchPayload, JSONB_COLUMNS } from '../db/matchRepository'
import { parseExtId, resolveJobExternalId, jobMatchKey, USER_MATCH_RESOURCE, userMatchRoles, userMatchJob } from '../utils/syncIds'
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
 * - Refused by the backend (a 4xx carrying an application error code: OV_*,
 *   PGRST*, a Postgres SQLSTATE) -> 'failed': resending the same payload cannot
 *   succeed, so it is retried only at app start, once an hour (at most
 *   FAILED_AUTO_RETRY_MAX times), by hand ("Retry All") or after a sign-in.
 * - A 4xx WITHOUT such a code did not come from the backend's own checks (a
 *   proxy/WAF page during a deploy, a misrouted URL): the job is parked as
 *   'error' with backoff and the pass stops, as for a network failure.
 * - Sent/superseded/dropped rows are pruned after SENT_RETENTION_MS.
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

// Resource processing order - matches must be synced before sets/events (FK
// dependency); the account links ("My Matches") come last
const RESOURCE_ORDER = ['match', 'set', 'event', USER_MATCH_RESOURCE]

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

// Jobs the backend refused ('failed') come back on their own once an hour, at
// most this many times (and at every app start): a refusal can be temporary
// (wrong account, a backend fix deployed), and the cloud copy must not depend
// on someone clicking "Retry All".
const FAILED_RETRY_MS = 60 * 60 * 1000
const FAILED_AUTO_RETRY_MAX = 24

// The requeue step of flush (errored jobs whose backoff passed, abandoned
// 'sending' jobs) runs at most this often; flush itself runs on every write.
const REQUEUE_INTERVAL_MS = 30000

// Sent, superseded and dropped rows are kept this long (for debugging), then
// pruned; the per-rally set score adds one row per point.
const SENT_RETENTION_MS = 7 * 24 * 3600 * 1000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

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
// scoping, permission). Parked as 'failed' (see FAILED_RETRY_MS).
export const PERMANENT_FAILURE = 'permanent'
// processJob result: a 4xx that did not come from the backend's own checks (no
// application error code: proxy/WAF page, misrouted URL). Parked as 'error'
// with backoff, and the pass stops: the next job would most likely get the same.
export const STOP_ERROR = 'stop_error'

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

// Error codes only the OpenVolley backend answers with: its own checks (OV_*),
// the PostgREST-shaped ones (PGRST116 ...) and Postgres SQLSTATEs (23505 ...).
// apiClient sets no code when the error body was not JSON.
const APPLICATION_ERROR_CODE = /^(OV_[A-Z0-9_]+|PGRST\d+|[0-9A-Z]{5})$/

/** The error came from the backend's own checks (it carries an application code). */
export function hasApplicationErrorCode(error) {
  return typeof error?.code === 'string' && APPLICATION_ERROR_CODE.test(error.code)
}

/** A 4xx other than the transient/auth ones (401, 408, 426, 429). */
function isRefusalStatus(error) {
  if (!error || error.network) return false
  const status = error.status ?? 0
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 426 && status !== 429
}

/**
 * The backend refused the request itself (400 validation such as
 * OV_UNSCOPED_EXTERNAL_ID, 406 PGRST116, a SQLSTATE ...). Sending the same
 * payload again gives the same answer. A 4xx without an application code (a
 * proxy or WAF page, a misrouted URL) is not one: see isForeignClientError.
 */
export function isPermanentError(error) {
  return isRefusalStatus(error) && hasApplicationErrorCode(error)
}

/** A 4xx that did not come from the backend's checks (no application code). */
export function isForeignClientError(error) {
  return isRefusalStatus(error) && !hasApplicationErrorCode(error)
}

// Reason of a job's last failure (by job id), stored on the job so a parked job
// can be explained. Never carries the payload (PINs). Kept per job, not in one
// shared variable: a direct send (useSequentialSync) can run while a queue pass
// is in flight.
const jobErrors = new Map()

/** The failure reason processJob recorded for this job (read once). */
export function takeJobError(jobId) {
  const error = jobErrors.get(jobId) ?? null
  jobErrors.delete(jobId)
  return error
}

function summarizeError(error) {
  if (!error) return null
  return {
    status: error.status ?? null,
    code: typeof error.code === 'string' ? error.code : null,
    message: String(error.message || '').slice(0, 200)
  }
}

// A PIN field: 'pin' as a word of the key (game_pin, gamePin, connection_pins,
// homeTeamUploadPin, PIN), not any key that contains the letters (mapping).
const isSecretLogKey = (key) =>
  /(^|_)pins?(_|$)/.test(String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())

// PIN values inside text: `Key (game_pin)=(123456)` from a unique violation,
// `"refereePin":"123456"` in a serialized body.
const PIN_IN_TEXT = /(pins?(?![a-z])[^\d\n]{0,24}?)\d{4,8}/gi
const redactText = (text) => text.replace(PIN_IN_TEXT, '$1[redacted]')

const LOG_REDACT_DEPTH = 6

/**
 * A value for the console (and so for uploaded logs): PIN fields left out at
 * any depth (game_pin, connection_pins, refereePin, ...), PIN values in error
 * texts masked. Anything else is passed through unchanged.
 */
export function redactForLog(value, depth = 0) {
  if (typeof value === 'string') return redactText(value)
  if (!value || typeof value !== 'object' || depth > LOG_REDACT_DEPTH) return value
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1))
  if (value instanceof Error) {
    const message = redactText(String(value.message || ''))
    return message === value.message ? value : { name: value.name, message }
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (!isSecretLogKey(k)) out[k] = redactForLog(v, depth + 1)
  }
  return out
}

// Every console line of the sync queue goes through redactForLog: job payloads
// and backend errors can carry game_pin / connection_pins.
const safeLog = {
  log: (...args) => console.log(...args.map((a) => redactForLog(a))),
  warn: (...args) => console.warn(...args.map((a) => redactForLog(a))),
  // A 401 (signed out, session expired) is an expected state the queue waits
  // out ('auth_required'), not an error worth a red console line
  error: (...args) => (args.some((a) => a && typeof a === 'object' && isAuthError(a)) ? console.warn : console.error)(...args.map((a) => redactForLog(a)))
}

// apiFrom rejects (throws) when fetch itself fails. Matched on the message only:
// a programming TypeError must not be mistaken for being offline.
function isNetworkException(err) {
  return NETWORK_ERROR_MESSAGE.test(err?.message || '')
}

// Map an apiFrom error to a processJob result; the reason goes on `ctx`
function failureResult(error, ctx) {
  if (ctx) ctx.error = summarizeError(error)
  if (error?.network) return STOP_NETWORK
  if (isStopError(error)) return STOP_PASS
  if (isAuthError(error)) return AUTH_REQUIRED
  if (isTransientError(error)) return null
  if (isPermanentError(error)) return PERMANENT_FAILURE
  if (isForeignClientError(error)) return STOP_ERROR
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

/** A 'failed' job (refused by the backend) due for its hourly automatic retry. */
function isFailedJobDue(job, now) {
  if ((job.failed_auto_retries || 0) >= FAILED_AUTO_RETRY_MAX) return false
  return !job.failed_at || now - job.failed_at >= FAILED_RETRY_MS || now < job.failed_at
}

/**
 * Internal helper: Reset errored jobs to queued (non-hook function)
 * This can be called from within useEffect without dependency issues.
 * Automatic retries respect each job's backoff; `force` (manual retry, back
 * online) requeues every errored job now. Jobs the backend refused ('failed')
 * come back once an hour (at most FAILED_AUTO_RETRY_MAX times), or at once with
 * `includeFailed` (manual retry, sign-in, app start).
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

    const errorJobs = await db.sync_queue.where('status').anyOf(['error', 'failed']).toArray()
    if (errorJobs.length === 0) return reclaimed > 0

    // Only the due jobs are trimmed against newer sent updates (that scan grows
    // with the queue history; jobs still waiting out a backoff skip it)
    const due = errorJobs.filter(job => job.status === 'failed'
      ? includeFailed || isFailedJobDue(job, now)
      : force || !job.next_attempt_at || job.next_attempt_at <= now)
    if (due.length === 0) return reclaimed > 0

    const superseded = await supersedeStaleUpdates(due)
    const requeue = due.filter(job => !superseded.has(job.id))
    if (requeue.length === 0) return reclaimed > 0 || superseded.size > 0

    safeLog.log(`[SyncQueue] ${force || includeFailed ? 'Retrying' : 'Auto-retrying'} ${requeue.length} errored jobs${superseded.size ? ` (${superseded.size} superseded)` : ''}`)
    for (const job of requeue) {
      const changes = { status: 'queued', retry_count: 0 }
      if (job.status === 'failed') {
        changes.failed_auto_retries = includeFailed ? 0 : (job.failed_auto_retries || 0) + 1
      }
      await db.sync_queue.update(job.id, changes)
    }
    return true
  } catch (err) {
    safeLog.error('[SyncQueue] Auto-retry errors failed:', err)
    return false
  }
}

/**
 * Remove sent, superseded and dropped rows older than `retentionMs`. Rows newer
 * than the oldest job still pending are kept whatever their age: the supersede
 * step of a retried job compares it with the updates sent after it.
 * @returns {Promise<number>} rows removed
 */
export async function pruneSyncQueue({ retentionMs = SENT_RETENTION_MS, now = Date.now() } = {}) {
  try {
    const pending = await db.sync_queue.where('status').anyOf(['queued', 'sending', 'error', 'failed']).toArray()
    const oldestPendingId = pending.reduce((min, j) => Math.min(min, j.id), Infinity)
    const done = await db.sync_queue.where('status').anyOf(['sent', 'superseded', 'dropped']).toArray()
    const ids = done
      .filter(j => {
        if (j.id >= oldestPendingId) return false
        // ts is a number (Date.now()) or an ISO string, depending on the writer
        const ts = typeof j.ts === 'number' ? j.ts : Date.parse(j.ts)
        return Number.isFinite(ts) && now - ts > retentionMs
      })
      .map(j => j.id)
    if (ids.length > 0) await db.sync_queue.bulkDelete(ids)
    return ids.length
  } catch (err) {
    safeLog.warn('[SyncQueue] Could not prune the sync queue:', err?.message)
    return 0
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
  safeLog.log(`[SyncQueue] Signed in - resuming sync${requeued ? ' (requeued parked jobs)' : ''}`)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('sync-queue-write'))
}

let _authListenerInstalled = false
function installAuthListener() {
  if (_authListenerInstalled || typeof window === 'undefined') return
  _authListenerInstalled = true
  const onSession = (session) => { if (session) resumeAfterSignIn() }
  window.addEventListener(AUTH_TOKEN_CHANGE_EVENT, (e) => onSession(e.detail))
  // Another tab signed in. Only a new session (no old value): another tab
  // refreshing the stored session's expiry is not a sign-in.
  window.addEventListener('storage', (e) => {
    if (e.key === AUTH_TOKEN_STORAGE_KEY && e.newValue && !e.oldValue) onSession(e.newValue)
  })
}
installAuthListener()

/**
 * Process a single job.
 * Returns true (sent), false (error), null (retry later), STOP_PASS,
 * STOP_NETWORK, STOP_ERROR, AUTH_REQUIRED, PERMANENT_FAILURE or DROP_JOB. The
 * failure reason is available once through takeJobError(job.id).
 *
 * A write refused as OV_NOT_MATCH_OWNER is taken over here (once per match
 * and CLAIM_RETRY_MS, see claimMatchWithLocalPin) and sent again, for the
 * background queue and the direct set-end / match-end syncs (sendJobNow)
 * alike. After a successful take-over the match's other parked jobs are
 * queued again.
 */
export async function processJob(job) {
  let result = await processJobOnce(job)
  if (result === PERMANENT_FAILURE && jobErrors.get(job?.id)?.code === 'OV_NOT_MATCH_OWNER') {
    const matchKey = jobMatchKey(job)
    if (matchKey && claimDue(matchKey) && await claimMatchWithLocalPin(matchKey)) {
      result = await processJobOnce(job)
      if (result === true) await requeueParkedJobsOf(matchKey, job.id)
    }
  }
  return result
}

async function processJobOnce(job) {
  const ctx = { error: null }
  const result = await processJobInner(job, ctx)
  if (ctx.error && job?.id != null) jobErrors.set(job.id, ctx.error)
  else if (job?.id != null) jobErrors.delete(job.id)
  return result
}

// Take-overs tried per match key (one per CLAIM_RETRY_MS: a refused one is not
// repeated by every job of the match)
const CLAIM_RETRY_MS = 60 * 1000
const claimAttempts = new Map()
function claimDue(matchKey, now = Date.now()) {
  const last = claimAttempts.get(matchKey)
  if (last !== undefined && now - last < CLAIM_RETRY_MS) return false
  if (claimAttempts.size >= 200) claimAttempts.delete(claimAttempts.keys().next().value)
  claimAttempts.delete(matchKey)
  claimAttempts.set(matchKey, now)
  return true
}

/** After a take-over: the match's jobs parked as refused go back to the queue. */
async function requeueParkedJobsOf(matchKey, exceptId) {
  try {
    const parked = await db.sync_queue.where('status').equals('failed').toArray()
    for (const j of parked) {
      if (j.id !== exceptId && jobMatchKey(j) === matchKey) {
        await db.sync_queue.update(j.id, { status: 'queued', retry_count: 0 })
      }
    }
  } catch (err) {
    safeLog.warn('[SyncQueue] Could not requeue the parked jobs of a match taken over:', err?.message)
  }
}

async function processJobInner(job, ctx) {
  try {
    // Jobs queued before set/event ids were namespaced (or by a call site that
    // still sends the bare Dexie id) are rewritten before they reach the cloud.
    if (job.resource === 'set' || job.resource === 'event') {
      const resolved = await resolveJobExternalId(job, { sets: db.sets, matches: db.matches, events: db.events })
      if (resolved?.drop) {
        safeLog.warn('[SyncQueue] Dropping job that cannot be attributed to a match:', job.resource, job.payload?.external_id)
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

      safeLog.log('[SyncQueue] Match insert payload:', redactForLog(matchPayload))
      const { error } = await apiFrom('matches')
        .upsert(matchPayload, { onConflict: 'external_id' })
      if (error) {
        safeLog.error('[SyncQueue] Match insert error:', error, redactForLog(matchPayload))
        return failureResult(error, ctx)
      }
      safeLog.log('[SyncQueue] Match insert successful')
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
          safeLog.error('[SyncQueue] Match fetch for merge error:', fetchError)
          // Do not overwrite JSON columns blind when the backend is struggling
          if (isStopError(fetchError) || isTransientError(fetchError)) return failureResult(fetchError, ctx)
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

      safeLog.log('[SyncQueue] Match update payload:', redactForLog({ id, ...finalUpdateData }))
      const { error } = await apiFrom('matches')
        .update(finalUpdateData)
        .eq('external_id', id)
      if (error) {
        safeLog.error('[SyncQueue] Match update error:', error, redactForLog(job.payload))
        return failureResult(error, ctx)
      }
      safeLog.log('[SyncQueue] Match update successful')
      return true
    }

    if (job.resource === 'match' && job.action === 'delete') {
      const { id } = job.payload
      safeLog.log('[SyncQueue] 🗑️ Starting match delete for external_id:', id)

      // First, look up the match to get its UUID
      const { data: matchData, error: lookupError } = await apiFrom('matches')
        .select('id')
        .eq('external_id', id)
        .maybeSingle()

      if (lookupError) {
        safeLog.error('[SyncQueue] Match lookup error:', lookupError, job.payload)
        return failureResult(lookupError, ctx)
      }

      if (!matchData) {
        // Match doesn't exist in Supabase, consider it successfully deleted
        safeLog.log('[SyncQueue] Match not found in Supabase (already deleted?):', id)
        return true
      }

      const matchUuid = matchData.id
      safeLog.log('[SyncQueue] 🔍 Found match UUID:', matchUuid)

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
      safeLog.log('[SyncQueue] 📊 Records before delete:', {
        events: eventsCountBefore,
        sets: setsCountBefore,
        match_live_state: liveStateCountBefore
      })

      // Delete events for this match
      safeLog.log('[SyncQueue] 🗑️ Deleting events...')
      const { error: eventsError } = await apiFrom('events')
        .delete()
        .eq('match_id', matchUuid)
        .select('*', { count: 'exact', head: true })
      if (eventsError) {
        safeLog.warn('[SyncQueue] Events delete error (continuing):', eventsError)
      } else {
        safeLog.log('[SyncQueue] ✅ Events deleted')
      }

      // Delete sets for this match
      safeLog.log('[SyncQueue] 🗑️ Deleting sets...')
      const { error: setsError } = await apiFrom('sets')
        .delete()
        .eq('match_id', matchUuid)
      if (setsError) {
        safeLog.warn('[SyncQueue] Sets delete error (continuing):', setsError)
      } else {
        safeLog.log('[SyncQueue] ✅ Sets deleted')
      }

      // Delete match_live_state for this match
      safeLog.log('[SyncQueue] 🗑️ Deleting match_live_state...')
      const { error: liveStateError } = await apiFrom('match_live_state')
        .delete()
        .eq('match_id', matchUuid)
      if (liveStateError) {
        safeLog.warn('[SyncQueue] match_live_state delete error (continuing):', liveStateError)
      } else {
        safeLog.log('[SyncQueue] ✅ match_live_state deleted')
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
      safeLog.log('[SyncQueue] 📊 Records after delete:', {
        events: eventsCountAfter,
        sets: setsCountAfter,
        match_live_state: liveStateCountAfter
      })

      // If any records remain, warn but continue
      if (eventsCountAfter > 0 || setsCountAfter > 0 || liveStateCountAfter > 0) {
        safeLog.warn('[SyncQueue] ⚠️ Some records were not deleted (RLS issue?). Attempting match delete anyway...')
      }

      // Delete the match
      safeLog.log('[SyncQueue] 🗑️ Deleting match...')
      const { error: matchError } = await apiFrom('matches')
        .delete()
        .eq('id', matchUuid)
      if (matchError) {
        safeLog.error('[SyncQueue] Match delete error:', matchError, job.payload)
        return failureResult(matchError, ctx)
      }

      safeLog.log('[SyncQueue] ✅ Deleted match and related records from Supabase:', id)
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
        safeLog.error('[SyncQueue] Restore failed: missing external_id in match payload')
        return false
      }

      const externalId = match.external_id
      safeLog.log('[SyncQueue] Processing restore job for match:', externalId)

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
          safeLog.error('[SyncQueue] Restore failed:', error.code || error.status, error.message, error.details || '')
          // 426 (old bundle), 429, 5xx and network errors: retry later
          return failureResult(error, ctx)
        }
        safeLog.log('[SyncQueue] Restore complete for match:', externalId, data?.counts || '')
        if (data?.dropped && Object.keys(data.dropped).length) {
          safeLog.warn('[SyncQueue] Restore: server dropped unknown keys:', data.dropped)
        }
        return true
      } catch (restoreErr) {
        safeLog.error('[SyncQueue] Restore exception:', restoreErr)
        ctx.error = summarizeError(restoreErr)
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

        if (lookupError) return failureResult(lookupError, ctx)
        if (!matchData) {
          // Match not yet synced - keep job queued for retry
          return null // null means "retry later"
        }
        setPayload.match_id = matchData.id
      }

      const { error } = await apiFrom('sets')
        .upsert(setPayload, { onConflict: 'external_id' })
      if (error) {
        safeLog.error('[SyncQueue] Set insert error:', error, setPayload)
        return failureResult(error, ctx)
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
        if (lookupError) return failureResult(lookupError, ctx)
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
        safeLog.error('[SyncQueue] Set update error:', error, job.payload)
        return failureResult(error, ctx)
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

        if (lookupError) return failureResult(lookupError, ctx)
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
        safeLog.error('[SyncQueue] Event insert error:', error, eventPayload)
        return failureResult(error, ctx)
      }
      return true
    }

    // ==================== USER MATCH (My Matches) ====================
    if (job.resource === USER_MATCH_RESOURCE && job.action === 'upsert') {
      const { user_id: owner, match_external_id: matchKey, role, sport_type: sportType } = job.payload || {}
      if (!matchKey || !role) return DROP_JOB
      // The backend links the row to whoever is signed in: never attach this
      // match to another account that signed in on this device meanwhile.
      const current = storedSessionUserId()
      if (owner && current && current !== owner) {
        console.warn('[SyncQueue] Dropping a My Matches link queued for another account')
        return DROP_JOB
      }
      const { error } = await apiFrom('user_matches')
        .upsert({ match_external_id: matchKey, role, sport_type: sportType || 'indoor' }, { onConflict: 'user_id,match_external_id,role' })
      if (error) {
        console.warn('[SyncQueue] My Matches link error:', error.code || error.status || error.message)
        return failureResult(error, ctx)
      }
      return true
    }

    // Unknown resource/action - mark as done to avoid infinite loop
    safeLog.warn('[SyncQueue] Unknown job type:', job.resource, job.action)
    return true

  } catch (err) {
    safeLog.error('[SyncQueue] Job processing error:', err, job.resource, job.action)
    ctx.error = summarizeError(err)
    return isNetworkException(err) ? STOP_NETWORK : false
  }
}

// Keys a failed job blocks for the rest of the pass (per-entity FIFO). A failed
// match insert/restore/delete blocks every job of that match; a failed update
// only blocks later updates of the same entity.
function entityKey(job) {
  if (job.resource === 'match') return `match:${jobMatchKey(job)}`
  if (job.resource === USER_MATCH_RESOURCE) return `${job.resource}:${jobMatchKey(job)}:${job.payload?.role}`
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
 * Take-over after a 403 OV_NOT_MATCH_OWNER: the cloud copy of this match was
 * created by another account (another account signed in on this device, a
 * match restored here, a second scoring device). This device holds the
 * match's game PIN, which the backend accepts as proof (POST /api/match/claim):
 * the signed-in account becomes an editor and the write can be retried.
 * @returns {Promise<boolean>} true when the backend granted access
 */
export async function claimMatchWithLocalPin(seedKey, { findLocal = findLocalMatchBySeed, claim = apiMatchClaim } = {}) {
  if (!seedKey) return false
  const local = await findLocal(seedKey)
  const pin = local?.gamePin ?? local?.game_pin
  if (pin === undefined || pin === null || String(pin).trim() === '') return false
  try {
    const { error, status } = await claim(seedKey, String(pin).trim())
    if (error) {
      safeLog.warn('[SyncQueue] Take-over of the cloud match refused:', error.code || status)
      return false
    }
    safeLog.log('[SyncQueue] This account may now write the cloud copy of', seedKey)
    return true
  } catch {
    return false
  }
}

/**
 * One pass over the queued jobs, in dependency order.
 * @returns {Promise<{ processed: number, sent: number, hasError: boolean, hasFailed: boolean, hasRetry: boolean, stopped: boolean, authRequired: boolean }>}
 */
export async function runQueuePass() {
  const queued = await db.sync_queue.where('status').equals('queued').toArray()
  const outcome = { processed: queued.length, sent: 0, hasError: false, hasFailed: false, hasRetry: false, stopped: false, authRequired: false }
  if (queued.length === 0) return outcome

  safeLog.log(`[SyncQueue] Processing ${queued.length} queued items`)

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
    safeLog.warn('[SyncQueue] Could not read pending jobs for ordering:', err?.message)
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

      // processJob takes the match over when the write is refused for ownership
      const result = await processJob(job)
      const jobError = takeJobError(job.id)

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

      if (result === STOP_ERROR) {
        // A 4xx from something in front of the backend (proxy/WAF page, no
        // application code): back off this job and stop the pass, the next job
        // would most likely get the same page.
        const attempts = (job.attempts || 0) + 1
        safeLog.warn(`[SyncQueue] Job ${job.id} (${job.resource} ${job.action}) got a ${jobError?.status} without a backend error code; retrying later`)
        await db.sync_queue.update(job.id, {
          status: 'error',
          attempts,
          next_attempt_at: Date.now() + errorBackoffMs(attempts),
          last_error: jobError
        })
        outcome.stopped = true
        outcome.hasError = true
        return outcome
      }

      if (result === PERMANENT_FAILURE) {
        // Refused by the backend: the same payload would be refused again
        safeLog.warn(`[SyncQueue] Job ${job.id} (${job.resource} ${job.action}) refused by the backend, retried only hourly or by hand:`, jobError?.code || jobError?.status)
        await db.sync_queue.update(job.id, {
          status: 'failed',
          attempts: (job.attempts || 0) + 1,
          failed_at: Date.now(),
          last_error: jobError
        })
        outcome.hasError = true
        outcome.hasFailed = true
      } else if (result === false) {
        const attempts = (job.attempts || 0) + 1
        await db.sync_queue.update(job.id, {
          status: 'error',
          attempts,
          next_attempt_at: Date.now() + errorBackoffMs(attempts),
          last_error: jobError
        })
        outcome.hasError = true
      } else {
        // null: retry later - increment retry count
        const currentRetries = job.retry_count || 0
        if (currentRetries >= MAX_DEPENDENCY_RETRIES) {
          // Park as error; the auto-retry brings it back with backoff
          safeLog.warn(`[SyncQueue] Job ${job.id} (${job.resource}) exceeded max retries, marking as error`)
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

// Last run of flush's throttled housekeeping (requeue of errored jobs, prune)
let lastRequeueAt = 0
let lastPruneAt = 0
// 'failed' jobs are requeued once per page load (the first connected mount)
let startupFailedRetryDone = false
// A clock that went backwards (device time corrected) counts as due
function isDue(last, interval, now) {
  return !last || now - last >= interval || now < last
}
/** Forget the housekeeping timestamps (tests; also a sign-in retries at once). */
export function resetQueueHousekeeping() {
  lastRequeueAt = 0
  lastPruneAt = 0
  claimAttempts.clear()
}

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
        safeLog.error('[SyncQueue] Connection check error:', error)
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
      safeLog.error('[SyncQueue] Connection check exception:', err)
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

      // No session on this device: every write would come back 401, so none
      // is sent. The queue resumes on sign-in (installAuthListener).
      if (!hasStoredSessionToken()) {
        const waiting = await db.sync_queue.where('status').equals('queued').count()
        setSyncStatus(waiting > 0 ? 'auth_required' : 'synced')
        return
      }

      // Errored jobs whose backoff has passed go back into this pass. Done here,
      // inside the flush claim: a separate timer always found a flush running
      // (its 30 s period was a multiple of the 5 s poll) and never retried.
      // Throttled: flush runs 200 ms after every queued write (every rally).
      const now = Date.now()
      if (isDue(lastRequeueAt, REQUEUE_INTERVAL_MS, now)) {
        lastRequeueAt = now
        await retryErrorsInternal()
      }
      if (isDue(lastPruneAt, PRUNE_INTERVAL_MS, now)) {
        lastPruneAt = now
        await pruneSyncQueue({ now })
      }

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
      safeLog.error('[SyncQueue] Flush error:', err)
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
            safeLog.log('[SyncQueue] Back online - retrying errored jobs and flushing queue')
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
            // On initial load, retry errored jobs if any; once per page load
            // also the ones the backend refused (a fix may have been deployed)
            const includeFailed = !startupFailedRetryDone
            startupFailedRetryDone = true
            await retryErrorsInternal({ force: true, includeFailed })
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

// ---------------------------------------------------------------------------
// My Matches: link the signed-in account to the match it scores
// ---------------------------------------------------------------------------

function readStoredJson(key) {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/**
 * Id of the account whose session is stored on this device (unexpired), or
 * null. Read from storage, not from the auth context: it also works offline
 * and outside React, and it is the session the queue's requests carry.
 */
export function storedSessionUserId() {
  const session = readStoredJson(AUTH_TOKEN_STORAGE_KEY)
  if (!session?.access_token) return null
  if (session.expires_at && Date.now() / 1000 > session.expires_at) return null
  return session.user?.id || null
}

/**
 * Is a session token stored on this device (unexpired)? Without one the
 * queue sends nothing: the backend answers every write with 401.
 */
export function hasStoredSessionToken() {
  const session = readStoredJson(AUTH_TOKEN_STORAGE_KEY)
  if (!session?.access_token) return false
  return !(session.expires_at && Date.now() / 1000 > session.expires_at)
}

/**
 * Queue the user_matches links of the signed-in account for a match (role
 * 'scorer', plus the officials roles carrying the account's name, see
 * userMatchRoles). Through the sync queue, so it works offline and is sent
 * after the match itself. Only official matches with a seed_key; nothing when
 * nobody is signed in (no backfill). A link already queued or sent for the
 * same account, match and role is not queued again.
 *
 * @returns {Promise<number>} links queued
 */
export async function queueUserMatchLinks(match) {
  const seedKey = match?.seed_key
  if (!seedKey || match.test === true) return 0
  const userId = storedSessionUserId()
  if (!userId) return 0
  const cached = readStoredJson('cachedProfile')
  const profile = cached && (!cached.user_id || cached.user_id === userId) ? cached : null
  const roles = userMatchRoles(match, profile)

  const existing = await db.sync_queue.where('resource').equals(USER_MATCH_RESOURCE).toArray()
  const known = new Set(existing
    .filter(j => j.status !== 'dropped' && j.payload?.user_id === userId && j.payload?.match_external_id === seedKey)
    .map(j => j.payload.role))
  let queued = 0
  for (const role of roles) {
    if (known.has(role)) continue
    await db.sync_queue.add(userMatchJob({ userId, seedKey, role }))
    queued++
  }
  if (queued) console.log(`[SyncQueue] Queued ${queued} My Matches link(s) for ${seedKey}`)
  return queued
}

/**
 * Keep the signed-in account linked to the match open in the scorer app
 * (created, set up or scored here). Re-checked when the match gets its
 * seed_key, when its officials change and when someone signs in.
 */
export function useUserMatchLink(matchId) {
  // A primitive key: the app does not re-render on every rally
  const key = useLiveQuery(async () => {
    if (matchId == null) return ''
    try {
      const m = await db.matches.get(matchId)
      if (!m?.seed_key || m.test === true) return ''
      return JSON.stringify([m.seed_key, m.officials || null])
    } catch {
      return ''
    }
  }, [matchId], '')

  const [authTick, setAuthTick] = useState(0)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const bump = () => setAuthTick(t => t + 1)
    const onStorage = (e) => { if (e.key === AUTH_TOKEN_STORAGE_KEY || e.key === 'cachedProfile') bump() }
    window.addEventListener(AUTH_TOKEN_CHANGE_EVENT, bump)
    // AuthContext PROFILE_CACHED_EVENT: the profile (name) arrives after the sign-in
    window.addEventListener('ov-profile-cached', bump)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(AUTH_TOKEN_CHANGE_EVENT, bump)
      window.removeEventListener('ov-profile-cached', bump)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  useEffect(() => {
    if (!key) return
    const [seedKey, officials] = JSON.parse(key)
    queueUserMatchLinks({ seed_key: seedKey, officials }).catch(err => {
      console.warn('[SyncQueue] Could not queue the My Matches link:', err?.message)
    })
  }, [key, authTick])
}
