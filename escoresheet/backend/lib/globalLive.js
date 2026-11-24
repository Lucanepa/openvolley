/**
 * globalLive — the Global tool's live page for TVs (owner 2026-11-17).
 *
 * A Global match is a test match to the rest of the server: its live state
 * never reaches match_live_state, the public lists or the public API. A
 * tournament that wants a live page opts in on the scorer devices with a
 * shared tournament code; the scorer's relay live-state-update then carries
 * `globalLive: <code>` and this store keeps a SUMMARY per court, in memory:
 *
 *   team names, short names and colours, points, sets won, the finished
 *   sets' points, the current set, best of, who serves, the match status,
 *   timeout / set interval, the hall and the scheduled time.
 *
 * Never kept: players, line-ups, substitutions, sanctions, officials, PINs,
 * signatures, remarks. No database row and no file: a restart empties it and
 * the next rally fills it again.
 *
 *   GET /api/global/live/<code> -> { data: { code, updatedAt, courts: [...] }, error: null }
 *
 * The code (8 characters from an alphabet without look-alikes, about 40
 * bits) is the way to a page. Nothing lists a code unless a scorer device
 * opted in to the public livescore as well ("Show on livescore", owner
 * 2026-11-17): only those courts are in
 *
 *   GET /api/global/live -> { data: { updatedAt, events: [{ code, updatedAt, courts }] }, error: null }
 *
 * (the livescore site's list; a court that stops saying so leaves it with
 * its next update). A code with a listed court shows its listed courts only
 * (owner decision 8, 23.11.2026). Bounded: maxCodes codes, maxCourtsPerCode
 * courts per code, a court is dropped endedKeepMs after its match ended,
 * idleMs after its last update (an unproved court posted once: onceMs), a
 * code with no court left is dropped; who may write or replace a court:
 * createGlobalLive.
 *
 * Node built-ins only. Pure: server.js does the relay checks (the room is a
 * Global match, the sender owns it), the rate limit and the HTTP layer.
 */
import crypto from 'node:crypto'

export const LIVE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/

/** A court token: a hex hash of a match's own secret (frontend utils/globalLive.js courtTokenFor). */
export const isCourtToken = (t) => typeof t === 'string' && /^[0-9a-f]{32}$/.test(t)

/**
 * The court token a scorer app up to 26.11.x (and OpenBeach) makes of a key:
 * SHA-256 of "court\0" + the key. Of a league or OpenBeach match's seed key it
 * is public (the seed key is the match's public id): only the relay room of
 * that key proves anything with it (createGlobalLive put).
 */
export const legacyCourtToken = (key) => crypto.createHash('sha256').update(`court\0${key}`).digest('hex').slice(0, 32)

const LIVE_SUMMARY_FIELDS = ['team_a_name', 'team_a_short', 'team_a_color', 'team_b_name', 'team_b_short', 'team_b_color', 'sets_won_a', 'sets_won_b', 'points_a', 'points_b', 'current_set', 'best_of', 'side_a', 'serving_team', 'match_status', 'timeout_active', 'set_interval_active']
/** Only the live-state fields courtSummary reads (what a forward or a push carries). */
export function pickLiveSummaryFields(liveState) {
  const out = {}
  if (!liveState || typeof liveState !== 'object') return out
  for (const k of LIVE_SUMMARY_FIELDS) if (k in liveState) out[k] = liveState[k]
  return out
}

/** A court number a scorer device set for its screen (1-99), else null. */
export function screenNumber(v) {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null
}

/**
 * The court number for /tv/<code>/<n>: the one the scorer device set, else
 * the number at the end of the match's court (OpenBeach: 'Court 3' -> 3).
 */
export function screenOf(explicit, entry) {
  const own = screenNumber(explicit)
  if (own != null) return own
  const court = entry?.match?.court
  const m = typeof court === 'string' ? /([0-9]{1,2})\s*$/.exec(court) : (Number.isInteger(court) ? [null, String(court)] : null)
  return m ? screenNumber(m[1]) : null
}

/** A live screen code as the app makes it (utils/globalLive.js). */
export const isLiveCode = (code) => typeof code === 'string' && CODE_RE.test(code)

const str = (v, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.min(999, Math.trunc(Number(v)))) : 0)
const color = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : null)

