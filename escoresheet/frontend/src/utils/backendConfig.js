/**
 * Backend Configuration
 * Detects if backend server is available and provides URLs
 * Supports runtime override via localStorage for local server connections
 */

import { getAppEntry } from './appEntry'

// Cloud relay URL for tablets/mobile (non-Electron/non-desktop): the
// production backend. A dev build never falls back to it (isDevBuild).
const CLOUD_RELAY_URL = 'https://backend.openvolley.app'
const PRODUCTION_BACKEND_HOST = new URL(CLOUD_RELAY_URL).hostname

// localStorage key for runtime backend URL override
const OVERRIDE_KEY = 'openvolley_backend_override'

// sessionStorage: { "<role page>": "<url>" }, the server a role link's
// ?server= named, once confirmed (applyServerParam / confirmLinkServer). Kept
// per role page and per tab, never for later visits, and never read by the
// scoretable (see linkServerOverride).
const LINK_SERVER_KEY = 'openvolley_link_server'
const LINK_SERVER_PAGES = ['referee', 'bench', 'livescore']

/**
 * A build of a dev branch: a Cloudflare Pages preview, the dev-* sites
 * (build-channel.js sets VITE_OV_DEV_BUILD). Owner decision 5: such a build
 * never talks to the production backend. Its backend is the test backend the
 * build named (VITE_DEV_BACKEND_URL, put in VITE_BACKEND_URL); without one it
 * has none and says "No test backend configured".
 */
export function isDevBuild() {
  return import.meta.env.VITE_OV_DEV_BUILD === 'true'
}

/** A dev build whose build named no test backend. */
export function isDevBuildWithoutBackend() {
  return isDevBuild() && !import.meta.env.VITE_BACKEND_URL
}

// The backend of a build that names none: the production backend, except in
// a dev build (none there)
function cloudFallbackUrl() {
  return isDevBuild() ? null : CLOUD_RELAY_URL
}

/**
 * A host on this machine or the local network: loopback, RFC 1918, *.local.
 * Such a host is a venue relay (desktop app, Pi, standalone server), never
 * the cloud backend.
 * @param {string} hostname
 */
function isLanHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true
  if (/^127\.(\d{1,3}\.){2}\d{1,3}$/.test(host)) return true
  if (/^10\.(\d{1,3}\.){2}\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

/**
 * SECURITY: the backend override decides where the app sends requests carrying
 * the user's auth token. It can be set from the ?server= query param, so it must
 * be restricted to trusted targets: a venue relay on this machine or the hall
 * network (loopback, RFC 1918, *.local) over http or https, or an
 * openvolley.app host over https only (plain http to the cloud would carry the
 * password and the session token in clear) — otherwise a crafted link could
 * exfiltrate the session token to any origin. A dev build never takes the
 * production backend.
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowedBackendUrl(url) {
  if (!url || typeof url !== 'string') return false
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (isLanHost(u.hostname)) return true
  if (u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  if (host !== 'openvolley.app' && !host.endsWith('.openvolley.app')) return false
  return !(isDevBuild() && host === PRODUCTION_BACKEND_HOST)
}

/**
 * An address typed on the connection screen or named by a link, as a URL:
 * trimmed, no trailing slash. A bare one gets http:// on the hall network (an
 * IP address, *.local, localhost: venue relays speak plain http) and https://
 * anywhere else.
 * @param {string} address
 * @returns {string}
 */
export function normalizeServerAddress(address) {
  const raw = String(address ?? '').trim().replace(/\/+$/, '')
  if (!raw || /^https?:\/\//i.test(raw)) return raw
  return `${isLanBackendUrl(`http://${raw}`) ? 'http' : 'https'}://${raw}`
}

// The role page this is, when it may follow a link's ?server= (not the
// scoretable, not an unmarked page)
function linkServerPage() {
  const entry = getAppEntry()
  return LINK_SERVER_PAGES.includes(entry) ? entry : null
}

function readLinkServers() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(LINK_SERVER_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeLinkServer(url) {
  const page = linkServerPage()
  if (!page) return
  try {
    const servers = readLinkServers()
    if (url) servers[page] = url
    else delete servers[page]
    sessionStorage.setItem(LINK_SERVER_KEY, JSON.stringify(servers))
  } catch { /* sessionStorage unavailable */ }
}

// A link that named this page's own server on an address isAllowedBackendUrl
// does not cover (a venue relay on a plain host name, ...): this tab uses the
// page's default, with no override (linkServerOverride)
const OWN_SERVER = Symbol('own server')

// This role page's confirmed link server in this tab, if any
function linkServerOverride() {
  const page = linkServerPage()
  if (!page) return null
  const url = readLinkServers()[page]
  if (typeof url !== 'string') return null
  if (isAllowedBackendUrl(url)) return url
  return isDefaultBackendUrl(url) ? OWN_SERVER : null
}

/**
 * Set a runtime backend URL override (persists in localStorage)
 * Used when connecting to a local server at a custom IP:port. A server chosen
 * here (connection screen, Android "Change server") also replaces the one a
 * link gave this role page.
 * @param {string|null} url - Backend URL to override with, or null to clear
 */
export function setBackendOverride(url) {
  try {
    if (url) {
      if (!isAllowedBackendUrl(url)) {
        console.warn('[backendConfig] Rejected untrusted backend override:', url)
        return
      }
      localStorage.setItem(OVERRIDE_KEY, url)
    } else {
      localStorage.removeItem(OVERRIDE_KEY)
    }
  } catch { /* localStorage unavailable */ }
  writeLinkServer(null)
}

/**
 * Get the current backend URL override, if set (and still trusted): on a role
 * page the server its link named (confirmed in this tab; none when that was
 * the page's own server on an address the allow-list does not cover), else
 * the stored one
 * @returns {string|null}
 */
export function getBackendOverride() {
  const link = linkServerOverride()
  if (link === OWN_SERVER) return null
  if (link) return link
  try {
    const v = localStorage.getItem(OVERRIDE_KEY) || null
    if (v && !isAllowedBackendUrl(v)) {
      localStorage.removeItem(OVERRIDE_KEY)
      return null
    }
    return v
  } catch { return null }
}

/**
 * Clear the backend URL override (and the server a link gave this role page)
 */
export function clearBackendOverride() {
  try { localStorage.removeItem(OVERRIDE_KEY) } catch {}
  writeLinkServer(null)
}

/**
 * Detect if running on a desktop platform (Mac/PC/Linux) vs tablet/mobile
 * Returns true if running in Electron or on a desktop browser
 */
export function isDesktopPlatform() {
  // Check if running in Electron
  if (typeof window !== 'undefined' && window.electronAPI) {
    return true
  }

  // Check user agent for desktop OS (without mobile indicators)
  const ua = navigator.userAgent.toLowerCase()
  const isDesktopOS = /windows|macintosh|mac os x|linux/i.test(ua) &&
                      !/android|iphone|ipad|ipod|mobile|tablet/i.test(ua)

  return isDesktopOS
}

/**
 * Detect if running on tablet/mobile
 */
export function isTabletOrMobile() {
  return !isDesktopPlatform()
}

/**
 * A host that serves the apps as static files, with no backend behind it:
 * *.openvolley.app, the Cloudflare Pages previews (*.pages.dev, e.g.
 * dev.openvolley-app.pages.dev) and GitHub Pages. Its /api/* paths answer
 * with the SPA's index.html.
 * @param {string} hostname
 */
export function isStaticHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === 'openvolley.app' || host.endsWith('.openvolley.app') ||
    host.endsWith('.pages.dev') || host.endsWith('.github.io')
}

/**
 * Running inside the native Android/iOS app (Capacitor). Its WebView serves the
 * bundled web app from https://localhost (androidScheme https) — a host that
 * has no backend behind it, exactly like a static deployment: the cloud
 * backend (VITE_BACKEND_URL / backend.openvolley.app) unless the user points
 * the app at a venue LAN relay (the override).
 */
export function isNativeApp() {
  if (typeof window === 'undefined') return false
  try {
    return !!window.Capacitor?.isNativePlatform?.()
  } catch {
    return false
  }
}

/**
 * Detect if running on a static deployment (see isStaticHost) or in the
 * native app. Neither has a backend server of its own, so they use the cloud
 * relay.
 */
export function isStaticDeployment() {
  if (typeof window === 'undefined') return false
  return isNativeApp() || isStaticHost(window.location.hostname)
}

/**
 * Detect if being served from a standalone local server (not cloud, not dev)
 * Any non-cloud production host = standalone server (LAN IP, localhost, etc.)
 */
export function isServedFromLocalServer() {
  if (typeof window === 'undefined') return false
  if (import.meta.env.DEV) return false
  if (isNativeApp()) return false
  if (isStaticHost(window.location.hostname)) return false
  return true
}

/**
 * Where this page asks its own server for /api/server/status (relay WS port,
 * LAN address): the dev server or a local server (Pi, desktop app). Null on a
 * static deployment, which has no such endpoint (it answered every 10 s poll
 * with its index.html), and for a page opened from disk.
 * @returns {string|null}
 */
export function getLocalServerStatusUrl() {
  if (typeof window === 'undefined' || !window.location) return null
  const { protocol, hostname, origin } = window.location
  if (protocol !== 'http:' && protocol !== 'https:') return null
  if (isNativeApp()) return null
  if (!import.meta.env.DEV && isStaticHost(hostname)) return null
  return `${origin}/api/server/status`
}

// Get backend URL from environment or use current host
export function getBackendUrl() {
  // Check runtime override first (set by local server connection UI)
  return getBackendOverride() || defaultBackendUrl()
}

/**
 * The backend this page uses when nothing was chosen on it (no override): the
 * build's VITE_BACKEND_URL, the cloud on a static deployment, the page's own
 * server when a local server serves it, the dev server.
 * @returns {string|null}
 */
export function defaultBackendUrl() {
  // If VITE_BACKEND_URL is set, use it (production with separate backend)
  if (import.meta.env.VITE_BACKEND_URL) {
    return import.meta.env.VITE_BACKEND_URL
  }

  // No page (a test's teardown: a late live-state push after the window
  // went away): no backend, not a ReferenceError
  if (typeof window === 'undefined' || !window.location) return null

  // On static deployments (*.openvolley.app), always use cloud relay
  // These deployments have no backend server (a dev build: none at all)
  if (isStaticDeployment()) {
    return cloudFallbackUrl()
  }

  // If served from a local server (non-openvolley.app, not localhost dev),
  // the app is running on the standalone server — use same origin as backend
  if (isServedFromLocalServer()) {
    return window.location.origin
  }

  // On tablets/mobile in production, use cloud relay automatically
  if (!import.meta.env.DEV && isTabletOrMobile()) {
    return cloudFallbackUrl()
  }

  // In development, use local server
  if (import.meta.env.DEV) {
    const protocol = window.location.protocol === 'https:' ? 'https' : 'http'
    const hostname = window.location.hostname
    const port = window.location.port || (protocol === 'https' ? '443' : '5173')
    return `${protocol}://${hostname}:${port}`
  }

  // In production without VITE_BACKEND_URL on desktop, assume standalone mode
  return null
}

export function getWebSocketUrl() {
  const backendUrl = getBackendUrl()

  if (!backendUrl) {
    return null // No backend available
  }

  // If runtime override is set, derive WebSocket URL from it
  const override = getBackendOverride()
  if (override) {
    return httpToWsUrl(override)
  }

  // If backend URL is set, use it for WebSocket
  if (import.meta.env.VITE_BACKEND_URL) {
    return httpToWsUrl(import.meta.env.VITE_BACKEND_URL)
  }

  // On static deployments, use cloud relay WebSocket
  if (isStaticDeployment()) {
    const cloud = cloudFallbackUrl()
    return cloud ? httpToWsUrl(cloud) : null
  }

  // If served from local server, use same origin for WebSocket
  if (isServedFromLocalServer()) {
    return httpToWsUrl(window.location.origin)
  }

  // In development, use separate WebSocket port
  if (import.meta.env.DEV) {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const hostname = window.location.hostname
    const wsPort = import.meta.env.VITE_WS_PORT || 8080
    return `${protocol}://${hostname}:${wsPort}`
  }

  return null
}

// The desktop relays (Tauri, Electron, frontend/server.js) serve the pages and
// /api/* on 5173 and take the WebSocket on 8080 only; the venue server
// (backend/server.js) and the cloud take both on one port.
const DESKTOP_RELAY_HTTP_PORT = '5173'
const DESKTOP_RELAY_WS_PORT = '8080'
// localStorage: { "<relay origin>": <its WS port> }, from its /api/server/status
const RELAY_WS_PORTS_KEY = 'openvolley_relay_ws_ports'
const MAX_REMEMBERED_RELAYS = 8

const originOf = (url) => {
  try { return new URL(url).origin } catch { return null }
}

const validPort = (value) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n < 65536 ? String(n) : null
}

function readRelayWsPorts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RELAY_WS_PORTS_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * The WebSocket port a relay told us it uses (rememberRelayWsPort), or null.
 * @param {string} baseUrl  the relay's http(s) URL
 */
export function relayWsPortFor(baseUrl) {
  const origin = originOf(baseUrl)
  return origin ? validPort(readRelayWsPorts()[origin]) : null
}

/**
 * Remember the WebSocket port of the relay at `baseUrl` (its
 * /api/server/status `wsPort`). Null forgets it.
 * @param {string} baseUrl
 * @param {number|string|null} wsPort
 */
export function rememberRelayWsPort(baseUrl, wsPort) {
  const origin = originOf(baseUrl)
  if (!origin) return
  try {
    const ports = readRelayWsPorts()
    delete ports[origin]
    const port = validPort(wsPort)
    if (port) ports[origin] = Number(port)
    // Newest last; only a few relays are worth remembering
    const keys = Object.keys(ports)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_RELAYS))) delete ports[k]
    localStorage.setItem(RELAY_WS_PORTS_KEY, JSON.stringify(ports))
  } catch { /* localStorage unavailable */ }
}

