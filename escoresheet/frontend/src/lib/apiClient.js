/**
 * API Client — the supabase-js-shaped client for the OpenVolley backend.
 * Every DB/storage/auth operation goes to the backend (/api/db, /api/storage/*,
 * /api/auth/*, /api/match/restore*), which serves them from its own Postgres
 * and filesystem. No database credentials or keys exist in the frontend.
 */

import { getCloudApiUrl } from '../utils/backendConfig'
import { deviceId, platformName } from '../utils/identity'
import { readSessionMirror, writeSessionMirror } from './sessionMirror'

/**
 * This installation, as the writes name it (server db/019, the scoring-device
 * handover: a match is scored on one device at a time). In the JSON body, not
 * a header: an older backend ignores an unknown body field, while a new
 * header would fail its CORS preflight. Null without storage.
 */
export function writingDevice() {
  const id = deviceId()
  return id ? { id, platform: platformName() } : null
}

// Client protocol version, sent as X-OV-Proto on every data request. The
// backend refuses writes below 2 (426 OV_CLIENT_TOO_OLD), so queued jobs from
// an old cached bundle (pre-namespaced set/event ids, client-side JSON merge)
// cannot act on the shared database.
export const OV_PROTO = '2'

// The backend sends errors either as a plain string ('Too many requests') or as
// { message }. Callers read error.message / error.status, so always hand them an
// object carrying the HTTP status.
export function normalizeError(err, status, fallbackError = 'Request failed') {
  if (!err) return { message: `${fallbackError} (${status})`, status }
  if (typeof err === 'string') return { message: err, status }
  if (typeof err === 'object') {
    return { ...err, message: err.message || `${fallbackError} (${status})`, status: err.status ?? status }
  }
  return { message: String(err), status }
}

// Helper: safely parse JSON response, handling non-ok status codes.
// Every result carries the HTTP `status` so callers can tell a rejected request
// (401) from a transient one (429/5xx).
async function safeJsonResponse(response, fallbackError = 'Request failed') {
  const status = response.status
  if (!response.ok) {
    let body = null
    try {
      body = await response.json()
    } catch { /* non-JSON error body */ }
    const error = normalizeError(body?.error, status, fallbackError)
    // The backend's X-Request-Id (its log line of the refusal): the activity log keeps it
    let requestId = null
    try { requestId = response.headers?.get?.('X-Request-Id') || null } catch { /* no headers */ }
    if (requestId && error && typeof error === 'object') error.requestId = String(requestId).slice(0, 64)
    return { data: null, error, status }
  }
  const result = await response.json()
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, error: result.error ? normalizeError(result.error, status, fallbackError) : (result.error ?? null), status }
  }
  return result
}

// Network failures (fetch rejects) carry no HTTP status.
function networkError(err) {
  noteBackendUnreachable()
  return { message: err?.message || 'Network unavailable', status: 0, network: true }
}

/**
 * Dispatched on window when the cloud backend answers again after requests
 * failed to reach it. An outage of the uplink or of the cloud while the hall
 * Wi-Fi stays up fires no 'online' event, so the sync queue's probe and the
 * scorer's relay socket waited out their backoff (up to 60 s) although the
 * scoreboard's own writes already got through (stress test 2026-10-25).
 */
export const BACKEND_REACHED_EVENT = 'ov-backend-reached'
let backendUnreachable = false
function noteBackendUnreachable() {
  backendUnreachable = true
}
// Any answer of the backend itself (not a 5xx of a proxy or tunnel in front of it)
function noteBackendAnswered(response) {
  if (!backendUnreachable || !response || response.status >= 500) return
  backendUnreachable = false
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(BACKEND_REACHED_EVENT))
}

// Upper bound for one /api/db round trip.
export const DB_REQUEST_TIMEOUT_MS = 20000

function requestTimeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms)
    }
    if (typeof AbortController !== 'undefined') {
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), ms)
      return ctrl.signal
    }
  } catch { /* no abort support: fall through */ }
  return undefined
}

// ==================== Database (drop-in for supabase.from()) ====================

class QueryBuilder {
  constructor(table) {
    this._table = table
    this._action = null
    this._params = {}
    this._headers = null
  }

