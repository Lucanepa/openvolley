import { createHash } from 'crypto'
import { THEME_BOOT_SCRIPT } from './theme-boot.js'

/**
 * Content-Security-Policy of the app's pages (fe-shell-pwa-6, android-7).
 * Shared by scripts/build-subdomains.js (a _headers rule for every web
 * build) and vite.config.js (a <meta> in the Android app's build, which has
 * no server to send a header). The desktop app serves the same build from
 * its relay without it.
 *
 * What the pages need, and nothing more where that is known:
 *   - scripts: the bundle ('self'), the colour theme boot script (inline, by
 *     its hash: theme-boot.js) and WebAssembly ('wasm-unsafe-eval': Argon2id
 *     of the backup PINs, hash-wasm in src/utils/backupCrypto/kdf.js). No
 *     other inline script and no eval.
 *   - styles: inline style attributes (React's style props, the dev build's
 *     badge) and <style> tags of libraries: 'unsafe-inline' for styles only.
 *   - images: the app's own, data: (signatures, QR codes) and blob: (PDF
 *     capture). No image from another host.
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

export const THEME_BOOT_HASH = `'sha256-${createHash('sha256').update(THEME_BOOT_SCRIPT, 'utf8').digest('base64')}'`

const DIRECTIVES = [
  ["default-src", "'self'"],
  ["script-src", `'self' 'wasm-unsafe-eval' ${THEME_BOOT_HASH}`],
  ["style-src", "'self' 'unsafe-inline'"],
  ["img-src", "'self' data: blob:"],
  ["font-src", "'self' data:"],
  ["connect-src", "'self' https: wss: http: ws:"],
  ["worker-src", "'self' blob:"],
  ["frame-src", "'self' blob:"],
  ["media-src", "'self' data: blob:"],
  ["manifest-src", "'self'"],
  ["object-src", "'none'"],
  ["base-uri", "'self'"],
  ["form-action", "'self'"],
]

/**
 * The policy as one header / meta value.
 * @param {{ frameAncestors?: string|null }} [opts] null: no frame-ancestors (a <meta>, or a page any site may frame)
 */
export function contentSecurityPolicy({ frameAncestors = "'self'" } = {}) {
  const parts = DIRECTIVES.map(([name, value]) => `${name} ${value}`)
  if (frameAncestors) parts.push(`frame-ancestors ${frameAncestors}`)
  return parts.join('; ')
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
