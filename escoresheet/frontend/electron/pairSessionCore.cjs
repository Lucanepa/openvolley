'use strict'
/**
 * pairSessionCore — "Pair a phone" (docs/phone-keyboard-spec.md): the scorer
 * pairs ONE phone with the scoring device, and the phone becomes a remote
 * keyboard for whatever text field is focused on that device.
 *
 * ONE implementation of the protocol state machine, shared by every Node relay:
 *   - ./lanRelayCore.cjs createLanRelay (server.js, the Vite dev plugin)
 *   - ../../backend/lib/pairSessions.js, an ESM copy GENERATED from this file by
 *     ../scripts/make-sign-core.mjs (the backend's Docker context has no frontend/)
 * src-tauri/src/pair.rs is the Rust port. The shared vectors in
 * ./__fixtures__/pair-vectors.json run against all three.
 *
 * Dependency-free CommonJS without any require() (the Vite config bundler turns
 * it into ESM). SHA-256 MUST be injected (`sha256`: node:crypto on the backend,
 * signSessionCore.sha256Hex on the LAN relays); randomness defaults to
 * WebCrypto's getRandomValues.
 *
 * Endpoints (all POST + JSON; the relay adapters read the body and do the auth
 * of start, exactly as for /api/sign/start):
 *   scoring device (holds the `watch` secret)
 *     start  { matchKey?, context }          -> 201 { ok, token, code, watch, joinBy, endsAt, path }
 *     wait   { watch, knownState?, after?, knownPhone? }
 *                                            -> 200 { ok, state, seq, inputs, phone, endsAt }   long-poll <= 25 s
 *     focus  { watch, field: null | { id, label?, kind?, text?, maxLength? }, applied? }
 *                                            -> 200 { ok, v }
 *     close  { watch }                       -> 200 { ok }  (unpair; idempotent)
 *   phone (the token or the short code once, then its own `phone` secret)
 *     join   { k } | { code }                -> 200 { ok, phone, state:'paired', context, endsAt, app? }
 *     poll   { phone, known? }               -> 200 { ok, state, v, field, applied, endsAt }   long-poll <= 25 s
 *     input  { phone, n, field, text?, action?, base? } -> 200 { ok, seq }   (n: the phone's counter, a retry is ignored;
 *                                            base: 8 hex, the FNV-1a hash of the field's text the phone typed on,
 *                                            so the scoring device can merge instead of overwriting what it never showed)
 * Errors: { ok:false, code, message } with the OV_PAIR_* codes below.
 *
 * Lifetimes: the link and the code join within 10 minutes and only once (one
 * phone per pairing). A pairing lives until the scoring device closes it,
 * 6 hours after start, or 5 minutes after the scoring device last called
 * (the app closed). Ended pairings answer "closed" / "expired" for 60 s more.
 *
 * Only SHA-256 hashes of the token, the code, the watch secret and the phone
 * secret are kept. Nothing is persisted, and no secret, context, label or text
 * is ever logged: one line per transition, `pair.<event> ref=<8 hex> via=…`.
 */

const JOIN_TTL_MS = 10 * 60 * 1000 // the QR link / the short code
const MAX_LIFE_MS = 6 * 60 * 60 * 1000 // a pairing, from start
const DEVICE_IDLE_MS = 5 * 60 * 1000 // the scoring device stopped calling
const PHONE_SEEN_MS = 40 * 1000 // the phone counts as connected this long after its last call
const TOMBSTONE_MS = 60 * 1000
const WAIT_MS = 25 * 1000
const SWEEP_MS = 60 * 1000
const RATE_WINDOW_MS = 5 * 60 * 1000
const BURST_WINDOW_MS = 1000
const BODY_MAX = 4 * 1024
const TEXT_BODY_MAX = 64 * 1024 // focus and input carry a field's text
const PAIR_PATH = '/pair'

const TEXT_MAX = 8000 // code points (the remarks column of db/017 takes 8000)
const LABEL_MAX = 80
const INPUT_QUEUE_MAX = 64
const FIELD_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const BASE_RE = /^[0-9a-f]{8}$/
const FIELD_KINDS = ['line', 'multiline']
const ACTIONS = ['next', 'prev', 'enter', 'done']
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 symbols, no 0/O/1/I
const CODE_LEN = 8 // 40 bits
const MAX_N = 9007199254740991

