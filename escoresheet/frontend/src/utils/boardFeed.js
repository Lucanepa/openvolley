/**
 * The scoreboard page's feed (/board, components/board/BoardApp): one match,
 * named by a scoreboard code or a league game number, as a board view.
 *
 * Code (docs/scoreboard-code-spec.md §3): one WebSocket to the relay the
 * livescore uses (relayLivescoreWsUrl: the LAN relay that served the page, a
 * ?server= choice, else the cloud). On open it sends
 *   { type: 'subscribe-match', code, device: 'display' }
 * never a PIN and never a matchId; the relay answers `display-code`:
 *   ok:true, matchId, endsAt          follow that room (the relay subscribed
 *                                     the socket: match-full-data, every
 *                                     live-state-update, scorer-presence)
 *   ok:false, reason 'not-found'      asked again after 15 s, 30 s, then
 *                                     every 60 s, on the same socket
 *   ok:false, reason 'rate-limited'   asked again after retryAfter s
 *   ok:false, reason 'ended'          the scorer made a new code or stopped
 *                                     sharing: asked again every 60 s
 * Every reconnect sends the code again (the relay resolves it again). The
 * live row is built as the relay livescore builds it (relayLiveRow,
 * newerLiveState, liveStateWithBundleScore, settleLiveChange), so the board
 * shows what the livescore shows. Ping every 25 s, no answer within 10 s
 * means a half-open socket: reconnect (livescoreReconnectDelay). The `online`
 * event and the page becoming visible again reconnect at once.
 *
 * Game number: GET <api>/api/global/live/game/<n> every 5 s (the TV page's
 * endpoint, public), backing off on errors; it has no time-out counts or
 * substitutions (null in the view).
 *
 * The view (onView): see emptyBoardView. Left / right are the sides on court
 * (side_a, like liveScoreboard); a game number's summary has no sides, so
 * home is left there.
 */
import { getApiUrl, getCloudApiUrl } from './backendConfig'
import { relayLiveRow, liveStateWithBundleScore, livescoreReconnectDelay, relayLivescoreWsUrl } from './relayLivescore'
import { newerLiveState, isBundleNewerThanLiveState } from './serverDataSync'
import { liveScoreboard, liveSetNumber, liveBestOf, settleLiveChange } from './livescoreModel'
import { normaliseColour } from './teamColours'
import { formatBoardCode, normalizeBoardCode } from './boardCode'

export * from './boardCode'

/** not-found: asked again after 15 s, 30 s, then every 60 s. */
export const BOARD_NOT_FOUND_RETRY_MS = Object.freeze([15000, 30000, 60000])
/** ended: asked again every 60 s (the scorer may share the match again). */
export const BOARD_ENDED_RETRY_MS = 60000
/** rate-limited without a retryAfter */
export const BOARD_RATE_LIMIT_DEFAULT_S = 60
/** Game number: how often the summary is asked for, and the longest wait after errors. */
export const BOARD_GAME_POLL_MS = 5000
export const BOARD_GAME_MAX_BACKOFF_MS = 60000
/** Substitutions per set (FIVB 15.6) and time-outs per set (15.4), as the board draws them. */
export const BOARD_SUBS_PER_SET = 6
export const BOARD_TIMEOUTS_PER_SET = 2

export const BOARD_STATES = Object.freeze(['connecting', 'not-found', 'ended', 'waiting', 'live', 'rate-limited', 'offline'])

const WS_OPEN = 1
const WS_CONNECTING = 0

const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const countOf = (v) => (Array.isArray(v) ? v.length : num(v))

/**
 * The board view with nothing to show yet.
 *   state         'connecting' | 'not-found' | 'ended' | 'waiting' | 'live' | 'rate-limited' | 'offline'
 *   mode          'code' | 'game'
 *   code          'ABCD-2345' (code mode), else null;  game: '12345' (game mode), else null
 *   left, right   { name, short, color, points, sets, timeoutsUsed, subs, serving } or null
 *                 (timeoutsUsed / subs null when the source does not say)
 *   setResults    [{ set, left, right }] the finished sets
 *   setNumber, bestOf, phase ('play' | 'timeout' | 'set_break' | 'final')
 *   scorerPresent true / false (scorer-presence), null when not known
 *   connected     the socket is open / the last poll answered
 *   retryAfter    seconds (rate-limited), else null;  endsAt: the code's end (ms), else null
 *   updatedAt     the live state's updated_at (or the summary's), else null
 * 'live' keeps the last score on screen while the connection is down
 * (connected false: the page says it reconnects); 'offline' is a lost
 * connection with no score to show.
 */
