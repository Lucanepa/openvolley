/**
 * What the backend relay (server.js) keeps of what any socket sends: the
 * synced match bundles (sync-match-data) and live states (live-state-update)
 * of every room, in memory, without an account or a PIN. The backend runs
 * with 256 MB of V8 heap (deploy/compose.yaml); an anonymous client that
 * filled it ended the process, and every room, PIN budget and sign session
 * with it.
 *
 * Measured (a long five-set match: 30:28, 23:25, 27:25, 22:25, 18:16): about
 * 600 events, 80 KB as JSON; with its 14 signature images (PNG data URLs,
 * 20-80 KB each) 0.5-1.2 MB, about as much in the heap. An older scorer
 * (before 2026-10-26) sends each event's undo snapshot too, 2-3 MB in all,
 * which the relay drops before it keeps the bundle (server.js relayEvents).
 * The limits below are far above that.
 *
 * Pure module: node:buffer only, safe in the LAN / SEA bundle.
 */
import { Buffer } from 'node:buffer'

/** Events of one bundle (a restore takes as many: lib/matchRestore.js maxEvents). */
export const MAX_RELAY_EVENTS = 20000
/** Sets of one bundle (lib/matchRestore.js maxSets). */
export const MAX_RELAY_SETS = 20
/** Players of one list (homePlayers, team1Players, legacy players, ...). */
export const MAX_RELAY_PLAYERS = 200
/** Length of a PIN field as text (the PINs have 6 digits; restore takes 32). */
export const MAX_RELAY_PIN_LENGTH = 64
/** One room's bundle, as approxHeapBytes counts it. */
export const MAX_RELAY_BUNDLE_BYTES = 8 * 1024 * 1024
/** A live state as JSON: the live hub's limit (lib/realtimeHub.js maxPayloadBytes). */
export const MAX_LIVE_STATE_BYTES = 256 * 1024
/**
 * JSON values in one frame, counted before it is parsed (frameTooLarge). The
 * frame limit is 10 MB, and 10 MB of `{},` parse to 3.4 million objects, over
 * 200 MB of heap. A five-set bundle with undo snapshots has about 35,000.
 */
export const MAX_FRAME_VALUES = 300000
/**
 * Share of V8's heap limit the relay's bundles and live states may hold in
 * all; one address (IPv4, IPv6 /64 on the cloud) may hold half of that. With
 * --max-old-space-size=256 (V8 limit 304 MB on Node 22) about 106 MB: 80 to
 * 170 matches at their end with all 14 signatures, half of them behind one
 * hall's address. A backend started with a bigger heap (deploy/README.md, big
 * events) keeps more; OV_RELAY_MAX_MB sets the total instead.
 */
export const RELAY_HEAP_SHARE = 0.35
/**
 * A new room (one the relay does not hold yet) is refused once the stored
 * bundles and live states reach this share of the total, or of one address's
 * share. The headroom above it is kept for the rooms already in play, which
 * grow a little with every rally: an overloaded relay sheds new matches
 * instead of freezing the ones a referee and the benches are watching.
 */
export const NEW_ROOM_SHARE = 0.8
/**
 * On the cloud (DATABASE_URL), the rooms the database does not know as official
 * matches (forged or rehearsal rooms, anything an anonymous socket syncs) may
 * hold at most this share of the total together, so an anonymous flood cannot
 * take the memory an official match in play needs. Official matches use the
 * whole budget.
 */
export const RELAY_ANON_SHARE = 0.6

