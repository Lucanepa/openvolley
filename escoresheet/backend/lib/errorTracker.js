/**
 * errorTracker — the self-hosted error tracker (db/050_error_tracker.sql).
 *
 * Owner, 2026-11-19: "an error tool (like sentry/svrz_rc) that I get when
 * there's an error on OpenVolley app/web etc. with OS, tool, app, member".
 * Every page and app reports its errors here, signed in or not; the server
 * reports its own. One error = one group (fingerprint); each occurrence is an
 * event. lib/errorAlerts.js mails, pushes and rings the bell about new and
 * returning groups; the manager's Errors tab (super admins) triages them.
 *
 *   POST /api/errors {events:[<=20]}   anyone (Bearer optional), server.js:
 *        per address, per device and in total rate limited; ≤ 64 KB
 *   GET    /api/admin/errors?status=&product=&tool=&os=&version=&source=&level=&since=&q=&sort=&limit=
 *   GET    /api/admin/errors/:id                 the group, 14 days, breakdowns
 *   GET    /api/admin/errors/:id/events?before=&limit=   occurrences with the member (audited)
 *   GET    /api/admin/errors/events?device=|account=&before=&limit=   one device's / account's (audited)
 *   PATCH  /api/admin/errors/:id {status, important, mute, resolved_in_version, note, commit_ref}
 *   DELETE /api/admin/errors/events?device=|account=&confirm=yes   delete on request (audited)
 *   (all /api/admin/errors* for super admins only: lib/manageApi.js)
 *
 * Privacy (docs/legal privacy §5, data map 4.18):
 *   - the account only from the request's own verified session, never from
 *     the body; no IP address is stored (the rate limits keep it in memory);
 *   - messages, frames, breadcrumbs, views and data are sanitized again here
 *     (PINs, long numbers, e-mail addresses, dates, tokens, URL queries,
 *     Postgres "Key (col)=(value)" details) whatever the device sent;
 *   - events are kept 90 days (purge), an account's go with it (lib/auth.js).
 *
 * Grouping: product | source | kind | error name | message with ids and
 * numbers masked (normalizeMessage) | the top frame's file without the build
 * hash (index-AbC12.js -> index.js) | for server errors also the place. So a
 * bug stays one group across builds and versions.
 *
 * Alert state lives in the group (alert_due_at, last_alert_at): a new group,
 * a resolved one seen again (a regression) and an open one still happening a
 * day after its last alert owe a digest; lib/errorAlerts.js sends it.
 *
 * Handlers answer { status, body } and never throw.
 */
import { createHash, randomUUID } from 'node:crypto'
import { DENIED_KEY, redactFreeText, REDACTED } from './activitySanitize.js'
import { connectClient } from './pgClient.js'

export const PRODUCTS = Object.freeze(['openvolley', 'openbeach'])
export const TOOLS = Object.freeze([
  'scorer', 'referee', 'bench', 'livescore', 'scoresheet', 'dictate', 'roster', 'manager', 'tv',
  'scoreboard', 'board', 'other', 'server', 'render'
])
// What a page or app may report (the server's own kinds are not taken from a client)
export const CLIENT_KINDS = Object.freeze([
  'js.error', 'js.unhandledrejection', 'react.crash', 'boot.fail', 'resource.error', 'chunk.stale',
  'app.error', 'sync.error', 'sync.dropped', 'backup.error', 'net.fail'
])
export const SERVER_KINDS = Object.freeze(['server.exception', 'server.unhandled', 'server.uncaught', 'job.failed', 'render.failed'])
export const LEVELS = Object.freeze(['warn', 'error'])
export const RUNS_AS = Object.freeze(['tab', 'pwa', 'desktop', 'android_app', 'ios_app', 'server'])
export const STATUSES = Object.freeze(['open', 'resolved', 'muted'])

export const MAX_EVENTS = 20
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_FRAMES = 20
export const MAX_BREADCRUMBS = 20
export const MESSAGE_MAX = 500
export const EVENT_RETENTION_DAYS = 90
export const GROUP_RETENTION_DAYS = 180
// Events stored per group and day; past it only the count grows
export const DAILY_EVENTS_PER_GROUP = 500
// A digest waits this long after the first error of a burst (more of them join it)
export const ALERT_DEBOUNCE_MS = 2 * 60 * 1000
// An open group still happening this long after its last alert alerts again
export const REMIND_AFTER_MS = 24 * 60 * 60 * 1000
export const CLIENT_TS_MAX_AHEAD_MS = 24 * 60 * 60 * 1000
export const CLIENT_TS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const LIST_MAX = 200
const REASON_RANK = { ongoing: 1, new: 2, regression: 3 }
export const EVENTS_MAX = 100
// Rate limits of POST /api/errors (events, fixed windows, in memory)
export const RATE_LIMITS = Object.freeze({
  ip: { max: 120, windowMs: 5 * 60 * 1000 },
  device: { max: 300, windowMs: 60 * 60 * 1000 },
  total: { max: 5000, windowMs: 5 * 60 * 1000 }
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_TEXT_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const ERROR_NAME_RE = /^[A-Za-z_$][\w$.]{0,79}$/
const SIZE_RE = /^\d{1,5}x\d{1,5}$/
const REQUEST_ID_RE = /^[0-9a-f]{6,32}$/i
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/

const answer = (status, data) => ({ status, body: { data, error: null } })
const fail = (status, code, message, details) => ({ status, body: { data: null, error: { message, code, ...(details ? { details } : {}) } } })
const invalid = (details) => fail(400, 'OV_INVALID_REQUEST', 'Invalid request', details)
const notFound = () => fail(404, 'OV_NOT_FOUND', 'Not found')
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null))

