/**
 * Which browser origins may call this server with credentials (CORS).
 * Pure: no I/O at import, safe in the LAN / SEA build.
 *
 * Trusted: the list below, PUBLIC_ORIGINS (env, comma list: e.g. the
 * Cloudflare Pages previews dev.openvolley-<app>.pages.dev), any
 * https://<name>.openvolley.app, and on a venue LAN server (not cloud) the
 * private-range and localhost origins.
 */

export const ALLOWED_ORIGINS = Object.freeze([
  'https://openvolley.app',
  'https://app.openvolley.app',
  'https://referee.openvolley.app',
  'https://bench.openvolley.app',
  'https://livescore.openvolley.app',
  'https://roster.openvolley.app',
  // The manage console as a site of its own (admins, competition managers)
  'https://manager.openvolley.app',
  // Native shells: Capacitor (Android androidScheme https, iOS), Tauri
  // (macOS/Linux, Windows). DATABASE_URL implies strict cloud CORS, so without
  // these the apps would lose cloud sync. Auth is a bearer token, never a
  // cookie, so trusting them grants no ambient credentials.
  'https://localhost',
  'capacitor://localhost',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  // The Tauri desktop app's window (served by its own LAN relay on :5173,
  // cloud sync comes here) and local development
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  // OpenBeach's desktop window: the same Tauri shell on its own port
  // (src-tauri/src/flavour.rs, so both apps run on one laptop)
  'http://localhost:5174',
  'http://127.0.0.1:5174'
])

const OPENVOLLEY_SUBDOMAIN = /^https:\/\/[a-z0-9-]+\.openvolley\.app$/
const LAN_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|(\d{1,3}\.){3}\d{1,3})(:\d+)?$/

/** PUBLIC_ORIGINS: a comma list, trimmed, without trailing slashes. */
export function parsePublicOrigins(raw) {
  return String(raw || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
}

/**
 * @param {{ isCloud: boolean, publicOrigins?: string[] }} opts
 * @returns {{ isTrustedOrigin: (origin?: string) => boolean,
 *   getCorsOrigin: (req: { headers: Record<string, string|undefined> }) => { origin: string, credentials: boolean } }}
 */
export function createOriginPolicy({ isCloud, publicOrigins = [] }) {
  const extra = [...publicOrigins]

  function isTrustedOrigin(origin) {
    if (!origin) return false
    if (ALLOWED_ORIGINS.includes(origin)) return true
    if (extra.includes(origin)) return true
    if (OPENVOLLEY_SUBDOMAIN.test(origin)) return true
    // LAN origins for the local/standalone server (http on private ranges + localhost)
    if (!isCloud && LAN_ORIGIN.test(origin)) return true
    return false
  }

  // Returns { origin, credentials } — credentials are only allowed when the
  // origin is explicitly trusted, never when we reflect an arbitrary/`*` origin.
  function getCorsOrigin(req) {
    const origin = req.headers.origin
    if (isTrustedOrigin(origin)) return { origin, credentials: true }
    // Non-cloud (LAN) fallback: reflect the origin for read access, but WITHOUT
    // credentials so a malicious site cannot make credentialed cross-origin calls.
    if (!isCloud) return { origin: origin || '*', credentials: false }
    return { origin: ALLOWED_ORIGINS[0], credentials: false }
  }

  return { isTrustedOrigin, getCorsOrigin }
}
