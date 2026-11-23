import { createHash } from 'crypto'
import { THEME_BOOT_SCRIPT } from './theme-boot.js'
import { BROWSER_CHECK_SCRIPT } from './browser-check.js'
import { VIDEO_BASE } from './src/components/help/helpSections.js'

/**
 * Content-Security-Policy of the app's pages (fe-shell-pwa-6, android-7).
 * Shared by scripts/build-subdomains.js (a _headers rule for every web
 * build), vite.config.js (a <meta> in the Android app's build, which has
 * no server to send a header), the LAN relays that hand the build out
 * (relayPageCsp: the desktop app's relay, src-tauri relay.rs, through
 * shared/relayPageCsp.txt; frontend/server.js; SEC-47) and the backend
 * (backend/lib/pageCsp.js, a copy: its image has no frontend/).
 *
 * What the pages need, and nothing more where that is known:
 *   - scripts: the bundle ('self'), the colour theme boot script and the
 *     old-browser check (inline, by their hashes: theme-boot.js,
 *     browser-check.js) and WebAssembly ('wasm-unsafe-eval': Argon2id of the
 *     backup PINs, hash-wasm in src/utils/backupCrypto/kdf.js). No other
 *     inline script and no eval.
 *   - styles: inline style attributes (React's style props, the dev build's
 *     badge) and <style> tags of libraries: 'unsafe-inline' for styles only.
 *   - images: the app's own, data: (signatures, QR codes) and blob: (PDF
 *     capture), and the help videos' posters from the website.
 *   - media: the help videos and their subtitle tracks, on the website
 *     (openvolley.app/support/videos, helpSections.js VIDEO_BASE; the
 *     backend's own policy in server.js allows them the same way).
 *   - connections: the backend is per build and per user (?server=, the
 *     test backend, a club's own backend) and the venue relays are LAN
 *     addresses (http / ws on any private IP), so connect-src names schemes,
 *     not hosts. A page on https can only reach http / ws on the loopback
 *     address anyway (mixed content).
 *   - frames: the Android in-app view and the PDF capture frame are the
 *     app's own pages. frame-ancestors (header only, a <meta> cannot carry
 *     it): only the app's own pages may frame them, except the livescore
 *     display (no action on it; a club may show it in its own page).
 */

/** The website, where the help panel's videos, posters and subtitles are. */
export const HELP_VIDEO_ORIGIN = new URL(VIDEO_BASE).origin

/** OpenVolley's media bucket (R2, openvolley-media): the /dictate page's
 *  videos and result sheets, too big for the page host (25 MiB per file). */
export const OV_MEDIA_ORIGIN = 'https://openvolley-media.openvolley.app'

const sha256Source = (script) => `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`

export const THEME_BOOT_HASH = sha256Source(THEME_BOOT_SCRIPT)

export const BROWSER_CHECK_HASH = sha256Source(BROWSER_CHECK_SCRIPT)

const DIRECTIVES = [
  ["default-src", "'self'"],
  ["script-src", `'self' 'wasm-unsafe-eval' ${THEME_BOOT_HASH} ${BROWSER_CHECK_HASH}`],
  ["style-src", "'self' 'unsafe-inline'"],
  ["img-src", `'self' data: blob: ${HELP_VIDEO_ORIGIN} ${OV_MEDIA_ORIGIN}`],
  ["font-src", "'self' data:"],
  ["connect-src", "'self' https: wss: http: ws:"],
  ["worker-src", "'self' blob:"],
  ["frame-src", "'self' blob:"],
  ["media-src", `'self' data: blob: ${HELP_VIDEO_ORIGIN} ${OV_MEDIA_ORIGIN}`],
  ["manifest-src", "'self'"],
  ["object-src", "'none'"],
  ["base-uri", "'self'"],
  ["form-action", "'self'"],
]

/**
 * The policy as one header / meta value.
 * @param {{ frameAncestors?: string|null, connectExtra?: string[] }} [opts]
 *   frameAncestors null: no frame-ancestors (a <meta>, or a page any site may
 *   frame); connectExtra: more connect-src sources (relayPageCsp)
 */
export function contentSecurityPolicy({ frameAncestors = "'self'", connectExtra = [] } = {}) {
  const parts = DIRECTIVES.map(([name, value]) => `${name} ${name === 'connect-src' && connectExtra.length ? `${value} ${connectExtra.join(' ')}` : value}`)
  if (frameAncestors) parts.push(`frame-ancestors ${frameAncestors}`)
  return parts.join('; ')
}

/**
 * The policy of the pages the LAN relays hand out (SEC-47): the desktop app's
 * built-in server (src-tauri relay.rs, to its own scoretable window and to
 * the venue tablets) and frontend/server.js. The app's policy, plus Tauri's
 * IPC scheme (ipc:, the desktop window's native commands; http://ipc.localhost
 * on Windows is in http: already). No frame-ancestors: the relays send
 * X-Frame-Options SAMEORIGIN, as before. relay.rs reads it from
 * shared/relayPageCsp.txt (it cannot hash the scripts itself);
 * nativeShellHardening.test.js keeps the file equal to this.
 */
export function relayPageCsp() {
  return contentSecurityPolicy({ frameAncestors: null, connectExtra: ['ipc:'] })
}

/** Subdomain builds whose pages any site may frame (no frame-ancestors, no X-Frame-Options). */
export const FRAMEABLE_BUILDS = Object.freeze(['livescore'])

/**
 * The header lines of a web build's _headers rule for every path: the
 * policy (Report-Only on a dev build, so a page it would break shows up in
 * the console of the test site first; enforced in production) and frame
 * protection.
 * @param {string} name the subdomain build (scripts/build-subdomains.js)
 * @param {'dev'|'production'} channel build-channel.js buildChannel()
 * @param {{ noFrames?: boolean }} [opts] no page may frame it (the manager consoles)
 */
export function securityHeaderLines(name, channel = 'production', { noFrames = false } = {}) {
  const frameable = !noFrames && FRAMEABLE_BUILDS.includes(name)
  const policy = contentSecurityPolicy({ frameAncestors: frameable ? null : noFrames ? "'none'" : "'self'" })
  const header = channel === 'dev' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy'
  const lines = [`  ${header}: ${policy}`, '  X-Content-Type-Options: nosniff']
  if (!frameable) lines.push(`  X-Frame-Options: ${noFrames ? 'DENY' : 'SAMEORIGIN'}`)
  return lines
}

/**
 * Vite plugin: the policy as a <meta http-equiv> at the top of every page of
 * a build (the Android app: CAPACITOR=true in vite.config.js). Without
 * frame-ancestors, which a <meta> cannot set.
 * @param {{ enabled?: boolean }} [opts]
 */
export function cspMeta({ enabled = true } = {}) {
  return {
    name: 'openvolley-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      if (!enabled) return html
      return [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy({ frameAncestors: null }) },
        injectTo: 'head-prepend'
      }]
    }
  }
}
