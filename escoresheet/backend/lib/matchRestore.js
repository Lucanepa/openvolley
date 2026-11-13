/**
 * matchRestore — the two match endpoints that replace multi-step client flows.
 *
 *   POST /api/match/restore        { match, sets, events, liveState }   (needs a session)
 *     One transaction: upsert the match by external_id, delete its events,
 *     sets and live state, insert the sets and events (the pgQuery id scope
 *     guard applies) and the live state. Any failure rolls everything back.
 *     Keys that are not columns are dropped (and reported), not fatal: old
 *     backups and bundles send extra keys (backupManager's live state `status`
 *     is renamed to `match_status`). Sets/events without sport_type get the
 *     match's, else 'indoor'. Null/empty game_pin or connection_pins keep the
 *     stored value; connection_pins is merged into the stored object. PINs are
 *     stored in hashed form when a PIN secret is configured (lib/pinHash.js).
 *     With `matchOwner` (every non-admin session) the match must be new or
 *     owned by the caller (creator or editor), else 403 OV_NOT_MATCH_OWNER and
 *     nothing is written; with `matchOwner.testOnly` (not an approved scorer)
 *     only a test match, else 403 OV_SCORER_REQUIRED.
 *     db/007: a closed match (approved/final reached the server) cannot be
 *     restored over (409 OV_MATCH_CLOSED, nothing changes). A backup that is
 *     itself approved/final is written as 'ended' first and gets its closing
 *     status as the last step of the transaction, after its sets and events
 *     (closing first would lock the match before its children are in).
 *     `actorId` is the ov.user_id of the transaction (closed_by).
 *     `rekey` { sets: { <new external_id>: <old> }, events: { ... } }: the
 *     device that continues the match cannot keep the cloud's set/event ids
 *     (another local match holds them; frontend importMatchFromSupabase) and
 *     moves the rows to its own. Then the rows named are renamed IN PLACE
 *     (an old row that is gone is written under its new id) and nothing
 *     else is deleted: voided events (db/015), rows the payload does not
 *     name and the live state stay as they are. A whole-match replace here
 *     dropped the voided events and every row sent after the device read
 *     the match (2026-10-26). An older backend ignores `rekey` (a replace).
 *     -> 200 { data: { id, counts: { sets, events, liveState, rekeyed? }, dropped: { match?, sets?, events?, liveState? } }, error: null }
 *
 *   POST /api/match/restore-by-pin { gameN, pin }                        (anonymous, attempt-limited)
 *     Exact match on game number AND game PIN. Returns the match with its
 *     secret columns stripped, plus its sets, events and live state. With
 *     `editorUserId` (the caller is signed in) that account becomes an editor
 *     of the match (match_editors): proving the game PIN is the take-over.
 *     `takeOver(match)` (server.js, a device that continues the match: the
 *     scoring device, db/019) runs once the PIN is proved and BEFORE the
 *     sets, events and live state are read; what it returns is the answer's
 *     `scorer` (nothing when it returns null or fails).
 *     `idFloor` { set, event }: the highest local id the match's set / event
 *     external_ids carry (`<match>:s:<n>`, `<match>:e:<n>`), voided events and
 *     the revisions of events never uploaded included. The device continuing
 *     the match gives out ids above it: a new event under the id of a voided
 *     one would be born voided (db/015).
 *
 *   POST /api/match/claim { externalId, pin }                           (session, attempt-limited)
 *     The take-over alone: game PIN of that match -> the caller becomes an
 *     editor. Same attempt limits as restore-by-pin.
 *     Limits: 20 attempts per caller in 10 min across all game numbers and 5
 *     per caller and game number; a successful lookup does not count.
 *     The server MUST pass the client IP as `limitKey` (default: one shared bucket).
 *     Across callers (options.pinBudget, createPinFailureBudget: the server
 *     passes the budget of all its PIN checks): a wrong PIN for claim is one
 *     attempt against that match's game PIN, the counter every other check of
 *     the match's game PIN shares; a wrong PIN for restore-by-pin is one
 *     attempt against its game number (gameLimited), whatever number of
 *     matches carry it (game numbers repeat across seasons, beach ones in
 *     every tournament): its guesses never lock the game PIN of those matches
 *     for the scorer's own checks. Past PIN_MATCH_FAILURE_MAX the match's
 *     game PIN (claim) or the game number (restore-by-pin) is refused for a
 *     while, the right PIN too; restore-by-pin never proves a match whose
 *     game PIN is locked. A game number or match that does not exist counts
 *     nowhere across callers.
 *     -> 200 { data: { match, sets, events, liveState }, error: null }
 *     -> 404 { data: null, error: { code: 'OV_NOT_FOUND' } }  (wrong PIN or game number)
 *     -> 429 { data: null, error: { code: 'OV_TOO_MANY_ATTEMPTS' } }
 *
 * Both functions return { status, body } (and `changes` for the realtime
 * write-through) and never throw, like pgQuery.runQuery().
 *
 * Usage:
 *   const { createMatchRestore } = await import('./lib/matchRestore.js')
 *   const restore = createMatchRestore(db)            // db = createPgQuery(...)
 *   const r = await restore.restoreMatch(body, { proto: req.headers['x-ov-proto'] })
 *   const p = await restore.restoreByPin(body, { limitKey: clientIp })
 */
import { createHash, timingSafeEqual } from 'node:crypto'

