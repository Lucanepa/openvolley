/**
 * The origin rule of an OpenVolley server: which browser origins may call it
 * (CORS answers, state-changing requests, the WebSocket upgrade).
 * Pure: node:net only, no I/O at import, safe in the LAN / SEA build.
 *
 * Trusted, and nothing else:
 * - the exact sites below and PUBLIC_ORIGINS (env, comma list: e.g. the
 *   Cloudflare Pages previews dev.openvolley-<app>.pages.dev). No wildcard: a
 *   host under openvolley.app that is not listed (the support desk, the
 *   download host, a dev build, a forgotten DNS record) is a stranger;
 * - the native shells and local development (in the list);
 * - the server's own pages: an origin whose host is the request's Host, by
 *   a name no outside party can point at this server (DNS rebinding: a page
 *   of an outside name re-pointed at a venue server's address sends that
 *   name as its Host): an address, localhost, a .local or single-label name,
 *   or one of the server's public names (backend.openvolley.app and the
 *   hosts of PUBLIC_ORIGINS). The sign page, a venue server reached by its
 *   address or its .local or bare name;
 * - on a venue server (not cloud) only: http(s) pages of this network, the
 *   host parsed as an address, never matched as a prefix: localhost,
 *   loopback (127/8, ::1), private (10/8, 172.16/12, 192.168/16, fc00::/7)
 *   and link-local (169.254/16, fe80::/10) addresses, and .local (mDNS)
 *   names. 10.example.test or 192.168.example.test are names, not addresses.
 *
 * An origin that is not trusted gets no CORS answer of its own (the header
 * names the first site, which no other page matches); the request listener
 * and the WebSocket upgrade refuse it (server.js). A request without an
 * Origin (native apps' sockets, scripts, the board bridge, curl) is no
 * browser page and is not refused for it. The LAN relays (frontend/server.js,
 * lanRelayCore, the desktop app's relay.rs) are to apply the same rule
 * (README, "Origin rule"; the LAN relay and Tauri relay work of the rollout
 * fixes).
 */
import { isIP } from 'node:net'

export const ALLOWED_ORIGINS = Object.freeze([
  'https://openvolley.app',
  // The website and its support form (/api/contact)
  'https://www.openvolley.app',
  'https://app.openvolley.app',
  'https://referee.openvolley.app',
  'https://bench.openvolley.app',
  'https://livescore.openvolley.app',
  'https://roster.openvolley.app',
  'https://scoresheet.openvolley.app',
  // The manage console as a site of its own (admins, competition managers),
  // OpenVolley's and OpenBeach's (the same console, built per brand)
  'https://manager.openvolley.app',
  'https://manager-beach.openvolley.app',
  // OpenBeach's sites (openbeach repo scripts/build-subdomains.js), under
  // their names now and the <function>-beach names of plan 2.2
  'https://beach.openvolley.app',
  'https://beach-referee.openvolley.app',
  'https://beach-livescore.openvolley.app',
  'https://beach-scoresheet.openvolley.app',
  'https://beach-roster.openvolley.app',
  'https://referee-beach.openvolley.app',
  'https://livescore-beach.openvolley.app',
  'https://scoresheet-beach.openvolley.app',
  'https://roster-beach.openvolley.app',
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

/** PUBLIC_ORIGINS: a comma list, trimmed, without trailing slashes. */
export function parsePublicOrigins(raw) {
  return String(raw || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
}

/** An http(s) origin as { hostname, host } (IPv6 without brackets), else null. */
function parseOrigin(origin) {
  if (typeof origin !== 'string' || origin.length > 300) return null
  let u
  try { u = new URL(origin) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // scheme://host[:port] and nothing else (no path, user or query)
  if (u.origin !== origin.toLowerCase()) return null
  return { hostname: u.hostname.replace(/^\[|\]$/g, ''), host: u.host }
}

/**
 * Is this host (a URL hostname; IPv6 without brackets) this machine or the
 * local network: localhost, a loopback, private or link-local address, or a
 * .local name? Parsed as an address, never matched as a prefix.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLanHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const family = isIP(h)
  if (family === 4) {
    const [a, b] = h.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  if (family === 6) {
    if (h === '::1') return true
    // IPv4-mapped, as the URL parser prints it (::ffff:c0a8:114)
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
    if (mapped) {
      const hi = parseInt(mapped[1], 16)
      const lo = parseInt(mapped[2], 16)
      return isLanHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    const first = parseInt(h.split(':')[0] || '0', 16)
    // fc00::/7 (unique local), fe80::/10 (link-local)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  }
  // A name: .local (mDNS) only; any other name can point anywhere
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(h)
}

/** The cloud server's own public names: the phone-sign page is served there. */
export const SERVER_HOSTS = Object.freeze(['backend.openvolley.app'])

/**
 * May a page whose host is the request's Host count as this server's own
 * (rule 2)? Only by a name no outside party can point at the server: an
 * address (no DNS), localhost, a .local (mDNS) or single-label (the hall's
 * own DNS) name, or one of `ownNames`. A DNS-rebinding page has an outside
 * name re-pointed at the server's address, and the browser sends that name
 * as the Host.
 * @param {string} hostname URL hostname (IPv6 without brackets)
 * @param {string[]} ownNames
 */
function isOwnPageHost(hostname, ownNames) {
  const h = String(hostname || '').toLowerCase()
  if (!h) return false
  if (isIP(h) || isLanHost(h) || !h.includes('.')) return true
  return ownNames.includes(h)
}

/**
 * @param {{ isCloud: boolean, publicOrigins?: string[] }} opts
 * @returns {{ isTrustedOrigin: (origin?: string, opts?: { host?: string }) => boolean,
 *   getCorsOrigin: (req: { headers: Record<string, string|undefined> }) => { origin: string, credentials: boolean } }}
 */
export function createOriginPolicy({ isCloud, publicOrigins = [] }) {
  const extra = [...publicOrigins]
  // The names the server's own pages may have besides addresses and LAN
  // names (rule 2, isOwnPageHost)
  const ownNames = [...SERVER_HOSTS, ...extra.map((o) => parseOrigin(o)?.hostname).filter(Boolean)]

  /**
   * @param {string} [origin] the Origin header
   * @param {{ host?: string }} [opts] host: the request's Host header, for the server's own pages
   */
  function isTrustedOrigin(origin, { host } = {}) {
    if (!origin) return false
    if (ALLOWED_ORIGINS.includes(origin)) return true
    if (extra.includes(origin)) return true
    const o = parseOrigin(origin)
    if (!o) return false
    if (typeof host === 'string' && host && o.host === host.toLowerCase() && isOwnPageHost(o.hostname, ownNames)) return true
    // Pages of the venue network (LAN / standalone server only)
    return !isCloud && isLanHost(o.hostname)
  }

  // Returns { origin, credentials }: the caller's own origin when it is
  // trusted, else the first site. An origin that is not trusted is never
  // reflected, on the cloud or on a venue server (the relay's answers need no
  // cookie, so a reflected origin alone let any page read them).
  function getCorsOrigin(req) {
    const origin = req.headers.origin
    if (isTrustedOrigin(origin, { host: req.headers.host })) return { origin, credentials: true }
    return { origin: ALLOWED_ORIGINS[0], credentials: false }
  }

  return { isTrustedOrigin, getCorsOrigin }
}
