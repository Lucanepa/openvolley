/**
 * Backend Configuration
 * Detects if backend server is available and provides URLs
 */

// Cloud relay URL for tablets/mobile (non-Electron/non-desktop)
const CLOUD_RELAY_URL = 'https://escoresheet-backend-production.up.railway.app'

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

// Get backend URL from environment or use current host
export function getBackendUrl() {
  // If VITE_BACKEND_URL is set, use it (production with separate backend)
  if (import.meta.env.VITE_BACKEND_URL) {
    return import.meta.env.VITE_BACKEND_URL
  }

  // On static deployments (*.openvolley.app), always use cloud relay
  // These deployments have no backend server
  if (isStaticDeployment()) {
    console.log('[BackendConfig] Static deployment detected, using cloud relay:', CLOUD_RELAY_URL)
    return CLOUD_RELAY_URL
  }

  // On tablets/mobile in production, use cloud relay automatically
  if (!import.meta.env.DEV && isTabletOrMobile()) {
    console.log('[BackendConfig] Tablet/mobile detected, using cloud relay:', CLOUD_RELAY_URL)
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

  // If backend URL is set, use it for WebSocket
  if (import.meta.env.VITE_BACKEND_URL) {
    const url = new URL(import.meta.env.VITE_BACKEND_URL)
    const protocol = url.protocol === 'https:' ? 'wss' : 'ws'
    return `${protocol}://${url.host}`
  }

  // On static deployments, use cloud relay WebSocket
  if (isStaticDeployment()) {
    const url = new URL(CLOUD_RELAY_URL)
    const protocol = url.protocol === 'https:' ? 'wss' : 'ws'
    return `${protocol}://${url.host}`
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