/**
 * Ask the relay at `baseUrl` (a server chosen on the connection screen or by
 * ?server=) which port its WebSocket is on, and remember it for
 * getRelayWebSocketUrl. Every relay answers /api/server/status with `wsPort`.
 * Never throws; null when the relay did not say.
 * @param {string} baseUrl
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<string|null>}
 */
export async function learnRelayWsPort(baseUrl, { fetchImpl = typeof fetch === 'function' ? fetch : null, timeoutMs = 4000 } = {}) {
  const origin = originOf(baseUrl)
  // Only a venue relay on an explicit port: the cloud (and a LAN relay behind
  // a proxy on the default port) reports its container's port, not the
  // public one, and takes the WebSocket on its own origin anyway.
  if (!origin || !fetchImpl || !isLanBackendUrl(origin) || !new URL(origin).port) return null
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(`${origin}/api/server/status`, controller ? { signal: controller.signal } : undefined)
    if (!res?.ok) return null
    const body = await res.json()
    const port = validPort(body?.wsPort)
    if (port) rememberRelayWsPort(origin, port)
    return port
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const sameServer = (a, b) => {
  if (!a || !b) return false
  try {
    const [x, y] = [new URL(a), new URL(b)]
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '')
  } catch {
    return false
  }
}

/**
 * Is this the backend this page uses when nothing was chosen on it
 * (defaultBackendUrl)? The page reaches it with no override, so it is
 * accepted even where isAllowedBackendUrl does not cover its address: a page
 * a venue relay serves on a plain host name, an IPv6 or 100.64/10 address.
 * @param {string|null|undefined} url
 */
