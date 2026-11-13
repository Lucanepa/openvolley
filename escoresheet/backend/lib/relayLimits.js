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
 * 20-80 KB each) 0.5-1.2 MB, about as much in the heap, which approxHeapBytes
 * counts at 0.7-1.8 MB (an upper bound for any layout). An older scorer
 * (before 2026-10-26) sends each event's undo snapshot too, 2-3 MB in all,
 * which the relay drops before it keeps the bundle (relayEvents).
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
/**
 * One PIN field the relay never compares, only keeps and carries over into the
 * room's later syncs that leave it out (a connection_pins object, openbeach's
 * matchPin), as approxHeapBytes counts it. Real ones are a few hundred bytes:
 * five PINs, a PIN someone typed.
 */
export const MAX_RELAY_CARRIED_PIN_BYTES = 16 * 1024
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
 * --max-old-space-size=256 (V8 limit 304 MB on Node 22) about 106 MB: 60 to
 * 160 matches at their end with all 14 signatures, half of them behind one
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

// approxHeapBytes: an upper bound on the heap V8 keeps of a parsed JSON value
// (Node 22 / 24, 64-bit, no pointer compression), so that no layout a socket
// chooses can make a stored bundle take more heap than the relay's limits
// count. Every part is counted at the most V8 can give it:
// - a value: the 8-byte slot that holds it (a property or array element);
// - a number: a 16-byte box on top, whatever the number. V8 keeps a small
//   integer unboxed only while the field holds integers: once one object with
//   the same keys had a decimal there, that field is boxed in every object of
//   the key order, and of every key list that starts with the same keys;
// - a string: a 32-byte header (16) with its alignment (up to 7) plus its
//   characters, two bytes each unless it is long and plain ASCII;
// - an object: 88 bytes, its 24-byte header, the four in-object slots V8
//   reserves and the property array an object built key by key grows (its
//   header and up to two unused slots);
// - an array: 176 bytes, its header, its store's header and the 16 slots V8
//   adds when it grows one, plus half again of its elements' slots (the room
//   left after growing; a filter() result keeps it);
// - a key name: 128 bytes and two per character, once (V8 interns it);
// - a hash table (dictionary mode) for an object with more than
//   FAST_PROPERTIES named keys (JSON.parse switches at 128, an object built key
//   by key at about 20, and which one V8 chose cannot be seen from here), and
//   one for integer-like keys ("7", "1000"): 128 bytes and 72 per entry (88 for
//   an integer key), the capacity of up to three times the entries;
// - its hidden classes, below.
const SLOT_BYTES = 8
const HEAP_NUMBER_BYTES = 16
const STRING_BYTES = 32
const OBJECT_BYTES = 88
const ARRAY_BYTES = 176
// Per element of an array: the half again of room a grown store may keep
const ARRAY_SLACK_BYTES = SLOT_BYTES / 2
const NEW_KEY_BYTES = 128
/** Named properties an object may have and still be counted in the compact layout */
export const FAST_PROPERTIES = 16
const DICTIONARY_BYTES = 128
const DICTIONARY_ENTRY_BYTES = 72
const INDEX_ENTRY_BYTES = DICTIONARY_ENTRY_BYTES + HEAP_NUMBER_BYTES
// An object carries a hidden class, a V8 map chain: a map, descriptors, an
// enum cache and transitions per key, under MAP_KEY_BYTES each. Objects with
// the same keys in the same order share one; a different order has a chain of
// its own, and an anonymous socket can give every object its own order. V8
// also gives a key order a new chain when one of its fields widens (a small
// integer, then a decimal, then anything else: at most twice per field), and
// the objects parsed before keep the old chain alive. A key order lives under
// two roots (the one JSON.parse uses, and the one of objects built key by key
// such as relayEvents' copies). So the first chainsPerOrder(named) objects of
// every key order each count a whole chain: more chains than V8 can keep for
// that order, whatever the values and their order. A bundle of real events
// has a few dozen key orders. The order is the key list with each name
// length-prefixed, so no name (one holding the separator, say) can make two
// key lists one.
const MAP_BASE_BYTES = 64
const MAP_KEY_BYTES = 160
const chainsPerOrder = (named) => 2 * (2 * named + 1)
// Key orders remembered per value; past that every object counts a chain of
// its own (an upper bound: an attacker needs this many key orders to get here)
const MAX_TRACKED_SHAPES = 4096
// Names remembered per value; past that every name counts as new (more is no bundle)
const MAX_TRACKED_KEYS = 4096
// A short string is counted at two bytes per character without looking at it
const SHORT_STRING = 64

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
 * At most how many heap bytes a parsed JSON value takes, an upper bound (see
 * above): at or above the heap V8 keeps for every layout measured along the
 * relay's own path (tests/helpers/heapShapes.js), about 1.3-1.6x of it for
 * real bundles. Iterative: the frame was checked for depth before
 * (realtimeHub.js jsonTooDeep).
 * @param {unknown} value
 * @returns {number}
 */