export const RESTORE_DEFAULTS = Object.freeze({
  matchTable: 'matches',
  matchKey: 'external_id',
  matchId: 'id',
  childFk: 'match_id',
  setsTable: 'sets',
  eventsTable: 'events',
  liveStateTable: 'match_live_state',
  gameNColumn: 'game_n',
  pinColumn: 'game_pin',
  statementTimeoutMs: 60000,
  maxSets: 20,
  maxEvents: 20000,
  childRowCap: 100000,
  // Restored sets/events without sport_type get the match's, else this (the old client flow stamped 'indoor').
  defaultSportType: 'indoor',
  // Keys older clients still send, renamed when the table has the new column but not the old one.
  // backupManager.js builds the restore-in-place live state with `status`.
  legacyAliases: { match_live_state: { status: 'match_status' } },
  // Columns only the server writes (db/005, db/007): dropped from a backup's match row.
  serverOnlyColumns: ['created_by', 'closed_at', 'closed_by', 'official_game_exempt', 'tournament_match_id'],
  // Statuses that close a non-test match (db/007's trigger); a restore sets them last.
  closingStatuses: ['approved', 'final'],
  closingPlaceholderStatus: 'ended',
  // Never in the match that restore-by-pin returns (closed_at stays).
  restoreByPinHidden: ['created_by', 'closed_by', 'official_game_exempt'],
  // Only the key columns travel in the DELETE changes of a restore.
  deleteChangeColumns: ['id', 'external_id', 'match_id'],
  // restore-by-pin: per caller and game number, and per caller across all game numbers.
  pinAttempts: { max: 5, windowMs: 10 * 60 * 1000, maxKeys: 50000 },
  callerAttempts: { max: 20, windowMs: 10 * 60 * 1000, maxKeys: 50000 }
})

