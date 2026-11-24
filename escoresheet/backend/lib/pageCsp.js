/**
 * The Content-Security-Policy this server sends with its answers, among them
 * the frontend pages a venue server or a standalone (SEA) build hands out from
 * public/ (SEC-46).
 *
 * It is the app's own policy, frontend/csp.js, directive for directive: the
 * backend image has no frontend/ (deploy/Dockerfile.backend.dockerignore), so
 * this is a copy, and tests/cspPolicy.parity.test.js compares the two. Change
 * both together. What the pages need is explained there; in short:
 *   - 'wasm-unsafe-eval': the PIN-sealed backup files (Argon2id with
 *     hash-wasm, frontend/src/utils/backupCrypto/kdf.js). Without it a venue
 *     server's app could not write "Download game data" or the match-end ZIP;
 *   - worker-src and frame-src 'self' blob: (the PDF capture and preview);
 *   - object-src 'none', base-uri and form-action 'self'.
 *
 * Two things differ by mode, both set by server.js:
 *   - connect-src: a venue server's pages reach the LAN relays and any
 *     backend (schemes, as csp.js); the cloud names its own sites
 *     (CLOUD_CONNECT_SRC);
 *   - frame-ancestors: 'self' on a venue server (the app frames its own
 *     pages: the PDF capture), 'none' on the cloud, which serves no app page.
 */

/** frontend/theme-boot.js and frontend/browser-check.js, by their sha256 (csp.js THEME_BOOT_HASH, BROWSER_CHECK_HASH). */
export const THEME_BOOT_HASH = "'sha256-hAC66PTngtOWJY571phiLXHzeuEYS3pprPNjnV1uBik='"
export const BROWSER_CHECK_HASH = "'sha256-mEG3trr/2+bNH35eWodBg+Kvbb2CTl/9fvqyZgpWiCY='"

/** The website (help videos, posters, subtitles) and OpenVolley's media bucket (csp.js). */
export const HELP_VIDEO_ORIGIN = 'https://openvolley.app'
export const OV_MEDIA_ORIGIN = 'https://openvolley-media.openvolley.app'

/** connect-src of the pages a venue server hands out: schemes, not hosts (csp.js). */
export const LAN_CONNECT_SRC = "'self' https: wss: http: ws:"

/**
 * The directives in csp.js's order, connect-src as given.
 * @param {string} connectSrc
 * @returns {Array<[string, string]>}
 */
export function pageCspDirectives(connectSrc = LAN_CONNECT_SRC) {
  return [
    ['default-src', "'self'"],
    ['script-src', `'self' 'wasm-unsafe-eval' ${THEME_BOOT_HASH} ${BROWSER_CHECK_HASH}`],
    ['style-src', "'self' 'unsafe-inline'"],
    ['img-src', `'self' data: blob: ${HELP_VIDEO_ORIGIN} ${OV_MEDIA_ORIGIN}`],
    ['font-src', "'self' data:"],
    ['connect-src', connectSrc],
    ['worker-src', "'self' blob:"],
    ['frame-src', "'self' blob:"],
    ['media-src', `'self' data: blob: ${HELP_VIDEO_ORIGIN} ${OV_MEDIA_ORIGIN}`],
    ['manifest-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"]
  ]
}

/**
 * The policy as one header value.
 * @param {{ connectSrc?: string, frameAncestors?: string|null }} [opts]
 */
export function pageContentSecurityPolicy({ connectSrc = LAN_CONNECT_SRC, frameAncestors = "'self'" } = {}) {
  const parts = pageCspDirectives(connectSrc).map(([name, value]) => `${name} ${value}`)
  if (frameAncestors) parts.push(`frame-ancestors ${frameAncestors}`)
  return parts.join('; ')
}