  /**
   * Extra request headers for this request only, e.g. the match token of a
   * PIN check (serverDataSync matchAccessHeaders). Content-Type, X-OV-Proto
   * and Authorization cannot be replaced.
   */
  headers(extra) {
    if (extra && typeof extra === 'object') this._headers = { ...(this._headers || {}), ...extra }
    return this
  }

  // --- Actions ---
  select(columns, options) {
    // supabase-js semantics: .select() after insert/upsert/update/delete asks for
    // the written rows back. It must not turn the write into a plain SELECT.
    if (this._action && this._action !== 'select') {
      this._params.returning = columns || '*'
      if (options?.count) this._params.count = options.count
      if (options?.head) this._params.head = options.head
      return this
    }
    this._action = 'select'
    if (columns) this._params.columns = columns
    if (options?.count) this._params.count = options.count
    if (options?.head) this._params.head = options.head
    return this
  }

  insert(data) {
    this._action = 'insert'
    this._params.data = data
    return this
  }

  upsert(data, options) {
    this._action = 'upsert'
    this._params.data = data
    if (options?.onConflict) this._params.onConflict = options.onConflict
    return this
  }

  update(data) {
    this._action = 'update'
    this._params.data = data
    return this
  }

  delete() {
    this._action = 'delete'
    return this
  }

  // --- Filters ---
  _addFilter(type, column, value) {
    if (!this._params.filters) this._params.filters = []
    this._params.filters.push({ type, column, value })
    return this
  }

  eq(column, value) { return this._addFilter('eq', column, value) }
  neq(column, value) { return this._addFilter('neq', column, value) }
  gt(column, value) { return this._addFilter('gt', column, value) }
  gte(column, value) { return this._addFilter('gte', column, value) }
  lt(column, value) { return this._addFilter('lt', column, value) }
  lte(column, value) { return this._addFilter('lte', column, value) }
  like(column, value) { return this._addFilter('like', column, value) }
  ilike(column, value) { return this._addFilter('ilike', column, value) }
  in(column, value) { return this._addFilter('in', column, value) }
  contains(column, value) { return this._addFilter('contains', column, value) }
  is(column, value) { return this._addFilter('is', column, value) }

  // --- Modifiers ---
  order(column, options) {
    if (!this._params.order) this._params.order = []
    this._params.order.push({ column, ascending: options?.ascending !== false })
    return this
  }

  limit(n) {
    this._params.limit = n
    return this
  }

  single() {
    this._params.single = true
    return this
  }

  maybeSingle() {
    this._params.maybeSingle = true
    return this
  }

  // --- Execute ---
  async then(resolve, reject) {
    try {
      const result = await this._execute()
      resolve(result)
    } catch (err) {
      if (reject) reject(err)
      else resolve({ data: null, error: { message: err.message } })
    }
  }

  async _execute() {
    const apiUrl = getCloudApiUrl('/api/db')
    if (!apiUrl) {
      return { data: null, error: { message: 'Backend not available' } }
    }

    let response
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: this._headers ? { ...this._headers, ...getAuthHeaders() } : getAuthHeaders(),
        body: JSON.stringify({
          table: this._table,
          action: this._action,
          params: this._params,
          // writes name the device (db/019); reads never need it
          ...(this._action && this._action !== 'select' ? deviceField() : {})
        }),
        // A stalled request (captive portal, half-open TCP) must not hang the
        // page-wide sync flush forever.
        signal: requestTimeoutSignal(DB_REQUEST_TIMEOUT_MS)
      })
    } catch (err) {
      return { data: null, error: networkError(err), count: undefined, status: 0 }
    }
    noteBackendAnswered(response)

    const result = await safeJsonResponse(response, 'Database operation failed')
    return { data: result.data ?? null, error: result.error ?? null, count: result.count, status: result.status }
  }
}

/**
 * Drop-in replacement for supabase.from(table)
 * Usage: const { data, error } = await apiFrom('matches').select('*').eq('id', id).single()
 */
export function apiFrom(table) {
  return new QueryBuilder(table)
}

// ==================== Helpers ====================

