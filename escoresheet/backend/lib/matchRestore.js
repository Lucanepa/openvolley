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
 *     Across addresses (options.pinBudget, createPinFailureBudget: the server
 *     passes the budget of all its PIN checks): a wrong PIN for claim is one
 *     attempt against that match's game PIN, the counter every other check of
 *     the match's game PIN shares; a wrong PIN for restore-by-pin is one
 *     attempt against its game number (gameLimited), whatever number of
 *     matches carry it (game numbers repeat across seasons, beach ones in
 *     every tournament): its guesses never lock the game PIN of those matches
 *     for the scorer's own checks. Both are counted per address range of the
 *     caller (limitKey): a range past its share is refused the match's game
 *     PIN (claim) or the game number (restore-by-pin) for a while, the right
 *     PIN too, and restore-by-pin never proves a match whose game PIN is
 *     locked for that range; every other range goes on. `trust` (both): a
 *     caller the server trusts beyond the PIN is not refused by a range lock
 *     (and not counted across addresses): { userId, isAdmin: async () =>
 *     boolean, deviceId } (a signed-in admin, the creator or an editor of the
 *     match, the device the database names as its scorer; trustedFor). A
 *     game number or match that does not exist counts nowhere across
 *     addresses.
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
import { projectAnonDbRows } from './publicColumns.js'

/**
 * The matches columns only the server writes, never a client: the creator
 * (pgQuery's ownership guard), the closing stamps (db/007's triggers), the
 * exemption and release of an admin's release-game (db/040), the database's
 * created_at (part of the official-game key when scheduled_at is empty, so a
 * client must not pick the season through it) and the link to a beach
 * tournament match (db/014). /api/db strips them (server.js WRITE_DENYLIST)
 * and so does a restore (serverOnlyColumns): one list, so the two cannot
 * drift apart again (audit 2611 PERM-10: a restore wrote released_at and
 * created_at, which /api/db refused, and un-released a released duplicate).
 */
export const MATCH_SERVER_ONLY_COLUMNS = Object.freeze(['created_by', 'closed_at', 'closed_by', 'first_closed_at', 'official_game_exempt', 'released_at', 'created_at', 'tournament_match_id'])

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
  // Columns only the server writes (MATCH_SERVER_ONLY_COLUMNS): dropped from a backup's match row.
  serverOnlyColumns: MATCH_SERVER_ONLY_COLUMNS,
  // An event's void and revision count are the server's (db/015: event
  // revisions only; the insert trigger gives a restored event the void its
  // match's revisions recorded), never a backup's.
  eventServerColumns: ['voided_at', 'voided_by', 'void_reason', 'rev'],
  // Every restore is in the admin audit log (actor, device, counts before and after)
  auditAction: 'match.restore',
  // Statuses that close a non-test match (db/007's trigger); a restore sets them last.
  closingStatuses: ['approved', 'final'],
  closingPlaceholderStatus: 'ended',
  // Never in the match that restore-by-pin returns (closed_at stays).
  restoreByPinHidden: ['created_by', 'closed_by', 'official_game_exempt'],
  // Set when a match closes (db/007): from then on its game PIN is retired.
  closedColumn: 'closed_at',
  closedByColumn: 'closed_by',
  // ...except for claim, for as long as a shared tablet's next account may
  // still send the approval's PDF (lib/scoresheets.js LATE_EDITOR_WINDOW_MS)
  closedClaimWindowMs: 6 * 60 * 60 * 1000,
  // Only the key columns travel in the DELETE changes of a restore.
  deleteChangeColumns: ['id', 'external_id', 'match_id'],
  // restore-by-pin: per caller and game number, and per caller across all game numbers.
  pinAttempts: { max: 5, windowMs: 10 * 60 * 1000, maxKeys: 50000 },
  callerAttempts: { max: 20, windowMs: 10 * 60 * 1000, maxKeys: 50000 }
})

const PIN_RE = /^[A-Za-z0-9]{1,32}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const quote = (name) => '"' + String(name).replace(/"/g, '""') + '"'

// The PIN failure budget across callers (createPinFailureBudget). Wrong PINs
// are counted per match and PIN type, per game number of restore-by-pin and
// per PIN-only search (one PIN type of every live match), each in its window:
// - per address range of the caller (pinRangesOf: the IPv4 address and its
//   /24, the IPv6 /64, /56 and /48). A range past its share is refused that
//   check for PIN_LOCK_MS, the right PIN too (the guesser learns nothing);
//   every other range goes on, and the right PIN from there passes.
// - from every address together: PIN_MATCH_FAILURE_MAX (a match and PIN
//   type, a game number) or PIN_SEARCH_FAILURE_MAX (a PIN-only search) wrong
//   PINs raise one ops alert per window. Nobody is refused for it: 30 wrong
//   guesses from two addresses used to refuse the right PIN of a match's
//   referee, benches and scorer everywhere, and 100 every OpenBeach referee
//   (audit 2026-11, SEC-05 / SEC-06; owner decision: lock the guessers only).
// The share of a range: PIN_RANGE_FAILURE_MAX for an address (IPv4, IPv6
// /64), one and a half times that for an IPv6 /56, twice that for an IPv4
// /24 and an IPv6 /48 (a wider range holds more callers). Far above what
// real typos reach: a match's referee mistyping its PIN a few times, a hall
// of tablets behind one address.
export const PIN_MATCH_FAILURE_MAX = 30
export const PIN_SEARCH_FAILURE_MAX = 100
export const PIN_RANGE_FAILURE_MAX = 20
export const PIN_LOCK_MS = 10 * 60 * 1000
// Keys the budget holds at once per table; a full table counts no new key
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

const V4_KEY_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const V6_KEY_RE = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4})::\/64$/i