// total / perOwner / startPerOwner as for Sign on phone; phonePerIp counts
// every join, poll and input (a phone typing sends a few a second);
// codePerIp the short-code joins (guesses) per address; inputBurst the
// inputs of one pairing per second
const CLOUD_CAPS = Object.freeze({ total: 1000, perOwner: 5, startPerOwner: 20, phonePerIp: 3000, codePerIp: 30, inputBurst: 30, waiters: 2000, localReserve: 0 })
const LAN_CAPS = Object.freeze({ total: 60, perOwner: 5, startPerOwner: 30, phonePerIp: 6000, codePerIp: 60, inputBurst: 30, waiters: 120, localReserve: 10 })

const LANGS = ['en', 'de', 'de-CH', 'fr', 'it']
// [key, max characters, required]
const CONTEXT_TEXT = [['matchNo', 20, false], ['home', 60, true], ['away', 60, true], ['when', 32, false]]
const CONTEXT_ORDER = ['matchNo', 'home', 'away', 'when', 'lang']

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/

const PAIR_API_HEADERS = Object.freeze({ 'Cache-Control': 'no-store' })

const MESSAGES = {
  OV_PAIR_BAD_REQUEST: 'Invalid request',
  OV_PAIR_CONTEXT: 'Both team names are needed',
  OV_PAIR_FIELD: 'Invalid field',
  OV_PAIR_TEXT_TOO_LONG: 'The text is too long for this field',
  OV_PAIR_STALE: 'Another field is selected on the scoring device',
  OV_PAIR_NO_FIELD: 'No text field is selected on the scoring device',
  OV_PAIR_FORBIDDEN: 'This device may not pair a phone',
  OV_PAIR_MATCH: 'Pairing a phone needs a match this account scores, saved on the server',
  OV_PAIR_PIN_INVALID: 'Wrong game PIN',
  OV_PAIR_NOT_FOUND: 'This link or code is not valid',
  OV_PAIR_USED: 'Another phone is already paired',
  OV_PAIR_CANCELLED: 'The scoring device ended the pairing',
  OV_PAIR_EXPIRED: 'This pairing has expired',
  OV_PAIR_TOO_LARGE: 'Request body too large',
  OV_PAIR_RATE_LIMITED: 'Too many requests. Please wait a moment.',
  OV_PAIR_BUSY: 'Phone pairing is busy. Try again in a moment.',
  OV_PAIR_UNAVAILABLE: 'Phone pairing is not available on this server',
  OV_AUTH_REQUIRED: 'Sign in to pair a phone',
}

/** An error answer: { status, body:{ ok:false, code, message }, headers? }. */
function pairError(status, code, headers) {
  const r = { status, body: { ok: false, code, message: MESSAGES[code] || 'Error' } }
  if (headers) r.headers = headers
  return r
}

