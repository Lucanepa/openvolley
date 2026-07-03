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
 * Detect if running on a static deployment (*.openvolley.app)
 * Static deployments have no backend server, so they need to use cloud relay
 */
export function isStaticDeployment() {
  if (typeof window === 'undefined') return false
  return window.location.hostname.endsWith('.openvolley.app')
}

/**
 * Detect if being served from a standalone local server (not cloud, not dev)
 * Any non-cloud production host = standalone server (LAN IP, localhost, etc.)
 */
export function isServedFromLocalServer() {
  if (typeof window === 'undefined') return false
  if (import.meta.env.DEV) return false
  if (window.location.hostname.endsWith('.openvolley.app')) return false
  return true
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

// Build API URL
export function getApiUrl(path) {
  const backendUrl = getBackendUrl()

  if (!backendUrl) {
    return null // No backend, can't make API calls
  }

  return `${backendUrl}${path.startsWith('/') ? path : '/' + path}`
}
