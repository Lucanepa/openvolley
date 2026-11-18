/**
 * A scoreboard display that follows a match (docs/scoreboard-display-spec.md).
 *
 * A display (an LED board's controller, a hall screen) subscribes like any
 * livescore: subscribe-match { matchId, device: 'display', settingsUrl? }.
 * `settingsUrl` is where its own settings page is on the hall's network. The
 * relay keeps it only when it is an http(s) URL on a private-LAN address
 * (displaySettingsUrl) and hands it to the match's scorer only: the sockets
 * that proved the match (display-presence). Nothing else of the display goes
 * anywhere: no address, no name, no id.
 *
 * Same rule and message on every relay: lanRelayCore.cjs, src-tauri/src/relay.rs,
 * and the scorer checks it again (frontend/src/utils/scoreboardDisplay.js).
 */

export const DISPLAY_DEVICE = 'display'
export const MAX_SETTINGS_URL_LENGTH = 256

/** a.b.c.d of an IPv4 literal (WHATWG-normalised hostname), else null */
function ipv4Parts(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n <= 255) ? parts : null
}

/**
 * Whether a URL hostname (as `new URL().hostname` gives it) is an address of
 * a private LAN: IPv4 10/8, 172.16/12, 192.168/16, or an IPv6 unique local
 * address (fc00::/7). Names, loopback, link-local and public addresses are not.
 */
export function isPrivateLanHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false
  const v4 = ipv4Parts(hostname)
  if (v4) {
    const [a, b] = v4
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  const v6 = /^\[([0-9a-f:.]+)\]$/i.exec(hostname)
  if (v6) return /^f[cd][0-9a-f]{2}:/i.test(v6[1])
  return false
}

/**
 * The settings page a display announced, as the relay keeps it: the URL's
 * normalised href when it is http(s), carries no user name or password, is
 * at most MAX_SETTINGS_URL_LENGTH characters and points at a private-LAN
 * address (isPrivateLanHost); null for anything else (the display is still
 * a display, it just offers no settings page).
 * @param {unknown} raw
 * @returns {string|null}
 */
export function displaySettingsUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SETTINGS_URL_LENGTH) return null
  if (/[\u0000- \u007f]/.test(raw)) return null
  let u
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  if (!isPrivateLanHost(u.hostname)) return null
  return u.href.length <= MAX_SETTINGS_URL_LENGTH ? u.href : null
}

/**
 * display-presence for the scorer: whether a display follows the room, and
 * the settings page of the one that subscribed last with a usable URL.
 * @param {string} matchId
 * @param {{ present: boolean, settingsUrl: string|null }} state
 */
export function displayPresenceMessage(matchId, { present, settingsUrl }) {
  return { type: 'display-presence', matchId, present: !!present, settingsUrl: present ? (settingsUrl || null) : null }
}

/**
 * The room's display state from its display sockets, newest subscription
 * last: present when there is one, settingsUrl the newest one's that has one.
 * @param {Array<{ settingsUrl: string|null, at: number }>} displays
 */
export function displayStateOf(displays) {
  let settingsUrl = null
  let at = -Infinity
  for (const d of displays) {
    if (d.settingsUrl && d.at >= at) {
      settingsUrl = d.settingsUrl
      at = d.at
    }
  }
  return { present: displays.length > 0, settingsUrl }
}

/** The key two states compare by (a repeat is not sent again). */
export const displayStateKey = (s) => (s.present ? `1|${s.settingsUrl || ''}` : '0')
