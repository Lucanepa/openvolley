import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { offlineNavigationRoute, IGNORE_URL_PARAMETERS, PRECACHE_GLOB_PATTERNS } from '../../pwa-workbox.js'

// offlineNavigationRoute is stringified into sw.js; here it runs against
// stubbed service-worker globals (self.registration, caches, fetch).
describe('pwa-workbox offlineNavigationRoute', () => {
  const origin = window.location.origin
  const originalFetch = globalThis.fetch
  let precache
  let stores

  // `otherStores`: caches of other service workers on the same origin, created
  // BEFORE this worker's precache (so they come first in caches.keys()).
  function setup(scopePath = '/', otherStores = {}) {
    precache = new Map([
      [`${scopePath}index.html`, 'main-shell'],
      ...['referee', 'bench', 'livescore', 'scoresheet', 'upload_roster']
        .map((p) => [`${scopePath}${p}/index.html`, `${p}-shell`])
    ])
    self.registration = { scope: `${origin}${scopePath}` }
    stores = { ...otherStores, [`workbox-precache-v2-${origin}${scopePath}`]: precache, 'html-cache': new Map() }
    globalThis.caches = {
      keys: vi.fn(async () => Object.keys(stores)),
      open: vi.fn(async (name) => ({
        match: vi.fn(async (u, opts) => {
          expect(opts).toEqual({ ignoreSearch: true })
          return stores[name]?.get(u)
        })
      })),
      // Like CacheStorage.match: first hit in cache creation order
      match: vi.fn(async (u) => {
        for (const m of Object.values(stores)) if (m.has(u)) return m.get(u)
        return undefined
      })
    }
    globalThis.fetch = vi.fn().mockResolvedValue('network')
  }

  beforeEach(() => setup('/'))
  afterEach(() => {
    delete self.registration
    delete globalThis.caches
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  const handle = (path) => {
    const url = new URL(path, origin)
    return offlineNavigationRoute.handler({ request: { mode: 'navigate', url: url.href }, url })
  }

  it.each([
    ['/referee', 'referee-shell'],
    ['/referee?match=1&team=home', 'referee-shell'],
    ['/referee/', 'referee-shell'],
    ['/referee.html', 'referee-shell'],
    ['/bench?match=3&team=away', 'bench-shell'],
    ['/scoresheet?matchId=42', 'scoresheet-shell'],
    ['/upload_roster', 'upload_roster-shell'],
    ['/livescore/index.html', 'livescore-shell'],
    ['/', 'main-shell'],
    ['/?cache_bust=1', 'main-shell']
  ])('serves %s from the precached page shell', async (path, shell) => {
    expect(await handle(path)).toBe(shell)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('goes to the network for unknown paths', async () => {
    expect(await handle('/referee/extra/path')).toBe('network')
    expect(await handle('/nope')).toBe('network')
  })

  it('resolves shells relative to the SW scope (sub-app built with --base /referee/)', async () => {
    setup('/referee/')
    expect(await handle('/referee/?match=1')).toBe('main-shell')
    expect(precache.get('/referee/index.html')).toBe('main-shell')
  })

  it('only matches same-origin navigations outside /api/', () => {
    const match = offlineNavigationRoute.urlPattern
    expect(match({ request: { mode: 'navigate' }, url: new URL('/referee', origin) })).toBe(true)
    expect(match({ request: { mode: 'cors' }, url: new URL('/referee', origin) })).toBe(false)
    expect(match({ request: { mode: 'navigate' }, url: new URL('/api/x', origin) })).toBe(false)
    expect(match({ request: { mode: 'navigate' }, url: new URL('https://example.com/referee') })).toBe(false)
  })

  it('uses its own precache, not another same-origin sub-app\'s (release server: /referee/, /bench/, /roster/)', async () => {
    // The bench worker's precache was created first and holds a stale copy
    // of the referee shell under the same URL; the lookup must not pick it.
    setup('/referee/', {
      [`workbox-precache-v2-${origin}/bench/`]: new Map([['/referee/index.html', 'STALE-other-app']])
    })
    expect(await handle('/referee/?match=1')).toBe('main-shell')
  })

  it('handler and matcher still work when rebuilt from their source text (workbox stringifies them into sw.js)', async () => {
    // new Function bodies only see globals: any reference to a module-level
    // binding (PAGE_ENTRIES, an import...) would throw a ReferenceError here,
    // exactly as it would inside the generated sw.js.
    const rebuild = (fn) => new Function(`return (${fn.toString()})`)()
    const handler = rebuild(offlineNavigationRoute.handler)
    const urlPattern = rebuild(offlineNavigationRoute.urlPattern)

    expect(urlPattern({ request: { mode: 'navigate' }, url: new URL('/bench?match=1', origin) })).toBe(true)
    const url = new URL('/bench?match=3&team=away', origin)
    expect(await handler({ request: { mode: 'navigate', url: url.href }, url })).toBe('bench-shell')
    const unknown = new URL('/nope', origin)
    expect(await handler({ request: { mode: 'navigate', url: unknown.href }, url: unknown })).toBe('network')
  })

  it('ignores every query param in precache lookups and precaches .mjs/.jpg', () => {
    expect(IGNORE_URL_PARAMETERS.some((re) => re.test('matchId'))).toBe(true)
    expect(PRECACHE_GLOB_PATTERNS[0]).toMatch(/mjs/)
    expect(PRECACHE_GLOB_PATTERNS[0]).toMatch(/jpg/)
  })
})

describe('pwa-workbox and the phone signing page (/sign)', () => {
  it('a navigation to /sign never gets the app shell, and the page is not precached', async () => {
    const { NAVIGATE_FALLBACK_DENYLIST, PRECACHE_GLOB_IGNORES } = await import('../../pwa-workbox.js')
    const denied = (p) => NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test(p))
    for (const p of ['/sign', '/sign/', '/sign/index.html', '/api/sign/open', '/api/db']) expect(denied(p), p).toBe(true)
    for (const p of ['/', '/signature', '/referee/', '/scoresheet/']) expect(denied(p), p).toBe(false)
    expect(PRECACHE_GLOB_IGNORES).toContain('sign/**')
    // vite-plugin-pwa's defaults stay ignored too
    expect(PRECACHE_GLOB_IGNORES).toEqual(expect.arrayContaining(['**/node_modules/**/*', 'sw.js', 'workbox-*.js']))
  })
})