export function isDefaultBackendUrl(url) {
  return sameServer(url, defaultBackendUrl())
}

/**
 * The server a role link's ?server= names, as a URL (normalizeServerAddress),
 * or null when it names none this app would use (isAllowedBackendUrl).
 * @param {string|null} serverParam
 */
export function serverParamUrl(serverParam) {
  if (!serverParam || typeof serverParam !== 'string') return null
  const url = normalizeServerAddress(serverParam)
  return isAllowedBackendUrl(url) ? url : null
}

/**
 * What a role page does with its link's ?server=:
 *   'none'   no server, or one isAllowedBackendUrl refuses: the page's own
 *            choice stands, nothing is fetched from it
 *   'known'  the server this page uses already, or its own default (the
 *            scorer's QR links name the backend it syncs to; on a page a
 *            venue relay serves, that relay, whatever its address): used at
 *            once
 *   'ask'    another server: used only once the connection screen asked,
 *            naming its host, and the user said yes (confirmLinkServer)
 * @param {string|null} serverParam
 * @returns {{ state: 'none'|'known'|'ask', url: string|null }}
 */
export function linkServerState(serverParam) {
  if (!serverParam || typeof serverParam !== 'string') return { state: 'none', url: null }
  const named = normalizeServerAddress(serverParam)
  if (sameServer(named, getBackendUrl()) || isDefaultBackendUrl(named)) return { state: 'known', url: named }
  const url = serverParamUrl(serverParam)
  if (!url) return { state: 'none', url: null }
  return { state: 'ask', url }
}

