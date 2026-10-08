'use strict'
/**
 * signSessionCore — "Sign on phone" sessions (docs/qr-signing-spec.md, section 4).
 *
 * ONE implementation of the protocol state machine, shared by every Node relay:
 *   - ./lanRelayCore.cjs createLanRelay (server.js, the Vite dev plugin, Electron)
 *   - ../../backend/lib/signSessions.js, an ESM copy GENERATED from this file by
 *     ../scripts/make-sign-core.mjs (the backend's Docker context has no frontend/)
 * src-tauri/src/sign.rs is the Rust port. The shared vectors in
 * ./__fixtures__/sign-vectors.json run against all three.
 *
 * Dependency-free CommonJS without any require() (the Vite config bundler turns
 * it into ESM, and the generated backend copy is plain ESM). Randomness and
 * SHA-256 may be injected; the defaults are WebCrypto's getRandomValues and the
 * small SHA-256 below.
 *
 * Endpoints (all POST + JSON; the relay adapters read the body and do the auth):
 *   start  { slot, matchKey?, context }   -> 201 { ok, token, watch, expiresAt, ttlSeconds, path }
 *   open   { k }                          -> 200 { ok, state:'opened', slot, context, expiresAt, app? }
 *   submit { k, pad, strokes }            -> 200 { ok }                (single use)
 *   wait   { watch, known? }              -> 200 { ok, state, ... }     (long-poll, <= 25 s)
 *   close  { watch }                      -> 200 { ok }                 (idempotent)
 * Errors: { ok:false, code, message } with the codes of spec 4.4.
 *
 * Only SHA-256 hashes of the token and the watch secret are kept. Nothing is
 * persisted, and no secret, context or stroke is ever logged.
 *
 * `app`: the relay adapter (never the request body) may name the session's app
 * at start, start(body, { owner, app: 'beach' }); open then answers
 * `app: 'beach'` and the phone page shows OpenBeach's name and mark. Only the
 * cloud backend does (by the match's sport_type); every other session has no
 * `app` and the page stays as its relay serves it.
 */

const SIGN_TTL_MS = 10 * 60 * 1000 // an unsigned session
const SIGNED_TTL_MS = 5 * 60 * 1000 // strokes kept after signing
const MAX_LIFE_MS = 15 * 60 * 1000 // never longer than this from start
const TOMBSTONE_MS = 60 * 1000 // "expired" / "cancelled" / "used" answers after the end
const WAIT_MS = 25 * 1000 // long-poll hold
const SWEEP_MS = 60 * 1000
const RATE_WINDOW_MS = 5 * 60 * 1000
const SUBMIT_BODY_MAX = 64 * 1024
const BODY_MAX = 4 * 1024
const SIGN_PATH = '/sign'

const CLOUD_CAPS = Object.freeze({ total: 2000, perOwner: 20, startPerOwner: 30, phonePerIp: 120, waiters: 1000 })
const LAN_CAPS = Object.freeze({ total: 200, perOwner: 20, startPerOwner: 60, phonePerIp: 600, waiters: 200 })

const SLOTS = Object.freeze([
  'captain-a', 'captain-b', 'asst-scorer', 'scorer', 'ref2', 'ref1',
  'coach-home', 'coach-away', 'captain-home', 'captain-away',
  'captain-post-home', 'captain-post-away',
])
const LANGS = ['en', 'de', 'de-CH', 'fr', 'it']
// [key, max characters, required]
const CONTEXT_TEXT = [['matchNo', 20, false], ['home', 60, true], ['away', 60, true], ['name', 80, false], ['when', 32, false]]
const CONTEXT_ENUM = [['teamSide', ['home', 'away']], ['teamLabel', ['A', 'B']], ['lang', LANGS]]
const CONTEXT_ORDER = ['matchNo', 'home', 'away', 'teamSide', 'teamLabel', 'name', 'when', 'lang']

const PAD_W = 4000
const PAD_H_MIN = 1000
const PAD_H_MAX = 4000
const MAX_STROKES = 300
const MAX_STROKE_LEN = 2000 // numbers in one stroke (1000 points)
const MAX_POINTS = 4000
const MIN_INK = 0.06 * PAD_W // total polyline length

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/

