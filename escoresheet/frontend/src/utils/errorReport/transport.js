/**
 * Sends error reports to the backend (POST /api/errors, lib/errorTracker.js):
 * its own small queue in localStorage (at most 100, the oldest dropped), not
 * the sync queue, which waits for a signed-in session; works signed out. A
 * batch goes 5 s after the first report, at once for an error, and by
 * navigator.sendBeacon (text/plain) when the page is hidden or closed. A
 * report that could not be sent, or that a shared limit of the server
 * dropped (202 { dropped }: its rate limit, the new-group window of reports
 * without a session, a full store), is sent again later with the same uid
 * (the server keeps it once); a dropped one at most a day after it happened,
 * behind the rest of the queue. A beacon's answer is never read, so what it
 * sent stays queued until a fetch confirms it (sent again later, once per
 * page: the server dedupes by uid), and a report a 202 kept is not lost at
 * the next screen-off (review ET-5 of SEC-19). A session's Bearer token goes
 * along when there is one (not by beacon), so the server can name the
 * account; the body never names it.
 * Switched off (Options › Support and feedback): nothing is queued or sent,
 * and what was queued is dropped.
 */
export const QUEUE_KEY = 'ov.errorReports.queue'
export const OFF_KEY = 'ov.errorReports.off'
export const MAX_QUEUE = 100
export const BATCH = 20
export const DELAY_MS = 5000
const RETRY_MS = 60 * 1000
// A report the server's rate limit dropped (202 with dropped > 0) goes again
// later, up to this long after it happened; then it is let go
export const DROPPED_MAX_AGE_MS = 24 * 60 * 60 * 1000

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
export function createTransport({ url, authHeader = () => ({}), fetchImpl = (...a) => globalThis.fetch(...a), beacon = (u, b) => globalThis.navigator?.sendBeacon?.(u, b), store = storage(), setTimer = (fn, ms) => setTimeout(fn, ms), now = () => Date.now() } = {}) {
  let timer = null
  let sending = false
  let memory = [] // when storage is unusable
  // uids sent by beacon in this page's life: not beaconed again, they wait for a fetch
  const beaconed = new Set()

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
        // taken (200) or refused as malformed (400, 413): never sent again.
        // A rate limit (202 with dropped > 0): what it took or refused goes,
        // the rest waits and goes again later (until DROPPED_MAX_AGE_MS after
        // it happened). Anything else (5xx, 429): later.
        const dropped = res.status === 202 ? await droppedOf(res) : null
        if (dropped) {
          const cutoff = now() - DROPPED_MAX_AGE_MS
          const inBatch = new Set(batch.map((e) => e.uid))
          const tooOld = (e) => Date.parse(e.client_ts) < cutoff
          const left = queue().filter((e) => !dropped.done.has(e.uid) && !(inBatch.has(e.uid) && tooOld(e)))
          // what this batch kept goes behind the rest: a report the server
          // keeps refusing does not hold up the others
          save([...left.filter((e) => !inBatch.has(e.uid)), ...left.filter((e) => inBatch.has(e.uid))])
          schedule(RETRY_MS)
          break
        }
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

  /** A 202's body: { done: the uids it took or refused } when it dropped some, else null (taken as a 200). */
  async function droppedOf(res) {
    try {
      const data = typeof res.json === 'function' ? (await res.json())?.data : null
      if (!(Number(data?.dropped) > 0)) return null
      const done = new Set([
        ...(Array.isArray(data.accepted) ? data.accepted : []),
        ...(Array.isArray(data.rejected) ? data.rejected.map((r) => r?.uid) : [])
      ])
      return { done }
    } catch {
      return null
    }
  }

  /**
   * The page is hidden or going away: what is queued and was not beaconed
   * yet goes by beacon (no headers, so no account). It stays queued: a
   * beacon's answer is never read (a 202 dropped would be lost), so a fetch
   * sends it again when the page is back, or the next visit does.
   */
  function flushOnExit() {
    if (!errorReportsEnabled(store)) return
    const target = url()
    const q = queue()
    const queued = new Set(q.map((e) => e.uid))
    for (const uid of beaconed) if (!queued.has(uid)) beaconed.delete(uid)
    const batch = q.filter((e) => !beaconed.has(e.uid)).slice(0, BATCH)
    if (!target || !batch.length) return
    try {
      const body = new Blob([JSON.stringify({ events: batch })], { type: 'text/plain;charset=UTF-8' })
      if (beacon(target, body)) {
        for (const e of batch) beaconed.add(e.uid)
        schedule(RETRY_MS)
      }
    } catch { /* no beacon */ }
  }

  return { enqueue, flush, flushOnExit, queue }
}