export function emptyBoardView(target = null, state = 'connecting') {
  return {
    state,
    mode: target?.kind === 'game' ? 'game' : 'code',
    code: target?.kind === 'code' ? formatBoardCode(target.code) || null : null,
    game: target?.kind === 'game' ? String(target.game) : null,
    left: null,
    right: null,
    setResults: [],
    setNumber: null,
    bestOf: null,
    phase: 'play',
    scorerPresent: null,
    connected: false,
    retryAfter: null,
    endsAt: null,
    updatedAt: null
  }
}

/**
 * The score part of the view for a livescore row (relayLiveRow), or null.
 * @param {object|null} row
 */
export function boardScoreFromRow(row) {
  if (!row || typeof row !== 'object') return null
  const sb = liveScoreboard(row)
  const aLeft = (row.side_a || 'left') === 'left'
  // in a set break the board shows the coming set: no time-out taken in it
  // yet (a scorer app up to 26.11.x sent the finished set's, audit LOG-21)
  const inBreak = sb.phase === 'set_break'
  const team = (p) => ({
    short: str(row[`team_${p}_short`]),
    color: normaliseColour(row[`team_${p}_color`]),
    timeoutsUsed: inBreak ? 0 : countOf(row[`timeouts_${p}`]),
    subs: num(row[`subs_count_${p}`])
  })
  const [l, r] = aLeft ? [team('a'), team('b')] : [team('b'), team('a')]
  return {
    left: { name: sb.leftName, ...l, points: sb.leftPoints ?? 0, sets: sb.leftSets ?? 0, serving: sb.servingTeam === 'left' },
    right: { name: sb.rightName, ...r, points: sb.rightPoints ?? 0, sets: sb.rightSets ?? 0, serving: sb.servingTeam === 'right' },
    setResults: sb.setResults.map((s) => ({ set: num(s.set), left: num(s.left) ?? 0, right: num(s.right) ?? 0 })),
    setNumber: liveSetNumber(row),
    bestOf: liveBestOf(row),
    phase: sb.phase,
    updatedAt: row.updated_at || null
  }
}

/**
 * The score part of the view for a court of GET /api/global/live/game/<n>
 * (backend lib/globalLive.js courtSummary), home on the left.
 * @param {object|null} court
 */
export function boardScoreFromCourt(court) {
  if (!court || typeof court !== 'object') return null
  const team = (side) => ({
    name: str(court[side]?.name) || str(court[side]?.short) || (side === 'home' ? 'Home' : 'Away'),
    short: str(court[side]?.short),
    color: normaliseColour(court[side]?.color),
    points: num(court.points?.[side]) ?? 0,
    sets: num(court.setsWon?.[side]) ?? 0,
    timeoutsUsed: null,
    subs: null,
    serving: !court.ended && court.serving === side
  })
  const bestOf = num(court.bestOf) === 3 ? 3 : 5
  const current = num(court.currentSet)
  const phase = court.ended ? 'final' : court.interval ? 'set_break' : court.timeout ? 'timeout' : 'play'
  return {
    left: team('home'),
    right: team('away'),
    setResults: (Array.isArray(court.sets) ? court.sets : []).map((s, i) => ({ set: i + 1, left: num(s?.home) ?? 0, right: num(s?.away) ?? 0 })),
    setNumber: current == null ? null : bestOf === 3 && current === 5 ? 3 : current,
    bestOf,
    phase,
    updatedAt: court.updatedAt || null
  }
}

/** The game-number endpoint: the relay that served the page, else the cloud. */
export function boardGameUrl(game) {
  const path = `/api/global/live/game/${encodeURIComponent(String(game))}`
  return getCloudApiUrl(path) || getApiUrl(path)
}

/**
 * @param {object} opts
 * @param {{kind:'code',code:string}|{kind:'game',game:string}} opts.target
 * @param {(view: object) => void} opts.onView
 */
