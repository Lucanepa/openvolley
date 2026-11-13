import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
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

// fe-auth-client-1 / fe-shell-pwa-2: the API's answers belong to the account
// signed in. A runtime cache of the service worker kept every /api/ GET by URL
// only (the token not part of the key): after sign-out it answered the next
// account's requests on a shared device whenever the network failed or took
// over 10 s, as a normal 200, and on referee tablets an old match bundle
// replaced newer data. The app keeps its own per-account offline copies.
describe('pwa-workbox and the account API', () => {
  const frontendDir = resolve(__dirname, '../..')

  it('the /api/ route goes to the network only and keeps no cache', async () => {
    const { API_NETWORK_ONLY_ROUTE } = await import('../../pwa-workbox.js')
    expect(API_NETWORK_ONLY_ROUTE.handler).toBe('NetworkOnly')
    expect(API_NETWORK_ONLY_ROUTE.options?.cacheName).toBeUndefined()
    expect(API_NETWORK_ONLY_ROUTE.options?.expiration).toBeUndefined()
    // a RegExp matching from the start of the URL: Workbox applies it to the
    // backend on its own origin too
    const re = API_NETWORK_ONLY_ROUTE.urlPattern
    for (const u of ['https://backend.example.test/api/me', 'http://127.0.0.1:8080/api/match/list', 'https://backend.example.test/api/club-licences?club=1', 'https://backend.example.test/api/storage/download/logo.png']) {
      expect(re.exec(u)?.index, u).toBe(0)
    }
    for (const u of ['https://app.example.test/referee/', 'https://app.example.test/assets/index-abc.js']) expect(re.test(u), u).toBe(false)
  })

  it.each(['vite.config.js', 'scripts/build-subdomains.js'])('%s lists it right after the page route, before the asset rules, and caches no API answer', (file) => {
    const src = readFileSync(resolve(frontendDir, file), 'utf8')
    // first match wins: no later rule (static assets, html) can keep an /api/ answer
    expect(src).toMatch(/runtimeCaching: \[\s*(?:\/\/[^\n]*\n\s*)*offlineNavigationRoute,\s*(?:\/\/[^\n]*\n\s*)*API_NETWORK_ONLY_ROUTE,/)
    expect(src).not.toMatch(/api-cache/)
  })
})

// fe-shell-pwa-4: a tab still on an older build asked for one of its lazy
// files after a newer release replaced them. The page host answered the
// missing file with its index.html as a 200, and the cache-first rule kept
// that HTML under the script's address for 30 days: the part never loaded
// again, even with the network back.
describe('pwa-workbox static assets', () => {
  const frontendDir = resolve(__dirname, '../..')
  const html = () => new Response('<!DOCTYPE html><title>app</title>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  const js = () => new Response('export default 1', { status: 200, headers: { 'Content-Type': 'text/javascript' } })

  it('passes an HTML answer on as a 404 (never kept: CacheFirst keeps 200s only), a file as it is', async () => {
    const { STATIC_ASSETS_ROUTE } = await import('../../pwa-workbox.js')
    expect(STATIC_ASSETS_ROUTE.handler).toBe('CacheFirst')
    expect(STATIC_ASSETS_ROUTE.options.cacheName).toBe('static-assets')
    const [plugin] = STATIC_ASSETS_ROUTE.options.plugins
    const missing = await plugin.fetchDidSucceed({ request: new Request('https://app.example.test/assets/i18n-old.js'), response: html() })
    expect(missing.status).toBe(404)
    const file = js()
    expect(await plugin.fetchDidSucceed({ request: new Request('https://app.example.test/assets/i18n-new.js'), response: file })).toBe(file)
    for (const u of ['/assets/index-abc.js', '/assets/pdf.worker-1.mjs', '/assets/a.css', '/fonts/x.woff2']) expect(STATIC_ASSETS_ROUTE.urlPattern.test(u), u).toBe(true)
  })

  it('the plugin still works when rebuilt from its source text (workbox stringifies it into sw.js)', async () => {
    const { STATIC_ASSETS_ROUTE } = await import('../../pwa-workbox.js')
    const fn = new Function(`return (${STATIC_ASSETS_ROUTE.options.plugins[0].fetchDidSucceed.toString()})`)()
    expect((await fn({ response: html() })).status).toBe(404)
    expect((await fn({ response: js() })).status).toBe(200)
  })

  it.each(['vite.config.js', 'scripts/build-subdomains.js'])('%s uses the shared rule, no static-assets rule of its own', (file) => {
    const src = readFileSync(resolve(frontendDir, file), 'utf8')
    expect(src).toMatch(/API_NETWORK_ONLY_ROUTE,\s*(?:\/\/[^\n]*\n\s*)*STATIC_ASSETS_ROUTE,/)
    expect(src).not.toMatch(/cacheName: 'static-assets'/)
  })

  it('Cloudflare Pages answers a missing /assets/ file with a 404 page, which is not precached', async () => {
    const { PRECACHE_GLOB_IGNORES } = await import('../../pwa-workbox.js')
    const page = readFileSync(resolve(frontendDir, 'public/assets/404.html'), 'utf8')
    expect(page).toMatch(/<!DOCTYPE html>/i)
    expect(page).not.toMatch(/<script/i)
    expect(PRECACHE_GLOB_IGNORES).toContain('assets/404.html')
    // no rule of _redirects sends /assets/ to a page (a 200 rewrite would
    // shadow the 404); Pages skips "/x/*  /x/index.html" lines as loops
    const rules = readFileSync(resolve(frontendDir, 'public/_redirects'), 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/))
    const loop = ([from, to]) => /\/\*$/.test(from) && /\/index(\.html)?$/.test(to)
    const assetsRule = rules.filter((r) => !loop(r)).find(([from]) => from === '/*' || from.startsWith('/assets'))
    expect(assetsRule).toBeUndefined()
  })
})
