import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../utils/backendConfig', () => ({
  getApiUrl: (path) => `http://backend.test${path}`
}))

import { apiFrom, apiAuth, apiStorage, apiMatchRestore, apiMatchRestoreByPin, apiMatchClaim, isSessionRejected, normalizeError, toBase64 } from '../apiClient'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }
}

// Returns the parsed JSON body of the n-th fetch call
const sentBody = (n = 0) => JSON.parse(globalThis.fetch.mock.calls[n][1].body)

describe('apiClient QueryBuilder', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: null }))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('upsert().select("id").single() keeps the upsert and asks for returning', async () => {
    await apiFrom('matches').upsert({ external_id: 'm1' }, { onConflict: 'external_id' }).select('id').single()
    const body = sentBody()
    expect(body.action).toBe('upsert')
    expect(body.params.returning).toBe('id')
    expect(body.params.single).toBe(true)
    expect(body.params.onConflict).toBe('external_id')
    expect(body.params.data).toEqual({ external_id: 'm1' })
  })

  it('delete().eq().select("*", {count, head}) stays a delete', async () => {
    await apiFrom('events').delete().eq('match_id', 'u1').select('*', { count: 'exact', head: true })
    const body = sentBody()
    expect(body.action).toBe('delete')
    expect(body.params.returning).toBe('*')
    expect(body.params.count).toBe('exact')
    expect(body.params.head).toBe(true)
    expect(body.params.filters).toEqual([{ type: 'eq', column: 'match_id', value: 'u1' }])
  })

  it('update().eq().select("a,b") keeps the update and its data', async () => {
    await apiFrom('matches').update({ manual_changes: [1] }).eq('external_id', 'm1').select('a,b')
    const body = sentBody()
    expect(body.action).toBe('update')
    expect(body.params.data).toEqual({ manual_changes: [1] })
    expect(body.params.returning).toBe('a,b')
  })

  it('select() with no column list after a write returns all columns', async () => {
    await apiFrom('profiles').update({ first_name: 'A' }).eq('user_id', 'x').select().single()
    const body = sentBody()
    expect(body.action).toBe('update')
    expect(body.params.returning).toBe('*')
  })

  it('a plain select is unchanged', async () => {
    await apiFrom('matches').select('id, status', { count: 'exact' }).eq('external_id', 'm1').limit(1)
    const body = sentBody()
    expect(body.action).toBe('select')
    expect(body.params.columns).toBe('id, status')
    expect(body.params.count).toBe('exact')
    expect(body.params.limit).toBe(1)
    expect(body.params).not.toHaveProperty('returning')
  })

  it('carries the HTTP status and normalises string errors', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'Too many requests' }, 429))
    const result = await apiFrom('matches').select('id')
    expect(result.status).toBe(429)
    expect(result.error).toEqual({ message: 'Too many requests', status: 429 })
  })

  it('keeps { message } errors and adds the status', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: { message: 'Database operation failed' } }, 400))
    const result = await apiFrom('matches').select('id')
    expect(result.error).toEqual({ message: 'Database operation failed', status: 400 })
  })
})

describe('normalizeError', () => {
  it('wraps strings, keeps objects, fills a fallback', () => {
    expect(normalizeError('Authentication required', 401)).toEqual({ message: 'Authentication required', status: 401 })
    expect(normalizeError({ message: 'x', code: 'c' }, 400)).toEqual({ message: 'x', code: 'c', status: 400 })
    expect(normalizeError(null, 503, 'Auth request failed')).toEqual({ message: 'Auth request failed (503)', status: 503 })
  })
})

describe('apiAuth.getSession session-clearing rule', () => {
  const session = { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1' } }

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('api_auth_token', JSON.stringify(session))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the session when offline (network error) and returns it unverified', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const { data } = await apiAuth.getSession()
    expect(data.session.access_token).toBe('tok')
    expect(data.session.unverified).toBe(true)
    expect(localStorage.getItem('api_auth_token')).not.toBeNull()
  })

  it('keeps the session on 429', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'Too many requests' }, 429))
    const { data } = await apiAuth.getSession()
    expect(data.session).not.toBeNull()
    expect(localStorage.getItem('api_auth_token')).not.toBeNull()
  })

  it('keeps the session on 503', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'Supabase not configured on server' }, 503))
    const { data } = await apiAuth.getSession()
    expect(data.session).not.toBeNull()
    expect(localStorage.getItem('api_auth_token')).not.toBeNull()
  })

  it('clears the session on 401', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'Invalid or expired token' }, 401))
    const { data } = await apiAuth.getSession()
    expect(data.session).toBeNull()
    expect(localStorage.getItem('api_auth_token')).toBeNull()
  })

  it('clears the session when the auth server rejects the JWT (200 + error)', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: { message: 'invalid JWT: token is expired' } }, 200))
    const { data } = await apiAuth.getSession()
    expect(data.session).toBeNull()
    expect(localStorage.getItem('api_auth_token')).toBeNull()
  })

  it('returns the verified user on success', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { user: { id: 'u1', email: 'a@b.c' } }, error: null }))
    const { data } = await apiAuth.getSession()
    expect(data.session.user).toEqual({ id: 'u1', email: 'a@b.c' })
    expect(data.session.unverified).toBeUndefined()
  })

  it('signals SIGNED_OUT in the same tab when the token is cleared', async () => {
    const cb = vi.fn()
    const { data: { subscription } } = apiAuth.onAuthStateChange(cb)
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'Invalid or expired token' }, 401))
    await apiAuth.getSession()
    expect(cb).toHaveBeenCalledWith('SIGNED_OUT', null)
    subscription.unsubscribe()
  })
})

