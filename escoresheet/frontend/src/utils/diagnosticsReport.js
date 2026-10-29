/**
 * The support diagnostics report: the text file Support & feedback attaches
 * when "Include diagnostics" is ticked (openvolley-diagnostics-<date>.txt),
 * built from what utils/diagnosticsCollect.js reads on the device. Pure: no
 * database, no window, no React (the tests feed it data).
 *
 * Sections:
 *   1. Summary      app, version, platform, device, screen, language, time
 *                   and time zone (and the relay's clock offset), online,
 *                   connection, sync queue, storage, device and account ids
 *   2. Match        the open (or last open) match: game, status, sets and
 *                   score, serving team, line-ups, time-outs and
 *                   substitutions, events (the last 30), the server's word on
 *                   it (scorer claim, closed, moved), unsent writes
 *   3. Timeline     the activity log and the interaction log merged into one
 *                   chronological list over the last 2 hours (at least the
 *                   whole page load), one line per entry; runs of pointer
 *                   moves and scrolls collapsed, typing collapsed per field,
 *                   gaps over 5 minutes and app start / quit / reload /
 *                   background marked
 *   4. App log      errors and warnings with their stacks, the last 200
 *   5. Desktop app  what the desktop app's own files hold, when readable
 *
 * Size: at most REPORT_MAX_BYTES (2 MB) of UTF-8; the oldest timeline lines
 * go first, and the top of the report says how many.
 *
 * Privacy (redactReport, over the whole text): the secrets the collector
 * found on the device (game, tablet and upload PINs, the session tokens) are
 * replaced wherever they appear, and so are email addresses, phone numbers,
 * JWTs, bearer tokens, "pin=…" / "token: …" pairs, data URLs (signature
 * images), token-shaped strings and URL queries. Nothing typed into a field
 * is in the report at all (the timeline says which field and how many
 * characters); the interaction log's own redaction (no entry of a password or
 * PIN field, no PIN-like digits in click texts) applies before.
 */
import { activityLine, redactFreeText, DENIED_KEY } from '../domain/activitySummary'
import { describeEvent, humanize, teamLetter, hasTeamDesignation } from '../domain/describe'
import { redactScreenText } from './screenText'

export const REPORT_MAX_BYTES = 2 * 1024 * 1024
export const TIMELINE_WINDOW_MS = 2 * 60 * 60 * 1000
export const TIMELINE_MAX_LINES = 5000
export const GAP_MS = 5 * 60 * 1000
export const APP_LOG_MAX = 200
export const RECENT_EVENTS_MAX = 30
export const DESKTOP_LINES_MAX = 500
const STACK_LINES_MAX = 12
const TAP_ABSORB_MS = 1500
const LABEL_MAX = 40
const KIND_WIDTH = 6
const TIME_WIDTH = 12
const INDENT = ' '.repeat(TIME_WIDTH + 2)

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0')
const formatters = new Map()

function partsOf(ms, timeZone) {
  const key = timeZone || ''
  let f = formatters.get(key)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', {
        timeZone: timeZone || undefined, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
      })
    } catch {
      f = new Intl.DateTimeFormat('en-GB', { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }
    formatters.set(key, f)
  }
  const out = {}
  for (const p of f.formatToParts(new Date(ms))) out[p.type] = p.value
  return {
    y: Number(out.year), mo: Number(out.month), d: Number(out.day),
    h: Number(out.hour) % 24, mi: Number(out.minute), s: Number(out.second), ms: ((ms % 1000) + 1000) % 1000
  }
}

/** Clock helpers in one time zone (the device's when none is given). */
export function makeClock(timeZone) {
  return {
    time: (ms) => {
      const p = partsOf(ms, timeZone)
      return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}.${pad(p.ms, 3)}`
    },
    date: (ms) => {
      const p = partsOf(ms, timeZone)
      return `${p.y}-${pad(p.mo)}-${pad(p.d)}`
    },
    dateTime: (ms) => {
      const p = partsOf(ms, timeZone)
      return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`
    },
    stamp: (ms) => {
      const p = partsOf(ms, timeZone)
      return `${p.y}${pad(p.mo)}${pad(p.d)}-${pad(p.h)}${pad(p.mi)}`
    },
    /** "+01:00" */
    offset: (ms) => {
      const p = partsOf(ms, timeZone)
      const local = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s)
      const minutes = Math.round((local - Math.floor(ms / 1000) * 1000) / 60000)
      const sign = minutes < 0 ? '-' : '+'
      const a = Math.abs(minutes)
      return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
    }
  }
}

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 120) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

const tsOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v instanceof Date) return v.getTime()
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** openvolley-diagnostics-20261029-2201-g406970.txt (local time) */
export function diagnosticsFileName(now, gameNumber = null, { timeZone } = {}) {
  const game = gameNumber == null || gameNumber === '' ? '' : String(gameNumber).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20)
  return `openvolley-diagnostics-${makeClock(timeZone).stamp(now)}${game ? `-g${game}` : ''}.txt`
}