// Headers of the phone page (/sign*) on every relay (spec 4.7)
const SIGN_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const SIGN_PAGE_HEADERS = Object.freeze({
  'Content-Security-Policy': SIGN_PAGE_CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache',
})
// Headers of every /api/sign/* answer
const SIGN_API_HEADERS = Object.freeze({ 'Cache-Control': 'no-store' })

const MESSAGES = {
  OV_SIGN_BAD_REQUEST: 'Invalid request',
  OV_SIGN_SLOT: 'Unknown signature slot',
  OV_SIGN_CONTEXT: 'Both team names are needed',
  OV_SIGN_INK_INVALID: 'The signature is empty or invalid',
  OV_SIGN_FORBIDDEN: 'This device may not start phone signing',
  OV_SIGN_PIN_INVALID: 'Wrong game PIN',
  OV_SIGN_NOT_FOUND: 'This link is not valid',
  OV_SIGN_USED: 'This link was already used',
  OV_SIGN_CANCELLED: 'Signing was cancelled on the scoring device',
  OV_SIGN_EXPIRED: 'This link has expired',
  OV_SIGN_TOO_LARGE: 'Request body too large',
  OV_SIGN_RATE_LIMITED: 'Too many requests. Please wait a moment.',
  OV_SIGN_BUSY: 'Phone signing is busy. Try again in a moment.',
  OV_SIGN_UNAVAILABLE: 'Phone signing is not available on this server',
  OV_AUTH_REQUIRED: 'Sign in to sign on a phone',
}

/** An error answer: { status, body:{ ok:false, code, message }, headers? }. */
function signError(status, code, headers) {
  const r = { status, body: { ok: false, code, message: MESSAGES[code] || 'Error' } }
  if (headers) r.headers = headers
  return r
}

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4) over UTF-8 text, hex out. Small and dependency-free;
// relays that have node:crypto inject theirs.
// ---------------------------------------------------------------------------

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function utf8Bytes(text) {
  const s = String(text)
  const out = []
  for (const ch of s) {
    let c = ch.codePointAt(0)
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd // lone surrogate
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

function sha256Hex(text) {
  const bytes = utf8Bytes(text)
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const hi = Math.floor(bitLen / 0x100000000)
  const lo = bitLen >>> 0
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255)
  bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('')
}

function defaultRandomBytes(n) {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('signSessionCore: no CSPRNG (pass randomBytes)')
  return c.getRandomValues(new Uint8Array(n))
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
/** base64url without padding (32 bytes -> 43 characters). */
function base64url(bytes) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63]
  }
  return out
}

/** A presented token / watch secret has the shape of one (43 base64url characters). */
function isSecretShape(v) {
  return typeof v === 'string' && SECRET_RE.test(v)
}

// ---------------------------------------------------------------------------
// Validation (identical rules in sign.rs; vectors in __fixtures__/sign-vectors.json)
// ---------------------------------------------------------------------------

// C0, DEL, C1, and the bidi embeddings / overrides / isolates
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g
const EDGE_SPACE_RE = /^[\s﻿]+|[\s﻿]+$/g

