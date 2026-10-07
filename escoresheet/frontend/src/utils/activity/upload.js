/**
 * Upload of the activity log (POST /api/activity) through the sync queue:
 * one coalesced job { resource: 'activity', action: 'flush' } at a time,
 * queued 10 s after new entries (about one request per 10 s during a match,
 * two for a whole match scored offline). Each run sends up to 500 rows that
 * wait (synced 0) of no account or of the account signed in now; rows of
 * another account wait until it signs in again. Accepted rows become
 * synced 1, rows the server refuses synced 2 (kept on the device only).
 */
import { SYNC } from './writer'
import { currentAccountId } from '../identity'
import { apiPostActivity } from '../../lib/apiClient'
import { sanitizeActivityData } from '../../domain/activitySummary'

export const UPLOAD_BATCH = 500
export const FLUSH_DEBOUNCE_MS = 10000

export const activityFlushJob = () => ({ resource: 'activity', action: 'flush', payload: {}, ts: Date.now(), status: 'queued' })

/** Queue a flush job unless one is already queued (and only with a session). */
export async function ensureActivityFlushJob(db, { accountId = currentAccountId() } = {}) {
  if (!db?.sync_queue || !accountId) return false
  try {
    const queued = await db.sync_queue.where('resource').equals('activity').filter(j => j.status === 'queued').count()
    if (queued > 0) return false
    await db.sync_queue.add(activityFlushJob())
    return true
  } catch (e) {
    console.warn('[Activity] could not queue the upload:', e?.message)
    return false
  }
}

let timer = null
/** Queue the flush job FLUSH_DEBOUNCE_MS after the first new entry. */
export function scheduleActivityUpload(db, delayMs = FLUSH_DEBOUNCE_MS) {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    ensureActivityFlushJob(db)
  }, delayMs)
}

/** The /api/activity body of a row. */
export function uploadEntry(row) {
  return {
    uid: row.uid,
    client_ts: row.ts,
    kind: row.kind,
    level: row.level || 'info',
    app: row.app || 'indoor',
    match_external_id: row.matchExt || null,
    account_id: row.accountId || null,
    device_id: row.deviceId || null,
    app_version: row.appVersion || null,
    platform: row.platform || null,
    set_index: row.setIndex ?? null,
    event_seq: row.eventSeq ?? null,
    event_external_id: row.eventExt || null,
    // sanitized again: rows stored by an older version may predate a rule
    // (e.g. the free-text redaction of PINs and long numbers)
    data: sanitizeActivityData(row.kind, row.data || {})
  }
}

/**
 * Send one batch.
 * @returns {Promise<{ sent: number, accepted: number, rejected: number, more: boolean, error?: object, status?: number }>}
 */
export async function uploadActivityBatch(db, { post = apiPostActivity, accountId = currentAccountId(), batch = UPLOAD_BATCH } = {}) {
  const out = { sent: 0, accepted: 0, rejected: 0, more: false }
  if (!db?.activity_log) return out
  const mine = (r) => r.accountId == null || r.accountId === accountId
  const rows = await db.activity_log.where('synced').equals(SYNC.PENDING).filter(mine).limit(batch + 1).toArray()
  out.more = rows.length > batch
  const page = rows.slice(0, batch)
  if (!page.length) return out

  // Match keys the row did not know yet (the match got its seed_key later);
  // a test match's rows never leave the device
  const local = []
  const send = []
  const matchCache = new Map()
  for (const r of page) {
    if (r.matchId != null && !r.matchExt) {
      if (!matchCache.has(r.matchId)) {
        try { matchCache.set(r.matchId, await db.matches.get(r.matchId)) } catch { matchCache.set(r.matchId, null) }
      }
      const m = matchCache.get(r.matchId)
      if (m?.test === true) {
        local.push(r.lid)
        continue
      }
      if (m?.seed_key) r.matchExt = m.seed_key
    }
    send.push(r)
  }
  if (local.length) await db.activity_log.where('lid').anyOf(local).modify({ synced: SYNC.LOCAL })
  if (!send.length) return out

  out.sent = send.length
  const res = await post(send.map(uploadEntry))
  if (res?.error) return { ...out, error: res.error, status: res.status ?? res.error.status }
  const accepted = new Set(res?.data?.accepted || [])
  const rejected = new Set((res?.data?.rejected || []).map(r => r?.uid).filter(Boolean))
  const byUid = new Map(send.map(r => [r.uid, r]))
  const okLids = []
  const badLids = []
  for (const [uid, r] of byUid) {
    if (rejected.has(uid)) badLids.push(r.lid)
    else if (accepted.has(uid)) okLids.push(r.lid)
  }
  await db.transaction('rw', db.activity_log, async () => {
    if (okLids.length) await db.activity_log.where('lid').anyOf(okLids).modify({ synced: SYNC.UPLOADED })
    if (badLids.length) await db.activity_log.where('lid').anyOf(badLids).modify({ synced: SYNC.LOCAL })
    // the match key filled in above, for the rows uploaded
    for (const r of send) {
      if (r.matchExt && okLids.includes(r.lid)) await db.activity_log.update(r.lid, { matchExt: r.matchExt })
    }
  })
  out.accepted = okLids.length
  out.rejected = badLids.length
  return out
}

/** Testing: drop a pending debounce timer. */
export function resetActivityUploadTimer() {
  if (timer) clearTimeout(timer)
  timer = null
}