describe('isSessionRejected', () => {
  it('only treats an explicit rejection as fatal', () => {
    expect(isSessionRejected({ error: { message: 'x', status: 401 } })).toBe(true)
    expect(isSessionRejected({ error: { message: 'x', code: 'invalid_token', status: 400 } })).toBe(true)
    expect(isSessionRejected({ error: { message: 'Failed to fetch', status: 0, network: true } })).toBe(false)
    expect(isSessionRejected({ error: { message: 'Too many requests', status: 429 } })).toBe(false)
    expect(isSessionRejected({ error: { message: 'Authentication error', status: 500 } })).toBe(false)
    expect(isSessionRejected({ error: { message: 'fetch failed', status: 200 } })).toBe(false)
    expect(isSessionRejected({ error: null })).toBe(false)
  })

  it('HTTP 200 + error: only GoTrue token errors sign out, never gateway text', () => {
    const at200 = (message) => isSessionRejected({ error: { message, status: 200 } })
    expect(at200('invalid JWT: unable to parse or verify signature, token has invalid claims: token is expired')).toBe(true)
    expect(at200('JWT expired')).toBe(true)
    expect(at200('User from sub claim in JWT does not exist')).toBe(true)
    expect(at200('Session from session_id claim in JWT does not exist')).toBe(true)
    expect(at200('An invalid response was received from the upstream server')).toBe(false)
    expect(at200('Not Found')).toBe(false)
    expect(at200('Bad Gateway: upstream connect error or disconnect/reset before headers')).toBe(false)
    expect(at200('Internal server error')).toBe(false)
  })
})

describe('QueryBuilder transport failures', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes an abort signal so a stalled request cannot hang forever', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [], error: null }))
    await apiFrom('matches').select('id')
    const opts = globalThis.fetch.mock.calls[0][1]
    expect(opts.signal).toBeDefined()
  })

  it('a timeout or network failure resolves as a network error, never throws', async () => {
    globalThis.fetch = vi.fn(async () => { throw new DOMException('The operation timed out.', 'TimeoutError') })
    const result = await apiFrom('sets').update({ home_points: 3 }).eq('external_id', 'm:s:1')
    expect(result.data).toBeNull()
    expect(result.error.network).toBe(true)
    expect(result.error.status).toBe(0)
  })
})

describe('storage upload encoding', () => {
  const decode = (b64) => Buffer.from(b64, 'base64').toString('utf8')

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('encodes non-Latin-1 text as UTF-8', async () => {
    const text = 'Čech Müller 🏐 — “quoted”'
    expect(decode(await toBase64(text))).toBe(text)
  })

  it('encodes large binary payloads without overflowing the stack', async () => {
    const bytes = new Uint8Array(600000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    const b64 = await toBase64(bytes)
    const back = Buffer.from(b64, 'base64')
    expect(back.length).toBe(bytes.length)
    expect(back[12345]).toBe(12345 % 251)
  })

  it('encodes Blobs and objects', async () => {
    expect(decode(await toBase64(new Blob(['Zürich'])))).toBe('Zürich')
    expect(JSON.parse(decode(await toBase64({ a: 'é' })))).toEqual({ a: 'é' })
  })

  it('upload sends the UTF-8 base64 body', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { path: 'p' }, error: null }))
    const result = await apiStorage.from('backup').upload('logs/x.txt', 'ü 🏐', { contentType: 'text/plain' })
    expect(result.error).toBeNull()
    expect(decode(sentBody().fileBase64)).toBe('ü 🏐')
  })
})