/** NFC, control and bidi characters removed, trimmed, cut to `max` code points. */
function sanitizeText(value, max) {
  let s = String(value).normalize('NFC').replace(CONTROL_RE, '').replace(EDGE_SPACE_RE, '')
  const chars = Array.from(s)
  if (chars.length > max) s = chars.slice(0, max).join('').replace(EDGE_SPACE_RE, '')
  return s
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The context the phone page shows. { ok:true, context } or { ok:false, code }.
 * A known key with a non-string value: OV_SIGN_BAD_REQUEST. An empty home or
 * away: OV_SIGN_CONTEXT. Unknown keys and enum values outside the list are dropped.
 */
function validateContext(raw) {
  if (!isPlainObject(raw)) return { ok: false, code: 'OV_SIGN_BAD_REQUEST' }
  const out = {}
  for (const [key, max, required] of CONTEXT_TEXT) {
    const v = raw[key]
    if (v === undefined || v === null) {
      if (required) return { ok: false, code: 'OV_SIGN_CONTEXT' }
      continue
    }
    if (typeof v !== 'string') return { ok: false, code: 'OV_SIGN_BAD_REQUEST' }
    const s = sanitizeText(v, max)
    if (!s) {
      if (required) return { ok: false, code: 'OV_SIGN_CONTEXT' }
      continue
    }
    out[key] = s
  }
  for (const [key, allowed] of CONTEXT_ENUM) {
    const v = raw[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return { ok: false, code: 'OV_SIGN_BAD_REQUEST' }
    if (allowed.includes(v)) out[key] = v
  }
  const ordered = {}
  for (const k of CONTEXT_ORDER) if (k in out) ordered[k] = out[k]
  return { ok: true, context: ordered }
}

const isIntIn = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi

/**
 * The pen strokes of a phone signature (spec 4.3). { ok:true, pad, strokes }
 * (numbers as integers) or { ok:false, code:'OV_SIGN_INK_INVALID' }.
 */
function validateStrokes(pad, strokes) {
  const bad = { ok: false, code: 'OV_SIGN_INK_INVALID' }
  if (!isPlainObject(pad) || pad.w !== PAD_W || !isIntIn(pad.w, PAD_W, PAD_W) || !isIntIn(pad.h, PAD_H_MIN, PAD_H_MAX)) return bad
  if (!Array.isArray(strokes) || strokes.length < 1 || strokes.length > MAX_STROKES) return bad
  const w = pad.w
  const h = pad.h
  let points = 0
  let ink = 0
  const clean = []
  for (const stroke of strokes) {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > MAX_STROKE_LEN || stroke.length % 2 !== 0) return bad
    points += stroke.length / 2
    if (points > MAX_POINTS) return bad
    const out = new Array(stroke.length)
    for (let i = 0; i < stroke.length; i += 2) {
      const x = stroke[i]
      const y = stroke[i + 1]
      if (!isIntIn(x, 0, w) || !isIntIn(y, 0, h)) return bad
      out[i] = x
      out[i + 1] = y
      if (i >= 2) {
        const dx = x - out[i - 2]
        const dy = y - out[i - 1]
        ink += Math.sqrt(dx * dx + dy * dy)
      }
    }
    clean.push(out)
  }
  if (!(ink >= MIN_INK)) return bad
  return { ok: true, pad: { w, h }, strokes: clean }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   now?: () => number,
 *   randomBytes?: (n: number) => Uint8Array,
 *   sha256?: (text: string) => string,
 *   caps?: Partial<typeof LAN_CAPS>,
 *   waitMs?: number,
 *   via?: 'cloud'|'lan',
 *   log?: (line: string) => void,
 *   timers?: { setTimeout, clearTimeout, setInterval, clearInterval },
 * }} [options]
 */
