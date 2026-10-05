import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { offlineNavigationRoute, IGNORE_URL_PARAMETERS, PRECACHE_GLOB_PATTERNS } from '../../pwa-workbox.js'

// offlineNavigationRoute is stringified into sw.js; here it runs against
// stubbed service-worker globals (self.registration, caches, fetch).
describe('pwa-workbox offlineNavigationRoute', () => {
  const origin = window.location.origin
  let precache

  function setup(scopePath = '/') {
    precache = new Map([
      [`${scopePath}index.html`, 'main-shell'],
      ...['referee', 'bench', 'livescore', 'scoresheet', 'upload_roster']
        .map((p) => [`${scopePath}${p}/index.html`, `${p}-shell`])
    ])
    self.registration = { scope: `${origin}${scopePath}` }
    globalThis.caches = {
      keys: vi.fn().mockResolvedValue(['workbox-precache-v2-x', 'html-cache']),
      open: vi.fn().mockResolvedValue({
        match: vi.fn(async (u, opts) => {
          expect(opts).toEqual({ ignoreSearch: true })
          return precache.get(u) ?? undefined
        })
      }),
      match: vi.fn().mockResolvedValue(undefined)
    }
    globalThis.fetch = vi.fn().mockResolvedValue('network')
  }

  beforeEach(() => setup('/'))
  afterEach(() => {
    delete self.registration
    delete globalThis.caches
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

  it('handler and matcher are self-contained (workbox stringifies them into sw.js)', () => {
    for (const fn of [offlineNavigationRoute.handler, offlineNavigationRoute.urlPattern]) {
      // Must not reference module-level bindings that do not exist in sw.js
      expect(fn.toString()).not.toMatch(/PAGE_ENTRIES|PRECACHE_GLOB_PATTERNS|IGNORE_URL_PARAMETERS/)
    }
  })

  it('ignores every query param in precache lookups and precaches .mjs/.jpg', () => {
    expect(IGNORE_URL_PARAMETERS.some((re) => re.test('matchId'))).toBe(true)
    expect(PRECACHE_GLOB_PATTERNS[0]).toMatch(/mjs/)
    expect(PRECACHE_GLOB_PATTERNS[0]).toMatch(/jpg/)
  })
})