/**
 * The address ranges a caller's wrong PINs are counted in, narrowest first,
 * each with its share (`max`): `ipKey` is lib/auth.js ipBucketKey's key (an
 * IPv4 address, an IPv6 /64). IPv4: the address (`share`) and its /24 (twice
 * that); IPv6: the /64 (`share`), its /56 (one and a half times) and its /48
 * (twice). Any other key is one range of its own.
 * @returns {{ range: string, max: number }[]}
 */
export function pinRangesOf (ipKey, share = PIN_RANGE_FAILURE_MAX) {
  const key = String(ipKey ?? '').slice(0, 64) || 'unknown'
  const v4 = V4_KEY_RE.exec(key)
  if (v4) return [{ range: key, max: share }, { range: `${v4[1]}.${v4[2]}.${v4[3]}.0/24`, max: share * 2 }]
  const v6 = V6_KEY_RE.exec(key)
  if (v6) {
    const g = v6.slice(1, 5).map((x) => parseInt(x, 16).toString(16))
    const g56 = (parseInt(v6[4], 16) & 0xff00).toString(16)
    return [
      { range: key, max: share },
      { range: `${g[0]}:${g[1]}:${g[2]}:${g56}::/56`, max: Math.ceil(share * 1.5) },
      { range: `${g[0]}:${g[1]}:${g[2]}::/48`, max: share * 2 }
    ]
  }
  return [{ range: key, max: share }]
}

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
 * Counters by key (group, kind, sub) in a fixed window each, with a lock
 * (`until`, set by the caller): createPinFailureBudget's counts across
 * callers. At most `maxKeys` keys: expired ones are pruned at most once a
 * minute and when the table is full, and a full table makes no new key
 * (`touch` answers null). It never forgets a count or a lock to make room.
 */
function createCountTable ({ windowMs, maxKeys, now }) {
  const groups = new Map() // group -> Map(kind -> Map(sub -> { count, start, until }))
  let size = 0
  let lastPrune = now()
  const pruneEveryMs = Math.min(windowMs, 60000)
  const expired = (e, t) => (e.until ? t >= e.until : t - e.start > windowMs)
  function drop (group, kind, sub) {
    const g = groups.get(group)
    const k = g?.get(kind)
    if (!k || !k.delete(sub)) return
    size--
    if (k.size === 0) g.delete(kind)
    if (g.size === 0) groups.delete(group)
  }
  function prune (t) {
    lastPrune = t
    for (const [group, g] of groups) {
      for (const [kind, k] of g) {
        for (const [sub, e] of k) {
          if (!expired(e, t)) continue
          k.delete(sub)
          size--
        }
        if (k.size === 0) g.delete(kind)
      }
      if (g.size === 0) groups.delete(group)
    }
  }
  // The live entry of a key (an expired one is dropped)
  function get (group, kind, sub, t) {
    const e = groups.get(group)?.get(kind)?.get(sub)
    if (e && expired(e, t)) {
      drop(group, kind, sub)
      return undefined
    }
    return e
  }
  return {
    tick (t) { if (t - lastPrune >= pruneEveryMs) prune(t) },
    get,
    // The live entry of a key, made when missing; null when the table is full
    touch (group, kind, sub, t) {
      const e = get(group, kind, sub, t)
      if (e) return e
      if (size >= maxKeys) {
        prune(t)
        if (size >= maxKeys) return null
      }
      let g = groups.get(group)
      if (!g) {
        g = new Map()
        groups.set(group, g)
      }
      let k = g.get(kind)
      if (!k) {
        k = new Map()
        g.set(kind, k)
      }
      const fresh = { count: 0, start: t, until: 0 }
      k.set(sub, fresh)
      size++
      return fresh
    },
    drop,
    forget (group, kinds) {
      const g = groups.get(group)
      if (!g) return
      for (const kind of kinds) {
        const k = g.get(kind)
        if (!k) continue
        size -= k.size
        g.delete(kind)
      }
      if (g.size === 0) groups.delete(group)
    },
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
 *   compared): a right PIN never adds to any count.
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
 * Across addresses: limits per address bucket alone did not hold against
 * guesses spread over many buckets (an IPv6 /48 holds 65,536 /64 buckets).
 * The same calls count three more things a guess is made against:
 * - per match and PIN type (scope `m:<type>:<match>`; 'all' counts each of
 *   `kinds`),
 * - per PIN-only search (scope `any:<sport>:<type>`),
 * - per game number of restore-by-pin (`gameLimited(gameN, ipKey)` /
 *   `gameRefund(gameN, ipKey)`): one guess there is compared with every match
 *   of the game number, so it is counted once for the game number, never
 *   against each match's game PIN (that locked the scorer's own relay
 *   reconnects of every match with the number).
 * Each of them twice:
 * - per address range of the caller (pinRangesOf, `rangeMax`): a range at
 *   its share is refused that check for `lockMs`, the right PIN too, with one
 *   `log` line per lock; the other ranges go on, the right PIN from them
 *   always passes. `openKinds(match, kinds, ipKey)` / `locked(match, kind,
 *   ipKey)`: the types not refused to that caller now (a check of several
 *   types leaves the locked ones out, a PIN-only search skips a match locked
 *   for the caller).
 * - from every address together: `matchMax` (a match and PIN type, a game
 *   number) or `searchMax` (a PIN-only search) within the window raise ONE
 *   ops alert per window and match (game number, PIN-only search of a sport
 *   and PIN type): a `log` line and `alert({ scope, key, type, types, count,
 *   windowMinutes, ranges, otherRanges, message })` (`types`: the PIN types
 *   past it with their counts, `type` their names; `ranges`: the widest
 *   range of each caller counted, with its count; never a PIN). Nobody is
 *   refused for it.
 * `pinChanged(match, kinds)`: the scorer set a new PIN, its counts start
 * again (the locks are lifted). `tracks(match)` / `tracksAny()`: anything
 * counted for the match / for any match. `matchLimited(pairs, ipKey)` /
 * `matchRefund(pairs, ipKey)` ([match, type] pairs): the counts across
 * addresses alone, for callers with limits per address of their own (claim)
 * or a count to give back (the named match does not exist: nothing to
 * guess). `{ across: pairs }` (isLimited, refund, repeated alike): the
 * [match, type] pairs counted in place of what the scope names, for a check
 * that compares the PINs of other matches than its scope's (the relay's
 * database check of a scoreboard claim: the rows the synced match names, not
 * the room key the caller picked).
 * `scopeOnly` checks are neither refused nor counted across addresses (the
 * server trusts them beyond the PIN). In memory, at most `lockKeys` keys per
 * table: a full table counts no new key (the per-address limits still hold)
 * and raises one alert per window; it never forgets a count or a lock to
 * make room (expired ones go first; a key refunded to nothing is dropped).
 */