function createSignSessions(options = {}) {
  const now = options.now || Date.now
  const randomBytes = options.randomBytes || defaultRandomBytes
  const sha256 = options.sha256 || sha256Hex
  const caps = { ...(options.via === 'cloud' ? CLOUD_CAPS : LAN_CAPS), ...(options.caps || {}) }
  const waitMs = options.waitMs ?? WAIT_MS
  const via = options.via || 'lan'
  const log = options.log || ((line) => console.log(line))
  const timers = options.timers || { setTimeout, clearTimeout, setInterval, clearInterval }

  const byToken = new Map() // tokenHash -> session
  const byWatch = new Map() // watchHash -> session
  const deadTokens = new Map() // tokenHash -> { kind, until }
  const deadWatches = new Map() // watchHash -> { kind, until }
  const rate = new Map() // key -> { count, start }
  let waiters = 0
  let sweeper = null

  const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t }

  function line(event, s) {
    try { log(`sign.${event} ref=${s.ref} slot=${s.slot} via=${via}`) } catch { /* never break on logging */ }
  }

  /** Fixed 5-minute window: counts one hit, returns the seconds to wait or 0. */
  function limited(key, max) {
    const t = now()
    if (rate.size > 10000) {
      for (const [k, e] of rate) if (t - e.start >= RATE_WINDOW_MS) rate.delete(k)
      if (rate.size > 10000) rate.clear()
    }
    let e = rate.get(key)
    if (!e || t - e.start >= RATE_WINDOW_MS) {
      e = { count: 0, start: t }
      rate.set(key, e)
    }
    e.count++
    if (e.count <= max) return 0
    return Math.max(1, Math.ceil((e.start + RATE_WINDOW_MS - t) / 1000))
  }
  const rateLimited = (retryAfter) => signError(429, 'OV_SIGN_RATE_LIMITED', { 'Retry-After': String(retryAfter) })

  const liveUntil = (s) => (s.state === 'signed' ? Math.min(s.signedAt + SIGNED_TTL_MS, s.createdAt + MAX_LIFE_MS) : s.expiresAt)

  function ownerCount(owner) {
    let n = 0
    for (const s of byToken.values()) if (s.owner === owner) n++
    return n
  }

  function waitAnswer(s) {
    const body = { ok: true, state: s.state, expiresAt: s.expiresAt }
    if (s.openedAt != null) body.openedAt = s.openedAt
    if (s.signedAt != null) body.signedAt = s.signedAt
    if (s.state === 'signed') {
      body.pad = s.pad
      body.strokes = s.strokes
    }
    return { status: 200, body }
  }
  const deadWaitAnswer = (kind) => ({ status: 200, body: { ok: true, state: kind === 'cancelled' ? 'closed' : 'expired' } })

  /** Answer the session's pending wait, if any. */
  function wake(s, answer) {
    const w = s.waiter
    if (!w) return
    s.waiter = null
    w.finish(answer || waitAnswer(s))
  }

  /**
   * End a session ('expired' | 'cancelled'): tombstones for both secrets, the
   * waiter told. A signed session's token stays "used" whatever ends it.
   */
  function end(s, kind, at) {
    byToken.delete(s.tokenHash)
    byWatch.delete(s.watchHash)
    const until = at + TOMBSTONE_MS
    deadTokens.set(s.tokenHash, { kind: s.state === 'signed' ? 'used' : kind, until })
    deadWatches.set(s.watchHash, { kind, until })
    s.pad = null
    s.strokes = null
    wake(s, deadWaitAnswer(kind))
    line(kind === 'cancelled' ? 'close' : 'expire', s)
  }

  /** The live session for a hash (expired ones are ended here), or a tombstone, or null. */
  function lookup(map, deadMap, hash) {
    const t = now()
    const s = map.get(hash)
    if (s) {
      const until = liveUntil(s)
      if (t < until) return { session: s }
      end(s, 'expired', until)
    }
    const dead = deadMap.get(hash)
    if (dead) {
      if (t < dead.until) return { dead }
      deadMap.delete(hash)
    }
    return null
  }

  function deadTokenError(dead) {
    if (dead.kind === 'used') return signError(409, 'OV_SIGN_USED')
    if (dead.kind === 'cancelled') return signError(409, 'OV_SIGN_CANCELLED')
    return signError(410, 'OV_SIGN_EXPIRED')
  }

  function ensureSweeper() {
    if (sweeper) return
    sweeper = unref(timers.setInterval(sweep, SWEEP_MS))
  }

  /** Ends what has run out and forgets old tombstones and counters. */
  function sweep() {
    const t = now()
    for (const s of [...byToken.values()]) {
      const until = liveUntil(s)
      if (t >= until) end(s, 'expired', until)
    }
    for (const m of [deadTokens, deadWatches]) for (const [k, d] of m) if (t >= d.until) m.delete(k)
    for (const [k, e] of rate) if (t - e.start >= RATE_WINDOW_MS) rate.delete(k)
  }

  /**
   * POST /api/sign/start, after the relay's own auth.
   * @param {any} body
   * @param {{ owner: string }} who
   */
  function start(body, { owner, app = null }) {
    const retry = limited(`start:${owner}`, caps.startPerOwner)
    if (retry) return rateLimited(retry)
    if (!isPlainObject(body)) return signError(400, 'OV_SIGN_BAD_REQUEST')
    if (typeof body.slot !== 'string' || !SLOTS.includes(body.slot)) return signError(400, 'OV_SIGN_SLOT')
    let matchKey = null
    if (body.matchKey !== undefined && body.matchKey !== null) {
      if (typeof body.matchKey !== 'string') return signError(400, 'OV_SIGN_BAD_REQUEST')
      const mk = body.matchKey.trim()
      if (mk.length > 128) return signError(400, 'OV_SIGN_BAD_REQUEST')
      matchKey = mk || null
    }
    const ctx = validateContext(body.context)
    if (!ctx.ok) return signError(400, ctx.code)
    sweepIfFull()
    if (byToken.size >= caps.total) return signError(503, 'OV_SIGN_BUSY', { 'Retry-After': '30' })
    if (ownerCount(owner) >= caps.perOwner) return rateLimited(60)

    const token = base64url(randomBytes(32))
    const watch = base64url(randomBytes(32))
    const t = now()
    const tokenHash = sha256(token)
    const s = {
      tokenHash,
      watchHash: sha256(watch),
      ref: tokenHash.slice(0, 8),
      state: 'pending',
      slot: body.slot,
      matchKey,
      context: ctx.context,
      app: app === 'beach' ? 'beach' : null,
      owner,
      createdAt: t,
      expiresAt: t + SIGN_TTL_MS,
      openedAt: null,
      signedAt: null,
      pad: null,
      strokes: null,
      waiter: null,
    }
    byToken.set(s.tokenHash, s)
    byWatch.set(s.watchHash, s)
    ensureSweeper()
    line('start', s)
    return {
      status: 201,
      body: { ok: true, token, watch, expiresAt: s.expiresAt, ttlSeconds: SIGN_TTL_MS / 1000, path: SIGN_PATH },
    }
  }

  function sweepIfFull() {
    if (byToken.size >= caps.total) sweep()
  }

  /** The phone's rate limit and token lookup: { session } or an error result. */
  function phoneSession(body, ipKey) {
    const retry = limited(`phone:${ipKey}`, caps.phonePerIp)
    if (retry) return { error: rateLimited(retry) }
    if (!isPlainObject(body)) return { error: signError(400, 'OV_SIGN_BAD_REQUEST') }
    if (!isSecretShape(body.k)) return { error: signError(404, 'OV_SIGN_NOT_FOUND') }
    const found = lookup(byToken, deadTokens, sha256(body.k))
    if (!found) return { error: signError(404, 'OV_SIGN_NOT_FOUND') }
    if (found.dead) return { error: deadTokenError(found.dead) }
    if (found.session.state === 'signed') return { error: signError(409, 'OV_SIGN_USED') }
    return { session: found.session }
  }

  /** POST /api/sign/open (the phone page). */
  function open(body, { ipKey }) {
    const r = phoneSession(body, ipKey)
    if (r.error) return r.error
    const s = r.session
    if (s.state === 'pending') {
      s.state = 'opened'
      s.openedAt = now()
      line('open', s)
      wake(s)
    }
    const out = { ok: true, state: s.state, slot: s.slot, context: s.context, expiresAt: s.expiresAt }
    if (s.app) out.app = s.app
    return { status: 200, body: out }
  }

  /** POST /api/sign/submit (the phone page): single use. */
  function submit(body, { ipKey }) {
    const r = phoneSession(body, ipKey)
    if (r.error) return r.error
    const s = r.session
    const v = validateStrokes(body.pad, body.strokes)
    if (!v.ok) return signError(400, v.code)
    const t = now()
    if (s.openedAt == null) s.openedAt = t
    s.state = 'signed'
    s.signedAt = t
    s.pad = v.pad
    s.strokes = v.strokes
    line('submit', s)
    wake(s)
    return { status: 200, body: { ok: true } }
  }

  /**
   * POST /api/sign/wait (the scoring device): resolves at once when the state
   * differs from `known`, else on the next change, else after waitMs.
   * @param {any} body
   * @param {{ signal?: AbortSignal }} [opts] aborted when the HTTP request goes away
   * @returns {Promise<{ status: number, body: object, headers?: object }>}
   */
  function wait(body, opts = {}) {
    if (!isPlainObject(body)) return Promise.resolve(signError(400, 'OV_SIGN_BAD_REQUEST'))
    if (!isSecretShape(body.watch)) return Promise.resolve(signError(404, 'OV_SIGN_NOT_FOUND'))
    const found = lookup(byWatch, deadWatches, sha256(body.watch))
    if (!found) return Promise.resolve(signError(404, 'OV_SIGN_NOT_FOUND'))
    if (found.dead) return Promise.resolve(deadWaitAnswer(found.dead.kind))
    const s = found.session
    if (body.known !== s.state) return Promise.resolve(waitAnswer(s))
    // One wait per session: a newer one answers the older at once
    wake(s)
    if (waiters >= caps.waiters) return Promise.resolve(signError(503, 'OV_SIGN_BUSY', { 'Retry-After': '5' }))
    return new Promise((resolve) => {
      let done = false
      waiters++
      const hold = Math.max(0, Math.min(waitMs, liveUntil(s) - now()))
      const w = {
        finish(answer) {
          if (done) return
          done = true
          waiters--
          timers.clearTimeout(timer)
          if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
          if (s.waiter === w) s.waiter = null
          resolve(answer)
        },
      }
      // Not unref'd: it lives only while a request is held, which keeps the process up anyway
      const timer = timers.setTimeout(() => {
        // Expired meanwhile: lookup ends it and answers through end()
        const again = lookup(byWatch, deadWatches, s.watchHash)
        if (again && again.dead) w.finish(deadWaitAnswer(again.dead.kind))
        else if (!again) w.finish(signError(404, 'OV_SIGN_NOT_FOUND'))
        else w.finish(waitAnswer(s))
      }, hold)
      const onAbort = () => w.finish({ status: 499, body: { ok: false, code: 'OV_SIGN_ABORTED', message: 'aborted' } })
      if (opts.signal) {
        if (opts.signal.aborted) { onAbort(); return }
        opts.signal.addEventListener('abort', onAbort)
      }
      s.waiter = w
    })
  }

  /** POST /api/sign/close (the scoring device): idempotent. */
  function close(body) {
    if (!isPlainObject(body)) return signError(400, 'OV_SIGN_BAD_REQUEST')
    if (!isSecretShape(body.watch)) return signError(404, 'OV_SIGN_NOT_FOUND')
    const s = byWatch.get(sha256(body.watch))
    if (s) end(s, 'cancelled', now())
    return { status: 200, body: { ok: true } }
  }

  /** Stop: every waiter answered, the sweeper cleared, nothing kept. */
  function dispose() {
    for (const s of byToken.values()) wake(s, signError(503, 'OV_SIGN_UNAVAILABLE'))
    if (sweeper) timers.clearInterval(sweeper)
    sweeper = null
    byToken.clear(); byWatch.clear(); deadTokens.clear(); deadWatches.clear(); rate.clear()
  }

  return {
    start,
    open,
    submit,
    wait,
    close,
    sweep,
    dispose,
    /** For tests and status: counts only, never a secret. */
    stats: () => ({ sessions: byToken.size, tombstones: deadTokens.size, waiters, sweeper: !!sweeper }),
    caps,
  }
}

