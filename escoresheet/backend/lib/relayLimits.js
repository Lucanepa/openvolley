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

// approxHeapBytes: what V8 keeps of a parsed JSON value (measured with Node
// 22 and 24): a property or array element 8 bytes, an empty object 56 (room
// for 4 properties), an array 32 and 16 more for its elements, a string 24
// plus its characters (one byte each when all are ASCII, else two), a number
// that is no small integer 16. A key costs once per value walked: V8 keeps
// each name once and shares the hidden class of objects with the same keys;
// new keys cost about 130 bytes each (one object with many, or many objects
// each with its own).
const SLOT_BYTES = 8
const OBJECT_BYTES = 56
const ARRAY_BYTES = 32
const ELEMENTS_BYTES = 16
const STRING_BYTES = 24
const HEAP_NUMBER_BYTES = 16
const NEW_KEY_BYTES = 128
// Names remembered per value; past that every name counts as new (more is no bundle)
const MAX_TRACKED_KEYS = 4096
// A short string is counted at two bytes per character without looking at it
const SHORT_STRING = 64

const isSmallInt = (n) => Number.isInteger(n) && n >= -0x40000000 && n < 0x40000000
const stringBytes = (s) => (s.length <= SHORT_STRING || Buffer.byteLength(s) !== s.length ? 2 * s.length : s.length)

/**
 * About how many heap bytes a parsed JSON value takes (see above): at least
 * what V8 used for every shape measured (empty and nested objects and
 * arrays, numbers, unique keys and strings), 1.1-1.8x of it for real
 * bundles. Iterative: the frame was checked for depth before
 * (realtimeHub.js jsonTooDeep).
 * @param {unknown} value
 * @returns {number}
 */
export function approxHeapBytes(value) {
  let bytes = 0
  const keys = new Set()
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
        for (const k in v) {
          if (!keys.has(k)) {
            bytes += NEW_KEY_BYTES + 2 * k.length
            if (keys.size < MAX_TRACKED_KEYS) keys.add(k)
          }
          stack.push(v[k])
        }
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

const isPinValue = (v) =>
  v === undefined || v === null ||
  (typeof v === 'string' && v.length <= MAX_RELAY_PIN_LENGTH) ||
  (typeof v === 'number' && Number.isFinite(v))
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
 * number ('bad-request': the PIN checks compare text), an events / sets /
 * player list that is not an array ('bad-request') or longer than its limit
 * ('too-large'). Null when it may be kept; its size is checked on what the
 * relay keeps (approxHeapBytes).
 * @param {object} message
 * @param {readonly string[]} pinFields
 * @returns {{ code: 'bad-request'|'too-large', message: string, field: string }|null}
 */
export function relayBundleProblem(message, pinFields) {
  const fail = (code, field) => ({ code, message: `${PROBLEM_TEXT[code]} (${field})`, field })
  const match = message?.match
  if (match && typeof match === 'object') {
    for (const k of pinFields) {
      if (!isPinValue(match[k])) return fail('bad-request', `match.${k}`)
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
 * `maxMb` (OV_RELAY_MAX_MB) sets the total; otherwise RELAY_HEAP_SHARE of
 * `heapLimitBytes` (v8 heap_size_limit). Throws on a bad maxMb.
 * @param {{ heapLimitBytes: number, maxMb?: string|number|null }} opts
 * @returns {{ total: number, perAddress: number }}
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
  return { total, perAddress: Math.floor(total / 2) }
}