// approxHeapBytes: what V8 keeps of a parsed JSON value (measured with Node
// 22 and 24): a property or array element 8 bytes, an empty object 56 (room
// for 4 properties), an array 32 and 16 more for its elements, a string 24
// plus its characters (one byte each when all are ASCII, else two), a number
// that is no small integer 16. A key costs once per value walked: V8 keeps
// each name once and shares the hidden class of objects with the same keys;
// new keys cost about 130 bytes each (one object with many, or many objects
// each with its own).
// That is the compact (fast-properties) layout. V8 keeps an object as a hash
// table instead (dictionary mode, up to 72 bytes per property and about 100
// for the table) when it has many properties: JSON.parse from 128 on, an
// object built key by key (server.js carryMatchSecrets) from about 20 on. Its
// integer-like keys ("7", "1000") go to a hash table of their own whenever they
// are not dense, 88 bytes each with large ones. Which layout V8 chose cannot be
// seen from here, so such an object is counted as a hash table too.
const SLOT_BYTES = 8
const OBJECT_BYTES = 56
const ARRAY_BYTES = 32
const ELEMENTS_BYTES = 16
const STRING_BYTES = 24
const HEAP_NUMBER_BYTES = 16
const NEW_KEY_BYTES = 128
/** Named properties an object may have and still be counted in the compact layout */
export const FAST_PROPERTIES = 16
const DICTIONARY_BYTES = 128
const DICTIONARY_ENTRY_BYTES = 72
const INDEX_ENTRY_BYTES = DICTIONARY_ENTRY_BYTES + HEAP_NUMBER_BYTES
// An object carries a hidden class, a V8 map chain. Objects built with the same
// keys in the SAME order share one; a different insertion order is a fresh
// chain of several hundred bytes, and an anonymous socket can give every event
// in an array its own order. NEW_KEY_BYTES counts each name once (V8 interns it
// and the shared map keeps it once); this counts the per-object map on top,
// once per distinct ordered shape seen -- an upper bound, since V8 shares map
// prefixes and this does not. JSON.parse keeps objects of up to 127 keys in the
// compact layout, each order with its own chain, so the charge applies at any
// key count (a hash table on top of it past FAST_PROPERTIES). The shape is the
// key list with each name length-prefixed, so no name (one holding the
// separator, say) can make two different key lists one shape. Measured on
// Node 22/24: an array of 17000 fresh-order objects took about 440 (8 keys),
// 760 (12) and 1070-2170 (16, a plain array or the object-rest strip path)
// bytes each, and 24-127 keys about 1.06-1.33x the hash-table charge alone;
// the shape charge keeps the estimate at or above all of these.
const MAP_BASE_BYTES = 64
const MAP_KEY_BYTES = 160
// Ordered shapes remembered per value; past that every object counts as a fresh
// shape (an upper bound: an attacker needs this many distinct shapes to get here)
const MAX_TRACKED_SHAPES = 4096
// Names remembered per value; past that every name counts as new (more is no bundle)
const MAX_TRACKED_KEYS = 4096
// A short string is counted at two bytes per character without looking at it
const SHORT_STRING = 64

const isSmallInt = (n) => Number.isInteger(n) && n >= -0x40000000 && n < 0x40000000
const stringBytes = (s) => (s.length <= SHORT_STRING || Buffer.byteLength(s) !== s.length ? 2 * s.length : s.length)
// An integer-like key, which V8 keeps as an element ("0", "17"; not "007", "-1")
const isIndexKey = (k) => {
  const c = k.charCodeAt(0)
  if (c < 0x30 || c > 0x39 || (c === 0x30 && k.length > 1) || k.length > 10) return false
  for (let i = 1; i < k.length; i++) {
    const d = k.charCodeAt(i)
    if (d < 0x30 || d > 0x39) return false
  }
  return Number(k) < 0xffffffff
}

/**
 * About how many heap bytes a parsed JSON value takes (see above): at least
 * what V8 used for every shape measured (empty and nested objects and
 * arrays, numbers, unique keys and strings, objects with many or with
 * integer-like keys in either layout), 1.1-1.8x of it for real bundles.
 * Iterative: the frame was checked for depth before (realtimeHub.js
 * jsonTooDeep).
 * @param {unknown} value
 * @returns {number}
 */
export function approxHeapBytes(value) {
  let bytes = 0
  const keys = new Set()
  const shapes = new Set()
  const stack = [value]
  while (stack.length > 0) {
    const v = stack.pop()
    bytes += SLOT_BYTES
    if (typeof v === 'string') {
      bytes += STRING_BYTES + stringBytes(v)
    } else if (typeof v === 'number') {
      if (!isSmallInt(v)) bytes += HEAP_NUMBER_BYTES
    } else if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) {
        bytes += ARRAY_BYTES + (v.length > 0 ? ELEMENTS_BYTES : 0)
        for (let i = 0; i < v.length; i++) stack.push(v[i])
      } else {
        bytes += OBJECT_BYTES
        let named = 0
        let indexed = 0
        let shape = ''
        for (const k in v) {
          if (isIndexKey(k)) indexed++
          // Length-prefixed: one signature per ordered key list, whatever the names hold
          else { named++; shape += k.length + ':' + k }
          if (!keys.has(k)) {
            bytes += NEW_KEY_BYTES + 2 * k.length
            if (keys.size < MAX_TRACKED_KEYS) keys.add(k)
          }
          stack.push(v[k])
        }
        if (named > 0 && (shapes.size >= MAX_TRACKED_SHAPES || !shapes.has(shape))) {
          // A key order not seen before is a fresh hidden class, at any key count.
          bytes += MAP_BASE_BYTES + MAP_KEY_BYTES * named
          if (shapes.size < MAX_TRACKED_SHAPES) shapes.add(shape)
        }
        if (named > FAST_PROPERTIES) {
          // A hash table (dictionary mode), per object and order-independent.
          bytes += DICTIONARY_BYTES + DICTIONARY_ENTRY_BYTES * named
        }
        if (indexed > 0) bytes += DICTIONARY_BYTES + INDEX_ENTRY_BYTES * indexed
      }
    }
  }
  return bytes
}

