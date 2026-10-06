/**
 * The scorer's side of the match relay, kept out of the components so it can be
 * tested: the one relay connection App.jsx and Scoreboard.jsx share, which PINs
 * go with a sync, the order of live-state pushes and match_live_state writes,
 * and how long to wait before reconnecting.
 */
import { relayMatchPayload, getRelayServerStatus } from './serverDataSync'
import { getRelayWebSocketUrl } from './backendConfig'

let knownScorerWsPort = null

/**
 * The relay URL of the scorer page: App.jsx and Scoreboard.jsx both take it
 * from here, so they attach the shared connection to the SAME url. The LAN
 * relay's WS port, once either of them learnt it (Electron / server status),
 * is remembered: a Scoreboard remount (it unmounts for every sub-view) starts
 * without a status and would otherwise attach to the default-port URL, drop
 * the socket, prove the match again, and switch back when its status arrives.
 * @param {{ wsPort?: number|string|null }} [options]
 * @returns {string|null}
 */
export function scorerRelayUrl({ wsPort = null } = {}) {
  if (wsPort) knownScorerWsPort = wsPort
  return getRelayWebSocketUrl({ wsPort: wsPort || knownScorerWsPort })
}

/** Tests only: forget the remembered WS port. */
export function resetScorerRelayUrl() {
  knownScorerWsPort = null
}

/**
 * PINs go to the relay with the first sync of a match key on a socket and when
 * one changed; the relay keeps the stored ones meanwhile. Keyed by socket AND
 * key: a match that just got its seed key (a new relay room) proves it with its
 * PINs; a PIN-less first sync would have left that room without them. Any relay
 * error about the match (a refusal, a lost room, 'pins-required') makes the
 * next sync carry them again.
 */
export function createRelayPinTracker() {
  let sent = { ws: null, key: null, signature: null }
  return {
    /**
     * The match object for a sync of `key` on `ws`. Call commit() once it was sent.
     * `mark`: the live-state order's mark() taken before the sync read IndexedDB.
     * @returns {{ match: object, commit: () => void }}
     */
    payloadFor(ws, match, key = null, mark = null) {
      const same = sent.ws === ws && sent.key === key
      const { match: out, pinSignature } = relayMatchPayload(match, same ? sent.signature : null, { mark })
      return { match: out, commit: () => { sent = { ws, key, signature: pinSignature } } }
    },
    reset() {
      sent = { ws: null, key: null, signature: null }
    }
  }
}

const WS_CONNECTING = 0
const WS_OPEN = 1
const isRelayRequest = (message) => typeof message?.type === 'string' && message.type.endsWith('-request')

/**
 * The scorer's ONE relay connection. App.jsx (the current match, in every
 * view) and Scoreboard.jsx (every scoring action) both attach to it. They used
 * to open a socket each: the relay grants the scoreboard role per socket, so
 * the two proved the same match over and over (one sent PINs, the other left
 * them out) and the refusals counted toward the relay's per-IP claim limit,
 * which every scorer behind the venue's NAT shares. One socket is one owner.
 *
 * - attach(url, { onOpen(socket), onMessage(message, socket) }) -> detach().
 *   onOpen runs on every (re)connect, and right away when the socket is
 *   already open. Relay requests ('*-request') go to the most recently
 *   attached user only, so each gets one answer; everything else goes to all.
 * - The socket closes once the last user detached (not in between: an effect
 *   re-run detaches and attaches again in the same commit).
 * - Reconnects with relayReconnectDelay; at once when the device is back
 *   online or the tab visible again, and when a ping gets no answer (a
 *   half-open socket on venue Wi-Fi without uplink otherwise stays OPEN).
 * - `pins` is the connection's PIN tracker (createRelayPinTracker).
 */
