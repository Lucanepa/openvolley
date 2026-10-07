/**
 * The "Connect tablets" dialog's step logic, without React: which way the
 * tablets connect (step 1), which tablet is picked (step 2) and what its live
 * status is (step 3). The dialog reads and writes the view here.
 *
 * The saved view keeps the shape the QR-signing pages read too:
 * localStorage `ov_connect_tablets_view` = { tab: 'lan'|'server'|'bluetooth',
 * lanMode: 'hall'|'laptop', hallIp: string|null }.
 */

import { timeLabel } from '../../ui/format.js'

export const VIEW_KEY = 'ov_connect_tablets_view'

/** The four connections of step 1, in the order they are offered. */
export const TRANSPORT_IDS = ['hall', 'laptop', 'server', 'bluetooth']

/** Each connection as the saved view writes it. */
export const TRANSPORTS = Object.freeze({
  hall: { tab: 'lan', lanMode: 'hall' },
  laptop: { tab: 'lan', lanMode: 'laptop' },
  server: { tab: 'server' },
  bluetooth: { tab: 'bluetooth' }
})

/** The roles a tablet can be picked for in step 2, in order. */
export const PICKABLE_ROLES = ['referee', 'bench_home', 'bench_away', 'livescore']

const PIN_ROLES = ['referee', 'bench_home', 'bench_away']

