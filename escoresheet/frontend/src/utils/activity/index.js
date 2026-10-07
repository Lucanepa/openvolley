/**
 * The match activity log (docs/activity-log-spec.md): one synced record of
 * what happened on this device - scoring, corrections (undo, delete, edit,
 * manual changes), sync results, app start / update / quit and errors - with
 * the device id, app version, platform and account. Stored in Dexie
 * (activity_log), uploaded in batches (POST /api/activity) and, in the
 * desktop and Android apps, also appended to a daily JSONL file next to the
 * native backups.
 *
 * Click and keystroke streams are NOT part of it: they stay on the device
 * (utils/comprehensiveLogger).
 *
 * startActivityLog() runs once in the scorer app (main.jsx). Other code
 * reports through utils/activity/bus (emitActivity), which needs no database.
 */
import { createActivityWriter, SYNC } from './writer'
import { installActivityHooks } from './hooks'
import { setActivitySink, emitActivity } from './bus'
import { appVersion, platformName, currentAccountId } from '../identity'
import { AUTH_TOKEN_CHANGE_EVENT } from '../../lib/apiClient'
import { scheduleActivityUpload, ensureActivityFlushJob } from './upload'

export { emitActivity, flushActivityNow } from './bus'
export { SYNC } from './writer'

const LAST_VERSION_KEY = 'ov.lastVersion'
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
const SUMMARY_INTERVAL_MS = 5 * 60 * 1000

let started = null

/** Stored rows written after a batch (file copy, upload): set by the later stages. */
const afterWrite = new Set()
export function onActivityWritten(fn) {
  afterWrite.add(fn)
  return () => afterWrite.delete(fn)
}

function readStored(key) {
  try { return localStorage.getItem(key) } catch { return null }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, value) } catch { /* storage blocked */ }
}

/**
 * Start the activity log (idempotent).
 * @param {{ db: import('dexie').Dexie, win?: Window }} opts
 * @returns {{ writer: object, stop: () => void }}
 */
export function startActivityLog({ db, win = typeof window !== 'undefined' ? window : undefined } = {}) {
  if (started) return started
  const writer = createActivityWriter({
    db,
    onWritten: (rows) => {
      // Upload (with a session; rows of test matches never leave the device)
      if (rows.some(r => r.synced === SYNC.PENDING)) scheduleActivityUpload(db)
      for (const fn of afterWrite) {
        try { fn(rows) } catch (e) { console.warn('[Activity] after-write listener failed:', e?.message) }
      }
    }
  })

  // Sync summary: counted per pass, written at most every 5 minutes and at set end
  const summary = { sent: 0, failed: 0, pending: 0, at: Date.now(), dirty: false }
  const writeSummary = () => {
    if (!summary.dirty) return
    writer.record('sync.summary', { sent: summary.sent, failed: summary.failed, pending: summary.pending })
    summary.sent = 0
    summary.failed = 0
    summary.dirty = false
    summary.at = Date.now()
  }
  const sink = {
    record: (kind, data, opts) => writer.record(kind, data, opts),
    flush: () => writer.flush(),
    noteSyncPass: (o) => {
      if (!o) return
      summary.sent += o.sent || 0
      summary.failed += o.failed || 0
      summary.pending = o.pending ?? summary.pending
      if ((o.sent || 0) || (o.failed || 0)) summary.dirty = true
      if (Date.now() - summary.at >= SUMMARY_INTERVAL_MS) writeSummary()
    }
  }
  writer.setEnded = writeSummary
  setActivitySink(sink)

  const uninstallHooks = installActivityHooks(db, writer)
  const cleanups = [uninstallHooks]

  // app.start / app.update
  const version = appVersion()
  const previous = readStored(LAST_VERSION_KEY)
  const platform = platformName(win)
  Promise.resolve()
    .then(() => (typeof navigator !== 'undefined' && navigator.storage?.persisted ? navigator.storage.persisted() : null))
    .catch(() => null)
    .then((persisted) => {
      writer.record('app.start', { version, platform, persisted: persisted ?? null })
      if (previous && previous !== version) writer.record('app.update', { version, previous, platform })
      writeStored(LAST_VERSION_KEY, version)
    })

  // app.quit (web: the page goes; the desktop app reports through appLifecycle)
  if (win?.addEventListener) {
    const onHide = (e) => {
      if (e && e.persisted) return // bfcache: the page may come back
      writer.record('app.quit', {})
      writer.flush()
    }
    win.addEventListener('pagehide', onHide)
    cleanups.push(() => win.removeEventListener('pagehide', onHide))

    // auth.sign_in / auth.sign_out (the account id is the row's)
    let account = currentAccountId()
    const onAuth = () => {
      const next = currentAccountId()
      if (next === account) return
      if (account) writer.record('auth.sign_out', {}, { accountId: account })
      if (next) writer.record('auth.sign_in', {}, { accountId: next })
      account = next
      // What waited for a session goes now
      if (next) writer.flush().then(() => ensureActivityFlushJob(db, { accountId: next }))
    }
    win.addEventListener(AUTH_TOKEN_CHANGE_EVENT, onAuth)
    const onStorage = (e) => { if (e?.key === 'api_auth_token') onAuth() }
    win.addEventListener('storage', onStorage)
    cleanups.push(() => {
      win.removeEventListener(AUTH_TOKEN_CHANGE_EVENT, onAuth)
      win.removeEventListener('storage', onStorage)
    })
  }

  // Rows left from the last run (quit before the upload)
  const kick = setTimeout(() => { ensureActivityFlushJob(db) }, 15000)
  cleanups.push(() => clearTimeout(kick))

  // Retention
  writer.prune()
  const pruneTimer = setInterval(() => { writer.prune() }, PRUNE_INTERVAL_MS)
  cleanups.push(() => clearInterval(pruneTimer))

  started = {
    writer,
    stop() {
      for (const c of cleanups.splice(0)) {
        try { c() } catch { /* ignore */ }
      }
      setActivitySink(null)
      started = null
    }
  }
  return started
}

/** The writer of the running log (tests, the upload). */
export const activityWriter = () => started?.writer || null

/**
 * Entries of one match (or all with matchId null), newest first, for the UI.
 * @param {import('dexie').Dexie} db
 * @param {{ matchId?: any, limit?: number }} [opts]
 */
export async function listActivity(db, { matchId = null, limit = 2000 } = {}) {
  if (!db?.activity_log) return []
  try {
    await started?.writer?.flush()
    const coll = matchId == null
      ? db.activity_log.orderBy('ts').reverse()
      : db.activity_log.where('[matchId+ts]').between([matchId, ''], [matchId, '￿']).reverse()
    return await coll.limit(limit).toArray()
  } catch (e) {
    console.warn('[Activity] list failed:', e?.message)
    return []
  }
}

/** How many entries still wait for upload (optionally of one match). */
export async function countNotUploaded(db, { matchId = null } = {}) {
  if (!db?.activity_log) return 0
  try {
    if (matchId == null) return await db.activity_log.where('synced').equals(SYNC.PENDING).count()
    return await db.activity_log.where('[matchId+ts]').between([matchId, ''], [matchId, '￿']).filter(r => r.synced === SYNC.PENDING).count()
  } catch {
    return 0
  }
}

// Report helpers for code that already imports this module
export const recordActivity = (kind, data, opts) => emitActivity(kind, data, opts)
