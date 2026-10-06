/**
 * Livescore from a venue relay: the desktop app, the Electron app, the
 * standalone server.js or the venue server, reached on the hall Wi-Fi, the
 * laptop's own Wi-Fi or its Bluetooth network, with no internet.
 *
 * The cloud livescore reads match_live_state (/api/db + the ?purpose=live
 * socket), which no relay has. A relay has every match of the hall instead:
 *   - GET /api/match/list?finished=1  the matches scorers publish there (public
 *     rows: teams, status; finished ones too, so a match that just ended stays);
 *   - one WebSocket, subscribe-match { matchId, device: 'livescore' } per match
 *     and NEVER a PIN: the relay answers with the public summary only
 *     (match-full-data / match-data-update, access 'summary': team names and
 *     colours, status, set scores, the scorer's live state) and every
 *     live-state-update. PINs, rosters, officials, dates of birth, events and
 *     match actions only go to a socket that proved a PIN of the match.
 *
 * Of that, a row keeps only what the livescore shows (relayLiveRow): teams,
 * set scores, the current score, serve, timeouts and status, in the shape of a
 * match_live_state row, so LivescoreApp's model (utils/livescoreModel) works
 * on it unchanged. match_id is the relay key (the match's seed key).
 */
import { getBackendOverride, getLocalServerStatusUrl, getRelayWebSocketUrl, isLanBackendUrl, learnRelayWsPort, relayWsPortFor } from './backendConfig'
import { newerLiveState } from './serverDataSync'
import { settleLiveChange } from './livescoreModel'

/** How often the match list is asked for again (new matches appear). */
export const LIVESCORE_LIST_POLL_MS = 10 * 1000
/** Matches followed at once (a hall has a few courts). */
export const MAX_FOLLOWED_MATCHES = 32

const WS_OPEN = 1
const WS_CONNECTING = 0

/** match_live_state fields the livescore uses (relayLiveRow keeps no others). */
export const LIVESCORE_LIVE_FIELDS = Object.freeze([
  'current_set', 'best_of', 'match_status', 'sport_type',
  'team_a_name', 'team_a_short', 'team_a_color', 'team_b_name', 'team_b_short', 'team_b_color',
  'sets_won_a', 'sets_won_b', 'points_a', 'points_b', 'side_a', 'serving_team',
  'timeouts_a', 'timeouts_b', 'timeout_active', 'set_interval_active',
  'last_event_type', 'last_event_ts', 'updated_at', 'game_n', 'league', 'gender', 'set_results',
  '_seq', '_session'
])

/**
 * Should the livescore read a venue relay instead of the cloud? When its
 * server is one: the page is served by a relay on this machine or the local
 * network (the desktop window at localhost:5173, a tablet at
 * http://<laptop>:5173/livescore on the hall Wi-Fi, the laptop's hotspot or
 * Bluetooth), or the viewer chose a LAN server (Android app, ?server=).
 * A cloud server (*.openvolley.app, a cloud ?server=) keeps the cloud feed.
 * @param {{ servedFromLocalServer?: boolean, origin?: string|null, override?: string|null }} p
 */
export function relayLivescoreMode({ servedFromLocalServer = false, origin = null, override = null } = {}) {
  if (override) return isLanBackendUrl(override)
  return !!servedFromLocalServer && isLanBackendUrl(origin)
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

/**
 * Finished sets of a relay summary ({ index, homePoints|home_points,
 * awayPoints|away_points, finished }) as match set_results [{ set, home, away }].
 * @param {Array<object>} sets
 */
export function setResultsFromSets(sets) {
  if (!Array.isArray(sets)) return []
  return sets
    .filter((s) => s && typeof s === 'object' && s.finished === true && num(s.index) != null)
    .map((s) => ({ set: num(s.index), home: num(s.homePoints ?? s.home_points) ?? 0, away: num(s.awayPoints ?? s.away_points) ?? 0 }))
    .sort((a, b) => a.set - b.set)
}

const pick = (obj, keys) => {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]
  return out
}