// Milliseconds since `at` (an ISO time or epoch ms), null when unknown
export function ageOf(at, now = Date.now()) {
  const t = typeof at === 'number' ? at : (typeof at === 'string' ? Date.parse(at) : NaN)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round(now - t))
}

function deviceField() {
  const device = writingDevice()
  return device ? { device } : {}
}

function getAuthHeaders() {
  const headers = { 'Content-Type': 'application/json', 'X-OV-Proto': OV_PROTO }
  const token = getStoredToken()
  if (token?.access_token) {
    headers['Authorization'] = `Bearer ${token.access_token}`
  }
  return headers
}

// ==================== Match restore ====================

// A whole-match restore can carry thousands of events; the server runs it in
// one transaction with a 60 s statement timeout.
export const RESTORE_REQUEST_TIMEOUT_MS = 90000

async function postJson(path, body, { auth = true, timeoutMs = DB_REQUEST_TIMEOUT_MS, fallbackError = 'Request failed' } = {}) {
  const apiUrl = getCloudApiUrl(path)
  if (!apiUrl) return { data: null, error: { message: 'Backend not available' }, status: 0 }
  let response
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: auth ? getAuthHeaders() : { 'Content-Type': 'application/json', 'X-OV-Proto': OV_PROTO },
      body: JSON.stringify(body),
      signal: requestTimeoutSignal(timeoutMs)
    })
  } catch (err) {
    return { data: null, error: networkError(err), status: 0 }
  }
  noteBackendAnswered(response)
  const result = await safeJsonResponse(response, fallbackError)
  return { data: result.data ?? null, error: result.error ?? null, status: result.status }
}

/**
 * One JSON request to a cloud endpoint with the session's token (the account,
 * admin and saved-team endpoints). GET and DELETE send no body.
 * A network failure is { error: { network: true }, status: 0 }.
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
 * @param {string} path e.g. '/api/admin/accounts?filter=pending'
 * @param {object} [body]
 * @param {{timeoutMs?: number, fallbackError?: string}} [opts]
 * @returns {Promise<{data: any, error: object|null, status: number}>}
 */
export async function apiRequest(method, path, body, { timeoutMs = DB_REQUEST_TIMEOUT_MS, fallbackError = 'Request failed' } = {}) {
  const apiUrl = getCloudApiUrl(path)
  if (!apiUrl) return { data: null, error: { message: 'Backend not available', status: 0, network: true }, status: 0 }
  const verb = String(method || 'GET').toUpperCase()
  const init = { method: verb, headers: getAuthHeaders(), signal: requestTimeoutSignal(timeoutMs) }
  if (verb !== 'GET' && verb !== 'DELETE' && body !== undefined) init.body = JSON.stringify(body ?? {})
  let response
  try {
    response = await fetch(apiUrl, init)
  } catch (err) {
    return { data: null, error: networkError(err), status: 0 }
  }
  noteBackendAnswered(response)
  let result
  try {
    result = await safeJsonResponse(response, fallbackError)
  } catch {
    return { data: null, error: normalizeError(null, response.status, fallbackError), status: response.status }
  }
  return { data: result?.data ?? null, error: result?.error ?? null, status: result?.status ?? response.status }
}

/**
 * GET a file from a cloud endpoint with the session's token (the admin's
 * activity export). Resolves { blob, filename } or { error }.
 */
export async function apiDownload(path, { timeoutMs = 120000 } = {}) {
  const apiUrl = getCloudApiUrl(path)
  if (!apiUrl) return { error: { message: 'Backend not available', status: 0, network: true } }
  let response
  try {
    response = await fetch(apiUrl, { method: 'GET', headers: getAuthHeaders(), signal: requestTimeoutSignal(timeoutMs) })
  } catch (err) {
    return { error: networkError(err) }
  }
  if (!response.ok) {
    let body = null
    try { body = await response.json() } catch { /* not JSON */ }
    return { error: normalizeError(body?.error, response.status, 'Download failed') }
  }
  const disposition = response.headers?.get?.('Content-Disposition') || ''
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || null
  return { blob: await response.blob(), filename }
}

