// "Sign out" on a shared scoring device (club laptop, hall tablet), against
// the real lib/apiClient.js on fake-indexeddb, as sessionMirror.test.js does.
// A hall network that stalls instead of failing kept the device signed in:
// sign-out waited for the server without a time limit and removed the session
// only afterwards, so a tab closed meanwhile left the scorer signed in for the
// next person. And a sign-out that never reached the server (offline) left
// the server session valid for up to 30 days.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../utils/backendConfig', () => ({
  getApiUrl: (path) => `http://relay.test${path}`,
  getCloudApiUrl: (path) => `http://backend.test${path}`
}))

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const session = { access_token: 'tok-A', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-A', email: 'a@example.test' } }

// A new page load: the modules start over, IndexedDB and localStorage stay
async function pageLoad() {
  vi.resetModules()
  const api = await import('../apiClient')
  const mirror = await import('../sessionMirror')
  return { ...api, ...mirror }
}

async function signIn(page) {
  globalThis.fetch = vi.fn(async () => jsonResponse({ data: { session, user: session.user }, error: null }))
  await page.apiAuth.signInWithPassword({ email: 'a@example.test', password: 'pw' })
  await vi.waitFor(async () => expect((await page.readSessionMirror())?.access_token).toBe('tok-A'))
}

// The hall network: the request leaves, no answer comes; only its abort
// signal (the time limit) ends it
const stalled = () => vi.fn((url, init) => new Promise((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })))
}))
const offline = () => vi.fn(async () => { throw new TypeError('Failed to fetch') })
const signOutCalls = () => globalThis.fetch.mock.calls.filter(([url]) => url === 'http://backend.test/api/auth/sign-out')
// the answer handled (the waiting entry dropped or kept)
const settle = () => new Promise((r) => setTimeout(r, 30))
const revoked = () => signOutCalls().map(([, init]) => JSON.parse(init.body).access_token)

// A page that follows the session (AuthProvider); unsubscribed after each test
let subscriptions = []
function follow(page) {
  const { data: { subscription } } = page.apiAuth.onAuthStateChange(() => {})
  subscriptions.push(subscription)
}

// The time limit of the sign-out request, under the test's control
let limits
beforeEach(async () => {
  localStorage.clear()
  const page = await pageLoad()
  await page.writeSessionMirror(null)
  limits = []
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const ctrl = new AbortController()
    limits.push({ ms, ctrl })
    return ctrl.signal
  })
})
afterEach(() => {
  for (const s of subscriptions) s.unsubscribe()
  subscriptions = []
  vi.restoreAllMocks()
})

describe('sign-out on a network that does not answer', () => {
  it('signs the device out at once, and stops waiting for the server after a few seconds', async () => {
    const page = await pageLoad()
    await signIn(page)
    globalThis.fetch = stalled()

    let finished = false
    const done = page.apiAuth.signOut().then((r) => { finished = true; return r })
    // before any answer: no session on the device
    expect(localStorage.getItem('api_auth_token')).toBeNull()
    await vi.waitFor(async () => expect(await page.readSessionMirror()).toBeNull())

    // the revocation went out with a time limit of a few seconds, and survives a closed tab
    await vi.waitFor(() => expect(signOutCalls()).toHaveLength(1))
    const [, init] = signOutCalls()[0]
    expect(init.keepalive).toBe(true)
    expect(init.signal).toBeDefined()
    expect(limits[0].ms).toBeGreaterThan(0)
    expect(limits[0].ms).toBeLessThanOrEqual(10000)
    expect(finished).toBe(false)

    limits[0].ctrl.abort()
    expect(await done).toEqual({ error: null })
  })

  it('the next person who opens the app on that device is signed out, and the server is told then', async () => {
    const page = await pageLoad()
    await signIn(page)
    globalThis.fetch = stalled()
    page.apiAuth.signOut() // tapped; the tab is closed before any answer
    await vi.waitFor(() => expect(signOutCalls()).toHaveLength(1))

    // A new page load; the network works again
    const next = await pageLoad()
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: null }))
    const { data } = await next.apiAuth.getSession()
    expect(data.session).toBeNull()

    // the page that follows the session sends the revocation that never got through
    follow(next)
    await vi.waitFor(() => expect(revoked()).toEqual(['tok-A']))
    await settle()

    // ...once: the next start has nothing left to send
    const third = await pageLoad()
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: null }))
    follow(third)
    await settle()
    expect(signOutCalls()).toHaveLength(0)
  })
})

describe('sign-out while offline', () => {
  it('the revocation is sent again when the backend can be reached, and only until the server answered', async () => {
    const page = await pageLoad()
    await signIn(page)
    globalThis.fetch = offline()
    await page.apiAuth.signOut()
    expect(localStorage.getItem('api_auth_token')).toBeNull()
    // tried at once, as a keepalive request and once more as a plain one
    expect(signOutCalls().map(([, init]) => !!init.keepalive)).toEqual([true, false])

    // AuthProvider subscribing (a start) tries again: still offline, kept
    follow(page)
    await vi.waitFor(() => expect(signOutCalls()).toHaveLength(3))

    // a server error keeps it too
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'Service unavailable' }, 503))
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(revoked()).toEqual(['tok-A']))
    await settle()

    // the backend answers: revoked, and not sent again
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: null }))
    window.dispatchEvent(new Event(page.BACKEND_REACHED_EVENT))
    await vi.waitFor(() => expect(revoked()).toEqual(['tok-A']))
    await settle()
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: null }))
    window.dispatchEvent(new Event('online'))
    await settle()
    expect(signOutCalls()).toHaveLength(0)
  })

  it('a session signed out here never comes back from its IndexedDB copy while its revocation waits', async () => {
    const page = await pageLoad()
    await signIn(page)
    globalThis.fetch = offline()
    await page.apiAuth.signOut()
    // the copy's delete did not reach the disk (a crash, a full or broken IndexedDB)
    await page.writeSessionMirror(session)

    const next = await pageLoad()
    globalThis.fetch = offline()
    const { data } = await next.apiAuth.getSession()
    expect(data.session).toBeNull()
    expect(localStorage.getItem('api_auth_token')).toBeNull()
    expect(await next.readSessionMirror()).toBeNull()
  })

  it('a new sign-in on the device is not touched by an older account\'s revocation', async () => {
    const page = await pageLoad()
    await signIn(page)
    globalThis.fetch = offline()
    await page.apiAuth.signOut()

    const sessionB = { ...session, access_token: 'tok-B', user: { id: 'user-B', email: 'b@example.test' } }
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: { session: sessionB, user: sessionB.user }, error: null }))
    await page.apiAuth.signInWithPassword({ email: 'b@example.test', password: 'pw' })
    await vi.waitFor(async () => expect((await page.readSessionMirror())?.access_token).toBe('tok-B'))

    globalThis.fetch = vi.fn(async () => jsonResponse({ data: null, error: null }))
    follow(page)
    await vi.waitFor(() => expect(revoked()).toEqual(['tok-A']))
    expect(JSON.parse(localStorage.getItem('api_auth_token')).access_token).toBe('tok-B')
    expect((await page.readSessionMirror())?.access_token).toBe('tok-B')
  })
})
