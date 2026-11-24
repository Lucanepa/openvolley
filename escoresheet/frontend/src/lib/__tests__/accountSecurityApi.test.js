// The account's own security endpoints of lib/apiClient.js (backend
// lib/auth.js reauth, change-password, session/list, sign-out-everywhere):
// what each sends, and that a new password keeps this device signed in with
// the session the server returns.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../utils/backendConfig', () => ({
  getApiUrl: (path) => `http://relay.test${path}`,
  getCloudApiUrl: (path) => `http://backend.test${path}`
}))

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const exp = () => Math.floor(Date.now() / 1000) + 3600
const session = (token) => ({ access_token: token, token_type: 'bearer', expires_at: exp(), user: { id: 'user-A', email: 'a@example.test' } })

let api
const sent = (action) => globalThis.fetch.mock.calls
  .filter(([url]) => url === `http://backend.test/api/auth/${action}`)
  .map(([, init]) => JSON.parse(init.body))

beforeEach(async () => {
  localStorage.clear()
  vi.resetModules()
  api = (await import('../apiClient')).apiAuth
  globalThis.fetch = vi.fn(async () => jsonResponse({ data: { session: session('tok-A'), user: session('tok-A').user }, error: null }))
  await api.signInWithPassword({ email: 'a@example.test', password: 'pw' })
})
afterEach(() => { vi.restoreAllMocks() })

describe('account security requests', () => {
  it('delete-account and passkey/delete carry the confirmation', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: { code: 'reauth_required', message: 'x' } }, 403))
    await api.removePasskey('pk-1', { password: 'pw-1' })
    await api.deleteUser({ password: 'pw-1' })
    expect(sent('passkey/delete')).toEqual([{ access_token: 'tok-A', id: 'pk-1', password: 'pw-1' }])
    expect(sent('delete-account')).toEqual([{ access_token: 'tok-A', password: 'pw-1' }])
  })

  it('reauth with a passkey: the sign-in options, the device, then the answer for this session', async () => {
    globalThis.fetch = vi.fn(async (url) => url.endsWith('/passkey/login-options')
      ? jsonResponse({ data: { challengeId: 'c1', options: { challenge: 'x' } }, error: null })
      : jsonResponse({ data: { fresh_until: 1 }, error: null }))
    const ceremony = vi.fn(async () => ({ id: 'cred' }))
    const r = await api.reauth({}, ceremony)
    expect(r.error).toBeNull()
    expect(ceremony).toHaveBeenCalledWith({ challenge: 'x' })
    expect(sent('reauth')).toEqual([{ access_token: 'tok-A', passkey: { challengeId: 'c1', response: { id: 'cred' } } }])
  })

  it('change-password keeps this device signed in with the new session', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { session: session('tok-B'), user: session('tok-B').user }, error: null }))
    await api.changePassword({ password: 'old', newPassword: 'new-password-1' })
    expect(sent('change-password')).toEqual([{ access_token: 'tok-A', password: 'old', new_password: 'new-password-1' }])
    await api.listSessions()
    expect(sent('session/list')).toEqual([{ access_token: 'tok-B' }])
  })

  it('sign-out-everywhere sends the passkey choice; this device stays signed in', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { revoked_sessions: 2, removed_passkeys: 1 }, error: null }))
    await api.signOutEverywhere({ removePasskeys: true, password: 'pw-1' })
    expect(sent('sign-out-everywhere')).toEqual([{ access_token: 'tok-A', remove_passkeys: true, password: 'pw-1' }])
    await api.listSessions()
    expect(sent('session/list')).toEqual([{ access_token: 'tok-A' }])
  })
})