/**
 * Restore one match in the cloud in a single server-side transaction:
 * upsert the match by external_id, replace its sets, events and live state.
 * Needs a session. 426 / 429 / 5xx / network errors are worth retrying later.
 * @param {{match: object, sets?: object[], events?: object[], liveState?: object|null}} payload
 * @returns {Promise<{data: {id: string, counts: {sets: number, events: number, liveState: number}, dropped?: object}|null, error: object|null, status: number}>}
 */
export function apiMatchRestore({ match, sets = [], events = [], liveState = null, queuedAt = null, rekey = null }) {
  // The device: a backup restored here is this device's take-over (db/019),
  // unless another device took the match over after the restore was made
  // (age_ms: how long ago, by this device's own clock, so no clock skew).
  // rekey: a hand-over's move of the cloud rows to this device's ids
  // (backupManager.importMatchFromSupabase), renamed in place on the server
  const ageMs = ageOf(queuedAt)
  return postJson('/api/match/restore', { match, sets, events, liveState, ...(rekey ? { rekey } : {}), ...deviceField(), ...(ageMs != null ? { age_ms: ageMs } : {}) }, {
    timeoutMs: RESTORE_REQUEST_TIMEOUT_MS,
    fallbackError: 'Match restore failed'
  })
}

/**
 * Look a match up by game number and game PIN (exact match, attempt-limited).
 * Anonymous. 404 (error.code OV_NOT_FOUND) = no match with this number and PIN;
 * 429 (OV_TOO_MANY_ATTEMPTS) = too many wrong guesses, wait a few minutes.
 * `claim`: this device continues the match (the restore dialog's Confirm,
 * "Take back scoring here"): the game PIN makes it the match's scoring
 * device (db/019), signed in or not, and data.scorer says so ({ mine: true,
 * moved }); `externalId`: only that match is claimed. An older backend
 * ignores both (no data.scorer: the claim is queued as before).
 * @returns {Promise<{data: {match: object, sets: object[], events: object[], liveState: object|null, scorer?: {mine: boolean, moved: boolean}}|null, error: object|null, status: number}>}
 */
export function apiMatchRestoreByPin(gameN, pin, { claim = false, externalId = null } = {}) {
  // With a session the backend also makes this account an editor of the match
  // (proving the game PIN is the take-over); without one it is a plain lookup.
  const device = claim ? writingDevice() : null
  const body = device ? { gameN, pin, claim: true, device, ...(externalId ? { external_id: externalId } : {}) } : { gameN, pin }
  return postJson('/api/match/restore-by-pin', body, { fallbackError: 'Match lookup failed' })
}

/**
 * Take-over: prove the game PIN of a cloud match so the signed-in account may
 * write it (the backend adds it as an editor). Needs a session.
 * 404 OV_NOT_FOUND = wrong PIN / unknown match; 429 OV_TOO_MANY_ATTEMPTS.
 * @returns {Promise<{data: {id: string, external_id: string, role: 'creator'|'editor'}|null, error: object|null, status: number}>}
 */
export function apiMatchClaim(externalId, pin) {
  return postJson('/api/match/claim', { externalId, pin }, { fallbackError: 'Match take-over failed' })
}

/**
 * The scoring device of a match (db/019, the scoring-device handover).
 * claim true: this device scores the match from now on (a join, "Take back
 * scoring here"); the previous one is told and refused (409 OV_SCORER_MOVED).
 * claim false: is this device the scorer? Needs a session; the creator, an
 * editor or an admin of the match. 404 OV_MATCH_NOT_FOUND: not in the cloud
 * yet; 409 OV_MATCH_CLOSED: closed; a 404 without code: an older backend.
 * @returns {Promise<{data: {external_id: string, mine: boolean|null, moved?: boolean, scorer: {platform: string|null, at: string|null}|null, previous?: object|null}|null, error: object|null, status: number}>}
 */
export function apiMatchScorer(externalId, { claim = true } = {}) {
  const device = writingDevice()
  if (!device) return Promise.resolve({ data: null, error: { message: 'No device id', code: 'OV_NO_DEVICE' }, status: 0 })
  return postJson('/api/match/scorer', { external_id: externalId, device, claim }, { fallbackError: 'Scoring device change failed' })
}