/** Which /api/sign/* path this is ('start' | 'open' | 'submit' | 'wait' | 'close'), or null. */
function signEndpointOf(path) {
  const m = /^\/api\/sign\/(start|open|submit|wait|close)$/.exec(path)
  return m ? m[1] : null
}

/** The body cap of an endpoint. */
function signBodyLimit(endpoint) {
  return endpoint === 'submit' ? SUBMIT_BODY_MAX : BODY_MAX
}

/** Is this a phone-page path (/sign, /sign/, /sign/...)? */
function isSignPagePath(path) {
  return path === SIGN_PATH || path.startsWith(SIGN_PATH + '/')
}

module.exports = {
  SIGN_TTL_MS,
  SIGNED_TTL_MS,
  MAX_LIFE_MS,
  TOMBSTONE_MS,
  WAIT_MS,
  SWEEP_MS,
  RATE_WINDOW_MS,
  SUBMIT_BODY_MAX,
  BODY_MAX,
  SIGN_PATH,
  CLOUD_CAPS,
  LAN_CAPS,
  SLOTS,
  SIGN_PAGE_CSP,
  SIGN_PAGE_HEADERS,
  SIGN_API_HEADERS,
  MESSAGES,
  signError,
  sha256Hex,
  base64url,
  isSecretShape,
  sanitizeText,
  validateContext,
  validateStrokes,
  createSignSessions,
  signEndpointOf,
  signBodyLimit,
  isSignPagePath,
}
