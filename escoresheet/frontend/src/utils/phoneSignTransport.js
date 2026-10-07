/**
 * Sign on phone: which way the phone can reach a session (docs/qr-signing-spec.md
 * 5.2, 5.4). Pure: the caller hands in what it knows (online, the cloud API
 * base, the account, the local relay's /api/server/status, the laptop's Wi-Fi).
 *
 *   cloud  backend.openvolley.app (getCloudApiBaseUrl): online, signed in with
 *          a scorer, referee (indoor or beach) or admin account (D2), and not the
 *          desktop window on a port the cloud refuses (isCloudBlockedOnThisPort).
 *   lan    the relay that serves this page (the Tauri / Electron window, server.js,
 *          a Pi): it must report an address a phone can open (hallInterfaces),
 *          or the page itself was opened by a LAN address.
 *
 * Default (D6): the cloud when it works (a phone on mobile data reaches it
 * without joining any Wi-Fi), else the hall network; when both work the
 * scorer's last choice (ov_phone_sign_transport) wins.
 */
import { firstOfKind, hallInterfaces } from './tabletLinks'

export const TRANSPORT_KEY = 'ov_phone_sign_transport'
const SIGN_STARTER_ROLES = ['scorer', 'referee', 'beach:scorer', 'beach:referee']

/** May this account start phone signing over the internet (spec D2)? */
export function mayStartPhoneSign(access) {
  if (!access) return false
  if (access.isAdmin) return true
  const roles = Array.isArray(access.roles) ? access.roles : []
  return SIGN_STARTER_ROLES.some((r) => roles.includes(r))
}

export function rememberedTransport(storage = safeStorage()) {
  try {
    const v = storage?.getItem(TRANSPORT_KEY)
    return v === 'cloud' || v === 'lan' ? v : null
  } catch {
    return null
  }
}

export function rememberTransport(value, storage = safeStorage()) {
  try { storage?.setItem(TRANSPORT_KEY, value) } catch { /* private mode */ }
}

function safeStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

const stripSlash = (u) => String(u).replace(/\/+$/, '')

/**
 * @param {{
 *   online: boolean,
 *   cloudApiBase: string|null,       // getCloudApiBaseUrl()
 *   cloudBlocked?: boolean,          // isCloudBlockedOnThisPort()
 *   signedIn: boolean,
 *   access?: object|null,
 *   relayOrigin?: string|null,       // origin of the relay serving this page (getLocalServerStatusUrl answered)
 *   relayStatus?: object|null,       // its /api/server/status
 *   pageOrigin?: string|null,        // window.location.origin
 *   pageOnLanAddress?: boolean,      // isServedFromLanOrigin(): opened by a LAN address
 *   lanMode?: 'hall'|'laptop',       // the Connect tablets choice (ov_connect_tablets_view)
 *   hallIp?: string|null,            // the hall address picked in this dialog
 *   hotspot?: object|null,           // hotspot_status (desktop app)
 *   remembered?: 'cloud'|'lan'|null,
 * }} input
 */
export function availableTransports(input) {
  const {
    online, cloudApiBase, cloudBlocked = false, signedIn, access = null,
    relayOrigin = null, relayStatus = null, pageOrigin = null, pageOnLanAddress = false,
    lanMode = 'hall', hallIp = null, hotspot = null, remembered = null,
  } = input || {}

  // --- cloud ---
  let cloud
  if (!online || !cloudApiBase || cloudBlocked) cloud = { ok: false, reason: 'offline' }
  else if (!signedIn) cloud = { ok: false, reason: 'signIn' }
  else if (!mayStartPhoneSign(access)) cloud = { ok: false, reason: 'role' }
  else cloud = { ok: true, apiBase: stripSlash(cloudApiBase), phoneBase: stripSlash(cloudApiBase) }

  // --- the venue relay ---
  let lan
  const halls = hallInterfaces(relayStatus)
  const hotspotIp = hotspot?.active ? (hotspot.gatewayIp || firstOfKind(relayStatus, 'hotspot')?.ip || null) : null
  if (!relayOrigin) {
    lan = { ok: false, reason: 'noRelay', addresses: [] }
  } else if (pageOnLanAddress && pageOrigin) {
    // Opened by a LAN address: the phone opens the same one
    lan = { ok: true, apiBase: stripSlash(relayOrigin), phoneBase: stripSlash(pageOrigin), addresses: [], ip: null, wifiStep: false }
  } else if (!relayStatus || (halls.length === 0 && !hotspotIp)) {
    lan = { ok: false, reason: 'noNetwork', addresses: halls }
  } else {
    const port = relayStatus.port || null
    const viaHotspot = lanMode === 'laptop' && !!hotspotIp
    const ip = viaHotspot ? hotspotIp : (halls.find((i) => i.ip === hallIp)?.ip || halls[0]?.ip || hotspotIp)
    const phoneBase = `${relayStatus.protocol === 'https' ? 'https' : 'http'}://${ip}${port ? `:${port}` : ''}`
    lan = { ok: true, apiBase: stripSlash(relayOrigin), phoneBase, addresses: halls, ip, wifiStep: viaHotspot }
  }

  let def = null
  if (cloud.ok && lan.ok) def = remembered === 'lan' ? 'lan' : 'cloud'
  else if (cloud.ok) def = 'cloud'
  else if (lan.ok) def = 'lan'

  return { cloud, lan, default: def, reason: def ? null : unavailableReason(cloud, lan) }
}

/**
 * Why there is no way (spec 5.4), as the key of phoneSign.reason*:
 * 'noNetwork' (a relay without an address a phone can open), 'signIn',
 * 'role', else 'none'.
 */
function unavailableReason(cloud, lan) {
  if (lan.reason === 'noNetwork') return 'noNetwork'
  if (cloud.reason === 'signIn') return 'signIn'
  if (cloud.reason === 'role') return 'role'
  return 'none'
}

/** The i18n key of a reason. */
export const REASON_KEYS = Object.freeze({
  none: 'phoneSign.reasonNone',
  signIn: 'phoneSign.reasonSignIn',
  role: 'phoneSign.reasonRole',
  noNetwork: 'phoneSign.reasonNoNetwork',
})