/**
 * Upload activity log entries (utils/activity/upload): at most 500 per call.
 * Needs a session.
 * @returns {Promise<{data: {accepted: string[], rejected: {uid: string, code: string}[]}|null, error: object|null, status: number}>}
 */
export function apiPostActivity(entries) {
  return postJson('/api/activity', { entries }, { timeoutMs: 30000, fallbackError: 'Activity upload failed' })
}

/**
 * Send event revisions (undo / delete / edit / restore of logged events, see
 * db/eventHistory.js) of one match. The server voids or edits its copy of the
 * events and keeps the revision (POST /api/match/event-revisions). Needs a
 * session. 404 OV_MATCH_NOT_FOUND: the match is not on the server yet; a 404
 * without that code: a server without the route (older backend, LAN relay).
 * @param {string} matchExternalId the match seed_key
 * @param {object[]} revisions domain/eventRevisions revisionOfJob() bodies
 * @returns {Promise<{data: {applied: number, pending: number}|null, error: object|null, status: number}>}
 */
export function apiPostEventRevisions(matchExternalId, revisions) {
  // The device sending them (db/019): a revision's own device_id is the one
  // that made it, which may be this installation's id before a "clear all"
  return postJson('/api/match/event-revisions', { match_external_id: matchExternalId, revisions, ...deviceField() }, {
    fallbackError: 'Event history upload failed'
  })
}

// ==================== Base64 (storage uploads) ====================

// btoa() only takes Latin-1 and String.fromCharCode(...bytes) overflows the call
// stack on large files, so encode raw bytes in chunks. Text is encoded as UTF-8
// first, which is what download + blob.text() decodes.
export function bytesToBase64(bytes) {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export async function toBase64(fileData) {
  if (typeof Blob !== 'undefined' && fileData instanceof Blob) {
    return bytesToBase64(new Uint8Array(await fileData.arrayBuffer()))
  }
  if (fileData instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(fileData))
  if (ArrayBuffer.isView(fileData)) {
    return bytesToBase64(new Uint8Array(fileData.buffer, fileData.byteOffset, fileData.byteLength))
  }
  const text = typeof fileData === 'string'
    ? fileData
    : (fileData && typeof fileData === 'object' ? JSON.stringify(fileData) : String(fileData))
  return bytesToBase64(new TextEncoder().encode(text))
}

// ==================== Storage ====================

/**
 * Upper bound for one storage upload of `bodyLength` characters: the /api/db
 * bound plus the time the body takes at 20 KB/s (a ~1 MB scoresheet PDF on a
 * weak hall uplink). Uploads had none: a connection that passed no data held
 * the scorer's "Confirm and approve" for minutes (stress test 2026-10-25).
 */
export function storageUploadTimeoutMs(bodyLength) {
  return DB_REQUEST_TIMEOUT_MS + Math.ceil((Number(bodyLength) || 0) / 20000) * 1000
}

export const apiStorage = {
  from(bucket) {
    return {
      async upload(path, fileData, options = {}) {
        const apiUrl = getCloudApiUrl('/api/storage/upload')
        if (!apiUrl) return { data: null, error: { message: 'Backend not available' } }

        // Convert file data to base64 (inside the try: an encoding failure must
        // come back as { error }, not throw past the caller)
        let fileBase64
        try {
          fileBase64 = await toBase64(fileData)
        } catch (err) {
          return { data: null, error: { message: `Could not encode upload: ${err?.message || err}` } }
        }

        try {
          const body = JSON.stringify({
            bucket,
            path,
            fileBase64,
            contentType: options.contentType,
            upsert: options.upsert
          })
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: getAuthHeaders(),
            body,
            signal: requestTimeoutSignal(storageUploadTimeoutMs(body.length))
          })
          return safeJsonResponse(response, 'Storage upload failed')
        } catch (err) {
          return { data: null, error: networkError(err) }
        }
      },

      async download(path) {
        const apiUrl = getCloudApiUrl('/api/storage/download')
        if (!apiUrl) return { data: null, error: { message: 'Backend not available' } }

        let response
        try {
          response = await fetch(apiUrl, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ bucket, path })
          })
        } catch (err) {
          return { data: null, error: networkError(err) }
        }
        if (!response.ok) {
          return await safeJsonResponse(response, 'Storage download failed')
        }
        const result = await response.json()

        if (result.error) return { data: null, error: result.error }

        // Convert base64 back to Blob
        try {
          const binaryString = atob(result.data)
          const bytes = new Uint8Array(binaryString.length)
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i)
          }
          const blob = new Blob([bytes])
          return { data: blob, error: null }
        } catch {
          return { data: null, error: { message: 'Invalid file data received' } }
        }
      },

      async list(dirPath, options = {}) {
        const apiUrl = getCloudApiUrl('/api/storage/list')
        if (!apiUrl) return { data: null, error: { message: 'Backend not available' } }

        try {
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ bucket, path: dirPath, options })
          })
          return safeJsonResponse(response, 'Storage list failed')
        } catch (err) {
          return { data: null, error: networkError(err) }
        }
      }
    }
  }
}

