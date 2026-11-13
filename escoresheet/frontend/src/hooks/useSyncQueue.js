import { useEffect, useCallback, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { apiFrom, apiMatchRestore, apiMatchClaim, apiMatchScorer, apiPostEventRevisions, AUTH_TOKEN_CHANGE_EVENT, AUTH_TOKEN_STORAGE_KEY, BACKEND_REACHED_EVENT } from '../lib/apiClient'
import { REVISION_OPS, revisionOfJob } from '../domain/eventRevisions'
import { emitActivity, noteSyncPass } from '../utils/activity/bus'
import { setDiagnosticsInfo } from '../utils/diagnosticsInfo'
import { uploadActivityBatch, activityFlushJob } from '../utils/activity/upload'
import { getCloudApiUrl } from '../utils/backendConfig'
import { filterMatchPayload, JSONB_COLUMNS } from '../db/matchRepository'
import { parseExtId, resolveJobExternalId, rewriteQueuedSyncJobs, jobMatchKey, USER_MATCH_RESOURCE, SCORESHEET_UPLOAD_RESOURCE, APPROVAL_RESOURCE, userMatchRoles, userMatchJob } from '../utils/syncIds'
import { approvalsApi } from '../lib/accountApi'
import { buildConnectionPins } from '../utils/connectionPins'
import { isShirtNumber } from '../domain/roster'
import { uploadQueuedScoresheet } from '../utils/scoresheetUploader'
import { ACCESS_CHANGED_EVENT } from '../lib/access'
import { SCORER_CLAIM_ACTION, SCORER_MOVED, MATCH_CLOSED, SERVER_CLOSED_BY, isScorerMoved, noteScorerMoved, markScorerMoved, hasUnsentClaim, closeMovedMatches, retireIfSuperseded, retireStaleGameCopies, setAsideClosedJobs, setAsideClosedCopies } from '../utils/matchHandover'
import { RESTORE_REFUSED, partsMayHelp } from '../utils/refusedRestore'

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
 * - One flusher per origin: every page of the app runs this hook over the same
 *   IndexedDB queue; a pass runs under a Web Lock (QUEUE_LOCK), and each job is
 *   read again right before it is sent.
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
// 'activity': the activity log upload (utils/activity/upload), needs no match row
// APPROVAL_RESOURCE: an account approval undone after the sheet changed
// (domain/accountApproval approvalUndoJobs); the approval waits for it
const RESOURCE_ORDER = ['match', APPROVAL_RESOURCE, 'set', 'event', USER_MATCH_RESOURCE, SCORESHEET_UPLOAD_RESOURCE, 'activity']

// The queue's two lanes. The scoresheet files (the approval's PDF and final
// JSON, up to a megabyte or more) go in their own (runUploadLane), beside the
// score: in the pass, on an uplink too slow for the storage timeout (about
// 90 s for 1 MB), every pass spent that long on the upload and then stopped
// as offline, and a device already scoring the next match had its rallies
// and set ends wait each time (44 s in one stress run, "saved on this
// device" at set ends; 2026-10-26).
const UPLOAD_LANE = [SCORESHEET_UPLOAD_RESOURCE]
const SCORE_LANE = RESOURCE_ORDER.filter(r => !UPLOAD_LANE.includes(r))

// Max retries for jobs waiting on dependencies (e.g., event waiting for match to sync)
const MAX_DEPENDENCY_RETRIES = 10

// While the backend asks for a sign-in (401), a pass is retried only this often
// (in case the session was refreshed elsewhere); a sign-in retries at once.
const AUTH_RECHECK_MS = 5 * 60 * 1000

// Backoff for errored jobs: 30s, 1m, 2m, 4m ... capped at 10 minutes. Jobs are
// never given up on (offline-first: the cloud copy must eventually catch up).
const ERROR_BACKOFF_BASE = 30000
const ERROR_BACKOFF_MAX = 10 * 60 * 1000

// Backoff for the connection probe after a failure: 5s, 10s, then every 15s.
// (Capped at 60 s, a cloud back after a 2-minute outage waited up to a minute
// for the next probe, the scorer's pill on "Offline" all along.) Any answer
// of the backend in between (BACKEND_REACHED_EVENT) probes at once.
const PROBE_BACKOFF_BASE = 5000
const PROBE_BACKOFF_MAX = 15000

// A 'sending' job (claimed by useSequentialSync's direct sends, before the
// set end went through the queue) older than this is assumed abandoned (tab
// closed mid-request) and handed back to the queue.
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
const ACTIVITY_JOB_RETENTION_MS = 3600 * 1000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

// One flusher per origin. Every page of the app (a second tab, the
// "Scoresheet already open" duplicate, the referee page beside the scorer)
// mounts this hook over the same IndexedDB queue, and the in-page guard
// (flushInProgress) holds per page only: two pages sent the same restore
// twice (the late copy replaced the events sent in between) and an older set
// score after the newer one. A pass runs under this Web Lock; a page that
// finds it taken asks the page holding it, over QUEUE_WAKE_CHANNEL, to run
// once more after its pass. The scoresheet files' lane has its own lock.
const QUEUE_LOCK = 'ov-sync-queue'
const UPLOAD_LOCK = 'ov-sync-queue-upload'
const QUEUE_WAKE_CHANNEL = 'ov-sync-queue'
// A wake heard by a page that holds no pass runs its flush through this
// event (each mounted hook listens; the first one runs it)
const QUEUE_WAKE_EVENT = 'ov-sync-queue-wake'
// The lock has no lease of its own: a page suspended while it holds it (a
// background tab on iOS, its pass waiting on a request) keeps it until it
// runs again, and every other page sent nothing meanwhile, silently. The
// page holding it says so when its pass begins and every QUEUE_BEAT_MS
// while it runs; a page that has found the lock taken for QUEUE_LEASE_MS
// without hearing the holder takes it over (steal), and the holder, once
// it runs again, ends its pass before its next job (runQueuePass lease).
// Over a minute: a hidden page's timers may run only once a minute
// (intensive throttling), and a page still sending must keep the lock.
const QUEUE_BEAT_MS = 5000
const QUEUE_LEASE_MS = 90 * 1000
// A page that has not tried the lock for this long (suspended itself, or
// hidden and throttled) heard nothing meanwhile: it watches afresh
const QUEUE_WATCH_GAP_MS = 30 * 1000

// Event inserts of one match sent as one upsert (runQueuePass): after a long
// offline match hundreds of them waited, one request each against the
// per-user write limit (600 a minute). The /api/db body limit is 5 MB. A
// rally row (state snapshot, both line-ups) is about 5 KB: 64 KB take a few
// seconds on a weak hall uplink (20 KB/s), well inside the 20 s request
// timeout. A batch that failed on its way is halved for its match
// (eventBatchLimit), down to one by one, and doubles back after a success.
const EVENT_BATCH_MAX = 50
const EVENT_BATCH_MAX_BYTES = 64 * 1024

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

// The OV_GAME_TAKEN claim (spec 5.2), whitelisted: who scores the official
// game and in which state. Never PINs, emails or ids (the server sends none).
// external_id: only for the account's own match (a newer server): the
// device that joined it retires its refused copy (utils/matchHandover).
const CLAIM_FIELDS = ['game_n', 'season', 'sport', 'status', 'scorer_name', 'mine', 'scheduled_at', 'external_id']
export function summarizeClaim(claim) {
  if (!claim || typeof claim !== 'object') return null
  const out = {}
  for (const k of CLAIM_FIELDS) if (claim[k] !== undefined) out[k] = claim[k]
  return out
}

// The OV_SCORER_MOVED scorer (db/019): which kind of device scores the match
// now and since when. The server never sends the other device's id.
export function summarizeScorer(scorer) {
  if (!scorer || typeof scorer !== 'object') return null
  return {
    platform: typeof scorer.platform === 'string' ? scorer.platform.slice(0, 24) : null,
    at: typeof scorer.at === 'string' ? scorer.at.slice(0, 40) : null
  }
}

function summarizeError(error) {
  if (!error) return null
  const out = {
    status: error.status ?? null,
    code: typeof error.code === 'string' ? error.code : null,
    message: String(error.message || '').slice(0, 200)
  }
  if (typeof error.requestId === 'string') out.requestId = error.requestId
  if (error.code === 'OV_GAME_TAKEN') out.claim = summarizeClaim(error.claim)
  if (error.code === SCORER_MOVED) out.scorer = summarizeScorer(error.scorer)
  return out
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
 * texts masked, the scoresheet remarks (db/017) as their length only, like
 * the activity log. Anything else is passed through unchanged.
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
    if (isSecretLogKey(k)) continue
    out[k] = k === 'remarks' && typeof v === 'string' ? `[${v.length} characters]` : redactForLog(v, depth + 1)
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

/**
 * Sync status after a failed connection probe (SELECT on matches).
 * A 404 means this server has no /api/db at all: the page is served by a LAN
 * relay (desktop app, Rust relay) that only relays matches. That is the
 * offline setup working as designed, not a backend error.
 * @param {{network?: boolean, status?: number, code?: string, message?: string}} error
 * @returns {'offline'|'online_no_supabase'|'error'}
 */
export function probeErrorStatus(error) {
  if (error?.network) return 'offline'
  if (error?.status === 404) return 'online_no_supabase'
  // A missing table (42P01) is a setup issue, not a connection error
  if (error?.code === '42P01' || error?.message?.includes('relation') || error?.message?.includes('does not exist')) {
    return 'online_no_supabase'
  }
  return 'error'
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
 * than the oldest job still pending of the same match are kept whatever their
 * age: the supersede step of a retried job compares it with the updates of
 * its row (so of its match) sent after it. Per match: one job refused for good
 * kept every later row of every match, for as long as it stayed refused.
 * @returns {Promise<number>} rows removed
 */
export async function pruneSyncQueue({ retentionMs = SENT_RETENTION_MS, now = Date.now() } = {}) {
  try {
    const pending = await db.sync_queue.where('status').anyOf(['queued', 'sending', 'error', 'failed']).toArray()
    // match key (null: jobs without one) -> id of its oldest pending job
    const oldestPending = new Map()
    for (const j of pending) {
      const key = jobMatchKey(j) ?? null
      if (!oldestPending.has(key) || oldestPending.get(key) > j.id) oldestPending.set(key, j.id)
    }
    const done = await db.sync_queue.where('status').anyOf(['sent', 'superseded', 'dropped']).toArray()
    const ids = done
      .filter(j => {
        // ts is a number (Date.now()) or an ISO string, depending on the writer
        const ts = typeof j.ts === 'number' ? j.ts : Date.parse(j.ts)
        // the activity uploads (one every 10 s in a match) carry nothing to keep
        if (j.resource === 'activity') return Number.isFinite(ts) && now - ts > ACTIVITY_JOB_RETENTION_MS
        const key = jobMatchKey(j) ?? null
        if (oldestPending.has(key) && j.id >= oldestPending.get(key)) return false
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
/**
 * The 'sync-queue-write' event, when there is still a page to send it to: the
 * timer below can fire after it is gone (a test environment torn down right
 * after a write: an uncaught "window is not defined" failed whole suite runs).
 */
export function notifySyncQueueWrite() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('sync-queue-write'))
}
function installSyncQueueHook() {
  if (_syncQueueHookInstalled) return
  _syncQueueHookInstalled = true
  db.sync_queue.hook('creating', function () {
    // Dispatch after the current microtask completes (Dexie hooks run inside transaction)
    setTimeout(notifySyncQueueWrite, 0)
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
// ---------------------------------------------------------------------------
// Cloud blocks (spec 6.7): the server refused a match for good because the
// account is not an approved scorer, the official game is already scored by
// another cloud match, the match is closed, or (db/018) the game is not a home
// game of the account's clubs, or (db/019) another device scores the match
// now. The local match carries cloudBlock { code, claim, scorer, at } so the
// UI can say why it does not sync.
// ---------------------------------------------------------------------------
export const CLUB_BLOCK_CODES = ['OV_CLUB_REQUIRED', 'OV_NOT_YOUR_CLUB', 'OV_GAME_NOT_IN_SCHEDULE']
export const CLOUD_BLOCK_CODES = ['OV_SCORER_REQUIRED', 'OV_GAME_TAKEN', 'OV_MATCH_CLOSED', SCORER_MOVED, ...CLUB_BLOCK_CODES]
export const CLOUD_BLOCK_EVENT = 'ov-cloud-block'
const CLOUD_BLOCK_RESOURCES = ['match', 'set', 'event']

// seed_keys of local matches with a cloudBlock, loaded once, so a sent job
// does not scan the matches table to find out there is nothing to clear
let blockedSeeds = null
async function getBlockedSeeds() {
  if (blockedSeeds) return blockedSeeds
  const seeds = new Set()
  try {
    for (const m of await db.matches.filter(m => !!m.cloudBlock).toArray()) if (m.seed_key) seeds.add(m.seed_key)
  } catch { /* no table yet: nothing blocked */ }
  blockedSeeds = seeds
  return seeds
}
export function resetCloudBlockCache() {
  blockedSeeds = null
}

// A match that ended here and that the server already closed (approved on
// another device, or a backup of it restored here) is the server's official
// record: the local copy is finished too and no longer counts as an open
// match on the home screen (2026-10-19: a restored, closed match stayed open
// next to a new match of the same game). A copy still being scored here
// (scheduled, live) keeps its status and gets the block: marked final it
// would leave the home screen, and with it the way to remove it or to load
// the official version. Either way its unsent writes are set aside
// (recordCloudBlock).
const FINISHED_HERE = ['ended', 'approved']
export const closesLocalCopy = (local, code) => code === 'OV_MATCH_CLOSED' && local?.test !== true && FINISHED_HERE.includes(local?.status)

/**
 * @param {object|null} job the refused job (none: the self-check read the
 *   server's row, noteMatchClosedOnServer)
 * @param {{ code: string, claim?: object, scorer?: object }} error
 * @param {{ local?: object }} [options] the local copy to mark (default: the
 *   first one of the job's match)
 * @returns {Promise<{ setAside?: boolean }>} setAside: the match moved to
 *   another device or the server has closed it; its unsent writes (this job
 *   too) are set aside
 */
async function recordCloudBlock(job, error, { local: given = null } = {}) {
  const seedKey = given ? given.seed_key : jobMatchKey(job)
  if (!seedKey || !error?.code) return {}
  try {
    const local = given || await findLocalMatchBySeed(seedKey)
    if (!local) {
      // Closed and no local copy (Close match removed it while older writes
      // of the match were still queued): nothing to mark, but the server
      // refuses every one of them. Set aside, never a lasting refusal.
      if (error.code !== MATCH_CLOSED) return {}
      const n = await setAsideClosed(job, seedKey)
      safeLog.log(`[SyncQueue] Match ${seedKey} is closed on the server and has no local copy: ${n} unsent write(s) set aside`)
      return { setAside: true }
    }
    // db/019: another device scores the match. The notice stays whatever the
    // server refuses later (a closed match is no longer checked for its
    // device: OV_MATCH_CLOSED must not bring this device's old scoreboard
    // back); once the server says closed, the local copy is final too.
    if (error.code === SCORER_MOVED || isScorerMoved(local)) {
      const n = await markScorerMoved(db, local, {
        scorer: error.code === SCORER_MOVED ? (error.scorer ?? null) : null,
        closed: error.code === 'OV_MATCH_CLOSED'
      })
      ;(await getBlockedSeeds()).add(seedKey)
      safeLog.log(`[SyncQueue] Another device scores ${seedKey}${error.code === 'OV_MATCH_CLOSED' ? ' (closed there)' : ''}: ${n} unsent write(s) of this device set aside`)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(CLOUD_BLOCK_EVENT, { detail: { seedKey, code: SCORER_MOVED } }))
      }
      return { setAside: true }
    }
    const mods = { cloudBlock: { code: error.code, claim: error.claim ?? null, ...(error.scorer ? { scorer: error.scorer } : {}), at: Date.now() } }
    if (closesLocalCopy(local, error.code)) {
      mods.status = 'final'
      safeLog.log('[SyncQueue] Match is closed on the server, local copy marked final:', seedKey)
    }
    await db.matches.update(local.id, mods)
    ;(await getBlockedSeeds()).add(seedKey)
    // Refused for a game whose cloud match this device already joined: the
    // refused copy is retired (its jobs dropped), no lasting sync error
    if (error.code === 'OV_GAME_TAKEN') {
      const by = await retireIfSuperseded(db, { ...local, ...mods })
      if (by) safeLog.log('[SyncQueue] Refused copy of the game retired, continued as', by)
    }
    // Closed on the server: this write and every other unsent one of the
    // match are set aside (utils/matchHandover), whatever the local status.
    // The server refuses each of them; 2026-10-23 (match 406970) a refused
    // restore stayed 'failed' and held back every newer write of the match.
    const closed = error.code === MATCH_CLOSED && local.test !== true
    if (closed) {
      const n = await setAsideClosed(job, seedKey)
      safeLog.log(`[SyncQueue] Match ${seedKey} is closed on the server: ${n} unsent write(s) of this device set aside`)
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CLOUD_BLOCK_EVENT, { detail: { seedKey, code: error.code } }))
    }
    if (closed) return { setAside: true }
  } catch (err) {
    safeLog.warn('[SyncQueue] Could not record the cloud block of a match:', err?.message)
  }
  return {}
}

/**
 * The server's own row says match `localId` is closed, and no write of it
 * was refused: the self-check on open read it (utils/deviceSelfCheck). A copy
 * that writes nothing never hears of the close otherwise (2026-10-27: the
 * owner's PC opened match 406970 live a week after a phone had closed it).
 * Marked exactly as a write refused with 409 OV_MATCH_CLOSED marks it
 * (recordCloudBlock): the same block, the blocked-seeds bookkeeping, its
 * unsent writes set aside, final when it ended here, moved and final when
 * another device took it over. The closed-copy notice and dialog take over
 * from there. Never a test match. Never throws.
 * @returns {Promise<boolean>} true when the copy was marked
 */
export async function noteMatchClosedOnServer(localId) {
  try {
    const local = localId == null ? null : await db.matches.get(localId)
    if (!local?.seed_key || local.test === true) return false
    const { setAside } = await recordCloudBlock(null, { code: MATCH_CLOSED }, { local })
    return setAside === true
  } catch (err) {
    safeLog.warn('[SyncQueue] Could not mark a match closed on the server:', err?.message)
    return false
  }
}

// setAsideClosedJobs, and the mark on the refused job's own row: a direct
// send (useSequentialSync) holds it as 'sending', which the set-aside leaves
// alone. Stored as 'dropped' with the mark, it goes out again with the
// others when the server has the match open again (requeueClosedJobs).
async function setAsideClosed(job, seedKey) {
  const n = await setAsideClosedJobs(db, seedKey)
  if (job?.id != null) await db.sync_queue.update(job.id, { superseded_by: SERVER_CLOSED_BY })
  return n
}

/**
 * The relay said another device took a match over (scorer-moved, db/019):
 * when the server confirms this device no longer scores it, its local match
 * gets the OV_SCORER_MOVED block (ScorerMovedModal). Never throws.
 * @returns {Promise<boolean>} true when the match was marked
 */
export async function checkScorerMoved(seedKey) {
  try {
    return (await scorerCheck(seedKey)).moved
  } catch (err) {
    safeLog.warn('[SyncQueue] Could not check the scoring device of a match:', err?.message)
    return false
  }
}

/**
 * Which device scores `seedKey`, for the home screen's state of a copy (the
 * self-check, utils/deviceSelfCheck): 'moved' when another device does (the
 * copy is marked, as by checkScorerMoved), 'here' when the server answered
 * that this device does or that none does, null when it was not asked or
 * gave no answer (no connection, a claim of this device still unsent, a
 * test or final copy). Never throws.
 * @returns {Promise<'moved'|'here'|null>}
 */
export async function askScoringDevice(seedKey) {
  try {
    const { moved, answer } = await scorerCheck(seedKey)
    if (moved) return 'moved'
    return answer && !answer.error && answer.data && answer.data.mine !== false ? 'here' : null
  } catch (err) {
    safeLog.warn('[SyncQueue] Could not check the scoring device of a match:', err?.message)
    return null
  }
}

// checkScorerMoved and askScoringDevice: the server's answer, and the marking
async function scorerCheck(seedKey) {
  let answer = null
  const moved = await noteScorerMoved(db, seedKey, {
    check: async (key) => {
      answer = await apiMatchScorer(key, { claim: false })
      return answer
    }
  })
  if (moved) {
    ;(await getBlockedSeeds()).add(seedKey)
    safeLog.log('[SyncQueue] Another device scores this match now:', seedKey)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CLOUD_BLOCK_EVENT, { detail: { seedKey, code: SCORER_MOVED } }))
    }
  }
  return { moved, answer }
}

// A sent job that proves the server has the match open: a closed match
// refuses every set, event and revision row written (db/007, db/015) and
// every restore. Not a claim or a match delete (both answered "closed" count
// as sent), not a match update (a no-op rewrite, or approved -> final, passes
// on a closed match), and not a set/event update or delete: one of a row the
// server does not have touches nothing and passes too.
const provesMatchOpen = (job) => job?.resource === 'match'
  ? job.action === 'restore'
  : (job?.resource === 'set' || job?.resource === 'event') && job.action !== 'update' && job.action !== 'delete'

async function clearCloudBlock(job) {
  const seedKey = jobMatchKey(job)
  if (!seedKey) return
  try {
    const seeds = await getBlockedSeeds()
    if (!seeds.has(seedKey)) return
    const local = await findLocalMatchBySeed(seedKey)
    // "Closed on the server" stays until a write proves the match open again
    // (an admin reopened it): the closed-copy notice depends on it
    if (local?.cloudBlock?.code === MATCH_CLOSED && !provesMatchOpen(job)) return
    // A refused restore holds the match back until a restore (or the match
    // row itself) goes through: a claim or a link going through says nothing
    if (local?.cloudBlock?.code === RESTORE_REFUSED && !(job.resource === 'match' && (job.action === 'restore' || job.action === 'insert'))) return
    seeds.delete(seedKey)
    if (local?.cloudBlock) await db.matches.update(local.id, { cloudBlock: null })
  } catch (err) {
    safeLog.warn('[SyncQueue] Could not clear the cloud block of a match:', err?.message)
  }
}

/**
 * A restore refused with the server's own code that is no cloud block (too
 * large a body, too many rows, a row the server cannot take): parked as
 * refused, it holds every later job of its match (pendingEntityBlocks), so
 * the match never reaches the cloud without help. The local match says so
 * (CloudBlockNotice names the game and what to do); where the refusal is
 * about its size (`parts`), support sends it in parts (utils/refusedRestore).
 * A block of another kind stays as it is.
 */
async function recordRestoreRefused(job, error) {
  const seedKey = jobMatchKey(job)
  if (!seedKey) return
  try {
    const local = await findLocalMatchBySeed(seedKey)
    if (!local || local.test === true || (local.cloudBlock && local.cloudBlock.code !== RESTORE_REFUSED)) return
    const reason = typeof error?.code === 'string' ? error.code.slice(0, 40) : null
    await db.matches.update(local.id, { cloudBlock: { code: RESTORE_REFUSED, reason, parts: partsMayHelp(error, job.payload), claim: null, at: Date.now() } })
    ;(await getBlockedSeeds()).add(seedKey)
    safeLog.warn('[SyncQueue] Restore refused by the server; the match\'s later writes wait for it:', seedKey, reason)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CLOUD_BLOCK_EVENT, { detail: { seedKey, code: RESTORE_REFUSED } }))
    }
  } catch (err) {
    safeLog.warn('[SyncQueue] Could not note the refused restore of a match:', err?.message)
  }
}