/**
 * One court's summary from the scorer's live state and the room's synced
 * match (server.js activeMatches entry). Home and away as on the scoresheet:
 * the live state counts team A / B (the coin toss), so A is mapped back.
 */
export function courtSummary(liveState, entry = {}, nowIso = new Date().toISOString()) {
  const ls = liveState && typeof liveState === 'object' ? liveState : {}
  const match = entry.match && typeof entry.match === 'object' ? entry.match : {}
  const homeName = str(entry.homeTeam?.name)
  const awayName = str(entry.awayTeam?.name)
  const aName = str(ls.team_a_name)
  // A is home unless the names say otherwise, or the coin toss gave A to away
  const aIsHome = aName && awayName && aName === awayName && aName !== homeName
    ? false
    // (indoor says home/away, OpenBeach team1/team2)
    : (match.coinTossTeamA ? match.coinTossTeamA !== 'away' && match.coinTossTeamA !== 'team2' : true)
  const side = (a, b) => (aIsHome ? { home: a, away: b } : { home: b, away: a })
  const team = (prefix) => ({ name: str(ls[`team_${prefix}_name`]), short: str(ls[`team_${prefix}_short`], 12), color: color(ls[`team_${prefix}_color`]) })
  const teams = side(team('a'), team('b'))
  if (homeName) teams.home.name = homeName
  if (awayName) teams.away.name = awayName
  const setsWon = side(int(ls.sets_won_a), int(ls.sets_won_b))
  const points = side(int(ls.points_a), int(ls.points_b))
  // serving_team is a side (left/right); side_a says where team A stands
  let serving = null
  if ((ls.serving_team === 'left' || ls.serving_team === 'right') && (ls.side_a === 'left' || ls.side_a === 'right')) {
    const aServes = ls.serving_team === ls.side_a
    serving = aServes === aIsHome ? 'home' : 'away'
  }
  // The finished sets, home/away as the scoresheet keeps them
  const sets = (Array.isArray(entry.sets) ? entry.sets : [])
    .filter((s) => s && s.finished === true)
    .sort((x, y) => int(x.index) - int(y.index))
    .slice(0, 5)
    .map((s) => ({ home: int(s.homePoints), away: int(s.awayPoints) }))
  const status = str(ls.match_status, 20)
  const bestOf = int(ls.best_of) === 3 ? 3 : 5
  // a best-of-3 decider is stored as set 5 (frontend domain/describe.js): it is set 3
  const currentSet = int(ls.current_set) || null
  return {
    home: teams.home,
    away: teams.away,
    setsWon,
    points,
    sets,
    currentSet: bestOf === 3 && currentSet === 5 ? 3 : currentSet,
    bestOf,
    serving,
    status,
    ended: status === 'final' || status === 'ended' || status === 'approved',
    timeout: ls.timeout_active === true,
    interval: ls.set_interval_active === true,
    // the hall or venue, and the court when there is one (OpenBeach: the same
    // venue on every court, the court number tells them apart)
    hall: [str(match.hall) || str(match.venue), str(match.court)].filter(Boolean).join(' \u00b7 ') || null,
    scheduledAt: str(match.scheduledAt, 40),
    gameNumber: str(match.gameN != null ? String(match.gameN) : null, 20),
    updatedAt: nowIso
  }
}

const HOUR_MS = 60 * 60 * 1000

/**
 * The /56 of an IPv6 /64 bucket key (lib/auth.js ipBucketKey
 * "2001:db8:0:1::/64"), else the key itself (an IPv4 address).
 */
export function netOfBucket(bucket) {
  const v6 = typeof bucket === 'string' ? /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4})::\/64$/.exec(bucket) : null
  return v6 ? `${v6[1]}:${v6[2]}:${v6[3]}:${(parseInt(v6[4], 16) & 0xff00).toString(16)}::/56` : bucket
}