export function createScorerRelay({
  createSocket = (url) => new WebSocket(url),
  reconnectDelay = (attempt) => relayReconnectDelay(attempt),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  events = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null,
  pingIntervalMs = 25000,
  pongTimeoutMs = 10000
} = {}) {
  const users = []
  const pins = createRelayPinTracker()
  let url = null
  let ws = null
  let attempt = 0
  let reconnectTimer = null
  let closeTimer = null
  let pingTimer = null
  let pongTimer = null
  let lastMessageAt = 0
  let listening = false

  const safe = (fn) => {
    try { fn() } catch (err) { console.error('[ScorerRelay] handler failed:', err) }
  }
  const isOpen = () => !!ws && ws.readyState === WS_OPEN

  function stopPing() {
    if (pingTimer) clearTimer(pingTimer)
    if (pongTimer) clearTimer(pongTimer)
    pingTimer = null
    pongTimer = null
  }

  function drop(socket, code, reason) {
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = () => {}
    try {
      if (socket.readyState === WS_OPEN) socket.close(code, reason)
      // Closing a socket that is still connecting logs a browser error: close it once open
      else if (socket.readyState === WS_CONNECTING) socket.onopen = () => { try { socket.close(code, reason) } catch { /* gone */ } }
    } catch { /* already gone */ }
  }

  function scheduleReconnect(delay = null) {
    if (users.length === 0 || reconnectTimer) return
    reconnectTimer = setTimer(connect, delay ?? reconnectDelay(attempt))
    attempt += 1
  }

  function ping() {
    pingTimer = null
    const socket = ws
    if (!socket || socket.readyState !== WS_OPEN) return
    const sentAt = Date.now()
    try { socket.send(JSON.stringify({ type: 'ping', timestamp: sentAt })) } catch { /* closing */ }
    pongTimer = setTimer(() => {
      pongTimer = null
      if (ws !== socket) return
      if (lastMessageAt >= sentAt) {
        pingTimer = setTimer(ping, pingIntervalMs)
        return
      }
      // No answer: dead, even though it still says OPEN
      ws = null
      drop(socket, 4000, 'No answer to ping')
      scheduleReconnect(0)
    }, pongTimeoutMs)
  }

  function connect() {
    reconnectTimer = null
    if (!url || users.length === 0) return
    if (ws && (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING)) return
    let socket
    try {
      socket = createSocket(url)
    } catch (err) {
      console.error('[ScorerRelay] connection error:', err)
      scheduleReconnect()
      return
    }
    ws = socket
    socket.onerror = () => { /* onclose follows */ }
    socket.onopen = () => {
      if (ws !== socket) return
      attempt = 0
      lastMessageAt = Date.now()
      stopPing()
      pingTimer = setTimer(ping, pingIntervalMs)
      for (const user of [...users]) safe(() => user.onOpen?.(socket))
    }
    socket.onmessage = (event) => {
      if (ws !== socket) return
      lastMessageAt = Date.now()
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (!message || typeof message !== 'object') return
      const targets = isRelayRequest(message) ? users.slice(-1) : [...users]
      for (const user of targets) safe(() => user.onMessage?.(message, socket))
    }
    socket.onclose = () => {
      if (ws !== socket) return
      ws = null
      stopPing()
      scheduleReconnect()
    }
  }

  // Back online / tab visible again: reconnect now instead of after the backoff
  function reconnectNow() {
    if (users.length === 0) return
    if (doc && doc.visibilityState === 'hidden') return
    if (ws && (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING)) return
    if (reconnectTimer) {
      clearTimer(reconnectTimer)
      reconnectTimer = null
    }
    connect()
  }

  function listen(on) {
    if (on === listening) return
    listening = on
    const method = on ? 'addEventListener' : 'removeEventListener'
    events?.[method]?.('online', reconnectNow)
    doc?.[method]?.('visibilitychange', reconnectNow)
  }

  function shutdown() {
    closeTimer = null
    if (users.length > 0) return
    listen(false)
    stopPing()
    if (reconnectTimer) clearTimer(reconnectTimer)
    reconnectTimer = null
    attempt = 0
    if (ws) {
      const socket = ws
      ws = null
      drop(socket, 1000, 'Scorer left the match')
    }
    url = null
    pins.reset()
  }

  return {
    get socket() { return ws },
    /** The relay URL the connection is attached to (null when detached). */
    get url() { return url },
    get userCount() { return users.length },
    pins,
    isOpen,
    reconnectNow,
    /** Send on the open socket; false when there is none. */
    send(payload) {
      if (!isOpen()) return false
      try {
        ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
        return true
      } catch {
        return false
      }
    },
    attach(nextUrl, user = {}) {
      if (!nextUrl) return () => {}
      if (closeTimer) {
        clearTimer(closeTimer)
        closeTimer = null
      }
      const entry = { onOpen: user.onOpen, onMessage: user.onMessage }
      users.push(entry)
      listen(true)
      if (url !== nextUrl) {
        // Another relay (the LAN server's WS port is known now, ?server= changed)
        url = nextUrl
        if (ws) {
          const old = ws
          ws = null
          stopPing()
          drop(old, 1000, 'Relay changed')
        }
        if (reconnectTimer) clearTimer(reconnectTimer)
        reconnectTimer = null
        attempt = 0
        pins.reset()
        connect()
      } else if (isOpen()) {
        const socket = ws
        Promise.resolve().then(() => {
          if (users.includes(entry) && ws === socket) safe(() => entry.onOpen?.(socket))
        })
      } else if (!ws && !reconnectTimer) {
        connect()
      }
      return () => {
        const i = users.indexOf(entry)
        if (i === -1) return
        users.splice(i, 1)
        if (users.length === 0 && !closeTimer) closeTimer = setTimer(shutdown, 0)
      }
    }
  }
}

