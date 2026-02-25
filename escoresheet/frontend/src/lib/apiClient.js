/**
 * API Client — Drop-in replacement for Supabase frontend calls.
 * Routes all DB/storage/auth operations through the backend proxy
 * so that Supabase credentials stay server-side.
 */

import { getApiUrl } from '../utils/backendConfig'

// ==================== Database (drop-in for supabase.from()) ====================

class QueryBuilder {
  constructor(table) {
    this._table = table
    this._action = null
    this._params = {}
  }

  // --- Actions ---
  select(columns, options) {
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
    const apiUrl = getApiUrl('/api/db')
    if (!apiUrl) {
      return { data: null, error: { message: 'Backend not available' } }
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: this._table,
        action: this._action,
        params: this._params
      })
    })

    const result = await response.json()
    return { data: result.data ?? null, error: result.error ?? null, count: result.count }
  }
}

/**
 * Drop-in replacement for supabase.from(table)
 * Usage: const { data, error } = await apiFrom('matches').select('*').eq('id', id).single()
 */
export function apiFrom(table) {
  return new QueryBuilder(table)
}

// ==================== RPC ====================

export async function apiRpc(fn, params = {}) {
  const apiUrl = getApiUrl('/api/db/rpc')
  if (!apiUrl) return { data: null, error: { message: 'Backend not available' } }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fn, params })
  })
  return response.json()
}

// ==================== Storage ====================

export const apiStorage = {
  from(bucket) {
    return {
      async upload(path, fileData, options = {}) {
        const apiUrl = getApiUrl('/api/storage/upload')
        if (!apiUrl) return { data: null, error: { message: 'Backend not available' } }

        // Convert file data to base64
        let fileBase64
        if (fileData instanceof Blob) {
          const arrayBuffer = await fileData.arrayBuffer()
          fileBase64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
        } else if (fileData instanceof ArrayBuffer) {
          fileBase64 = btoa(String.fromCharCode(...new Uint8Array(fileData)))
        } else if (typeof fileData === 'string') {
          fileBase64 = btoa(fileData)
        } else if (fileData instanceof Uint8Array) {
          fileBase64 = btoa(String.fromCharCode(...fileData))
        } else {
          // Assume it's already base64 or a string
          fileBase64 = btoa(typeof fileData === 'object' ? JSON.stringify(fileData) : String(fileData))
        }

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bucket,
            path,
            fileBase64,
            contentType: options.contentType,
            upsert: options.upsert
          })
        })
        return response.json()
      },

      async download(path) {
        const apiUrl = getApiUrl('/api/storage/download')
        if (!apiUrl) return { data: null, error: { message: 'Backend not available' } }

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bucket, path })
        })
        const result = await response.json()

        if (result.error) return { data: null, error: result.error }

        // Convert base64 back to Blob
        const binaryString = atob(result.data)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i)
        }
        const blob = new Blob([bytes])
        return { data: blob, error: null }
      },

      async list(dirPath, options = {}) {
        const apiUrl = getApiUrl('/api/storage/list')
        if (!apiUrl) return { data: null, error: { message: 'Backend not available' } }

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bucket, path: dirPath, options })
        })
        return response.json()
      }
    }
  }
}

// ==================== Auth ====================

async function authRequest(action, body = {}) {
  const apiUrl = getApiUrl(`/api/auth/${action}`)
  if (!apiUrl) return { data: null, error: { message: 'Backend not available' } }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return response.json()
}

// Session token management
function getStoredToken() {
  try {
    const stored = localStorage.getItem('api_auth_token')
    return stored ? JSON.parse(stored) : null
  } catch { return null }
}

function storeToken(session) {
  if (session) {
    localStorage.setItem('api_auth_token', JSON.stringify(session))
  } else {
    localStorage.removeItem('api_auth_token')
  }
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
    storeToken(null)
    return { error: null }
  },

  async getSession() {
    const session = getStoredToken()
    if (!session?.access_token) return { data: { session: null }, error: null }

    // Verify token is still valid
    const result = await authRequest('get-user', { access_token: session.access_token })
    if (result.error) {
      storeToken(null)
      return { data: { session: null }, error: null }
    }
    return { data: { session: { ...session, user: result.data.user } }, error: null }
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
        const newSession = e.newValue ? JSON.parse(e.newValue) : null
        callback(newSession ? 'SIGNED_IN' : 'SIGNED_OUT', newSession)
      }
    }
    window.addEventListener('storage', handler)

    return {
      data: {
        subscription: {
          unsubscribe: () => window.removeEventListener('storage', handler)
        }
      }
    }
  },

  // Profile operations (convenience wrappers)
  async getProfile(token) {
    const accessToken = token || getStoredToken()?.access_token
    return authRequest('profile', { access_token: accessToken })
  },

  async updateProfile(updates, token) {
    const accessToken = token || getStoredToken()?.access_token
    return authRequest('profile', { access_token: accessToken, updates })
  }
}