// A closing update (approved / final) closes the match on the server, and from
// then on the server refuses its sets and events (409 OV_MATCH_CLOSED). It
// must not overtake an older set or event job of the same match that is still
// on its way (queued, in flight or waiting out a backoff). Old 'failed' set
// and event jobs do not hold it: they were refused and wait for a hand retry.
//
// Nor an older match update not delivered yet: the 'ended' update carries the
// result (winner, final_score, the last set_results, sanctions), the approval
// does not, and once the approval has closed the match the server refuses the
// update. Parked after a failure ('error', its backoff up to 10 minutes; or
// 'failed'), the approval went first and the official match had no result.
// Such an update is requeued at once, trimmed against newer sent updates
// first (supersedeStaleUpdates), once per closing job: one refused again for
// good ('failed') then no longer holds the approval, one that failed again on
// its way ('error') holds it until it is through. The remarks as approved
// (db/017) are such an update too: the approval queues them just before itself.
//
// Nor the undo of an account approval given before the sheet changed (a
// correction, a remarks change at the match end): closed first, the match
// keeps that approval for good (its approvals are frozen on the server).
const CLOSING_STATUSES = ['approved', 'final']
export function isClosingJob(job) {
  return job?.resource === 'match' && job.action === 'update' && CLOSING_STATUSES.includes(job.payload?.status)
}
export async function closingMustWait(job) {
  const matchKey = jobMatchKey(job)
  if (!matchKey || job?.id == null) return false
  try {
    const pending = await db.sync_queue.where('status').anyOf('queued', 'sending', 'error', 'failed').toArray()
    const older = pending.filter(j => j.id < job.id && jobMatchKey(j) === matchKey)
    if (older.some(j => j.status !== 'failed' && (j.resource === 'set' || j.resource === 'event' || j.resource === APPROVAL_RESOURCE))) return true
    const updates = older.filter(j => j.resource === 'match' && j.action === 'update' &&
      !(j.status === 'failed' && j.closing_retry_for === job.id))
    if (updates.length === 0) return false
    const parked = updates.filter(j => (j.status === 'error' || j.status === 'failed') && j.closing_retry_for !== job.id)
    const superseded = parked.length > 0 ? await supersedeStaleUpdates(parked) : new Set()
    for (const j of parked) {
      if (!superseded.has(j.id)) await db.sync_queue.update(j.id, { status: 'queued', retry_count: 0, closing_retry_for: job.id })
    }
    return updates.some(j => !superseded.has(j.id))
  } catch {
    return false
  }
}

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
  // A pending account was approved (admin or invite code), or its clubs
  // changed: the jobs the server refused (OV_SCORER_REQUIRED, the club codes)
  // can go now.
  window.addEventListener(ACCESS_CHANGED_EVENT, (e) => { if (e?.detail?.canScore) resumeAfterSignIn() })
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
 * and CLAIM_RETRY_MS, see claimMatchWithLocalPin) and sent again. After a
 * successful take-over the match's other parked jobs are queued again.
 * @param {object} job the sync_queue row
 * @param {{ matchIds?: Map<string, string> }} [pass] runQueuePass's cache of
 *   the cloud ids of the matches (cloudMatchId)
 */