/**
 * True for a relay `error` message about this match: it names one of `ids`
 * (the relay key or the local id), or names none at all.
 */
export function isRelayErrorFor(message, ids) {
  if (!message || message.type !== 'error') return false
  if (message.matchId === undefined || message.matchId === null) return true
  const id = String(message.matchId)
  return ids.some((k) => k !== undefined && k !== null && String(k) === id)
}

/**
 * Orders the live-state of one scorer. Each snapshot takes a sequence number
 * when it is computed (next()), not a wall-clock time: a clock stepped back by
 * NTP must not freeze the referee and the livescore.
 * - shouldPush(seq): the relay push of a snapshot older than one already pushed
 *   is dropped (on a side-out the 'point' snapshot from before the rotation and
 *   the 'rotation' one race);
 * - write(seq, fn): match_live_state upserts run one at a time, and one older
 *   than the last written is skipped (concurrent upserts are last-write-wins).
 * - session: a random id of this order. The tablets compare sequence numbers
 *   only within one session (a reload starts again at 1).
 * - mark(): what a relay sync records BEFORE it reads IndexedDB ({ seq, session,
 *   at }): the last sequence number issued and the time. A live state with a
 *   higher number than a bundle's _syncedSeq was computed after the bundle was
 *   read, so its score wins over the bundle's (serverDataSync.applyNewerLiveState).
 */
