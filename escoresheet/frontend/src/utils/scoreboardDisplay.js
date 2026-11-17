/**
 * A scoreboard display that follows the scorer's match (an LED board's
 * controller, a hall screen), and its settings page
 * (docs/scoreboard-display-spec.md).
 *
 * The display subscribes to the match on the relay with device 'display' and
 * may name its settings page (settingsUrl). The relay tells the match's
 * scorer, and only the scorer, with display-presence { matchId, present,
 * settingsUrl }: on the scorer socket's first accepted sync of the match and
 * whenever it changes. The scorer's menu then offers "Scoreboard settings",
 * which opens that page; with no display, or none that named a usable page,
 * there is no entry.
 *
 * The relays pass on only private-LAN http(s) pages; the page is checked here
 * again (scoreboardSettingsUrl), never trusted as it came: an http(s) URL with
 * no user name or password, on a private-LAN address, or on the host this page
 * itself was loaded from (a display serving the scorer's app).
 */
import { scorerRelay } from './relayPublisher'

export const MAX_SETTINGS_URL_LENGTH = 256

/** RFC 1918 IPv4 or an IPv6 unique local address (fc00::/7), as new URL().hostname gives them. */
export function isPrivateLanHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number)
    if ([a, b, c, d].some((n) => n > 255)) return false
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  const v6 = /^\[([0-9a-f:.]+)\]$/i.exec(hostname)
  if (v6) return /^f[cd][0-9a-f]{2}:/i.test(v6[1])
  return false
}

const isLoopbackHost = (h) => h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '[::1]'

/**
 * The display's settings page as the scorer may open it (the normalised
 * href), or null.
 * @param {unknown} raw
 * @param {{ pageHost?: string|null }} [opts]  the host this page was loaded from
 * @returns {string|null}
 */
export function scoreboardSettingsUrl(raw, { pageHost = null } = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SETTINGS_URL_LENGTH) return null
  if (/[\u0000- \u007f]/.test(raw)) return null
  let u
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  // the page's own host (not this device itself: localhost is the Android app's own page)
  const sameHost = typeof pageHost === 'string' && pageHost !== '' && u.hostname === pageHost.toLowerCase() && !isLoopbackHost(u.hostname)
  if (!isPrivateLanHost(u.hostname) && !sameHost) return null
  return u.href.length <= MAX_SETTINGS_URL_LENGTH ? u.href : null
}

const pageHostOf = (win) => {
  try { return win?.location?.hostname || null } catch { return null }
}

/**
 * What a relay message says about the displays of `relayKey`: { settingsUrl }
 * (a display follows and its page may be opened), null (none, or none with a
 * usable page), or undefined (the message is not about that).
 */
export function displayFromMessage(message, relayKey, { pageHost = null } = {}) {
  if (!message || message.type !== 'display-presence' || relayKey == null) return undefined
  if (String(message.matchId) !== String(relayKey)) return undefined
  if (message.present !== true) return null
  const settingsUrl = scoreboardSettingsUrl(message.settingsUrl, { pageHost })
  return settingsUrl ? { settingsUrl } : null
}

/**
 * The last display state per match, as the relay told this page's scorer
 * socket. One per page, listening from the start (the answer comes right
 * after the scorer's first sync, before the scoring screen may be open). A
 * state told on an earlier socket counts as unknown: the new socket's first
 * sync is answered again.
 * @param {{ relay?: typeof scorerRelay, win?: Window }} [opts]
 */
export function createScoreboardDisplays({ relay = scorerRelay, win = typeof window !== 'undefined' ? window : undefined } = {}) {
  const byMatch = new Map() // relay key -> { display, socket }
  const watchers = new Set()
  relay.listen((message, socket) => {
    if (message?.type !== 'display-presence' || message.matchId == null) return
    const key = String(message.matchId)
    const display = displayFromMessage(message, key, { pageHost: pageHostOf(win) })
    byMatch.set(key, { display: display ?? null, socket: socket ?? null })
    for (const fn of [...watchers]) fn()
  })
  return {
    /** { settingsUrl } or null */
    get(relayKey) {
      if (relayKey == null) return null
      const entry = byMatch.get(String(relayKey))
      if (!entry) return null
      if (entry.socket && relay.socket !== entry.socket) return null
      return entry.display
    },
    subscribe(fn) {
      watchers.add(fn)
      return () => watchers.delete(fn)
    }
  }
}

export const scoreboardDisplays = createScoreboardDisplays()