describe('self-hosted backend contract', () => {
  const session = { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1' } }
  const sentHeaders = (n = 0) => globalThis.fetch.mock.calls[n][1].headers

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('api_auth_token', JSON.stringify(session))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends X-OV-Proto: 2 on /api/db and /api/storage requests', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [], error: null }))
    await apiFrom('matches').select('id')
    await apiStorage.from('backup').list('x')
    expect(sentHeaders(0)['X-OV-Proto']).toBe('2')
    expect(sentHeaders(0).Authorization).toBe('Bearer tok')
    expect(sentHeaders(1)['X-OV-Proto']).toBe('2')
  })

  it('has no apiAuth.updateProfile (the auth profile route is read-only; AuthContext writes via /api/db)', () => {
    expect(apiAuth.updateProfile).toBeUndefined()
  })

  it('exports the token event names the sync queue listens to', async () => {
    const mod = await import('../apiClient')
    expect(mod.AUTH_TOKEN_STORAGE_KEY).toBe('api_auth_token')
    const seen = []
    const h = (e) => seen.push(e.detail)
    window.addEventListener(mod.AUTH_TOKEN_CHANGE_EVENT, h)
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { session: { access_token: 'n', user: { id: 'u2' } }, user: { id: 'u2' } }, error: null }))
    await apiAuth.signInWithPassword({ email: 'a@b.ch', password: 'x' })
    window.removeEventListener(mod.AUTH_TOKEN_CHANGE_EVENT, h)
    expect(seen).toEqual([{ access_token: 'n', user: { id: 'u2' } }])
  })

  it('apiMatchRestore posts the whole match to /api/match/restore with the session', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { id: 'uuid', counts: { sets: 1, events: 2, liveState: 0 } }, error: null }))
    const r = await apiMatchRestore({ match: { external_id: 'm1' }, sets: [{}], events: [{}, {}] })
    expect(globalThis.fetch.mock.calls[0][0]).toBe('http://backend.test/api/match/restore')
    expect(sentHeaders()['X-OV-Proto']).toBe('2')
    expect(sentHeaders().Authorization).toBe('Bearer tok')
    expect(sentBody()).toEqual({ match: { external_id: 'm1' }, sets: [{}], events: [{}, {}], liveState: null })
    expect(r.error).toBeNull()
    expect(r.data.counts.events).toBe(2)
  })

  it('apiMatchRestore reports 426 with its status (retry later, not fatal)', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: { message: 'too old', code: 'OV_CLIENT_TOO_OLD' } }, 426))
    const r = await apiMatchRestore({ match: { external_id: 'm1' } })
    expect(r.error.status).toBe(426)
    expect(r.error.code).toBe('OV_CLIENT_TOO_OLD')
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const offline = await apiMatchRestore({ match: { external_id: 'm1' } })
    expect(offline.error.network).toBe(true)
  })

  it('apiMatchRestoreByPin carries the session when there is one (take-over) and maps 404 to an error object', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: { message: 'Match not found with this ID and PIN', code: 'OV_NOT_FOUND' } }, 404))
    const r = await apiMatchRestoreByPin(12, '123456')
    expect(globalThis.fetch.mock.calls[0][0]).toBe('http://backend.test/api/match/restore-by-pin')
    expect(sentHeaders().Authorization).toBe('Bearer tok')
    expect(sentBody()).toEqual({ gameN: 12, pin: '123456' })
    expect(r.error.code).toBe('OV_NOT_FOUND')
    expect(r.status).toBe(404)
    // Signed out: anonymous lookup
    localStorage.removeItem('api_auth_token')
    await apiMatchRestoreByPin(12, '123456')
    expect(globalThis.fetch.mock.calls[1][1].headers.Authorization).toBeUndefined()
  })

  it('apiMatchClaim proves the game PIN with the session', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { id: 'u', external_id: 'match_1', role: 'editor' }, error: null }))
    const r = await apiMatchClaim('match_1', '864201')
    expect(globalThis.fetch.mock.calls[0][0]).toBe('http://backend.test/api/match/claim')
    expect(sentHeaders().Authorization).toBe('Bearer tok')
    expect(sentBody()).toEqual({ externalId: 'match_1', pin: '864201' })
    expect(r.data.role).toBe('editor')
  })

  it('a query can carry extra headers (match token) without replacing the session', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [], error: null }))
    await apiFrom('matches').headers({ 'X-OV-Match-Token': 'v1.a.b', Authorization: 'Bearer forged' }).select('*').eq('external_id', 'm')
    expect(sentHeaders()['X-OV-Match-Token']).toBe('v1.a.b')
    expect(sentHeaders().Authorization).toBe('Bearer tok')
  })

  it('signOut revokes the session on the server, then clears it locally (even offline)', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: null }))
    await apiAuth.signOut()
    expect(globalThis.fetch.mock.calls[0][0]).toBe('http://backend.test/api/auth/sign-out')
    expect(sentBody()).toEqual({ access_token: 'tok' })
    expect(localStorage.getItem('api_auth_token')).toBeNull()

    localStorage.setItem('api_auth_token', JSON.stringify(session))
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await apiAuth.signOut()
    expect(localStorage.getItem('api_auth_token')).toBeNull()
  })

  it('getSession keeps the server-slid expires_at', async () => {
    const later = session.expires_at + 30 * 24 * 3600
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { user: { id: 'u1' }, session: { expires_at: later, expires_in: 99 } }, error: null }))
    const { data } = await apiAuth.getSession()
    expect(data.session.expires_at).toBe(later)
    expect(JSON.parse(localStorage.getItem('api_auth_token')).expires_at).toBe(later)
  })
})