/** Does this page's link name a server the connection screen must ask about first? */
export function serverParamNeedsConfirm(serverParam) {
  return linkServerState(serverParam).state === 'ask'
}

/**
 * Use the server a role link named, for this role page in this tab only: not
 * for later visits, never on the scoretable (a link opened on the scoring
 * device must not move the relay its PINs and rosters go to, nor its
 * sign-in). For a venue relay its WebSocket port is learnt in the background
 * (the 5173 -> 8080 default of getRelayWebSocketUrl covers the desktop app
 * until then). The connection screen calls it once the user confirmed the
 * host. The page's own server on an address isAllowedBackendUrl does not
 * cover is kept as "the page's default" (no override, OWN_SERVER).
 * @param {string} url
 * @returns {boolean} whether this page now uses it
 */
export function confirmLinkServer(url) {
  if (!isAllowedBackendUrl(url)) {
    if (!isDefaultBackendUrl(url)) return false
    writeLinkServer(url)
    return sameServer(getBackendUrl(), url)
  }
  writeLinkServer(url)
  if (getBackendOverride() !== url) return false
  void learnRelayWsPort(url)
  return true
}

/**
 * A role link's ?server= (referee, bench, livescore), on page load. The
 * server this page uses already, or its own default, is used at once (kept
 * for this page in this tab, so a reload asks nothing); another one only
 * after the connection screen asked (linkServerState 'ask').
 * @param {string|null} serverParam
 * @returns {'none'|'known'|'ask'}
 */
export function applyServerParam(serverParam) {
  const { state, url } = linkServerState(serverParam)
  if (state === 'known') confirmLinkServer(url)
  return state
}

/**
 * WebSocket URL of a relay chosen as the backend override. The port its
 * /api/server/status named (learnRelayWsPort) wins. Without one, a LAN relay
 * on the desktop relays' HTTP port 5173 takes its WebSocket on 8080 (the
 * desktop app, Electron and frontend/server.js do not accept it on 5173);
 * anything else (the venue server, the cloud) on its own port.
 * @param {string} override
 */
function overrideWebSocketUrl(override) {
  const url = new URL(override)
  const protocol = url.protocol === 'https:' ? 'wss' : 'ws'
  if (!url.port || !isLanBackendUrl(override)) return httpToWsUrl(override)
  const learned = relayWsPortFor(override)
  if (learned) return `${protocol}://${url.hostname}:${learned}`
  if (url.port === DESKTOP_RELAY_HTTP_PORT) return `${protocol}://${url.hostname}:${DESKTOP_RELAY_WS_PORT}`
  return httpToWsUrl(override)
}

/**
 * WebSocket URL of the match relay (sync-match-data / subscribe-match). Every
 * relay client (scorer, referee, bench, livescore, tablet status) resolves it
 * here, so the scorer publishes where its tablets listen.
 *
 * Same precedence as getBackendUrl: the ?server= / connection-screen override
 * (on the port its relay named, see overrideWebSocketUrl: the Android app at
 * http://<laptop>:5173 reaches the desktop relay's WebSocket on 8080),
 * VITE_BACKEND_URL, the cloud relay on *.openvolley.app — those relays take the
 * WebSocket on their HTTP port. A page served by a LAN relay (Pi, desktop app)
 * or the dev server reaches it on the relay's own WS port: `wsPort` when the
 * caller knows it (Electron server status), else 8080 — except behind a proxy
 * on the default port, where the WebSocket shares the page's origin.
 * Returns null when there is no relay to reach (a page opened from file://).
 * @param {{ wsPort?: number|string|null }} [options]
 * @returns {string|null}
 */
export function getRelayWebSocketUrl({ wsPort = null } = {}) {
  const override = getBackendOverride()
  if (override) return overrideWebSocketUrl(override)
  if (import.meta.env.VITE_BACKEND_URL) return httpToWsUrl(import.meta.env.VITE_BACKEND_URL)
  if (typeof window === 'undefined' || !window.location) return null
  if (isStaticDeployment()) {
    const cloud = cloudFallbackUrl()
    return cloud ? httpToWsUrl(cloud) : null
  }
  const { protocol: pageProtocol, hostname, port, origin } = window.location
  if (pageProtocol !== 'http:' && pageProtocol !== 'https:') return null
  const protocol = pageProtocol === 'https:' ? 'wss' : 'ws'
  if (wsPort) return `${protocol}://${hostname}:${wsPort}`
  if (import.meta.env.DEV) return `${protocol}://${hostname}:${import.meta.env.VITE_WS_PORT || 8080}`
  if (!port) return httpToWsUrl(origin)
  return `${protocol}://${hostname}:8080`
}