const teamName = (team) => {
  const name = typeof team === 'string' ? team : team && typeof team === 'object' ? team.name : null
  return typeof name === 'string' && name.trim() ? name : null
}

/**
 * The livescore row of a followed relay match, or null while the scorer has
 * not pushed a live state yet (nothing to show; the cloud has no row then
 * either) or for a match that is not indoor volleyball.
 * @param {string} matchId  the relay key
 * @param {{ liveState?: object|null, match?: object|null, homeTeam?: object|string|null, sets?: Array<object>, listed?: object|null }} entry
 */
export function relayLiveRow(matchId, entry) {
  const live = entry?.liveState
  if (!live || typeof live !== 'object') return null
  if (live.sport_type != null && live.sport_type !== 'indoor') return null
  const match = entry.match && typeof entry.match === 'object' ? entry.match : {}
  const joined = { set_results: setResultsFromSets(entry.sets) }
  const teamA = match.coinTossTeamA
  if (teamA === 'home' || teamA === 'away') joined.coin_toss = { team_a: teamA }
  const home = teamName(entry.homeTeam) || teamName(match.homeTeamName) || teamName(entry.listed?.homeTeam)
  if (home) joined.home_team = { name: home }
  return {
    ...pick(live, LIVESCORE_LIVE_FIELDS),
    match_id: String(matchId),
    test: match.test === true || entry.listed?.test === true,
    matches: joined
  }
}

/**
 * The relay's match list for the livescore (finished matches included).
 * @param {string|null} listUrl  e.g. getApiUrl('/api/match/list?finished=1')
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ success: boolean, matches: Array<object>, error?: string }>}
 */
export async function fetchRelayLivescoreList(listUrl, fetchImpl = typeof fetch === 'function' ? fetch : null) {
  if (!listUrl || !fetchImpl) return { success: false, matches: [], error: 'No relay' }
  try {
    const res = await fetchImpl(listUrl, { headers: { Accept: 'application/json' } })
    if (!res.ok) return { success: false, matches: [], error: `HTTP ${res.status}` }
    const body = await res.json()
    return { success: body?.success !== false, matches: Array.isArray(body?.matches) ? body.matches : [] }
  } catch (err) {
    return { success: false, matches: [], error: err?.message || 'Network error' }
  }
}

/**
 * The relay WebSocket for the livescore. A page served by the relay asks it
 * for its WS port first (/api/server/status `wsPort`: the desktop app moved
 * off 8080 with OPENVOLLEY_WS_PORT, the venue server's one port); a chosen
 * LAN server (Android app, ?server=) is asked the same once, when its port
 * is not known yet (learnRelayWsPort), and getRelayWebSocketUrl does the rest.
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<string|null>}
 */
export async function relayLivescoreWsUrl({ fetchImpl = typeof fetch === 'function' ? fetch : null } = {}) {
  const override = getBackendOverride()
  if (override) {
    if (fetchImpl && isLanBackendUrl(override) && !relayWsPortFor(override)) await learnRelayWsPort(override, { fetchImpl })
    return getRelayWebSocketUrl()
  }
  const statusUrl = getLocalServerStatusUrl()
  if (statusUrl && fetchImpl) {
    try {
      const res = await fetchImpl(statusUrl)
      const status = res?.ok ? await res.json() : null
      if (status?.wsPort) return getRelayWebSocketUrl({ wsPort: status.wsPort })
    } catch { /* the default port below */ }
  }
  return getRelayWebSocketUrl()
}

/** 5 s, 10 s, 20 s, then 30 s between reconnects. */
export function livescoreReconnectDelay(attempt) {
  const n = Math.max(0, Math.min(Number(attempt) || 0, 8))
  return Math.min(5000 * 2 ** n, 30000)
}