export function utf8Bytes(text) {
  try {
    return new TextEncoder().encode(text).length
  } catch {
    return unescape(encodeURIComponent(text)).length
  }
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const DATA_URL_RE = /data:[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[A-Za-z0-9+/=%._-]*/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
// "pin=123456", "game_pin": "123456", refereePin: 123456, access_token=..., "password":"..."
const SECRET_PAIR_RE = /([A-Za-z_]*(?:pin|token|secret|password|passwd|passwort|apikey|api_key|authorization|cookie)s?)(["']?\s*[:=]\s*["']?)([^\s"'&,;)}\]]+)/gi
// "PIN 123456", "Code: 4711" in free text
const PIN_WORD_RE = /\b(pin|code|passwor[dt]|mot de passe)(s?[\s:=#'"-]{0,3})\d{4,8}(?!\d)/gi
const URL_QUERY_RE = /((?:https?|wss?|tauri|capacitor):\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi
const TOKENISH_RE = /[A-Za-z0-9_-]{24,}/g
const PHONE_INTL_RE = /(^|[^\w+])((?:\+|00)[1-9][\d ./()-]{6,20}\d)(?![\w])/g
const PHONE_LOCAL_RE = /(^|[^\w(])(\(?0\d{1,3}\)?(?:[ ./-]?\d{2,4}){2,4})(?![\w])/g

const digitCount = (s) => (s.match(/\d/g) || []).length

// A run of letters and digits that looks random: both kinds, mixed through
// (at least 3 changes between letters and digits or lower and upper case)
function looksRandom(seg) {
  if (digitCount(seg) < 2 || (seg.match(/[A-Za-z]/g) || []).length < 2) return false
  let changes = 0
  let prev = null
  for (const ch of seg) {
    const cls = /\d/.test(ch) ? 'd' : /[a-z]/.test(ch) ? 'l' : 'u'
    if (prev && cls !== prev) changes++
    prev = cls
  }
  return changes >= 3
}

/**
 * A string that looks like a random token (a session token, a key, a hash),
 * not a UUID (device and account ids stay), a seed key, a file name or a word.
 */
export function isTokenShaped(s) {
  if (UUID.test(s)) return false
  const segs = s.split(/[-_]/)
  if (segs.some(seg => seg.length >= 20 && looksRandom(seg))) return true
  const randomChars = segs.filter(seg => seg.length >= 8 && looksRandom(seg)).reduce((n, seg) => n + seg.length, 0)
  return s.length >= 32 && randomChars >= 24
}

/** The patterns of the known secrets (a digit PIN also grouped: "771 234"). */
function secretPatterns(secrets) {
  const out = []
  const seen = new Set()
  for (const raw of secrets || []) {
    const s = raw == null ? '' : String(raw).trim()
    if (s.length < 4 || seen.has(s)) continue
    seen.add(s)
    if (/^\d+$/.test(s)) out.push(new RegExp(`(^|\\D)${s.split('').join('[\\s\\u00a0-]?')}(?!\\d)`, 'g'))
    else out.push(new RegExp(`(^|[^A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`, 'g'))
  }
  return out
}

/**
 * The text without secrets and contact data (see the module comment).
 * @param {string} text
 * @param {{ secrets?: string[] }} [opts] values found on the device (PINs, tokens)
 */
export function redactReport(text, { secrets = [] } = {}) {
  let s = String(text ?? '')
  for (const re of secretPatterns(secrets)) s = s.replace(re, '$1[secret]')
  s = s.replace(DATA_URL_RE, '[data URL]')
  s = s.replace(JWT_RE, '[token]')
  s = s.replace(BEARER_RE, '$1 [token]')
  s = s.replace(URL_QUERY_RE, '$1')
  s = s.replace(SECRET_PAIR_RE, (m, key, sep, value) => (value === '[secret]' || value === '[redacted]' ? m : `${key}${sep}[redacted]`))
  s = s.replace(PIN_WORD_RE, '$1$2[redacted]')
  s = s.replace(EMAIL_RE, '[email]')
  s = s.replace(PHONE_INTL_RE, (m, pre, num) => (digitCount(num) >= 8 && digitCount(num) <= 15 ? `${pre}[phone]` : m))
  s = s.replace(PHONE_LOCAL_RE, (m, pre, num) => (digitCount(num) >= 9 && digitCount(num) <= 11 ? `${pre}[phone]` : m))
  s = s.replace(TOKENISH_RE, (m) => (isTokenShaped(m) ? '[token]' : m))
  return s
}

/** Free text from the app (an error message, a log line): no PIN or long number, no URL query. */
export function cleanFreeText(text) {
  return redactScreenText(redactFreeText(String(text ?? ''))).replace(URL_QUERY_RE, '$1')
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const oneLine = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const quote = (v) => `"${oneLine(v, LABEL_MAX)}"`

// "Label:   value" rows, aligned; a row with an empty label continues the one above
function kv(rows) {
  const list = rows.filter(r => r && r[1] !== undefined && r[1] !== null && r[1] !== '')
  if (!list.length) return []
  const width = Math.max(...list.map(([k]) => k.length)) + 2
  return list.map(([k, v]) => (k ? `${`${k}:`.padEnd(width)}${v}` : `${' '.repeat(width)}${v}`))
}

const heading = (n, title) => ['', `== ${n}. ${title} ${'='.repeat(Math.max(3, 66 - title.length))}`, '']
const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : null)

// A short, safe "k=v k=v" of the scalar fields of a payload (debug lines)
function shortFields(payload, max = 4) {
  if (!payload || typeof payload !== 'object') return ''
  const out = []
  for (const [k, v] of Object.entries(payload)) {
    if (out.length >= max) break
    if (DENIED_KEY.test(k) || /snapshot|timestamp|^ts$|text|name|value/i.test(k)) continue
    if (v === null || v === undefined || typeof v === 'object' || typeof v === 'function') continue
    out.push(`${k}=${oneLine(redactScreenText(String(v)), 30)}`)
  }
  return out.join(' ')
}

// ---------------------------------------------------------------------------
// Timeline: interaction log entries
// ---------------------------------------------------------------------------

const PRESS = new Set(['touchstart', 'touchend', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'])
const MOVE = new Set(['touchmove', 'dragover', 'mousemove', 'pointermove', 'touchcancel'])
const DROPPED = new Set(['focus', 'blur', 'keyup', 'dragend', 'focusin', 'focusout'])
const FIELD_TAGS = new Set(['input', 'textarea', 'select'])
const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'search', 'tel', 'url', 'number', 'password', 'date', 'time', 'datetime-local', 'month', 'week'])

function isFieldTarget(t) {
  return !!t && (FIELD_TAGS.has(t.tagName) || /contenteditable/i.test(String(t.className || '')))
}

/** "Point A" (the element's text), its aria-label, or button#id / the path's end. */
function targetLabel(t) {
  if (!t || typeof t !== 'object') return '(unknown)'
  const text = t.textContent ? oneLine(t.textContent, LABEL_MAX) : ''
  if (text) return quote(text)
  if (t.ariaLabel) return quote(t.ariaLabel)
  const tag = t.tagName || 'element'
  if (t.id) return `${tag}#${oneLine(t.id, 30)}`
  if (t.name) return `${tag}[name=${oneLine(t.name, 30)}]`
  if (t.role) return `${tag}[role=${t.role}]`
  const tail = String(t.path || '').split(' > ').slice(-2).join(' > ')
  return tail ? oneLine(tail.replace(/\.[^\s.>]{25,}/g, ''), 60) : tag
}

/** The field a key or input went to: its label, name or id. */
function fieldLabel(t) {
  if (!t) return 'a field'
  if (t.ariaLabel) return quote(t.ariaLabel)
  const tag = t.tagName || 'field'
  const type = t.type && t.type !== 'text' && tag === 'input' ? `[type=${t.type}]` : ''
  if (t.name) return `${tag}${type}[name=${oneLine(t.name, 30)}]`
  if (t.id) return `${tag}${type}#${oneLine(t.id, 30)}`
  return `${tag}${type}`
}

const fieldKey = (t) => (t ? `${t.tagName}|${t.id || ''}|${t.name || ''}|${t.ariaLabel || ''}|${t.path || ''}` : 'none')

const where = (component) => (component && !['global', 'unknown', 'App', 'DebugLogger', 'ComprehensiveLogger'].includes(component) ? oneLine(component, 30) : '')

function keyName(p) {
  const key = String(p?.key ?? '')
  const mods = [p?.ctrlKey && 'Ctrl', p?.altKey && 'Alt', p?.metaKey && 'Meta', p?.shiftKey && key.length > 1 && 'Shift'].filter(Boolean)
  const name = key === ' ' ? 'Space' : key
  return [...mods, name].join('+')
}

/**
 * One interaction log entry as a timeline item, or null (focus, blur, key up:
 * nothing a reader needs).
 * Items: { ts, src, kind, text, where?, noise?, typing?, tap?, marker? }
 */
export function interactionItem(e) {
  if (!e || !Number.isFinite(e.ts)) return null
  const p = e.payload || {}
  const t = e.target || null
  const base = { ts: e.ts, src: 'ui', order: 0 }
  switch (e.category) {
    case 'ui': {
      const type = e.type
      if (DROPPED.has(type)) return null
      // a password or PIN field (comprehensiveLogger getRecentLogs): only that it happened
      if (t?.secret) {
        if (type === 'keydown' || type === 'input' || type === 'change') return { ...base, typing: { field: 'secret', label: 'a password or PIN field', keys: type === 'keydown' ? 1 : 0, hidden: true, length: null }, kind: 'type', text: '' }
        if (type === 'click') return { ...base, tap: true, kind: 'tap', text: 'a password or PIN field' }
        return null
      }
      if (PRESS.has(type)) return { ...base, noise: 'press', kind: 'touch', text: '' }
      if (MOVE.has(type)) return { ...base, noise: 'move', kind: 'move', text: '' }
      if (type === 'scroll') return { ...base, noise: 'scroll', kind: 'scroll', text: '' }
      if (type === 'click' || type === 'dblclick' || type === 'contextmenu') {
        return { ...base, tap: true, kind: type === 'click' ? 'tap' : type === 'dblclick' ? 'tap×2' : 'menu', text: targetLabel(t), where: where(e.component) }
      }
      if (type === 'keydown') {
        const key = String(p.key ?? '')
        const hidden = key === '[REDACTED]'
        if (hidden || ((key.length === 1 || key === 'Backspace' || key === 'Delete') && !p.ctrlKey && !p.metaKey && !p.altKey && isFieldTarget(t))) {
          return { ...base, typing: { field: fieldKey(t), label: fieldLabel(t), keys: 1, hidden, length: null }, kind: 'type', text: '' }
        }
        // a key outside any field (a shortcut): not text, the key is shown
        if (key.length === 1 && !p.ctrlKey && !p.metaKey && !p.altKey) return { ...base, kind: 'key', text: key === ' ' ? 'Space' : quote(key), where: where(e.component) }
        return { ...base, kind: 'key', text: keyName(p) || 'key', where: where(e.component) }
      }
      if (type === 'input') {
        const hidden = p.value === '[REDACTED]' || p.valueLength == null
        return { ...base, typing: { field: fieldKey(t), label: fieldLabel(t), keys: 0, hidden, length: hidden ? null : Number(p.valueLength) || 0 }, kind: 'type', text: '' }
      }
      if (type === 'change') {
        if (t?.type === 'checkbox' || t?.type === 'radio' || typeof p.checked === 'boolean') {
          const label = fieldLabel(t)
          if (t?.type === 'radio') return { ...base, kind: 'change', text: `chose ${label}`, where: where(e.component) }
          return { ...base, kind: 'change', text: `${p.checked ? '[x]' : '[ ]'} ${label}`, where: where(e.component) }
        }
        if (t?.tagName === 'select') {
          const value = p.value === '[REDACTED]' ? '(hidden)' : quote(redactScreenText(String(p.value ?? '')))
          return { ...base, kind: 'change', text: `${fieldLabel(t)} → ${value}`, where: where(e.component) }
        }
        if (t?.tagName === 'textarea' || (t?.tagName === 'input' && TEXT_INPUT_TYPES.has(String(t.type || '')))) {
          const hidden = p.value === '[REDACTED]'
          const n = typeof p.value === 'string' && !hidden ? p.value.length : null
          return { ...base, typing: { field: fieldKey(t), label: fieldLabel(t), keys: 0, hidden, length: n, change: true }, kind: 'type', text: '' }
        }
        if (t?.type === 'file') return { ...base, kind: 'change', text: `picked a file in ${fieldLabel(t)}`, where: where(e.component) }
        return { ...base, kind: 'change', text: fieldLabel(t), where: where(e.component) }
      }
      if (type === 'submit') return { ...base, kind: 'submit', text: t?.id ? `form#${oneLine(t.id, 30)}` : 'a form', where: where(e.component) }
      if (type === 'dragstart') return { ...base, kind: 'drag', text: targetLabel(t), where: where(e.component) }
      if (type === 'drop') return { ...base, kind: 'drop', text: targetLabel(t), where: where(e.component) }
      if (type === 'error') {
        const msg = p.message || p.reason || p.error || e.action
        return { ...base, kind: 'error', level: 'error', text: `${e.action === 'unhandledrejection' ? 'unhandled rejection: ' : ''}${oneLine(cleanFreeText(String(msg).split('\n')[0]), 160)}` }
      }
      return { ...base, kind: 'ui', text: `${oneLine(type, 20)} ${targetLabel(t)}`.trim(), where: where(e.component) }
    }
    case 'error':
      return { ...base, kind: 'error', level: 'error', text: `${oneLine(e.component, 30)}.${oneLine(e.action, 40)}: ${oneLine(cleanFreeText(p?.error?.message || ''), 160)}` }
    case 'debug':
      return { ...base, kind: 'debug', text: `${oneLine(e.type || e.action, 40)} ${shortFields(p)}`.trim() }
    case 'navigation':
      return { ...base, kind: 'nav', text: `${oneLine(e.component, 30)} ${oneLine(String(e.action || e.type).replace(/_/g, ' '), 40)}`.trim() }
    case 'system': {
      if (e.type === 'init') return { ...base, marker: 'PAGE LOADED (a new page load: start or reload)' }
      if (e.type === 'visibility') return { ...base, marker: e.action === 'hidden' ? 'APP IN THE BACKGROUND (screen off, other app or tab)' : 'APP IN THE FOREGROUND AGAIN' }
      if (e.type === 'network') return { ...base, kind: 'net', level: e.action === 'offline' ? 'warn' : 'info', text: e.action === 'offline' ? 'the device went offline' : 'the device is online again' }
      if (e.type === 'config_change' && e.action === 'setGameContext') {
        const g = p.gameNumber
        return { ...base, kind: 'match', text: g == null && p.matchId == null ? 'no match open' : `open match: game ${oneLine(g ?? '?', 20)} (local id ${oneLine(p.matchId ?? '?', 20)})` }
      }
      return { ...base, kind: 'system', text: `${oneLine(e.type, 30)} ${oneLine(e.action, 40)}`.trim() }
    }
    case 'state':
    case 'function':
      return { ...base, kind: 'fn', text: `${oneLine(e.component, 30)}.${oneLine(e.action, 40)} (${oneLine(e.type, 20)})` }
    default:
      return { ...base, kind: oneLine(e.category || 'log', KIND_WIDTH), text: `${oneLine(e.type, 30)} ${oneLine(e.action, 40)}`.trim() }
  }
}

// ---------------------------------------------------------------------------
// Timeline: activity log rows
// ---------------------------------------------------------------------------

const EVENT_NAMES = {
  point: 'Point', timeout: 'Time-out', substitution: 'Substitution', sanction: 'Sanction', lineup: 'Line-up',
  libero_entry: 'Libero in', libero_exit: 'Libero out', libero_exchange: 'Libero exchange', rally_start: 'Rally start',
  replay: 'Replay', set_start: 'Set start', set_end: 'Set end', coin_toss: 'Coin toss', decision_change: 'Decision change',
  remark: 'Remark', forfait: 'Forfeit', match_stopped: 'Match stopped'
}

function teamRef(team, match) {
  if (team !== 'home' && team !== 'away') return ''
  return match ? `${teamLetter(team, match)} (${team})` : team
}

// The snapshot's score: team A first (the scoresheet's way)
const scoreRef = (d) => (d.scoreA == null || d.scoreB == null ? '' : `${d.scoreA}:${d.scoreB}`)

/**
 * One activity log row as a timeline item. matches: local match id -> match
 * row (team A / B), for the rows of the report's match.
 */
export function activityItem(row, matches = new Map()) {
  const ts = tsOf(row?.ts)
  if (ts == null) return null
  const d = row.data || {}
  const match = row.matchId != null ? matches.get(row.matchId) || null : null
  const base = { ts, src: 'act', order: 1, level: row.level }
  const set = d.set ?? row.setIndex
  switch (row.kind) {
    case 'event.add': {
      const name = EVENT_NAMES[d.type] || humanize(d.type) || 'Event'
      const parts = [name, teamRef(d.team, match)]
      if (d.player != null) parts.push(`#${d.player}`)
      if (d.playerOut != null || d.playerIn != null) parts.push(`#${d.playerIn ?? '?'} in for #${d.playerOut ?? '?'}`)
      if (d.libero != null) parts.push(`libero #${d.libero}`)
      if (d.sanction) parts.push(humanize(d.sanction).toLowerCase())
      const score = scoreRef(d)
      return { ...base, kind: 'score', text: `${parts.filter(Boolean).join(' ')}${score ? ` → ${score}` : ''}${set != null ? ` (set ${set})` : ''}${d.seq != null ? `  seq ${d.seq}` : ''}` }
    }
    case 'event.bulk_add':
      return { ...base, kind: 'score', text: `${d.count} events added at once (${(d.types || []).join(', ')})` }
    case 'event.undo':
    case 'event.delete':
    case 'event.edit':
    case 'event.restore': {
      const verb = { 'event.undo': 'undone', 'event.delete': 'deleted', 'event.edit': 'edited', 'event.restore': 'restored' }[row.kind]
      const name = EVENT_NAMES[d.type] || humanize(d.type) || 'Event'
      const changed = row.kind === 'event.edit' && d.changed?.length ? ` (${d.changed.join(', ')})` : ''
      return { ...base, kind: row.kind === 'event.undo' ? 'undo' : 'fix', text: `${name} seq ${d.seq ?? '?'}${set != null ? ` (set ${set})` : ''} ${verb}${changed}${d.reason && d.reason !== 'undo' ? `, reason: ${d.reason}` : ''}` }
    }
    case 'set.start':
    case 'set.end':
    case 'set.reopen':
    case 'set.delete': {
      const verb = { 'set.start': 'started', 'set.end': 'ended', 'set.reopen': 'reopened', 'set.delete': 'deleted' }[row.kind]
      const score = d.home != null && d.away != null ? ` ${d.home}:${d.away} (home:away)` : ''
      return { ...base, kind: 'set', text: `Set ${d.set ?? '?'} ${verb}${score}` }
    }
    case 'app.start':
      return { ...base, marker: `APP START ${oneLine(d.version, 32)}${d.platform ? ` (${oneLine(d.platform, 24)})` : ''}${d.persisted === false ? ', storage not persistent' : ''}` }
    case 'app.update':
      return { ...base, marker: `APP UPDATED ${oneLine(d.previous, 32)} → ${oneLine(d.version, 32)}` }
    case 'app.quit':
      return { ...base, marker: 'APP QUIT (page closed or app ended)' }
    case 'app.error':
      return { ...base, kind: 'error', level: 'error', text: `${oneLine(cleanFreeText(d.message), 160)}${d.source ? ` [${oneLine(d.source, 30)}]` : ''}` }
    case 'backup.error':
      return { ...base, kind: 'error', level: 'error', text: `backup: ${oneLine(cleanFreeText(d.message), 160)}` }
    case 'auth.sign_in':
      return { ...base, kind: 'auth', text: 'signed in' }
    case 'auth.sign_out':
      return { ...base, kind: 'auth', text: 'signed out' }
    case 'sync.error':
    case 'sync.dropped':
      return {
        ...base,
        kind: 'sync',
        level: row.level || 'warn',
        text: [
          `${row.kind === 'sync.dropped' ? 'dropped' : 'refused'}: ${[d.resource ?? '?', d.action, d.status, d.code].filter(v => v != null && v !== '').join(' ')}`,
          d.attempt != null ? `attempt ${d.attempt}` : null,
          d.requestId ? `request ${oneLine(d.requestId, 40)}` : null
        ].filter(Boolean).join(', ')
      }
    case 'sync.state':
      return { ...base, kind: 'sync', text: `status ${d.from ?? '–'} → ${d.to ?? '–'}` }
    case 'sync.summary':
      return { ...base, kind: 'sync', text: `last minutes: sent ${d.sent ?? 0}, failed ${d.failed ?? 0}, pending ${d.pending ?? 0}` }
    case 'match.create':
      return { ...base, kind: 'match', text: `match created (local id ${row.matchId ?? '?'}${d.test ? ', test' : ''})` }
    case 'activity.overflow':
      return { ...base, kind: 'app', level: 'warn', text: `${d.dropped} activity entries dropped (the device's log was full)` }
    default: {
      const line = oneLine(activityLine(row), 160)
      const kind = String(row.kind || '').split('.')[0] || 'act'
      return { ...base, kind: oneLine(kind, KIND_WIDTH), text: `${String(row.kind || '').split('.').slice(1).join('.').replace(/_/g, ' ')}${line ? `: ${line}` : ''}` }
    }
  }
}

// ---------------------------------------------------------------------------
// Timeline: merge, collapse, gaps
// ---------------------------------------------------------------------------

const NOISE_TEXT = { move: 'pointer moved', scroll: 'scrolled', press: 'touched (no tap)' }

function lineOf(clock, item) {
  const time = clock.time(item.ts).padEnd(TIME_WIDTH)
  if (item.marker) return `${time}  ════ ${item.marker} ════`
  const kind = (item.level === 'error' && item.kind !== 'error' ? 'error' : item.kind).padEnd(KIND_WIDTH)
  const text = item.where ? `${item.text.padEnd(28)}  ${item.where}` : item.text
  return `${time}  ${kind}  ${text}`.trimEnd()
}

/**
 * The merged timeline as lines (oldest first).
 * @param {{ activity?: object[], interaction?: object[], matches?: Map, now: number, from?: number|null,
 *   timeZone?: string, maxLines?: number, gapMs?: number }} input
 * @returns {{ lines: string[], cut: number, entries: { activity: number, interaction: number }, from: number|null, to: number|null }}
 */
export function buildTimeline({ activity = [], interaction = [], matches = new Map(), now, from = null, timeZone, maxLines = TIMELINE_MAX_LINES, gapMs = GAP_MS }) {
  const clock = makeClock(timeZone)
  const items = []
  for (const e of interaction) {
    const it = interactionItem(e)
    if (it && (from == null || it.ts >= from)) items.push(it)
  }
  for (const r of activity) {
    const it = activityItem(r, matches)
    if (it && (from == null || it.ts >= from)) items.push(it)
  }
  // Chronological; at the same millisecond the tap before what it caused
  items.forEach((it, i) => { it.seq = i })
  items.sort((a, b) => a.ts - b.ts || a.order - b.order || a.seq - b.seq)

  // Collapse: runs of moves / scrolls / presses, and typing per field, are
  // one line each, at the run's first entry (the activity log's lines in
  // between do not end a run, the next tap or key does); the presses just
  // before a tap belong to it
  const out = []
  let noise = null
  let typing = null
  const noiseText = (n) => {
    const span = n.last - n.ts
    return `${NOISE_TEXT[n.group]}${n.count > 1 ? ` ×${n.count}` : ''}${n.count > 1 && span >= 1000 ? ` over ${duration(span)}` : ''}`
  }
  const typingText = (ty) => {
    if (ty.hidden) return `typed into ${ty.field === 'secret' ? 'a password or PIN field' : `${ty.label} (a password or PIN field)`}: not recorded`
    const keys = ty.keys ? `${ty.keys} key${ty.keys === 1 ? '' : 's'} into ` : 'into '
    return `typed ${keys}${ty.label}${ty.length != null ? ` (now ${ty.length} character${ty.length === 1 ? '' : 's'}; the text is not included)` : ' (the text is not included)'}`
  }
  const closeRuns = () => {
    noise = null
    typing = null
  }
  for (const it of items) {
    const runLast = Math.max(noise?.last ?? -Infinity, typing?.last ?? -Infinity)
    if (Number.isFinite(runLast) && it.ts - runLast > gapMs) closeRuns()
    if (it.noise) {
      typing = null
      if (noise && noise.group !== it.noise) noise = null
      if (!noise) {
        noise = { group: it.noise, ts: it.ts, last: it.ts, count: 0, presses: [], line: { ts: it.ts, kind: it.noise === 'press' ? 'touch' : it.noise, text: '' } }
        out.push(noise.line)
      }
      noise.count++
      noise.last = it.ts
      noise.line.last = it.ts
      if (it.noise === 'press') noise.presses.push(it.ts)
      noise.line.text = noiseText(noise)
      continue
    }
    if (it.typing) {
      noise = null
      if (typing && typing.field !== it.typing.field) typing = null
      if (!typing) {
        typing = { ...it.typing, ts: it.ts, last: it.ts, keys: 0, line: { ts: it.ts, kind: 'type', text: '' } }
        out.push(typing.line)
      }
      typing.keys += it.typing.keys
      typing.hidden = typing.hidden || it.typing.hidden
      if (it.typing.length != null) typing.length = it.typing.length
      typing.last = it.ts
      typing.line.last = it.ts
      typing.line.text = typingText(typing)
      continue
    }
    if (it.tap && noise?.group === 'press') {
      // the touchstart / mousedown / ... of this tap
      const kept = noise.presses.filter(t => t < it.ts - TAP_ABSORB_MS)
      noise.count -= noise.presses.length - kept.length
      noise.presses = kept
      if (noise.count <= 0) out.splice(out.lastIndexOf(noise.line), 1)
      else noise.line.text = noiseText(noise)
    }
    // the next tap, key or screen ends a run; the activity log's lines do not, its markers do
    if (it.src === 'ui' || it.marker) closeRuns()
    out.push(it)
  }

  // Lines, with the day, the gaps and the quiet end
  const lines = []
  let prevTs = null
  let prevDay = null
  for (const it of out) {
    const day = clock.date(it.ts)
    if (day !== prevDay) {
      lines.push(`${'—'.repeat(4)} ${day} ${'—'.repeat(4)}`)
      prevDay = day
    }
    if (prevTs != null && it.ts - prevTs > gapMs) lines.push(`${INDENT}···· ${duration(it.ts - prevTs)} with nothing recorded ····`)
    lines.push(lineOf(clock, it))
    prevTs = Math.max(prevTs ?? -Infinity, it.last ?? it.ts)
  }
  if (prevTs != null && now - prevTs > gapMs) lines.push(`${INDENT}···· ${duration(now - prevTs)} with nothing recorded, up to this report ····`)
  const cut = Math.max(0, lines.length - maxLines)
  return {
    lines: cut ? lines.slice(cut) : lines,
    cut,
    entries: { activity: activity.length, interaction: interaction.length },
    from: items.length ? items[0].ts : null,
    to: items.length ? items[items.length - 1].ts : null
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function connectionRows(info = {}, clock) {
  const rows = []
  const ago = (at) => (Number.isFinite(at) ? `${clock.time(at)}` : null)
  if (info.sync) {
    const s = info.sync
    rows.push(['Sync status', `${s.status}${Number.isFinite(s.since) ? ` since ${ago(s.since)}` : ''}`])
    if (s.lastPass) {
      const p = s.lastPass
      const flags = [p.error && 'errors', p.failed && 'refused', p.retry && 'retry later', p.stopped && 'stopped', p.authRequired && 'sign-in required'].filter(Boolean)
      rows.push(['Last sync pass', `${ago(p.at)}: ${p.sent} sent${p.processed != null ? ` of ${p.processed}` : ''}${flags.length ? `, ${flags.join(', ')}` : ''}`])
    }
  }
  if (info.relay) {
    const r = info.relay
    rows.push(['Relay (live tablets)', `${r.state}${r.url ? ` ${r.url}` : ''}${r.reconnectAttempt ? `, reconnect attempt ${r.reconnectAttempt}` : ''}${Number.isFinite(r.lastMessageAt) ? `, last message ${ago(r.lastMessageAt)}` : ''}`])
  }
  if (info.realtime) {
    const r = info.realtime
    rows.push(['Connection', `${r.status}${r.activeConnection ? ` via ${r.activeConnection}` : ''} (mode ${r.connectionType})${r.matchId ? `, match ${r.matchId}` : ''}${Number.isFinite(r.lastUpdate) ? `, last update ${ago(r.lastUpdate)}` : ''}${r.error ? `, error: ${oneLine(r.error, 120)}` : ''}`])
  }
  if (info.bench) {
    const b = info.bench
    const c = b.connections || {}
    rows.push(['Bench', `${b.view || 'match list'}${b.matchId ? `, match ${b.matchId}` : ''}${b.team ? `, team ${b.team}` : ''}`])
    rows.push(['Connection', `server ${c.server ?? '?'}, websocket ${c.websocket ?? '?'}, database stream ${c.supabase ?? '?'}${b.activeConnection ? `, using ${b.activeConnection}` : ''} (mode ${b.connectionMode})${b.error ? `, error: ${oneLine(b.error, 120)}` : ''}`])
  }
  if (info.livescore) {
    const l = info.livescore
    rows.push(['Livescore', `${l.games} game(s) listed (${l.mode})${l.selectedGame ? `, showing ${l.selectedGame}` : ''}${l.loading ? ', loading' : ''}${l.stale ? ', list may be old (a refetch failed)' : ''}${l.error ? `, error: ${oneLine(l.error, 120)}` : ''}`])
  }
  return rows
}

function summarySection(s, clock, now) {
  const rows = [
    ['App', `${s.appName}${s.app ? ` – ${s.app}` : ''}`],
    ['Version', s.version],
    ['Platform', s.platform],
    ['Runs as', s.runsAs],
    ['Operating system', s.os],
    ['User agent', s.userAgent],
    ['Screen', s.screen],
    ['Window', s.window],
    ['Display mode', s.displayMode],
    ['Language', s.language],
    ['Local time', `${clock.dateTime(now)} (${s.timeZone || 'unknown time zone'}, UTC${clock.offset(now)})`],
    ['Clock offset', s.clock ? `the relay's clock is ${s.clock.offsetMs >= 0 ? '+' : ''}${s.clock.offsetMs} ms from this device's (round trip ${s.clock.rttMs} ms, measured ${clock.time(s.clock.at)})` : 'unknown (no reply from the relay yet)'],
    ['Online', yesNo(s.online)],
    ['Page', s.page],
    ...connectionRows(s.info, clock),
    ['Sync queue', s.queue],
    ['Sync errors', s.queueErrors?.length ? s.queueErrors[0] : null],
    ...(s.queueErrors || []).slice(1).map((e) => ['', e]),
    ['Storage', s.storage],
    ['Diagnostics mode', s.diagnosticsMode],
    ['Device id', s.deviceId ? `${s.deviceId} (random, made by the app)` : null],
    ['Account id', s.accountId || 'not signed in']
  ]
  return kv(rows.map(([k, v]) => [k, v == null ? v : String(v)]))
}

function lineupText(lineup) {
  if (!lineup || typeof lineup !== 'object') return null
  return ['I', 'II', 'III', 'IV', 'V', 'VI'].map(pos => `${pos} ${lineup[pos] ?? '?'}`).join(' · ')
}

/** The match section's lines. m: utils/diagnosticsCollect's match (rows from the database). */
export function matchSection(m, clock) {
  if (!m?.row) return [m?.note || 'No match is open on this device.']
  const row = m.row
  const sets = [...(m.sets || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const events = [...(m.events || [])].sort((a, b) => (a.seq || 0) - (b.seq || 0) || (tsOf(a.ts) || 0) - (tsOf(b.ts) || 0))
  const home = m.homeTeam?.name || row.homeName || 'home'
  const away = m.awayTeam?.name || row.awayName || 'away'
  const letters = hasTeamDesignation(row)
  const team = (k) => (letters ? `${k}, ${teamLetter(k, row)}` : k)
  const current = sets.find(s => !s.finished) || sets[sets.length - 1] || null
  const setEvents = current ? events.filter(e => (e.setIndex ?? 1) === current.index) : []
  const count = (type, key) => setEvents.filter(e => e.type === type && e.payload?.team === key).length
  const lastLineup = (key) => {
    const withLineup = setEvents.filter(e => e.payload?.team === key && (e.payload?.newLineup || e.payload?.lineup))
    const last = withLineup[withLineup.length - 1]
    return last ? `${lineupText(last.payload.newLineup || last.payload.lineup)} (seq ${last.seq})` : null
  }
  const lastPoint = [...setEvents].reverse().find(e => e.type === 'point')
  const type = row.test === true ? (row.easy === true ? 'easy match (unofficial, test type)' : 'test match') : 'official match'
  const block = row.cloudBlock
  const server = []
  if (row.scorerClaim) server.push('this device holds a scorer claim for the relay room')
  if (block?.code === 'OV_SCORER_MOVED') server.push(`another device scores it now${block.scorer?.platform ? ` (${oneLine(block.scorer.platform, 24)}${block.scorer.at ? ` since ${oneLine(block.scorer.at, 40)}` : ''})` : ''}${block.closed ? ', closed there' : ''}`)
  else if (block?.code === 'OV_MATCH_CLOSED') server.push('closed on the server (this copy is read-only)')
  else if (block?.code) server.push(`refused by the server: ${oneLine(block.code, 40)}${Number.isFinite(block.at) ? ` at ${clock.dateTime(block.at)}` : ''}`)
  if (!server.length) server.push(row.seed_key ? 'no refusal recorded' : 'not on the server (no cloud id)')
  const perSet = sets.map(s => `${s.index}: ${events.filter(e => (e.setIndex ?? 1) === s.index).length}`).join(', ')

  const rows = [
    ['Game number', row.gameNumber ?? row.gameN ?? row.game_n ?? null],
    ['Match id', `${row.id} (on this device)${row.seed_key ? `, ${oneLine(row.seed_key, 60)} (cloud)` : ''}${row.externalId ? `, external ${oneLine(row.externalId, 40)}` : ''}`],
    ['Shown in the report', m.why || null],
    ['Type', type],
    ['Status', `${row.status ?? '?'}${row.approved ? ', approved' : ''}`],
    ['Teams', `${oneLine(home, 60)} (${team('home')}) – ${oneLine(away, 60)} (${team('away')})`],
    ['Coin toss', row.coinTossConfirmed ? `confirmed, team A is ${row.coinTossTeamA || 'home'}` : (letters ? `team A is ${row.coinTossTeamA}` : 'not done')],
    ['Best of', row.bestOf ?? null],
    ['Sets (home:away)', sets.length ? sets.map(s => `set ${s.index} ${s.homePoints ?? 0}:${s.awayPoints ?? 0}${s.finished ? '' : ' (running)'}`).join(', ') : 'none yet'],
    ['Current set', current ? `set ${current.index}: ${home} ${current.homePoints ?? 0} – ${current.awayPoints ?? 0} ${away}` : null],
    ['Serving', lastPoint ? `${lastPoint.payload?.team ?? '?'} (won the last point)` : (current ? 'not known yet (no point in this set)' : null)],
    ['Line-up home', current ? lastLineup('home') || 'none in this set' : null],
    ['Line-up away', current ? lastLineup('away') || 'none in this set' : null],
    ['Time-outs', current ? `set ${current.index}: home ${count('timeout', 'home')}, away ${count('timeout', 'away')}` : null],
    ['Substitutions', current ? `set ${current.index}: home ${count('substitution', 'home')}, away ${count('substitution', 'away')}` : null],
    ['Events', `${events.length} in all${perSet ? ` (per set ${perSet})` : ''}`],
    ['Server', server.join('; ')],
    ['Unsent writes', m.unsent || null]
  ]
  const lines = kv(rows.map(([k, v]) => [k, v == null ? v : String(v)]))
  const recent = events.slice(-RECENT_EVENTS_MAX)
  if (recent.length) {
    lines.push('', `Last ${recent.length} events (newest last; score with team A first):`)
    lines.push(`  ${'seq'.padEnd(7)}${'time'.padEnd(14)}${'set'.padEnd(5)}event`)
    const ctx = { short: true, match: row, homeTeam: m.homeTeam, awayTeam: m.awayTeam }
    for (const e of recent) {
      let text
      if (e.type === 'remark') text = `Remark (${String(e.payload?.text || '').length} characters)`
      else {
        let d = null
        try { d = describeEvent(e, events, ctx) } catch { d = null }
        text = d?.text || `${EVENT_NAMES[e.type] || humanize(e.type) || 'Event'}${e.payload?.team ? ` ${e.payload.team}` : ''} (automatic)`
      }
      const t = tsOf(e.ts)
      lines.push(`  ${String(e.seq ?? '').padEnd(7)}${(t ? clock.time(t) : '').padEnd(14)}${String(e.setIndex ?? '').padEnd(5)}${oneLine(text, 120)}`)
    }
  }
  return lines
}

function appLogSection(entries, clock) {
  if (!entries.length) return ['No errors or warnings recorded.']
  const lines = []
  for (const e of entries) {
    const level = e.level === 'warn' ? 'WARN ' : 'ERROR'
    const first = oneLine(e.message, 400)
    lines.push(`${clock.time(e.ts).padEnd(TIME_WIDTH)}  ${level}  [${oneLine(e.source || 'app', 30)}] ${first}`)
    if (e.stack) {
      const stackLines = String(e.stack).split('\n').map(l => l.trim()).filter(Boolean)
      // the stack's first line ("TypeError: x") repeats the message
      const head = oneLine(stackLines[0] || '', 400)
      const repeats = head && !/^at\s|@/.test(head) && (first.includes(head) || first.includes(head.replace(/^[\w$.]*(?:Error|Exception)[\w$]*:\s*/, '')))
      const frames = repeats ? stackLines.slice(1) : stackLines
      for (const f of frames.slice(0, STACK_LINES_MAX)) lines.push(`${INDENT}       ${oneLine(f, 300)}`)
      if (frames.length > STACK_LINES_MAX) lines.push(`${INDENT}       … ${frames.length - STACK_LINES_MAX} more frames`)
    } else if (e.frames?.length) {
      lines.push(`${INDENT}       at ${e.frames.map(f => oneLine(f, 80)).join(', ')}`)
    }
  }
  return lines
}

/**
 * Errors and warnings from every source, oldest first, the same error told
 * twice (the activity log and the interaction log both see an uncaught
 * error) once, with the longer stack; the last APP_LOG_MAX.
 */
export function mergeAppLog(entries, { max = APP_LOG_MAX } = {}) {
  const list = (entries || [])
    .filter(e => e && Number.isFinite(e.ts) && e.message != null)
    .map(e => ({ ...e, message: cleanFreeText(e.message), stack: e.stack ? cleanFreeText(e.stack) : null }))
    .sort((a, b) => a.ts - b.ts)
  const out = []
  for (const e of list) {
    const key = oneLine(e.message, 80)
    const twin = out.find(o => Math.abs(o.ts - e.ts) <= 2000 && oneLine(o.message, 80) === key)
    if (twin) {
      if ((e.stack || '').length > (twin.stack || '').length) twin.stack = e.stack
      if (!twin.frames?.length && e.frames?.length) twin.frames = e.frames
      continue
    }
    out.push(e)
  }
  return out.slice(-max)
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * @param {object} input utils/diagnosticsCollect's collectDiagnosticsInput()
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ text: string, bytes: number, lines: number, fileName: string, timelineLines: number,
 *   timelineCut: number, sizeCut: number }}
 */
export function buildDiagnosticsReport(input, { maxBytes = REPORT_MAX_BYTES } = {}) {
  const now = input.now ?? Date.now()
  const clock = makeClock(input.timeZone)
  const s = input.summary || {}
  const fileName = diagnosticsFileName(now, input.gameNumber, { timeZone: input.timeZone })

  const timeline = input.timeline
    ? buildTimeline({ ...input.timeline, now, timeZone: input.timeZone, maxLines: input.maxTimelineLines ?? TIMELINE_MAX_LINES })
    : null
  const appLog = mergeAppLog(input.appLog || [])

  const head = (notes) => [
    'OpenVolley diagnostics',
    `${s.appName || 'OpenVolley'} ${s.version || ''} · ${clock.dateTime(now)} (${s.timeZone || 'local time'}) · ${fileName}`.replace(/\s+·/, ' ·'),
    'Sent with a support request because "Include diagnostics" was ticked. Nothing typed into a field,',
    'no password, PIN, session token, email address, phone number or signature is in it.',
    ...notes.map(n => `NOTE: ${n}`)
  ]

  const body1 = [...heading(1, 'Summary'), ...summarySection(s, clock, now)]
  const body2 = [...heading(2, 'Match'), ...matchSection(input.match, clock)]
  const tlHead = [...heading(3, 'Timeline: what was done on this device, oldest first')]
  if (timeline) {
    const t = input.timeline
    tlHead.push(
      `From ${t.from != null ? clock.dateTime(t.from) : 'the oldest entry'} to ${clock.dateTime(now)}${t.sessionStart != null ? ` (this page load started ${clock.dateTime(t.sessionStart)})` : ''}.`,
      `${timeline.entries.activity} activity log entries (scoring, corrections, sync, app start and quit, errors) and ${timeline.entries.interaction} interaction log entries (taps, keys, screens) in that time.`,
      'Columns: local time, kind, what. Runs of pointer moves and scrolls are one line, typing is one line per field',
      '(how many keys, never the text). "····" marks more than 5 minutes with nothing recorded.',
      ...(t.notes || []),
      ''
    )
  } else {
    tlHead.push(input.timelineNote || 'No timeline: this app keeps no activity or interaction log.')
  }
  let tlLines = timeline ? timeline.lines : []
  const body4 = [...heading(4, `App log: errors and warnings (last ${APP_LOG_MAX})`), ...appLogSection(appLog, clock)]
  const body5 = input.desktop
    ? [...heading(5, 'Desktop app'), ...(input.desktop.notes || []), ...(input.desktop.lines?.length ? ['', ...input.desktop.lines.slice(-DESKTOP_LINES_MAX).map(l => oneLine(l, 2000))] : [])]
    : []
  const tail = ['', '== end of report ==', '']

  const secrets = input.secrets || []
  const compose = (notes) => redactReport([...head(notes), ...body1, ...body2, ...tlHead, ...tlLines, ...body4, ...body5, ...tail].join('\n'), { secrets })
  const notesFor = (sizeCut) => [
    timeline?.cut ? `the timeline is cut to its last ${TIMELINE_MAX_LINES} lines: ${timeline.cut} older lines are left out.` : null,
    sizeCut ? `the report is cut to ${formatSize(maxBytes)}: the ${sizeCut} oldest timeline lines are left out.` : null
  ].filter(Boolean)

  let sizeCut = 0
  let text = compose(notesFor(0))
  let bytes = utf8Bytes(text)
  if (bytes > maxBytes && tlLines.length) {
    // drop the oldest timeline lines until it fits (each line's size once)
    const sizes = tlLines.map(l => utf8Bytes(l) + 1)
    let over = bytes - maxBytes + 256
    while (over > 0 && sizeCut < tlLines.length) {
      over -= sizes[sizeCut]
      sizeCut++
    }
    for (;;) {
      tlLines = (timeline ? timeline.lines : []).slice(sizeCut)
      text = compose(notesFor(sizeCut))
      bytes = utf8Bytes(text)
      if (bytes <= maxBytes || sizeCut >= sizes.length) break
      sizeCut = Math.min(sizes.length, sizeCut + Math.max(1, Math.ceil(sizes.length / 100)))
    }
  }
  return {
    text,
    bytes,
    lines: text.split('\n').length,
    fileName,
    timelineLines: tlLines.length,
    timelineCut: timeline?.cut || 0,
    sizeCut
  }
}