// ------------------------------------------------------------------ sanitizing

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// 1.2.2011, 01.02.11, 2011-02-01, 1/2/2011 (a date of birth reads like any date)
const DATE_RE = /\b(?:\d{1,2}[./]\d{1,2}[./](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2})\b/g
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
const SECRET_PAIR_RE = /\b([\w-]{0,20}(?:pin|pins|password|passwd|token|secret|otp|apikey|api_key|auth|session|signature)[\w-]{0,20})(\s*[=:]\s*)("?)[^\s"&,;]+\3/gi
// Postgres DETAIL "Key (email)=(anna@x.ch) already exists": the column stays
const PG_KEY_RE = /\bKey \(([^)]{1,120})\)=\(([^)]*)\)/g
const URL_QUERY_RE = /(https?:\/\/[^\s?#"']+|\/[^\s?#"']*)\?[^\s#"']*/g
// a capability or id in a path: /tv/AB12CD, /api/match/<uuid>, long hex / base64ish runs
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g

/** Free text as it may be stored: no PIN, long number, address, date, token, query or key value. */
export function redactText(text, { max = MESSAGE_MAX, frame = false } = {}) {
  if (typeof text !== 'string') return null
  let out = text
    .replace(PG_KEY_RE, `Key ($1)=(${REDACTED})`)
    .replace(BEARER_RE, `$1 ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(EMAIL_RE, '[email]')
    .replace(URL_QUERY_RE, '$1')
    .replace(SECRET_PAIR_RE, `$1$2${REDACTED}`)
  if (!frame) out = out.replace(DATE_RE, '[date]')
  out = redactFreeText(out, { frame })
  out = out.replace(LONG_TOKEN_RE, (m) => (/^[a-z_.-]+$/i.test(m) && !/\d/.test(m) ? m : REDACTED))
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
  return out.length > max ? out.slice(0, max - 1) + '…' : out
}

/** A page path or view name: the path only, tokens and ids out. */
export function redactView(v) {
  if (typeof v !== 'string' || !v) return null
  const s = v.replace(/^https?:\/\/[^/]+/i, '').split(/[?]/)[0]
  return redactText(s.replace(UUID_RE_G, '<id>'), { max: 120 })
}
const UUID_RE_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** One stack frame as text ("fn@/assets/index-AbC1.js:1:2345"), origin and query removed. */
export function cleanFrame(f) {
  let s
  if (typeof f === 'string') s = f
  else if (isPlainObject(f)) {
    const file = typeof f.file === 'string' ? f.file : ''
    const fn = typeof f.fn === 'string' ? f.fn : ''
    const pos = [f.line, f.col].filter((n) => Number.isInteger(n) && n >= 0).join(':')
    s = `${fn ? fn + '@' : ''}${file}${pos ? ':' + pos : ''}`
  } else return null
  s = s.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^/\s)]+/gi, '').replace(/(tauri|capacitor|file|app):\/\/[^/\s)]*/gi, '')
    // a query (?v=3) up to the position: the line and column stay
    .replace(/\?[^\s:)]*/g, '')
  if (!s) return null
  return redactText(s, { max: 200, frame: true })
}

/** The frames of an error: at most MAX_FRAMES cleaned lines. */
export function cleanFrames(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : []
  const out = []
  for (const f of list) {
    if (out.length >= MAX_FRAMES) break
    const c = cleanFrame(f)
    if (c && !/^\w*Error\b/.test(c)) out.push(c)
  }
  return out
}

/** Frames of a server Error's stack (node "    at fn (file:line:col)"). */
export function framesOfStack(stack) {
  if (typeof stack !== 'string') return []
  return cleanFrames(stack.split('\n').slice(1).map((l) => l.trim()).filter((l) => l.startsWith('at ')).map((l) => {
    const m = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(l)
    if (!m) return l.slice(3)
    const file = m[2].replace(/^file:\/\//, '').replace(/^.*\/(backend|escoresheet|app)\//, '')
    return `${m[1] ? m[1] + '@' : ''}${file}:${m[3]}:${m[4]}`
  }))
}

const CRUMB_CATS = new Set(['nav', 'click', 'fetch', 'sync', 'net', 'console', 'app', 'error'])

/** The steps before an error: { t, c, m, d? }, at most MAX_BREADCRUMBS, the newest last. */
export function cleanBreadcrumbs(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const b of v.slice(-MAX_BREADCRUMBS)) {
    if (!isPlainObject(b)) continue
    const c = CRUMB_CATS.has(b.c) ? b.c : 'app'
    const m = redactText(typeof b.m === 'string' ? b.m : '', { max: 160 })
    if (!m) continue
    const t = typeof b.t === 'string' && b.t.length <= 40 && Number.isFinite(Date.parse(b.t)) ? b.t : null
    const d = isPlainObject(b.d) ? cleanData(b.d, { depth: 1, keys: 8 }) : null
    out.push({ ...(t ? { t } : {}), c, m, ...(d && Object.keys(d).length ? { d } : {}) })
  }
  return out
}

/** Extra data: never a value under a denied key; strings redacted; bounded. */
export function cleanData(v, { depth = 3, keys = 30 } = {}) {
  const walk = (x, d) => {
    if (x == null) return null
    if (typeof x === 'boolean') return x
    if (typeof x === 'number') return Number.isFinite(x) ? x : null
    if (typeof x === 'string') return redactText(x, { max: 200 })
    if (d >= depth) return null
    if (Array.isArray(x)) return x.slice(0, 20).map((y) => walk(y, d + 1))
    if (!isPlainObject(x)) return null
    const out = {}
    for (const [k, y] of Object.entries(x).slice(0, keys)) {
      if (typeof k !== 'string' || k.length > 40) continue
      if (DENIED_KEY.test(k)) { if (typeof y === 'boolean') out[k] = y; continue }
      out[k] = walk(y, d + 1)
    }
    return out
  }
  const out = isPlainObject(v) ? walk(v, 0) : {}
  return JSON.stringify(out).length > 4096 ? { _truncated: true } : out
}

// ------------------------------------------------------------------ grouping

/** The message with what changes between occurrences masked (svrz_rc server/logquery.ts). */
export function normalizeMessage(msg) {
  return String(msg || '').toLowerCase()
    .replace(UUID_RE_G, '<uuid>')
    .replace(/[0-9a-f]{15,}/g, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** The file of a frame without path, position and build hash: "index-AbC12.js:1:2" -> "index.js". */
export function frameFile(frame) {
  if (typeof frame !== 'string') return ''
  const file = frame.replace(/^[^@]*@/, '').replace(/:\d+(:\d+)?$/, '').split('/').pop() || ''
  return file.replace(/[-.][A-Za-z0-9_]{6,12}(?=\.m?[jt]sx?$)/, '').slice(0, 80)
}

/** The group of an event: 40 hex characters. */
export function fingerprintOf({ product, source, kind, error_name: name, message, frames, view }) {
  const top = Array.isArray(frames) && frames.length ? frameFile(frames[0]) : ''
  const place = source === 'server' ? String(view || '') : ''
  return createHash('sha1').update([product, source, kind, name || '', normalizeMessage(message), top, place].join('|')).digest('hex')
}

export function titleOf({ error_name: name, message }) {
  const msg = String(message || '(no message)')
  const t = name && !msg.startsWith(name) ? `${name}: ${msg}` : msg
  return t.length > 300 ? t.slice(0, 299) + '…' : t
}

export function culpritOf({ frames, view, source }) {
  if (Array.isArray(frames) && frames.length) return String(frames[0]).slice(0, 300)
  return view ? String(view).slice(0, 300) : (source === 'server' ? 'server' : null)
}

/** a >= b for app versions ("3.4.10" >= "3.4.9"); an unreadable one is never newer. */
export function versionAtLeast(a, b) {
  const parse = (v) => (typeof v === 'string' && /^\d+(\.\d+)*/.test(v) ? v.match(/^\d+(\.\d+)*/)[0].split('.').map(Number) : null)
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return false
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d !== 0) return d > 0
  }
  return true
}

// ------------------------------------------------------------------ checking

const optText = (v, max, re) => {
  if (v == null || v === '') return null
  if (typeof v !== 'string' || v.length > max) return undefined
  return re && !re.test(v) ? undefined : v
}
const optBool = (v) => (v == null ? null : typeof v === 'boolean' ? v : undefined)
const plainText = (v, max) => (typeof v === 'string' && v ? redactText(v, { max }) : null)

/**
 * One reported event -> { row } or { code } (the refusal).
 * @param {object} e as the app sends it (src/utils/errorReport/transport.js)
 * @param {{ now?: number, accountId?: string|null }} [opts]
 */
export function checkClientEvent(e, { now = Date.now(), accountId = null } = {}) {
  if (!isPlainObject(e)) return { code: 'OV_ERROR_INVALID' }
  if (typeof e.uid !== 'string' || !UUID_RE.test(e.uid)) return { code: 'OV_ERROR_INVALID' }
  if (!CLIENT_KINDS.includes(e.kind)) return { code: 'OV_ERROR_INVALID' }
  const level = e.level == null ? 'error' : e.level
  if (!LEVELS.includes(level)) return { code: 'OV_ERROR_INVALID' }
  const product = e.product == null ? 'openvolley' : e.product
  if (!PRODUCTS.includes(product)) return { code: 'OV_ERROR_INVALID' }
  const tool = e.tool == null ? 'other' : e.tool
  if (!TOOLS.includes(tool) || tool === 'server' || tool === 'render') return { code: 'OV_ERROR_INVALID' }
  const runsAs = e.runs_as == null ? null : RUNS_AS.includes(e.runs_as) && e.runs_as !== 'server' ? e.runs_as : undefined
  const sent = typeof e.client_ts === 'string' && e.client_ts.length <= 40 ? Date.parse(e.client_ts) : NaN
  if (!Number.isFinite(sent)) return { code: 'OV_ERROR_INVALID' }
  const ts = Math.max(Math.min(sent, now + CLIENT_TS_MAX_AHEAD_MS), now - CLIENT_TS_MAX_AGE_MS)
  if (typeof e.message !== 'string' || e.message.length > 4000) return { code: 'OV_ERROR_INVALID' }
  const fields = {
    app_version: optText(e.app_version, 32, VERSION_RE),
    build: optText(e.build, 40, /^[0-9A-Za-z._-]+$/),
    platform: optText(e.platform, 24, /^[a-z0-9_-]+$/),
    os_name: optText(e.os_name, 24),
    os_version: optText(e.os_version, 24),
    browser: optText(e.browser, 32),
    browser_version: optText(e.browser_version, 24),
    device_model: optText(e.device_model, 48),
    screen: optText(e.screen, 16, SIZE_RE),
    viewport: optText(e.viewport, 16, SIZE_RE),
    lang: optText(e.lang, 16, /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})*$/),
    tz: optText(e.tz, 48, /^[A-Za-z0-9_+/-]+$/),
    device_id: optText(e.device_id, 64, ID_TEXT_RE),
    session_id: optText(e.session_id, 64, ID_TEXT_RE),
    match_external_id: optText(e.match_external_id, 200, /^[A-Za-z0-9_.:-]+$/),
    request_id: optText(e.request_id, 32, REQUEST_ID_RE),
    error_name: e.error_name == null || e.error_name === '' ? null : typeof e.error_name === 'string' && ERROR_NAME_RE.test(e.error_name) ? e.error_name : null,
    online: optBool(e.online),
    point_hub: optBool(e.point_hub)
  }
  if (Object.values(fields).includes(undefined) || runsAs === undefined) return { code: 'OV_ERROR_INVALID' }
  const dpr = e.dpr == null ? null : Number.isFinite(Number(e.dpr)) && Number(e.dpr) > 0 && Number(e.dpr) < 10 ? Math.round(Number(e.dpr) * 100) / 100 : undefined
  if (dpr === undefined) return { code: 'OV_ERROR_INVALID' }
  if (e.data != null && !isPlainObject(e.data)) return { code: 'OV_ERROR_INVALID' }
  // free text from a device is cleaned whatever it already did
  for (const k of ['os_name', 'os_version', 'browser', 'browser_version', 'device_model']) fields[k] = plainText(fields[k], 48)
  const row = {
    uid: e.uid.toLowerCase(),
    client_ts: new Date(ts).toISOString(),
    level,
    kind: e.kind,
    product,
    source: 'client',
    tool,
    runs_as: runsAs,
    dpr,
    ...fields,
    point_hub: fields.point_hub === true,
    account_id: UUID_RE.test(String(accountId || '')) ? accountId : null,
    view: redactView(e.view),
    message: redactText(e.message, { max: MESSAGE_MAX }) || '(no message)',
    frames: cleanFrames(e.frames),
    breadcrumbs: cleanBreadcrumbs(e.breadcrumbs),
    data: cleanData(e.data || {})
  }
  return { row }
}

/** The server's own event of an Error. */
export function serverEvent(err, { tool = 'server', kind = 'server.exception', view = null, requestId = null, status = null, accountId = null, product = 'openvolley', version = null, build = null, data = null, now = Date.now() } = {}) {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : String(err?.message || err))
  return {
    uid: randomUUID(),
    client_ts: new Date(now).toISOString(),
    level: 'error',
    kind: SERVER_KINDS.includes(kind) ? kind : 'server.exception',
    product: PRODUCTS.includes(product) ? product : 'openvolley',
    source: 'server',
    tool: tool === 'render' ? 'render' : 'server',
    runs_as: 'server',
    app_version: typeof version === 'string' && VERSION_RE.test(version) ? version : null,
    build: typeof build === 'string' && /^[0-9A-Za-z._-]{1,40}$/.test(build) ? build : null,
    platform: 'node',
    os_name: null,
    os_version: null,
    browser: null,
    browser_version: null,
    device_model: null,
    point_hub: false,
    screen: null,
    viewport: null,
    dpr: null,
    lang: null,
    tz: null,
    online: null,
    device_id: null,
    session_id: null,
    match_external_id: null,
    account_id: UUID_RE.test(String(accountId || '')) ? accountId : null,
    view: view ? redactView(String(view)) : null,
    request_id: typeof requestId === 'string' && REQUEST_ID_RE.test(requestId) ? requestId : null,
    error_name: typeof e.name === 'string' && ERROR_NAME_RE.test(e.name) ? e.name : null,
    message: redactText([e.message, e.code ? `(${e.code})` : null, e.detail || null].filter(Boolean).join(' '), { max: MESSAGE_MAX }) || '(no message)',
    frames: framesOfStack(e.stack),
    breadcrumbs: [],
    data: cleanData({ ...(Number.isInteger(status) ? { status } : {}), ...(isPlainObject(data) ? data : {}) })
  }
}

// ------------------------------------------------------------------ rate limits

/** Fixed-window counters (in memory only: no address is ever stored). */
export function createWindowCounter({ max, windowMs, now = Date.now, maxKeys = 20000 }) {
  const windows = new Map()
  return {
    /** Takes n; false when the key is over its window's max. */
    take(key, n = 1) {
      const t = now()
      let w = windows.get(key)
      if (!w || t - w.start >= windowMs) {
        if (windows.size >= maxKeys) for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k)
        if (windows.size >= maxKeys) windows.delete(windows.keys().next().value)
        w = { start: t, n: 0 }
        windows.set(key, w)
      }
      if (w.n + n > max) return false
      w.n += n
      return true
    }
  }
}

// ------------------------------------------------------------------ the store

const EVENT_COLUMNS = ['uid', 'client_ts', 'level', 'kind', 'product', 'source', 'tool', 'app_version', 'build', 'platform',
  'os_name', 'os_version', 'browser', 'browser_version', 'runs_as', 'device_model', 'point_hub', 'screen', 'viewport', 'dpr',
  'lang', 'tz', 'online', 'device_id', 'session_id', 'account_id', 'view', 'match_external_id', 'error_name', 'message',
  'frames', 'breadcrumbs', 'data', 'request_id']
const JSON_COLUMNS = new Set(['frames', 'breadcrumbs', 'data'])

const queryValue = (query, k) => {
  const v = typeof query?.get === 'function' ? query.get(k) : query?.[k]
  return v == null || v === '' ? null : String(v)
}
const clampLimit = (v, max) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : max
}
const SINCE = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '14d': '14 days', '30d': '30 days', '90d': '90 days' }
const MUTE_FOR = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 }

/** A device line for a mail, a push or a row: "Android 15 · Chrome 131 · android_app · 1280x800". */
export function deviceLine(e) {
  if (!e) return ''
  if (e.source === 'server') return [e.tool === 'render' ? 'render service' : 'backend', e.build ? `build ${String(e.build).slice(0, 12)}` : null].filter(Boolean).join(' · ')
  return [
    [e.os_name, e.os_version].filter(Boolean).join(' ') || e.platform || null,
    e.device_model || null,
    [e.browser, e.browser_version].filter(Boolean).join(' ') || null,
    e.runs_as || null,
    e.point_hub ? 'Point Hub board' : null,
    e.viewport || e.screen || null
  ].filter(Boolean).join(' · ')
}

/**
 * @param {{ pool: import('pg').Pool, audit?: Function, clubsOfMany?: Function, log?: Console, now?: () => number,
 *           dailyEventsPerGroup?: number, debounceMs?: number, remindAfterMs?: number, rateLimits?: object }} deps
 */
export function createErrorTracker({ pool, audit = null, clubsOfMany = null, log = console, now = Date.now, dailyEventsPerGroup = DAILY_EVENTS_PER_GROUP, debounceMs = ALERT_DEBOUNCE_MS, remindAfterMs = REMIND_AFTER_MS, rateLimits = RATE_LIMITS } = {}) {
  const limits = {
    ip: createWindowCounter({ ...rateLimits.ip, now }),
    device: createWindowCounter({ ...rateLimits.device, now }),
    total: createWindowCounter({ ...rateLimits.total, now })
  }
  const counters = { accepted: 0, rejected: 0, dropped: 0, capped: 0, failed: 0, lastFailureAt: null }
  const dbError = (where, err) => {
    counters.failed++
    counters.lastFailureAt = new Date(now()).toISOString()
    log.warn?.(`[errors] ${where} failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
    return fail(503, 'OV_DB_UNAVAILABLE', 'Service unavailable')
  }

  /**
   * Stores one checked event: its group made or updated (counts, versions,
   * regression, alert state), the event itself unless the group's daily cap
   * is reached. A uid stored before changes nothing. Returns
   * { stored, duplicate, capped, groupId, alert }.
   */
  async function storeEvent(row) {
    const fingerprint = fingerprintOf(row)
    const client = await connectClient(pool, log)
    try {
      await client.query('BEGIN')
      const dup = await client.query('SELECT 1 FROM public.error_events WHERE uid = $1::uuid', [row.uid])
      if (dup.rows.length) {
        await client.query('ROLLBACK')
        return { stored: false, duplicate: true }
      }
      const t = new Date(now())
      const ins = await client.query(
        `INSERT INTO public.error_groups (fingerprint, product, source, kind, level, title, culprit, first_seen, last_seen,
                                          event_count, first_version, last_version, stored_day, stored_today)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz, 0, $9, $9, $8::timestamptz::date, 0)
         ON CONFLICT (fingerprint) DO NOTHING
         RETURNING *`,
        [fingerprint, row.product, row.source, row.kind, row.level, titleOf(row), culpritOf(row), t.toISOString(), row.app_version])
      const fresh = ins.rows.length > 0
      const g = fresh
        ? ins.rows[0]
        : (await client.query('SELECT * FROM public.error_groups WHERE fingerprint = $1 FOR UPDATE', [fingerprint])).rows[0]
      const today = t.toISOString().slice(0, 10)
      const storedDay = g.stored_day instanceof Date ? g.stored_day.toISOString().slice(0, 10) : String(g.stored_day || '').slice(0, 10)
      const storedToday = storedDay === today ? Number(g.stored_today) || 0 : 0
      const capped = storedToday >= dailyEventsPerGroup
      if (!capped) {
        const values = EVENT_COLUMNS.map((c) => (JSON_COLUMNS.has(c) ? JSON.stringify(row[c] ?? (c === 'data' ? {} : [])) : row[c] ?? null))
        const e = await client.query(
          `INSERT INTO public.error_events (group_id, ${EVENT_COLUMNS.join(', ')})
           VALUES ($1, ${EVENT_COLUMNS.map((c, i) => `$${i + 2}${JSON_COLUMNS.has(c) ? '::jsonb' : ''}`).join(', ')})
           ON CONFLICT (uid) DO NOTHING`, [g.id, ...values])
        if (!e.rowCount) {
          await client.query('ROLLBACK')
          return { stored: false, duplicate: true }
        }
      }
      // What the group owes: a digest for a new error, one that came back
      // after "resolved", one now an error (was only a warning), and one still
      // happening a day after its last alert. A muted group owes nothing until
      // its mute ends.
      let status = g.status
      let regressed = g.regressed
      let resolvedAt = g.resolved_at
      if (status === 'muted' && g.muted_until && new Date(g.muted_until) <= t) status = 'open'
      let reason = fresh ? 'new' : null
      if (status === 'resolved') {
        const back = g.resolved_in_version
          ? (row.source === 'server' ? new Date(g.resolved_at || 0) < t : versionAtLeast(row.app_version, g.resolved_in_version))
          : new Date(g.resolved_at || 0) < t
        if (back) {
          status = 'open'
          regressed = true
          resolvedAt = null
          reason = 'regression'
        }
      }
      if (!reason && g.level === 'warn' && row.level === 'error') reason = 'new'
      if (!reason && status === 'open' && row.level === 'error' && (!g.last_alert_at || t - new Date(g.last_alert_at) >= remindAfterMs)) reason = 'ongoing'
      const level = g.level === 'error' || row.level === 'error' ? 'error' : 'warn'
      const owes = reason != null && status === 'open' && level === 'error'
      const due = owes ? (g.alert_due_at ? new Date(g.alert_due_at) : new Date(t.getTime() + debounceMs)) : g.alert_due_at
      // the strongest reason a pending digest has: regression > new > ongoing
      const pending = g.alert_due_at ? g.alert_reason : null
      const alertReason = owes ? [reason, pending].filter(Boolean).sort((a, b) => REASON_RANK[b] - REASON_RANK[a])[0] : pending
      await client.query(
        `UPDATE public.error_groups
            SET last_seen = greatest(last_seen, $2::timestamptz), event_count = event_count + 1,
                last_version = coalesce($3, last_version), first_version = coalesce(first_version, $3),
                level = $4, status = $5, regressed = $6, resolved_at = $7, alert_due_at = $8, alert_reason = $11,
                muted_until = CASE WHEN $5 = 'muted' THEN muted_until END,
                stored_day = $9::date, stored_today = $10
          WHERE id = $1`,
        [g.id, t.toISOString(), row.app_version, level, status, regressed, resolvedAt, due, today, storedToday + (capped ? 0 : 1), alertReason])
      await client.query('COMMIT')
      return { stored: !capped, duplicate: false, capped, groupId: g.id, alert: owes ? reason : null }
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* broken connection */ }
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * POST /api/errors. `accountId`: the verified session's account (server.js),
   * or null. `ipKey`: the caller's address bucket, for the rate limit only.
   */
  async function ingest({ body, accountId = null, ipKey = 'unknown' } = {}) {
    if (!isPlainObject(body) || !Array.isArray(body.events)) return invalid('events must be an array')
    if (body.events.length === 0) return answer(200, { accepted: [], rejected: [] })
    if (body.events.length > MAX_EVENTS) return invalid(`at most ${MAX_EVENTS} events`)
    const n = body.events.length
    const device = body.events.find((e) => typeof e?.device_id === 'string')?.device_id
    if (!limits.total.take('all', n) || !limits.ip.take(String(ipKey), n) || (device && !limits.device.take(`d:${String(device).slice(0, 64)}`, n))) {
      counters.dropped += n
      return answer(202, { accepted: [], rejected: [], dropped: n })
    }
    const accepted = []
    const rejected = []
    const t = now()
    try {
      for (const e of body.events) {
        const r = checkClientEvent(e, { now: t, accountId })
        if (r.code) {
          counters.rejected++
          if (typeof e?.uid === 'string' && e.uid.length <= 64) rejected.push({ uid: e.uid, code: r.code })
          continue
        }
        const s = await storeEvent(r.row)
        if (s.capped) counters.capped++
        if (!s.duplicate) counters.accepted++
        accepted.push(r.row.uid)
      }
      return answer(200, { accepted, rejected })
    } catch (err) {
      return dbError('ingest', err)
    }
  }

  /** The server's own error (server.js). Never throws; resolves to the store result or null. */
  async function captureServer(err, opts = {}) {
    try {
      return await storeEvent(serverEvent(err, { ...opts, now: now() }))
    } catch (e) {
      counters.failed++
      counters.lastFailureAt = new Date(now()).toISOString()
      log.warn?.(`[errors] capture failed: ${e?.code || ''} ${String(e?.message || e).slice(0, 160)}`)
      return null
    }
  }

  // ---------------------------------------------------------------- admin

  /** Group filters -> { where, values } (error_groups g). */
  function groupFilters(query, values = []) {
    const get = (k) => queryValue(query, k)
    const p = (v) => { values.push(v); return `$${values.length}` }
    const where = []
    const status = get('status') || 'open'
    if (status !== 'all') {
      if (!STATUSES.includes(status)) return { error: invalid('status') }
      where.push(`g.status = ${p(status)}`)
    }
    const product = get('product')
    if (product) {
      if (!PRODUCTS.includes(product)) return { error: invalid('product') }
      where.push(`g.product = ${p(product)}`)
    }
    const source = get('source')
    if (source) {
      if (!['client', 'server'].includes(source)) return { error: invalid('source') }
      where.push(`g.source = ${p(source)}`)
    }
    const level = get('level')
    if (level) {
      if (!LEVELS.includes(level)) return { error: invalid('level') }
      where.push(`g.level = ${p(level)}`)
    }
    const tool = get('tool')
    if (tool) {
      if (!TOOLS.includes(tool)) return { error: invalid('tool') }
      where.push(`EXISTS (SELECT 1 FROM public.error_events e WHERE e.group_id = g.id AND e.tool = ${p(tool)})`)
    }
    const os = get('os')
    if (os) {
      if (os.length > 24) return { error: invalid('os') }
      where.push(`EXISTS (SELECT 1 FROM public.error_events e WHERE e.group_id = g.id AND (e.os_name ILIKE ${p(os)} OR e.platform = ${p(os)}))`)
    }
    const version = get('version')
    if (version) {
      if (!VERSION_RE.test(version)) return { error: invalid('version') }
      where.push(`EXISTS (SELECT 1 FROM public.error_events e WHERE e.group_id = g.id AND e.app_version = ${p(version)})`)
    }
    const since = get('since')
    if (since) {
      if (!SINCE[since]) return { error: invalid('since') }
      where.push(`g.last_seen > now() - interval '${SINCE[since]}'`)
    }
    const q = get('q')
    if (q) {
      if (q.length > 120) return { error: invalid('q') }
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      where.push(`(g.title ILIKE ${p(like)} OR g.culprit ILIKE ${p(like)} OR g.kind ILIKE ${p(like)})`)
    }
    if (get('important') === '1') where.push('g.important')
    return { where, values }
  }

  const ORDERS = { last_seen: 'g.last_seen DESC', count: 'g.event_count DESC, g.last_seen DESC', new: 'g.first_seen DESC' }
  const GROUP_COLUMNS = `g.id, g.product, g.source, g.kind, g.level, g.title, g.culprit, g.first_seen, g.last_seen, g.event_count,
    g.first_version, g.last_version, g.status, g.important, g.muted_until, g.resolved_at, g.resolved_in_version, g.regressed,
    g.note, g.commit_ref, g.last_alert_at`
  const groupOut = (r) => ({
    ...r,
    first_seen: iso(r.first_seen),
    last_seen: iso(r.last_seen),
    muted_until: iso(r.muted_until),
    resolved_at: iso(r.resolved_at),
    last_alert_at: iso(r.last_alert_at),
    event_count: Number(r.event_count) || 0,
    ...(r.events_24h != null ? { events_24h: Number(r.events_24h) || 0 } : {}),
    ...(r.accounts != null ? { accounts: Number(r.accounts) || 0 } : {}),
    ...(r.devices != null ? { devices: Number(r.devices) || 0 } : {})
  })

  /** GET /api/admin/errors */
  async function listGroups({ query } = {}) {
    const f = groupFilters(query)
    if (f.error) return f.error
    const sort = queryValue(query, 'sort') || 'last_seen'
    if (!ORDERS[sort]) return invalid('sort')
    const limit = clampLimit(queryValue(query, 'limit'), LIST_MAX)
    f.values.push(limit)
    try {
      const { rows } = await pool.query(
        `SELECT ${GROUP_COLUMNS}, s.events_24h, s.accounts, s.devices, s.tools, s.platforms
           FROM public.error_groups g
           LEFT JOIN LATERAL (
             SELECT count(*) FILTER (WHERE e.at > now() - interval '24 hours') AS events_24h,
                    count(DISTINCT e.account_id) AS accounts, count(DISTINCT e.device_id) AS devices,
                    array_remove(array_agg(DISTINCT e.tool), NULL) AS tools,
                    array_remove(array_agg(DISTINCT coalesce(e.os_name, e.platform)), NULL) AS platforms
               FROM public.error_events e WHERE e.group_id = g.id) s ON true
          ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''}
          ORDER BY g.important DESC, ${ORDERS[sort]}
          LIMIT $${f.values.length}`, f.values)
      const { rows: [c] } = await pool.query(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE status = 'open' AND regressed)::int AS regressed,
                count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
                count(*) FILTER (WHERE status = 'muted')::int AS muted
           FROM public.error_groups`)
      return answer(200, { groups: rows.map((r) => ({ ...groupOut(r), tools: r.tools || [], platforms: r.platforms || [] })), counts: c })
    } catch (err) {
      return dbError('list', err)
    }
  }

  const BREAKDOWNS = {
    os: "coalesce(nullif(trim(coalesce(e.os_name, '') || ' ' || coalesce(e.os_version, '')), ''), e.platform)",
    browser: "nullif(trim(coalesce(e.browser, '') || ' ' || coalesce(split_part(e.browser_version, '.', 1), '')), '')",
    version: 'e.app_version',
    tool: 'e.tool',
    runs_as: 'e.runs_as',
    view: 'e.view',
    product: 'e.product'
  }

  /** GET /api/admin/errors/:id */
  async function getGroup({ id } = {}) {
    if (!UUID_RE.test(String(id || ''))) return notFound()
    try {
      const { rows: [g] } = await pool.query(`SELECT ${GROUP_COLUMNS} FROM public.error_groups g WHERE g.id = $1`, [id])
      if (!g) return notFound()
      const { rows: days } = await pool.query(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day, count(e.id)::int AS n
           FROM generate_series((now() - interval '13 days')::date, now()::date, interval '1 day') d
           LEFT JOIN public.error_events e ON e.group_id = $1 AND e.at >= d AND e.at < d + interval '1 day'
          GROUP BY d ORDER BY d`, [id])
      const breakdowns = {}
      for (const [k, expr] of Object.entries(BREAKDOWNS)) {
        const { rows } = await pool.query(
          `SELECT ${expr} AS value, count(*)::int AS n FROM public.error_events e
            WHERE e.group_id = $1 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`, [id])
        breakdowns[k] = rows.filter((r) => r.value != null)
      }
      const { rows: [s] } = await pool.query(
        `SELECT count(*)::int AS stored, count(DISTINCT account_id)::int AS accounts, count(DISTINCT device_id)::int AS devices,
                count(*) FILTER (WHERE account_id IS NULL)::int AS guests
           FROM public.error_events WHERE group_id = $1`, [id])
      return answer(200, { group: groupOut(g), days, breakdowns, stats: s })
    } catch (err) {
      return dbError('group', err)
    }
  }

  const EVENT_LIST_COLUMNS = `e.id, e.uid, e.group_id, e.at, e.client_ts, e.level, e.kind, e.product, e.source, e.tool, e.app_version,
    e.build, e.platform, e.os_name, e.os_version, e.browser, e.browser_version, e.runs_as, e.device_model, e.point_hub, e.screen,
    e.viewport, e.dpr, e.lang, e.tz, e.online, e.device_id, e.session_id, e.account_id, e.view, e.match_external_id,
    e.error_name, e.message, e.frames, e.breadcrumbs, e.data, e.request_id`

  /** The members behind events: id -> { name, email, roles, clubs } (super admins' view only). */
  async function membersOf(ids) {
    const uniq = [...new Set(ids.filter((x) => UUID_RE.test(String(x || ''))))]
    const out = new Map()
    if (!uniq.length) return out
    const { rows } = await pool.query(
      `SELECT u.id, u.email, nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') AS name,
              coalesce(p.roles, '{}'::text[]) AS roles
         FROM auth.users u LEFT JOIN public.profiles p ON p.user_id = u.id
        WHERE u.id = ANY($1::uuid[])`, [uniq])
    const clubs = clubsOfMany ? await clubsOfMany(null, uniq) : new Map()
    for (const r of rows) out.set(String(r.id), { id: String(r.id), name: r.name, email: r.email, roles: r.roles || [], clubs: clubs.get(r.id) || clubs.get(String(r.id)) || [] })
    return out
  }

  /**
   * GET /api/admin/errors/:id/events and /api/admin/errors/events?device=|account=
   * Newest first, with the member (name, address, roles, clubs) or null (a
   * guest). A page naming any member is audited (errors.read).
   */
  async function listEvents({ actorId = null, groupId = null, query } = {}) {
    const values = []
    const p = (v) => { values.push(v); return `$${values.length}` }
    const where = []
    if (groupId != null) {
      if (!UUID_RE.test(String(groupId))) return notFound()
      where.push(`e.group_id = ${p(groupId)}`)
    }
    const device = queryValue(query, 'device')
    if (device) {
      if (!ID_TEXT_RE.test(device)) return invalid('device')
      where.push(`e.device_id = ${p(device)}`)
    }
    const account = queryValue(query, 'account')
    if (account) {
      if (!UUID_RE.test(account)) return invalid('account')
      where.push(`e.account_id = ${p(account)}::uuid`)
    }
    if (!where.length) return invalid('a group, device or account')
    const before = queryValue(query, 'before')
    if (before) {
      if (!/^\d{1,18}$/.test(before)) return invalid('before')
      where.push(`e.id < ${p(before)}::bigint`)
    }
    const limit = clampLimit(queryValue(query, 'limit'), EVENTS_MAX)
    values.push(limit)
    try {
      const { rows } = await pool.query(
        `SELECT ${EVENT_LIST_COLUMNS}, g.title AS group_title FROM public.error_events e
           JOIN public.error_groups g ON g.id = e.group_id
          WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT $${values.length}`, values)
      const members = await membersOf(rows.map((r) => r.account_id))
      if (members.size && audit) {
        await audit(null, { actorId, action: 'errors.read', targetUserId: members.size === 1 ? [...members.keys()][0] : null, details: { group: groupId, device: device || null, account: account || null, rows: rows.length, members: members.size } })
      }
      const events = rows.map((r) => ({
        ...r,
        id: String(r.id),
        at: iso(r.at),
        client_ts: iso(r.client_ts),
        dpr: r.dpr == null ? null : Number(r.dpr),
        device: deviceLine(r),
        member: r.account_id ? members.get(String(r.account_id)) || { id: String(r.account_id), name: null, email: null, roles: [], clubs: [] } : null
      }))
      const last = rows[rows.length - 1]
      return answer(200, { events, next: rows.length === limit && last ? String(last.id) : null })
    } catch (err) {
      return dbError('events', err)
    }
  }

  /** PATCH /api/admin/errors/:id { status, important, mute, resolved_in_version, note, commit_ref } (audited) */
  async function updateGroup({ actorId = null, id, body } = {}) {
    if (!UUID_RE.test(String(id || ''))) return notFound()
    if (!isPlainObject(body)) return invalid('body')
    const sets = []
    const values = [id]
    const p = (v) => { values.push(v); return `$${values.length}` }
    const changed = {}
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return invalid('status')
      changed.status = body.status
      sets.push(`status = ${p(body.status)}`)
      if (body.status === 'resolved') {
        const v = body.resolved_in_version
        if (v != null && v !== '' && !(typeof v === 'string' && VERSION_RE.test(v))) return invalid('resolved_in_version')
        sets.push('resolved_at = now()', `resolved_by = ${p(UUID_RE.test(String(actorId || '')) ? actorId : null)}::uuid`,
          `resolved_in_version = ${p(v || null)}`, 'regressed = false', 'alert_due_at = NULL', 'alert_reason = NULL', 'muted_until = NULL')
        changed.resolved_in_version = v || null
      } else if (body.status === 'muted') {
        const mute = body.mute ?? 'forever'
        if (mute !== 'forever' && !MUTE_FOR[mute]) return invalid('mute')
        sets.push(`muted_until = ${p(mute === 'forever' ? null : new Date(now() + MUTE_FOR[mute]).toISOString())}::timestamptz`, 'alert_due_at = NULL', 'alert_reason = NULL')
        changed.mute = mute
      } else {
        sets.push('muted_until = NULL', 'resolved_at = NULL', 'resolved_in_version = NULL', 'regressed = false')
      }
    }
    if (body.important !== undefined) {
      if (typeof body.important !== 'boolean') return invalid('important')
      sets.push(`important = ${p(body.important)}`)
      changed.important = body.important
    }
    for (const [k, max] of [['note', 1000], ['commit_ref', 80]]) {
      if (body[k] === undefined) continue
      if (body[k] !== null && (typeof body[k] !== 'string' || body[k].length > max)) return invalid(k)
      sets.push(`${k} = ${p(body[k] ? body[k] : null)}`)
      changed[k] = body[k] ? (k === 'note' ? '[note]' : body[k]) : null
    }
    if (!sets.length) return invalid('nothing to change')
    try {
      const client = await connectClient(pool, log)
      try {
        await client.query('BEGIN')
        const { rows: [g] } = await client.query(`UPDATE public.error_groups g SET ${sets.join(', ')} WHERE g.id = $1 RETURNING ${GROUP_COLUMNS}`, values)
        if (!g) {
          await client.query('ROLLBACK')
          return notFound()
        }
        if (audit) await audit(client, { actorId, action: 'errors.update', details: { group: id, ...changed } })
        await client.query('COMMIT')
        return answer(200, { group: groupOut(g) })
      } catch (err) {
        try { await client.query('ROLLBACK') } catch { /* broken connection */ }
        throw err
      } finally {
        client.release()
      }
    } catch (err) {
      return dbError('update', err)
    }
  }

  /** DELETE /api/admin/errors/events?device=|account=&confirm=yes: delete on request (audited). */
  async function deleteEvents({ actorId = null, query } = {}) {
    if (queryValue(query, 'confirm') !== 'yes') return invalid('confirm=yes is required')
    const device = queryValue(query, 'device')
    const account = queryValue(query, 'account')
    if (!device && !account) return invalid('device or account')
    if (device && !ID_TEXT_RE.test(device)) return invalid('device')
    if (account && !UUID_RE.test(account)) return invalid('account')
    try {
      const client = await connectClient(pool, log)
      try {
        await client.query('BEGIN')
        const r = await client.query(
          `DELETE FROM public.error_events WHERE ${device ? 'device_id = $1' : 'account_id = $1::uuid'}`, [device || account])
        if (audit) await audit(client, { actorId, action: 'errors.delete', targetUserId: account || null, details: { device: device || null, account: account || null, rows: r.rowCount } })
        await client.query('COMMIT')
        return answer(200, { deleted: r.rowCount })
      } catch (err) {
        try { await client.query('ROLLBACK') } catch { /* broken connection */ }
        throw err
      } finally {
        client.release()
      }
    } catch (err) {
      return dbError('delete', err)
    }
  }

  // ---------------------------------------------------------------- alerts (lib/errorAlerts.js)

  /**
   * The groups whose digest is due (alert_due_at passed, open, an error),
   * oldest due first, each with what a mail needs and no name or address:
   * the newest event, the counts since the last alert, tools, versions,
   * devices, and the members' roles + clubs ("guest" when none).
   */
  async function dueAlerts({ limit = 12 } = {}) {
    // a group muted or resolved meanwhile owes nothing any more
    await pool.query(`UPDATE public.error_groups SET alert_due_at = NULL, alert_reason = NULL WHERE alert_due_at IS NOT NULL AND (status <> 'open' OR level <> 'error')`)
    const { rows } = await pool.query(
      `SELECT ${GROUP_COLUMNS}, g.alert_due_at, g.alert_reason FROM public.error_groups g
        WHERE g.alert_due_at IS NOT NULL AND g.alert_due_at <= $1::timestamptz
        ORDER BY g.alert_due_at, g.id LIMIT $2`, [new Date(now()).toISOString(), limit])
    const out = []
    for (const g of rows) {
      // since the last digest (database time, as the events' `at`); a group
      // never alerted: all of its events
      const since = g.last_alert_at || null
      const { rows: [s] } = await pool.query(
        `SELECT count(*)::int AS n, array_remove(array_agg(DISTINCT e.tool), NULL) AS tools,
                array_remove(array_agg(DISTINCT e.app_version), NULL) AS versions,
                count(DISTINCT e.device_id)::int AS devices, count(DISTINCT e.account_id)::int AS accounts,
                count(*) FILTER (WHERE e.account_id IS NULL)::int AS guests,
                bool_or(e.tool = 'scorer' AND e.match_external_id IS NOT NULL) AS during_match
           FROM public.error_events e WHERE e.group_id = $1 AND ($2::timestamptz IS NULL OR e.at > $2::timestamptz)`, [g.id, since])
      const { rows: [last] } = await pool.query(
        `SELECT ${EVENT_LIST_COLUMNS} FROM public.error_events e WHERE e.group_id = $1 ORDER BY e.id DESC LIMIT 1`, [g.id])
      const { rows: who } = await pool.query(
        `SELECT DISTINCT e.account_id FROM public.error_events e WHERE e.group_id = $1 AND ($2::timestamptz IS NULL OR e.at > $2::timestamptz) AND e.account_id IS NOT NULL LIMIT 5`,
        [g.id, since])
      const members = await membersOf(who.map((w) => w.account_id))
      out.push({
        group: groupOut(g),
        reason: g.alert_reason || (g.last_alert_at ? 'ongoing' : 'new'),
        since: iso(since || g.first_seen),
        count: Number(s?.n) || 0,
        tools: s?.tools || [],
        versions: s?.versions || [],
        devices: Number(s?.devices) || 0,
        accounts: Number(s?.accounts) || 0,
        guests: Number(s?.guests) || 0,
        duringMatch: s?.during_match === true,
        last: last ? { ...last, id: String(last.id), at: iso(last.at), client_ts: iso(last.client_ts), device: deviceLine(last) } : null,
        // roles + clubs only: a mail or a push never names the member
        members: [...members.values()].map((m) => ({ roles: m.roles, clubs: m.clubs.map((c) => c.name) }))
      })
    }
    return out
  }

  /** After a sent digest: the cooldown starts, nothing is owed. */
  async function markAlerted(ids) {
    if (!ids.length) return
    // database time: the next digest counts the events after it (their `at`)
    await pool.query('UPDATE public.error_groups SET last_alert_at = now(), alert_due_at = NULL, alert_reason = NULL WHERE id = ANY($1::uuid[])', [ids])
  }

  /** A digest that has to wait (the hourly ceiling): due again at `until`. */
  async function deferAlerts(ids, until) {
    if (!ids.length) return
    await pool.query('UPDATE public.error_groups SET alert_due_at = greatest(alert_due_at, $2::timestamptz) WHERE id = ANY($1::uuid[])',
      [ids, new Date(until).toISOString()])
  }

  /** Retention (daily): events after 90 days; groups without events, not open, after 180. */
  async function purge({ at = new Date(now()) } = {}) {
    const events = await pool.query(
      `DELETE FROM public.error_events WHERE at < $1::timestamptz - make_interval(days => $2)`, [at.toISOString(), EVENT_RETENTION_DAYS])
    const groups = await pool.query(
      `DELETE FROM public.error_groups g WHERE g.status <> 'open' AND g.last_seen < $1::timestamptz - make_interval(days => $2)
          AND NOT EXISTS (SELECT 1 FROM public.error_events e WHERE e.group_id = g.id)`, [at.toISOString(), GROUP_RETENTION_DAYS])
    return { events: events.rowCount, groups: groups.rowCount }
  }

  /** Counters for the internal /health body (no values). */
  function stats() {
    return { ...counters }
  }

  return { ingest, captureServer, storeEvent, listGroups, getGroup, listEvents, updateGroup, deleteEvents, dueAlerts, markAlerted, deferAlerts, purge, stats }
}