export function approxHeapBytes(value) {
  let bytes = 0
  const keys = new Set()
  // key order -> objects of it counted with a chain of their own
  const shapes = new Map()
  const stack = [value]
  while (stack.length > 0) {
    const v = stack.pop()
    bytes += SLOT_BYTES
    if (typeof v === 'string') {
      bytes += STRING_BYTES + stringBytes(v)
    } else if (typeof v === 'number') {
      bytes += HEAP_NUMBER_BYTES
    } else if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) {
        bytes += ARRAY_BYTES + ARRAY_SLACK_BYTES * v.length
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
        if (named > 0) {
          // A whole hidden-class chain while the key order may still have a new
          // one, at any key count (shapes stops tracking new orders when full)
          const counted = shapes.get(shape) ?? 0
          if (counted < chainsPerOrder(named)) {
            bytes += MAP_BASE_BYTES + MAP_KEY_BYTES * named
            if (counted > 0 || shapes.size < MAX_TRACKED_SHAPES) shapes.set(shape, counted + 1)
          }
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

/**
 * Frames of a role socket that owns no room yet (it has proved no scoreboard
 * claim) above this size: only the claim itself carries that much, the first
 * sync-match-data of a scorer's bundle. Everything else a socket sends before
 * a claim (subscribe-match, ping, bench requests and answers) is a few KB.
 */
export const MAX_UNPROVED_FRAME_BYTES = 64 * 1024
/** Such large frames per socket and window: a claim, its retry with the PINs, a sync waiting behind a cloud claim's check. */
export const MAX_UNPROVED_LARGE_FRAMES = 4
/** Bytes of such large frames per address (IPv6 /64 on the cloud) and window: a hall's scorers claiming at once. */
export const MAX_UNPROVED_ADDRESS_BYTES = 32 * 1024 * 1024
/** Bytes per socket and window, any socket: several times an older scorer's 3 MB bundle synced on every rally. */
export const MAX_SOCKET_WINDOW_BYTES = 128 * 1024 * 1024
/** Frames refused per socket and window after which the socket is closed. */
export const MAX_REFUSED_FRAMES = 3

/**
 * The byte budget of the role sockets' frames (server.js), checked on the
 * frame's length before it is parsed. Parsing and walking a frame cost the
 * one CPU about 35 ms per MB, and a socket could send 120 frames of up to
 * 10 MB (compressed, a few KB on the wire) a minute without any claim. Now a
 * socket that owns no room sends a few large frames per window
 * (MAX_UNPROVED_LARGE_FRAMES, MAX_UNPROVED_ADDRESS_BYTES per address), every
 * socket at most MAX_SOCKET_WINDOW_BYTES, and one refused MAX_REFUSED_FRAMES
 * times is closed.
 *
 *   const frames = createFrameBudget()
 *   frames.check(clientInfo.frames, address, data.length, owned) -> 'ok' | 'refused' | 'close'
 *
 * @param {{ windowMs?: number, now?: () => number, maxAddresses?: number, limits?: object }} [opts]
 */
export function createFrameBudget({ windowMs = 60 * 1000, now = Date.now, maxAddresses = 50000, limits = {} } = {}) {
  const lim = {
    unprovedFrameBytes: MAX_UNPROVED_FRAME_BYTES,
    unprovedLargeFrames: MAX_UNPROVED_LARGE_FRAMES,
    unprovedAddressBytes: MAX_UNPROVED_ADDRESS_BYTES,
    socketBytes: MAX_SOCKET_WINDOW_BYTES,
    refusedFrames: MAX_REFUSED_FRAMES,
    ...limits
  }
  // address -> { windowStart, bytes }: the large frames of unproved sockets
  const addresses = new Map()
  const fresh = (e, t) => !!e && t - e.windowStart <= windowMs
  return {
    /**
     * @param {object} socket the socket's own state (an object kept per socket, filled here)
     * @param {string|null} address its address bucket; null: not limited per address (loopback)
     * @param {number} bytes the frame's length
     * @param {boolean} proved the socket owns a room (a proved scoreboard claim)
     * @returns {'ok'|'refused'|'close'}
     */
    check(socket, address, bytes, proved) {
      const t = now()
      if (!fresh(socket, t)) Object.assign(socket, { windowStart: t, bytes: 0, large: 0, refused: 0 })
      let ok = socket.bytes + bytes <= lim.socketBytes
      if (ok && !proved && bytes > lim.unprovedFrameBytes) {
        ok = socket.large < lim.unprovedLargeFrames
        if (ok && address != null) {
          let a = addresses.get(address)
          if (!fresh(a, t)) {
            addresses.delete(address)
            while (addresses.size >= maxAddresses) addresses.delete(addresses.keys().next().value)
            a = { windowStart: t, bytes: 0 }
            addresses.set(address, a)
          }
          ok = a.bytes + bytes <= lim.unprovedAddressBytes
          if (ok) a.bytes += bytes
        }
        if (ok) socket.large++
      }
      if (!ok) {
        socket.refused++
        return socket.refused >= lim.refusedFrames ? 'close' : 'refused'
      }
      socket.bytes += bytes
      return 'ok'
    },
    /** Forget the address windows that are over. */
    sweep() {
      const t = now()
      for (const [k, e] of addresses) if (!fresh(e, t)) addresses.delete(k)
    },
    get addresses() { return addresses.size }
  }
}

// The scorer's undo snapshots on its events: stateSnapshot on every point,
// stateBefore on rally starts, rotations and substitutions. Its own undo and
// corrections use them; no relay subscriber reads them (referee, bench,
// livescore, the LedBox bridge). They were about 90% of a bundle (2.5 KB per
// point, 2.4 MB at the end of a 5-set match), kept parsed per match in
// activeMatches and sent to every tablet twice per rally: at a national peak
// that alone filled the backend's 256 MiB. Dropped when a sync is stored;
// scorers since 2026-10-26 leave them out themselves (frontend relayEvents).
// The copy is made in one step (object rest): one built key by key turns into
// a hash table past about 20 keys, several times the heap of the parsed event
// (approxHeapBytes).
const RELAY_EVENT_OMIT = ['stateSnapshot', 'stateBefore']

/**
 * The events of a sync as the relay keeps them (server.js handleSyncMatchData):
 * each without its undo snapshots; anything that is no array as it is.
 * @param {unknown} events
 * @returns {unknown}
 */
export function relayEvents(events) {
  if (!Array.isArray(events)) return events
  return events.map((e) => {
    if (!e || typeof e !== 'object' || !RELAY_EVENT_OMIT.some((k) => k in e)) return e
    const { stateSnapshot, stateBefore, ...out } = e
    return out
  })
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
// safely elsewhere). No PIN length limit: the user types it with no maximum,
// and a long one must not stop the sync; its size is bounded far above what
// anyone types (MAX_RELAY_CARRIED_PIN_BYTES).
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
 * carriedField (a PIN field the relay only keeps and carries over into the
 * room's later syncs: connection_pins, matchPin) over
 * MAX_RELAY_CARRIED_PIN_BYTES as approxHeapBytes counts it ('too-large': a
 * room's holder could park megabytes there, counted against every later sync
 * that leaves it out), a
 * display field (status, scheduledAt, a team's name) that is not text, a finite
 * number or missing ('bad-request': the match list, landing page and PIN check
 * turn it into a string or a Date, and an object there answers 500 for
 * everyone), an events / sets / player list that is not an array ('bad-request')
 * or longer than its limit ('too-large'). Null when it may be kept; its size is
 * checked on what the relay keeps (approxHeapBytes).
 * @param {object} message
 * @param {readonly string[]} pinFields
 * @param {readonly string[]} [typeOnlyFields]
 * @param {readonly string[]} [carriedFields]
 * @returns {{ code: 'bad-request'|'too-large', message: string, field: string }|null}
 */
export function relayBundleProblem(message, pinFields, typeOnlyFields = [], carriedFields = []) {
  const fail = (code, field) => ({ code, message: `${PROBLEM_TEXT[code]} (${field})`, field })
  const match = message?.match
  if (match && typeof match === 'object') {
    for (const k of pinFields) {
      if (!isPinValue(match[k])) return fail('bad-request', `match.${k}`)
    }
    for (const k of typeOnlyFields) {
      if (!isPinType(match[k])) return fail('bad-request', `match.${k}`)
    }
    for (const k of carriedFields) {
      if (match[k] != null && approxHeapBytes(match[k]) > MAX_RELAY_CARRIED_PIN_BYTES) return fail('too-large', `match.${k}`)
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