// ==================== Auth ====================

async function authRequest(action, body = {}) {
  const apiUrl = getCloudApiUrl(`/api/auth/${action}`)
  if (!apiUrl) return { data: null, error: { message: 'Backend not available' } }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return safeJsonResponse(response, 'Auth request failed')
  } catch (err) {
    return { data: null, error: networkError(err) }
  }
}

// Same-tab notification: the 'storage' event only fires in OTHER tabs, so without
// this AuthContext keeps showing a signed-in user after the token is dropped here.
const TOKEN_CHANGE_EVENT = 'api-auth-token-change'
// Exported for listeners outside the auth context (the sync queue resumes on sign-in)
export const AUTH_TOKEN_CHANGE_EVENT = TOKEN_CHANGE_EVENT
export const AUTH_TOKEN_STORAGE_KEY = 'api_auth_token'
function notifyTokenChange(session) {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(TOKEN_CHANGE_EVENT, { detail: session || null }))
    }
  } catch { /* ignore */ }
}

/**
 * { Authorization: 'Bearer <session>' } for a cloud call made outside this
 * client (lib/phoneSignApi.js), or {} without a valid session.
 */
export function authorizationHeader() {
  const token = getStoredToken()
  return token?.access_token ? { Authorization: `Bearer ${token.access_token}` } : {}
}

// Session token management. localStorage holds the session the app reads;
// lib/sessionMirror keeps a copy in IndexedDB, which survives a crash right
// after signing in (restoreMirroredSession).
function getStoredToken() {
  try {
    const stored = localStorage.getItem('api_auth_token')
    if (!stored) {
      // (a crash may have lost it: the IndexedDB copy, once per page load)
      restoreMirroredSession()
      return null
    }
    const session = JSON.parse(stored)
    // Check token expiration
    if (session?.expires_at && Date.now() / 1000 > session.expires_at) {
      localStorage.removeItem('api_auth_token')
      writeSessionMirror(null)
      notifyTokenChange(null)
      return null
    }
    return session
  } catch { return null }
}

function storeToken(session) {
  sessionSetHere = true
  if (session) {
    localStorage.setItem('api_auth_token', JSON.stringify(session))
  } else {
    localStorage.removeItem('api_auth_token')
  }
  writeSessionMirror(session || null)
  notifyTokenChange(session)
}

// Refresh the stored session in place (sliding expiry, fresh user) without
// announcing a sign-in: the session did not change hands.
function refreshStoredToken(session) {
  try {
    localStorage.setItem('api_auth_token', JSON.stringify(session))
  } catch { /* storage full or blocked: keep the old copy */ }
  writeSessionMirror(session)
}

// Set once this page load stored or removed a session itself: a restore still
// reading the IndexedDB copy must not bring an older one back over it
let sessionSetHere = false
let sessionRestore = null

/**
 * Once per page load: when localStorage has no session but its IndexedDB copy
 * (lib/sessionMirror) has one that has not expired, it is put back and
 * announced like a sign-in (the sync queue resumes, AuthContext shows the
 * user). Chromium writes localStorage to disk only about a minute after the
 * first writes of a start: a crash or power loss within a minute of signing in
 * signed the scorer out, while the match itself (IndexedDB) was kept (stress
 * test 2026-10-25). Never rejects.
 */