function defaultRandomBytes(n) {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('pairSessionCore: no CSPRNG (pass randomBytes)')
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

/** 8 symbols of CODE_ALPHABET from 5 random bytes (40 bits, 5 per symbol). */
function codeFromBytes(bytes) {
  let bits = 0
  let acc = 0
  let out = ''
  for (let i = 0; i < 5; i++) {
    acc = (acc << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CODE_ALPHABET[(acc >> bits) & 31]
    }
    acc &= (1 << bits) - 1
  }
  return out
}

/**
 * A typed short code as the relay compares it: upper case, spaces and dashes
 * removed, and 8 symbols of the alphabet; else null.
 */
function normalizeCode(value) {
  if (typeof value !== 'string' || value.length > 32) return null
  const s = value.toUpperCase().replace(/[\s-]/g, '')
  if (s.length !== CODE_LEN) return null
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null
  return s
}

const isSecretShape = (v) => typeof v === 'string' && SECRET_RE.test(v)
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ---------------------------------------------------------------------------
// Validation (identical rules in pair.rs; vectors in __fixtures__/pair-vectors.json)
// ---------------------------------------------------------------------------

// C0, DEL, C1, and the bidi embeddings / overrides / isolates
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
// the same but the line feed (multi-line text)
const TEXT_CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
const EDGE_SPACE_RE = /^[\s\ufeff]+|[\s\ufeff]+$/g

/** A one-line label: NFC, control and bidi characters removed, trimmed, cut to `max` code points. */
function sanitizeLabel(value, max) {
  let s = String(value).normalize('NFC').replace(CONTROL_RE, '').replace(EDGE_SPACE_RE, '')
  const chars = Array.from(s)
  if (chars.length > max) s = chars.slice(0, max).join('').replace(EDGE_SPACE_RE, '')
  return s
}

/**
 * A field's text as typed: NFC; CR LF, CR, U+2028 and U+2029 are line feeds
 * ('line': a space instead); a tab is a space; the other control and bidi
 * characters are removed. NOT trimmed: the text is the field's value, and a
 * trailing line feed is where the scorer goes on typing.
 */
function sanitizeFieldText(value, kind) {
  const s = String(value).normalize('NFC')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(TEXT_CONTROL_RE, '')
  return kind === 'line' ? s.replace(/\n/g, ' ') : s
}

const cpLength = (s) => Array.from(s).length
const cutCp = (s, max) => (cpLength(s) > max ? Array.from(s).slice(0, max).join('') : s)

/** The context the phone shows (the match). { ok, context } or { ok:false, code }. */
function validateContext(raw) {
  if (!isPlainObject(raw)) return { ok: false, code: 'OV_PAIR_BAD_REQUEST' }
  const out = {}
  for (const [key, max, required] of CONTEXT_TEXT) {
    const v = raw[key]
    if (v === undefined || v === null) {
      if (required) return { ok: false, code: 'OV_PAIR_CONTEXT' }
      continue
    }
    if (typeof v !== 'string') return { ok: false, code: 'OV_PAIR_BAD_REQUEST' }
    const s = sanitizeLabel(v, max)
    if (!s) {
      if (required) return { ok: false, code: 'OV_PAIR_CONTEXT' }
      continue
    }
    out[key] = s
  }
  if (raw.lang !== undefined && raw.lang !== null) {
    if (typeof raw.lang !== 'string') return { ok: false, code: 'OV_PAIR_BAD_REQUEST' }
    if (LANGS.includes(raw.lang)) out.lang = raw.lang
  }
  const ordered = {}
  for (const k of CONTEXT_ORDER) if (k in out) ordered[k] = out[k]
  return { ok: true, context: ordered }
}

/**
 * The focused field the scoring device reports: null (nothing to type into)
 * or { id, label, kind, text, maxLength }. The text is cut to the field's cap.
 * { ok, field } or { ok:false, code:'OV_PAIR_FIELD' | 'OV_PAIR_BAD_REQUEST' }.
 */
function validateField(raw) {
  if (raw === null) return { ok: true, field: null }
  if (!isPlainObject(raw)) return { ok: false, code: 'OV_PAIR_FIELD' }
  if (typeof raw.id !== 'string' || !FIELD_ID_RE.test(raw.id)) return { ok: false, code: 'OV_PAIR_FIELD' }
  let kind = 'line'
  if (raw.kind !== undefined && raw.kind !== null) {
    if (!FIELD_KINDS.includes(raw.kind)) return { ok: false, code: 'OV_PAIR_FIELD' }
    kind = raw.kind
  }
  let maxLength = TEXT_MAX
  if (raw.maxLength !== undefined && raw.maxLength !== null) {
    if (!Number.isInteger(raw.maxLength) || raw.maxLength < 1) return { ok: false, code: 'OV_PAIR_FIELD' }
    maxLength = Math.min(raw.maxLength, TEXT_MAX)
  }
  let label = ''
  if (raw.label !== undefined && raw.label !== null) {
    if (typeof raw.label !== 'string') return { ok: false, code: 'OV_PAIR_BAD_REQUEST' }
    label = sanitizeLabel(raw.label, LABEL_MAX)
  }
  let text = ''
  if (raw.text !== undefined && raw.text !== null) {
    if (typeof raw.text !== 'string') return { ok: false, code: 'OV_PAIR_BAD_REQUEST' }
    text = cutCp(sanitizeFieldText(raw.text, kind), maxLength)
  }
  return { ok: true, field: { id: raw.id, label, kind, text, maxLength } }
}

/**
 * One input from the phone for the focused field `field` (validated):
 * { ok, input:{ n, field, text?, action? } } or { ok:false, code }.
 * The text is never cut: more than the field takes is OV_PAIR_TEXT_TOO_LONG.
 */
function validateInput(body, field) {
  if (!Number.isInteger(body.n) || body.n < 1 || body.n > MAX_N) return { ok: false, code: 'OV_PAIR_BAD_REQUEST' }
  if (typeof body.field !== 'string' || !FIELD_ID_RE.test(body.field)) return { ok: false, code: 'OV_PAIR_BAD_REQUEST' }
  const hasText = body.text !== undefined && body.text !== null
  const hasAction = body.action !== undefined && body.action !== null
  if (!hasText && !hasAction) return { ok: false, code: 'OV_PAIR_BAD_REQUEST' }
  if (hasText && typeof body.text !== 'string') return { ok: false, code: 'OV_PAIR_BAD_REQUEST' }
  if (hasAction && !ACTIONS.includes(body.action)) return { ok: false, code: 'OV_PAIR_BAD_REQUEST' }
  const hasBase = body.base !== undefined && body.base !== null
  if (hasBase && (typeof body.base !== 'string' || !BASE_RE.test(body.base))) return { ok: false, code: 'OV_PAIR_BAD_REQUEST' }
  if (!field) return { ok: false, code: 'OV_PAIR_NO_FIELD' }
  if (body.field !== field.id) return { ok: false, code: 'OV_PAIR_STALE' }
  const input = { n: body.n, field: body.field }
  if (hasText) {
    const text = sanitizeFieldText(body.text, field.kind)
    if (cpLength(text) > field.maxLength) return { ok: false, code: 'OV_PAIR_TEXT_TOO_LONG' }
    input.text = text
  }
  if (hasAction) input.action = body.action
  if (hasBase) input.base = body.base
  return { ok: true, input }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   sha256: (text: string) => string,
 *   now?: () => number,
 *   randomBytes?: (n: number) => Uint8Array,
 *   caps?: Partial<typeof LAN_CAPS>,
 *   waitMs?: number,
 *   via?: 'cloud'|'lan',
 *   log?: (line: string) => void,
 *   timers?: { setTimeout, clearTimeout, setInterval, clearInterval },
 * }} options
 */
