/**
 * Operational logging helpers for server.js: proportionate, value-free logs.
 *
 *   newRequestId()                       short random id, echoed as X-Request-Id
 *   formatDbRejection({...})             one line for a rejected /api/db request
 *   createLogLimiter({ max, windowMs })  at most `max` lines per window, then a
 *                                        "N suppressed" note (anonymous probes
 *                                        cannot flood the log)
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
 * Passes at most `max` lines per `windowMs`; the first line after a window
 * with drops is preceded by "[log] N similar lines suppressed".
 * @returns {(line: string) => void}
 */
export function createLogLimiter({ max = 30, windowMs = 60_000, write = (l) => console.warn(l), now = Date.now } = {}) {
  let windowStart = now()
  let count = 0
  let suppressed = 0
  return function limited(line) {
    const t = now()
    if (t - windowStart >= windowMs) {
      if (suppressed > 0) write(`[log] ${suppressed} similar line(s) suppressed in the last ${Math.round((t - windowStart) / 1000)}s`)
      windowStart = t
      count = 0
      suppressed = 0
    }
    if (count < max) {
      count++
      write(line)
    } else {
      suppressed++
    }
  }
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
