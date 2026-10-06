/**
 * Is the backend this page talks to on the local network (or this machine)?
 *
 * When the browser reports offline (navigator.onLine === false, the 'offline'
 * event), a cloud backend cannot answer, whatever the last poll said: the
 * connection pill must say Offline at once. Only a server on this machine or
 * the venue LAN (offline desktop app, Pi scoretable serving tablets) can
 * still be reached, so only then do the polled server/WebSocket statuses
 * still count.
 */
import { getBackendUrl, isServedFromLocalServer } from './backendConfig'

/**
 * Loopback, private (RFC 1918), link-local, CGNAT / Tailscale (100.64/10),
 * IPv6 loopback / ULA / link-local, the usual LAN-only names, and single-label
 * names (http://scoretable:3000, http://openvolley/): public DNS names
 * always have a dot.
 * @param {string} hostname
 */
export function isLocalNetworkHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  // Single label (no dot, not IPv6): a LAN name resolved by the router / hosts file
  if (!h.includes('.') && !h.includes(':')) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true
  if (h === '::1' || h.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(h)) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
}

/**
 * True when the backend (override, VITE_BACKEND_URL, same origin) is on
 * this machine or the local network.
 * @param {{ backendUrl?: string|null, servedFromLocalServer?: boolean }} [given] for tests
 */
export function backendOnLocalNetwork(given = {}) {
  let url = given.backendUrl
  if (url === undefined) {
    try { url = getBackendUrl() } catch { url = null }
  }
  if (!url) {
    const local = given.servedFromLocalServer ?? (() => { try { return isServedFromLocalServer() } catch { return false } })()
    return !!local
  }
  try {
    return isLocalNetworkHost(new URL(url).hostname)
  } catch {
    return false
  }
}