/**
 * Convert an HTTP(S) URL to a WS(S) URL
 * @param {string} httpUrl
 * @returns {string}
 */
function httpToWsUrl(httpUrl) {
  const url = new URL(httpUrl)
  const protocol = url.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${url.host}`
}

export function isBackendAvailable() {
  return getBackendUrl() !== null
}

export function isStandaloneMode() {
  return !isBackendAvailable()
}

/**
 * Is this URL on this machine or the local network (localhost, *.local, RFC1918)?
 * Such a host is a venue relay (desktop app, Pi, standalone server), never
 * the cloud backend.
 * @param {string|null|undefined} url
 */
export function isLanBackendUrl(url) {
  if (!url) return false
  let host
  try { host = new URL(url).hostname } catch { return false }
  return isLanHost(host)
}

const isLoopbackHost = (hostname) => {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '::1' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(host)
}

/**
 * Is this page served by a local / self-hosted server from an address other
 * than loopback (a venue tablet at http://192.168.1.20:5173/referee, the Pi
 * at http://openvolley.local, a self-hosted domain)? The cloud backend's CORS
 * never trusts such an origin. The desktop window itself (http://localhost)
 * is not one.
 */
export function isServedFromLanOrigin() {
  if (!isServedFromLocalServer()) return false
  const { protocol, hostname } = window.location || {}
  if (protocol !== 'http:' && protocol !== 'https:') return false
  return !isLoopbackHost(hostname)
}

/**
 * Loopback origins the cloud backend's CORS trusts (ALLOWED_ORIGINS in
 * backend/server.js): the desktop window on the relay's default port 5173 and
 * a local server.js on 3000. Keep the two lists in step.
 */
const CLOUD_TRUSTED_LOOPBACK_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
]

/**
 * Is this the desktop window (a page a local relay serves on loopback) on a
 * port the cloud does not trust? OPENVOLLEY_HTTP_PORT can move the relay off
 * 5173 (when another program holds it); the cloud's CORS would then reject
 * every call, so cloud sync is unavailable there and says so instead of
 * failing as "Offline". A build or runtime override naming another cloud
 * (VITE_CLOUD_API_URL / VITE_BACKEND_URL / a cloud ?server=) is not judged.
 * @returns {boolean}
 */
export function isCloudBlockedOnThisPort() {
  if (!isServedFromLocalServer() || isServedFromLanOrigin()) return false
  if (import.meta.env.VITE_CLOUD_API_URL || import.meta.env.VITE_BACKEND_URL) return false
  const override = getBackendOverride()
  if (override && !isLanBackendUrl(override)) return false
  const { protocol, origin } = window.location || {}
  if (protocol !== 'http:' && protocol !== 'https:') return false
  return !CLOUD_TRUSTED_LOOPBACK_ORIGINS.includes(origin)
}

const stripTrailingSlash = (url) => String(url).replace(/\/+$/, '')

/**
 * Base URL of the CLOUD API: /api/db, /api/auth/*, /api/storage/*, the match
 * restore / claim / PIN endpoints, official matches, contact, and the
 * database realtime socket. Kept apart from the relay (getBackendUrl /
 * getRelayWebSocketUrl), which carries the match to the venue tablets:
 *
 *   - A page served by a local relay from a LAN / non-loopback host (venue
 *     tablets at http://<laptop-IP>:5173/referee, a browser on the Pi's LAN
 *     address, a self-hosted server on its own domain): the page's own server,
 *     exactly like the relay (getBackendUrl). The cloud backend only trusts
 *     its own origins and the loopback / native app origins, so a cloud call
 *     from a LAN origin could never succeed — and a hall Wi-Fi without uplink
 *     would make each one hang on DNS before the relay fallback. The relay
 *     answers /api/db with an instant 404 (no cloud: relay only); a
 *     self-hosted server with a database answers it itself.
 *   - VITE_CLOUD_API_URL, when the build sets one.
 *   - A runtime override (?server= / connection screen / Android "Change
 *     server") that is a cloud host serves both. One on the LAN is a venue
 *     relay without a database: the cloud stays the cloud.
 *   - VITE_BACKEND_URL (web builds on *.openvolley.app: one backend for both).
 *   - Static deployments and the native app: backend.openvolley.app.
 *   - A page served by a local relay on loopback (the Tauri desktop window
 *     at http://localhost:5173): that relay has no /api/db, so cloud calls go
 *     to backend.openvolley.app (which trusts that origin) whenever it is
 *     reachable, while the relay keeps the venue running offline. On another
 *     port (OPENVOLLEY_HTTP_PORT) the cloud would reject the origin: null.
 *   - Dev server: same as getBackendUrl (unchanged).
 * @returns {string|null}
 */
export function getCloudApiBaseUrl() {
  if (isServedFromLanOrigin()) {
    const base = getBackendUrl()
    return base ? stripTrailingSlash(base) : null
  }
  if (import.meta.env.VITE_CLOUD_API_URL) return stripTrailingSlash(import.meta.env.VITE_CLOUD_API_URL)
  const override = getBackendOverride()
  if (override && !isLanBackendUrl(override)) return stripTrailingSlash(override)
  if (import.meta.env.VITE_BACKEND_URL) return stripTrailingSlash(import.meta.env.VITE_BACKEND_URL)
  // A dev build without its test backend has no cloud (cloudFallbackUrl)
  if (override) return cloudFallbackUrl()
  if (isStaticDeployment()) return cloudFallbackUrl()
  // The desktop window off port 5173: the cloud would reject it (CORS), so
  // there is no cloud here (isCloudBlockedOnThisPort) and the relay goes on
  if (isServedFromLocalServer()) return isCloudBlockedOnThisPort() ? null : cloudFallbackUrl()
  const base = getBackendUrl()
  return base ? stripTrailingSlash(base) : null
}

/**
 * Do cloud calls go somewhere else than the relay (desktop app, venue LAN
 * relay)? Then a cloud failure says nothing about the venue, and vice versa.
 */
export function isCloudApiSplit() {
  const cloud = getCloudApiBaseUrl()
  const relay = getBackendUrl()
  if (!cloud || !relay) return false
  return stripTrailingSlash(cloud) !== stripTrailingSlash(relay)
}

/**
 * Full URL of a cloud API endpoint (see getCloudApiBaseUrl), or null.
 * @param {string} path
 */
export function getCloudApiUrl(path) {
  const base = getCloudApiBaseUrl()
  if (!base) return null
  return `${base}${path.startsWith('/') ? path : '/' + path}`
}

/**
 * WebSocket base of the cloud database realtime (relayRealtime, ?purpose=live).
 * Same backend as the cloud API when the two are split; otherwise unchanged
 * (getWebSocketUrl). None for the desktop window off port 5173.
 */
export function getCloudWebSocketUrl() {
  if (isCloudBlockedOnThisPort()) return null
  if (isCloudApiSplit()) {
    try { return httpToWsUrl(getCloudApiBaseUrl()) } catch { return null }
  }
  return getWebSocketUrl()
}

/**
 * URL of a RELAY endpoint: the server that carries the match to the tablets
 * (/api/server/*, /api/match/list, /api/match/:id, validate-pin). On the
 * cloud web build this is the same backend as getCloudApiUrl.
 * @param {string} path
 */
export function getApiUrl(path) {
  const backendUrl = getBackendUrl()

  if (!backendUrl) {
    return null // No backend, can't make API calls
  }

  return `${backendUrl}${path.startsWith('/') ? path : '/' + path}`
}

/**
 * Is this relay URL a venue / local relay (the desktop app, the Pi, a scorer
 * laptop on the hall network, the dev server) rather than a cloud relay? Only
 * hosts that cannot be the internet count: loopback, private and link-local
 * addresses (RFC 1918, 169.254/16, 100.64/10 as Tailscale uses it, fc00::/7,
 * fe80::/10), mDNS / home-network names (.local, .lan, .home.arpa, .internal,
 * .localhost) and single-label host names. Anything else, the cloud relay
 * (backend.openvolley.app) included, is not local.
 * @param {string|null|undefined} url
 */
export function isLocalRelayUrl(url) {
  if (!url || typeof url !== 'string') return false
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host) return false
  if (host.includes(':')) {
    // IPv6: loopback, unique local (fc00::/7), link-local (fe80::/10)
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  if (host === 'localhost' || !host.includes('.')) return true
  return /\.(local|lan|home\.arpa|internal|localhost)$/.test(host)
}