/**
 * The store. Who may write a court (audit SEC-07 / SEC-10 / LOG-11, 23.11.2026):
 *
 * - A court is keyed by an HMAC (a key of this process) of its code and token,
 *   so its public id says nothing about the token.
 * - A relay room (`room`: the room key of a socket that owns it) is bound to
 *   one court per code: a push without a token, or with a token the room did
 *   not start with, goes to that court (a scorer page's first push came
 *   without its token and made a second, frozen court: LOG-11); a room that
 *   started without a token (an older app) and then sends one moves to it,
 *   its room court is dropped.
 * - A court is locked to its room when the relay proved it: the room key's own
 *   court token (what an app up to 26.11.x makes of the seed key, which is the
 *   room key), the server's token of a room that sent none, or a room whose
 *   scorer proved the game PIN of the match's database row (`official`; it
 *   proves a new court or one of its own room only, never another room's:
 *   the game PIN of one match is no key to the others' courts). A locked
 *   court takes no HTTP push and no other room, except the room whose key
 *   the token is made of. Any other court is unproved: whoever has its
 *   token updates it, as before (a current app's token comes from a random
 *   secret of the match that never leaves the device: nobody can guess it;
 *   an older app's token of a league or OpenBeach match is a hash of the
 *   public seed key, but its scorer on the cloud relay locks it; the courts
 *   only HTTP pushes feed, from the desktop app or a venue relay's forward,
 *   stay unproved).
 * - Bounded without letting strangers push real courts out: a new court
 *   replaces only an ended or stale court of a full code, and a new code
 *   only a code with nothing live; a relay court also an HTTP court that
 *   was posted only once (never a court being scored, whichever way it
 *   comes); an unproved court posted only once goes after onceMs; new codes
 *   and new courts per address (/64 bucket and its /56) and hour are capped,
 *   and per relay room (a room that proved its game PIN per room only: many
 *   scorers share a hall's address). What is refused is counted (stats,
 *   /health).
 */
