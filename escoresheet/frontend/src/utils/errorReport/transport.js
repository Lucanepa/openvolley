/**
 * Sends error reports to the backend (POST /api/errors, lib/errorTracker.js):
 * its own small queue in localStorage (at most 100, the oldest dropped), not
 * the sync queue, which waits for a signed-in session; works signed out. A
 * batch goes 5 s after the first report, at once for an error, and by
 * navigator.sendBeacon (text/plain) when the page is hidden or closed. A
 * report that could not be sent is sent again later with the same uid (the
 * server counts it once). A session's Bearer token goes along when there is
 * one, so the server can name the account; the body never names it.
 * Switched off (Options › Support and feedback): nothing is queued or sent,
 * and what was queued is dropped.
 */
export const QUEUE_KEY = 'ov.errorReports.queue'
export const OFF_KEY = 'ov.errorReports.off'
export const MAX_QUEUE = 100
export const BATCH = 20
export const DELAY_MS = 5000
const RETRY_MS = 60 * 1000

const storage = () => {
  try { return globalThis.localStorage || null } catch { return null }
}

/** Is automatic error reporting on (the default)? */
export function errorReportsEnabled(store = storage()) {
  try { return store?.getItem(OFF_KEY) !== '1' } catch { return true }
}

/** Switches it on or off; off also drops what is queued. */
export function setErrorReportsEnabled(on, store = storage()) {
  try {
    if (on) store?.removeItem(OFF_KEY)
    else {
      store?.setItem(OFF_KEY, '1')
      store?.removeItem(QUEUE_KEY)
    }
  } catch { /* storage blocked */ }
}

export function readQueue(store = storage()) {
  try {
    const q = JSON.parse(store?.getItem(QUEUE_KEY) || '[]')
    return Array.isArray(q) ? q : []
  } catch {
    return []
  }
}

function writeQueue(q, store = storage()) {
  try { store?.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE))) } catch { /* full or blocked: the reports stay in memory only */ }
}

/**
 * @param {{ url: () => string|null, authHeader?: () => object, fetchImpl?: Function, beacon?: Function, store?: Storage, setTimer?: Function }} deps
 */
export function createTransport({ url, authHeader = () => ({}), fetchImpl = (...a) => globalThis.fetch(...a), beacon = (u, b) => globalThis.navigator?.sendBeacon?.(u, b), store = storage(), setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
  let timer = null
  let sending = false
  let memory = [] // when storage is unusable

  const queue = () => (store ? readQueue(store) : memory)
  const save = (q) => { if (store) writeQueue(q, store); else memory = q.slice(-MAX_QUEUE) }

  function schedule(ms) {
    if (timer) return
    timer = setTimer(() => { timer = null; void flush() }, ms)
  }

  /** Queues one report; an error goes at once, a warning with the next batch. */
  function enqueue(event) {
    if (!errorReportsEnabled(store)) return false
    const q = queue()
    if (q.some((e) => e.uid === event.uid)) return false
    q.push(event)
    save(q)
    schedule(event.level === 'error' ? 0 : DELAY_MS)
    return true
  }

  /** Sends what is queued (a batch at a time). Never throws. */
  async function flush() {
    if (sending || !errorReportsEnabled(store)) return { sent: 0 }
    const target = url()
    if (!target) return { sent: 0 }
    sending = true
    let sent = 0
    try {
      for (;;) {
        const q = queue()
        if (!q.length) break
        const batch = q.slice(0, BATCH)
        let res
        try {
          res = await fetchImpl(target, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader() },
            body: JSON.stringify({ events: batch }),
            keepalive: batch.length <= 5
          })
        } catch {
          schedule(RETRY_MS)
          break
        }
        // taken (200), dropped by a rate limit (202) or refused as malformed
        // (400): never sent again. Anything else (5xx, 429): later.
        if (res.ok || res.status === 400 || res.status === 413) {
          const done = new Set(batch.map((e) => e.uid))
          save(queue().filter((e) => !done.has(e.uid)))
          sent += batch.length
        } else {
          schedule(RETRY_MS)
          break
        }
      }
    } finally {
      sending = false
    }
    return { sent }
  }

  /** The page is going away: what is queued goes by beacon (no headers, so no account). */
  function flushOnExit() {
    if (!errorReportsEnabled(store)) return
    const target = url()
    const q = queue()
    if (!target || !q.length) return
    try {
      const body = new Blob([JSON.stringify({ events: q.slice(0, BATCH) })], { type: 'text/plain;charset=UTF-8' })
      if (beacon(target, body)) save(q.slice(BATCH))
    } catch { /* no beacon */ }
  }

  return { enqueue, flush, flushOnExit, queue }
}