function createPairSessions(options = {}) {
  if (typeof options.sha256 !== 'function') throw new Error('pairSessionCore: pass sha256')
  const sha256 = options.sha256
  const now = options.now || Date.now
  const randomBytes = options.randomBytes || defaultRandomBytes
  const caps = { ...(options.via === 'cloud' ? CLOUD_CAPS : LAN_CAPS), ...(options.caps || {}) }
  const waitMs = options.waitMs ?? WAIT_MS
  const via = options.via || 'lan'
  const log = options.log || ((line) => console.log(line))
  const timers = options.timers || { setTimeout, clearTimeout, setInterval, clearInterval }

  const byWatch = new Map() // watchHash -> session (the session's own map)
  const byToken = new Map() // tokenHash -> watchHash
  const byCode = new Map() // codeHash -> watchHash
  const byPhone = new Map() // phoneHash -> watchHash
  const dead = new Map() // any hash -> { kind: 'expired'|'cancelled', until }
  const rate = new Map() // key -> { count, start }
  let waiters = 0
  let sweeper = null

  const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t }
  const tokenKey = (token) => sha256(`k:${token}`)
  const codeKey = (code) => sha256(`c:${code}`)
  const watchKey = (watch) => sha256(`w:${watch}`)
  const phoneKey = (phone) => sha256(`p:${phone}`)

  function line(event, s) {
    try { log(`pair.${event} ref=${s.ref} via=${via}`) } catch { /* never break on logging */ }
  }

  /** Fixed window: counts one hit, returns the seconds to wait or 0. */
  function limited(key, max, windowMs = RATE_WINDOW_MS) {
    const t = now()
    if (rate.size > 10000) {
      for (const [k, e] of rate) if (t - e.start >= e.window) rate.delete(k)
      if (rate.size > 10000) rate.clear()
    }
    let e = rate.get(key)
    if (!e || t - e.start >= e.window) {
      e = { count: 0, start: t, window: windowMs }
      rate.set(key, e)
    }
    e.count++
    if (e.count <= max) return 0
    return Math.max(1, Math.ceil((e.start + e.window - t) / 1000))
  }
  const rateLimited = (retryAfter) => pairError(429, 'OV_PAIR_RATE_LIMITED', { 'Retry-After': String(retryAfter) })

  const deviceLast = (s, t) => (s.deviceWaiter ? t : s.deviceSeenAt)
  function liveUntil(s, t = now()) {
    const idle = deviceLast(s, t) + DEVICE_IDLE_MS
    const end = Math.min(s.endsAt, idle)
    return s.state === 'pending' ? Math.min(end, s.joinBy) : end
  }
  const phoneConnected = (s, t = now()) => !!s.phoneWaiter || (s.phoneSeenAt != null && t - s.phoneSeenAt < PHONE_SEEN_MS)

  function ownerCount(owner) {
    let n = 0
    for (const s of byWatch.values()) if (s.owner === owner) n++
    return n
  }

  function deviceAnswer(s, after) {
    const t = now()
    const inputs = s.inputs.filter((i) => i.seq > after)
    const body = { ok: true, state: s.state, seq: s.seq, inputs, phone: { connected: phoneConnected(s, t) }, endsAt: s.endsAt }
    if (s.state === 'pending') body.joinBy = s.joinBy
    if (s.pairedAt != null) body.pairedAt = s.pairedAt
    return { status: 200, body }
  }
  function phoneAnswer(s) {
    return { status: 200, body: { ok: true, state: s.state, v: s.v, field: s.field, applied: s.applied, endsAt: s.endsAt } }
  }
  const deadAnswer = (kind) => ({ status: 200, body: { ok: true, state: kind === 'cancelled' ? 'closed' : 'expired' } })

  function deadError(d) {
    if (d.kind === 'cancelled') return pairError(409, 'OV_PAIR_CANCELLED')
    return pairError(410, 'OV_PAIR_EXPIRED')
  }

  /** Answer the session's held device wait, if any (with `answer` or its state). */
  function wakeDevice(s, answer) {
    const w = s.deviceWaiter
    if (!w) return
    s.deviceWaiter = null
    w.finish(answer || deviceAnswer(s, w.after))
  }
  function wakePhone(s, answer) {
    const w = s.phoneWaiter
    if (!w) return
    s.phoneWaiter = null
    w.finish(answer || phoneAnswer(s))
  }

  /** End a pairing ('expired' | 'cancelled'): tombstones for every secret, both sides told. */
  function end(s, kind, at) {
    byWatch.delete(s.watchHash)
    byToken.delete(s.tokenHash)
    byCode.delete(s.codeHash)
    if (s.phoneHash) byPhone.delete(s.phoneHash)
    const until = at + TOMBSTONE_MS
    for (const h of [s.watchHash, s.tokenHash, s.codeHash, s.phoneHash]) if (h) dead.set(h, { kind, until })
    s.field = null
    s.inputs = []
    s.context = null
    wakeDevice(s, deadAnswer(kind))
    wakePhone(s, deadAnswer(kind))
    line(kind === 'cancelled' ? 'close' : 'expire', s)
  }

  /** The live session behind `hash` (via `index`, or the session map itself), a tombstone, or null. */
  function lookup(index, hash) {
    const t = now()
    const watchHash = index ? index.get(hash) : hash
    const s = watchHash ? byWatch.get(watchHash) : null
    if (s) {
      const until = liveUntil(s, t)
      if (t < until) return { session: s }
      end(s, 'expired', until)
    }
    const d = dead.get(hash)
    if (d) {
      if (t < d.until) return { dead: d }
      dead.delete(hash)
    }
    return null
  }

  function ensureSweeper() {
    if (sweeper) return
    sweeper = unref(timers.setInterval(sweep, SWEEP_MS))
  }

  /** Ends what has run out and forgets old tombstones and counters. */
  function sweep() {
    const t = now()
    for (const s of [...byWatch.values()]) {
      const until = liveUntil(s, t)
      if (t >= until) end(s, 'expired', until)
    }
    for (const [k, d] of dead) if (t >= d.until) dead.delete(k)
    for (const [k, e] of rate) if (t - e.start >= e.window) rate.delete(k)
  }

  /**
   * Hold a long-poll on `s` for the device or the phone. `ready()` answers at
   * once when it returns an answer; else the request waits for a wake or the
   * hold, then answers `again()`.
   */
  function hold(s, side, opts, again, extra = {}) {
    const slot = side === 'device' ? 'deviceWaiter' : 'phoneWaiter'
    // One held request per side: a newer one answers the older at once
    if (side === 'device') wakeDevice(s)
    else wakePhone(s)
    if (waiters >= caps.waiters) return Promise.resolve(pairError(503, 'OV_PAIR_BUSY', { 'Retry-After': '5' }))
    return new Promise((resolve) => {
      let done = false
      waiters++
      const holdMs = Math.max(0, Math.min(waitMs, liveUntil(s) - now()))
      const w = {
        ...extra,
        finish(answer) {
          if (done) return
          done = true
          waiters--
          timers.clearTimeout(timer)
          if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
          if (s[slot] === w) s[slot] = null
          if (side === 'device') s.deviceSeenAt = Math.max(s.deviceSeenAt, now())
          else s.phoneSeenAt = now()
          resolve(answer)
        },
      }
      // Not unref'd: it lives only while a request is held
      const timer = timers.setTimeout(() => {
        if (s[slot] === w) s[slot] = null
        // the clock moves on: seen now, then the session looked up again
        if (side === 'device') s.deviceSeenAt = now()
        const found = lookup(null, s.watchHash)
        if (found && found.session) w.finish(again())
        else w.finish(found && found.dead ? deadAnswer(found.dead.kind) : pairError(404, 'OV_PAIR_NOT_FOUND'))
      }, holdMs)
      const onAbort = () => w.finish({ status: 499, body: { ok: false, code: 'OV_PAIR_ABORTED', message: 'aborted' } })
      if (opts.signal) {
        if (opts.signal.aborted) { onAbort(); return }
        opts.signal.addEventListener('abort', onAbort)
      }
      s[slot] = w
    })
  }

  // --- the scoring device --------------------------------------------------

  /**
   * POST /api/pair/start, after the relay's own auth.
   * @param {any} body
   * @param {{ owner: string, app?: string|null }} who
   */
  function start(body, { owner, app = null }) {
    const retry = limited(`start:${owner}`, caps.startPerOwner)
    if (retry) return rateLimited(retry)
    if (!isPlainObject(body)) return pairError(400, 'OV_PAIR_BAD_REQUEST')
    let matchKey = null
    if (body.matchKey !== undefined && body.matchKey !== null) {
      if (typeof body.matchKey !== 'string') return pairError(400, 'OV_PAIR_BAD_REQUEST')
      const mk = body.matchKey.trim()
      if (mk.length > 128) return pairError(400, 'OV_PAIR_BAD_REQUEST')
      matchKey = mk || null
    }
    const ctx = validateContext(body.context)
    if (!ctx.ok) return pairError(400, ctx.code)
    const room = owner === 'local' ? caps.total : caps.total - (caps.localReserve || 0)
    if (byWatch.size >= room) sweep()
    if (byWatch.size >= room) return pairError(503, 'OV_PAIR_BUSY', { 'Retry-After': '30' })
    if (ownerCount(owner) >= caps.perOwner) return rateLimited(60)

    const token = base64url(randomBytes(32))
    const watch = base64url(randomBytes(32))
    let code = null
    let codeHash = null
    for (let i = 0; i < 8 && !code; i++) {
      const c = codeFromBytes(randomBytes(5))
      const h = codeKey(c)
      if (!byCode.has(h) && !dead.has(h)) { code = c; codeHash = h }
    }
    if (!code) return pairError(503, 'OV_PAIR_BUSY', { 'Retry-After': '5' })
    const t = now()
    const tokenHash = tokenKey(token)
    const s = {
      watchHash: watchKey(watch),
      tokenHash,
      codeHash,
      phoneHash: null,
      ref: tokenHash.slice(0, 8),
      state: 'pending',
      matchKey,
      context: ctx.context,
      app: app === 'beach' ? 'beach' : null,
      owner,
      createdAt: t,
      joinBy: t + JOIN_TTL_MS,
      endsAt: t + MAX_LIFE_MS,
      deviceSeenAt: t,
      phoneSeenAt: null,
      pairedAt: null,
      field: null,
      v: 0,
      applied: 0,
      inputs: [],
      seq: 0,
      lastN: 0,
      deviceWaiter: null,
      phoneWaiter: null,
    }
    byWatch.set(s.watchHash, s)
    byToken.set(tokenHash, s.watchHash)
    byCode.set(codeHash, s.watchHash)
    ensureSweeper()
    line('start', s)
    return {
      status: 201,
      body: { ok: true, token, code, watch, joinBy: s.joinBy, endsAt: s.endsAt, path: PAIR_PATH },
    }
  }

  /** The device's session for a body's watch secret: { session } or { error } / { deadAnswer }. */
  function deviceSession(body) {
    if (!isPlainObject(body)) return { error: pairError(400, 'OV_PAIR_BAD_REQUEST') }
    if (!isSecretShape(body.watch)) return { error: pairError(404, 'OV_PAIR_NOT_FOUND') }
    const found = lookup(null, watchKey(body.watch))
    if (!found) return { error: pairError(404, 'OV_PAIR_NOT_FOUND') }
    if (found.dead) return { gone: deadAnswer(found.dead.kind) }
    found.session.deviceSeenAt = now()
    return { session: found.session }
  }

  /**
   * POST /api/pair/wait (the scoring device): at once when the state is not
   * `knownState`, an input after `after` is queued, or the phone's presence is
   * not `knownPhone`; else on the next change, else after the hold. Inputs up
   * to `after` are acknowledged and dropped.
   */
  function wait(body, opts = {}) {
    const r = deviceSession(body)
    if (r.error) return Promise.resolve(r.error)
    if (r.gone) return Promise.resolve(r.gone)
    const s = r.session
    const after = Number.isInteger(body.after) && body.after >= 0 ? body.after : 0
    if (after > 0) s.inputs = s.inputs.filter((i) => i.seq > after)
    const ready = body.knownState !== s.state
      || s.inputs.some((i) => i.seq > after)
      || (typeof body.knownPhone === 'boolean' && body.knownPhone !== phoneConnected(s))
    if (ready) return Promise.resolve(deviceAnswer(s, after))
    return hold(s, 'device', opts, () => deviceAnswer(s, after), { after })
  }

  /** POST /api/pair/focus (the scoring device): the field the phone types into, or null. */
  function focus(body) {
    const r = deviceSession(body)
    if (r.error) return r.error
    if (r.gone) return pairError(409, r.gone.body.state === 'closed' ? 'OV_PAIR_CANCELLED' : 'OV_PAIR_EXPIRED')
    const s = r.session
    if (!('field' in body)) return pairError(400, 'OV_PAIR_BAD_REQUEST')
    const f = validateField(body.field)
    if (!f.ok) return pairError(400, f.code)
    let applied = s.applied
    if (body.applied !== undefined && body.applied !== null) {
      if (!Number.isInteger(body.applied) || body.applied < 0 || body.applied > MAX_N) return pairError(400, 'OV_PAIR_BAD_REQUEST')
      applied = body.applied
    }
    const changed = JSON.stringify(f.field) !== JSON.stringify(s.field) || applied !== s.applied
    if (changed) {
      // a new field drops the inputs still queued for another one
      if (!f.field || !s.field || f.field.id !== s.field.id) s.inputs = s.inputs.filter((i) => f.field && i.field === f.field.id)
      s.field = f.field
      s.applied = applied
      s.v++
      wakePhone(s)
    }
    return { status: 200, body: { ok: true, v: s.v } }
  }

  /** POST /api/pair/close (the scoring device): unpair. Idempotent. */
  function close(body) {
    if (!isPlainObject(body)) return pairError(400, 'OV_PAIR_BAD_REQUEST')
    if (!isSecretShape(body.watch)) return pairError(404, 'OV_PAIR_NOT_FOUND')
    const s = byWatch.get(watchKey(body.watch))
    if (s) end(s, 'cancelled', now())
    return { status: 200, body: { ok: true } }
  }

  // --- the phone -----------------------------------------------------------

  /** POST /api/pair/join: the QR link's token or the short code, once. */
  function join(body, { ipKey }) {
    const retry = limited(`phone:${ipKey}`, caps.phonePerIp)
    if (retry) return rateLimited(retry)
    if (!isPlainObject(body)) return pairError(400, 'OV_PAIR_BAD_REQUEST')
    let found
    if (body.k !== undefined) {
      if (!isSecretShape(body.k)) return pairError(404, 'OV_PAIR_NOT_FOUND')
      found = lookup(byToken, tokenKey(body.k))
    } else if (body.code !== undefined) {
      // every typed code counts (a guess), right or wrong
      const r2 = limited(`code:${ipKey}`, caps.codePerIp)
      if (r2) return rateLimited(r2)
      const code = normalizeCode(body.code)
      if (!code) return pairError(404, 'OV_PAIR_NOT_FOUND')
      found = lookup(byCode, codeKey(code))
    } else {
      return pairError(400, 'OV_PAIR_BAD_REQUEST')
    }
    if (!found) return pairError(404, 'OV_PAIR_NOT_FOUND')
    if (found.dead) return deadError(found.dead)
    const s = found.session
    if (s.state !== 'pending') return pairError(409, 'OV_PAIR_USED')
    const phone = base64url(randomBytes(32))
    const t = now()
    s.phoneHash = phoneKey(phone)
    byPhone.set(s.phoneHash, s.watchHash)
    s.state = 'paired'
    s.pairedAt = t
    s.phoneSeenAt = t
    line('join', s)
    wakeDevice(s)
    const out = { ok: true, phone, state: s.state, context: s.context, endsAt: s.endsAt }
    if (s.app) out.app = s.app
    return { status: 200, body: out }
  }

  /** The phone's rate limit and lookup by its secret: { session } or { error } / { gone }. */
  function phoneSession(body, ipKey) {
    const retry = limited(`phone:${ipKey}`, caps.phonePerIp)
    if (retry) return { error: rateLimited(retry) }
    if (!isPlainObject(body)) return { error: pairError(400, 'OV_PAIR_BAD_REQUEST') }
    if (!isSecretShape(body.phone)) return { error: pairError(404, 'OV_PAIR_NOT_FOUND') }
    const found = lookup(byPhone, phoneKey(body.phone))
    if (!found) return { error: pairError(404, 'OV_PAIR_NOT_FOUND') }
    if (found.dead) return { gone: found.dead }
    const s = found.session
    const was = phoneConnected(s)
    s.phoneSeenAt = now()
    if (!was) wakeDevice(s)
    return { session: s }
  }

  /** POST /api/pair/poll (the phone): the focused field, at once when `known` is not its version, else on the next change. */
  function poll(body, { ipKey, signal } = {}) {
    const r = phoneSession(body, ipKey)
    if (r.error) return Promise.resolve(r.error)
    if (r.gone) return Promise.resolve(deadAnswer(r.gone.kind))
    const s = r.session
    if (body.known !== s.v) return Promise.resolve(phoneAnswer(s))
    return hold(s, 'phone', { signal }, () => phoneAnswer(s))
  }

  /** POST /api/pair/input (the phone): text and / or an action for the focused field. */
  function input(body, { ipKey }) {
    const r = phoneSession(body, ipKey)
    if (r.error) return r.error
    if (r.gone) return deadError(r.gone)
    const s = r.session
    const burst = limited(`burst:${s.ref}`, caps.inputBurst, BURST_WINDOW_MS)
    if (burst) return rateLimited(burst)
    // A retry of an input already taken: answered, not queued again
    if (Number.isInteger(body.n) && body.n >= 1 && body.n <= s.lastN) return { status: 200, body: { ok: true, seq: s.seq, duplicate: true } }
    const v = validateInput(body, s.field)
    if (!v.ok) return pairError(v.code === 'OV_PAIR_STALE' || v.code === 'OV_PAIR_NO_FIELD' ? 409 : 400, v.code)
    const inp = v.input
    // A text after a text for the same field replaces it (only the last one counts)
    const last = s.inputs[s.inputs.length - 1]
    if (inp.text !== undefined && !inp.action && last && last.field === inp.field && last.text !== undefined && !last.action) {
      s.inputs.pop()
    }
    if (s.inputs.length >= INPUT_QUEUE_MAX) return pairError(429, 'OV_PAIR_RATE_LIMITED', { 'Retry-After': '1' })
    s.seq++
    s.lastN = inp.n
    s.inputs.push({ seq: s.seq, ...inp })
    // the phone's text is the field's text now (no echo of it back to the phone)
    if (inp.text !== undefined && s.field) s.field = { ...s.field, text: inp.text }
    wakeDevice(s)
    return { status: 200, body: { ok: true, seq: s.seq } }
  }

  /** Stop: every waiter answered, the sweeper cleared, nothing kept. */
  function dispose() {
    for (const s of byWatch.values()) {
      wakeDevice(s, pairError(503, 'OV_PAIR_UNAVAILABLE'))
      wakePhone(s, pairError(503, 'OV_PAIR_UNAVAILABLE'))
    }
    if (sweeper) timers.clearInterval(sweeper)
    sweeper = null
    byWatch.clear(); byToken.clear(); byCode.clear(); byPhone.clear(); dead.clear(); rate.clear()
  }

  return {
    start,
    wait,
    focus,
    close,
    join,
    poll,
    input,
    sweep,
    dispose,
    /** For tests and status: counts only, never a secret. */
    stats: () => ({ sessions: byWatch.size, tombstones: dead.size, waiters, sweeper: !!sweeper }),
    caps,
  }
}

