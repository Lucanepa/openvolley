/**
 * The links the "Connect tablets" dialog shows for each role, on each kind of
 * connection, and the Wi-Fi QR code for the laptop's own network.
 *
 * Roles: the scoretable (a second scorer screen), the referee, the home and
 * away benches and the livescore. A link only *preselects* the match
 * (`?match=<seed key>`, never the Dexie id); the tablet still asks for the
 * role's PIN, which is shown on the scorer's screen and never put in a link
 * or a QR code. The game PIN is never shown at all: the relay accepts it for
 * every role.
 */

import { cloudTabletBase } from '../components/QRCodeModal'

export const TABLET_ROLES = ['main', 'referee', 'bench_home', 'bench_away', 'livescore']

const LAN_PATHS = {
  main: '/',
  referee: '/referee',
  bench_home: '/bench',
  bench_away: '/bench',
  livescore: '/livescore'
}

/**
 * The role's PIN and whether the scorer let that role in. Livescore and the
 * scoretable have no PIN.
 * @param {object|null} match the scorer's Dexie match
 * @param {string} role
 * @returns {{ pin: string|null, enabled: boolean|null, field: string|null, syncField: string|null, pinKey: string|null }}
 */
export function roleAccess(match, role) {
  const map = {
    referee: { pin: match?.refereePin, enabled: match?.refereeConnectionEnabled, field: 'refereeConnectionEnabled', syncField: 'referee_enabled', pinKey: 'referee' },
    bench_home: { pin: match?.homeTeamPin, enabled: match?.homeTeamConnectionEnabled, field: 'homeTeamConnectionEnabled', syncField: 'home_bench_enabled', pinKey: 'bench_home' },
    bench_away: { pin: match?.awayTeamPin, enabled: match?.awayTeamConnectionEnabled, field: 'awayTeamConnectionEnabled', syncField: 'away_bench_enabled', pinKey: 'bench_away' }
  }
  const entry = map[role]
  if (!entry) return { pin: null, enabled: null, field: null, syncField: null, pinKey: null }
  const pin = entry.pin != null && String(entry.pin).trim() !== '' ? String(entry.pin).trim() : null
  return { ...entry, pin, enabled: match ? entry.enabled === true : null }
}

function query(role, seedKey, extra = {}) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v)
  if (seedKey && role !== 'livescore' && role !== 'main') params.set('match', String(seedKey))
  if (role === 'bench_home') params.set('team', 'home')
  if (role === 'bench_away') params.set('team', 'away')
  const q = params.toString()
  return q ? `?${q}` : ''
}

/**
 * A role's link on the local network: the laptop's address on that network
 * (hall Wi-Fi, its own Wi-Fi, Bluetooth). The page's own server is the relay,
 * so no `server=` is needed.
 * @param {string} ip
 * @param {number|string} port
 * @param {string} role
 * @param {string|null} seedKey
 */
export function lanRoleUrl(ip, port, role, seedKey) {
  if (!ip || !LAN_PATHS[role]) return null
  const host = String(ip).includes(':') ? `[${ip}]` : ip
  const p = port && String(port) !== '80' ? `:${port}` : ''
  return `http://${host}${p}${LAN_PATHS[role]}${query(role, seedKey)}`
}

/**
 * Where the scoretable itself lives online, next to the scorer's deployment
 * (dev-app.openvolley.app stays on dev; the desktop app links production).
 */
export function cloudScoretableBase(hostname = typeof window !== 'undefined' ? window.location.hostname : '') {
  const host = String(hostname || '').toLowerCase()
  if (host.endsWith('.openvolley.app') || host.endsWith('openvolley-app.pages.dev')) return `https://${host}`
  return 'https://app.openvolley.app'
}

/**
 * A role's link through the cloud: the role's site on *.openvolley.app (as
 * QRCodeModal's cloudTabletBase derives it) with the backend the scorer syncs
 * to, so a dev scorer's tablets use the dev backend.
 * @param {string} role
 * @param {string|null} seedKey
 * @param {{ cloudApiBase?: string|null, hostname?: string }} [opts]
 */
export function cloudRoleUrl(role, seedKey, { cloudApiBase = null, hostname } = {}) {
  if (role === 'main') return `${cloudScoretableBase(hostname)}/`
  const base = cloudTabletBase(role, hostname)
  if (!base) return null
  return `${base}/${query(role, seedKey, { server: cloudApiBase })}`
}

/**
 * The interfaces /api/server/status reports (Tauri relay: `interfaces`),
 * with a fallback for relays that only send `localIP` (Electron, server.js,
 * the dev server).
 * @returns {{ name: string, ip: string, kind: 'hotspot'|'wifi'|'ethernet'|'bluetooth'|'other' }[]}
 */
export function statusInterfaces(status) {
  if (!status) return []
  if (Array.isArray(status.interfaces)) {
    return status.interfaces.filter(i => i && i.ip && i.kind)
  }
  const ip = status.localIP || status.ip
  if (!ip || ip === '127.0.0.1' || ip === 'localhost') return []
  return [{ name: '', ip, kind: 'other' }]
}

/** Addresses of the hall network: Wi-Fi first, then Ethernet, then other. */
export function hallInterfaces(status) {
  const order = { wifi: 0, ethernet: 1, other: 2 }
  return statusInterfaces(status)
    .filter(i => i.kind in order)
    .sort((a, b) => order[a.kind] - order[b.kind])
}

export const firstOfKind = (status, kind) => statusInterfaces(status).find(i => i.kind === kind) || null

/**
 * Escape a value for the Wi-Fi QR format (ZXing / Wi-Fi Alliance `WIFI:`
 * URI): backslash, semicolon, comma, colon and double quote take a
 * backslash.
 */
export function escapeWifiQr(value) {
  return String(value ?? '').replace(/([\\;,:"])/g, '\\$1')
}

/**
 * The Wi-Fi QR code text: the tablet's camera (iPad) or Wi-Fi settings
 * (Android 10+: Settings > Wi-Fi > QR icon) joins the network from it.
 * @param {{ ssid: string, password?: string|null, hidden?: boolean }} network
 */
export function wifiQrString({ ssid, password, hidden = false }) {
  if (!ssid) return null
  const auth = password ? 'WPA' : 'nopass'
  let out = `WIFI:T:${auth};S:${escapeWifiQr(ssid)};`
  if (password) out += `P:${escapeWifiQr(password)};`
  if (hidden) out += 'H:true;'
  return `${out};`
}