export async function processJob(job, pass = {}) {
  let result = await processJobOnce(job, pass)
  if (result === PERMANENT_FAILURE && jobErrors.get(job?.id)?.code === 'OV_NOT_MATCH_OWNER') {
    const matchKey = jobMatchKey(job)
    if (matchKey && claimDue(matchKey) && await claimMatchWithLocalPin(matchKey)) {
      result = await processJobOnce(job, pass)
      if (result === true) await requeueParkedJobsOf(matchKey, job.id)
    }
  }
  if (CLOUD_BLOCK_RESOURCES.includes(job?.resource)) {
    if (result === PERMANENT_FAILURE && jobErrors.get(job?.id)?.code === SCORER_MOVED && job.action !== SCORER_CLAIM_ACTION &&
        await hasUnsentClaim(db, jobMatchKey(job)).catch(() => false)) {
      // This device asked to score the match (a join, a take-back) and the
      // server has not confirmed it yet: the previous device still holds it.
      // Retried after the claim, never the "scored on another device" notice
      // on the device the scorer is using.
      safeLog.log('[SyncQueue] Write waits for this device\'s scoring claim:', jobMatchKey(job), job.resource, job.action)
      result = null
    }
    if (result === PERMANENT_FAILURE) {
      const error = jobErrors.get(job?.id)
      // Judged on the local copy BEFORE the block marks it final
      const dropAfterClose = error?.code === 'OV_MATCH_CLOSED' && await isNeedlessAfterClose(job)
      const recorded = CLOUD_BLOCK_CODES.includes(error?.code) ? await recordCloudBlock(job, error) : {}
      if (recorded.setAside) {
        // Another device scores the match, or the server has closed it: this
        // write is set aside with the match's others (utils/matchHandover
        // setAsideMovedJobs, setAsideClosedJobs), not refused
        result = DROP_JOB
        if (job?.id != null) setAsideJobIds.add(job.id)
      } else if (dropAfterClose) {
        safeLog.log('[SyncQueue] Dropping a match update refused after the match was closed here (nothing of the score in it):',
          jobMatchKey(job), Object.keys(job.payload || {}).filter(k => k !== 'id').join(','))
        result = DROP_JOB
      } else if (job?.id != null && error?.code === 'OV_GAME_TAKEN') {
        // The block retired the match (utils/matchHandover): its jobs, this
        // one too, are superseded, not refused
        const now = await db.sync_queue.get(job.id).catch(() => null)
        if (now?.status === 'superseded') result = DROP_JOB
      }
      if (result === PERMANENT_FAILURE && job?.resource === 'match' && job.action === 'restore' && !CLOUD_BLOCK_CODES.includes(error?.code)) {
        await recordRestoreRefused(job, error)
      }
    } else if (result === true) {
      await clearCloudBlock(job)
    }
  }
  return result
}

