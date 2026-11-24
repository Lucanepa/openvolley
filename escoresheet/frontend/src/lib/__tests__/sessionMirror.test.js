// The signed-in session survives a crash right after signing in (against
// Dexie 4 on fake-indexeddb). Stress test 2026-10-25: Chromium writes
// localStorage to disk only about a minute after the first writes of a start;
// a crash 3, 15, 30 or 45 s after signing in signed the scorer out, and every
// rally of the official match waited in the sync queue.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../utils/backendConfig', () => ({
  getApiUrl: (path) => `http://relay.test${path}`,
  getCloudApiUrl: (path) => `http://backend.test${path}`
}))

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const session = { access_token: 'tok-1', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1' } }

// A new page load: the modules start over, IndexedDB keeps its contents
async function pageLoad() {
  vi.resetModules()
  const api = await import('../apiClient')
  const mirror = await import('../sessionMirror')
  return { ...api, ...mirror }
}

async function signIn(page) {
  globalThis.fetch = vi.fn(async () => jsonResponse({ data: { session, user: session.user }, error: null }))
  await page.apiAuth.signInWithPassword({ email: 'scorer@example.test', password: 'pw' })
  await vi.waitFor(async () => expect((await page.readSessionMirror())?.access_token).toBe('tok-1'))
}

// What the crash leaves: IndexedDB committed, localStorage not yet on disk
const crash = () => localStorage.clear()

beforeEach(async () => {
  localStorage.clear()
  const page = await pageLoad()
  await page.writeSessionMirror(null)
})

describe('session copy in IndexedDB', () => {
  it('a session signed in just before a crash is back after the restart, announced as a sign-in', async () => {
    await signIn(await pageLoad())
    crash()

    const page = await pageLoad()
    const announced = vi.fn()
    window.addEventListener(page.AUTH_TOKEN_CHANGE_EVENT, (e) => announced(e.detail?.access_token))
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { user: session.user }, error: null }))
    const { data } = await page.apiAuth.getSession()
    expect(data.session?.access_token).toBe('tok-1')
    expect(JSON.parse(localStorage.getItem('api_auth_token')).access_token).toBe('tok-1')
    // the sync queue resumes on it (useSyncQueue resumeAfterSignIn)
    expect(announced).toHaveBeenCalledWith('tok-1')
  })

  it('the first session state AuthContext gets is the restored one', async () => {
    await signIn(await pageLoad())
    crash()

    const page = await pageLoad()
    const initial = await new Promise((resolve) => {
      page.apiAuth.onAuthStateChange((event, s) => { if (event === 'INITIAL_SESSION') resolve(s) })
    })
    expect(initial?.access_token).toBe('tok-1')
  })

  it('signing out removes the copy: a restart stays signed out', async () => {
    const first = await pageLoad()
    await signIn(first)
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: null }))
    await first.apiAuth.signOut()
    await vi.waitFor(async () => expect(await first.readSessionMirror()).toBeNull())
    crash()

    const page = await pageLoad()
    globalThis.fetch = vi.fn()
    const { data } = await page.apiAuth.getSession()
    expect(data.session).toBeNull()
    expect(localStorage.getItem('api_auth_token')).toBeNull()
  })

  it('an expired copy is not restored', async () => {
    const page0 = await pageLoad()
    await page0.writeSessionMirror({ ...session, expires_at: Math.floor(Date.now() / 1000) - 10 })

    const page = await pageLoad()
    globalThis.fetch = vi.fn()
    const { data } = await page.apiAuth.getSession()
    expect(data.session).toBeNull()
    expect(await page.readSessionMirror()).toBeNull()
  })

  it('a session in localStorage is the one the app keeps (the copy never replaces it)', async () => {
    await signIn(await pageLoad())
    const other = { ...session, access_token: 'tok-2', user: { id: 'u2' } }
    localStorage.setItem('api_auth_token', JSON.stringify(other))

    const page = await pageLoad()
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { user: other.user }, error: null }))
    const { data } = await page.apiAuth.getSession()
    expect(data.session?.access_token).toBe('tok-2')
  })
})

// review of #37: Options > "Clear all (includes settings)" cleared localStorage
// only, and the reload brought the session back from its copy: on a shared club
// laptop the previous scorer stayed signed in
describe('"Clear all (includes settings)"', () => {
  it('signs out for good: the reload does not bring the session back from its copy', async () => {
    await signIn(await pageLoad())
    const { clearCachesAndReload } = await import('../../hooks/useServiceWorker')
    const originalLocation = window.location
    Object.defineProperty(window, 'location', { value: { href: 'https://host/', replace: vi.fn() }, configurable: true, writable: true })
    globalThis.caches = { keys: vi.fn().mockResolvedValue([]), delete: vi.fn() }
    globalThis.fetch = vi.fn(async () => ({ ok: true }))
    try {
      expect(await clearCachesAndReload({ includeLocalStorage: true })).toBe(true)
    } finally {
      Object.defineProperty(window, 'location', { value: originalLocation, configurable: true, writable: true })
      delete globalThis.caches
    }
    expect(localStorage.getItem('api_auth_token')).toBeNull()

    const page = await pageLoad()
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { user: session.user }, error: null }))
    const { data } = await page.apiAuth.getSession()
    expect(data.session).toBeNull()
    expect(await page.readSessionMirror()).toBeNull()
  })
})