export function createGlobalLive({
  maxCodes = 1000,
  maxCourtsPerCode = 24,
  idleMs = 3 * HOUR_MS,
  endedKeepMs = 45 * 60 * 1000,
  // an unproved court with a single push (nobody scores it)
  onceMs = 15 * 60 * 1000,
  // a court without an update this long may give way to a new one
  staleMs = 10 * 60 * 1000,
  // new codes / new courts per hour: [per /64 bucket, per /56]
  newCodesPerHour = [12, 36],
  newCourtsPerHour = [120, 360],
  // ... and per relay room (one court per code: a live screen code typed
  // wrong, or changed, now and then)
  newCodesPerRoom = 4,
  newCourtsPerRoom = 8,
  maxSources = 20000,
  // the room courts' tokens: an HMAC under it (null: an unkeyed hash, as
  // before, on a venue relay without a secret)
  secret = null,
  now = Date.now
} = {}) {
  /** code -> { courts: Map(courtId -> court), proved, at } */
  const codes = new Map()
  /** relay room key -> { code, id, token, derived } */
  const rooms = new Map()
  /** 'codes\0' | 'courts\0' + address -> { start, n } */
  const sources = new Map()
  const refused = { full: 0, courtsFull: 0, rate: 0, bound: 0 }

  const idKey = crypto.randomBytes(32)
  const roomKey = secret ? crypto.createHmac('sha256', String(secret)).update('ov-global-live-room:v1').digest() : null
  const courtIdOf = (code, token) => crypto.createHmac('sha256', idKey).update(`${code}\0${token}`).digest('base64url').slice(0, 10)
  /** The token of a room that sends none (an older scorer app). */
  const roomTokenOf = (room) => (roomKey
    ? crypto.createHmac('sha256', roomKey).update(`room\0${room}`).digest('hex')
    : crypto.createHash('sha256').update(`room\0${room}`).digest('hex')).slice(0, 32)

  function dropCourt(code, entry, id) {
    const c = entry.courts.get(id)
    entry.courts.delete(id)
    const b = c?.room != null ? rooms.get(c.room) : null
    if (b && b.code === code && b.id === id) rooms.delete(c.room)
  }
  function dropCode(code) {
    const entry = codes.get(code)
    if (!entry) return
    for (const id of [...entry.courts.keys()]) dropCourt(code, entry, id)
    codes.delete(code)
  }

  function sweep() {
    const t = now()
    for (const [code, entry] of codes) {
      for (const [id, c] of entry.courts) {
        if (t - c.at > idleMs || (c.endedAt && t - c.endedAt > endedKeepMs) || (c.room == null && c.n < 2 && t - c.at > onceMs)) dropCourt(code, entry, id)
      }
      if (entry.courts.size === 0) codes.delete(code)
    }
    // a room whose court went
    for (const [room, b] of rooms) if (!codes.get(b.code)?.courts.has(b.id)) rooms.delete(room)
    for (const [k, s] of sources) if (t - s.start > HOUR_MS) sources.delete(k)
  }

  // The hour's budget of new codes or courts of an address (its /64 bucket
  // and the /56 around it; no address: the relay host itself, a test) and of
  // a relay room
  function slotOf(key, limit, t) {
    let s = sources.get(key)
    if (s && t - s.start > HOUR_MS) { sources.delete(key); s = null }
    return { key, s, limit }
  }
  function budget(source, kind, t) {
    if (!source) return []
    const limits = kind === 'codes' ? newCodesPerHour : newCourtsPerHour
    const keys = [source]
    const net = netOfBucket(source)
    if (net !== source) keys.push(net)
    return keys.map((k, i) => slotOf(`${kind}\0${i}\0${k}`, limits[i] ?? limits[0], t))
  }
  const roomBudget = (room, kind, t) => (room == null
    ? []
    : [slotOf(`${kind}\0room\0${room}`, kind === 'codes' ? newCodesPerRoom : newCourtsPerRoom, t)])
  const allowed = (slots) => slots.every(({ s, limit }) => !s || s.n < limit)
  function charge(slots, t) {
    for (const { key, s } of slots) {
      if (s) { s.n++; continue }
      // bounded: the oldest window gives way
      if (sources.size >= maxSources) sources.delete(sources.keys().next().value)
      sources.set(key, { start: t, n: 1 })
    }
  }

  const replaceable = (c, t) => c.endedAt != null || t - c.at > staleMs
  // an HTTP court posted only once (nobody scores it yet, or a stranger's)
  const postedOnce = (c) => c.room == null && c.n < 2
  // The court a new one may replace in a full code: the oldest ended or stale
  // one; for a relay court also the oldest HTTP court posted only once. Never
  // one being scored: a stranger's relay rooms (anyone may own a test room)
  // pushed out the courts of the desktop app and of a venue relay's forward
  // for good (audit fix-up LP-1)
  function courtToReplace(entry, relay, t) {
    let pick = null
    for (const [id, c] of entry.courts) if (replaceable(c, t) && (!pick || c.at < pick.c.at)) pick = { id, c }
    if (!pick && relay) for (const [id, c] of entry.courts) if (postedOnce(c) && (!pick || c.at < pick.c.at)) pick = { id, c }
    return pick?.id ?? null
  }
  // The code a new one may replace in a full store: the least recently updated
  // with nothing live (every court ended or stale); for a relay court also
  // one whose courts are all ended, stale or HTTP courts posted only once
  function codeToReplace(relay, t) {
    let pick = null
    for (const [code, e] of codes) {
      if ((!pick || e.at < pick.e.at) && [...e.courts.values()].every((c) => replaceable(c, t))) pick = { code, e }
    }
    if (!pick && relay) {
      for (const [code, e] of codes) {
        if ((!pick || e.at < pick.e.at) && [...e.courts.values()].every((c) => replaceable(c, t) || postedOnce(c))) pick = { code, e }
      }
    }
    return pick?.code ?? null
  }

  /**
   * One court's live state. `token`: the court token (an HTTP push needs one;
   * a relay room may send none). Options: screen (the court number the scorer
   * device set, 1-99), listed (the device opted in to the public livescore
   * list), room (the key of a relay room the sender owns; none: an HTTP
   * push), official (that room's scorer proved the database row's game PIN),
   * source (the sender's address bucket, for the hourly caps). The caller has
   * checked the room and the rate limit.
   * @returns {{ ok: true, token: string, id: string } | { ok: false, reason: 'bad'|'full'|'courts-full'|'rate'|'bound' }}
   */
  function put(code, token, liveState, entry, { screen = null, listed = false, room = null, official = false, source = null } = {}) {
    if (!isLiveCode(code) || !liveState || typeof liveState !== 'object') return { ok: false, reason: 'bad' }
    const relay = room != null && String(room) !== ''
    if (token != null && (typeof token !== 'string' || token === '')) return { ok: false, reason: 'bad' }
    if (!relay && token == null) return { ok: false, reason: 'bad' }
    sweep()
    const t = now()
    let roomCourt = null
    if (relay) {
      room = String(room)
      const b = rooms.get(room)
      if (b && b.code === code) {
        if (token == null || token === b.token) token = b.token
        else if (b.derived) roomCourt = b.id // an older app's room court gives way to its token's court
        else token = b.token // one court per room: not a token it did not start with
      }
      if (token == null) token = roomTokenOf(room)
    }
    const derived = relay && token === roomTokenOf(room)
    // the relay proves this room's own court: the token is its key's, or the server's of it
    const ownKey = relay && (derived || token === legacyCourtToken(room))
    const id = courtIdOf(code, token)
    let codeEntry = codes.get(code)
    const prev = codeEntry?.courts.get(id) || null
    // the game PIN of the room's match proves a new court or one of this
    // room's own: never another room's court (the PIN of any one official
    // match passed every lock: audit fix-up LP-2)
    const pinProved = relay && official === true && (prev == null || prev.room === room)
    const proves = ownKey || pinProved
    if (prev?.locked && !(relay && (prev.room === room || ownKey))) {
      refused.bound++
      return { ok: false, reason: 'bound' }
    }
    if (!prev) {
      const newCode = !codeEntry
      // a room that proved the database row's game PIN is no stranger: no cap
      // per address (many scorers share one hall's address), only its own per
      // room, as every relay room (one room made 1000 codes: LP-2)
      const bySource = pinProved ? null : source
      const codeSlots = newCode ? [...budget(bySource, 'codes', t), ...roomBudget(relay ? room : null, 'codes', t)] : []
      const courtSlots = [...budget(bySource, 'courts', t), ...roomBudget(relay ? room : null, 'courts', t)]
      if (!allowed(codeSlots) || !allowed(courtSlots)) { refused.rate++; return { ok: false, reason: 'rate' } }
      // the room's own court of an older app gives way to its token's court
      if (roomCourt != null) { dropCourt(code, codeEntry, roomCourt); roomCourt = null }
      if (newCode && codes.size >= maxCodes) {
        const gone = codeToReplace(relay, t)
        if (gone == null) { refused.full++; return { ok: false, reason: 'full' } }
        dropCode(gone)
      }
      if (!newCode && codeEntry.courts.size >= maxCourtsPerCode) {
        const gone = courtToReplace(codeEntry, relay, t)
        if (gone == null) { refused.courtsFull++; return { ok: false, reason: 'courts-full' } }
        dropCourt(code, codeEntry, gone)
      }
      if (newCode) {
        codeEntry = { courts: new Map(), proved: false, at: t }
        codes.set(code, codeEntry)
      }
      charge(codeSlots, t)
      charge(courtSlots, t)
    }
    if (roomCourt != null && roomCourt !== id) dropCourt(code, codeEntry, roomCourt)
    const summary = { id, ...courtSummary(liveState, entry, new Date(t).toISOString()), screen: screenNumber(screen) }
    codeEntry.courts.set(id, {
      summary,
      at: t,
      endedAt: summary.ended ? (prev?.endedAt || t) : null,
      listed: listed === true,
      room: relay ? room : (prev?.room ?? null),
      locked: (prev?.locked === true) || proves,
      n: (prev?.n || 0) + 1
    })
    codeEntry.at = t
    if (relay) {
      codeEntry.proved = true
      rooms.set(room, { code, id, token, derived })
    }
    return { ok: true, token, id }
  }

  /** put() for callers that only need yes or no. */
  function update(code, token, liveState, entry, screen = null, listed = false, opts = {}) {
    return put(code, token, liveState, entry, { ...opts, screen, listed }).ok
  }

  const order = (a, b) => (a.ended - b.ended) || String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || '')) || String(a.hall || '').localeCompare(String(b.hall || ''))

  /**
   * The page's data for a code (one court with `screen`), or null when
   * nothing is live under it. A code with a court on the public livescore
   * list shows its listed courts only (owner decision 8, 23.11.2026: the list
   * gives its code to anyone; a court that is not listed needs a code of its
   * own).
   */
  function get(code, { screen = null } = {}) {
    if (!isLiveCode(code)) return null
    sweep()
    const entry = codes.get(code)
    if (!entry || entry.courts.size === 0) return null
    const all = [...entry.courts.values()]
    const shown = all.some((c) => c.listed) ? all.filter((c) => c.listed) : all
    const only = screenNumber(screen)
    const list = shown.map((c) => c.summary).filter((c) => only == null || c.screen === only)
    // running matches first, then by the scheduled time, then by hall
    list.sort(order)
    const updatedAt = list.reduce((m, c) => (c.updatedAt > m ? c.updatedAt : m), '')
    return { code, updatedAt, courts: list }
  }

  /**
   * The public livescore's list: the codes with at least one court whose
   * scorer opted in, with those courts only; running events first, at most
   * maxEvents (codes the relay proved take the places first, so pushes from
   * strangers cannot crowd them out).
   */
  function list({ maxEvents = 50 } = {}) {
    sweep()
    const events = []
    for (const [code, entry] of codes) {
      const shown = [...entry.courts.values()].filter((c) => c.listed).map((c) => c.summary)
      if (shown.length === 0) continue
      shown.sort(order)
      const updatedAt = shown.reduce((m, c) => (c.updatedAt > m ? c.updatedAt : m), '')
      events.push({ code, updatedAt, live: shown.some((c) => !c.ended), proved: entry.proved, courts: shown })
    }
    events.sort((a, b) => (b.live - a.live) || b.updatedAt.localeCompare(a.updatedAt))
    const kept = new Set([...events.filter((e) => e.proved), ...events.filter((e) => !e.proved)].slice(0, maxEvents))
    const out = events.filter((e) => kept.has(e)).map(({ live, proved, ...e }) => e)
    return { updatedAt: out.reduce((m, e) => (e.updatedAt > m ? e.updatedAt : m), '') || null, events: out }
  }

  /** For /health: the store's size and what it refused since the start. */
  function stats() {
    let courts = 0
    for (const e of codes.values()) courts += e.courts.size
    return { codes: codes.size, courts, refused: { ...refused } }
  }

  return { put, update, get, list, sweep, stats, size: () => codes.size }
}

