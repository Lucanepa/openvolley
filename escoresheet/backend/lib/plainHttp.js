/**
 * The cloud over plain http (SEC-61). Pure: no imports, no I/O.
 *
 * Cloudflare names the scheme the visitor used in cf-visitor
 * ({"scheme":"http"}); the tunnel itself always speaks http to the backend.
 * What a plain http request gets:
 *
 * - a page, a script or any other address a browser opens (the landing page,
 *   /tv, /sign, /pair, /embed/livescore.js), and an API address typed or
 *   opened as a page (Sec-Fetch-Mode: navigate): a redirect to the same
 *   address on https, 301 for GET and HEAD, else 308;
 * - an API call (/api/*) that is no page navigation, and any CORS preflight
 *   (OPTIONS): answered over http as before. Older apps (3.x before
 *   13.11.2026 turned a typed bare address into http://) still call
 *   http://backend.openvolley.app: a preflight must get a 2xx (a redirect
 *   fails it), and a call that follows a redirect to another scheme carries
 *   `Origin: null`, which the origin rule does not trust. Such calls are
 *   counted in the ops log (one line per app origin and kind, rate limited)
 *   so the lead sees who still uses http;
 * - the health checks, a request without cf-visitor (local callers, the
 *   tunnel's own checks) and a venue server: nothing changes.
 *
 * A WebSocket upgrade over ws:// is accepted as before (the same older apps
 * open their relay socket that way) and counted the same way (server.js).
 */

/** The visitor's scheme from cf-visitor ('http', 'https', 'ws', 'wss'), else null. */
export function visitorScheme(headers) {
  const visitor = headers?.['cf-visitor']
  if (typeof visitor !== 'string' || !visitor || visitor.length > 200) return null
  let scheme
  try { scheme = JSON.parse(visitor)?.scheme } catch { return null }
  return typeof scheme === 'string' ? scheme.toLowerCase() : null
}

/** Did the visitor reach Cloudflare in the clear (http:// or ws://)? */
export function isPlainVisitor(headers) {
  const scheme = visitorScheme(headers)
  return scheme === 'http' || scheme === 'ws'
}

/**
 * What a cloud request that may have come over plain http gets.
 * @param {{ method?: string, url?: string, headers: Record<string, string|string[]|undefined> }} req
 * @returns {null
 *   | { action: 'redirect', status: 301 | 308, location: string }
 *   | { action: 'serve', kind: 'preflight' | 'api' }}
 *   null: not plain http, or nothing to do (health checks, no usable Host).
 */
export function plainHttpAnswer(req) {
  if (!isPlainVisitor(req.headers)) return null
  const raw = String(req.url || '/')
  const path = raw.startsWith('/') ? raw : '/'
  const pathname = path.split('?')[0]
  if (pathname === '/health' || pathname.startsWith('/health/')) return null
  const method = String(req.method || 'GET').toUpperCase()
  // A preflight must get a 2xx: a redirect fails it, and with it the app's call
  if (method === 'OPTIONS') return { action: 'serve', kind: 'preflight' }
  const navigate = String(req.headers['sec-fetch-mode'] || '').toLowerCase() === 'navigate'
  if ((pathname === '/api' || pathname.startsWith('/api/')) && !navigate) return { action: 'serve', kind: 'api' }
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null
  // 308 keeps the method and body of a write
  return { action: 'redirect', status: method === 'GET' || method === 'HEAD' ? 301 : 308, location: `https://${host}${path}` }
}

const clean = (v, max) => String(v ?? '').replace(/[^A-Za-z0-9_:/.@ -]/g, '').slice(0, max)

/**
 * Who sent it, for the ops log: the app origin when the origin rule trusts it
 * (a site or app shell of the list, never a visitor's value), "none" without
 * an Origin (a native client, a script), else only "untrusted".
 * @param {{ origin?: string, trusted: boolean }} p
 */
export function plainHttpSource({ origin, trusted }) {
  if (origin === undefined) return 'none'
  return trusted ? (clean(origin, 80) || 'untrusted') : 'untrusted'
}

/**
 * The ops line of a plain http call that was answered (value-free: the kind,
 * the route with its ids masked, and plainHttpSource).
 * @param {{ kind: string, route: string, origin?: string, trusted: boolean }} p
 */
export function formatPlainHttpLine({ kind, route, origin, trusted }) {
  return `[HTTP] plain http answered (SEC-61) kind=${clean(kind, 16) || '-'} route=${clean(route, 120) || '-'} origin=${plainHttpSource({ origin, trusted })}`
}

/** The log limiter's key: one budget per kind and source, so each app origin shows up. */
export function plainHttpLogKey({ kind, origin, trusted }) {
  return `${clean(kind, 16)}-${plainHttpSource({ origin, trusted })}`.replace(/[^A-Za-z0-9_.-]/g, '_')
}