// A match that is closed here: approved on this device (the local status
// stays 'ended' until Close Match), final, or already known to be closed on
// the server (an earlier refusal).
export const isClosedHere = (local) => !!local && local.test !== true &&
  (local.approved === true || CLOSING_STATUSES.includes(local.status) || local.cloudBlock?.code === 'OV_MATCH_CLOSED')

/**
 * The match-end update { status: 'ended', set_results, ... } (App finishSet)
 * is needless when the match is closed here (it would only be refused as
 * closed), and when the same one is still on its way. 2026-10-20: a match
 * approved on a phone and continued two hours later opened the Scoreboard,
 * whose "already finished" effect called finishSet on every render until
 * Match End showed: seven such updates, all refused with OV_MATCH_CLOSED.
 * @param {object} match the local match row
 * @param {object[]} pendingJobs sync_queue rows (any status)
 * @param {object} payload the update about to be queued
 */
export function matchEndUpdateNeeded(match, pendingJobs, payload) {
  if (!match?.seed_key || match.test === true || isClosedHere(match)) return false
  return !(pendingJobs || []).some(j =>
    ['queued', 'sending', 'error'].includes(j.status) && j.resource === 'match' && j.action === 'update' &&
    j.payload?.id === match.seed_key && j.payload?.status === 'ended' &&
    JSON.stringify(j.payload?.set_results ?? null) === JSON.stringify(payload?.set_results ?? null) &&
    (j.payload?.final_score ?? null) === (payload?.final_score ?? null))
}

/**
 * A match UPDATE the server refused as closed (409 OV_MATCH_CLOSED) for a
 * match that is closed here too: the server's closed copy is the official
 * record, which this device approved with every set and event before it
 * (closingMustWait), so a later update of the match row (status, results,
 * signatures, remarks, connections) has nothing left to deliver. Only a
 * fallback now: recordCloudBlock sets aside every write refused as closed
 * (sets, events, restores and updates alike, of a copy closed here or still
 * live), and the local rows keep the score. This drops the update when that
 * could not be recorded.
 */
async function isNeedlessAfterClose(job) {
  if (job?.resource !== 'match' || job.action !== 'update') return false
  try {
    return isClosedHere(await findLocalMatchBySeed(jobMatchKey(job)))
  } catch {
    return false
  }
}

// Jobs whose match moved to another device, or was closed on the server,
// while they were processed: the pass must not send the match's other jobs it
// read before they were set aside
const setAsideJobIds = new Set()

/**
 * Whether processJob set this job aside because another device scores its
 * match (OV_SCORER_MOVED) or the server has closed it (OV_MATCH_CLOSED): the
 * direct sender (useSequentialSync) reports it as kept, not failed. Forgets
 * the job.
 */
export function takeSetAside(jobId) {
  return setAsideJobIds.delete(jobId)
}

