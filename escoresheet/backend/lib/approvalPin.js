/**
 * approvalPin — the pure helpers of account approvals
 * (docs/account-approval-spec.md sections 1.1, 1.3, 1.4 and 2). node:crypto only.
 *
 * Personal approval PIN, 4 to 6 digits, stored in auth.approval_pins as
 *
 *   pinKey = HKDF-SHA256(ikm = OV_PIN_SECRET, salt = <empty>, info = "ov-approval-pin-v1", 32)
 *   mac    = HMAC-SHA256(pinKey, salt16 || lower(user_id) || 0x00 || pin)
 *
 * The key is not in the database, so a dump alone reveals no PIN (the same
 * reason lib/pinHash.js keys match PINs with the secret). The HKDF subkey
 * keeps these MACs apart from the h1: match-PIN HMACs. key_id names the
 * secret generation: rows with another key_id read as "not set".
 *
 * Never log a PIN, a MAC or a salt.
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

export const PIN_RE = /^\d{4,6}$/
export const KEY_ID = 1
export const MIN_SECRET_LENGTH = 32
export const RESULT_KEY_PREFIX = 'ov-result-v1|'

const DUMMY_SALT = Buffer.alloc(16, 0x5a)
const DUMMY_USER_ID = '00000000-0000-0000-0000-000000000000'
const DUMMY_MAC = Buffer.alloc(32, 0)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True for a PIN nobody should pick: one repeated digit (0000, 111111) or a
 * strictly ascending or descending run (1234, 0123, 123456, 4321, 987654).
 * Only meaningful for a PIN that matches PIN_RE.
 */
export function isWeakPin (pin) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) return false
  const d = [...pin].map(Number)
  const steps = d.slice(1).map((v, i) => v - d[i])
  return steps.every((s) => s === 0) || steps.every((s) => s === 1) || steps.every((s) => s === -1)
}

function hkdf (secret, info) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(info, 'utf8'), 32))
}

/** { pinKey, ipKey } from OV_PIN_SECRET. Throws on a missing or too short secret. */
export function deriveKeys (secret) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`OV_PIN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
  }
  return { pinKey: hkdf(secret, 'ov-approval-pin-v1'), ipKey: hkdf(secret, 'ov-approval-ip-v1') }
}

/** The 32-byte MAC of `pin` for `userId` with `salt` (16 bytes). */
export function macPin (pinKey, salt, userId, pin) {
  return createHmac('sha256', pinKey)
    .update(salt)
    .update(Buffer.from(String(userId).toLowerCase(), 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(String(pin), 'utf8'))
    .digest()
}

const isBytes = (v, n) => Buffer.isBuffer(v) && v.length === n

/** True when `row` (an auth.approval_pins row) holds a PIN made with the current key. */
export function isCurrentPinRow (row) {
  return !!row && Number(row.key_id) === KEY_ID && isBytes(row.salt, 16) && isBytes(row.mac, 32)
}

/**
 * Constant-time check of a typed PIN. Always computes exactly one HMAC: with
 * no row, a row of an older key, no user or a malformed PIN it MACs dummy
 * inputs, compares them with a dummy value and answers false.
 * `opts.mac` replaces macPin (tests count the calls).
 */
export function verifyPin (pinKey, row, userId, pin, { mac = macPin } = {}) {
  const usable = isCurrentPinRow(row) && typeof userId === 'string' && UUID_RE.test(userId) &&
    typeof pin === 'string' && PIN_RE.test(pin)
  if (usable) return timingSafeEqual(mac(pinKey, row.salt, userId, pin), row.mac)
  const dummyPin = typeof pin === 'string' ? pin.slice(0, 6) : ''
  timingSafeEqual(mac(pinKey, DUMMY_SALT, DUMMY_USER_ID, dummyPin), DUMMY_MAC)
  return false
}

const pointsOf = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/**
 * The canonical result of a match: its finished sets ordered by index,
 *   "ov-result-v1|<index>:<home>:<away>,..."
 * `sets` holds [index, home, away] triples (the request body, already
 * finished sets) or rows { index, home_points, away_points, finished } (only
 * finished ones count). A missing points value counts as 0.
 */
export function resultKey (sets) {
  const triples = []
  for (const s of Array.isArray(sets) ? sets : []) {
    if (Array.isArray(s)) triples.push([pointsOf(s[0]), pointsOf(s[1]), pointsOf(s[2])])
    else if (s && typeof s === 'object' && s.finished === true) triples.push([pointsOf(s.index), pointsOf(s.home_points), pointsOf(s.away_points)])
  }
  triples.sort((a, b) => a[0] - b[0])
  return RESULT_KEY_PREFIX + triples.map((t) => t.join(':')).join(',')
}

/** The [index, home, away] triples of a result key (for OV_RESULT_NOT_SYNCED details). */
export function triplesOf (key) {
  const body = String(key || '').slice(RESULT_KEY_PREFIX.length)
  return body ? body.split(',').map((t) => t.split(':').map(Number)) : []
}

/** sha256(utf8(key)), 32 bytes. */
export function resultHash (key) {
  return createHash('sha256').update(String(key), 'utf8').digest()
}

/** HMAC-SHA256(ipKey, bucket): `bucket` is the client's ipBucketKey (lib/auth.js). */
export function ipHash (ipKey, bucket) {
  return createHmac('sha256', ipKey).update(String(bucket), 'utf8').digest()
}

/** sha256("ov-device:" + device id), or null without one. */
export function deviceHash (deviceId) {
  if (typeof deviceId !== 'string' || !deviceId) return null
  return createHash('sha256').update('ov-device:' + deviceId.toLowerCase(), 'utf8').digest()
}

/** The ID printed on the PDF: the first 8 hex characters of the uuid, upper case. */
export function shortId (uuid) {
  return String(uuid || '').replace(/-/g, '').slice(0, 8).toUpperCase()
}
