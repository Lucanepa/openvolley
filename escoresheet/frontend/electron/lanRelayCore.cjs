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
 *                     Otherwise { type:'error', code:'not-match-owner' }. Dexie ids restart
 *                     at 1 on every device, so an id nobody has owned for a while may be
 *                     reused by another scorer: after ORPHAN_TAKEOVER_MS when the stored
 *                     match is finished, after STALE_TAKEOVER_MS otherwise — and then the
 *                     displaced game PIN may reclaim the id once. Wrong-PIN claims are
 *                     limited per IP and per socket ('rate-limited', no PIN oracle); only
 *                     a claim carrying a PIN counts. A LAN IP may hold only a few match
 *                     ids at once ('too-many-matches').
 *                     Room key: the match's seed_key (match.seed_key) when it carries one,
 *                     else String(matchId). Every device's first match is Dexie id 1, so
 *                     the seed_key keeps scorers apart and is the id the tablets know
 *                     (cloud PIN check, QR code, /api/match/validate-pin). The socket's
 *                     own matchId is remembered as an alias of that key, so its later
 *                     match-action / live-state-update / delete-match / keepMatchId may
 *                     still use the Dexie id.
 *                     PINs: a socket that already proved the match may leave the PIN
 *                     fields (gamePin, refereePin, ...) out; the relay keeps the stored
 *                     ones. A field that is present (even null) replaces the stored value.
 *                     A sync without the PIN fields gets { code:'pins-required' } when this
 *                     socket sent PINs for the key before and the relay no longer holds
 *                     the match (a room recreated without PINs could be claimed by
 *                     anyone), and when this socket has not proved the stored match (a
 *                     scorer's reconnected socket): it must resend them. Not a failed
 *                     claim: never counted toward 'rate-limited'. The scorer publishes
 *                     only under the seed key (never a Dexie id), PINs with the first
 *                     sync of each key, and in the browser on one socket for all views.
 *                     Rooms exist only under that key: a scoreboard asked for a match by
 *                     another id (GET /api/match/<Dexie id>) is not answered, so a Dexie
 *                     id never opens a second, frozen room. Subscribers (tablets, the
 *                     point-hub LedBox bridge) must use the seed key: MATCH_ID=<seed key>,
 *                     or resolve it via /api/match/list or /api/match/by-game-number.
 *   match-action      { matchId, action, data, timestamp }   proven scoreboard of matchId only
 *   live-state-update { matchId, liveState }                 proven scoreboard of matchId only
 *   delete-match      { matchId }                            proven scoreboard of matchId only
 *   clear-all-matches { keepMatchId? }   removes only matches THIS socket proved
 *   subscribe-match   { matchId, device?, team? }  /  unsubscribe-match { matchId }  /  ping
 *                     device ('referee' | 'bench' | 'livescore') and team ('home' | 'away')
 *                     only label the socket in /api/server/connections (tablet status on
 *                     the scorer); they grant nothing. `role` is accepted as the old name.
 *   match-data-response | game-number-response | match-update-response { requestId, ... }
 *                     answers to relay requests; accepted only from the sockets asked.
 * Relay -> client
 *   match-full-data, match-data-update  FLAT bundle: { type, matchId, match, homeTeam, awayTeam,
 *                     homePlayers, awayPlayers, sets, events, liveState?, _timestamp,
 *                     _scoreboardTimestamp }. `match` is always stripped of PINs.
 *                     When a liveState is stored it is ALSO sent as `data: { liveState }`
 *                     (and nothing else under `data`) for the LedBox bridge (point-hub
 *                     relaySubscriber reads msg.data.liveState). The liveState is carried
 *                     across syncs only while the same game PIN keeps the match.
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
// A FINISHED match whose scoreboard left this long ago may be claimed by
// another scoreboard: a second scorer device / reset browser reusing the same
// Dexie id on a long-running relay. Far longer than a Wi-Fi blip (clients
// reconnect within ~5 s), so a live scoreboard is never displaced.
const ORPHAN_TAKEOVER_MS = 60 * 1000
// An UNFINISHED match is only claimable after a much longer absence (a scorer
// tablet asleep through a set break must not lose its match), and its own game
// PIN may then reclaim it once.
const STALE_TAKEOVER_MS = 10 * 60 * 1000
// Wrong game-PIN claims allowed per IP / per socket per minute. Past that every
// claim needing proof is refused WITHOUT comparing the PIN, so the answer is
// no oracle for guessing it. One limit for both on purpose: on the venue LAN
// every scorer device has its own address (no NAT in between), unlike the
// cloud relay (backend/server.js CLAIM_FAILURE_LIMIT_PER_IP = 20, venue NATs).
const CLAIM_FAILURE_LIMIT = 5
// Distinct match ids the sockets of one (non-loopback) IP may own at once, and
// new ids one IP may claim per minute: stops a LAN device squatting on ids.
const MAX_OWNED_PER_IP = 4
const NEW_CLAIM_LIMIT = 10
const FINISHED_STATUSES = new Set(['final', 'ended', 'completed', 'finished'])

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

// Personal data the relay never hands out. Subscribing needs no PIN (tablets
// check theirs over HTTP, then subscribe like any viewer) and the room key is
// the match's public external_id, so every match object and bundle that
// leaves the relay is public. The match is the scorer's free-form Dexie row,
// hence denylists. Same lists in backend/lib/publicColumns.js and
// src-tauri/src/relay.rs.
const PERSON_PRIVATE_FIELDS = [
  'dob', 'dateOfBirth', 'date_of_birth', 'birthDate', 'birthdate', 'birth_date',
  'country', 'nationality', 'email', 'phone', 'address',
]
// Plus every key containing "signature" (any case).
const MATCH_PRIVATE_FIELDS = [
  'officials', 'signatures', 'approval', 'manualChanges', 'manual_changes',
  'pendingHomeRoster', 'pendingAwayRoster', 'pending_home_roster', 'pending_away_roster',
]
// Match keys holding people: kept, each entry without PERSON_PRIVATE_FIELDS.
const MATCH_ROSTER_FIELDS = [
  'players_home', 'players_away', 'bench_home', 'bench_away',
  'players_team1', 'players_team2', 'benchHome', 'benchAway', 'homePlayers', 'awayPlayers',
]

function publicPerson(p) {
  if (p == null || typeof p !== 'object' || Array.isArray(p)) return p
  let out = p
  for (const k of PERSON_PRIVATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      if (out === p) out = { ...p }
      delete out[k]
    }
  }
  return out
}