async function processJobOnce(job, pass = {}) {
  const ctx = { error: null, matchIds: pass?.matchIds ?? null }
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

// Answers to a scoring-device claim that leave nothing to record (see below)
const NO_SCORER_RECORD = ['OV_MATCH_CLOSED', 'OV_SCORER_UNAVAILABLE', 'OV_DB_NOT_CONFIGURED']

/**
 * The cloud id (uuid) of the match `seedKey`, read once per pass (ctx.matchIds,
 * filled by runQueuePass): every set and event job read it before its write,
 * two requests per job against the per-address read limit after a long
 * offline match. Only a match found is kept (not in the cloud yet: asked again).
 * @returns {Promise<{ id: string|null, error?: object }>}
 */
async function cloudMatchId(seedKey, ctx) {
  const cache = ctx?.matchIds
  if (cache?.has(seedKey)) return { id: cache.get(seedKey) }
  const { data, error } = await apiFrom('matches')
    .select('id')
    .eq('external_id', seedKey)
    .maybeSingle()
  if (error) return { id: null, error }
  const id = data?.id ?? null
  if (id && cache) cache.set(seedKey, id)
  return { id }
}

/** An event insert as the events table takes it: its match's cloud id, no bad server number. */
function eventInsertRow(payload, matchUuid) {
  const row = { ...payload, sport_type: 'indoor' }
  // serve_player is an integer column: a shirt number stored as '1.5' by
  // an older roster editor (queued, or already parked as refused) was
  // refused (22P02) at every retry and the rally never reached the
  // cloud. Sent without its server, the rally counts.
  if (row.serve_player != null && !isShirtNumber(row.serve_player)) row.serve_player = null
  if (matchUuid) row.match_id = matchUuid
  return row
}

async function processJobInner(job, ctx) {
  try {
    // A test match never reaches the cloud, whoever queued the job (MatchSetup
    // once queued its insert as test: false) and even when it waited for a
    // sign-in
    const testKey = jobMatchKey(job)
    if (testKey && (await findLocalMatchBySeed(testKey))?.test === true) {
      safeLog.log('[SyncQueue] Dropping a job of a test match:', job.resource, job.action)
      return DROP_JOB
    }

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

    // Closing order: the approval waits for the match's older sets, events
    // and match updates
    if (isClosingJob(job) && await closingMustWait(job)) {
      safeLog.log('[SyncQueue] Closing update waits for older jobs of its match')
      return null
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
      ctx.matchIds?.delete(id)

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
      if (matchError?.code === 'OV_MATCH_CLOSED') {
        // A closed match is the official record: the server keeps it, only an
        // admin can reopen or remove it. Deleting it here only meant deleting
        // this device's copy, which is done, so the job has nothing left to do.
        safeLog.log('[SyncQueue] Match is closed on the server, kept there; local copy deleted:', id)
        return true
      }
      if (matchError) {
        safeLog.error('[SyncQueue] Match delete error:', matchError, job.payload)
        return failureResult(matchError, ctx)
      }

      safeLog.log('[SyncQueue] ✅ Deleted match and related records from Supabase:', id)
      return true
    }

    // ==================== SCORING DEVICE (db/019) ====================
    // This device scores the match from now on (a join, "Take back scoring
    // here", utils/matchHandover). A server that cannot record it answers
    // without effect: the match is not in the cloud yet (its first write
    // records this device anyway), it is closed, the server has no handover
    // (an older backend: 404 without code; 503 OV_SCORER_UNAVAILABLE without
    // db/019; a server without a database, 503 OV_DB_NOT_CONFIGURED). None
    // of these may hold the match's other jobs back.
    if (job.resource === 'match' && job.action === SCORER_CLAIM_ACTION) {
      const seedKey = job.payload?.id
      if (!seedKey) return DROP_JOB
      const { error, status } = await apiMatchScorer(seedKey, { claim: true })
      if (error) {
        const st = error.status ?? status
        if (error.code === 'OV_NO_DEVICE' || st === 404 || NO_SCORER_RECORD.includes(error.code)) {
          safeLog.log('[SyncQueue] Scoring device not recorded (nothing to take over):', seedKey, error.code || st)
          return true
        }
        return failureResult(error, ctx)
      }
      safeLog.log('[SyncQueue] This device scores', seedKey)
      return true
    }

    // ==================== MATCH RESTORE ====================
    // Backup restore: POST /api/match/restore runs it server-side in ONE
    // transaction (upsert the match BY external_id, replace THIS match's sets,
    // events and live state). Nothing half-restored is ever left behind; a
    // failure rolls back and the job is retried (local IndexedDB stays the source).
    if (job.resource === 'match' && job.action === 'restore') {
      const { match, sets, events, liveState, rekey } = job.payload

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
          liveState: liveState || null,
          // When the restore was made (db/019): another device that took the
          // match over after that keeps it (409 OV_SCORER_MOVED)
          queuedAt: job.ts,
          // A hand-over's re-key (importMatchFromSupabase): only the rows it
          // names are renamed, nothing is deleted
          ...(rekey ? { rekey } : {})
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
        const { id: matchUuid, error: lookupError } = await cloudMatchId(setPayload.match_id, ctx)
        if (lookupError) return failureResult(lookupError, ctx)
        if (!matchUuid) {
          // Match not yet synced - keep job queued for retry
          return null // null means "retry later"
        }
        setPayload.match_id = matchUuid
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
        const { id: matchUuid, error: lookupError } = await cloudMatchId(parsed.seedKey, ctx)
        if (lookupError) return failureResult(lookupError, ctx)
        if (!matchUuid) return null // match not in the cloud yet - retry later
        // Also match the row a set insert created before ids were namespaced;
        // the match scope keeps that bare id from touching other matches.
        query = query
          .eq('match_id', matchUuid)
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

    if (job.resource === 'set' && job.action === 'delete') {
      // A set deleted on the device (utils/eventSync queueSetDeletes), queued
      // behind its insert and updates. By the namespaced external_id, which
      // the backend requires for a child-row delete (pgQuery
      // assertChildFilterScoped); a row the cloud never had matches nothing.
      const externalId = job.payload?.external_id
      if (!parseExtId(externalId)) return DROP_JOB
      const { error } = await apiFrom('sets').delete().eq('external_id', externalId)
      if (error) {
        safeLog.error('[SyncQueue] Set delete error:', error, externalId)
        return failureResult(error, ctx)
      }
      return true
    }

    // ==================== EVENT ====================
    if (job.resource === 'event' && job.action === 'insert') {
      // Resolve match_id from external_id
      let eventPayload = eventInsertRow(job.payload, null)

      if (eventPayload.match_id && typeof eventPayload.match_id === 'string') {
        const { id: matchUuid, error: lookupError } = await cloudMatchId(eventPayload.match_id, ctx)
        if (lookupError) return failureResult(lookupError, ctx)
        if (!matchUuid) {
          // Match not yet synced - keep job queued for retry (will be limited by MAX_DEPENDENCY_RETRIES)
          return null // null means "retry later"
        }
        eventPayload.match_id = matchUuid
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

    // ============ EVENT HISTORY (undo / delete / edit / restore) ============
    // Queued by db/eventHistory's hooks. Resource 'event' on purpose: the
    // per-entity order keeps a void behind its event's insert, and a closing
    // update waits for it (closingMustWait).
    if (job.resource === 'event' && REVISION_OPS.includes(job.action)) {
      const revision = revisionOfJob({ ...job.payload, op: job.payload?.op || job.action })
      const seedKey = jobMatchKey(job)
      if (!revision || !seedKey) return DROP_JOB
      const { error, status } = await apiPostEventRevisions(seedKey, [revision])
      if (error) {
        const st = error.status ?? status
        if (st === 404 && error.code === 'OV_MATCH_NOT_FOUND') {
          // The match is not in the cloud yet: retry later, like an event insert
          ctx.error = summarizeError(error)
          return null
        }
        if (st === 404) {
          // A server without the route (older backend, LAN relay): parked as
          // refused, retried hourly
          ctx.error = { ...summarizeError(error), status: 404, code: error.code || 'OV_ROUTE_MISSING' }
          return PERMANENT_FAILURE
        }
        safeLog.warn('[SyncQueue] Event revision refused:', error.code || st)
        return failureResult(error, ctx)
      }
      return true
    }

    if (job.resource === 'event' && job.action === 'delete') {
      // LEGACY: a job queued by an app before the event history
      // (db/eventHistory), when a correction removed an event. Corrections
      // now send a void revision instead (the db.events hooks); the server
      // turns this delete of ONE event into a void too (lib/eventRevisions
      // voidByExternalId), so its row is kept. A row that never reached the
      // cloud is no error — the delete simply matches nothing. Scoped by the namespaced
      // external_id (`${seedKey}:e:${id}`), which the backend requires for a
      // child-row delete (pgQuery assertChildFilterScoped).
      const externalId = job.payload?.external_id
      if (!externalId) return DROP_JOB
      const { error } = await apiFrom('events').delete().eq('external_id', externalId)
      if (error) {
        safeLog.error('[SyncQueue] Event delete error:', error, externalId)
        return failureResult(error, ctx)
      }
      return true
    }

    // ==================== ACTIVITY LOG UPLOAD ====================
    if (job.resource === 'activity' && job.action === 'flush') {
      const r = await uploadActivityBatch(db)
      if (r.error) {
        const st = r.error.status ?? r.status
        if (st === 404) {
          // A server without /api/activity: parked as refused, retried hourly
          ctx.error = { ...summarizeError(r.error), status: 404, code: r.error.code || 'OV_ROUTE_MISSING' }
          return PERMANENT_FAILURE
        }
        return failureResult(r.error, ctx)
      }
      // More rows than one batch: the next flush right after this one
      if (r.more) await db.sync_queue.add(activityFlushJob())
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

    // ==================== ACCOUNT APPROVAL UNDO ====================
    // The sheet changed after an official approved it with their account
    // (domain/accountApproval approvalUndoJobs): the approval goes on the
    // server too, retried like every write until it is through
    if (job.resource === APPROVAL_RESOURCE && job.action === 'undo') {
      const id = job.payload?.id
      if (!id) return DROP_JOB
      const { error } = await approvalsApi.undo(id)
      if (error) {
        // gone already: replaced by a newer approval of the slot, or undone
        if (error.status === 404) return true
        if (error.code === 'OV_MATCH_CLOSED') {
          // the match was closed first: its approvals are frozen there
          safeLog.warn('[SyncQueue] Approval undo refused, the match is closed: dropped')
          ctx.error = summarizeError(error)
          return DROP_JOB
        }
        safeLog.warn('[SyncQueue] Approval undo error:', error.code || error.status || error.message)
        return failureResult(error, ctx)
      }
      return true
    }

    // ==================== SCORESHEET FILES ====================
    // The approval's PDF and final JSON (MatchEnd): the job carries the file
    if (job.resource === SCORESHEET_UPLOAD_RESOURCE && job.action === 'upload') {
      if (!job.payload?.path || !job.payload?.file) return DROP_JOB
      const { error, status } = await uploadQueuedScoresheet(job.payload)
      if (error) {
        if ((error.status ?? status) === 404 && error.code === 'OV_MATCH_NOT_FOUND') {
          // The backend stores a PDF for its match only, and the match is not
          // in the cloud yet (its insert is in the score's lane): retry later
          ctx.error = summarizeError(error)
          return null
        }
        if (error.code === 'OV_MATCH_CLOSED') {
          // The match is closed and keeps the PDF it has: this file is never
          // taken (after an admin reopen, the new approval queues new files)
          safeLog.warn('[SyncQueue] Scoresheet upload refused, the match is closed: dropped')
          ctx.error = summarizeError(error)
          return DROP_JOB
        }
        safeLog.warn('[SyncQueue] Scoresheet upload error:', error.code || error.status || error.message)
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
  if (job.resource === SCORESHEET_UPLOAD_RESOURCE) return `${job.resource}:${job.payload?.path}`
  if (job.resource === APPROVAL_RESOURCE) return `${job.resource}:${job.payload?.id}`
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
    // A scoring-device claim (utils/matchHandover) not answered yet, in flight
    // or waiting out a backoff, holds the whole match back: its writes would
    // be refused as long as the previous device holds the match. A refused
    // ('failed') claim holds nothing back.
    if (job.resource === 'match' && job.action === SCORER_CLAIM_ACTION) {
      const matchKey = jobMatchKey(job)
      if (matchKey && (job.status === 'error' || job.status === 'sending')) add(`whole:${matchKey}`, job.id)
      continue
    }
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
 * Refused, failed and dropped jobs go into the activity log (sync.error /
 * sync.dropped, utils/activity). Never the activity uploads themselves (no
 * feedback loop), never a payload.
 */
function reportJobOutcome(job, result, jobError) {
  if (!job || job.resource === 'activity') return
  const failed = result === PERMANENT_FAILURE || result === false || result === STOP_ERROR
  if (!failed && result !== DROP_JOB) return
  emitActivity(result === DROP_JOB ? 'sync.dropped' : 'sync.error', {
    resource: job.resource,
    action: job.action,
    status: jobError?.status ?? null,
    code: jobError?.code ?? null,
    requestId: jobError?.requestId ?? null,
    attempt: (job.attempts || 0) + 1
  }, { level: 'warn', matchExt: jobMatchKey(job) })
}

// An event insert that may go in a batch: its namespaced id names the match
// it carries (bare and legacy ids are rewritten one by one in processJob)
function isBatchableEventInsert(job) {
  if (job?.resource !== 'event' || job.action !== 'insert') return false
  const seedKey = job.payload?.match_id
  const parsed = parseExtId(job.payload?.external_id)
  return typeof seedKey === 'string' && !!seedKey && parsed?.kind === 'event' && parsed.seedKey === seedKey
}
// The columns a job writes: one upsert of rows with different columns would
// write NULL into the columns a row does not carry
const payloadShape = (job) => Object.keys(job.payload || {}).sort().join(',')

// Rows per event batch of a match, where lowered from EVENT_BATCH_MAX: a
// batch that did not get through on its way (network, the request's
// timeout, a page from in front of the backend) was built again at the same
// size by the next pass, and on a link too slow for it the backlog never
// drained. Halved after each such failure, down to one by one; doubled back
// after each event or batch of the match that went through. Per page load.
const eventBatchLimits = new Map()
const eventBatchLimit = (seedKey) => eventBatchLimits.get(seedKey) ?? EVENT_BATCH_MAX
function noteEventBatch(seedKey, rows, delivered) {
  if (!delivered) {
    eventBatchLimits.set(seedKey, Math.max(1, Math.floor(rows / 2)))
    return
  }
  const limit = eventBatchLimits.get(seedKey)
  if (limit == null) return
  if (limit * 2 >= EVENT_BATCH_MAX) eventBatchLimits.delete(seedKey)
  else eventBatchLimits.set(seedKey, limit * 2)
}

/**
 * Event inserts of one match in one upsert (EVENT_BATCH_MAX). A refusal by
 * the backend is left to the jobs one by one, each with its own answer (one
 * refused row parks only itself; take-over, cloud blocks). Any other failure
 * (network, rate limit, no session, a proxy page, a 5xx) is the first job's:
 * the pass goes on as it would after it, the match's other events held back.
 * @returns {Promise<{ result: * }|null>} result true: all sent; another
 *   processJob result: the first job's; null: send them one by one
 */
async function sendEventBatch(jobs, ctx) {
  const answerOf = (error) => {
    const result = failureResult(error, ctx)
    return result === PERMANENT_FAILURE || result === false ? null : { result }
  }
  try {
    const seedKey = jobs[0].payload.match_id
    if ((await findLocalMatchBySeed(seedKey))?.test === true) return null
    const { id: matchUuid, error: lookupError } = await cloudMatchId(seedKey, ctx)
    if (lookupError) return answerOf(lookupError)
    // not in the cloud yet: the first job waits, and with it the match's others
    if (!matchUuid) return { result: null }
    const { error } = await apiFrom('events')
      .upsert(jobs.map(j => eventInsertRow(j.payload, matchUuid)), { onConflict: 'external_id' })
    if (error) {
      safeLog.warn(`[SyncQueue] ${jobs.length} events not sent together (${error.code || error.status})`)
      return answerOf(error)
    }
    return { result: true }
  } catch (err) {
    ctx.error = summarizeError(err)
    return isNetworkException(err) ? { result: STOP_NETWORK } : null
  }
}

/**
 * One pass over the queued jobs, in dependency order. `resources`: the lane
 * (SCORE_LANE by default; the scoresheet files go in runUploadLane).
 * `lease`: withQueueLock's; once another page has taken the lock over, the
 * pass ends before its next job (leaseLost).
 * @returns {Promise<{ processed: number, sent: number, hasError: boolean, hasFailed: boolean, hasRetry: boolean, stopped: boolean, authRequired: boolean, leaseLost?: boolean }>}
 */
export async function runQueuePass({ resources = SCORE_LANE, lease = null } = {}) {
  const queued = (await db.sync_queue.where('status').equals('queued').toArray()).filter(j => resources.includes(j.resource))
  const outcome = { processed: queued.length, sent: 0, hasError: false, hasFailed: false, hasRetry: false, stopped: false, authRequired: false }
  if (queued.length === 0) return outcome
  // (marks left by an earlier pass; only the score lane sets jobs aside, and
  // the upload lane runs beside it)
  if (resources !== UPLOAD_LANE) setAsideJobIds.clear()

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

  // The cloud ids of the matches, read once in this pass (cloudMatchId)
  const pass = { matchIds: new Map() }
  // Jobs sent with an earlier one (an event batch), and the matches whose
  // batch was refused in this pass (their events go one by one)
  const handled = new Set()
  const noBatch = new Set()

  // The queued event inserts after jobs[start] (already read again) that go
  // with it: the same match, the same columns, in order, none held back
  const eventBatchFrom = async (jobs, start, first) => {
    if (!isBatchableEventInsert(first) || noBatch.has(first.payload.match_id)) return [first]
    const seedKey = first.payload.match_id
    const shape = payloadShape(first)
    const ids = new Set([first.payload.external_id])
    let bytes = JSON.stringify(first.payload).length
    const batch = [first]
    const limit = Math.min(EVENT_BATCH_MAX, eventBatchLimit(seedKey))
    for (let k = start + 1; k < jobs.length && batch.length < limit; k++) {
      const next = jobs[k]
      if (!isBatchableEventInsert(next) || next.payload.match_id !== seedKey) break
      if (isHeldBack(entityKey(next), next.id) || isHeldBack(`whole:${seedKey}`, next.id)) break
      const row = await db.sync_queue.get(next.id)
      if (!row || row.status !== 'queued' || !isBatchableEventInsert(row) || row.payload.match_id !== seedKey) break
      // (the same event twice: an upsert cannot write one row twice)
      if (payloadShape(row) !== shape || ids.has(row.payload.external_id)) break
      bytes += JSON.stringify(row.payload).length
      if (bytes > EVENT_BATCH_MAX_BYTES) break
      batch.push(row)
      ids.add(row.payload.external_id)
    }
    return batch
  }

  // Process in dependency order
  for (const resource of RESOURCE_ORDER) {
    if (!resources.includes(resource)) continue
    // A scoring-device claim goes first among the match jobs: the writes
    // queued before "Take back scoring here" would be refused without it
    const claimFirst = (j) => (j.action === SCORER_CLAIM_ACTION ? 0 : 1)
    const jobs = (jobsByResource[resource] || []).sort((a, b) => claimFirst(a) - claimFirst(b) || a.id - b.id)

    for (let i = 0; i < jobs.length; i++) {
      if (handled.has(jobs[i].id)) continue
      if (lease && !lease.held()) {
        // Another page sends the queue now; it reads every job again
        outcome.leaseLost = true
        outcome.hasRetry = true
        return outcome
      }
      let job = jobs[i]
      const key = entityKey(job)
      const matchKey = jobMatchKey(job)
      // (a claim is never held back: the match's other jobs wait for it)
      const isClaim = job.resource === 'match' && job.action === SCORER_CLAIM_ACTION
      if (!isClaim && (isHeldBack(key, job.id) || (matchKey && isHeldBack(`whole:${matchKey}`, job.id)))) {
        // An earlier job for this entity/match failed or is still pending: keep order
        outcome.hasRetry = true
        continue
      }

      // The row as it is now: the list above was read when the pass began.
      // A job deleted since (a newer score replaced it, an undone set took
      // its jobs) or no longer queued (set aside, superseded) is not sent;
      // the payload sent is the one read now.
      const current = await db.sync_queue.get(job.id)
      if (!current || current.status !== 'queued') continue
      job = current

      let result
      let jobError = null
      const batch = await eventBatchFrom(jobs, i, job)
      if (batch.length > 1) {
        const ctx = { error: null, matchIds: pass.matchIds }
        const answer = await sendEventBatch(batch, ctx)
        if (answer?.result === true) {
          for (const b of batch) {
            await db.sync_queue.update(b.id, { status: 'sent', retry_count: 0, network_stops: 0, last_error: null })
            handled.add(b.id)
          }
          outcome.sent += batch.length
          noteEventBatch(job.payload.match_id, batch.length, true)
          await clearCloudBlock(job)
          continue
        }
        if (answer) {
          // as if the first job had got the answer
          result = answer.result
          jobError = ctx.error
          // (lost on its way: smaller next time)
          if (result === STOP_NETWORK || result === STOP_ERROR) noteEventBatch(job.payload.match_id, batch.length, false)
        } else {
          noBatch.add(job.payload.match_id)
        }
      }
      if (result === undefined) {
        // processJob takes the match over when the write is refused for ownership
        result = await processJob(job, pass)
        jobError = takeJobError(job.id)
      }
      reportJobOutcome(job, result, jobError)

      if (result === true) {
        await db.sync_queue.update(job.id, { status: 'sent', retry_count: 0, network_stops: 0, last_error: null })
        outcome.sent++
        if (isBatchableEventInsert(job)) noteEventBatch(job.payload.match_id, 1, true)
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
        // A dropped match creation (its match retired, utils/matchHandover),
        // or a match that moved to another device or was closed on the server
        // (its jobs set aside): the rest of the match is not sent in this
        // pass either
        const setAside = setAsideJobIds.delete(job.id)
        if (matchKey && (blocksWholeMatch(job) || setAside)) blocked.add(`whole:${matchKey}`)
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

// The upload lane (UPLOAD_LANE) runs one pass at a time, beside the score's
let uploadLaneBusy = false

/**
 * One pass over the queued scoresheet files, beside the score's pass (flush
 * starts it and does not wait): a slow upload no longer holds back the
 * rallies of the next match. Same bookkeeping as the score's pass: a network
 * stop leaves the file queued (then backs off), a refusal parks it, and the
 * errored ones come back with retryErrorsInternal until delivered. Its own
 * stops never mark the score's connection as down.
 * @returns {Promise<object|null>} the pass outcome, null while one runs
 */
export async function runUploadLane() {
  if (uploadLaneBusy) return null
  uploadLaneBusy = true
  try {
    // (another page sending the files: it sends these too)
    const { ran, value } = await runAsQueueHolder(UPLOAD_LOCK, (lease) => runQueuePass({ resources: UPLOAD_LANE, lease }))
    return ran ? value : null
  } finally {
    uploadLaneBusy = false
  }
}

/**
 * A scoresheet file is still waiting in its lane (queued, or being sent).
 * The score's pass alone being through is no "synced" then: the badge said
 * synced while the approval's PDF / JSON was still uploading, and a scorer
 * could close the device thinking the cloud had it (2026-10-27 review).
 */
async function uploadLaneHasWork() {
  try {
    return (await db.sync_queue.where('status').anyOf('queued', 'sending').and(j => UPLOAD_LANE.includes(j.resource)).count()) > 0
  } catch {
    return false
  }
}

// One flusher per page. App, Scoreboard and Referee each mount this hook; a
// per-instance flag let two instances process the same queued rows at once
// (restore/delete are not idempotent). Across the pages of the origin: the
// Web Lock (withQueueLock).
let flushInProgress = false
// A flush asked for while one ran (the set end's writes, queued after that
// pass read the queue; another page's, over QUEUE_WAKE_CHANNEL): run again
// as soon as it is done
let flushAgain = false
// This page is running a pass of the score's lane (under QUEUE_LOCK)
let queuePassRunning = false

// Web Locks are there but refuse every request (an opaque origin, a browser
// bug): logged once, then each page flushes on its own
let queueLockRefusedLogged = false

/**
 * Run `fn` holding the origin-wide Web Lock `name`, if no other page of the
 * app holds it (one flusher per origin). Without Web Locks (browsers before
 * 2022), or where the browser refuses the request itself, `fn` runs at once:
 * one flusher per page, as before. `steal`: take the lock from the page
 * holding it (QUEUE_LEASE_MS). `fn` gets a lease: held() turns false once
 * another page has taken the lock over; the pass then ends before its next
 * job.
 * @returns {Promise<{ ran: boolean, value?: * }>} ran false: another page holds it
 */
export async function withQueueLock(name, fn, { steal = false } = {}) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null
  const unlocked = { locked: false, held: () => true }
  if (!locks || typeof locks.request !== 'function') return { ran: true, value: await fn(unlocked) }
  let entered = false
  let lost = false
  let work = null
  const lease = { locked: true, held: () => !lost }
  let out = { ran: false }
  try {
    await locks.request(name, steal ? { steal: true } : { ifAvailable: true }, async (lock) => {
      if (!lock) return
      entered = true
      work = (async () => fn(lease))()
      out = { ran: true, value: await work }
    })
  } catch (err) {
    if (!entered) {
      if (!queueLockRefusedLogged) {
        queueLockRefusedLogged = true
        safeLog.warn('[SyncQueue] The browser refused the queue lock; this page sends the queue on its own:', err?.name || err?.message)
      }
      return { ran: true, value: await fn(unlocked) }
    }
    // Another page took the lock over (it did not hear this one for
    // QUEUE_LEASE_MS): this pass ends before its next job
    if (err?.name !== 'AbortError' || !work) throw err
    lost = true
    safeLog.warn(`[SyncQueue] Another page took ${name} over; this pass ends after its current job`)
    return { ran: true, value: await work }
  }
  return out
}

// The pages' line (BroadcastChannel; none in old browsers), by message type:
// - 'flush': a page that found the queue taken asks the page holding it to
//   run once more after its pass (the pass it runs read the queue before
//   this page's write). A page that hears it while it holds no pass and runs
//   no flush flushes itself (the holder may have just finished); it never
//   asks on in turn, so pages cannot wake each other in a loop.
// - 'busy': the page holding `lock` is alive (QUEUE_BEAT_MS).
// - 'drained': the holder's pass sent jobs. Each page dispatches
//   'sync-queue-drained' too: the scoreboard's live-state catch-up and Match
//   End's listen in the scorer's page, whichever page sent its jobs.
let wakeChannel
// Per lock: when this page first found it taken (since it last held it),
// when it last heard the page holding it, and when it last tried it
const lockTakenSince = new Map()
const holderHeardAt = new Map()
const lockTriedAt = new Map()
function queueWakeChannel() {
  if (wakeChannel !== undefined) return wakeChannel
  wakeChannel = null
  try {
    if (typeof BroadcastChannel === 'function') {
      wakeChannel = new BroadcastChannel(QUEUE_WAKE_CHANNEL)
      wakeChannel.onmessage = (e) => {
        const msg = e?.data || {}
        if (msg.type === 'busy') {
          if (typeof msg.lock === 'string') holderHeardAt.set(msg.lock, Date.now())
          return
        }
        if (msg.type === 'drained') {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('sync-queue-drained', { detail: { sent: Number(msg.sent) || 0, pending: !!msg.pending } }))
          }
          return
        }
        if (queuePassRunning) flushAgain = true
        else if (!flushInProgress && typeof window !== 'undefined') window.dispatchEvent(new Event(QUEUE_WAKE_EVENT))
      }
    }
  } catch {
    wakeChannel = null
  }
  return wakeChannel
}
function postQueueMessage(message) {
  try {
    queueWakeChannel()?.postMessage(message)
  } catch { /* closed: the 5 s poll catches up */ }
}
function wakeQueueHolder() {
  postQueueMessage({ type: 'flush' })
}

/**
 * withQueueLock for this page's passes: the holder is heard (a 'busy' when
 * its pass begins and every QUEUE_BEAT_MS while it runs), and a lock held
 * by a page not heard for QUEUE_LEASE_MS while this page kept finding it
 * taken is taken over.
 */
async function runAsQueueHolder(name, fn) {
  const now = Date.now()
  const lastTry = lockTriedAt.get(name)
  lockTriedAt.set(name, now)
  if (lockTakenSince.has(name) && (lastTry == null || now - lastTry > QUEUE_WATCH_GAP_MS)) lockTakenSince.set(name, now)
  const since = lockTakenSince.get(name)
  const quietFor = since == null ? 0 : now - Math.max(since, holderHeardAt.get(name) || 0)
  const steal = quietFor > QUEUE_LEASE_MS
  if (steal) safeLog.warn(`[SyncQueue] The page holding ${name} has not been heard for ${Math.round(quietFor / 1000)} s; taking it over`)
  const out = await withQueueLock(name, async (lease) => {
    lockTakenSince.delete(name)
    if (!lease.locked) return fn(lease)
    const beat = () => postQueueMessage({ type: 'busy', lock: name })
    beat()
    const timer = setInterval(beat, QUEUE_BEAT_MS)
    try {
      return await fn(lease)
    } finally {
      clearInterval(timer)
    }
  }, { steal })
  if (!out.ran && !lockTakenSince.has(name)) lockTakenSince.set(name, Date.now())
  return out
}

// Last run of flush's throttled housekeeping (requeue of errored jobs, prune)
let lastRequeueAt = 0
let lastPruneAt = 0
// 'failed' jobs are requeued once per page load (the first connected mount)
let startupFailedRetryDone = false
// Refused copies of a game this device continued in its cloud match are
// retired once per page load, before the startup retry sends them again.
// Then the unsent writes of matches closed on the server are set aside, also
// the ones an older version parked as 'failed' (utils/matchHandover
// setAsideClosedCopies): the startup retry would send them only to be
// refused again (2026-10-23, match 406970: a refused restore was retried at
// every start and held the match's newer writes back).
// First, set jobs an older version queued with a bare local id (MatchEnd's
// and the scoreboard's Reopen set and forfeit) get their match key while the
// local set is still there: Close match deletes it, and such a job was then
// dropped unsent (rewriteQueuedSyncJobs never rejects).
let staleCopiesSweep = null
function sweepStaleGameCopiesOnce() {
  staleCopiesSweep ??= rewriteQueuedSyncJobs({ queue: db.sync_queue, sets: db.sets, matches: db.matches, events: db.events }, { statuses: ['queued', 'error', 'failed'] })
    .then(({ rewritten, dropped }) => { if (rewritten || dropped) safeLog.log(`[SyncQueue] Bare set/event ids: ${rewritten} given their match, ${dropped} not attributable (dropped)`) })
    .then(() => retireStaleGameCopies(db))
    .then((n) => { if (n) safeLog.log(`[SyncQueue] Retired ${n} refused local cop${n === 1 ? 'y' : 'ies'} of games continued in their cloud match`) })
    .catch((err) => safeLog.warn('[SyncQueue] Could not check the refused local matches:', err?.message))
    .then(() => setAsideClosedCopies(db))
    .then((n) => { if (n) safeLog.log(`[SyncQueue] Set aside ${n} unsent write(s) of matches closed on the server`) })
    .catch((err) => safeLog.warn('[SyncQueue] Could not set aside the writes of matches closed on the server:', err?.message))
  return staleCopiesSweep
}
// Matches this device lost to another one (OV_SCORER_MOVED) are asked about
// once per page load: closed there meanwhile, they are final here too
let movedMatchesCheck = null
function checkMovedMatchesOnce() {
  movedMatchesCheck ??= closeMovedMatches(db, { check: (key) => apiMatchScorer(key, { claim: false }) })
    .then((n) => { if (n) safeLog.log(`[SyncQueue] ${n} match(es) continued and closed on another device marked final here`) })
    .catch((err) => safeLog.warn('[SyncQueue] Could not check the matches scored on another device:', err?.message))
  return movedMatchesCheck
}
// A clock that went backwards (device time corrected) counts as due
function isDue(last, interval, now) {
  return !last || now - last >= interval || now < last
}
/** Forget the housekeeping timestamps (tests; also a sign-in retries at once). */
export function resetQueueHousekeeping() {
  lastRequeueAt = 0
  lastPruneAt = 0
  claimAttempts.clear()
  eventBatchLimits.clear()
  lockTakenSince.clear()
  holderHeardAt.clear()
  lockTriedAt.clear()
  staleCopiesSweep = null
  movedMatchesCheck = null
}

// Sync status is shared by every mounted instance: whichever instance runs the
// flush publishes it, so the Scoreboard indicator stays current even when the
// App instance did the work.
// Before the first probe: 'connecting' when the browser is online and a cloud
// backend is set (owner 2026-11-11: the startup check flashed the amber "no
// connection" Offline, then Connecting, then Connected); 'offline' only when
// the browser says so or there is no backend to reach.
export function initialSyncStatus() {
  try {
    const online = typeof navigator === 'undefined' || navigator.onLine !== false
    return online && getCloudApiUrl('/api/db') ? 'connecting' : 'offline'
  } catch {
    return 'offline'
  }
}
let currentSyncStatus = initialSyncStatus()
const syncStatusListeners = new Set()
// Activity log: only changes between these groups are an entry (a pass flips
// syncing <-> synced all the time)
const SYNC_STATE_GROUP = { synced: 'ok', syncing: 'ok', connecting: 'ok' }
const syncGroup = (s) => SYNC_STATE_GROUP[s] || s
// Statuses that say the cloud answered
const CLOUD_REACHED = new Set(['synced', 'syncing', 'auth_required'])
// The support diagnostics (utils/diagnosticsInfo): the status, since when,
// and what the last queue pass did
let syncStatusSince = Date.now()
let lastSyncPass = null
function publishSyncDiagnostics() {
  setDiagnosticsInfo('sync', { status: currentSyncStatus, since: syncStatusSince, lastPass: lastSyncPass })
}
function publishSyncStatus(status) {
  if (syncGroup(status) !== syncGroup(currentSyncStatus)) {
    emitActivity('sync.state', { from: currentSyncStatus, to: status }, { level: status === 'error' ? 'warn' : 'info' })
  }
  if (status !== currentSyncStatus) syncStatusSince = Date.now()
  currentSyncStatus = status
  publishSyncDiagnostics()
  for (const listener of syncStatusListeners) listener(status)
}

/**
 * The shared sync status only, without running a queue of its own (the
 * Connect tablets dialog shows it): offline, online_no_supabase, connecting,
 * auth_required, syncing, synced, error.
 */
export function useSyncStatus() {
  const [syncStatus, setLocalSyncStatus] = useState(currentSyncStatus)
  useEffect(() => {
    syncStatusListeners.add(setLocalSyncStatus)
    setLocalSyncStatus(currentSyncStatus)
    return () => { syncStatusListeners.delete(setLocalSyncStatus) }
  }, [])
  return syncStatus
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
  const hasBackend = () => !!getCloudApiUrl('/api/db')
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
      // Only show 'connecting' on initial check, not during regular syncs,
      // and never over a cloud another instance already reaches: the
      // scoreboard's own queue turned the header's chip for one frame
      // (laptop run 2026-10-08, OB-3)
      if (!connectionVerified.current && probeFailures.current === 0 && !CLOUD_REACHED.has(currentSyncStatus)) {
        setSyncStatus('connecting')
      }
      // Try a simple query to check connection - use matches table
      const { error } = await apiFrom('matches').select('id').limit(1)
      if (error) {
        // offline (no answer), no database on this server (LAN relay), or an error
        const status = probeErrorStatus(error)
        if (status === 'error') safeLog.error('[SyncQueue] Connection check error:', error)
        return probeFailed(status)
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

  // One flush's work, under the queue's lock (flush; `lease` withQueueLock's)
  const flushPass = useCallback(async (lease) => {
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

    // A session is there (the checks above): the "sign in again" banner must
    // not stay up through this pass (a long queue takes a minute)
    if (currentSyncStatus === 'auth_required') setSyncStatus('syncing')
    const outcome = await runQueuePass({ lease })
    if (outcome.leaseLost) {
      // Another page sends the queue now (runAsQueueHolder)
      setSyncStatus('syncing')
      return
    }
    noteSyncPass({ sent: outcome.sent, failed: outcome.hasFailed || outcome.hasError ? 1 : 0, pending: outcome.hasRetry ? 1 : 0 })
    lastSyncPass = {
      at: Date.now(),
      processed: outcome.processed ?? null,
      sent: outcome.sent,
      error: !!outcome.hasError,
      failed: !!outcome.hasFailed,
      retry: !!outcome.hasRetry,
      stopped: !!outcome.stopped,
      authRequired: !!outcome.authRequired
    }
    publishSyncDiagnostics()

    if (outcome.authRequired) {
      authBlockedAt = Date.now()
      setSyncStatus('auth_required')
      return
    }
    clearAuthBlock()
    // The scoresheet files, beside the score (not waited for)
    runUploadLane().catch((err) => safeLog.warn('[SyncQueue] Scoresheet upload lane failed:', err?.message))

    if (outcome.sent > 0 && !outcome.stopped && typeof window !== 'undefined') {
      // Consumers that push state outside the queue (match_live_state) catch
      // up, in every page of the app (QUEUE_WAKE_CHANNEL)
      window.dispatchEvent(new CustomEvent('sync-queue-drained', { detail: { sent: outcome.sent, pending: outcome.hasRetry } }))
      postQueueMessage({ type: 'drained', sent: outcome.sent, pending: outcome.hasRetry })
    }

    if (outcome.processed === 0) {
      setSyncStatus(await uploadLaneHasWork() ? 'syncing' : 'synced')
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
      setSyncStatus(await uploadLaneHasWork() ? 'syncing' : 'synced')
    }
  }, [checkSupabaseConnection])

  // `wake: false`: asked for by another page (QUEUE_WAKE_EVENT); a queue
  // taken by a third page is not asked again
  const flush = useCallback(async (options) => {
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
      // One flusher per origin: when another page is sending the queue, it
      // runs once more for this page's writes when its pass is through
      const { ran } = await runAsQueueHolder(QUEUE_LOCK, async (lease) => {
        queuePassRunning = true
        try {
          return await flushPass(lease)
        } finally {
          queuePassRunning = false
        }
      })
      if (!ran && options?.wake !== false) wakeQueueHolder()
    } catch (err) {
      safeLog.error('[SyncQueue] Flush error:', err)
      setSyncStatus('error')
    } finally {
      flushInProgress = false
      if (flushAgain) {
        flushAgain = false
        setTimeout(() => { if (!flushInProgress) flush() }, 0)
      }
    }
  }, [flushPass])

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
    const sweep = sweepStaleGameCopiesOnce()
    if (isOnline) {
      if (hasBackend()) {
        checkSupabaseConnection(true).then(async (connected) => {
          if (connected) {
            await sweep
            checkMovedMatchesOnce()
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

    // Writes the scorer waits for (the set end, useSequentialSync): sent now,
    // behind the older jobs, even while a failed probe backs off (only the
    // 'online' event resets that backoff, and it does not fire when the
    // internet comes back while the Wi-Fi stays up)
    const handleFlushNow = () => {
      probeFailures.current = 0
      nextProbeAt.current = 0
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      if (flushInProgress) flushAgain = true
      else flush()
    }
    window.addEventListener('sync-queue-flush-now', handleFlushNow)
    // The backend answered another request after failing ones (a live-state
    // write, a status read): it is back, no need to wait out the backoff
    window.addEventListener(BACKEND_REACHED_EVENT, handleFlushNow)
    // Another page found the queue taken and asked for a pass (QUEUE_WAKE_CHANNEL)
    queueWakeChannel()
    const handleWake = () => {
      if (!flushInProgress) flush({ wake: false })
    }
    window.addEventListener(QUEUE_WAKE_EVENT, handleWake)

    // Fallback poll every 5s to catch any missed items (e.g., tab focus, retries)
    const interval = setInterval(() => {
      if (!flushInProgress) flush()
    }, 5000)

    return () => {
      window.removeEventListener('sync-queue-write', handleQueueWrite)
      window.removeEventListener('sync-queue-flush-now', handleFlushNow)
      window.removeEventListener(BACKEND_REACHED_EVENT, handleFlushNow)
      window.removeEventListener(QUEUE_WAKE_EVENT, handleWake)
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
