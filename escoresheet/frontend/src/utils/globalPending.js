/**
 * The final uploads of a Global match that the server refused for now (2611
 * review, SR-4): its final backup and PDF for the Global store
 * (/api/global/save) and its final cloud copy with the PDF
 * (/api/global/cloud/save). A tournament day behind one sports hall's address
 * can spend the hall's daily share (429 OV_GLOBAL_QUOTA, Retry-After: the rest
 * of that day), the cloud can be busy (503) or full (507); the app tried a few
 * times within seconds and then gave up, and a closed match is never saved
 * again, so its result and PDF never reached the organizer list, the share
 * link or the backup-code restore.
 *
 * Such an upload is kept here (IndexedDB table global_pending, db/db.js
 * version 24) with the request it was, and sent again once the server's
 * Retry-After has passed (at least a minute, at most 6 hours apart), at app
 * start, when the device is back online and every few minutes; it is dropped
 * once stored, when the server refuses it for good (another 4xx: a wrong PIN,
 * a bad file), or after 7 days. One entry per match and kind: a newer final
 * upload of the same match replaces the older one. Best effort, never throws.
 */
import { db as appDb } from '../db/db'
import { getCloudApiUrl } from './backendConfig'

export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const RETRY_MIN_MS = 60 * 1000
export const RETRY_MAX_MS = 6 * 60 * 60 * 1000
export const RETRY_EVERY_MS = 5 * 60 * 1000
const PATHS = new Set(['/api/global/save', '/api/global/cloud/save'])

/** A refusal that may pass later: a rate or a daily share (429), a busy or full server (5xx), no answer. */
export const isRetryableRefusal = (status) => status === undefined || status === null || status === 0 || status === 429 || status >= 500

/** The wait before the next try: the server's Retry-After (seconds), within RETRY_MIN_MS..RETRY_MAX_MS. */
export function retryWaitMs(retryAfterSec, attempts = 0) {
  const fromServer = Number(retryAfterSec) > 0 ? Number(retryAfterSec) * 1000 : 0
  const backoff = RETRY_MIN_MS * 2 ** Math.min(8, Math.max(0, attempts))
  return Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, fromServer || backoff))
}

/** The seconds of a Retry-After header (a number; a date is read as one too), or null. */
export function retryAfterOf(res) {
  const raw = res?.headers?.get?.('retry-after')
  if (!raw) return null
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) return n
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : null
}

const offline = () => {
  try { return localStorage.getItem('offlineMode') === 'true' || (typeof navigator !== 'undefined' && navigator.onLine === false) } catch { return false }
}

/**
 * Keep a refused final upload: `id` names the match and the kind (one entry
 * each), `path` one of the two upload routes, `body` the JSON body it sent.
 */
export async function keepGlobalPending({ id, path, body, retryAfterSec = null, database = appDb, now = Date.now() } = {}) {
  if (typeof id !== 'string' || !id || !PATHS.has(path) || !body || typeof body !== 'object') return false
  try {
    const before = await database.global_pending.get(id)
    await database.global_pending.put({
      id,
      path,
      body,
      attempts: 0,
      createdAt: before?.createdAt ?? now,
      notBefore: now + retryWaitMs(retryAfterSec, 0)
    })
    return true
  } catch (err) {
    console.warn('[Global] A refused upload could not be kept:', err?.message)
    return false
  }
}

let running = null

/**
 * Send the kept uploads whose time has come. -> { sent, kept, dropped }
 * (`fetchImpl`, `now`, `database` for the tests).
 */
export function retryGlobalPending({ database = appDb, now = Date.now, fetchImpl = (...a) => fetch(...a) } = {}) {
  if (running) return running
  running = (async () => {
    const out = { sent: 0, kept: 0, dropped: 0 }
    if (offline()) return out
    let due = []
    try { due = await database.global_pending.where('notBefore').belowOrEqual(now()).toArray() } catch { return out }
    for (const e of due) {
      try {
        if (now() - (e.createdAt ?? 0) > PENDING_MAX_AGE_MS || !PATHS.has(e.path)) {
          await database.global_pending.delete(e.id)
          out.dropped++
          continue
        }
        const url = getCloudApiUrl(e.path)
        if (!url) { out.kept++; continue }
        let res = null
        try {
          res = await fetchImpl(url, { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(e.body) })
        } catch { res = null }
        const json = res ? await res.json().catch(() => null) : null
        if (res?.ok && !json?.error) {
          await database.global_pending.delete(e.id)
          out.sent++
        } else if (res && !isRetryableRefusal(res.status)) {
          console.warn('[Global] A kept upload was refused for good:', json?.error?.code || `HTTP ${res.status}`)
          await database.global_pending.delete(e.id)
          out.dropped++
        } else {
          const attempts = (e.attempts || 0) + 1
          await database.global_pending.update(e.id, { attempts, notBefore: now() + retryWaitMs(retryAfterOf(res), attempts) })
          out.kept++
        }
      } catch { out.kept++ }
    }
    return out
  })().finally(() => { running = null })
  return running
}

let started = false

/** At app start: send what is due now, when the device is back online, and every RETRY_EVERY_MS. */
export function startGlobalPendingRetry({ everyMs = RETRY_EVERY_MS } = {}) {
  if (started || typeof window === 'undefined') return () => {}
  started = true
  const run = () => { retryGlobalPending().catch(() => {}) }
  run()
  window.addEventListener('online', run)
  const timer = setInterval(run, everyMs)
  return () => {
    started = false
    window.removeEventListener('online', run)
    clearInterval(timer)
  }
}
