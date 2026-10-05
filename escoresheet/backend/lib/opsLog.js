/**
 * Operational logging helpers for server.js: proportionate, value-free logs.
 *
 *   newRequestId()                       short random id, echoed as X-Request-Id
 *   formatDbRejection({...})             one line for a rejected /api/db request
 *   createLogLimiter({ max, windowMs })  at most `max` lines per key (error
 *                                        code) and window, then a per-key
 *                                        "suppressed" note (anonymous probes
 *                                        cannot flood the log or crowd out
 *                                        the rare codes)
 *   createConnectionSummary({...})       counts socket opens/closes (and other
 *                                        chatty events) and prints one summary
 *                                        line per interval instead of one line
 *                                        per event
 *
 * Nothing here ever receives request values, PINs, tokens or client IPs: the
 * callers pass only status, error code, table, action and the request id.
 */
import { randomBytes } from 'node:crypto'

/** 12 hex chars; enough to correlate one request in a day of logs. */
export function newRequestId() {
  return randomBytes(6).toString('hex')
}

// Codes, tables and actions come from our own allowlists, but a rejected
// request is by definition not trusted: keep only identifier characters.
const token = (v, max = 64) => {
  if (v === undefined || v === null || v === '') return '-'
  const s = String(v).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max)
  return s || '-'
}

/**
 * @param {object} p
 * @param {string} p.reqId
 * @param {number} p.status   HTTP status sent to the client
 * @param {string} [p.code]   machine error code (OV_UNSCOPED_EXTERNAL_ID, missing_token, ...)
 * @param {string} [p.table]
 * @param {string} [p.action]
 * @returns {string}
 */
export function formatDbRejection({ reqId, status, code, table, action }) {
  return `[DB] rejected req=${token(reqId, 32)} status=${Number(status) || 0} code=${token(code)} table=${token(table)} action=${token(action, 16)}`
}

/**
 * Rate-limits log lines per key (e.g. the error code): each key gets its own
 * budget of `max` lines per `windowMs`, so a flood of one kind (anonymous
 * 401s, 429s from a prober) cannot hide the rare, important kinds
 * (OV_UNSCOPED_EXTERNAL_ID, OV_CLIENT_TOO_OLD). At most `maxKeys` keys are
 * tracked per window; further keys share the budget of the key "other".
 *
 * Dropped lines are counted per key and reported as one line when the window
 * ends: "[log] suppressed in the last 60s: OV_RATE_LIMITED=1200, invalid_token=40".
 * The note is written by the next line after the window or by flush(), which
 * the caller runs from a timer so a burst followed by quiet still reports.
 *
 *   const log = createLogLimiter({ max: 30, windowMs: 60_000 })
 *   log(line, code)
 *   setInterval(() => log.flush(), 60_000).unref()
 *
 * @returns {((line: string, key?: string) => void) & { flush: () => string | null }}
 */
export function createLogLimiter({ max = 30, windowMs = 60_000, maxKeys = 32, write = (l) => console.warn(l), now = Date.now } = {}) {
  let windowStart = now()
  let counts = new Map()
  let suppressed = new Map()

  function rollover(t) {
    let note = null
    if (suppressed.size > 0) {
      const parts = [...suppressed].map(([k, n]) => `${token(k)}=${n}`)
      note = `[log] suppressed in the last ${Math.max(1, Math.round((t - windowStart) / 1000))}s: ${parts.join(', ')}`
      write(note)
    }
    windowStart = t
    counts = new Map()
    suppressed = new Map()
    return note
  }

  function limited(line, key = 'default') {
    const t = now()
    if (t - windowStart >= windowMs) rollover(t)
    let k = String(key ?? 'default')
    if (!counts.has(k) && counts.size >= maxKeys) k = 'other'
    const n = counts.get(k) || 0
    if (n < max) {
      counts.set(k, n + 1)
      write(line)
    } else {
      suppressed.set(k, (suppressed.get(k) || 0) + 1)
    }
  }

  /** End the window if it has elapsed, writing the suppression note. */
  limited.flush = () => {
    const t = now()
    return t - windowStart >= windowMs ? rollover(t) : null
  }

  return limited
}

/**
 * Counts chatty events and logs one line per interval with activity.
 *
 *   const s = createConnectionSummary({ label: '[WS]' })
 *   s.count('opened'); s.count('closed'); s.setGauge('open', connections.size)
 *   setInterval(() => s.flush(), 60_000).unref()
 *
 * count() also flushes when the interval has elapsed, so a busy server logs
 * on time even without the timer. flush() logs nothing when nothing happened.
 *
 * @param {object} [opts]
 * @param {string} [opts.label='[WS]']
 * @param {number} [opts.intervalMs=60000]
 * @param {(line: string) => void} [opts.write]
 * @param {() => number} [opts.now]
 */
export function createConnectionSummary({ label = '[WS]', intervalMs = 60_000, write = (l) => console.log(l), now = Date.now } = {}) {
  let counters = new Map()
  const gauges = new Map()
  let since = now()

  function flush() {
    const t = now()
    if (counters.size === 0) { since = t; return null }
    const parts = [...counters].map(([k, v]) => `${v} ${k}`)
    for (const [k, v] of gauges) parts.push(`${k} now ${v}`)
    const line = `${label} last ${Math.max(1, Math.round((t - since) / 1000))}s: ${parts.join(', ')}`
    counters = new Map()
    since = t
    write(line)
    return line
  }

  return {
    count(name, n = 1) {
      counters.set(name, (counters.get(name) || 0) + n)
      if (now() - since >= intervalMs) flush()
    },
    setGauge(name, value) { gauges.set(name, value) },
    flush,
    /** Current unflushed counts (tests, /health). */
    snapshot() { return Object.fromEntries(counters) }
  }
}
