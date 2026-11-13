/**
 * Workbox options shared by vite.config.js (main multi-page build) and
 * scripts/build-subdomains.js (per-app builds), so the two service workers
 * cannot drift apart again.
 *
 * Offline requirement: every entry page, and every URL the app itself opens
 * (with query strings, with or without trailing slash), must load from the
 * precache with no network.
 */

// Multi-page entries of the main build (folder/index.html each)
export const PAGE_ENTRIES = ['referee', 'scoresheet', 'bench', 'livescore', 'upload_roster']

// Precache everything the pages need for a cold offline start: code (incl. .mjs
// workers), styles, fonts and images (the bundled, content-hashed ball and logo too).
export const PRECACHE_GLOB_PATTERNS = ['**/*.{js,mjs,css,html,ico,png,jpg,jpeg,svg,webp,woff,woff2}']

// The phone signing page (public/sign/, docs/qr-signing-spec.md 4.7) is opened
// by OTHER phones from a QR code, never by the app: not precached, and a
// navigation to /sign must reach the server (its own page and CSP), never the
// app shell.
// (vite-plugin-pwa's own defaults are kept: setting globIgnores replaces them)
// The largest file the service worker precaches. Workbox's default is
// 2 MiB, and a build whose entry chunk outgrows it fails ("won't be
// precached"): OpenBeach's web app stopped deploying at 2.4 MB (2.0.2), and
// this app's entry was 1.6 MB (2.4.2). The entry must be precached:
// scorers work offline.
export const PRECACHE_MAX_FILE_BYTES = 8 * 1024 * 1024

// assets/404.html: the page host's answer for a file of the build it no
// longer has (public/assets/404.html, STATIC_ASSETS_ROUTE), not an app file
export const PRECACHE_GLOB_IGNORES = ['**/node_modules/**/*', 'sw.js', 'workbox-*.js', 'sign/**', 'assets/404.html']
export const NAVIGATE_FALLBACK_DENYLIST = [/^\/api\//, /^\/sign(\/|$)/]

// Logo files the pages' heads link to (rendered from brand/ by
// scripts/make-brand-assets.py). The serve ball is not one of them: the code
// imports it (src/brand.js, a content-hashed /assets/ URL), so a new build can
// never be served the cached old /ball.png.
export const PWA_INCLUDE_ASSETS = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'fonts/*.woff2']

// Manifest icons: the white tile ('any'), and a full-bleed white square with
// the ball inside the safe zone for launchers that mask ('maskable').
export const PWA_ICONS = [
  { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: 'icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
]

// Ignore every query param when looking up the precache: /scoresheet/?matchId=X,
// /referee/?match=..&team=.. and /?cache_bust=.. must all map to the
// precached index.html (Workbox's default only ignores utm_* and fbclid).
export const IGNORE_URL_PARAMETERS = [/.*/]

/**
 * The backend's API (/api/ on any origin) goes to the network only and is
 * never kept by the service worker. Its answers belong to the account signed
 * in, and a cache keyed by URL (the token is no part of the key) handed one
 * account's answers to the next on a shared device whenever the network
 * failed or took over 10 s, as a normal 200; on referee tablets an old match
 * bundle replaced newer data. The app keeps its own offline copies, per
 * account (Dexie, localStorage), and handles a failed request itself.
 * Listed right after offlineNavigationRoute, before the asset rules: the
 * first matching route wins, so none of those can keep an /api/ answer.
 * A RegExp matching from the start of the URL, so Workbox applies it to the
 * cloud backend's own origin as well.
 */
export const API_NETWORK_ONLY_ROUTE = {
  urlPattern: /^https?:\/\/.*\/api\/.*/i,
  handler: 'NetworkOnly'
}

/**
 * The build's files (content-hashed scripts, styles, fonts, images): from the
 * cache first, kept 30 days. An answer in HTML is never one of them: a host
 * answers a file it no longer has (an older build's lazy chunk, after a newer
 * release replaced it) with its index.html as a 200, and kept under the
 * file's address it came back on every later try, for 30 days, so a tab
 * still on the older build could not load that part again even after the
 * network was back. Such an answer is passed on as a 404 and never kept:
 * the import fails at once and vite:preloadError asks for a reload
 * (useServiceWorker installPreloadErrorNotice). Cloudflare Pages answers a
 * missing /assets/ file with a 404 itself (public/assets/404.html).
 *
 * NOTE: workbox-build stringifies the plugin into sw.js: self-contained.
 */
export const STATIC_ASSETS_ROUTE = {
  urlPattern: /\.(?:js|mjs|css|png|jpg|jpeg|svg|gif|webp|woff|woff2)$/,
  handler: 'CacheFirst',
  options: {
    cacheName: 'static-assets',
    expiration: {
      maxEntries: 100,
      maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
    },
    plugins: [{
      fetchDidSucceed: async ({ response }) =>
        /^\s*text\/html/i.test(response.headers.get('content-type') || '')
          ? new Response(null, { status: 404, statusText: 'Not Found' })
          : response
    }]
  }
}

/**
 * Navigation route for page URLs the precache route cannot map by itself,
 * mainly the extension-less entries (/referee, /bench?match=..): Workbox's
 * cleanURLs would look for /referee.html, which does not exist. Serves the
 * entry's precached index.html (cache-first, like the precache route), else
 * goes to the network.
 *
 * NOTE: workbox-build stringifies urlPattern/handler into sw.js, so both must be
 * self-contained (no closure variables or imports) - the entry list is inlined.
 */
export const offlineNavigationRoute = {
  urlPattern: ({ request, url }) =>
    request.mode === 'navigate' &&
    url.origin === self.location.origin &&
    !/\/api\//.test(url.pathname),
  handler: async ({ request, url }) => {
    const scope = new URL(self.registration.scope).pathname
    const rel = url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) : null
    let shell = null
    if (rel !== null) {
      // /referee, /referee/, /referee/index.html and the legacy /referee.html
      // (server.js /api/server/status still advertises /bench.html etc.)
      const m = /^(referee|scoresheet|bench|livescore|upload_roster)(?:\.html|\/(?:index\.html)?)?$/.exec(rel)
      if (m) shell = scope + m[1] + '/index.html'
      else if (rel === '' || rel === 'index.html') shell = scope + 'index.html'
    }
    if (shell) {
      try {
        // Prefer THIS worker's precache (keys carry ?__WB_REVISION__, hence
        // ignoreSearch). Workbox names it workbox-precache-v2-<scope>; several
        // sub-apps (/referee/, /bench/, /roster/) share one origin in the
        // release server, so "the first workbox-precache*" may be another app's.
        const precacheName = 'workbox-precache-v2-' + self.registration.scope
        const names = await caches.keys()
        const cached = (names.includes(precacheName) && await (await caches.open(precacheName)).match(shell, { ignoreSearch: true })) ||
          await caches.match(shell, { ignoreSearch: true })
        if (cached) return cached
      } catch {
        // fall through to the network
      }
    }
    return fetch(request)
  }
}
