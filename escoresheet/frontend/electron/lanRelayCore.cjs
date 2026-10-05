'use strict'
/**
 * lanRelayCore — the ONE implementation of the LAN relay wire protocol and the
 * relay-owned /api/match/* endpoints, shared by every Node relay runtime:
 *   - ../server.js                 standalone / Pi LAN server (`npm start`)
 *   - ../vite-plugin-api-routes.js Vite dev-server replica
 *   - ./relayServer.js             in-process Electron relay
 * src-tauri/src/relay.rs is a Rust port of the same protocol, and the cloud /
 * SEA backend (backend/server.js) speaks the same client-facing messages.
 * Change the protocol here and mirror it there.
 *
 * It lives in electron/ as dependency-free CommonJS so the packaged Electron
 * app (which ships only dist/ and electron/) can require() it; the ESM relays
 * import it through ../lanRelayCore.js. Do not require() anything here: the Vite
 * config bundler turns this file into ESM, where a bare require() throws.
 *
 * Client -> relay
 *   sync-match-data   { matchId, match, homeTeam, awayTeam, homePlayers, awayPlayers,
 *                       sets, events, _timestamp }  (or { matchId, matchData: {...} })
 *                     Proves the scoreboard role for matchId: accepted when the match is
 *                     new to the relay or its gamePin equals the stored match's gamePin.
 *                     Otherwise { type:'error', code:'not-match-owner' }.
 *   match-action      { matchId, action, data, timestamp }   proven scoreboard of matchId only
 *   live-state-update { matchId, liveState }                 proven scoreboard of matchId only
 *   delete-match      { matchId }                            proven scoreboard of matchId only
 *   clear-all-matches { keepMatchId? }   removes only matches THIS socket proved
 *   subscribe-match   { matchId }  /  unsubscribe-match { matchId }  /  ping
 *   match-data-response | game-number-response | match-update-response { requestId, ... }
 *                     answers to relay requests; accepted only from the sockets asked.
 * Relay -> client
 *   match-full-data, match-data-update  FLAT bundle: { type, matchId, match, homeTeam, awayTeam,
 *                     homePlayers, awayPlayers, sets, events, liveState?, _timestamp,
 *                     _scoreboardTimestamp }. `match` is always stripped of PINs.
 *   match-action      { type, matchId, action, data, timestamp, _timestamp, _scoreboardTimestamp }
 *   live-state-update { type, matchId, liveState }
 *   match-deleted     { type, matchId }
 *   connected, pong, error { type:'error', code, message, matchId? }
 *   match-data-request | game-number-request | match-update-request  (proven scoreboards only)
 *
 * Match ids are always String(matchId). PINs never leave the relay: PIN
 * validation is answered from the relay's own store, never by a WS client.
 */

// Secret fields on a match object that must never be returned to a client.
// PINs are the connection gate for referee/bench, so they are stripped from
// every match-returning response and every WS message.
const MATCH_SECRET_FIELDS = [
  'refereePin', 'homeTeamPin', 'awayTeamPin',
  'homeTeamUploadPin', 'awayTeamUploadPin',
  'connection_pins', 'connectionPins', 'game_pin', 'gamePin',
]

const WS_MAX_PAYLOAD = 10 * 1024 * 1024 // same cap as the cloud relay
const MAX_BODY_SIZE = 1024 * 1024
const MAX_MATCH_ID_LENGTH = 128

// PIN types accepted by POST /api/match/validate-pin
const PIN_TYPES = {
  referee: { pin: 'refereePin', enabled: 'refereeConnectionEnabled' },
  homeTeam: { pin: 'homeTeamPin', enabled: 'homeTeamConnectionEnabled' },
  awayTeam: { pin: 'awayTeamPin', enabled: 'awayTeamConnectionEnabled' },
}

/**
 * Return a shallow copy of a match object with all PIN/secret fields removed.
 * @param {any} match
 */
function stripMatchSecrets(match) {
  if (!match || typeof match !== 'object') return match
  const clean = { ...match }
  for (const k of MATCH_SECRET_FIELDS) delete clean[k]
  return clean
}