/**
 * Does this frame (the raw message) hold more than MAX_FRAME_VALUES JSON
 * values? Counted on the bytes, before JSON.parse: every value after the first
 * follows a ',', '[' or '{' (more of them inside strings only count more). A
 * frame of fewer than two bytes per allowed value cannot hold more and is not
 * scanned (a current scorer's bundle, about 1.2 ms per MB otherwise).
 * @param {Buffer|string} data
 * @returns {boolean}
 */
export function frameTooLarge(data) {
  if (data == null || data.length <= 2 * MAX_FRAME_VALUES) return false
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  let values = 1
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (c === 0x2c || c === 0x5b || c === 0x7b) {
      if (++values > MAX_FRAME_VALUES) return true
    }
  }
  return false
}

// A PIN the relay compares (gamePin, refereePin, the bench and upload PINs):
// text of at most MAX_RELAY_PIN_LENGTH or a number. A longer one is refused so
// it cannot grow the bundle, and never String()d.
const isPinValue = (v) =>
  v === undefined || v === null ||
  (typeof v === 'string' && v.length <= MAX_RELAY_PIN_LENGTH) ||
  (typeof v === 'number' && Number.isFinite(v))
// A PIN field the relay never compares (openbeach's matchPin, the device's own
// lock): only its type matters (an object would still have to be String()d
// safely elsewhere). No length limit: the user types it with no maximum, and a
// long one must not stop the sync.
const isPinType = (v) =>
  v === undefined || v === null || typeof v === 'string' ||
  (typeof v === 'number' && Number.isFinite(v))
// A display field (status, scheduledAt, a team's name) the match list, the
// venue landing page or the PIN check turn into a string or a Date: text, a
// finite number or missing. An object or array would make String() / new Date()
// throw and that answer 500 (or sort the whole list to an error) for everyone.
const isDisplayValue = (v) =>
  v === undefined || v === null || typeof v === 'string' ||
  (typeof v === 'number' && Number.isFinite(v))
// Match fields read into a string or a Date by those paths (lib/publicColumns.js
// relayMatchListRow and the /api/match/list sort, lib/landingPage.js, the
// relay validate-pin loop). scheduled_at / game_n are the snake-case aliases.
const DISPLAY_MATCH_FIELDS = ['status', 'scheduledAt', 'scheduled_at', 'homeTeamName', 'awayTeamName', 'gameNumber', 'gameN', 'game_n']
// A team arrives as a string, a number or an object with a name; the landing
// page and the summary read .name / .shortName. Checked wherever a team can be.
const TEAM_FIELDS = ['homeTeam', 'awayTeam', 'team1Team', 'team2Team', 'team1', 'team2']
const TEAM_NAME_FIELDS = ['name', 'shortName', 'short_name']
const teamNameProblem = (team) => {
  if (team === undefined || team === null || typeof team === 'string' || typeof team === 'number') return false
  if (typeof team !== 'object' || Array.isArray(team)) return true
  for (const k of TEAM_NAME_FIELDS) if (!isDisplayValue(team[k])) return true
  return false
}
const listProblem = (v, max) => {
  if (v === undefined || v === null) return null
  if (!Array.isArray(v)) return 'bad-request'
  return v.length > max ? 'too-large' : null
}
const PROBLEM_TEXT = {
  'bad-request': 'Invalid match data',
  'too-large': 'Match data too large for the relay'
}

