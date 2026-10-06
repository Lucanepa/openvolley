/**
 * API Client — the supabase-js-shaped client for the OpenVolley backend.
 * Every DB/storage/auth operation goes to the backend (/api/db, /api/storage/*,
 * /api/auth/*, /api/match/restore*), which serves them from its own Postgres
 * and filesystem. No database credentials or keys exist in the frontend.
 */

import { getCloudApiUrl } from '../utils/backendConfig'

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
    return { data: null, error: normalizeError(body?.error, status, fallbackError), status }
  }
  const result = await response.json()
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, error: result.error ? normalizeError(result.error, status, fallbackError) : (result.error ?? null), status }
  }
  return result
}

// Network failures (fetch rejects) carry no HTTP status.
function networkError(err) {
  return { message: err?.message || 'Network unavailable', status: 0, network: true }
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
          params: this._params
        }),
        // A stalled request (captive portal, half-open TCP) must not hang the
        // page-wide sync flush forever.
        signal: requestTimeoutSignal(DB_REQUEST_TIMEOUT_MS)
      })
    } catch (err) {
      return { data: null, error: networkError(err), count: undefined, status: 0 }
    }

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
  const result = await safeJsonResponse(response, fallbackError)
  return { data: result.data ?? null, error: result.error ?? null, status: result.status }
}

/**
 * Restore one match in the cloud in a single server-side transaction:
 * upsert the match by external_id, replace its sets, events and live state.
 * Needs a session. 426 / 429 / 5xx / network errors are worth retrying later.
 * @param {{match: object, sets?: object[], events?: object[], liveState?: object|null}} payload
 * @returns {Promise<{data: {id: string, counts: {sets: number, events: number, liveState: number}, dropped?: object}|null, error: object|null, status: number}>}
 */
export function apiMatchRestore({ match, sets = [], events = [], liveState = null }) {
  return postJson('/api/match/restore', { match, sets, events, liveState }, {
    timeoutMs: RESTORE_REQUEST_TIMEOUT_MS,
    fallbackError: 'Match restore failed'
  })
}

/**
 * Look a match up by game number and game PIN (exact match, attempt-limited).
 * Anonymous. 404 (error.code OV_NOT_FOUND) = no match with this number and PIN;
 * 429 (OV_TOO_MANY_ATTEMPTS) = too many wrong guesses, wait a few minutes.
 * @returns {Promise<{data: {match: object, sets: object[], events: object[], liveState: object|null}|null, error: object|null, status: number}>}
 */
export function apiMatchRestoreByPin(gameN, pin) {
  // With a session the backend also makes this account an editor of the match
  // (proving the game PIN is the take-over); without one it is a plain lookup.
  return postJson('/api/match/restore-by-pin', { gameN, pin }, { fallbackError: 'Match lookup failed' })
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
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
              bucket,
              path,
              fileBase64,
              contentType: options.contentType,
              upsert: options.upsert
            })
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

// Session token management
function getStoredToken() {
  try {
    const stored = localStorage.getItem('api_auth_token')
    if (!stored) return null
    const session = JSON.parse(stored)
    // Check token expiration
    if (session?.expires_at && Date.now() / 1000 > session.expires_at) {
      localStorage.removeItem('api_auth_token')
      notifyTokenChange(null)
      return null
    }
    return session
  } catch { return null }
}

function storeToken(session) {
  if (session) {
    localStorage.setItem('api_auth_token', JSON.stringify(session))
  } else {
    localStorage.removeItem('api_auth_token')
  }
  notifyTokenChange(session)
}

// Refresh the stored session in place (sliding expiry, fresh user) without
// announcing a sign-in: the session did not change hands.
function refreshStoredToken(session) {
  try {
    localStorage.setItem('api_auth_token', JSON.stringify(session))
  } catch { /* storage full or blocked: keep the old copy */ }
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

export const apiAuth = {
  async signInWithPassword({ email, password }) {
    const result = await authRequest('sign-in', { email, password })
    if (!result.error && result.data?.session) {
      storeToken(result.data.session)
    }
    return result
  },

  async signUp({ email, password, options }) {
    const result = await authRequest('sign-up', {
      email,
      password,
      metadata: options?.data || {}
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

  async resetPasswordForEmail(email, options) {
    return authRequest('reset-password', { email, redirectTo: options?.redirectTo })
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
    // Check session immediately
    const session = getStoredToken()
    if (session?.access_token) {
      setTimeout(() => callback('INITIAL_SESSION', session), 0)
    } else {
      setTimeout(() => callback('INITIAL_SESSION', null), 0)
    }

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
