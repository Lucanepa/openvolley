/**
 * Activity log writer: buffers entries in memory and writes them to Dexie
 * (activity_log) with one bulkAdd every 250 ms or 50 entries, at once for an
 * error and on quit. Never awaited on the scoring path: the match and its
 * events stay the authoritative record; this is the account of who did what.
 *
 * Row: { lid, uid, ts, kind, level, app, matchId, matchExt, setIndex,
 *        eventSeq, eventExt, data, deviceId, appVersion, platform, accountId,
 *        synced: 0 (to upload) | 1 (uploaded) | 2 (local only) }
 */
import { sanitizeActivityData, isKnownKind, ACTIVITY_LEVELS } from '../../domain/activitySummary'
import { deviceId, appVersion, platformName, currentAccountId } from '../identity'
import { randomUuid } from '../deviceId'

export const FLUSH_DELAY_MS = 250
export const FLUSH_BATCH = 50
// Retention (pruneActivityLog)
export const SYNCED_MAX_AGE_MS = 180 * 24 * 3600 * 1000
export const KEEP_ROWS = 100000
export const HARD_CAP = 200000
// The same error message at most this often (per window)
export const ERROR_REPEAT_MAX = 5
export const ERROR_REPEAT_WINDOW_MS = 10 * 60 * 1000

export const SYNC = Object.freeze({ PENDING: 0, UPLOADED: 1, LOCAL: 2 })

/**
 * @param {object} deps
 * @param {import('dexie').Dexie} deps.db
 * @param {(rows:Array)=>void} [deps.onWritten] called after each stored batch (file copy, upload)
 * @param {() => number} [deps.now]
 * @param {'indoor'|'beach'} [deps.app]
 */
export function createActivityWriter({ db, onWritten = null, now = () => Date.now(), app = 'indoor' } = {}) {
  let buffer = []
  let timer = null
  let flushing = Promise.resolve()
  const matchInfo = new Map() // local match id -> { seedKey, test }
  const errorSeen = new Map() // message -> { at, count }
  let platform = null

  const platformOf = () => {
    if (platform == null) platform = platformName()
    return platform
  }

  function rememberMatch(id, seedKey, test) {
    if (id == null) return
    const prev = matchInfo.get(id) || {}
    matchInfo.set(id, {
      seedKey: seedKey === undefined ? prev.seedKey ?? null : seedKey || null,
      test: test === undefined ? prev.test ?? false : test === true
    })
    if (matchInfo.size > 200) matchInfo.delete(matchInfo.keys().next().value)
  }

  function errorAllowed(message) {
    const key = String(message || '').slice(0, 120)
    const t = now()
    const seen = errorSeen.get(key)
    if (!seen || t - seen.at > ERROR_REPEAT_WINDOW_MS) {
      errorSeen.set(key, { at: t, count: 1 })
      if (errorSeen.size > 100) errorSeen.delete(errorSeen.keys().next().value)
      return true
    }
    seen.count++
    return seen.count <= ERROR_REPEAT_MAX
  }

  /**
   * @returns {object|null} the entry (null when dropped)
   */
  function record(kind, data = {}, opts = {}) {
    if (!isKnownKind(kind)) return null
    const level = ACTIVITY_LEVELS.includes(opts.level) ? opts.level : 'info'
    if (kind === 'app.error' && !errorAllowed(data?.message)) return null
    const entry = {
      uid: randomUuid(),
      ts: typeof opts.ts === 'string' ? opts.ts : new Date(now()).toISOString(),
      kind,
      level,
      app,
      matchId: opts.matchId ?? null,
      matchExt: opts.matchExt ?? null,
      setIndex: Number.isFinite(Number(opts.setIndex)) && opts.setIndex !== null ? Number(opts.setIndex) : null,
      eventSeq: Number.isFinite(Number(opts.eventSeq)) && opts.eventSeq !== null ? Number(opts.eventSeq) : null,
      eventExt: opts.eventExt ?? null,
      data: sanitizeActivityData(kind, data),
      deviceId: deviceId(),
      appVersion: appVersion(),
      platform: platformOf(),
      accountId: opts.accountId !== undefined ? opts.accountId : currentAccountId(),
      synced: SYNC.PENDING
    }
    buffer.push(entry)
    if (level === 'error' || buffer.length >= FLUSH_BATCH) flush()
    else schedule()
    return entry
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, FLUSH_DELAY_MS)
  }

  async function resolveMatches(rows) {
    for (const r of rows) {
      if (r.matchId == null) continue
      let info = matchInfo.get(r.matchId)
      if (!info) {
        try {
          const m = await db?.matches?.get?.(r.matchId)
          rememberMatch(r.matchId, m?.seed_key ?? null, m?.test === true)
        } catch { /* unknown match */ }
        info = matchInfo.get(r.matchId)
      }
      if (!r.matchExt && info?.seedKey) r.matchExt = info.seedKey
      if (info?.test) r.synced = SYNC.LOCAL
    }
  }

  /** Write the buffer. Resolves when it is stored (or could not be). */
  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const rows = buffer
    buffer = []
    if (!rows.length) return flushing
    flushing = flushing.then(async () => {
      if (!db?.activity_log) return
      await resolveMatches(rows)
      try {
        await db.activity_log.bulkAdd(rows)
      } catch (e) {
        // A row that cannot be stored (a duplicate uid on a retry) must not take the batch
        for (const r of rows) {
          try { await db.activity_log.add(r) } catch { /* skip it */ }
        }
        console.warn('[Activity] batch write failed, wrote row by row:', e?.message)
      }
      if (typeof onWritten === 'function') {
        try { onWritten(rows) } catch (e) { console.warn('[Activity] after-write failed:', e?.message) }
      }
    }).catch(e => console.warn('[Activity] write failed:', e?.message))
    return flushing
  }

  /**
   * Local retention: uploaded / local-only rows 180 days and at most
   * KEEP_ROWS in all (oldest uploaded first); rows still to upload are kept
   * below HARD_CAP, above it the oldest go and one activity.overflow says how
   * many. Never throws.
   */
  async function prune() {
    const t = now()
    let removed = 0
    try {
      if (!db?.activity_log) return 0
      const cutoff = new Date(t - SYNCED_MAX_AGE_MS).toISOString()
      const oldDone = await db.activity_log.where('ts').below(cutoff).filter(r => r.synced !== SYNC.PENDING).primaryKeys()
      if (oldDone.length) await db.activity_log.bulkDelete(oldDone)
      removed += oldDone.length
      let total = await db.activity_log.count()
      if (total > KEEP_ROWS) {
        const done = await db.activity_log.orderBy('ts').filter(r => r.synced !== SYNC.PENDING).limit(total - KEEP_ROWS).primaryKeys()
        if (done.length) await db.activity_log.bulkDelete(done)
        removed += done.length
        total -= done.length
      }
      if (total > HARD_CAP) {
        const extra = await db.activity_log.orderBy('ts').limit(total - HARD_CAP).primaryKeys()
        await db.activity_log.bulkDelete(extra)
        removed += extra.length
        record('activity.overflow', { dropped: extra.length }, { level: 'warn' })
      }
    } catch (e) {
      console.warn('[Activity] prune failed:', e?.message)
    }
    return removed
  }

  return {
    record,
    flush,
    prune,
    rememberMatch,
    pending: () => buffer.length
  }
}