export function restoreMirroredSession() {
  if (!sessionRestore) {
    sessionRestore = (async () => {
      if (typeof localStorage === 'undefined' || localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)) return
      const session = await readSessionMirror()
      if (!session?.access_token || sessionSetHere || localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)) return
      if (session.expires_at && Date.now() / 1000 > session.expires_at) {
        await writeSessionMirror(null)
        return
      }
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, JSON.stringify(session))
      console.log('[apiClient] Session restored from its IndexedDB copy')
      notifyTokenChange(session)
    })().catch(() => {})
  }
  return sessionRestore
}

// restoreMirroredSession, waited for at most this long by the session reads at
// start: an IndexedDB that does not answer must not hold the sign-in state
const SESSION_RESTORE_WAIT_MS = 1500
function sessionRestored() {
  return Promise.race([restoreMirroredSession(), new Promise(resolve => setTimeout(resolve, SESSION_RESTORE_WAIT_MS))])
}

/**
 * Did the auth server reject the token itself? Only then may the stored login be
 * cleared. Offline (network error), rate limiting (429) and server errors (5xx)
 * keep the session: a scorer who opens the app without internet must stay
 * signed in.
 */
const SESSION_REJECTED_MESSAGE = /\bjwt\b|token is expired|token has expired|token is malformed|(sub|session_id) claim/i

export function isSessionRejected(result) {
  const err = result?.error
  if (!err) return false
  if (err.network) return false
  const status = err.status ?? result.status
  if (status === 401 || err.code === 'invalid_token') return true
  // The self-hosted backend answers 401 invalid_token. The old Supabase proxy
  // answered get-user with HTTP 200 + { error } when GoTrue rejected the JWT;
  // kept for a backend that still runs it. Match only GoTrue's token errors,
  // never generic gateway text ('invalid response from upstream') seen during
  // an outage.
  if (status === 200 && SESSION_REJECTED_MESSAGE.test(err.message || '')) return true
  return false
}

// Sign-in busy (503 auth_busy: the server's sign-in gate lets a few through
// per second for the whole server, Retry-After 2 s). Asked again this many
// times, each after 2-4 s, before the error is shown: at a national peak
// hundreds of scorers sign in within two minutes and one in ten got it
// (load test 2026-10-26).
const SIGN_IN_BUSY_RETRIES = 3
const isAuthBusy = (result) => result?.status === 503 && result?.error?.code === 'auth_busy'