/**
 * A league game's court summary from its public live row (publicApi
 * gameLiveRow: match_live_state + the match row), for /tv/<game number>.
 * The live row's columns are the scorer's live-state names, so courtSummary
 * reads it as it is; home / away and the finished sets come from the match.
 */
export function gameSummary(row, nowIso = new Date().toISOString()) {
  if (!row || typeof row !== 'object') return null
  const j = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return null } }
  const beach = (row.match_sport || row.sport_type) === 'beach'
  const home = j(beach ? row.team1_data : row.home_team) || {}
  const away = j(beach ? row.team2_data : row.away_team) || {}
  const info = j(row.match_info) || {}
  const aIsHome = !(typeof row.team_a_name === 'string' && row.team_a_name === away.name && row.team_a_name !== home.name)
  const sets = (Array.isArray(j(row.set_results)) ? j(row.set_results) : [])
    .filter((x) => x && typeof x === 'object')
    .map((x) => {
      // the scorer's live state (frontend domain/livePublicFields): { set, home, away, a, b }
      if (x.home != null || x.away != null) return { index: x.set ?? x.index, homePoints: x.home, awayPoints: x.away, finished: true }
      // an older shape by team A / B
      const a = x.pointsA ?? x.home_points
      const b = x.pointsB ?? x.away_points
      return { index: x.index, homePoints: aIsHome ? a : b, awayPoints: aIsHome ? b : a, finished: true }
    })
  // best of: the scorer's live row, else the match's own format (a game not started has no live row)
  const liveState = { ...row, match_status: row.match_status || row.status, points_a: row.points_a ?? 0, points_b: row.points_b ?? 0, sets_won_a: row.sets_won_a ?? 0, sets_won_b: row.sets_won_b ?? 0, best_of: row.best_of ?? info.best_of ?? null }
  const scheduledAt = row.scheduled_at instanceof Date ? row.scheduled_at.toISOString() : row.scheduled_at
  const entry = {
    match: { coinTossTeamA: aIsHome ? 'home' : 'away', hall: info.hall ?? null, scheduledAt: scheduledAt ?? null, gameN: row.game_n ?? null },
    homeTeam: { name: home.name ?? null },
    awayTeam: { name: away.name ?? null },
    sets
  }
  return { id: `game-${row.game_n}`, ...courtSummary(liveState, entry, nowIso) }
}
