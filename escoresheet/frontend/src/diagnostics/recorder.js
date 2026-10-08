/**
 * The diagnostics recorder: one JSON line per observation,
 *
 *   {"ts":"2026-10-08T12:34:56.789Z","m":15234.5,"sid":"k3f9a2","seq":42,
 *    "src":"page","k":"geo.jump","a":7,"d":{...}}
 *
 *   ts   wall clock (UTC)            m    performance.now() of this page load (ms)
 *   sid  this page load              seq  line number in this page load
 *   k    what (page.*, geo.*, css.*, dialog.*, ui.*, action.*, lq.*, perf.*, react.*, sw.*)
 *   a    the user action this follows (the n-th click / key of this load), 0 before any
 *   d    the data, redacted (redact.js)
 *
 * `diag(kind, data)` is a no-op while diagnostics is off (one boolean check),
 * so callers in hot paths need no guard. Lines are buffered and written
 * every second / 100 lines; on pagehide the unwritten ones also go into
 * sessionStorage and are written by the next load of this tab.
 */
import { sanitizeDiagData } from './redact'

export const FLUSH_MS = 1000
export const FLUSH_LINES = 100
export const PENDING_KEY = 'ov.diagnostics.pending'
const PENDING_MAX = 300
const MAX_BUFFER = 5000

let active = false
let sink = null
let buffer = []
let timer = null
let chain = Promise.resolve()
let seq = 0
let action = 0
let actionAt = 0
let lastState = null
let sid = ''
let perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
let wallNow = () => Date.now()
let session = null
let dropped = 0

// Kinds that change what is on screen: a later size change names the last one
const STATE_KINDS = /^(action\.(commit|ui)|lq\.emit|dialog\.(open|close|content)|css\.vars|geo\.window|page\.visibility)$/

const r1 = (n) => Math.round(n * 10) / 10

export const diagActive = () => active
export const diagSessionId = () => sid

/** Record one line (no-op while off). */
export function diag(kind, data) {
  if (!active) return
  try {
    const m = perfNow()
    const line = { ts: new Date(wallNow()).toISOString(), m: r1(m), sid, seq: ++seq, src: 'page', k: kind, a: action }
    if (data !== undefined) line.d = sanitizeDiagData(data)
    if (STATE_KINDS.test(kind)) lastState = { k: kind, m }
    if (buffer.length >= MAX_BUFFER) {
      dropped++
      return
    }
    buffer.push(JSON.stringify(line))
    if (buffer.length >= FLUSH_LINES) flushDiagnostics()
    else if (!timer) timer = setTimeout(flushDiagnostics, FLUSH_MS)
  } catch { /* diagnostics never breaks the app */ }
}

/** A user action (click, key): later lines carry its number. Returns it. */
export function noteAction(kind, data) {
  if (!active) return 0
  action++
  actionAt = perfNow()
  diag(kind, data)
  return action
}

/** { a, ms } : the current user action and how long ago it was. */
export function sinceAction() {
  return { a: action, ms: action ? r1(perfNow() - actionAt) : null }
}

/** { k, ms } : the last screen-changing line (action commit, dialog, CSS variables ...). */
export function sinceState() {
  return lastState ? { k: lastState.k, ms: r1(perfNow() - lastState.m) } : null
}

export function flushDiagnostics() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (dropped) {
    const n = dropped
    dropped = 0
    buffer.push(JSON.stringify({ ts: new Date(wallNow()).toISOString(), m: r1(perfNow()), sid, seq: ++seq, src: 'page', k: 'diag.dropped', a: action, d: { lines: n } }))
  }
  const batch = buffer
  buffer = []
  const target = sink
  if (!batch.length || !target) return chain
  chain = chain
    .then(() => withTimeout(target.write(batch)))
    .then(() => clearPending())
    .catch((e) => { try { console.warn('[Diagnostics] write failed:', e?.message || e) } catch { /* ignore */ } })
  return chain
}

// a write that never answers (the page going away mid-call) must not hold the later ones
const WRITE_TIMEOUT_MS = 10000
function withTimeout(promise) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('write timed out')), WRITE_TIMEOUT_MS) })
  ]).finally(() => clearTimeout(timer))
}

function clearPending() {
  try { session?.removeItem(PENDING_KEY) } catch { /* ignore */ }
}

/**
 * pagehide: keep what is not written yet for the next load of this tab (the
 * write below may not finish before the page is gone), then write it.
 */
export function stashAndFlush() {
  if (!active) return chain
  try {
    if (buffer.length) {
      const prev = JSON.parse(session?.getItem(PENDING_KEY) || '[]')
      session?.setItem(PENDING_KEY, JSON.stringify([...prev, ...buffer].slice(-PENDING_MAX)))
    }
  } catch { /* storage full or blocked */ }
  return flushDiagnostics()
}

/** Lines a previous load of this tab could not write (stashAndFlush). */
export function takePending(storage = session) {
  try {
    const lines = JSON.parse(storage?.getItem(PENDING_KEY) || '[]')
    storage?.removeItem(PENDING_KEY)
    return Array.isArray(lines) ? lines.filter(l => typeof l === 'string') : []
  } catch {
    return []
  }
}

const randomSid = () => Math.random().toString(36).slice(2, 8).padEnd(6, '0')

/**
 * Start recording into `sink`.
 * @param {{ sink: { write(lines: string[]): Promise<any> }, sessionId?: string, now?: () => number, perf?: () => number, storage?: Storage }} opts
 */
export function startRecorder({ sink: s, sessionId = randomSid(), now, perf, storage = globalThis.sessionStorage } = {}) {
  sink = s || null
  sid = sessionId
  if (now) wallNow = now
  if (perf) perfNow = perf
  session = storage || null
  seq = 0
  action = 0
  actionAt = 0
  lastState = null
  buffer = []
  dropped = 0
  active = true
  const pending = takePending(storage)
  const target = sink
  if (pending.length && target) chain = chain.then(() => withTimeout(target.write(pending))).catch(() => {})
  return sid
}

/** Stop recording (what is buffered is written first). */
export async function stopRecorder() {
  if (!active) return
  await flushDiagnostics()
  active = false
  sink = null
}

/** The running sink (Options: export, open folder). */
export const diagSink = () => sink