const PIN_RE = /^[A-Za-z0-9]{1,32}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const quote = (name) => '"' + String(name).replace(/"/g, '""') + '"'

// The PIN failure budget across callers (createPinFailureBudget): wrong PINs
// per match and PIN type from every address together, and per PIN-only search
// (one PIN type of every live match), in its window; past them those PIN
// checks are refused for PIN_LOCK_MS. Far above what real typos reach: a
// match's referee mistyping its PIN a few times, a hall of tablets.
export const PIN_MATCH_FAILURE_MAX = 30
export const PIN_SEARCH_FAILURE_MAX = 100
export const PIN_LOCK_MS = 10 * 60 * 1000
// Keys (match and PIN type) the budget holds at once; a full table refuses new ones
export const PIN_LOCK_KEYS = 100000

/**
 * What a PIN check compares against, the scope of createPinFailureBudget:
 *   search  a PIN looked up among every live match (validate-connection-pin
 *           without a match, the relay's validate-pin): that PIN type of the sport
 *   match   the PINs of one match: one PIN type (validate-connection-pin's
 *           types, 'game'), or 'all' (any of its PINs, matchAccess
 *           pinGrantsAccess: the types compared are passed as `kinds`)
 */
export const pinScope = {
  search: (sport, type) => `any:${sport}:${String(type).slice(0, 20)}`,
  match: (matchKey, kind = 'all') => `m:${kind}:${String(matchKey).slice(0, 200)}`
}
const MATCH_SCOPE_RE = /^m:([^:]+):([\s\S]+)$/
const matchGroup = (matchKey) => String(matchKey).slice(0, 200)

/**
 * Fixed-window attempt limiter with a bounded key map.
 * - `isLimited(key)` counts one attempt and says whether the key is over the limit.
 * - `refund(key)` takes one attempt back (a successful lookup), `reset(key)` forgets the key.
 * Expired windows are pruned at most once a minute (or once per window, if shorter).
 * When the map is full the oldest windows are evicted first (Map insertion order),
 * so memory stays bounded and a request never walks the whole map.
 */
export function createAttemptLimiter ({ max = 5, windowMs = 600000, maxKeys = 50000 } = {}) {
  const hits = new Map()
  const pruneEveryMs = Math.min(windowMs, 60000)
  let lastPrune = Date.now()
  function prune (now) {
    lastPrune = now
    for (const [k, e] of hits) {
      if (now - e.start <= windowMs) break // insertion order = window start order
      hits.delete(k)
    }
  }
  return {
    isLimited (key) {
      const now = Date.now()
      if (now - lastPrune >= pruneEveryMs) prune(now)
      let e = hits.get(key)
      if (e && now - e.start > windowMs) { hits.delete(key); e = undefined }
      if (!e) {
        while (hits.size >= maxKeys) hits.delete(hits.keys().next().value)
        e = { count: 0, start: now }
        hits.set(key, e)
      }
      e.count++
      return e.count > max
    },
    refund (key) {
      const e = hits.get(key)
      if (e && e.count > 0) e.count--
    },
    reset (key) { hits.delete(key) },
    get size () { return hits.size }
  }
}

/**
 * Wrong PINs per key from every caller, with a lock (createPinFailureBudget's
 * counters across callers). A key is a group (a match key) and a kind (its
 * PIN type). `max` attempts counted within `windowMs` refuse the key; the
 * first refusal starts its lock (`lockMs`, one onLock call). `begin(keys)`
 * counts one attempt for each key up front, or none when one of them refuses
 * or a new key does not fit: at most `maxKeys` keys, expired ones pruned
 * first, a full table refuses new keys and never forgets a count or a lock.
 * `refund(keys)` takes an attempt back (not from a lock); a key refunded to
 * nothing is dropped.
 */
function createLockTable ({ max, windowMs, lockMs, maxKeys, now, onLock }) {
  const groups = new Map() // group -> Map(kind -> { count, start, until })
  let size = 0
  let lastPrune = now()
  const pruneEveryMs = Math.min(windowMs, 60000)
  const expired = (e, t) => (e.until ? t >= e.until : t - e.start > windowMs)
  function drop (group, kind) {
    const g = groups.get(group)
    if (!g || !g.delete(kind)) return
    size--
    if (g.size === 0) groups.delete(group)
  }
  function prune (t) {
    lastPrune = t
    for (const [group, g] of groups) {
      for (const [kind, e] of g) {
        if (expired(e, t)) {
          g.delete(kind)
          size--
        }
      }
      if (g.size === 0) groups.delete(group)
    }
  }
  // The live entry of a key (an expired one is dropped)
  function entry (group, kind, t) {
    const e = groups.get(group)?.get(kind)
    if (e && expired(e, t)) {
      drop(group, kind)
      return undefined
    }
    return e
  }
  function refusing (group, kind, t) {
    const e = entry(group, kind, t)
    if (!e) return false
    if (e.until) return true
    if (e.count < max) return false
    e.until = t + lockMs
    onLock(group, kind, e.count)
    return true
  }
  return {
    refusing (group, kind) { return refusing(group, kind, now()) },
    begin (keys) {
      const t = now()
      if (t - lastPrune >= pruneEveryMs) prune(t)
      if (keys.some(([group, kind]) => refusing(group, kind, t))) return false
      const fresh = keys.filter(([group, kind]) => !groups.get(group)?.has(kind)).length
      if (fresh > 0 && size + fresh > maxKeys) {
        prune(t)
        if (size + fresh > maxKeys) return false
      }
      for (const [group, kind] of keys) {
        let g = groups.get(group)
        if (!g) {
          g = new Map()
          groups.set(group, g)
        }
        let e = g.get(kind)
        if (!e) {
          e = { count: 0, start: t, until: 0 }
          g.set(kind, e)
          size++
        }
        e.count++
      }
      return true
    },
    refund (keys) {
      const t = now()
      for (const [group, kind] of keys) {
        const e = entry(group, kind, t)
        if (!e || e.until) continue
        e.count--
        if (e.count <= 0) drop(group, kind)
      }
    },
    forget (group, kinds) { for (const kind of kinds) drop(group, kind) },
    has (group) { return groups.has(group) },
    get size () { return size }
  }
}

/**
 * The brute-force budget of the server's PIN checks: wrong PINs per address
 * bucket (`ipKey`, IPv6 by /64) AND scope, where the scope names what a check
 * compares against (one match's PINs, or one PIN type of every live match),
 * with a larger ceiling per address across all scopes. Same shape as
 * restore-by-pin's limits (per caller and game number, per caller).
 *
 * One limit per address alone locked a whole hall (every tablet behind one
 * venue NAT) out of every PIN check, right PINs included, after about ten
 * typos on one tablet: the bench and a reloading referee of another court, the
 * scoreboard re-proving its own match, a roster upload's wrong PINs the
 * referee connect. Per scope, a run of wrong PINs locks only what was being
 * guessed, and still for the right PIN too (no guessing oracle); the ceiling
 * keeps a sprayer from adding up fresh scopes.
 *
 * - `isLimited(ipKey, scope)` counts one attempt up front (parallel guesses
 *   cannot all slip through) and says whether nothing may be compared. A
 *   refused attempt does not count toward the ceiling (nothing was compared).
 * - `refund(ipKey, scope)` takes the attempt back (a right PIN, or no PIN
 *   compared).
 * - `{ scopeOnly: true }` (both, alike): the address's ceiling is neither
 *   asked nor counted, only the scope's limit. For a check the server trusts
 *   beyond the PIN: the scoreboard of the device the database names as the
 *   match's scorer, re-proving its own match on the relay (server.js
 *   verifyRelayClaim), was refused once a hall had spent the ceiling on
 *   other PINs, and its referee and benches froze.
 * - `repeated(ipKey, scope, pin, opts?)` after a WRONG PIN: true, and the
 *   attempt is refunded (with `opts`, as refund), when the same PIN already
 *   failed in this scope within the window; else it is remembered (as a
 *   hash). The same wrong PIN tried again is no new guess: the apps check a
 *   typed PIN twice (the backend, then the relay), and one typo used to cost
 *   two.
 *
 * Across callers (every address together): limits per address alone did not
 * hold against guesses spread over many addresses (an IPv6 /48 holds 65,536
 * /64 buckets). Two more counters, kept in the same calls:
 * - per match and PIN type (scope `m:<type>:<match>`; 'all' counts each of
 *   `kinds`): `matchMax` wrong PINs within the window refuse that PIN type of
 *   that match, from every address and the right PIN too, for `lockMs`, with
 *   one `log` line per lock. The match's other PIN types and every other
 *   match go on; match tokens already issued are not PIN checks.
 *   `openKinds(match, kinds)` / `locked(match, kind)`: the types not refused
 *   now (a check of several types leaves the locked ones out, a PIN-only
 *   search skips a locked match). `pinChanged(match, kinds)`: the scorer set
 *   a new PIN, its counter starts again (the lock is lifted). `tracks(match)`:
 *   anything counted for the match. `matchLimited(pairs)` /
 *   `matchRefund(pairs)` ([match, type] pairs): the same counters alone, for
 *   callers with limits per address of their own (claim) or a count to give
 *   back (the named match does not exist: nothing to guess).
 *   `{ across: pairs }` (isLimited, refund, repeated alike): the [match,
 *   type] pairs counted across callers in place of what the scope names, for
 *   a check that compares the PINs of other matches than its scope's (the
 *   relay's database check of a scoreboard claim: the rows the synced match
 *   names, not the room key the caller picked).
 * - per PIN-only search (scope `any:<sport>:<type>`): `searchMax` wrong PINs
 *   within the window refuse only those lookups, never one that names its
 *   match, so nobody can stop PIN entry for named matches league-wide.
 * - per game number of restore-by-pin (`gameLimited(gameN)` /
 *   `gameRefund(gameN)`): `matchMax` wrong PINs within the window refuse
 *   restore-by-pin of that game number only. One guess there is compared
 *   with every match of the game number, so it is counted once for the game
 *   number, not against each match: counted per match, a few wrong guesses
 *   locked the game PIN of every match with that number for the scorer's
 *   own relay reconnects too.
 * `scopeOnly` checks are neither refused nor counted there (the server
 * trusts them beyond the PIN). In memory, at most `lockKeys` keys per
 * counter: a full table refuses new keys, it never forgets a count or a lock
 * to make room (expired ones go first; a key refunded to nothing is dropped).
 */
export function createPinFailureBudget ({
  max = 20, ipMax = 60, windowMs = 600000, maxKeys = 50000,
  matchMax = PIN_MATCH_FAILURE_MAX, searchMax = PIN_SEARCH_FAILURE_MAX, lockMs = PIN_LOCK_MS,
  lockKeys = PIN_LOCK_KEYS, log = (line) => console.warn(line), now = Date.now
} = {}) {
  const scoped = createAttemptLimiter({ max, windowMs, maxKeys })
  const total = createAttemptLimiter({ max: ipMax, windowMs, maxKeys })
  const wrong = new Map() // hash of ipKey|scope|pin -> time it failed (insertion order = time order)
  const scopeKey = (ipKey, scope) => `${ipKey}|${scope}`
  const minutes = (ms) => Math.max(1, Math.round(ms / 60000))
  // Match keys and PIN types come from the request: identifier characters only in the log
  const label = (v) => String(v).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || '-'
  const matches = createLockTable({
    max: matchMax, windowMs, lockMs, maxKeys: lockKeys, now,
    onLock: (match, kind, n) => log(`[PIN] match ${label(match)}: ${n} wrong ${label(kind)} PINs from all callers within ${minutes(windowMs)} min; its ${label(kind)} PIN checks are refused for ${minutes(lockMs)} min (match tokens already issued keep working)`)
  })
  const searches = createLockTable({
    max: searchMax, windowMs, lockMs, maxKeys: lockKeys, now,
    onLock: (_, kind, n) => log(`[PIN] ${n} wrong ${label(kind)} PINs in lookups without a match from all callers within ${minutes(windowMs)} min; those lookups are refused for ${minutes(lockMs)} min (lookups that name their match are not affected)`)
  })
  const games = createLockTable({
    max: matchMax, windowMs, lockMs, maxKeys: lockKeys, now,
    onLock: (gameN, _, n) => log(`[PIN] game number ${label(gameN)}: ${n} wrong game PINs in restore-by-pin from all callers within ${minutes(windowMs)} min; restore-by-pin of that game number is refused for ${minutes(lockMs)} min (the other PIN checks of its matches are not affected)`)
  })
  const gameKeys = (gameN) => [[String(gameN).slice(0, 20), 'restore']]
  // The counters across callers of a scope: { table, keys: [group, kind][] }, or null
  function acrossOf (scope, kinds, across) {
    if (Array.isArray(across)) return { table: matches, keys: pairsOf(across) }
    const s = String(scope)
    if (s.startsWith('any:')) return { table: searches, keys: [['search', s.slice(4)]] }
    const m = MATCH_SCOPE_RE.exec(s)
    if (!m) return null
    const list = m[1] === 'all' ? [...new Set(Array.isArray(kinds) ? kinds.map(String) : [])] : [m[1]]
    return { table: matches, keys: list.map((kind) => [m[2], kind]) }
  }
  const pairsOf = (pairs) => [...new Map((Array.isArray(pairs) ? pairs : []).map(([match, kind]) => {
    const key = [matchGroup(match), String(kind)]
    return [key.join('\n'), key]
  })).values()]
  const budget = {
    isLimited (ipKey, scope, { scopeOnly = false, kinds, across } = {}) {
      if (!scopeOnly && total.isLimited(ipKey)) {
        total.refund(ipKey)
        return true
      }
      if (scoped.isLimited(scopeKey(ipKey, scope))) {
        if (!scopeOnly) total.refund(ipKey)
        return true
      }
      const counters = scopeOnly ? null : acrossOf(scope, kinds, across)
      if (counters && !counters.table.begin(counters.keys)) {
        scoped.refund(scopeKey(ipKey, scope))
        total.refund(ipKey)
        return true
      }
      return false
    },
    refund (ipKey, scope, { scopeOnly = false, kinds, across } = {}) {
      scoped.refund(scopeKey(ipKey, scope))
      if (scopeOnly) return
      total.refund(ipKey)
      const counters = acrossOf(scope, kinds, across)
      if (counters) counters.table.refund(counters.keys)
    },
    matchLimited (pairs) { return !matches.begin(pairsOf(pairs)) },
    matchRefund (pairs) { matches.refund(pairsOf(pairs)) },
    gameLimited (gameN) { return !games.begin(gameKeys(gameN)) },
    gameRefund (gameN) { games.refund(gameKeys(gameN)) },
    openKinds (match, kinds) { return kinds.filter((kind) => !matches.refusing(matchGroup(match), String(kind))) },
    locked (match, kind) { return matches.refusing(matchGroup(match), String(kind)) },
    pinChanged (match, kinds) { matches.forget(matchGroup(match), kinds.map(String)) },
    tracks (match) { return matches.has(matchGroup(match)) },
    tracksAny () { return matches.size > 0 },
    repeated (ipKey, scope, pin, opts = {}) {
      const now = Date.now()
      for (const [k, at] of wrong) {
        if (now - at <= windowMs) break
        wrong.delete(k)
      }
      const k = createHash('sha256').update(`${scopeKey(ipKey, scope)}|${String(pin)}`).digest('base64url')
      const at = wrong.get(k)
      if (at !== undefined && now - at <= windowMs) {
        budget.refund(ipKey, scope, opts)
        return true
      }
      while (wrong.size >= maxKeys) wrong.delete(wrong.keys().next().value)
      wrong.set(k, now)
      return false
    }
  }
  return budget
}

class RestoreAbort extends Error {
  constructor (step, result) {
    super(`restore failed at ${step}`)
    this.step = step
    this.result = result
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function errorBody (status, code, message, details) {
  const error = { message, code }
  if (details) error.details = details
  return { status, body: { data: null, error } }
}

/**
 * @param {ReturnType<import('./pgQuery.js').createPgQuery>} db
 * @param {object} [options]  overrides of RESTORE_DEFAULTS, plus `logger`,
 *   `pinHasher` (lib/pinHash.js) and `pinBudget` (createPinFailureBudget; a
 *   budget of its own when left out)
 */
export function createMatchRestore (db, options = {}) {
  const cfg = { ...RESTORE_DEFAULTS, ...options }
  const log = options.logger || console
  // lib/pinHash.js hasher; without one PINs are stored and compared as they are.
  const pins = options.pinHasher || {
    enabled: false,
    candidates: (kind, pin) => [String(pin)],
    matches: (kind, pin, stored) => {
      const a = Buffer.from(String(pin ?? '').trim(), 'utf8')
      const b = Buffer.from(String(stored ?? '').trim(), 'utf8')
      return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
    },
    hashMatchRow: (row) => row
  }
  const pinLimiter = createAttemptLimiter(cfg.pinAttempts)
  const callerLimiter = createAttemptLimiter(cfg.callerAttempts)
  // Wrong game PINs per match across callers: the server's budget, shared
  // with every other PIN check of the match (server.js pinFailureLimiter)
  const pinBudget = options.pinBudget || createPinFailureBudget({ log: (line) => log.warn?.(line) })

  /**
   * Keep only the keys that are columns of `table` (renaming legacy keys first)
   * and record the dropped ones. Old backups and old bundles send extra keys;
   * one of them must not roll back the whole restore.
   */
  function cleanRow (cat, table, row, dropped, label) {
    const t = cat.tables.get(table)
    const aliases = cfg.legacyAliases?.[table] || {}
    const out = {}
    for (const [key, value] of Object.entries(row)) {
      let k = key
      if (!t.columns.has(k) && aliases[k] && t.columns.has(aliases[k]) && !(aliases[k] in row)) k = aliases[k]
      if (t.columns.has(k)) out[k] = value
      else (dropped[label] ||= new Set()).add(key)
    }
    return out
  }

  function duplicateExternalId (rows, ext) {
    const seen = new Set()
    for (const r of rows) {
      const v = r[ext]
      if (v == null) continue
      if (seen.has(v)) return String(v).slice(0, 120)
      seen.add(v)
    }
    return null
  }

  // The closing status of a restored approved/final backup, its last step
  function closeMatch (run, matchUuid, closingStatus) {
    return run('close', {
      table: cfg.matchTable,
      action: 'update',
      params: { data: { status: closingStatus }, filters: [{ type: 'eq', column: cfg.matchId, value: matchUuid }] }
    })
  }

  // payload.rekey -> { sets: Map(new -> old), events: Map(new -> old) }, or
  // null (absent or not an object: a plain restore)
  function rekeyOf (raw) {
    if (!isPlainObject(raw)) return null
    const mapOf = (o) => new Map(isPlainObject(o)
      ? Object.entries(o).filter(([to, from]) => typeof from === 'string' && from && from.length <= 200 && from !== to)
      : [])
    return { sets: mapOf(raw.sets), events: mapOf(raw.events) }
  }

  /**
   * The re-key of a hand-over (payload.rekey): each row of `rows` whose new
   * external_id names an old one is renamed in place, the row keeps
   * everything else (voided, edited, its id); a row already under the new id
   * is replaced (the device's own row, as its next write of it would). A
   * row whose old one is gone, or that names none, is written under its id.
   * Rows the payload does not name are left alone. Returns the rows renamed.
   * In two steps (each row to a parked name, then to its new one): the
   * device's new ids continue its own counter and may be old ids of this
   * same match (cloud e:1..e:5 to e:3..e:7), and renaming one by one deleted
   * rows still to be moved and moved others twice.
   */
  async function rekeyRows (client, run, table, rows, from, matchUuid, withFk) {
    if (!rows.length) return 0
    const byMatch = { type: 'eq', column: cfg.childFk, value: matchUuid }
    const keys = [...new Set(rows.flatMap(r => [r.external_id, from.get(r.external_id)]).filter(k => typeof k === 'string'))]
    // voided events included: what is there, not what is shown
    const { rows: found } = await client.query(
      `SELECT external_id FROM ${quote(db.config.schema || 'public')}.${quote(table)} WHERE ${quote(cfg.childFk)} = $1 AND external_id = ANY($2::text[])`,
      [matchUuid, keys])
    const there = new Set(found.map(r => r.external_id))
    const renames = rows.filter(r => there.has(from.get(r.external_id)))
    const rename = (step, fromKey, toKey) => run(`rekey ${table} ${step}`, {
      table,
      action: 'update',
      params: { data: { external_id: toKey }, filters: [byMatch, { type: 'eq', column: 'external_id', value: fromKey }] }
    })
    // (the match's own prefix and separator: inside the id scope guard)
    const parked = (key) => `${key}#rekey`
    for (const r of renames) await rename('park', from.get(r.external_id), parked(r.external_id))
    // A row still under a new id is none of the rows moved: the device's replaces it
    const moved = new Set(renames.map(r => from.get(r.external_id)))
    const taken = renames.map(r => r.external_id).filter(k => there.has(k) && !moved.has(k))
    if (taken.length) {
      await run(`rekey ${table}`, { table, action: 'delete', params: { filters: [byMatch, { type: 'in', column: 'external_id', value: taken }] } },
        { changeColumns: cfg.deleteChangeColumns })
    }
    for (const r of renames) await rename('move', parked(r.external_id), r.external_id)
    const rest = rows.filter(r => !there.has(from.get(r.external_id)))
    if (rest.length) {
      await run(table, { table, action: 'upsert', params: { data: rest.map(withFk), onConflict: 'external_id' } })
    }
    return renames.length
  }

  async function restoreMatch (payload, { proto, matchOwner, actorId } = {}) {
    if (!isPlainObject(payload)) return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request')
    const { match, sets = [], events = [], liveState = null } = payload
    const rekey = rekeyOf(payload.rekey)
    const minProto = db.config.minWriteProto
    if (minProto != null && !(Number(proto) >= minProto)) {
      return errorBody(426, 'OV_CLIENT_TOO_OLD', 'This app version is too old to write. Please reload the app.')
    }
    if (!isPlainObject(match) || typeof match[cfg.matchKey] !== 'string' || !match[cfg.matchKey] || match[cfg.matchKey].length > 200) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', `match.${cfg.matchKey} is required`)
    }
    if (!Array.isArray(sets) || !sets.every(isPlainObject) || sets.length > cfg.maxSets) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', 'sets must be an array of objects')
    }
    if (!Array.isArray(events) || !events.every(isPlainObject) || events.length > cfg.maxEvents) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', 'events must be an array of objects')
    }
    if (liveState != null && !isPlainObject(liveState)) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', 'liveState must be an object')
    }

    try {
      const cat = await db.ensureCatalog()
      const has = (t) => cat.tables.has(t) && db.config.allowedTables.includes(t)
      for (const t of [cfg.matchTable, ...(sets.length ? [cfg.setsTable] : []), ...(events.length ? [cfg.eventsTable] : []), ...(liveState ? [cfg.liveStateTable] : [])]) {
        if (!has(t)) return errorBody(400, '42P01', 'Database operation failed', `${t} is not available`)
      }

      // Rows as they will be written: unknown keys dropped, server keys replaced.
      const dropped = {}
      const { id: _ignored, ...matchIn } = match
      const matchRow = cleanRow(cat, cfg.matchTable, matchIn, dropped, 'match')
      // A backup without the PINs (or with them nulled) keeps the stored ones;
      // JSON secrets (connection_pins) are merged into the stored object below.
      const matchSecrets = db.secretColumnsOf(cfg.matchTable)
      for (const k of matchSecrets) {
        if (k in matchRow && (matchRow[k] == null || matchRow[k] === '')) delete matchRow[k]
      }
      // The creator, the closing stamp and the exemption are the server's to set
      // (pgQuery's ownership guard, db/007's triggers, the admin), never a backup's.
      for (const k of cfg.serverOnlyColumns) delete matchRow[k]
      if (db.config.ownership?.ownerColumn) delete matchRow[db.config.ownership.ownerColumn]
      const storedMatchRow = pins.hashMatchRow(matchRow)
      // A closing status goes in last (after the children), see the header.
      const closingStatus = matchRow.test !== true && cfg.closingStatuses.includes(matchRow.status) ? matchRow.status : null
      const upsertMatchRow = closingStatus ? { ...storedMatchRow, status: cfg.closingPlaceholderStatus } : storedMatchRow
      const sportType = typeof matchRow.sport_type === 'string' && matchRow.sport_type ? matchRow.sport_type : cfg.defaultSportType
      const childRows = (table, rows, label) => {
        const hasSport = cat.tables.get(table).columns.has('sport_type')
        return rows.map(r => {
          const { id: _id, ...rest } = r
          const row = cleanRow(cat, table, rest, dropped, label)
          if (hasSport && row.sport_type == null && sportType) row.sport_type = sportType
          return row
        })
      }
      const setRows = sets.length ? childRows(cfg.setsTable, sets, 'sets') : []
      const eventRows = events.length ? childRows(cfg.eventsTable, events, 'events') : []
      const liveRow = liveState ? childRows(cfg.liveStateTable, [liveState], 'liveState')[0] : null
      for (const [label, rows] of [['sets', setRows], ['events', eventRows]]) {
        const dup = duplicateExternalId(rows, 'external_id')
        if (dup) return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', `${label}: duplicate external_id "${dup}"`)
      }
      const droppedOut = Object.fromEntries(Object.entries(dropped).map(([k, v]) => [k, [...v].sort()]))
      if (Object.keys(droppedOut).length) {
        log.warn?.(`[matchRestore] ${match[cfg.matchKey].slice(0, 80)}: dropped unknown keys ${JSON.stringify(droppedOut).slice(0, 300)}`)
      }

      const changes = []
      const out = await db.withTransaction(async (client) => {
        if (typeof actorId === 'string' && UUID_RE.test(actorId)) {
          await client.query("SELECT set_config('ov.user_id', $1, true)", [actorId])
        }
        const run = async (step, request, extra = {}) => {
          const r = await db.runQuery(request, { client, proto, collectChanges: true, ...(matchOwner ? { matchOwner } : {}), ...extra })
          if (r.body.error) throw new RestoreAbort(step, r)
          if (r.changes) changes.push(...r.changes)
          return r
        }
        const up = await run('match', {
          table: cfg.matchTable,
          action: 'upsert',
          params: { data: upsertMatchRow, onConflict: cfg.matchKey, returning: cfg.matchId, single: true }
        }, { mergeOnUpsert: matchSecrets })
        const matchUuid = up.body.data[cfg.matchId]
        const withFk = (row) => ({ ...row, [cfg.childFk]: matchUuid })
        if (rekey) {
          const rekeyed = (await rekeyRows(client, run, cfg.setsTable, setRows, rekey.sets, matchUuid, withFk)) +
            (await rekeyRows(client, run, cfg.eventsTable, eventRows, rekey.events, matchUuid, withFk))
          if (closingStatus) await closeMatch(run, matchUuid, closingStatus)
          return { id: matchUuid, counts: { sets: setRows.length, events: eventRows.length, liveState: 0, rekeyed }, dropped: droppedOut }
        }
        // DELETE changes carry only the keys, so subscribers drop the old rows.
        const del = (table) => run(`delete ${table}`, {
          table, action: 'delete', params: { filters: [{ type: 'eq', column: cfg.childFk, value: matchUuid }] }
        }, { changeColumns: cfg.deleteChangeColumns })
        if (has(cfg.eventsTable)) await del(cfg.eventsTable)
        if (has(cfg.setsTable)) await del(cfg.setsTable)
        if (has(cfg.liveStateTable)) await del(cfg.liveStateTable)

        const counts = { sets: 0, events: 0, liveState: 0 }
        if (setRows.length) {
          const r = await run('sets', { table: cfg.setsTable, action: 'insert', params: { data: setRows.map(withFk), count: 'exact' } })
          counts.sets = r.body.count
        }
        if (eventRows.length) {
          const r = await run('events', { table: cfg.eventsTable, action: 'insert', params: { data: eventRows.map(withFk), count: 'exact' } })
          counts.events = r.body.count
        }
        if (liveRow) {
          const r = await run('liveState', { table: cfg.liveStateTable, action: 'insert', params: { data: withFk(liveRow), count: 'exact' } })
          counts.liveState = r.body.count
        }
        if (closingStatus) await closeMatch(run, matchUuid, closingStatus)
        return { id: matchUuid, counts, dropped: droppedOut }
      }, { statementTimeoutMs: cfg.statementTimeoutMs })
      return { status: 200, body: { data: out, error: null }, changes }
    } catch (err) {
      if (err instanceof RestoreAbort) {
        const { status, body } = err.result
        const error = { ...body.error, details: `${err.step}: ${body.error.details || body.error.code}` }
        log.warn?.(`[matchRestore] rolled back at ${err.step}: ${body.error.code}`)
        return { status, body: { data: null, error } }
      }
      // Catalog not loaded, BEGIN/COMMIT failing (serialization, connection) ...
      const r = db.toErrorResult(err, { action: 'restore', table: cfg.matchTable })
      return { status: r.status, body: r.body }
    }
  }

  /**
   * Make `userId` an editor of the match (unless it created it). Never throws;
   * returns 'creator' | 'editor' | null (failed, logged).
   */
  async function addEditor (matchUuid, userId, via) {
    const own = db.config.ownership
    if (!own || typeof userId !== 'string' || !userId) return null
    const table = (name) => `${quote(db.config.schema || 'public')}.${quote(name)}`
    try {
      const r = await db.pool.query(
        `WITH m AS (SELECT ${quote(own.ownerColumn)} AS owner FROM ${table(own.parent)} WHERE ${quote(own.key)} = $1),
              ins AS (INSERT INTO ${table(own.editors.table)} (${quote(own.editors.matchColumn)}, ${quote(own.editors.userColumn)}, granted_via)
                      SELECT $1, $2::uuid, $3 WHERE NOT EXISTS (SELECT 1 FROM m WHERE owner = $2::uuid)
                      ON CONFLICT DO NOTHING RETURNING 1)
         SELECT EXISTS (SELECT 1 FROM m WHERE owner = $2::uuid) AS creator`,
        [matchUuid, userId, via])
      return r.rows[0]?.creator ? 'creator' : 'editor'
    } catch (err) {
      log.warn?.(`[matchRestore] could not add an editor: ${err.code || err.message}`)
      return null
    }
  }

  /**
   * Highest `<n>` of the match's `<ext>:s:<n>` set and `<ext>:e:<n>` event ids
   * (voided events and event_revisions too): { set, event }, null when none.
   * Never throws: without it the device keeps the ids it imported (null).
   */
  async function idFloor (cat, matchUuid, ext) {
    const table = (name) => `${quote(db.config.schema || 'public')}.${quote(name)}`
    const n = (col) => `substr(${col}, length($2::text) + 4)`
    const own = (col, kind) => `left(${col}, length($2::text) + 3) = $2::text || '${kind}' AND ${n(col)} ~ '^[0-9]{1,15}$'`
    const maxOf = (tbl, col, kind) => `SELECT ${n(col)}::bigint AS n FROM ${table(tbl)} WHERE ${quote(cfg.childFk)} = $1 AND ${own(col, kind)}`
    const eventSources = [maxOf(cfg.eventsTable, 'external_id', ':e:')]
    if (cat.tables.has('event_revisions')) eventSources.push(maxOf('event_revisions', 'event_external_id', ':e:'))
    try {
      const r = await db.pool.query(
        `SELECT (SELECT max(n) FROM (${maxOf(cfg.setsTable, 'external_id', ':s:')}) s) AS "set",
                (SELECT max(n) FROM (${eventSources.join(' UNION ALL ')}) e) AS "event"`,
        [matchUuid, ext])
      const toNum = (v) => (v == null ? null : Number(v))
      return { set: toNum(r.rows[0]?.set), event: toNum(r.rows[0]?.event) }
    } catch (err) {
      log.warn?.(`[matchRestore] could not read the id floor: ${err.code || err.message}`)
      return null
    }
  }

  const tooMany = () => errorBody(429, 'OV_TOO_MANY_ATTEMPTS', 'Too many attempts. Please wait a few minutes before trying again.')

  /** Attempt limits shared by restore-by-pin and claim. Returns a 429 result or null. */
  function overLimit (callerKey, gameKey) {
    if (callerLimiter.isLimited(callerKey) || pinLimiter.isLimited(gameKey)) return tooMany()
    return null
  }

  /**
   * The game PINs of these matches (external_ids) are about to be compared:
   * one attempt each, across callers (pinBudget), counted up front. A 429
   * result when one of them refuses: nothing is compared and the caller's
   * attempt is given back. Else null.
   */
  function overMatchLimit (callerKey, gameKey, matchKeys) {
    if (!pinBudget.matchLimited(matchKeys.map((k) => [k, 'game']))) return null
    callerLimiter.refund(callerKey)
    pinLimiter.refund(gameKey)
    return tooMany()
  }

  /**
   * POST /api/match/claim { externalId, pin }: the caller (signed in) proves
   * the match's game PIN and becomes an editor of it.
   */
  async function claimMatch (input, { userId, limitKey = 'anon' } = {}) {
    if (!isPlainObject(input)) return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request')
    const ext = typeof input.externalId === 'string' ? input.externalId.trim() : ''
    const pin = typeof input.pin === 'number' ? String(input.pin) : (typeof input.pin === 'string' ? input.pin.trim() : '')
    if (!ext || ext.length > 200 || !PIN_RE.test(pin)) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', 'externalId and pin are required')
    }
    const callerKey = String(limitKey)
    const gameKey = `${callerKey}|ext:${ext}`
    const limited = overLimit(callerKey, gameKey)
    if (limited) return limited
    try {
      // The match first, then its game PIN (constant time): a match that
      // does not exist, or has no game PIN, has no PIN to guess and is
      // counted nowhere across callers
      const found = await db.runQuery({
        table: cfg.matchTable,
        action: 'select',
        params: {
          columns: `${cfg.matchId}, ${cfg.pinColumn}`,
          filters: [{ type: 'eq', column: cfg.matchKey, value: ext }],
          limit: 1
        }
      }, { internal: true })
      if (found.body.error) return { status: found.status, body: found.body }
      const stored = found.body.data[0]
      const hasPin = stored?.[cfg.pinColumn] != null && String(stored[cfg.pinColumn]).trim() !== ''
      if (hasPin) {
        const locked = overMatchLimit(callerKey, gameKey, [ext])
        if (locked) return locked
      }
      const row = hasPin && pins.matches('game', pin, stored[cfg.pinColumn]) ? stored : null
      if (!row) return errorBody(404, 'OV_NOT_FOUND', 'No match with this id and game PIN')
      pinBudget.matchRefund([[ext, 'game']])
      pinLimiter.reset(gameKey)
      callerLimiter.refund(callerKey)
      const role = await addEditor(row[cfg.matchId], userId, 'claim')
      if (!role) return errorBody(503, 'OV_DB_UNAVAILABLE', 'Service unavailable')
      return { status: 200, body: { data: { id: row[cfg.matchId], external_id: ext, role }, error: null } }
    } catch (err) {
      const r = db.toErrorResult(err, { action: 'claim', table: cfg.matchTable })
      return { status: r.status, body: r.body }
    }
  }

  async function restoreByPin (input, { limitKey = 'anon', editorUserId = null, takeOver = null } = {}) {
    if (!isPlainObject(input)) return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request')
    const gameN = typeof input.gameN === 'string' && /^\d+$/.test(input.gameN.trim()) ? Number(input.gameN.trim()) : input.gameN
    const pin = typeof input.pin === 'number' ? String(input.pin) : (typeof input.pin === 'string' ? input.pin.trim() : '')
    if (!Number.isInteger(gameN) || gameN < 0 || gameN > 2147483647 || !PIN_RE.test(pin)) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', 'gameN (integer) and pin are required')
    }
    // Per caller across all game numbers first (one guessed PIN cannot be tried
    // against every match), then per caller and game number.
    const callerKey = String(limitKey)
    const gameKey = `${callerKey}|${gameN}`
    const limited = overLimit(callerKey, gameKey)
    if (limited) return limited
    try {
      const cat = await db.ensureCatalog()
      const mt = cat.tables.get(cfg.matchTable)
      if (!mt) return errorBody(400, '42P01', 'Database operation failed')
      const order = mt.columns.has('updated_at') ? [{ column: 'updated_at', ascending: false, nullsFirst: false }]
        : mt.columns.has('created_at') ? [{ column: 'created_at', ascending: false, nullsFirst: false }] : undefined
      // Across callers, one attempt against the game number (pinBudget
      // gameLimited), counted up front: the PIN is compared with every match
      // that carries it. A game number no match has has no PIN to guess and
      // counts nowhere.
      const any = await db.runQuery({
        table: cfg.matchTable,
        action: 'select',
        params: { columns: cfg.matchId, filters: [{ type: 'eq', column: cfg.gameNColumn, value: gameN }], limit: 1 }
      }, { internal: true })
      if (any.body.error) return { status: any.status, body: any.body }
      if (any.body.data.length === 0) return errorBody(404, 'OV_NOT_FOUND', 'Match not found with this ID and PIN')
      if (pinBudget.gameLimited(gameN)) {
        callerLimiter.refund(callerKey)
        pinLimiter.refund(gameKey)
        return tooMany()
      }
      // internal: the only place a secret column is filtered on, and only with exact equality.
      // A few rows: the same game number and PIN on more than one match is rare.
      const found = await db.runQuery({
        table: cfg.matchTable,
        action: 'select',
        params: {
          columns: '*',
          filters: [
            { type: 'eq', column: cfg.gameNColumn, value: gameN },
            { type: 'in', column: cfg.pinColumn, value: pins.candidates('game', pin) }
          ],
          order,
          limit: 5
        }
      }, { internal: true })
      if (found.body.error) return { status: found.status, body: found.body }
      // A match whose game PIN is locked across callers (its own checks: claim,
      // the relay) proves nothing here either: answered as a wrong PIN
      const row = found.body.data.find((r) => !(r[cfg.matchKey] && pinBudget.locked(r[cfg.matchKey], 'game')))
      if (!row) return errorBody(404, 'OV_NOT_FOUND', 'Match not found with this ID and PIN')
      // Only failed guesses count against the caller.
      pinBudget.gameRefund(gameN)
      pinLimiter.reset(gameKey)
      callerLimiter.refund(callerKey)
      const match = { ...row }
      for (const k of db.secretColumnsOf(cfg.matchTable)) {
        for (const key of Object.keys(match)) if (key.toLowerCase() === k) delete match[key]
      }
      const matchUuid = row[cfg.matchId]
      // A signed-in caller who proved the game PIN may now write the match.
      const editor = editorUserId ? await addEditor(matchUuid, editorUserId, 'restore-by-pin') : null
      for (const k of cfg.restoreByPinHidden) delete match[k]
      // The caller scores the match from here on (before the read: a write
      // of the device it leaves is in what is read, or refused after it)
      let scorer = null
      if (typeof takeOver === 'function') {
        try {
          scorer = await takeOver({ id: matchUuid, external_id: row[cfg.matchKey] })
        } catch (err) {
          log.warn?.(`[matchRestore] scoring-device take-over failed: ${err?.code || err?.message}`)
        }
      }
      const byMatch = [{ type: 'eq', column: cfg.childFk, value: matchUuid }]
      const childOrder = (table, cols) => {
        const t = cat.tables.get(table)
        const col = t && cols.find(c => t.columns.has(c))
        return col ? [{ column: col, ascending: true }] : undefined
      }
      const read = async (table, params) => {
        if (!cat.tables.has(table) || !db.config.allowedTables.includes(table)) return { body: { data: params.maybeSingle ? null : [] } }
        const r = await db.runQuery({ table, action: 'select', params: { columns: '*', filters: byMatch, ...params } }, { maxRows: cfg.childRowCap })
        if (r.body.error) throw Object.assign(new Error('child read failed'), { result: r })
        return r
      }
      const [s, e, l, floor] = await Promise.all([
        read(cfg.setsTable, { order: childOrder(cfg.setsTable, ['index']) }),
        read(cfg.eventsTable, { order: childOrder(cfg.eventsTable, ['seq', 'ts', 'id']) }),
        read(cfg.liveStateTable, { maybeSingle: true }),
        idFloor(cat, matchUuid, row[cfg.matchKey])
      ])
      return { status: 200, body: { data: { match, sets: s.body.data, events: e.body.data, liveState: l.body.data, ...(floor ? { idFloor: floor } : {}), ...(editor ? { access: editor } : {}), ...(scorer ? { scorer } : {}) }, error: null } }
    } catch (err) {
      if (err?.result) return { status: err.result.status, body: err.result.body }
      const r = db.toErrorResult(err, { action: 'restore-by-pin', table: cfg.matchTable })
      return { status: r.status, body: r.body }
    }
  }

  return { restoreMatch, restoreByPin, claimMatch, addEditor, pinLimiter, callerLimiter }
}
