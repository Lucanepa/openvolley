/**
 * PINs at rest (matches.game_pin, matches.connection_pins.*).
 *
 * A match PIN is 6 digits: one million values. Any hash anyone can compute
 * (plain or salted SHA-256, even bcrypt) falls to a brute force of that space
 * in minutes to hours, and a slow hash would also cost a validate-connection-pin
 * scan of every live match one bcrypt per row. So the stored value is an HMAC
 * with a server-side secret that is NOT in the database:
 *
 *   h1:<base64url HMAC-SHA256(OV_PIN_SECRET, "<kind>:<pin>")>
 *
 * kind is 'game' for game_pin and the connection_pins key otherwise ('referee',
 * 'bench_home', 'bench_away', 'upload_home', 'upload_away'). A database dump or
 * a leaked backup alone then reveals no PIN; the secret lives in the backend's
 * environment only. Comparisons are constant time.
 *
 * Without a secret (OV_PIN_SECRET unset, the LAN relay, tests) nothing is
 * hashed and every comparison is plaintext, exactly as before. Values stored
 * before the secret was set stay plaintext until they are written again (or
 * scripts/hash-pins.mjs rewrites them); both forms are accepted on read.
 *
 * Losing or changing the secret makes every hashed PIN unverifiable (referee,
 * bench and roster PIN checks, restore-by-PIN, take-over fail for matches stored
 * with the old one). Treat it like a password: keep it in the secret store.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const PIN_HASH_PREFIX = 'h1:'
const HASH_RE = /^h1:[A-Za-z0-9_-]{43}$/
export const CONNECTION_PIN_KINDS = Object.freeze(['referee', 'bench_home', 'bench_away', 'upload_home', 'upload_away'])
export const MIN_SECRET_LENGTH = 32

/** True for a value written by hash() (any secret). */
export const isHashedPin = (v) => typeof v === 'string' && HASH_RE.test(v)

function safeEqual (a, b) {
  const x = Buffer.from(String(a), 'utf8')
  const y = Buffer.from(String(b), 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

const pinText = (pin) => (pin === undefined || pin === null ? '' : String(pin).trim())

/**
 * @param {string|null|undefined} secret  OV_PIN_SECRET; empty = hashing off
 */
export function createPinHasher (secret) {
  const key = typeof secret === 'string' && secret.length > 0 ? secret : null
  if (key && key.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`OV_PIN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
  }

  /** The stored form of `pin` (hashed when a secret is set). Empty stays empty. */
  function hash (kind, pin) {
    const p = pinText(pin)
    if (!p || !key || isHashedPin(p)) return p
    return PIN_HASH_PREFIX + createHmac('sha256', key).update(`${kind}:${p}`, 'utf8').digest('base64url')
  }

  /** Does the typed `pin` match the `stored` value (hashed or legacy plaintext)? */
  function matches (kind, pin, stored) {
    const p = pinText(pin)
    const s = pinText(stored)
    if (!p || !s) return false
    if (isHashedPin(s)) return key ? safeEqual(hash(kind, p), s) : false
    return safeEqual(p, s)
  }

  /** Every stored form `pin` may have (for an exact-match SQL filter). */
  function candidates (kind, pin) {
    const p = pinText(pin)
    if (!p) return []
    return key ? [p, hash(kind, p)] : [p]
  }

  /**
   * A matches row (or write payload) with its PIN columns in stored form:
   * game_pin hashed, each connection_pins value hashed under its key. Other
   * keys are untouched; returns a new object only when something changed.
   */
  function hashMatchRow (row) {
    if (!key || !row || typeof row !== 'object' || Array.isArray(row)) return row
    let out = row
    const set = (k, v) => { if (out === row) out = { ...row }; out[k] = v }
    if (typeof row.game_pin === 'string' || typeof row.game_pin === 'number') {
      const h = hash('game', row.game_pin)
      if (h !== row.game_pin) set('game_pin', h)
    }
    const cp = row.connection_pins
    if (cp && typeof cp === 'object' && !Array.isArray(cp)) {
      let next = cp
      for (const [k, v] of Object.entries(cp)) {
        if (typeof v !== 'string' && typeof v !== 'number') continue
        const h = hash(k, v)
        if (h !== v) {
          if (next === cp) next = { ...cp }
          next[k] = h
        }
      }
      if (next !== cp) set('connection_pins', next)
    }
    return out
  }

  return { enabled: !!key, hash, matches, candidates, hashMatchRow }
}

/** The hasher for this process's environment (OV_PIN_SECRET). Throws on a too-short secret. */
export function pinHasherFromEnv (env = process.env) {
  return createPinHasher(env.OV_PIN_SECRET ? String(env.OV_PIN_SECRET) : null)
}
