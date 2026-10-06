/**
 * Backend Configuration
 * Detects if backend server is available and provides URLs
 * Supports runtime override via localStorage for local server connections
 */

// Cloud relay URL for tablets/mobile (non-Electron/non-desktop)
const CLOUD_RELAY_URL = 'https://backend.openvolley.app'

// localStorage key for runtime backend URL override
const OVERRIDE_KEY = 'openvolley_backend_override'

/**
 * SECURITY: the backend override decides where the app sends requests carrying
 * the user's auth token. It can be set from the ?server= query param, so it must
 * be restricted to trusted targets (LAN/localhost or an openvolley.app host) —
 * otherwise a crafted link could exfiltrate the session token to any origin.
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowedBackendUrl(url) {
  if (!url || typeof url !== 'string') return false
  let u
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  if (host.endsWith('.openvolley.app') || host === 'openvolley.app') return true
  if (host.endsWith('.local')) return true // mDNS LAN hostnames
  // Private (RFC1918) LAN ranges
  if (/^10\.(\d{1,3}\.){2}\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

/**
 * Set a runtime backend URL override (persists in localStorage)
 * Used when connecting to a local server at a custom IP:port
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
}

/**
 * Get the current backend URL override, if set (and still trusted)
 * @returns {string|null}
 */
export function getBackendOverride() {
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
 * Clear the backend URL override
 */
export function clearBackendOverride() {
  try { localStorage.removeItem(OVERRIDE_KEY) } catch {}
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
  const override = getBackendOverride()
  if (override) {
    return override
  }

  // If VITE_BACKEND_URL is set, use it (production with separate backend)
  if (import.meta.env.VITE_BACKEND_URL) {
    return import.meta.env.VITE_BACKEND_URL
  }

  // On static deployments (*.openvolley.app), always use cloud relay
  // These deployments have no backend server
  if (isStaticDeployment()) {
    return CLOUD_RELAY_URL
  }

  // If served from a local server (non-openvolley.app, not localhost dev),
  // the app is running on the standalone server — use same origin as backend
  if (isServedFromLocalServer()) {
    return window.location.origin
  }

  // On tablets/mobile in production, use cloud relay automatically
  if (!import.meta.env.DEV && isTabletOrMobile()) {
    return CLOUD_RELAY_URL
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
    return httpToWsUrl(CLOUD_RELAY_URL)
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

/**
 * WebSocket URL of the match relay (sync-match-data / subscribe-match). Every
 * relay client (scorer, referee, bench, livescore, tablet status) resolves it
 * here, so the scorer publishes where its tablets listen.
 *
 * Same precedence as getBackendUrl: the ?server= / connection-screen override,
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
  if (override) return httpToWsUrl(override)
  if (import.meta.env.VITE_BACKEND_URL) return httpToWsUrl(import.meta.env.VITE_BACKEND_URL)
  if (typeof window === 'undefined' || !window.location) return null
  if (isStaticDeployment()) return httpToWsUrl(CLOUD_RELAY_URL)
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
  host = host.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true
  if (/^127\.(\d{1,3}\.){2}\d{1,3}$/.test(host)) return true
  if (/^10\.(\d{1,3}\.){2}\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

const stripTrailingSlash = (url) => String(url).replace(/\/+$/, '')

/**
 * Base URL of the CLOUD API: /api/db, /api/auth/*, /api/storage/*, the match
 * restore / claim / PIN endpoints, official matches, contact, and the
 * database realtime socket. Kept apart from the relay (getBackendUrl /
 * getRelayWebSocketUrl), which carries the match to the venue tablets:
 *
 *   - VITE_CLOUD_API_URL, when the build sets one.
 *   - A runtime override (?server= / connection screen / Android "Change
 *     server") that is a cloud host serves both. One on the LAN is a venue
 *     relay without a database: the cloud stays the cloud.
 *   - VITE_BACKEND_URL (web builds on *.openvolley.app: one backend for both).
 *   - Static deployments and the native app: backend.openvolley.app.
 *   - A page served by a local relay (Tauri desktop app, Pi, standalone LAN
 *     server, the tablets that load from them): those relays have no /api/db,
 *     so cloud calls go to backend.openvolley.app whenever it is reachable,
 *     while the relay keeps the venue running offline.
 *   - Dev server: same as getBackendUrl (unchanged).
 * @returns {string|null}
 */
export function getCloudApiBaseUrl() {
  if (import.meta.env.VITE_CLOUD_API_URL) return stripTrailingSlash(import.meta.env.VITE_CLOUD_API_URL)
  const override = getBackendOverride()
  if (override && !isLanBackendUrl(override)) return stripTrailingSlash(override)
  if (import.meta.env.VITE_BACKEND_URL) return stripTrailingSlash(import.meta.env.VITE_BACKEND_URL)
  if (override) return CLOUD_RELAY_URL
  if (isStaticDeployment()) return CLOUD_RELAY_URL
  if (isServedFromLocalServer()) return CLOUD_RELAY_URL
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
 * (getWebSocketUrl).
 */
export function getCloudWebSocketUrl() {
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
