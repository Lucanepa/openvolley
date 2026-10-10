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

export const PRECACHE_GLOB_IGNORES = ['**/node_modules/**/*', 'sw.js', 'workbox-*.js', 'sign/**']
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