const PAIR_ENDPOINTS = ['start', 'wait', 'focus', 'close', 'join', 'poll', 'input']

/** Which /api/pair/* path this is, or null. */
function pairEndpointOf(path) {
  const m = /^\/api\/pair\/(start|wait|focus|close|join|poll|input)$/.exec(path)
  return m ? m[1] : null
}

/** The body cap of an endpoint: focus and input carry a field's text. */
function pairBodyLimit(endpoint) {
  return endpoint === 'focus' || endpoint === 'input' ? TEXT_BODY_MAX : BODY_MAX
}

/** Is this the phone page (/pair, /pair/, /pair/...)? It takes the /sign page's headers. */
function isPairPagePath(path) {
  return path === PAIR_PATH || path.startsWith(PAIR_PATH + '/')
}

module.exports = {
  JOIN_TTL_MS,
  MAX_LIFE_MS,
  DEVICE_IDLE_MS,
  PHONE_SEEN_MS,
  TOMBSTONE_MS,
  WAIT_MS,
  SWEEP_MS,
  RATE_WINDOW_MS,
  BODY_MAX,
  TEXT_BODY_MAX,
  PAIR_PATH,
  TEXT_MAX,
  LABEL_MAX,
  INPUT_QUEUE_MAX,
  CODE_ALPHABET,
  CLOUD_CAPS,
  LAN_CAPS,
  ACTIONS,
  PAIR_ENDPOINTS,
  PAIR_API_HEADERS,
  MESSAGES,
  pairError,
  base64url,
  codeFromBytes,
  normalizeCode,
  sanitizeLabel,
  sanitizeFieldText,
  validateContext,
  validateField,
  validateInput,
  createPairSessions,
  pairEndpointOf,
  pairBodyLimit,
  isPairPagePath,
}
