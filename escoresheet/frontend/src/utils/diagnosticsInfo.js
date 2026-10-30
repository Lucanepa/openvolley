/**
 * What the support diagnostics (utils/diagnosticsReport.js) read from the
 * running app without importing it: each app publishes the state only it
 * holds (the scorer's sync status and relay clock, the referee's and the
 * bench's connection, the livescore's list) under a key, and the report
 * reads the latest value of every key when the user ticks "Include
 * diagnostics". Memory only, nothing is stored or sent from here.
 *
 * The error trail is for the apps without utils/logger (referee, bench,
 * livescore): their console errors and warnings and their uncaught errors,
 * the last ERROR_TRAIL_MAX, in memory only. The scorer app keeps them in the
 * logger's buffer, the activity log and the interaction log instead.
 *
 * No imports: every app and hook can use it.
 */

const info = new Map()

/**
 * Publish the current state of one part of the app (null removes it).
 * @param {string} key e.g. 'sync', 'relay', 'realtime', 'bench', 'livescore'
 * @param {object|null} value plain data, no secrets (the report scrubs anyway)
 */
export function setDiagnosticsInfo(key, value) {
  if (typeof key !== 'string' || !key) return
  if (value == null) info.delete(key)
  else info.set(key, { ...value, at: Date.now() })
}

/** Every published value, by key ({ key: { ...value, at } }). */
export function getDiagnosticsInfo() {
  return Object.fromEntries(info)
}

// ---------------------------------------------------------------------------
// Error trail (referee, bench, livescore)
// ---------------------------------------------------------------------------

export const ERROR_TRAIL_MAX = 200
const MESSAGE_MAX = 2000
const STACK_MAX = 4000

let trail = []
let installed = null

function text(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * One problem of the page for the diagnostics (newest last).
 * @param {'error'|'warn'} level
 * @param {string} source 'console' | 'window.error' | 'unhandledrejection' | ...
 * @param {string} message
 * @param {string|null} [stack]
 */
export function noteAppProblem(level, source, message, stack = null) {
  try {
    trail.push({
      ts: Date.now(),
      level: level === 'warn' ? 'warn' : 'error',
      source: String(source || 'app'),
      message: String(message ?? '').slice(0, MESSAGE_MAX),
      stack: typeof stack === 'string' && stack ? stack.slice(0, STACK_MAX) : null
    })
    if (trail.length > ERROR_TRAIL_MAX) trail = trail.slice(-ERROR_TRAIL_MAX)
  } catch {
    // never breaks the app
  }
}

/** The trail, oldest first. */
export const getErrorTrail = () => [...trail]

/**
 * Keep the page's console errors and warnings and its uncaught errors in the
 * trail (idempotent). The console still prints them.
 * @returns {() => void} uninstall
 */
export function installErrorTrail({ win = typeof window !== 'undefined' ? window : undefined, con = typeof console !== 'undefined' ? console : undefined } = {}) {
  if (installed) return installed
  const original = { error: con?.error, warn: con?.warn }
  const wrap = (level) => function (...args) {
    const err = args.find((a) => a instanceof Error)
    noteAppProblem(level, 'console', args.map(text).join(' '), err?.stack || null)
    return original[level]?.apply(con, args)
  }
  if (con) {
    con.error = wrap('error')
    con.warn = wrap('warn')
  }
  const onError = (e) => noteAppProblem('error', 'window.error', e?.error?.message || e?.message || 'Error', e?.error?.stack || null)
  const onRejection = (e) => noteAppProblem('error', 'unhandledrejection', e?.reason?.message || text(e?.reason), e?.reason?.stack || null)
  win?.addEventListener?.('error', onError)
  win?.addEventListener?.('unhandledrejection', onRejection)
  installed = () => {
    if (con) {
      con.error = original.error
      con.warn = original.warn
    }
    win?.removeEventListener?.('error', onError)
    win?.removeEventListener?.('unhandledrejection', onRejection)
    installed = null
  }
  return installed
}

/** Tests only. */
export function resetDiagnosticsInfoForTests() {
  info.clear()
  trail = []
  if (installed) installed()
}