export function createPinFailureBudget ({
  max = 20, ipMax = 60, windowMs = 600000, maxKeys = 50000,
  matchMax = PIN_MATCH_FAILURE_MAX, searchMax = PIN_SEARCH_FAILURE_MAX, rangeMax = PIN_RANGE_FAILURE_MAX,
  lockMs = PIN_LOCK_MS, lockKeys = PIN_LOCK_KEYS, log = (line) => console.warn(line), alert = null, now = Date.now
} = {}) {
  const scoped = createAttemptLimiter({ max, windowMs, maxKeys })
  const total = createAttemptLimiter({ max: ipMax, windowMs, maxKeys })
  const wrong = new Map() // hash of ipKey|scope|pin -> time it failed (insertion order = time order)
  const scopeKey = (ipKey, scope) => `${ipKey}|${scope}`
  const minutes = (ms) => Math.max(1, Math.round(ms / 60000))
  // Match keys and PIN types come from the request: identifier characters only in the log
  const label = (v) => String(v).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || '-'
  const rangeLabel = (v) => String(v).replace(/[^A-Za-z0-9_.:/-]/g, '').slice(0, 64) || '-'
  // PIN types already labelled, joined by '/'
  const kindsLabel = (v) => String(v).replace(/[^A-Za-z0-9_.:/-]/g, '').slice(0, 120) || '-'
  const W = minutes(windowMs)
  const L = minutes(lockMs)
  // alertOf(group, kind): what one alert per window is raised for (a match, a game number, one search)
  const family = (name, threshold, lockLine, alertLine, alertOf = (group) => group) => ({
    name,
    threshold,
    lockLine,
    alertLine,
    alertOf,
    ranges: createCountTable({ windowMs, maxKeys: lockKeys, now }),
    all: createCountTable({ windowMs, maxKeys: lockKeys, now }),
    alerted: new Map(), // alertOf key -> time of its alert
    fullAt: -Infinity
  })
  const matches = family('match', matchMax,
    (match, kind, range, n) => `[PIN] match ${label(match)}: ${n} wrong ${label(kind)} PINs from ${rangeLabel(range)} within ${W} min; its ${label(kind)} PIN checks from that range are refused for ${L} min (other addresses, and match tokens already issued, keep working)`,
    (match, kind, n, ranges) => `[PIN] match ${label(match)}: ${n} wrong ${kindsLabel(kind)} PINs from all callers within ${W} min (${ranges}); ops alert, nobody is refused for it (only a range past its share is)`)
  const searches = family('search', searchMax,
    (_, kind, range, n) => `[PIN] ${n} wrong ${label(kind)} PINs in lookups without a match from ${rangeLabel(range)} within ${W} min; those lookups from that range are refused for ${L} min (other addresses, and lookups that name their match, are not affected)`,
    (_, kind, n, ranges) => `[PIN] ${n} wrong ${kindsLabel(kind)} PINs in lookups without a match from all callers within ${W} min (${ranges}); ops alert, nobody is refused for it (only a range past its share is)`,
    (_, kind) => kind)
  const games = family('game', matchMax,
    (gameN, _, range, n) => `[PIN] game number ${label(gameN)}: ${n} wrong game PINs in restore-by-pin from ${rangeLabel(range)} within ${W} min; restore-by-pin of that game number from that range is refused for ${L} min (other addresses, and the other PIN checks of its matches, are not affected)`,
    (gameN, _, n, ranges) => `[PIN] game number ${label(gameN)}: ${n} wrong game PINs in restore-by-pin from all callers within ${W} min (${ranges}); ops alert, nobody is refused for it (only a range past its share is)`)
  const gameKeys = (gameN) => [[String(gameN).slice(0, 20), 'restore']]
  const levelsOf = (ipKey) => pinRangesOf(ipKey, rangeMax)
  function raise (fam, message, payload) {
    log(message)
    if (typeof alert !== 'function') return
    try { alert({ ...payload, scope: fam.name, windowMinutes: W, message }) } catch { /* an alert never fails a PIN check */ }
  }
  // A table without room: once per window
  function full (fam, t) {
    if (t - fam.fullAt < windowMs) return
    fam.fullAt = t
    raise(fam, `[PIN] the ${fam.name} counts are full (${lockKeys} keys): new wrong PINs are counted per address only until older ones expire`, { key: '-', type: '-', types: [], count: lockKeys, ranges: [], otherRanges: 0 })
  }
  // Is (group, kind) refused to the caller of `levels`? A range at its share starts its lock here (one log line).
  function refusing (fam, group, kind, levels, t) {
    let refused = false
    for (const { range, max: share } of levels) {
      const e = fam.ranges.get(group, kind, range, t)
      if (!e) continue
      if (!e.until && e.count >= share) {
        e.until = t + lockMs
        log(fam.lockLine(group, kind, range, e.count))
      }
      if (e.until) refused = true
    }
    return refused
  }
  // The widest range of each caller counted for the alert (at most 16, the rest as a number)
  function noteRange (a, range, d) {
    if (!a.ranges) {
      a.ranges = new Map()
      a.others = 0
    }
    const n = a.ranges.get(range) || 0
    if (d > 0) {
      if (n > 0 || a.ranges.size < 16) a.ranges.set(range, n + 1)
      else a.others++
    } else if (n > 1) a.ranges.set(range, n - 1)
    else if (n === 1) a.ranges.delete(range)
    else if (a.others > 0) a.others--
  }
  /**
   * The alerts due after `pairs` were counted: one per alertOf key and
   * window, naming every PIN type of it past the threshold (a relay check of
   * all a match's PINs counts each of them at once).
   */
  function alertsDue (fam, pairs, t) {
    const due = new Map() // alertOf key -> [group, [kind, entry][]]
    for (const [group, kind] of pairs) {
      const a = fam.all.get(group, kind, '*', t)
      if (!a || a.count < fam.threshold) continue
      const key = fam.alertOf(group, kind)
      const at = fam.alerted.get(key)
      if (at !== undefined && t - at <= windowMs) continue
      if (!due.has(key)) due.set(key, [group, []])
      due.get(key)[1].push([kind, a])
    }
    for (const [key, [group, list]] of due) {
      if (fam.alerted.size >= 10000) for (const [k, at] of fam.alerted) if (t - at > windowMs) fam.alerted.delete(k)
      fam.alerted.set(key, t)
      const [, top] = list.reduce((x, y) => (y[1].count > x[1].count ? y : x))
      const kinds = list.map(([kind]) => label(kind))
      const ranges = [...(top.ranges || [])].sort((x, y) => y[1] - x[1]).map(([range, count]) => ({ range: rangeLabel(range), count }))
      const shown = ranges.slice(0, 8).map((r) => `${r.range} x${r.count}`)
      const more = ranges.length - shown.length + (top.others || 0)
      const text = shown.length ? shown.join(', ') + (more > 0 ? `, ${more} more ranges` : '') : 'no range noted'
      raise(fam, fam.alertLine(group, kinds.join('/'), top.count, text), {
        key: label(group),
        type: kinds.join('/'),
        types: list.map(([kind, a]) => ({ type: label(kind), count: a.count })),
        count: top.count,
        ranges,
        otherRanges: top.others || 0
      })
    }
  }
  /** Counts one attempt for each pair up front, or none when the caller's range is refused one of them. */
  function begin (fam, pairs, ipKey) {
    const t = now()
    fam.ranges.tick(t)
    fam.all.tick(t)
    const levels = levelsOf(ipKey)
    // every pair is asked (each lock that is due starts now)
    if (pairs.map(([group, kind]) => refusing(fam, group, kind, levels, t)).some(Boolean)) return false
    const widest = levels[levels.length - 1].range
    for (const [group, kind] of pairs) {
      for (const { range } of levels) {
        const e = fam.ranges.touch(group, kind, range, t)
        if (e) e.count++
        else full(fam, t)
      }
      const a = fam.all.touch(group, kind, '*', t)
      if (!a) {
        full(fam, t)
        continue
      }
      a.count++
      noteRange(a, widest, 1)
    }
    alertsDue(fam, pairs, t)
    return true
  }
  /** Takes back what begin counted (a right PIN, nothing compared). A lock stays. */
  function settle (fam, pairs, ipKey) {
    const t = now()
    const levels = levelsOf(ipKey)
    const widest = levels[levels.length - 1].range
    for (const [group, kind] of pairs) {
      for (const { range } of levels) {
        const e = fam.ranges.get(group, kind, range, t)
        if (!e || e.until) continue
        e.count--
        if (e.count <= 0) fam.ranges.drop(group, kind, range)
      }
      const a = fam.all.get(group, kind, '*', t)
      if (!a) continue
      a.count--
      noteRange(a, widest, -1)
      if (a.count <= 0) fam.all.drop(group, kind, '*')
    }
  }
  // What a scope is counted for across addresses: { fam, pairs: [group, kind][] }, or null
  function acrossOf (scope, kinds, across) {
    if (Array.isArray(across)) return { fam: matches, pairs: pairsOf(across) }
    const s = String(scope)
    if (s.startsWith('any:')) return { fam: searches, pairs: [['search', s.slice(4)]] }
    const m = MATCH_SCOPE_RE.exec(s)
    if (!m) return null
    const list = m[1] === 'all' ? [...new Set(Array.isArray(kinds) ? kinds.map(String) : [])] : [m[1]]
    return { fam: matches, pairs: list.map((kind) => [m[2], kind]) }
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
      if (counters && !begin(counters.fam, counters.pairs, ipKey)) {
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
      if (counters) settle(counters.fam, counters.pairs, ipKey)
    },
    matchLimited (pairs, ipKey) { return !begin(matches, pairsOf(pairs), ipKey) },
    matchRefund (pairs, ipKey) { settle(matches, pairsOf(pairs), ipKey) },
    gameLimited (gameN, ipKey) { return !begin(games, gameKeys(gameN), ipKey) },
    gameRefund (gameN, ipKey) { settle(games, gameKeys(gameN), ipKey) },
    openKinds (match, kinds, ipKey) {
      const t = now()
      const levels = levelsOf(ipKey)
      return kinds.filter((kind) => !refusing(matches, matchGroup(match), String(kind), levels, t))
    },
    locked (match, kind, ipKey) { return refusing(matches, matchGroup(match), String(kind), levelsOf(ipKey), now()) },
    pinChanged (match, kinds) {
      const list = kinds.map(String)
      matches.ranges.forget(matchGroup(match), list)
      matches.all.forget(matchGroup(match), list)
      // the next alert of the match is about its new PINs
      matches.alerted.delete(matchGroup(match))
    },
    tracks (match) { return matches.ranges.has(matchGroup(match)) || matches.all.has(matchGroup(match)) },
    tracksAny () { return matches.ranges.size > 0 || matches.all.size > 0 },
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

  /**
   * What the server holds of a match: its sets, events (voided ones too) and
   * live state, or null when the tables are not there (pgQuery's own suites).
   */
  async function rowCounts (client, cat, matchUuid) {
    const tables = [cfg.setsTable, cfg.eventsTable, cfg.liveStateTable]
    if (!tables.every(t => cat.tables.get(t)?.columns.has(cfg.childFk)) || !cat.tables.get(cfg.eventsTable).columns.has('voided_at')) return null
    const q = (t) => `${quote(db.config.schema || 'public')}.${quote(t)}`
    const fk = quote(cfg.childFk)
    const { rows: [c] } = await client.query(
      `SELECT (SELECT count(*) FROM ${q(cfg.setsTable)} WHERE ${fk} = $1)::int AS sets,
              (SELECT count(*) FROM ${q(cfg.eventsTable)} WHERE ${fk} = $1)::int AS events,
              (SELECT count(*) FROM ${q(cfg.eventsTable)} WHERE ${fk} = $1 AND voided_at IS NOT NULL)::int AS voided_events,
              (SELECT count(*) FROM ${q(cfg.liveStateTable)} WHERE ${fk} = $1)::int AS live_state`, [matchUuid])
    return c
  }

  /**
   * The audit entry of a restore (cfg.auditAction), in its transaction: who,
   * from which device, and the match's rows before and after. Nothing when
   * the audit log is not there.
   */
  async function auditRestore (client, cat, { actorId, matchUuid, externalId, device, before, rekeyed }) {
    if (!before || !cat.tables.has('audit_log')) return
    const after = await rowCounts(client, cat, matchUuid)
    const details = { external_id: externalId, before, after }
    // the device id (lib/scorerDevice.js deviceOf: a UUID, a string or { id, platform })
    const deviceId = typeof device === 'string' ? device : (isPlainObject(device) ? device.id : null)
    if (typeof deviceId === 'string' && UUID_RE.test(deviceId)) details.device = deviceId.toLowerCase()
    if (rekeyed) details.rekeyed = rekeyed
    await client.query(
      `INSERT INTO public.audit_log (actor_id, action, match_id, details, app)
       SELECT $1, $2, m.id, $4::jsonb, CASE WHEN to_jsonb(m) ->> 'sport_type' = 'beach' THEN 'beach' END
         FROM ${quote(db.config.schema || 'public')}.${quote(cfg.matchTable)} m WHERE m.${quote(cfg.matchId)} = $3`,
      [typeof actorId === 'string' && UUID_RE.test(actorId) ? actorId : null, cfg.auditAction, matchUuid, JSON.stringify(details)])
  }

  /**
   * `scorerCheck(client, externalId)`: the scoring device's check (db/019,
   * server.js scorerCheckOf), run first in the restore's transaction; an
   * answer (409 OV_SCORER_MOVED) refuses the restore, nothing written.
   */
  async function restoreMatch (payload, { proto, matchOwner, actorId, scorerCheck = null } = {}) {
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
      for (const row of eventRows) for (const k of cfg.eventServerColumns) delete row[k]
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
        // Before the match is written (locked): a take-over locks the scorer row first too
        const refused = scorerCheck ? await scorerCheck(client, match[cfg.matchKey]) : null
        if (refused) return { refused }
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
        const before = await rowCounts(client, cat, matchUuid)
        const audited = async (result) => {
          await auditRestore(client, cat, { actorId, matchUuid, externalId: match[cfg.matchKey], device: payload.device, before, rekeyed: result.counts.rekeyed })
          return result
        }
        if (rekey) {
          const rekeyed = (await rekeyRows(client, run, cfg.setsTable, setRows, rekey.sets, matchUuid, withFk)) +
            (await rekeyRows(client, run, cfg.eventsTable, eventRows, rekey.events, matchUuid, withFk))
          if (closingStatus) await closeMatch(run, matchUuid, closingStatus)
          return audited({ id: matchUuid, counts: { sets: setRows.length, events: eventRows.length, liveState: 0, rekeyed }, dropped: droppedOut })
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
        return audited({ id: matchUuid, counts, dropped: droppedOut })
      }, { statementTimeoutMs: cfg.statementTimeoutMs })
      if (out.refused) return out.refused
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
   * one attempt each, across addresses (pinBudget, by the caller's address
   * ranges), counted up front. { counted: true } then; { counted: false }
   * when the caller's range is refused one of them but the caller is trusted
   * beyond the PIN (`trusted()`, nothing counted); else { refused } (a 429:
   * nothing is compared and the caller's attempt is given back).
   */
  async function overMatchLimit (callerKey, gameKey, matchKeys, trusted) {
    if (!pinBudget.matchLimited(matchKeys.map((k) => [k, 'game']), callerKey)) return { counted: true }
    if (await trusted()) return { counted: false }
    callerLimiter.refund(callerKey)
    pinLimiter.refund(gameKey)
    return { refused: tooMany() }
  }

  /**
   * Is the caller trusted beyond the PIN for one of the matches whose
   * `column` is `value` (the match of a claim, the matches of a game
   * number)? A signed-in admin (`trust.isAdmin()`), the creator or an editor
   * of one of them (`trust.userId`), or the device the database names as the
   * scorer of an open one (`trust.deviceId`, db/019 match_scorer_devices).
   * Asked only when a range lock refuses the caller. Never throws (false).
   */
  async function trustedFor (column, value, trust) {
    if (!trust || typeof trust !== 'object') return false
    try {
      if (typeof trust.isAdmin === 'function' && (await trust.isAdmin()) === true) return true
      const userId = typeof trust.userId === 'string' && UUID_RE.test(trust.userId) ? trust.userId : null
      const deviceId = typeof trust.deviceId === 'string' && UUID_RE.test(trust.deviceId) ? trust.deviceId : null
      if (!userId && !deviceId) return false
      const cat = await db.ensureCatalog()
      const mt = cat.tables.get(cfg.matchTable)
      if (!mt || !mt.columns.has(column)) return false
      const schema = quote(db.config.schema || 'public')
      const own = db.config.ownership
      const values = [value]
      const p = (v) => {
        values.push(v)
        return '$' + values.length
      }
      const ors = []
      if (userId && own && mt.columns.has(own.ownerColumn)) {
        const u = p(userId)
        ors.push(`m.${quote(own.ownerColumn)} = ${u}::uuid`)
        if (cat.tables.has(own.editors.table)) {
          ors.push(`EXISTS (SELECT 1 FROM ${schema}.${quote(own.editors.table)} e WHERE e.${quote(own.editors.matchColumn)} = m.${quote(cfg.matchId)} AND e.${quote(own.editors.userColumn)} = ${u}::uuid)`)
        }
      }
      if (deviceId && cat.tables.has('match_scorer_devices')) {
        const open = mt.columns.has(cfg.closedColumn) ? ` AND m.${quote(cfg.closedColumn)} IS NULL` : ''
        ors.push(`(EXISTS (SELECT 1 FROM ${schema}.match_scorer_devices s WHERE s.match_id = m.${quote(cfg.matchId)} AND s.device_id = ${p(deviceId)})${open})`)
      }
      if (ors.length === 0) return false
      const r = await db.pool.query(
        `SELECT 1 FROM ${schema}.${quote(cfg.matchTable)} m WHERE m.${quote(column)} = $1 AND (${ors.join(' OR ')}) LIMIT 1`, values)
      return r.rows.length > 0
    } catch (err) {
      log.warn?.(`[matchRestore] could not check who asks: ${err.code || err.message}`)
      return false
    }
  }

  /**
   * POST /api/match/claim { externalId, pin }: the caller (signed in) proves
   * the match's game PIN and becomes an editor of it.
   */
  /**
   * May `userId` read the closed match `row` (selected with '*') whole? Its
   * creator, the account that closed it and an editor an admin added: the
   * game PIN gives a closed match's full record to nobody. Never throws.
   */
  async function readsClosedWhole (row, userId) {
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) return false
    const own = db.config.ownership
    if ((own && row[own.ownerColumn] === userId) || row[cfg.closedByColumn] === userId) return true
    if (!own) return false
    try {
      const r = await db.pool.query(
        `SELECT 1 FROM ${quote(db.config.schema || 'public')}.${quote(own.editors.table)}
          WHERE ${quote(own.editors.matchColumn)} = $1 AND ${quote(own.editors.userColumn)} = $2::uuid AND granted_via = 'admin' LIMIT 1`,
        [row[cfg.matchId], userId])
      return r.rows.length > 0
    } catch (err) {
      log.warn?.(`[matchRestore] could not read the editors: ${err.code || err.message}`)
      return false
    }
  }

  async function claimMatch (input, { userId, limitKey = 'anon', trust = null } = {}) {
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
      const cat = await db.ensureCatalog()
      const hasClosed = cat.tables.get(cfg.matchTable)?.columns.has(cfg.closedColumn) === true
      const found = await db.runQuery({
        table: cfg.matchTable,
        action: 'select',
        params: {
          columns: `${cfg.matchId}, ${cfg.pinColumn}${hasClosed ? `, ${cfg.closedColumn}` : ''}`,
          filters: [{ type: 'eq', column: cfg.matchKey, value: ext }],
          limit: 1
        }
      }, { internal: true })
      if (found.body.error) return { status: found.status, body: found.body }
      const stored = found.body.data[0]
      const hasPin = stored?.[cfg.pinColumn] != null && String(stored[cfg.pinColumn]).trim() !== ''
      let counted = false
      if (hasPin) {
        const limit = await overMatchLimit(callerKey, gameKey, [ext], () => trustedFor(cfg.matchKey, ext, trust))
        if (limit.refused) return limit.refused
        counted = limit.counted
      }
      const row = hasPin && pins.matches('game', pin, stored[cfg.pinColumn]) ? stored : null
      if (!row) return errorBody(404, 'OV_NOT_FOUND', 'No match with this id and game PIN')
      if (counted) pinBudget.matchRefund([[ext, 'game']], callerKey)
      pinLimiter.reset(gameKey)
      callerLimiter.refund(callerKey)
      // The game PIN is retired at the close: past the window it makes no
      // editor of a closed match (one added in it still reads the match as
      // the public does: lib/pgQuery.js ownedSql)
      const closedAt = hasClosed && row[cfg.closedColumn] != null ? new Date(row[cfg.closedColumn]).getTime() : null
      if (closedAt !== null && !(Date.now() - closedAt <= cfg.closedClaimWindowMs)) {
        return errorBody(409, 'OV_MATCH_CLOSED', 'This match is closed: its game PIN no longer gives access')
      }
      const role = await addEditor(row[cfg.matchId], userId, 'claim')
      if (!role) return errorBody(503, 'OV_DB_UNAVAILABLE', 'Service unavailable')
      return { status: 200, body: { data: { id: row[cfg.matchId], external_id: ext, role }, error: null } }
    } catch (err) {
      const r = db.toErrorResult(err, { action: 'claim', table: cfg.matchTable })
      return { status: r.status, body: r.body }
    }
  }

  /**
   * The sets (by index), events (by seq; voided ones left out by pgQuery),
   * live state and id floor of the match `matchUuid` (key `matchKey`), as
   * restore-by-pin answers them.
   */
  async function readChildren (cat, matchUuid, matchKey) {
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
    return Promise.all([
      read(cfg.setsTable, { order: childOrder(cfg.setsTable, ['index']) }),
      read(cfg.eventsTable, { order: childOrder(cfg.eventsTable, ['seq', 'ts', 'id']) }),
      read(cfg.liveStateTable, { maybeSingle: true }),
      idFloor(cat, matchUuid, matchKey)
    ])
  }

  /**
   * The whole record of the match `matchUuid` for trusted server code (an
   * admin's "Rebuild PDF", lib/scoresheets.js): { match, sets, events,
   * liveState }, the match without its secret columns (PINs) and the
   * restore-by-pin hidden ones; null when there is no such match. No PIN, no
   * limiter, no editor: the caller has checked the right to read it.
   */
  async function readWhole (matchUuid) {
    if (typeof matchUuid !== 'string' || !UUID_RE.test(matchUuid)) return null
    const cat = await db.ensureCatalog()
    if (!cat.tables.get(cfg.matchTable)) return null
    const found = await db.runQuery({
      table: cfg.matchTable,
      action: 'select',
      params: { columns: '*', filters: [{ type: 'eq', column: cfg.matchId, value: matchUuid }], limit: 1 }
    }, { internal: true })
    if (found.body.error) throw Object.assign(new Error('match read failed'), { result: found })
    const row = found.body.data[0]
    if (!row) return null
    const match = { ...row }
    for (const k of db.secretColumnsOf(cfg.matchTable)) {
      for (const key of Object.keys(match)) if (key.toLowerCase() === k) delete match[key]
    }
    for (const k of cfg.restoreByPinHidden) delete match[k]
    const [s, e, l] = await readChildren(cat, matchUuid, row[cfg.matchKey])
    return { match, sets: s.body.data, events: e.body.data, liveState: l.body.data }
  }

  async function restoreByPin (input, { limitKey = 'anon', editorUserId = null, takeOver = null, trust = null } = {}) {
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
      // Across addresses, one attempt against the game number (pinBudget
      // gameLimited, by the caller's address ranges), counted up front: the
      // PIN is compared with every match that carries it. A game number no
      // match has has no PIN to guess and counts nowhere. A caller the
      // server trusts beyond the PIN (trustedFor) is not refused by a range
      // lock, and nothing is counted for it.
      const any = await db.runQuery({
        table: cfg.matchTable,
        action: 'select',
        params: { columns: cfg.matchId, filters: [{ type: 'eq', column: cfg.gameNColumn, value: gameN }], limit: 1 }
      }, { internal: true })
      if (any.body.error) return { status: any.status, body: any.body }
      if (any.body.data.length === 0) return errorBody(404, 'OV_NOT_FOUND', 'Match not found with this ID and PIN')
      let trusted = false
      if (pinBudget.gameLimited(gameN, callerKey)) {
        trusted = await trustedFor(cfg.gameNColumn, gameN, trust)
        if (!trusted) {
          callerLimiter.refund(callerKey)
          pinLimiter.refund(gameKey)
          return tooMany()
        }
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
      // A match whose game PIN is locked for the caller's range (its own
      // checks: claim, the relay) proves nothing here either, answered as a
      // wrong PIN, unless the caller is trusted beyond the PIN for it
      let row = null
      for (const r of found.body.data) {
        if (trusted || !(r[cfg.matchKey] && pinBudget.locked(r[cfg.matchKey], 'game', callerKey)) ||
            await trustedFor(cfg.matchId, r[cfg.matchId], trust)) {
          row = r
          break
        }
      }
      if (!row) return errorBody(404, 'OV_NOT_FOUND', 'Match not found with this ID and PIN')
      // Only failed guesses count against the caller.
      if (!trusted) pinBudget.gameRefund(gameN, callerKey)
      pinLimiter.reset(gameKey)
      callerLimiter.refund(callerKey)
      const match = { ...row }
      for (const k of db.secretColumnsOf(cfg.matchTable)) {
        for (const key of Object.keys(match)) if (key.toLowerCase() === k) delete match[key]
      }
      const matchUuid = row[cfg.matchId]
      // After the close the game PIN is retired: it makes no editor and no
      // scorer, and gives the public view of the match only (no rosters'
      // dates of birth, contacts, signatures, event payloads). Its creator,
      // its closer and an admin's editor still get the whole record.
      const closed = row[cfg.closedColumn] != null
      const anonymous = closed && !(await readsClosedWhole(row, editorUserId))
      // A signed-in caller who proved the game PIN may now write the match.
      const editor = editorUserId && !closed ? await addEditor(matchUuid, editorUserId, 'restore-by-pin') : null
      for (const k of cfg.restoreByPinHidden) delete match[k]
      // The caller scores the match from here on (before the read: a write
      // of the device it leaves is in what is read, or refused after it)
      let scorer = null
      if (typeof takeOver === 'function' && !closed) {
        try {
          scorer = await takeOver({ id: matchUuid, external_id: row[cfg.matchKey] })
        } catch (err) {
          log.warn?.(`[matchRestore] scoring-device take-over failed: ${err?.code || err?.message}`)
        }
      }
      const [s, e, l, floor] = await readChildren(cat, matchUuid, row[cfg.matchKey])
      if (anonymous) {
        const pub = (table, rows) => projectAnonDbRows(table, rows)
        const pubMatch = { ...pub(cfg.matchTable, match), [cfg.closedColumn]: row[cfg.closedColumn] }
        return { status: 200, body: { data: { match: pubMatch, sets: pub(cfg.setsTable, s.body.data), events: pub(cfg.eventsTable, e.body.data), liveState: pub(cfg.liveStateTable, l.body.data), access: 'public' }, error: null } }
      }
      return { status: 200, body: { data: { match, sets: s.body.data, events: e.body.data, liveState: l.body.data, ...(floor ? { idFloor: floor } : {}), ...(editor ? { access: editor } : {}), ...(scorer ? { scorer } : {}) }, error: null } }
    } catch (err) {
      if (err?.result) return { status: err.result.status, body: err.result.body }
      const r = db.toErrorResult(err, { action: 'restore-by-pin', table: cfg.matchTable })
      return { status: r.status, body: r.body }
    }
  }

  return { restoreMatch, restoreByPin, readWhole, claimMatch, addEditor, pinLimiter, callerLimiter }
}