/** A roster array without personal keys (anything else is returned as is). */
function publicPeople(list) {
  return Array.isArray(list) ? list.map(publicPerson) : list
}

/**
 * A match object as the relay may hand it out: PIN-free (stripMatchSecrets),
 * without MATCH_PRIVATE_FIELDS or signature keys, rosters without personal keys.
 * @param {any} match
 */
function publicMatch(match) {
  const clean = stripMatchSecrets(match)
  if (!clean || typeof clean !== 'object' || Array.isArray(clean)) return clean
  const out = {}
  for (const [k, v] of Object.entries(clean)) {
    if (MATCH_PRIVATE_FIELDS.includes(k) || /signature/i.test(k)) continue
    out[k] = MATCH_ROSTER_FIELDS.includes(k) ? publicPeople(v) : v
  }
  return out
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

/**
 * The relay room key of a synced match: its seed_key when it carries one (see
 * the protocol notes above), else the id the scoreboard sent.
 */
function relayKeyOf(rawId, match) {
  const seed = match && typeof match === 'object' ? (match.seed_key ?? match.seedKey) : null
  return (typeof seed === 'string' && normalizeMatchId(seed)) || normalizeMatchId(rawId)
}

/**
 * A scoreboard that already proved the match sends its PINs only when they
 * change: fields it leaves out keep the stored values.
 */
function carryMatchSecrets(prevMatch, nextMatch) {
  if (!prevMatch || typeof prevMatch !== 'object' || !nextMatch || typeof nextMatch !== 'object') return nextMatch
  let out = nextMatch
  for (const k of MATCH_SECRET_FIELDS) {
    if (!(k in nextMatch) && prevMatch[k] !== undefined) {
      if (out === nextMatch) out = { ...nextMatch }
      out[k] = prevMatch[k]
    }
  }
  return out
}

const DEVICE_ROLES = ['referee', 'bench', 'livescore']
const DEVICE_TEAMS = ['home', 'away']
const MAX_ALIASES = 16

/** True when the match object carries a game PIN field at all (even empty). */
function hasGamePinField(match) {
  return !!match && typeof match === 'object' && ('gamePin' in match || 'game_pin' in match)
}

/** True when the match object carries any PIN field at all (even empty). */
function hasAnyPinField(match) {
  return !!match && typeof match === 'object' && MATCH_SECRET_FIELDS.some((k) => k in match)
}

/** Remember a key in a bounded Set (oldest dropped first). */
function rememberKey(set, key, max) {
  set.delete(key)
  if (set.size >= max) set.delete(set.values().next().value)
  set.add(key)
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

/**
 * The PIN-free, personal-data-free bundle fields every match-data message and
 * HTTP response carries (only the scorer, who sent it, has the full bundle).
 */
function toWireBundle(bundle) {
  const out = {
    match: publicMatch(bundle.match),
    homeTeam: bundle.homeTeam ?? null,
    awayTeam: bundle.awayTeam ?? null,
    homePlayers: publicPeople(bundle.homePlayers || []),
    awayPlayers: publicPeople(bundle.awayPlayers || []),
    sets: bundle.sets || [],
    events: bundle.events || [],
  }
  if (bundle.liveState !== undefined) out.liveState = bundle.liveState
  return out
}

/**
 * A match-full-data / match-data-update message. Flat bundle for the apps; a
 * stored liveState is mirrored under `data` for the LedBox bridge, which reads
 * `msg.data.liveState` (`data` never carries anything else, so no PINs).
 */
function matchDataMessage(type, matchId, bundle, scoreboardTs) {
  const now = Date.now()
  const msg = { type, matchId, ...toWireBundle(bundle), _timestamp: now, _scoreboardTimestamp: scoreboardTs || now }
  if (bundle.liveState !== undefined) msg.data = { liveState: bundle.liveState }
  return msg
}

function isFinishedMatch(match) {
  return !!match && FINISHED_STATUSES.has(String(match.status || '').toLowerCase())
}

function stripV4Prefix(addr) {
  return typeof addr === 'string' && addr.startsWith('::ffff:') ? addr.slice(7) : addr
}

function isLoopbackAddress(addr) {
  const a = stripV4Prefix(addr)
  return a === '::1' || (typeof a === 'string' && a.startsWith('127.'))
}

/**
 * `isLocal(addr)`: the request comes from the relay host itself — loopback, or
 * one of its own interface addresses (the scoretable app calls the relay on
 * its LAN IP, which arrives from that IP, not 127.0.0.1). Pass
 * os.networkInterfaces; this module must not require() it.
 */
function createLocalAddressCheck(networkInterfaces) {
  return function isLocal(addr) {
    if (!addr) return false
    if (isLoopbackAddress(addr)) return true
    const a = stripV4Prefix(addr)
    try {
      const nets = networkInterfaces ? networkInterfaces() : {}
      for (const list of Object.values(nets)) {
        for (const net of list || []) if (net.address === a) return true
      }
    } catch { /* treat as remote */ }
    return false
  }
}

/**
 * Single main-scoresheet lock, the same rule on every relay: only the relay
 * host itself (see createLocalAddressCheck) may register or release it, and it
 * may always re-register. A LAN device can therefore never lock the scoretable
 * out of "/". When the scorer runs on a LAN tablet (headless Pi) nobody
 * registers and the gate stays off — the gate would otherwise block that
 * tablet's own reload, since a page navigation cannot send X-Instance-ID.
 */
function createMainInstanceGate({ isLocal }) {
  let mainInstanceId = null
  return {
    get mainInstanceId() { return mainInstanceId },
    register(instanceId, addr) {
      if (!isLocal(addr)) {
        return { status: 403, body: { success: false, error: 'Only the scoretable machine can register the main instance' } }
      }
      mainInstanceId = instanceId || `instance-${Date.now()}`
      return { status: 200, body: { success: true, instanceId: mainInstanceId } }
    },
    unregister(instanceId, addr) {
      if (!isLocal(addr)) {
        return { status: 403, body: { success: false, error: 'Not the registered instance' } }
      }
      mainInstanceId = null // the host may always release its own lock
      return { status: 200, body: { success: true } }
    },
    /** True when a request for "/" must get the "already running" page. */
    blocksMainPage(addr, requestingInstanceId) {
      return mainInstanceId !== null && !isLocal(addr) && requestingInstanceId !== mainInstanceId
    },
    /**
     * Serve /api/server/register-main and /api/server/unregister-main.
     * Returns true when handled.
     */
    handleRequest(req, res, path) {
      if (path !== '/api/server/register-main' && path !== '/api/server/unregister-main') return false
      const addr = req.socket && req.socket.remoteAddress
      const id = req.headers['x-instance-id']
      const r = path.endsWith('/register-main') ? this.register(id, addr) : this.unregister(id, addr)
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.body))
      return true
    },
  }
}