/**
 * Why a sync-match-data cannot be kept, before anything reads it: a PIN
 * field (pinFields) that is not text of at most MAX_RELAY_PIN_LENGTH or a
 * number ('bad-request': the PIN checks compare text), a typeOnlyField that is
 * not text or a number (its length does not matter, it is never compared), a
 * display field (status, scheduledAt, a team's name) that is not text, a finite
 * number or missing ('bad-request': the match list, landing page and PIN check
 * turn it into a string or a Date, and an object there answers 500 for
 * everyone), an events / sets / player list that is not an array ('bad-request')
 * or longer than its limit ('too-large'). Null when it may be kept; its size is
 * checked on what the relay keeps (approxHeapBytes).
 * @param {object} message
 * @param {readonly string[]} pinFields
 * @param {readonly string[]} [typeOnlyFields]
 * @returns {{ code: 'bad-request'|'too-large', message: string, field: string }|null}
 */
export function relayBundleProblem(message, pinFields, typeOnlyFields = []) {
  const fail = (code, field) => ({ code, message: `${PROBLEM_TEXT[code]} (${field})`, field })
  const match = message?.match
  if (match && typeof match === 'object') {
    for (const k of pinFields) {
      if (!isPinValue(match[k])) return fail('bad-request', `match.${k}`)
    }
    for (const k of typeOnlyFields) {
      if (!isPinType(match[k])) return fail('bad-request', `match.${k}`)
    }
    // Fields the match list, landing page and PIN check turn into a string or
    // a Date: an object there makes one crafted room answer 500 for everyone.
    for (const k of DISPLAY_MATCH_FIELDS) {
      if (!isDisplayValue(match[k])) return fail('bad-request', `match.${k}`)
    }
  }
  // The teams, however the bundle names them (home/away, team1/team2, legacy
  // teams[]): a non-string name would throw on the landing page.
  for (const k of TEAM_FIELDS) {
    if (teamNameProblem(message?.[k])) return fail('bad-request', k)
  }
  if (Array.isArray(message?.teams)) {
    for (let i = 0; i < message.teams.length && i < 2; i++) {
      if (teamNameProblem(message.teams[i])) return fail('bad-request', `teams[${i}]`)
    }
  }
  const lists = [
    ['events', MAX_RELAY_EVENTS], ['sets', MAX_RELAY_SETS],
    ['players', MAX_RELAY_PLAYERS], ['homePlayers', MAX_RELAY_PLAYERS], ['awayPlayers', MAX_RELAY_PLAYERS],
    ['team1Players', MAX_RELAY_PLAYERS], ['team2Players', MAX_RELAY_PLAYERS]
  ]
  for (const [field, max] of lists) {
    const code = listProblem(message?.[field], max)
    if (code) return fail(code, field)
  }
  return null
}

/**
 * The relay's memory budget in bytes (approxHeapBytes): `total` for every
 * stored bundle and live state, `perAddress` for those of one address.
 * `newRoomTotal` / `newRoomPerAddress` are the lower marks at which a room the
 * relay does not hold yet is refused, so the headroom above is kept for the
 * rooms in play (NEW_ROOM_SHARE). `anonTotal` is the most the rooms the
 * database does not know as official may hold together (RELAY_ANON_SHARE).
 * `maxMb` (OV_RELAY_MAX_MB) sets the total; otherwise RELAY_HEAP_SHARE of
 * `heapLimitBytes` (v8 heap_size_limit). Throws on a bad maxMb.
 * @param {{ heapLimitBytes: number, maxMb?: string|number|null }} opts
 * @returns {{ total: number, perAddress: number, newRoomTotal: number, newRoomPerAddress: number, anonTotal: number }}
 */
export function relayMemoryBudget({ heapLimitBytes, maxMb = null }) {
  let total
  if (maxMb !== null && maxMb !== undefined && String(maxMb).trim() !== '') {
    const mb = Number(String(maxMb).trim())
    if (!Number.isFinite(mb) || mb <= 0) throw new TypeError(`OV_RELAY_MAX_MB must be a positive number of MB (got ${JSON.stringify(maxMb)})`)
    total = Math.floor(mb * 1024 * 1024)
  } else {
    total = Math.floor(heapLimitBytes * RELAY_HEAP_SHARE)
  }
  const perAddress = Math.floor(total / 2)
  return {
    total,
    perAddress,
    newRoomTotal: Math.floor(total * NEW_ROOM_SHARE),
    newRoomPerAddress: Math.floor(perAddress * NEW_ROOM_SHARE),
    anonTotal: Math.floor(total * RELAY_ANON_SHARE)
  }
}