/**
 * The relay livescore feed: one WebSocket, one subscription per listed match.
 *
 * - refresh(): asks for the list (also every `pollMs`), follows new matches.
 *   A match that drops out of the list stays followed until the relay deletes
 *   it (livescoreModel drops stale rows by itself).
 * - onChange(rows): the rows (relayLiveRow) after every change, list order.
 * - onList({ ok, error }): after every list request.
 * - onLive(boolean): the socket is open (true) or down (false).
 * @param {object} opts
 * @param {() => Promise<{success:boolean, matches:Array<object>, error?:string}>} opts.listMatches
 * @param {() => Promise<string|null>|string|null} opts.getWsUrl
 */
export function createRelayLivescoreFeed({
  listMatches,
  getWsUrl,
  onChange = () => {},
  onList = () => {},
  onLive = () => {},
  createSocket = (url) => new WebSocket(url),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  pollMs = LIVESCORE_LIST_POLL_MS,
  pingMs = 25000,
  pongTimeoutMs = 10000,
  reconnectDelay = livescoreReconnectDelay,
  maxFollowed = MAX_FOLLOWED_MATCHES
}) {
  const followed = new Map() // relay key -> { listed, match, homeTeam, sets, liveState, row }
  let ws = null
  let stopped = true
  let attempt = 0
  let reconnectTimer = null
  let pollTimer = null
  let pingTimer = null
  let pongTimer = null
  let lastMessageAt = 0
  let live = false

  const rows = () => [...followed.values()].map((e) => e.row).filter(Boolean)
  const emit = () => { try { onChange(rows()) } catch (err) { console.error('[RelayLivescore] onChange failed:', err) } }
  const setLive = (on) => {
    if (on === live) return
    live = on
    try { onLive(on) } catch { /* ignore */ }
  }

  const send = (msg) => {
    if (!ws || ws.readyState !== WS_OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }
  // Never a PIN: the relay then sends the public summary only
  const subscribe = (id) => send({ type: 'subscribe-match', matchId: id, device: 'livescore' })

  function follow(listed) {
    const id = listed?.id == null ? null : String(listed.id)
    if (!id) return false
    const known = followed.get(id)
    if (known) {
      known.listed = listed
      return false
    }
    while (followed.size >= maxFollowed) {
      const oldest = followed.keys().next().value
      followed.delete(oldest)
      send({ type: 'unsubscribe-match', matchId: oldest })
    }
    followed.set(id, { listed, match: null, homeTeam: null, sets: [], liveState: null, row: null })
    subscribe(id)
    return true
  }

  /** Recompute a followed match's row; the ended set_end frame keeps the last set's layout. */
  function update(id) {
    const entry = followed.get(id)
    if (!entry) return
    const next = relayLiveRow(id, entry)
    if (!next || !entry.row) {
      entry.row = next
      return
    }
    const settled = settleLiveChange([entry.row], { eventType: 'UPDATE', new: next })
    if (settled) entry.row = settled.new
  }

  function onMessage(message) {
    if (!message || typeof message !== 'object') return
    const id = message.matchId == null ? null : String(message.matchId)
    const entry = id ? followed.get(id) : null
    if (message.type === 'match-full-data' || message.type === 'match-data-update') {
      if (!entry) return
      entry.match = message.match && typeof message.match === 'object' ? message.match : entry.match
      entry.homeTeam = message.homeTeam ?? entry.homeTeam
      entry.sets = Array.isArray(message.sets) ? message.sets : entry.sets
      if (message.liveState && typeof message.liveState === 'object') entry.liveState = newerLiveState(entry.liveState, message.liveState)
      update(id)
      emit()
    } else if (message.type === 'live-state-update') {
      if (!entry || !message.liveState || typeof message.liveState !== 'object') return
      const kept = newerLiveState(entry.liveState, message.liveState)
      if (kept === entry.liveState) return
      entry.liveState = kept
      update(id)
      emit()
    } else if (message.type === 'match-deleted') {
      if (!entry) return
      followed.delete(id)
      emit()
    }
  }

  function stopPing() {
    if (pingTimer) clearTimer(pingTimer)
    if (pongTimer) clearTimer(pongTimer)
    pingTimer = null
    pongTimer = null
  }

  function drop(socket) {
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = () => {}
    try {
      if (socket.readyState === WS_OPEN) socket.close(1000, 'Livescore left')
      else if (socket.readyState === WS_CONNECTING) socket.onopen = () => { try { socket.close(1000, 'Livescore left') } catch { /* gone */ } }
    } catch { /* gone */ }
  }

  function scheduleReconnect(delay = null) {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimer(connect, delay ?? reconnectDelay(attempt))
    attempt += 1
  }

  function ping() {
    pingTimer = null
    const socket = ws
    if (!socket || socket.readyState !== WS_OPEN) return
    const sentAt = Date.now()
    send({ type: 'ping', timestamp: sentAt })
    pongTimer = setTimer(() => {
      pongTimer = null
      if (ws !== socket) return
      if (lastMessageAt >= sentAt) {
        pingTimer = setTimer(ping, pingMs)
        return
      }
      // No answer: a half-open socket on venue Wi-Fi
      ws = null
      drop(socket)
      setLive(false)
      scheduleReconnect(0)
    }, pongTimeoutMs)
  }

  async function connect() {
    reconnectTimer = null
    if (stopped) return
    if (ws && (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING)) return
    let url = null
    try { url = await getWsUrl() } catch { url = null }
    if (stopped) return
    if (!url) {
      scheduleReconnect()
      return
    }
    let socket
    try {
      socket = createSocket(url)
    } catch (err) {
      console.warn('[RelayLivescore] cannot open the relay socket:', err?.message)
      scheduleReconnect()
      return
    }
    ws = socket
    socket.onerror = () => { /* onclose follows */ }
    socket.onopen = () => {
      if (ws !== socket) return
      attempt = 0
      lastMessageAt = Date.now()
      setLive(true)
      for (const id of followed.keys()) subscribe(id)
      stopPing()
      pingTimer = setTimer(ping, pingMs)
      // Whatever started while the socket was down
      void refresh()
    }
    socket.onmessage = (event) => {
      if (ws !== socket) return
      lastMessageAt = Date.now()
      let message
      try { message = JSON.parse(event.data) } catch { return }
      onMessage(message)
    }
    socket.onclose = () => {
      if (ws !== socket) return
      ws = null
      stopPing()
      setLive(false)
      scheduleReconnect()
    }
  }

  async function refresh() {
    let result
    try {
      result = await listMatches()
    } catch (err) {
      result = { success: false, matches: [], error: err?.message }
    }
    if (stopped) return { ok: false, error: 'stopped' }
    const ok = !!result?.success
    if (ok) {
      let added = false
      for (const m of result.matches || []) if (follow(m)) added = true
      if (added) emit()
    }
    const outcome = ok ? { ok: true } : { ok: false, error: result?.error || 'The relay did not answer' }
    try { onList(outcome) } catch { /* ignore */ }
    return outcome
  }

  function poll() {
    pollTimer = null
    if (stopped) return
    void refresh().finally(() => {
      if (!stopped && !pollTimer) pollTimer = setTimer(poll, pollMs)
    })
  }

  return {
    /** Connect and list (the first list right away, then every pollMs). */
    start() {
      if (!stopped) return
      stopped = false
      poll()
      void connect()
    },
    stop() {
      stopped = true
      if (reconnectTimer) clearTimer(reconnectTimer)
      if (pollTimer) clearTimer(pollTimer)
      reconnectTimer = null
      pollTimer = null
      stopPing()
      if (ws) {
        const socket = ws
        ws = null
        drop(socket)
      }
      setLive(false)
    },
    /** Ask for the list now. */
    refresh,
    /** The rows now (as onChange last had them). */
    rows,
    get live() { return live }
  }
}