export function createBoardFeed({
  target,
  onView = () => {},
  getWsUrl = () => relayLivescoreWsUrl(),
  createSocket = (url) => new WebSocket(url),
  fetchImpl = typeof fetch === 'function' ? (...a) => fetch(...a) : null,
  gameUrl = boardGameUrl,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  now = () => Date.now(),
  pingMs = 25000,
  pongTimeoutMs = 10000,
  reconnectDelay = livescoreReconnectDelay,
  gamePollMs = BOARD_GAME_POLL_MS,
  events = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null
}) {
  const code = target?.kind === 'code' ? normalizeBoardCode(target.code) : null
  const game = target?.kind === 'game' ? String(target.game) : null
  let stopped = true
  let view = emptyBoardView(target)

  // ── shared ──
  let connected = false
  let everOpened = false
  let score = null // boardScoreFromRow / boardScoreFromCourt
  let answer = 'pending' // code: 'pending' | 'found' | 'not-found' | 'ended' | 'rate-limited'; game: 'pending' | 'found' | 'not-found' | 'rate-limited'
  let retryAfter = null
  let endsAt = null
  let scorerPresent = null

  function compute() {
    let state
    if (score) state = 'live'
    else if (!connected) state = everOpened ? 'offline' : (answer === 'rate-limited' ? 'rate-limited' : 'connecting')
    else if (answer === 'found') state = 'waiting'
    else if (answer === 'pending') state = 'connecting'
    else state = answer
    // A game number answered with nothing live: 'not-found' (the page says it checks again)
    view = {
      ...emptyBoardView(target, state),
      ...(score || {}),
      scorerPresent,
      connected,
      retryAfter: state === 'rate-limited' ? retryAfter : null,
      endsAt
    }
    return view
  }
  const emit = () => {
    const v = compute()
    try { onView(v) } catch (err) { console.error('[BoardFeed] onView failed:', err) }
  }

  // ── code mode ──
  let ws = null
  let attempt = 0
  let reconnectTimer = null
  let retryTimer = null
  let pingTimer = null
  let pongTimer = null
  let lastMessageAt = 0
  let notFoundCount = 0
  let followedId = null
  let entry = null // { match, homeTeam, sets, liveState, row }

  const send = (msg) => {
    if (!ws || ws.readyState !== WS_OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }
  // The code only: never a PIN, never a matchId
  const subscribe = () => send({ type: 'subscribe-match', code, device: 'display' })

  function clearRetry() {
    if (retryTimer) clearTimer(retryTimer)
    retryTimer = null
  }
  function retryIn(ms) {
    clearRetry()
    retryTimer = setTimer(() => {
      retryTimer = null
      if (!stopped) subscribe()
    }, ms)
  }
  function unfollow() {
    followedId = null
    entry = null
    score = null
    scorerPresent = null
    endsAt = null
  }

  function rebuildRow() {
    const next = relayLiveRow(followedId, entry)
    if (!next || !entry.row) {
      entry.row = next
    } else {
      const settled = settleLiveChange([entry.row], { eventType: 'UPDATE', new: next }, now())
      if (settled) entry.row = settled.new
    }
    score = boardScoreFromRow(entry.row)
  }

  function onDisplayCode(message) {
    if (message.ok === true && message.matchId != null) {
      const id = String(message.matchId)
      if (id !== followedId) {
        unfollow()
        followedId = id
        entry = { match: null, homeTeam: null, sets: [], liveState: null, row: null }
      }
      answer = 'found'
      notFoundCount = 0
      endsAt = num(message.endsAt)
      clearRetry()
      return
    }
    const reason = message.reason
    if (reason === 'rate-limited') {
      retryAfter = Math.max(1, num(message.retryAfter) ?? BOARD_RATE_LIMIT_DEFAULT_S)
      answer = 'rate-limited'
      retryIn(retryAfter * 1000)
      return
    }
    unfollow()
    if (reason === 'ended') {
      answer = 'ended'
      retryIn(BOARD_ENDED_RETRY_MS)
      return
    }
    // 'not-found' (and any other refusal): the code may not be set yet
    answer = 'not-found'
    retryIn(BOARD_NOT_FOUND_RETRY_MS[Math.min(notFoundCount, BOARD_NOT_FOUND_RETRY_MS.length - 1)])
    notFoundCount += 1
  }

  function onMessage(message) {
    if (!message || typeof message !== 'object') return
    const type = message.type
    if (type === 'display-code') {
      onDisplayCode(message)
      emit()
      return
    }
    // An older relay knows no codes ("Match ID required"): as not found, asked again later
    if (type === 'error' && answer === 'pending') {
      onDisplayCode({ ok: false, reason: 'not-found' })
      emit()
      return
    }
    const id = message.matchId == null ? null : String(message.matchId)
    if (!entry || id !== followedId) return
    if (type === 'match-full-data' || type === 'match-data-update') {
      entry.match = message.match && typeof message.match === 'object' ? message.match : entry.match
      entry.homeTeam = message.homeTeam ?? entry.homeTeam
      entry.sets = Array.isArray(message.sets) ? message.sets : entry.sets
      if (message.liveState && typeof message.liveState === 'object') entry.liveState = newerLiveState(entry.liveState, message.liveState)
      if (entry.liveState && isBundleNewerThanLiveState(entry.liveState, entry)) entry.liveState = liveStateWithBundleScore(entry.liveState, entry)
      if (entry.liveState) rebuildRow()
      emit()
    } else if (type === 'live-state-update') {
      if (!message.liveState || typeof message.liveState !== 'object') return
      const kept = newerLiveState(entry.liveState, message.liveState)
      if (kept === entry.liveState) return
      entry.liveState = kept
      rebuildRow()
      emit()
    } else if (type === 'scorer-presence') {
      scorerPresent = message.present === true
      emit()
    } else if (type === 'match-deleted') {
      unfollow()
      answer = 'ended'
      retryIn(BOARD_ENDED_RETRY_MS)
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
      if (socket.readyState === WS_OPEN) socket.close(1000, 'Board left')
      else if (socket.readyState === WS_CONNECTING) socket.onopen = () => { try { socket.close(1000, 'Board left') } catch { /* gone */ } }
    } catch { /* gone */ }
  }

  function lost() {
    ws = null
    stopPing()
    clearRetry()
    connected = false
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
    const sentAt = now()
    send({ type: 'ping', timestamp: sentAt })
    pongTimer = setTimer(() => {
      pongTimer = null
      if (ws !== socket) return
      if (lastMessageAt >= sentAt) {
        pingTimer = setTimer(ping, pingMs)
        return
      }
      // No answer: a half-open socket (the TV slept, venue Wi-Fi)
      drop(socket)
      lost()
      emit()
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
    if (ws && (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING)) return
    if (!url) {
      if (!everOpened) { everOpened = true; emit() }
      scheduleReconnect()
      return
    }
    let socket
    try {
      socket = createSocket(url)
    } catch (err) {
      console.warn('[BoardFeed] cannot open the relay socket:', err?.message)
      if (!everOpened) { everOpened = true; emit() }
      scheduleReconnect()
      return
    }
    ws = socket
    socket.onerror = () => { /* onclose follows */ }
    socket.onopen = () => {
      if (ws !== socket) return
      attempt = 0
      everOpened = true
      connected = true
      lastMessageAt = now()
      clearRetry()
      subscribe()
      stopPing()
      pingTimer = setTimer(ping, pingMs)
      emit()
    }
    socket.onmessage = (event) => {
      if (ws !== socket) return
      lastMessageAt = now()
      let message
      try { message = JSON.parse(event.data) } catch { return }
      onMessage(message)
    }
    socket.onclose = () => {
      if (ws !== socket) return
      // A socket that never opened: the first try failed, say so
      if (!everOpened) everOpened = true
      lost()
      emit()
      scheduleReconnect()
    }
  }

  // ── game mode ──
  let pollTimer = null
  let polling = false
  let errors = 0

  async function poll() {
    pollTimer = null
    if (stopped || polling) return
    polling = true
    let wait = gamePollMs
    try {
      const url = gameUrl(game)
      if (!url || !fetchImpl) throw new Error('No server')
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      if (stopped) return
      if (res.status === 429) {
        retryAfter = Math.max(1, num(res.headers?.get?.('Retry-After')) ?? BOARD_RATE_LIMIT_DEFAULT_S)
        answer = 'rate-limited'
        connected = true
        everOpened = true
        score = null
        wait = retryAfter * 1000
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      } else {
        const body = await res.json()
        if (stopped) return
        const court = Array.isArray(body?.data?.courts) ? body.data.courts[0] : null
        errors = 0
        connected = true
        everOpened = true
        score = boardScoreFromCourt(court)
        answer = score ? 'found' : 'not-found'
      }
    } catch {
      if (stopped) return
      errors += 1
      connected = false
      everOpened = true
      wait = Math.min(gamePollMs * 2 ** errors, BOARD_GAME_MAX_BACKOFF_MS)
    } finally {
      polling = false
    }
    if (stopped) return
    emit()
    if (!pollTimer) pollTimer = setTimer(poll, wait)
  }

  // ── waking up: the network came back, the screen is shown again ──
  function wake() {
    if (stopped) return
    if (game) {
      if (polling) return
      if (pollTimer) clearTimer(pollTimer)
      pollTimer = null
      void poll()
      return
    }
    if (ws && ws.readyState === WS_OPEN) {
      // Probably fine; ask again so a stale room or code shows at once
      subscribe()
      return
    }
    if (reconnectTimer) clearTimer(reconnectTimer)
    reconnectTimer = null
    attempt = 0
    void connect()
  }
  const onOnline = () => wake()
  const onVisibility = () => { if (doc?.visibilityState === 'visible') wake() }

  return {
    start() {
      if (!stopped || (!code && !game)) return
      stopped = false
      events?.addEventListener?.('online', onOnline)
      doc?.addEventListener?.('visibilitychange', onVisibility)
      emit()
      if (game) void poll()
      else void connect()
    },
    stop() {
      if (stopped) return
      stopped = true
      events?.removeEventListener?.('online', onOnline)
      doc?.removeEventListener?.('visibilitychange', onVisibility)
      if (reconnectTimer) clearTimer(reconnectTimer)
      if (pollTimer) clearTimer(pollTimer)
      reconnectTimer = null
      pollTimer = null
      clearRetry()
      stopPing()
      if (ws) {
        const socket = ws
        ws = null
        drop(socket)
      }
      connected = false
    },
    /** Reconnect / ask again now. */
    wake,
    get view() { return view }
  }
}