function storageOf(storage) {
  if (storage) return storage
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

/**
 * The saved view, cleaned: unknown values become null so the caller can fall
 * back to its recommendation.
 * @returns {{ tab: string|null, lanMode: 'hall'|'laptop', hallIp: string|null }}
 */
export function readView(storage) {
  let raw = {}
  try { raw = JSON.parse(storageOf(storage)?.getItem(VIEW_KEY) || 'null') || {} } catch { raw = {} }
  return {
    tab: ['lan', 'server', 'bluetooth'].includes(raw.tab) ? raw.tab : null,
    lanMode: raw.lanMode === 'laptop' ? 'laptop' : 'hall',
    hallIp: typeof raw.hallIp === 'string' && raw.hallIp ? raw.hallIp : null
  }
}

export function saveView(view, storage) {
  try {
    storageOf(storage)?.setItem(VIEW_KEY, JSON.stringify({
      tab: view.tab,
      lanMode: view.lanMode === 'laptop' ? 'laptop' : 'hall',
      hallIp: view.hallIp || null
    }))
  } catch { /* private mode */ }
}

/** The connection a saved view stands for, or null. */
export function transportOf(view) {
  if (!view?.tab) return null
  if (view.tab === 'lan') return view.lanMode === 'laptop' ? 'laptop' : 'hall'
  return view.tab === 'server' || view.tab === 'bluetooth' ? view.tab : null
}

/** The view after choosing a connection: the Wi-Fi mode and hall address stay. */
export function viewFor(view, transport) {
  const t = TRANSPORTS[transport]
  if (!t) return view
  return { ...view, tab: t.tab, lanMode: t.lanMode || view.lanMode || 'hall' }
}

/**
 * Step 1: each connection, whether it can work on this device (and why
 * not), and which one is recommended.
 *
 * @param {object} env
 * @param {boolean} env.served       a local server serves the tablet pages (desktop app, venue box)
 * @param {boolean} env.desktop      the desktop app (it can create networks)
 * @param {boolean} [env.relayLoading] the local server's addresses are not read yet
 * @param {Array}   [env.halls]      hallInterfaces() of the local server
 * @param {object|null} [env.hotspot]   hotspot_status
 * @param {object|null} [env.bluetooth] bluetooth_status (desktop) — may be unread
 * @param {boolean} [env.bluetoothFound] the local server reports a Bluetooth network (not desktop)
 * @param {string|null} [env.platform] 'windows' | 'linux' | … when the desktop app said
 * @param {boolean} [env.cloudBlocked] cloud sync is off in this window
 * @returns {{ id: string, available: boolean, reasonKey: string|null, recommended: boolean, experimental: boolean }[]}
 */
export function transportOptions({
  served, desktop, relayLoading = false, halls = [], hotspot = null, bluetooth = null,
  bluetoothFound = false, platform = null, cloudBlocked = false
}) {
  const hallKnown = served && !relayLoading
  const reasons = {
    hall: !served ? 'needsServer' : (hallKnown && halls.length === 0 ? 'noNetwork' : null),
    laptop: !desktop ? 'needsDesktop' : (hotspot && !hotspot.supported && !hotspot.active ? 'cannotCreateWifi' : null),
    server: cloudBlocked ? 'cloudBlocked' : null,
    bluetooth: !desktop
      ? (bluetoothFound ? null : 'needsLinuxDesktop')
      : (platform === 'windows' || bluetooth?.reason === 'windows-cannot-serve')
          ? 'windowsBluetooth'
          : (bluetooth && !bluetooth.supported && !bluetooth.active ? 'btNotHere' : null)
  }

  let recommended
  if (hotspot?.active) recommended = 'laptop'
  else if (served && (relayLoading || halls.length > 0)) recommended = 'hall'
  else if (desktop && !reasons.laptop) recommended = 'laptop'
  else if (!cloudBlocked) recommended = 'server'
  else recommended = 'hall'

  return TRANSPORT_IDS.map(id => ({
    id,
    available: !reasons[id],
    reasonKey: reasons[id],
    recommended: id === recommended,
    experimental: id === 'bluetooth'
  }))
}

/** The connection to open on: the saved one when it can work here, else the recommendation. */
export function initialTransport(saved, options) {
  const pick = options.find(o => o.id === saved)
  if (pick?.available) return pick.id
  return (options.find(o => o.recommended) || options[0]).id
}

/** The relay's subscribers of one role on one match. */
export function roleClients(clients, role, matchKey, match = null) {
  if (!Array.isArray(clients)) return []
  const key = matchKey == null ? null : String(matchKey)
  const mine = clients.filter(c => c && (!key || String(c.matchId) === key))
  if (role === 'referee') return mine.filter(c => c.role === 'referee')
  if (role !== 'bench_home' && role !== 'bench_away') return []
  const team = role === 'bench_home' ? 'home' : 'away'
  const out = mine.filter(c => c.role === 'bench' && c.team === team)
  // A bench that did not say its team: as summarizeRelayTablets counts it,
  // for the one bench that is let in
  const unknown = mine.filter(c => c.role === 'bench' && c.team !== 'home' && c.team !== 'away')
  if (unknown.length && match) {
    const home = match.homeTeamConnectionEnabled === true
    const away = match.awayTeamConnectionEnabled === true
    if ((team === 'home' && home && !away) || (team === 'away' && away && !home)) out.push(...unknown)
  }
  return out
}

/** "23" from "192.168.1.23" (or the last group of an IPv6 address). */
export function ipTail(ip) {
  const s = String(ip || '').trim()
  if (!s) return ''
  const parts = s.split(/[.:]/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

/**
 * Step 2 and 3: one tablet's live state.
 *
 * - off       the role is switched off (its tablet is told the PIN is wrong)
 * - nopin     on, but the match has no PIN for it (a bench of a cloud-loaded match)
 * - public    livescore: no PIN, anyone may watch
 * - remote    over the internet with nobody seen here: the local relay cannot see cloud tablets
 * - unknown   the relay's list cannot be read: never claim "waiting"
 * - waiting / connected / many  0, 1, more subscribers with that role
 *
 * @returns {{ status: string, count: number, since: string|null, ipTail: string }}
 */
export function roleStatus({ role, access, clients = null, matchKey = null, match = null, transport = null, reachable = false }) {
  const none = { count: 0, since: null, ipTail: '' }
  if (role === 'livescore') return { status: 'public', ...none }
  if (!PIN_ROLES.includes(role)) return { status: 'unknown', ...none }
  if (access?.enabled === false) return { status: 'off', ...none }
  if (!access?.pin) return { status: 'nopin', ...none }
  const list = reachable ? roleClients(clients, role, matchKey, match) : []
  const count = list.length
  if (count === 0) {
    if (transport === 'server') return { status: 'remote', ...none }
    if (!reachable) return { status: 'unknown', ...none }
    return { status: 'waiting', ...none }
  }
  const sorted = [...list].sort((a, b) => String(a.connectedAt || '').localeCompare(String(b.connectedAt || '')))
  const first = sorted[0]
  return {
    status: count === 1 ? 'connected' : 'many',
    count,
    since: first?.connectedAt || null,
    ipTail: ipTail(first?.ip)
  }
}

/** "14:32" (Zurich clock) for a relay `connectedAt`, or ''. */
export function sinceLabel(since) {
  if (!since) return ''
  try { return timeLabel(since) } catch { return '' }
}

/** "654 949": a six-digit PIN read out in two groups. Other lengths stay as they are. */
export function formatPin(pin) {
  const s = String(pin ?? '').trim()
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 3)} ${s.slice(3)}`
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)} ${s.slice(4)}`
  return s
}

/**
 * The tablet step 2 starts on: the first role that is let in and has no
 * tablet yet, else the first one let in, else the referee.
 * @param {(role: string) => { enabled: boolean|null }} accessOf
 * @param {Record<string, { status: string }>} [statuses]
 */
export function defaultRole(accessOf, statuses = {}) {
  const on = PIN_ROLES.filter(r => accessOf(r)?.enabled === true)
  const open = on.find(r => !['connected', 'many'].includes(statuses[r]?.status))
  return open || on[0] || 'referee'
}

/**
 * The footer summary: which roles have a tablet, of how many let in.
 * @param {Record<string, { status: string }>} statuses
 * @returns {{ connected: string[], on: number, known: boolean }}
 */
export function connectedSummary(statuses) {
  const roles = PIN_ROLES.filter(r => statuses[r])
  const on = roles.filter(r => !['off'].includes(statuses[r].status))
  const connected = on.filter(r => ['connected', 'many'].includes(statuses[r].status))
  const known = on.some(r => ['waiting', 'connected', 'many'].includes(statuses[r].status))
  return { connected, on: on.length, known }
}