export const apiAuth = {
  async signInWithPassword({ email, password }) {
    let result = await authRequest('sign-in', { email, password })
    for (let i = 0; i < SIGN_IN_BUSY_RETRIES && isAuthBusy(result); i++) {
      await new Promise((resolve) => setTimeout(resolve, Math.round(2000 * (1 + Math.random()))))
      result = await authRequest('sign-in', { email, password })
    }
    if (!result.error && result.data?.session) {
      storeToken(result.data.session)
    }
    return result
  },

  async signUp({ email, password, options }) {
    const result = await authRequest('sign-up', {
      email,
      password,
      metadata: options?.data || {},
      // the language of the confirmation email, when the server sends one
      ...(options?.lang ? { lang: options.lang } : {}),
      // the app it signs up in ('beach': OpenBeach's mail and membership);
      // left out, the server treats it as before (OpenVolley)
      ...(options?.app ? { app: options.app } : {})
    })
    return result
  },

  async signOut() {
    // Revoke the session on the server first (best effort: offline or a server
    // error must not keep the user signed in on this device).
    const token = getStoredToken()?.access_token
    if (token) {
      try { await authRequest('sign-out', { access_token: token }) } catch { /* ignore */ }
    }
    storeToken(null)
    return { error: null }
  },

  async getSession() {
    await sessionRestored()
    const session = getStoredToken()
    if (!session?.access_token) return { data: { session: null }, error: null }

    // Verify token is still valid
    const result = await authRequest('get-user', { access_token: session.access_token })
    if (result.error) {
      if (isSessionRejected(result)) {
        storeToken(null)
        return { data: { session: null }, error: null }
      }
      // Offline / 429 / 5xx: keep the stored login and return it unverified
      return { data: { session: { ...session, unverified: true } }, error: null }
    }
    // The server slides the expiry (30 days, capped at 90 from sign-in); keep
    // its expires_at so getStoredToken's local expiry check follows it.
    const refreshed = {
      ...session,
      user: result.data?.user ?? session.user,
      ...(typeof result.data?.session?.expires_at === 'number' ? { expires_at: result.data.session.expires_at } : {})
    }
    if (refreshed.expires_at !== session.expires_at || refreshed.user !== session.user) refreshStoredToken(refreshed)
    return { data: { session: refreshed }, error: null }
  },

  async getUser(token) {
    const accessToken = token || getStoredToken()?.access_token
    if (!accessToken) return { data: { user: null }, error: null }
    return authRequest('get-user', { access_token: accessToken })
  },

  // Always { data: { requested: true } } for a valid address, known or not
  // (no enumeration); 503 reset_unavailable when the server sends no email.
  // options.app 'beach': the OpenBeach mail, with a link to its manager.
  async resetPasswordForEmail(email, options) {
    return authRequest('reset-password', { email, ...(options?.lang ? { lang: options.lang } : {}), ...(options?.app ? { app: options.app } : {}) })
  },

  // The links of the account emails (utils/authLinks.js). The token goes
  // nowhere else and is never logged.
  async confirmPasswordReset(token, password, lang, app) {
    return authRequest('reset-password/confirm', { token, password, ...(lang ? { lang } : {}), ...(app ? { app } : {}) })
  },

  async confirmEmail(token) {
    return authRequest('confirm-email', { token })
  },

  async resendConfirmation(lang, app) {
    const token = getStoredToken()?.access_token
    return authRequest('resend-confirmation', { access_token: token, ...(lang ? { lang } : {}), ...(app ? { app } : {}) })
  },

  async updateUser({ email }) {
    const token = getStoredToken()?.access_token
    return authRequest('update-user', { access_token: token, email })
  },

  async deleteUser() {
    const token = getStoredToken()?.access_token
    const result = await authRequest('delete-account', { access_token: token })
    if (!result.error) storeToken(null)
    return result
  },

  // Auth state change listener — polls session status
  // Returns { data: { subscription } } matching Supabase API shape
  onAuthStateChange(callback) {
    // Check session immediately (once a session lost from localStorage is
    // back from its IndexedDB copy)
    sessionRestored().then(() => {
      const session = getStoredToken()
      callback('INITIAL_SESSION', session?.access_token ? session : null)
    })

    // Listen for storage events (cross-tab sync)
    const handler = (e) => {
      if (e.key === 'api_auth_token') {
        let newSession = null
        try { newSession = e.newValue ? JSON.parse(e.newValue) : null } catch { /* ignore corrupt data */ }
        callback(newSession ? 'SIGNED_IN' : 'SIGNED_OUT', newSession)
      }
    }
    window.addEventListener('storage', handler)

    // Same-tab changes (token expired or rejected, sign-in, sign-out)
    const localHandler = (e) => {
      const newSession = e.detail || null
      callback(newSession ? 'SIGNED_IN' : 'SIGNED_OUT', newSession)
    }
    window.addEventListener(TOKEN_CHANGE_EVENT, localHandler)

    return {
      data: {
        subscription: {
          unsubscribe: () => {
            window.removeEventListener('storage', handler)
            window.removeEventListener(TOKEN_CHANGE_EVENT, localHandler)
          }
        }
      }
    }
  },

  // Profile operations (convenience wrappers)
  async getProfile(token) {
    const accessToken = token || getStoredToken()?.access_token
    return authRequest('profile', { access_token: accessToken })
  }

  // No updateProfile here: /api/auth/profile is read-only (it ignored `updates`
  // and answered 200, so a write looked saved and was not). Profile writes go
  // through AuthContext.updateProfile -> /api/db, which scopes the row to the
  // signed-in user, strips roles and returns the written row to check.
}