export function createLiveStateOrder({ session = newLiveSession(), now = () => Date.now() } = {}) {
  let seq = 0
  let lastPushed = 0
  let lastWritten = 0
  let chain = Promise.resolve()
  return {
    session,
    next() {
      seq += 1
      return seq
    },
    current() {
      return seq
    },
    mark() {
      return { seq, session, at: now() }
    },
    shouldPush(n) {
      if (n < lastPushed) return false
      lastPushed = n
      return true
    },
    /** @returns {Promise<any>} fn's result, or { skipped: true } */
    write(n, fn) {
      const run = async () => {
        if (n < lastWritten) return { skipped: true }
        lastWritten = n
        return fn()
      }
      const pending = chain.then(run, run)
      chain = pending.catch(() => {})
      return pending
    }
  }
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

/**
 * Where a live-state snapshot of the scorer goes. The relay gets it under the
 * match's room key (the referee, the livescore and the LedBox bridge follow
 * it); the database (match_live_state) only for an official match. A test
 * (rehearsal) match stays out of the cloud: its live state goes to a local
 * relay only (isLocalRelayUrl), so the LedBox can be rehearsed in the hall.
 * @param {{ isTest?: boolean, relayKey?: string|null, relayUrl?: string|null }} args
 * @returns {{ relay: boolean, cloud: boolean }}
 */
export function liveStateTargets({ isTest = false, relayKey = null, relayUrl = null } = {}) {
  return {
    relay: !!relayKey && (!isTest || isLocalRelayUrl(relayUrl)),
    cloud: !isTest
  }
}

/**
 * Publishes one live-state snapshot along liveStateTargets: the relay push
 * first (so an offline hall or a slow cloud never holds up the referee and
 * the LedBox), then the cloud work (lookup, upsert, retry marks), which runs
 * only when `targets.cloud`. Everything that touches the cloud goes in
 * `toCloud`: a test (rehearsal) match never reaches it.
 * @param {{ targets: { relay: boolean, cloud: boolean }, toRelay: () => void, toCloud: () => Promise<any> }} args
 * @returns {Promise<any>} what `toCloud` returned, or undefined when skipped
 */
export async function publishLiveState({ targets, toRelay, toCloud }) {
  if (targets?.relay) toRelay()
  if (!targets?.cloud) return undefined
  return toCloud()
}

export const RELAY_RECONNECT_BASE_MS = 5000
export const RELAY_RECONNECT_MAX_MS = 60000

/**
 * Delay before reconnect attempt `attempt` (0 = first after a drop): 5 s,
 * 10 s, 20 s, 40 s, then 60 s. A relay that is not there (offline hall on a
 * cloud build) is not hammered with a new socket every few seconds.
 */
export function relayReconnectDelay(attempt) {
  const n = Math.max(0, Math.min(Number(attempt) || 0, 16))
  return Math.min(RELAY_RECONNECT_BASE_MS * 2 ** n, RELAY_RECONNECT_MAX_MS)
}

/**
 * The relay entry of the scorer's connection status. The scorer's own socket
 * when it is open; otherwise GET /api/server/status (getRelayServerStatus, as
 * the referee and bench apps do), never a throwaway probe socket.
 * @param {{ wsUrl: string|null, ws?: { readyState: number }|null, getStatus?: () => Promise<{ running: boolean }> }} args
 * @returns {Promise<{ status: string, message: string, details?: string }>}
 */
export async function relayConnectionStatus({ wsUrl, ws = null, getStatus = getRelayServerStatus }) {
  if (!wsUrl) {
    return { status: 'not_available', message: 'No WebSocket relay for this page (using local database only)' }
  }
  if (ws && ws.readyState === WS_OPEN) {
    return { status: 'connected', message: 'WebSocket server is reachable (active connection)' }
  }
  const { running } = await getStatus()
  if (running) {
    return { status: 'connected', message: 'WebSocket server is reachable', details: `Relay: ${wsUrl}` }
  }
  if (ws && ws.readyState === WS_CONNECTING) {
    return { status: 'connecting', message: 'Connecting to the WebSocket server...' }
  }
  return {
    status: 'disconnected',
    message: 'Not connected to the WebSocket server (retrying in the background)',
    details: `Relay: ${wsUrl}`
  }
}

function newLiveSession() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* insecure context */ }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

/** The scorer page's relay connection, shared by App.jsx and Scoreboard.jsx. */
export const scorerRelay = createScorerRelay()

/**
 * The scorer page's live-state order, shared by App.jsx (its relay syncs mark
 * it) and Scoreboard.jsx (every live state takes a number). One per page load,
 * so the numbers keep rising across Scoreboard remounts.
 */
export const scorerLiveOrder = createLiveStateOrder()