/**
 * Strip secrets from a stored match-data bundle ({ match, homeTeam, ... }),
 * redacting the nested `match` object which is where the PINs live.
 * @param {any} matchData
 */
function stripMatchDataSecrets(matchData) {
  if (!matchData || typeof matchData !== 'object') return matchData
  return { ...matchData, match: stripMatchSecrets(matchData.match) }
}

/** Room / store key for a match id: always a string (Dexie ids are numbers). */
function normalizeMatchId(id) {
  if (id === undefined || id === null) return null
  const s = String(id).trim()
  if (!s || s.length > MAX_MATCH_ID_LENGTH) return null
  return s
}

/** The match's game PIN as a comparable string, or null when it has none (test matches). */
function gamePinOf(match) {
  if (!match || typeof match !== 'object') return null
  const v = match.gamePin != null && match.gamePin !== '' ? match.gamePin : match.game_pin
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s ? s : null
}

/** Build the stored bundle from a sync-match-data (flat or { matchData }) message. */
function bundleFromMessage(msg) {
  const src = msg && msg.matchData && typeof msg.matchData === 'object' ? msg.matchData : msg
  if (!src || !src.match || typeof src.match !== 'object') return null
  return {
    match: src.match,
    homeTeam: src.homeTeam ?? null,
    awayTeam: src.awayTeam ?? null,
    homePlayers: Array.isArray(src.homePlayers) ? src.homePlayers : [],
    awayPlayers: Array.isArray(src.awayPlayers) ? src.awayPlayers : [],
    sets: Array.isArray(src.sets) ? src.sets : [],
    events: Array.isArray(src.events) ? src.events : [],
  }
}

/** The PIN-free bundle fields every match-data message and HTTP response carries. */
function toWireBundle(bundle) {
  const out = {
    match: stripMatchSecrets(bundle.match),
    homeTeam: bundle.homeTeam ?? null,
    awayTeam: bundle.awayTeam ?? null,
    homePlayers: bundle.homePlayers || [],
    awayPlayers: bundle.awayPlayers || [],
    sets: bundle.sets || [],
    events: bundle.events || [],
  }
  if (bundle.liveState !== undefined) out.liveState = bundle.liveState
  return out
}

/** Numeric ids stay numbers in HTTP responses (clients compare them to Dexie ids). */
function publicMatchId(key) {
  return /^\d+$/.test(key) ? Number(key) : key
}

function formatDateTime(scheduledAt) {
  if (!scheduledAt) return 'TBD'
  try {
    const d = new Date(scheduledAt)
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    return `${dateStr} ${timeStr}`
  } catch {
    return 'TBD'
  }
}

/**
 * Fixed-window per-key rate limiter. The cleanup timer is unref'd so it never
 * keeps a process (e.g. `vite build`) alive.
 */
function createRateLimiter({ windowMs = 60 * 1000, max = 10 } = {}) {
  const entries = new Map()
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, e] of entries) if (now - e.windowStart > windowMs * 2) entries.delete(key)
  }, 5 * 60 * 1000)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return function isRateLimited(key, limit = max) {
    const now = Date.now()
    const e = entries.get(key)
    if (!e || now - e.windowStart > windowMs) {
      entries.set(key, { count: 1, windowStart: now })
      return false
    }
    e.count++
    return e.count > limit
  }
}

/**
 * Create one relay instance (state + WS protocol + HTTP API).
 * @param {{ log?: Console, requestTimeoutMs?: number, isRateLimited?: Function }} [options]
 */