/** Counts failures per key in a fixed window; `blocked` never increments. */
function createFailureCounter({ windowMs = 60 * 1000, max = CLAIM_FAILURE_LIMIT } = {}) {
  const entries = new Map()
  const fresh = (key) => {
    const e = entries.get(key)
    if (e && Date.now() - e.windowStart <= windowMs) return e
    entries.delete(key)
    return null
  }
  return {
    blocked: (key) => { const e = fresh(key); return !!e && e.count >= max },
    fail: (key) => {
      if (entries.size > 10000) entries.clear() // bound memory under a flood
      const e = fresh(key)
      if (e) e.count++
      else entries.set(key, { count: 1, windowStart: Date.now() })
    },
  }
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
  const orphanTakeoverMs = options.orphanTakeoverMs ?? ORPHAN_TAKEOVER_MS
  const staleTakeoverMs = options.staleTakeoverMs ?? STALE_TAKEOVER_MS
  const maxOwnedPerIp = options.maxOwnedPerIp ?? MAX_OWNED_PER_IP
  const isRateLimited = options.isRateLimited || createRateLimiter()
  const claimFailures = createFailureCounter({ max: options.claimFailureLimit ?? CLAIM_FAILURE_LIMIT })
  const isNewClaimLimited = createRateLimiter({ max: options.newClaimLimit ?? NEW_CLAIM_LIMIT })

  const store = new Map() // matchId -> bundle (unstripped: the PINs live only here)
  const subscriptions = new Map() // matchId -> Set<ws>
  const clients = new Map() // ws -> { id, ip, role, connectedAt, owned:Set, subscribed:Set }
  const pending = new Map() // requestId -> { type, matchId, targets:Set<ws>, resolve, timer }
  const orphanedSince = new Map() // matchId -> when its last owning socket left
  const displaced = new Map() // matchId -> game PIN an unfinished match had before a stale takeover
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
      team: null,
      connectedAt: new Date().toISOString(),
      owned: new Set(),
      subscribed: new Set(),
      aliases: new Map(), // id this socket synced under -> room key (seed_key)
      pinKeys: new Set(), // room keys this socket sent PINs for (see 'pins-required')
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
    for (const matchId of meta.owned) {
      if (ownersOf(matchId).length === 0) orphanedSince.set(matchId, Date.now())
    }
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
   * No connected socket has owned matchId for long enough: ORPHAN_TAKEOVER_MS
   * for a finished match, STALE_TAKEOVER_MS for one still in play.
   */
  function isAbandoned(matchId, existing) {
    const since = orphanedSince.get(matchId)
    if (since === undefined || ownersOf(matchId).length > 0) return false
    const grace = isFinishedMatch(existing && existing.match) ? orphanTakeoverMs : staleTakeoverMs
    return Date.now() - since >= grace
  }

  const failureKeys = (meta) => (meta.ip ? [`ip:${meta.ip}`, `ws:${meta.id}`] : [`ws:${meta.id}`])

  /** Squatting limits for a socket that is about to own an id it did not own. */
  function newClaimDenied(meta, matchId) {
    if (!meta.ip || isLoopbackAddress(meta.ip)) return null // the scoretable machine itself
    const ids = new Set()
    for (const other of clients.values()) {
      if (other.ip !== meta.ip) continue
      for (const id of other.owned) if (id !== matchId) ids.add(id)
    }
    if (ids.size >= maxOwnedPerIp) return 'too-many-matches'
    if (isNewClaimLimited(`new:${meta.ip}`)) return 'rate-limited'
    return null
  }

  /**
   * Prove the scoreboard role for matchId with the match's own game PIN.
   * Returns { ok:true, kind } or { ok:false, code }. kind is 'owner' (this
   * socket already owned it), 'proved' (same game PIN), 'new', 'open' (test
   * match without a PIN), 'takeover' or 'reclaim'.
   * - match not on the relay yet: the first scoreboard claims it;
   * - stored match has a game PIN: the incoming match must carry the same one;
   * - stored match has none (test match): any socket may write it, but only a
   *   socket that already owns it may attach a game PIN to it;
   * - an abandoned match (see isAbandoned) may be taken over; when an
   *   unfinished match is taken over with another game PIN, its own PIN may
   *   reclaim it once (a scorer that was asleep is not locked out for good);
   * - a socket that has not proved the match and leaves the game PIN out is
   *   asked for it ('pins-required'): not a guess, not counted.
   */
  function claim(ws, matchId, incomingMatch) {
    const meta = clients.get(ws)
    if (!meta) return { ok: false, code: 'bad-request' }
    const wasOwner = meta.owned.has(matchId)
    const existing = store.get(matchId)
    const incomingPin = gamePinOf(incomingMatch)
    const grant = (kind) => {
      meta.owned.add(matchId)
      orphanedSince.delete(matchId)
      return { ok: true, kind }
    }
    const denyNew = () => (wasOwner ? null : newClaimDenied(meta, matchId))

    if (!existing) {
      const denied = denyNew()
      return denied ? { ok: false, code: denied } : grant(wasOwner ? 'owner' : 'new')
    }
    const storedPin = gamePinOf(existing.match)
    if (storedPin === null && (incomingPin === null || wasOwner)) {
      const denied = denyNew()
      return denied ? { ok: false, code: denied } : grant(wasOwner ? 'owner' : 'open')
    }
    // An owner re-sending its own PIN proved it already: never rate limited.
    // Leaving the PIN out is fine too (PINs are sent only when they change).
    if (wasOwner && storedPin !== null && (incomingPin === storedPin || !hasGamePinField(incomingMatch))) return grant('owner')
    // Proof takes the game PIN. A socket that leaves it out (the scorer after
    // a reconnect) is asked for it: nothing compared, nothing counted.
    if (storedPin !== null && !hasGamePinField(incomingMatch)) return { ok: false, code: 'pins-required' }
    // From here the socket must prove something. Over the failure limit it is
    // refused before any comparison, so the reply says nothing about the PIN.
    const keys = failureKeys(meta)
    if (keys.some((k) => claimFailures.blocked(k))) return { ok: false, code: 'rate-limited' }

    if (storedPin !== null && incomingPin === storedPin) return grant(wasOwner ? 'owner' : 'proved')

    const reclaimPin = displaced.get(matchId)
    if (reclaimPin !== undefined && incomingPin !== null && incomingPin === reclaimPin) {
      displaced.delete(matchId)
      for (const other of clients.values()) if (other !== meta) other.owned.delete(matchId)
      return grant('reclaim')
    }
    if (isAbandoned(matchId, existing)) {
      const denied = denyNew()
      if (denied) return { ok: false, code: denied }
      if (storedPin !== null && incomingPin !== storedPin && !isFinishedMatch(existing.match)) displaced.set(matchId, storedPin)
      else displaced.delete(matchId)
      return grant('takeover')
    }
    // Only a claim with a PIN is a guess (a null PIN proves nothing either way)
    if (incomingPin !== null) for (const k of keys) claimFailures.fail(k)
    return { ok: false, code: 'not-match-owner' }
  }

  const CLAIM_ERRORS = {
    'not-match-owner': 'Match is owned by another scoreboard (game PIN mismatch)',
    'rate-limited': 'Too many failed scoreboard claims. Wait a minute.',
    'too-many-matches': 'This device already drives the maximum number of matches',
    'bad-request': 'Unknown connection',
    'pins-required': 'Send this match again with its PINs (the relay lost it, or this connection has not proved it yet)',
  }

  /**
   * Store a synced bundle. A sync carries no liveState: the last one pushed is
   * kept only while the same scoreboard / game PIN keeps the match — never
   * across a takeover, a reclaim or a PIN change (it would describe another
   * match: its sides, sets won, 'ended' status, ...).
   */
  function storeBundle(matchId, bundle, kind) {
    const prev = store.get(matchId)
    if (prev && (kind === 'owner' || kind === 'proved')) {
      bundle = { ...bundle, match: carryMatchSecrets(prev.match, bundle.match) }
    }
    const carry = prev && prev.liveState !== undefined && bundle.liveState === undefined &&
      (kind === 'owner' || kind === 'proved') && gamePinOf(prev.match) === gamePinOf(bundle.match)
    const next = carry ? { ...bundle, liveState: prev.liveState } : bundle
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
    orphanedSince.delete(matchId)
    displaced.delete(matchId)
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
      // Stored only under its room key, and only when that is the id asked for
      const claimed = msg.success && bundle && id === p.matchId && relayKeyOf(id, bundle.match) === id
        ? claim(ws, id, bundle.match) : null
      if (!claimed || !claimed.ok) {
        declineRequest(msg.requestId, ws)
        return
      }
      settle(msg.requestId, storeBundle(id, bundle, claimed.kind))
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
      const claimed = bundle && id === p.matchId && relayKeyOf(id, bundle.match) === id ? claim(ws, id, bundle.match) : null
      if (claimed && claimed.ok) {
        const stored = storeBundle(id, bundle, claimed.kind)
        sendToSubscribers(id, matchDataMessage('match-data-update', id, stored), ws)
        settle(msg.requestId, { data: stored })
      } else {
        settle(msg.requestId, { data: null })
      }
    }
  }

  // --- WS message handlers ---------------------------------------------------

  /** The room key for an id this socket sends (its Dexie id is an alias of the seed_key). */
  function resolveKey(ws, rawId) {
    const id = normalizeMatchId(rawId)
    if (!id) return null
    const meta = clients.get(ws)
    return (meta && meta.aliases.get(id)) || id
  }

  function onSync(ws, msg) {
    const bundle = bundleFromMessage(msg)
    const rawId = normalizeMatchId(msg.matchId)
    const matchId = bundle ? relayKeyOf(rawId, bundle.match) : null
    if (!matchId || !bundle) {
      sendError(ws, 'bad-request', 'sync-match-data needs matchId and match')
      return
    }
    const meta = clients.get(ws)
    if (meta) {
      if (hasAnyPinField(bundle.match)) {
        rememberKey(meta.pinKeys, matchId, MAX_ALIASES)
      } else if (!store.has(matchId) && meta.pinKeys.has(matchId)) {
        // It left the PINs out because the relay held them: not any more
        sendError(ws, 'pins-required', CLAIM_ERRORS['pins-required'], matchId)
        return
      }
    }
    const claimed = claim(ws, matchId, bundle.match)
    if (!claimed.ok) {
      sendError(ws, claimed.code, CLAIM_ERRORS[claimed.code] || 'Refused', matchId)
      return
    }
    if (meta && rawId && rawId !== matchId) {
      meta.aliases.delete(rawId)
      if (meta.aliases.size >= MAX_ALIASES) meta.aliases.delete(meta.aliases.keys().next().value)
      meta.aliases.set(rawId, matchId)
    }
    const stored = storeBundle(matchId, bundle, claimed.kind)
    sendToSubscribers(matchId, matchDataMessage('match-data-update', matchId, stored, msg._timestamp), ws)
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
      const device = msg.device ?? msg.role
      if (DEVICE_ROLES.includes(device)) meta.role = device
      if (DEVICE_TEAMS.includes(msg.team)) meta.team = msg.team
    }
    const stored = store.get(matchId)
    if (stored) send(ws, matchDataMessage('match-full-data', matchId, stored))
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
    const matchId = resolveKey(ws, msg.matchId)
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
    const matchId = resolveKey(ws, msg.matchId)
    if (!requireOwner(ws, matchId, 'live-state-update')) return
    if (!msg.liveState || typeof msg.liveState !== 'object') return
    const existing = store.get(matchId)
    if (existing) existing.liveState = msg.liveState
    sendToSubscribers(matchId, { type: 'live-state-update', matchId, liveState: msg.liveState }, ws)
  }

  function onDelete(ws, msg) {
    const matchId = resolveKey(ws, msg.matchId)
    if (!requireOwner(ws, matchId, 'delete-match')) return
    deleteMatch(matchId)
  }

  function onClearAll(ws, msg) {
    const meta = clients.get(ws)
    if (!meta || meta.owned.size === 0) {
      sendError(ws, 'not-scoreboard', 'Only a scoreboard that synced its match may clear matches')
      return
    }
    const keep = resolveKey(ws, msg.keepMatchId)
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
        return { status: 200, body: { success: true, match: publicMatch({ ...match, id: publicMatchId(key) }) } }
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
        return { status: 200, body: { success: true, match: publicMatch(match), matchId: key } }
      }
    }
    const found = await requestFromScoreboards('game-number-request', { gameNumber: gn })
    if (!found) return { status: 404, body: { success: false, error: 'Match not found with this game number' } }
    return { status: 200, body: { success: true, match: publicMatch(found.match), matchId: found.matchId } }
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
        list.push({ id: meta.id, ip: meta.ip, role: meta.role, team: meta.team, matchId, connectedAt: meta.connectedAt })
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
  PERSON_PRIVATE_FIELDS,
  MATCH_PRIVATE_FIELDS,
  MATCH_ROSTER_FIELDS,
  publicMatch,
  publicPeople,
  normalizeMatchId,
  gamePinOf,
  relayKeyOf,
  carryMatchSecrets,
  toWireBundle,
  matchDataMessage,
  createRateLimiter,
  createLocalAddressCheck,
  createMainInstanceGate,
  createLanRelay,
}