function createLanRelay(options = {}) {
  const log = options.log || console
  const requestTimeoutMs = options.requestTimeoutMs || 5000
  const isRateLimited = options.isRateLimited || createRateLimiter()

  const store = new Map() // matchId -> bundle (unstripped: the PINs live only here)
  const subscriptions = new Map() // matchId -> Set<ws>
  const clients = new Map() // ws -> { id, ip, role, connectedAt, owned:Set, subscribed:Set }
  const pending = new Map() // requestId -> { type, matchId, targets:Set<ws>, resolve, timer }
  let nextClientId = 1

  function send(ws, msg) {
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch (err) {
      log.error('[Relay] send failed:', err && err.message)
      return false
    }
  }

  function sendError(ws, code, message, matchId) {
    send(ws, matchId ? { type: 'error', code, message, matchId } : { type: 'error', code, message })
  }

  function sendToSubscribers(matchId, msg, excludeWs = null) {
    const subs = subscriptions.get(matchId)
    if (!subs) return 0
    const text = JSON.stringify(msg)
    let sent = 0
    for (const client of subs) {
      if (client === excludeWs || client.readyState !== 1) continue
      try {
        client.send(text)
        sent++
      } catch (err) {
        log.error('[Relay] send to subscriber failed:', err && err.message)
      }
    }
    return sent
  }

  // --- Connection lifecycle -------------------------------------------------

  function addClient(ws, info = {}) {
    const meta = {
      id: `c${nextClientId++}`,
      ip: info.ip || null,
      role: 'subscriber',
      connectedAt: new Date().toISOString(),
      owned: new Set(),
      subscribed: new Set(),
    }
    clients.set(ws, meta)
    send(ws, { type: 'connected', message: 'Connected to eScoresheet WebSocket server', timestamp: Date.now() })
    return meta
  }

  function removeClient(ws) {
    const meta = clients.get(ws)
    if (!meta) return
    for (const id of meta.subscribed) {
      const subs = subscriptions.get(id)
      if (subs) {
        subs.delete(ws)
        if (subs.size === 0) subscriptions.delete(id)
      }
    }
    clients.delete(ws)
    // A scoreboard that disconnects can no longer answer pending requests.
    for (const [requestId, p] of pending) {
      if (p.targets.delete(ws) && p.targets.size === 0) settle(requestId, null)
    }
  }

  // --- Scoreboard ownership -------------------------------------------------

  function isOwner(ws, matchId) {
    const meta = clients.get(ws)
    return !!meta && meta.owned.has(matchId)
  }

  function ownersOf(matchId) {
    const out = []
    for (const [ws, meta] of clients) if (meta.owned.has(matchId)) out.push(ws)
    return out
  }

  function scoreboardSockets() {
    const out = []
    for (const [ws, meta] of clients) if (meta.owned.size > 0 && ws.readyState === 1) out.push(ws)
    return out
  }

  /**
   * Prove the scoreboard role for matchId with the match's own game PIN.
   * - match not on the relay yet: the first scoreboard claims it;
   * - stored match has a game PIN: the incoming match must carry the same one;
   * - stored match has none (test match): any socket may write it, but only a
   *   socket that already owns it may attach a game PIN to it.
   */
  function claim(ws, matchId, incomingMatch) {
    const meta = clients.get(ws)
    if (!meta) return false
    const existing = store.get(matchId)
    if (existing) {
      const storedPin = gamePinOf(existing.match)
      const incomingPin = gamePinOf(incomingMatch)
      if (storedPin !== null) {
        if (incomingPin !== storedPin) return false
      } else if (incomingPin !== null && !meta.owned.has(matchId)) {
        return false
      }
    }
    meta.owned.add(matchId)
    return true
  }

  function storeBundle(matchId, bundle) {
    const prev = store.get(matchId)
    // A sync carries no liveState; keep the last one the scoreboard pushed.
    const next = prev && prev.liveState !== undefined && bundle.liveState === undefined
      ? { ...bundle, liveState: prev.liveState }
      : bundle
    store.set(matchId, next)
    return next
  }

  function deleteMatch(matchId) {
    // Read the subscribers BEFORE dropping them, so they actually get told.
    sendToSubscribers(matchId, { type: 'match-deleted', matchId })
    const subs = subscriptions.get(matchId)
    if (subs) for (const ws of subs) clients.get(ws)?.subscribed.delete(matchId)
    subscriptions.delete(matchId)
    store.delete(matchId)
    for (const meta of clients.values()) meta.owned.delete(matchId)
  }

  // --- Relay -> scoreboard requests ----------------------------------------

  function settle(requestId, result) {
    const p = pending.get(requestId)
    if (!p) return
    pending.delete(requestId)
    clearTimeout(p.timer)
    p.resolve(result)
  }

  /** Ask the connected (proven) scoreboards; resolves null on timeout / no answer. */
  function requestFromScoreboards(type, payload, matchId = null) {
    const targets = new Set(scoreboardSockets())
    if (targets.size === 0) return Promise.resolve(null)
    const requestId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(requestId, null), requestTimeoutMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
      pending.set(requestId, { type, matchId, targets, resolve, timer })
      for (const ws of targets) send(ws, { type, requestId, ...payload })
    })
  }

  /** One scoreboard said "not me": wait for the others, give up when none are left. */
  function declineRequest(requestId, ws) {
    const p = pending.get(requestId)
    if (!p) return
    p.targets.delete(ws)
    if (p.targets.size === 0) settle(requestId, null)
  }

  function onResponse(ws, msg) {
    const p = pending.get(msg.requestId)
    // Only the scoreboards the relay asked may answer, and only the matching type.
    if (!p || !p.targets.has(ws) || `${p.type.replace(/-request$/, '')}-response` !== msg.type) return

    if (msg.type === 'match-data-response') {
      const bundle = bundleFromMessage({ matchData: msg.data ?? msg.matchData })
      const id = normalizeMatchId(msg.matchId) ?? p.matchId
      if (!msg.success || !bundle || id !== p.matchId || !claim(ws, id, bundle.match)) {
        declineRequest(msg.requestId, ws)
        return
      }
      settle(msg.requestId, storeBundle(id, bundle))
    } else if (msg.type === 'game-number-response') {
      const id = normalizeMatchId(msg.matchId)
      if (!msg.success || !msg.match || !id || !isOwner(ws, id)) {
        declineRequest(msg.requestId, ws)
        return
      }
      settle(msg.requestId, { match: msg.match, matchId: id })
    } else if (msg.type === 'match-update-response') {
      if (!msg.success) {
        declineRequest(msg.requestId, ws)
        return
      }
      const bundle = bundleFromMessage({ matchData: msg.data })
      const id = normalizeMatchId(msg.matchId) ?? p.matchId
      if (bundle && id === p.matchId && claim(ws, id, bundle.match)) {
        const stored = storeBundle(id, bundle)
        const now = Date.now()
        sendToSubscribers(id, { type: 'match-data-update', matchId: id, ...toWireBundle(stored), _timestamp: now, _scoreboardTimestamp: now }, ws)
        settle(msg.requestId, { data: stored })
      } else {
        settle(msg.requestId, { data: null })
      }
    }
  }

  // --- WS message handlers ---------------------------------------------------

  function onSync(ws, msg) {
    const matchId = normalizeMatchId(msg.matchId)
    const bundle = bundleFromMessage(msg)
    if (!matchId || !bundle) {
      sendError(ws, 'bad-request', 'sync-match-data needs matchId and match')
      return
    }
    if (!claim(ws, matchId, bundle.match)) {
      sendError(ws, 'not-match-owner', 'Match is owned by another scoreboard (game PIN mismatch)', matchId)
      return
    }
    const stored = storeBundle(matchId, bundle)
    const now = Date.now()
    sendToSubscribers(matchId, {
      type: 'match-data-update',
      matchId,
      ...toWireBundle(stored),
      _timestamp: now,
      _scoreboardTimestamp: msg._timestamp || now,
    }, ws)
  }

  function onSubscribe(ws, msg) {
    const matchId = normalizeMatchId(msg.matchId)
    if (!matchId) {
      sendError(ws, 'bad-request', 'subscribe-match needs matchId')
      return
    }
    const meta = clients.get(ws)
    if (!subscriptions.has(matchId)) subscriptions.set(matchId, new Set())
    subscriptions.get(matchId).add(ws)
    if (meta) {
      meta.subscribed.add(matchId)
      if (['referee', 'bench', 'livescore'].includes(msg.role)) meta.role = msg.role
    }
    const stored = store.get(matchId)
    if (stored) {
      const now = Date.now()
      send(ws, { type: 'match-full-data', matchId, ...toWireBundle(stored), _timestamp: now, _scoreboardTimestamp: now })
    }
  }

  function onUnsubscribe(ws, msg) {
    const matchId = normalizeMatchId(msg.matchId)
    if (!matchId) return
    const subs = subscriptions.get(matchId)
    if (subs) {
      subs.delete(ws)
      if (subs.size === 0) subscriptions.delete(matchId)
    }
    clients.get(ws)?.subscribed.delete(matchId)
  }

  function requireOwner(ws, matchId, what) {
    if (!matchId) {
      sendError(ws, 'bad-request', `${what} needs matchId`)
      return false
    }
    if (!isOwner(ws, matchId)) {
      sendError(ws, 'not-match-owner', `Only the match's scoreboard may send ${what}`, matchId)
      return false
    }
    return true
  }

  function onMatchAction(ws, msg) {
    const matchId = normalizeMatchId(msg.matchId)
    if (!requireOwner(ws, matchId, 'match-action')) return
    if (!msg.action || typeof msg.action !== 'string') {
      sendError(ws, 'bad-request', 'match-action needs action', matchId)
      return
    }
    const now = Date.now()
    sendToSubscribers(matchId, {
      type: 'match-action',
      matchId,
      action: msg.action,
      // Scoreboard sends the payload as `data`; `actionData` is the legacy name.
      data: msg.data !== undefined ? msg.data : msg.actionData,
      timestamp: msg.timestamp,
      _timestamp: now,
      _scoreboardTimestamp: msg._timestamp || msg.timestamp || now,
    }, ws)
  }

  function onLiveState(ws, msg) {
    const matchId = normalizeMatchId(msg.matchId)
    if (!requireOwner(ws, matchId, 'live-state-update')) return
    if (!msg.liveState || typeof msg.liveState !== 'object') return
    const existing = store.get(matchId)
    if (existing) existing.liveState = msg.liveState
    sendToSubscribers(matchId, { type: 'live-state-update', matchId, liveState: msg.liveState }, ws)
  }

  function onDelete(ws, msg) {
    const matchId = normalizeMatchId(msg.matchId)
    if (!requireOwner(ws, matchId, 'delete-match')) return
    deleteMatch(matchId)
  }

  function onClearAll(ws, msg) {
    const meta = clients.get(ws)
    if (!meta || meta.owned.size === 0) {
      sendError(ws, 'not-scoreboard', 'Only a scoreboard that synced its match may clear matches')
      return
    }
    const keep = normalizeMatchId(msg.keepMatchId)
    for (const matchId of [...meta.owned]) {
      if (matchId === keep) continue
      // Another live socket still drives this match: just drop our claim.
      if (ownersOf(matchId).some((other) => other !== ws && other.readyState === 1)) {
        meta.owned.delete(matchId)
      } else {
        deleteMatch(matchId)
      }
    }
  }

  function handleMessage(ws, raw) {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    } catch {
      sendError(ws, 'bad-request', 'Invalid message format')
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (!clients.has(ws)) addClient(ws)

    switch (msg.type) {
      case 'ping': send(ws, { type: 'pong', timestamp: Date.now() }); break
      case 'sync-match-data': onSync(ws, msg); break
      case 'subscribe-match': onSubscribe(ws, msg); break
      case 'unsubscribe-match': onUnsubscribe(ws, msg); break
      case 'match-action': onMatchAction(ws, msg); break
      case 'live-state-update': onLiveState(ws, msg); break
      case 'delete-match': onDelete(ws, msg); break
      case 'clear-all-matches': onClearAll(ws, msg); break
      case 'match-data-response':
      case 'game-number-response':
      case 'match-update-response':
        onResponse(ws, msg)
        break
      // The relay validates PINs itself; answers from clients are ignored.
      case 'pin-validation-response': break
      // No catch-all rebroadcast: unknown types are dropped.
      default: break
    }
  }

  // --- Relay-owned HTTP API -------------------------------------------------

  function validatePin(body) {
    const pinStr = String((body && body.pin) ?? '').trim()
    const cfg = PIN_TYPES[(body && body.type) || 'referee']
    if (pinStr.length !== 6) return { status: 400, body: { success: false, error: 'Invalid PIN format' } }
    if (!cfg) return { status: 400, body: { success: false, error: 'Invalid PIN type' } }
    for (const [key, bundle] of store) {
      const match = bundle.match
      if (!match) continue
      const expected = match[cfg.pin]
      if (expected === undefined || expected === null || String(expected).trim() !== pinStr) continue
      if (match[cfg.enabled] === true && match.status !== 'final') {
        return { status: 200, body: { success: true, match: stripMatchSecrets({ ...match, id: publicMatchId(key) }) } }
      }
    }
    return {
      status: 404,
      body: { success: false, error: 'No match found with this PIN. Make sure the main scoresheet is running and connected.' },
    }
  }

  async function getMatch(rawId) {
    const matchId = normalizeMatchId(rawId)
    if (!matchId) return { status: 400, body: { success: false, error: 'Match ID required' } }
    const bundle = store.get(matchId) || await requestFromScoreboards('match-data-request', { matchId }, matchId)
    if (!bundle) {
      return { status: 404, body: { success: false, error: 'Match data not found. Make sure the main scoresheet is running and connected.' } }
    }
    return { status: 200, body: { success: true, ...toWireBundle(bundle) } }
  }

  function listMatches() {
    const matches = []
    for (const [key, bundle] of store) {
      const match = bundle.match || {}
      const m = {
        id: publicMatchId(key),
        gameNumber: match.gameNumber || match.game_n || key,
        homeTeam: bundle.homeTeam?.name || match.homeTeamName || 'Home',
        awayTeam: bundle.awayTeam?.name || match.awayTeamName || 'Away',
        scheduledAt: match.scheduledAt,
        dateTime: formatDateTime(match.scheduledAt),
        status: match.status,
        // PINs intentionally NOT returned — validated via /api/match/validate-pin
        refereeConnectionEnabled: match.refereeConnectionEnabled === true,
      }
      if (m.refereeConnectionEnabled && (m.status === 'scheduled' || m.status === 'live')) matches.push(m)
    }
    // Most recent first; only the single most recent open match is offered.
    matches.sort((a, b) => (b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0) - (a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0))
    return { status: 200, body: { success: true, matches: matches.slice(0, 1) } }
  }

  async function findByGameNumber(gameNumber) {
    const gn = gameNumber === undefined || gameNumber === null ? '' : String(gameNumber).trim()
    if (!gn) return { status: 400, body: { success: false, error: 'Game number required' } }
    for (const [key, bundle] of store) {
      const match = bundle.match
      if (match && (String(match.gameNumber || '') === gn || String(match.game_n || '') === gn || key === gn)) {
        return { status: 200, body: { success: true, match: stripMatchSecrets(match), matchId: key } }
      }
    }
    const found = await requestFromScoreboards('game-number-request', { gameNumber: gn })
    if (!found) return { status: 404, body: { success: false, error: 'Match not found with this game number' } }
    return { status: 200, body: { success: true, match: stripMatchSecrets(found.match), matchId: found.matchId } }
  }

  async function updateMatch(rawId, updates) {
    const matchId = normalizeMatchId(rawId)
    if (!matchId) return { status: 400, body: { success: false, error: 'Match ID required' } }
    const result = await requestFromScoreboards('match-update-request', { matchId, updates }, matchId)
    if (!result) {
      return { status: 500, body: { success: false, error: 'Update request timeout. Make sure the main scoresheet is running.' } }
    }
    return { status: 200, body: { success: true, ...(result.data ? toWireBundle(result.data) : {}) } }
  }

  function getConnections(matchIdFilter) {
    const filter = normalizeMatchId(matchIdFilter)
    const list = []
    for (const [, meta] of clients) {
      if (meta.owned.size > 0) continue // scoreboards are not dashboards
      for (const matchId of meta.subscribed) {
        if (filter && matchId !== filter) continue
        list.push({ id: meta.id, ip: meta.ip, role: meta.role, team: null, matchId, connectedAt: meta.connectedAt })
      }
    }
    const matchSubscriptions = {}
    for (const [matchId, subs] of subscriptions) matchSubscriptions[matchId] = subs.size
    return {
      totalClients: clients.size,
      dashboardClients: list.length,
      referees: list.filter((c) => c.role === 'referee').length,
      benches: list.filter((c) => c.role === 'bench').length,
      clients: list,
      matchSubscriptions,
    }
  }

  function sendJson(res, status, body) {
    if (res.headersSent || res.writableEnded) return
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
        if (body.length > MAX_BODY_SIZE) {
          reject(Object.assign(new Error('Request body too large'), { status: 413 }))
          req.destroy()
        }
      })
      req.on('end', () => {
        if (!body.trim()) return reject(Object.assign(new Error('Empty request body'), { status: 400 }))
        try {
          resolve(JSON.parse(body))
        } catch {
          reject(Object.assign(new Error('Invalid request body'), { status: 400 }))
        }
      })
      req.on('error', reject)
    })
  }

  /**
   * Serve the relay-owned endpoints. `url` is the full '/api/...' path with
   * query (the Vite middleware strips '/api', so it passes '/api' + req.url).
   * Returns true when the request was handled (the response may finish later).
   */
  function handleApiRequest(req, res, url) {
    const parsed = new URL(url, 'http://relay.local')
    const path = parsed.pathname
    const method = req.method
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown'
    const reply = (p) => Promise.resolve(p)
      .then((r) => sendJson(res, r.status, r.body))
      .catch((err) => sendJson(res, err.status || 500, { success: false, error: err.message || 'Internal error' }))

    if (path === '/api/match/validate-pin') {
      if (method !== 'POST') return false
      if (isRateLimited(ip)) {
        sendJson(res, 429, { success: false, error: 'Too many attempts. Please wait a minute before trying again.' })
        return true
      }
      reply(readJsonBody(req).then(validatePin))
      return true
    }
    if (path === '/api/match/list' && method === 'GET') {
      reply(listMatches())
      return true
    }
    if (path === '/api/match/by-game-number' && method === 'GET') {
      if (isRateLimited(`gn:${ip}`, 60)) {
        sendJson(res, 429, { success: false, error: 'Too many requests' })
        return true
      }
      reply(findByGameNumber(parsed.searchParams.get('gameNumber')))
      return true
    }
    if (path === '/api/server/connections' && method === 'GET') {
      sendJson(res, 200, getConnections(parsed.searchParams.get('matchId')))
      return true
    }
    const m = path.match(/^\/api\/match\/([^/]+)$/)
    if (m) {
      let id
      try { id = decodeURIComponent(m[1]) } catch { id = null }
      if (method === 'GET') {
        reply(getMatch(id))
        return true
      }
      if (method === 'PATCH') {
        reply(readJsonBody(req).then((updates) => updateMatch(id, updates)))
        return true
      }
    }
    return false
  }

  return {
    // WS side
    addClient,
    removeClient,
    handleMessage,
    // HTTP side
    handleApiRequest,
    validatePin,
    getMatch,
    listMatches,
    findByGameNumber,
    updateMatch,
    getConnections,
    // introspection (status endpoints, tests)
    get clientCount() { return clients.size },
    hasMatch: (id) => store.has(normalizeMatchId(id)),
    isScoreboard: (ws) => (clients.get(ws)?.owned.size || 0) > 0,
  }
}

module.exports = {
  MATCH_SECRET_FIELDS,
  WS_MAX_PAYLOAD,
  MAX_BODY_SIZE,
  stripMatchSecrets,
  stripMatchDataSecrets,
  normalizeMatchId,
  gamePinOf,
  toWireBundle,
  createRateLimiter,
  createLanRelay,
}
