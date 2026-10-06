/**
 * Logger - Captures console logs and backs them up to the cloud storage.
 *
 * Debug output: production builds keep console.log/console.debug out of the
 * browser console unless debug logging is on (dev server, localStorage
 * `ov_debug` = '1', `?ov_debug=1` in the URL, or window.ovSetDebug(true) in
 * the browser console). Warnings, errors and console.info always reach the
 * console. Plain console.log lines stay in the in-memory buffer as
 * breadcrumbs for the log upload, except the per-rally debug traces
 * ([PERF...], [DEBUG], [SET_END_DEBUG], [Snapshot], [LiveState]
 * Syncing/Synced) and console.debug, which are dropped unless debug logging
 * is on.
 *
 * Log upload: every buffer entry carries a sequence number that keeps growing
 * across reloads (taken from the clock). uploadLogsToCloud sends only the
 * entries after the last successful upload (cursor in localStorage), as a new
 * chunk file logs/<game folder>/logs_<utc>_<seq>.txt: nothing already up there
 * is downloaded or sent again, and no file grows towards the storage cap. The
 * every-action backup sends logs at most once a minute; set end, match end,
 * coin toss and match creation send at once. Entries not uploaded yet are
 * kept in localStorage when the page is hidden or closed and come back at the
 * next start, for the same account only (sign-out and account deletion drop
 * them). Nothing is sent without a stored session.
 *
 * The upload cursor in memory is this tab's own: a second scorer tab's lines
 * are not skipped because another tab uploaded later ones. The buffer holds
 * MAX_BUFFER_SIZE lines; the every-action backup uploads early once
 * EARLY_UPLOAD_UNSENT lines wait, and lines evicted before they were sent are
 * counted in a "[logger] N lines dropped" line at the top of the next chunk.
 */

import { apiStorage, AUTH_TOKEN_STORAGE_KEY } from '../lib/apiClient'

// In-memory log buffer
let logBuffer = []
const MAX_BUFFER_SIZE = 1000

// Last backup tracking to avoid duplicate uploads
let lastBackupTime = 0
let isBackupInProgress = false

// ── Debug flag ──────────────────────────────────────────────────────────────

export const DEBUG_STORAGE_KEY = 'ov_debug'

let debugOverride = null // set by setDebugLogging / tests
let debugEnabled = false // cached: read on every console call

function readDebugFlag() {
  if (debugOverride !== null) return debugOverride
  try {
    if (import.meta.env?.DEV) return true
  } catch { /* no import.meta.env */ }
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(DEBUG_STORAGE_KEY) === '1') return true
  } catch { /* storage blocked */ }
  try {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location?.search || '').get(DEBUG_STORAGE_KEY) === '1') return true
  } catch { /* no location */ }
  return false
}

/** Is debug logging on (console.log/debug shown, debug traces kept)? */
export function isDebugLoggingEnabled() {
  return debugEnabled
}

/**
 * Turn debug logging on or off for this device (kept in localStorage).
 * Pass null to drop the override and go back to the dev / storage / URL rule.
 * @param {boolean|null} on
 * @param {{persist?: boolean}} [opts]
 * @returns {boolean} whether debug logging is on now
 */
export function setDebugLogging(on, { persist = true } = {}) {
  debugOverride = on === null || on === undefined ? null : !!on
  if (persist && debugOverride !== null) {
    try {
      if (debugOverride) localStorage.setItem(DEBUG_STORAGE_KEY, '1')
      else localStorage.removeItem(DEBUG_STORAGE_KEY)
    } catch { /* storage blocked */ }
  }
  debugEnabled = readDebugFlag()
  return debugEnabled
}

// Per-rally traces of the scoreboard: useful while debugging, noise otherwise
const DEBUG_ONLY_PREFIX = /^\[(PERF(:[\w-]+)?|DEBUG|SET_END_DEBUG|Snapshot|ensureActiveSet)\]/
const DEBUG_ONLY_LIVESTATE = /^\[LiveState\] (Syncing|Synced)\b/

/** A debug-only trace (first console argument): dropped unless debug logging is on. */
export function isDebugOnlyMessage(first) {
  return typeof first === 'string' && (DEBUG_ONLY_PREFIX.test(first) || DEBUG_ONLY_LIVESTATE.test(first))
}

// ── Buffer ──────────────────────────────────────────────────────────────────

// Grows across reloads: microseconds of the clock, or one more than the last
let lastSeq = 0
function nextSeq(now = Date.now()) {
  // First entry of this page load: never at or below what was uploaded before
  if (lastSeq === 0) lastSeq = readCursor()
  lastSeq = Math.max(lastSeq + 1, now * 1000)
  return lastSeq
}

// Original console methods
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console)
}

/**
 * Format a log entry
 */
function formatLogEntry(level, args) {
  const now = Date.now()
  const timestamp = new Date(now).toISOString()
  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    }
    return String(arg)
  }).join(' ')

  return { seq: nextSeq(now), timestamp, level, message }
}

/**
 * Add entry to buffer
 */
function addToBuffer(entry) {
  logBuffer.push(entry)
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    const evicted = logBuffer.length - MAX_BUFFER_SIZE
    const cursor = readCursor()
    for (let i = 0; i < evicted; i++) if (logBuffer[i].seq > cursor) droppedUnsent++
    logBuffer = logBuffer.slice(-MAX_BUFFER_SIZE)
  }
}

/**
 * Record one console call. initLogger routes console.* here.
 * @param {'log'|'info'|'warn'|'error'|'debug'} level
 * @param {unknown[]} args
 * @param {Record<string, Function>} [out] where to echo (the real console)
 */
export function captureConsole(level, args, out = originalConsole) {
  if (!debugEnabled && (level === 'log' || level === 'debug')) {
    // Not echoed. console.debug and the per-rally traces are not kept either.
    if (level === 'debug' || isDebugOnlyMessage(args[0])) return
    addToBuffer(formatLogEntry(level, args))
    return
  }
  addToBuffer(formatLogEntry(level, args))
  out[level](...args)
}

let pageListenersInstalled = false

/**
 * Intercept console methods
 */
export function initLogger() {
  debugEnabled = readDebugFlag()
  restorePendingLogs()

  console.log = (...args) => captureConsole('log', args)
  console.warn = (...args) => captureConsole('warn', args)
  console.error = (...args) => captureConsole('error', args)
  console.info = (...args) => captureConsole('info', args)
  console.debug = (...args) => captureConsole('debug', args)

  if (typeof window !== 'undefined' && !pageListenersInstalled) {
    pageListenersInstalled = true
    // Debug output on or off from the browser console (kept on this device)
    window.ovSetDebug = (on = true) => setDebugLogging(on)
    // Lines not uploaded yet survive a reload or a closed tab
    window.addEventListener('pagehide', persistPendingLogs)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistPendingLogs()
    })
    window.addEventListener('storage', (e) => {
      if (e.key === DEBUG_STORAGE_KEY) debugEnabled = readDebugFlag()
    })
  }

  console.log('[Logger] Initialized - capturing console output')
}

/**
 * Get all captured logs
 */
export function getLogs() {
  return [...logBuffer]
}

/**
 * Clear log buffer
 */
export function clearLogs() {
  logBuffer = []
}

/**
 * Export logs as string
 */
export function exportLogsAsText() {
  return logBuffer.map(entry =>
    `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`
  ).join('\n')
}

/**
 * Download logs as file
 */
export function downloadLogs(matchId = null) {
  const text = exportLogsAsText()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = matchId
    ? `logs_match_${matchId}_${timestamp}.txt`
    : `logs_${timestamp}.txt`

  const blob = new Blob([text], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)

  return filename
}

// ── Log upload ──────────────────────────────────────────────────────────────

/** localStorage: seq of the last entry uploaded (any game folder). */
export const LOG_CURSOR_KEY = 'ov_log_upload_cursor'
/** localStorage: entries not uploaded yet, saved when the page is hidden/closed. */
export const LOG_PENDING_KEY = 'ov_log_pending'
/** The every-action backup sends logs at most this often (set/match end send at once). */
export const LOG_UPLOAD_MIN_INTERVAL_MS = 60 * 1000
/** One chunk stays well under the 5 MiB storage cap; the oldest lines are cut first. */
export const MAX_LOG_CHUNK_BYTES = 1024 * 1024
/** The every-action backup uploads at once (no 60 s wait) when this many lines wait. */
export const EARLY_UPLOAD_UNSENT = 600
const MAX_PENDING_ENTRIES = 500
const MAX_PENDING_CHARS = 512 * 1024

let memoryCursor = 0
let cursorLoaded = false
let droppedUnsent = 0 // unsent lines evicted from the buffer since the last upload
let lastLogUploadAt = 0
let logUploadInFlight = false
let queuedLogUpload = null

/** Is a session stored on this device (unexpired)? Cloud storage needs one. */
export function hasStoredSession() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) : null
    if (!raw) return false
    const session = JSON.parse(raw)
    if (!session?.access_token) return false
    if (session.expires_at && Date.now() / 1000 > session.expires_at) return false
    return true
  } catch {
    return false
  }
}

/** The signed-in user's id from the stored session, or null. */
function storedSessionUserId() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) : null
    const session = raw ? JSON.parse(raw) : null
    return session?.user?.id ?? null
  } catch {
    return null
  }
}

function readStoredCursor() {
  try {
    const stored = Number(localStorage.getItem(LOG_CURSOR_KEY))
    return Number.isFinite(stored) ? stored : 0
  } catch {
    return 0 // storage blocked: memory only
  }
}

// This tab's cursor: the stored one once at start, then only its own uploads
function readCursor() {
  if (!cursorLoaded) {
    cursorLoaded = true
    memoryCursor = Math.max(memoryCursor, readStoredCursor())
  }
  return memoryCursor
}

function writeCursor(seq) {
  readCursor()
  if (seq > memoryCursor) memoryCursor = seq
  // Never move the shared copy back (another tab may have uploaded later lines)
  const stored = Math.max(readStoredCursor(), memoryCursor)
  try { localStorage.setItem(LOG_CURSOR_KEY, String(stored)) } catch { /* memory only */ }
}

/** Entries the cloud does not have yet (after this tab's upload cursor). */
export function getUnsentLogs() {
  const cursor = readCursor()
  return logBuffer.filter(e => e.seq > cursor)
}

function readPending() {
  const raw = localStorage.getItem(LOG_PENDING_KEY)
  if (!raw) return null
  const saved = JSON.parse(raw)
  if (Array.isArray(saved)) return { uid: null, entries: saved } // untagged (older build)
  if (saved && Array.isArray(saved.entries)) return { uid: saved.uid ?? null, entries: saved.entries }
  return null
}

/**
 * Keep the entries not uploaded yet for the next start of the app (pagehide,
 * tab hidden), tagged with the signed-in account. Lines another scorer tab of
 * the same account saved are merged, not overwritten. Capped; the newest
 * entries win.
 */
export function persistPendingLogs() {
  try {
    const uid = storedSessionUserId()
    let previous = []
    try {
      const saved = readPending()
      if (saved && saved.uid === uid) previous = saved.entries
    } catch { /* unreadable: overwrite */ }
    const bySeq = new Map()
    for (const e of [...previous, ...getUnsentLogs()]) {
      if (e && Number.isFinite(e.seq) && typeof e.message === 'string') bySeq.set(e.seq, e)
    }
    const pending = [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_PENDING_ENTRIES)
    let chars = 0
    let from = pending.length
    while (from > 0 && chars + pending[from - 1].message.length <= MAX_PENDING_CHARS) {
      from--
      chars += pending[from].message.length
    }
    const kept = pending.slice(from)
    if (kept.length === 0) localStorage.removeItem(LOG_PENDING_KEY)
    else localStorage.setItem(LOG_PENDING_KEY, JSON.stringify({ uid, entries: kept }))
  } catch { /* storage full or blocked */ }
}

/** Remove uploaded entries from the saved pending lines (this tab saved them earlier). */
function prunePending(uploaded) {
  try {
    const saved = readPending()
    if (!saved) return
    const seqs = new Set(uploaded.map(e => e.seq))
    const left = saved.entries.filter(e => !seqs.has(e?.seq))
    if (left.length === saved.entries.length) return
    if (left.length === 0) localStorage.removeItem(LOG_PENDING_KEY)
    else localStorage.setItem(LOG_PENDING_KEY, JSON.stringify({ uid: saved.uid, entries: left }))
  } catch { /* storage blocked */ }
}

/**
 * Forget every line not uploaded yet (saved and in memory): sign-out and
 * account deletion, so the next account on this device never uploads them.
 */
export function discardUnsentLogs() {
  try { localStorage.removeItem(LOG_PENDING_KEY) } catch { /* storage blocked */ }
  const last = Math.max(lastSeq, logBuffer.length > 0 ? logBuffer[logBuffer.length - 1].seq : 0)
  if (last > 0) writeCursor(last)
  droppedUnsent = 0
}

/**
 * Put the entries saved by persistPendingLogs back into the buffer, only when
 * the same account (or none) is signed in now. Not filtered by the shared
 * cursor: another scorer tab may have uploaded later lines; an upload removes
 * its lines from the saved copy instead (prunePending).
 * @returns {number} how many came back
 */
export function restorePendingLogs() {
  try {
    const saved = readPending()
    localStorage.removeItem(LOG_PENDING_KEY)
    if (!saved || saved.uid !== storedSessionUserId()) return 0
    const have = new Set(logBuffer.map(e => e.seq))
    const restored = saved.entries.filter(e =>
      e && Number.isFinite(e.seq) && !have.has(e.seq) && typeof e.message === 'string')
    if (restored.length === 0) return 0
    for (const e of restored) if (e.seq > lastSeq) lastSeq = e.seq
    // This tab sends them, even below the shared cursor (another tab's uploads)
    const firstRestored = Math.min(...restored.map(e => e.seq))
    if (readCursor() >= firstRestored) memoryCursor = firstRestored - 1
    logBuffer = [...restored, ...logBuffer].sort((a, b) => a.seq - b.seq).slice(-MAX_BUFFER_SIZE)
    return restored.length
  } catch {
    return 0
  }
}

function formatEntries(entries) {
  return entries.map(entry =>
    `[${entry.timestamp}] [${String(entry.level).toUpperCase()}] ${entry.message}`
  ).join('\n')
}

const utf8Length = (text) => new TextEncoder().encode(text).length

/** Text of one upload chunk, cut from the oldest lines down to maxBytes. */
export function buildLogChunk(entries, maxBytes = MAX_LOG_CHUNK_BYTES) {
  const text = formatEntries(entries)
  // A UTF-8 character is at most 4 bytes (3 per UTF-16 unit)
  if (text.length * 3 <= maxBytes || utf8Length(text) <= maxBytes) return text
  let kept = entries
  let body = text
  while (kept.length > 1 && utf8Length(body) > maxBytes - 128) {
    kept = kept.slice(Math.ceil(kept.length / 10))
    body = formatEntries(kept)
  }
  return `[logger] ${entries.length - kept.length} older lines left out (chunk size cap)\n${body}`
}

// 4xx other than 401 / 408 / 429: sending the same chunk again cannot succeed
function isPermanentUploadError(error) {
  const status = error?.status ?? 0
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429
}

// yyyymmdd_hhmmss (UTC)
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)

/**
 * Upload the log lines added since the last successful upload, as a new
 * chunk file in the game's folder. Without a session, or with nothing new,
 * nothing is sent; the lines wait for the next upload.
 * @param {string|null} matchId - Match ID for organizing logs
 * @param {string|number|null} gameNumber - Game number for human-readable folder names
 * @param {{minIntervalMs?: number}} [options] - skip when the last upload is more recent
 * @returns {Promise<string|null>} the uploaded path, or null
 */
export async function uploadLogsToCloud(matchId = null, gameNumber = null, { minIntervalMs = 0 } = {}) {
  if (!hasStoredSession()) return null
  if (logUploadInFlight) {
    // An immediate upload (set/match end) runs right after the one in flight
    if (!minIntervalMs) queuedLogUpload = { matchId, gameNumber }
    return null
  }
  const now = Date.now()
  if (minIntervalMs > 0 && now - lastLogUploadAt < minIntervalMs) return null

  const entries = getUnsentLogs()
  if (entries.length === 0) return null
  const lastEntrySeq = entries[entries.length - 1].seq
  const dropped = droppedUnsent
  const chunk = buildLogChunk(entries)
  const body = dropped > 0 ? `[logger] ${dropped} lines dropped (buffer full before upload)\n${chunk}` : chunk

  // Use gameNumber if available for human-readable paths, fall back to matchId
  const folderName = gameNumber ? `game_${gameNumber}` : (matchId ? `match_${matchId}` : 'general')
  const filename = `logs/${folderName}/logs_${utcStamp(now)}_${lastEntrySeq.toString(36)}.txt`

  logUploadInFlight = true
  lastLogUploadAt = now
  try {
    const { data, error } = await apiStorage
      .from('backup')
      .upload(filename, body, {
        contentType: 'text/plain',
        upsert: true // the same chunk sent again replaces itself
      })

    if (error) {
      if (isPermanentUploadError(error)) {
        // Refused for good (size, path): skip these lines rather than retry forever
        writeCursor(lastEntrySeq)
        prunePending(entries)
        droppedUnsent = Math.max(0, droppedUnsent - dropped)
        console.warn('[Logger] Log upload refused, these lines are skipped:', error)
      } else {
        console.warn('[Logger] Log upload failed, will retry:', error)
      }
      return null
    }

    writeCursor(lastEntrySeq)
    prunePending(entries)
    droppedUnsent = Math.max(0, droppedUnsent - dropped)
    return data?.path || filename
  } catch (err) {
    console.warn('[Logger] Error uploading logs:', err)
    return null
  } finally {
    logUploadInFlight = false
    const next = queuedLogUpload
    queuedLogUpload = null
    if (next) uploadLogsToCloud(next.matchId, next.gameNumber).catch(() => {})
  }
}

/** Test hook: forget the buffer, cursor, timers and debug override. */
export function resetLoggerForTests() {
  logBuffer = []
  lastSeq = 0
  memoryCursor = 0
  cursorLoaded = false
  droppedUnsent = 0
  lastLogUploadAt = 0
  logUploadInFlight = false
  queuedLogUpload = null
  lastBackupTime = 0
  isBackupInProgress = false
  debugOverride = null
  debugEnabled = false
}

/**
 * Upload match backup JSON to Supabase storage (sequential, with state summary)
 * Uses game_pin for folder structure so backups can be found by PIN
 */
export async function uploadBackupToCloud(matchId, backupData) {
  // Cloud storage needs an account: nothing to send while signed out
  if (!hasStoredSession()) return null
  const gameN = backupData?.match?.gameN || backupData?.match?.game_n || 1

  // Get set and score info for filename
  let setIndex = 1
  let leftScore = 0
  let rightScore = 0
  if (backupData?.sets?.length > 0) {
    const latestSet = backupData.sets.sort((a, b) => (b.index || 0) - (a.index || 0))[0]
    if (latestSet) {
      setIndex = latestSet.index || 1
      leftScore = latestSet.homePoints || 0
      rightScore = latestSet.awayPoints || 0
    }
  }

  // Generate UTC timestamp in yyyymmdd_hhmmss_ms format for uniqueness
  const now = new Date()
  const utcDate = now.toISOString().slice(0, 10).replace(/-/g, '') // yyyymmdd
  const utcTime = now.toISOString().slice(11, 19).replace(/:/g, '') // hhmmss
  const ms = now.getMilliseconds().toString().padStart(3, '0') // milliseconds

  // Folder structure: backups/backup_g{gameN}/
  const filename = `backups/backup_g${gameN}/backup_g${gameN}_set${setIndex}_scoreleft${leftScore}_scoreright${rightScore}_${utcDate}_${utcTime}_${ms}.json`

  try {
    const { data, error } = await apiStorage
      .from('backup')
      .upload(filename, JSON.stringify(backupData, null, 2), {
        contentType: 'application/json',
        upsert: false // Don't overwrite - create new file
      })

    if (error) {
      // Offline courtside is normal: a warning, not an error per rally
      console.warn('[Logger] Failed to upload backup:', error)
      return null
    }

    console.debug('[Logger] Backup uploaded to cloud:', filename)
    return data?.path || filename
  } catch (err) {
    console.error('[Logger] Error uploading backup:', err)
    return null
  }
}

/**
 * List all cloud backups for a game
 * @param {string} gamePin - Game PIN (unused but kept for API compatibility)
 * @param {number} gameN - Game number
 * @returns {Array} List of backup files with name and metadata
 */
export async function listCloudBackups(gamePin, gameN = 1) {
  try {
    const { data, error } = await apiStorage
      .from('backup')
      .list(`backups/backup_g${gameN}`, {
        sortBy: { column: 'name', order: 'desc' }
      })

    if (error) {
      console.error('[Logger] Failed to list backups:', error)
      return []
    }

    // Parse filenames like "backup_g1_set2_scoreleft15_scoreright12_20250104_153045_123.json"
    return (data || []).map(file => {
      const match = file.name.match(/^backup_g(\d+)_set(\d+)_scoreleft(\d+)_scoreright(\d+)_(\d{8})_(\d{6})_(\d{3})\.json$/)
      if (match) {
        return {
          name: file.name,
          path: `backups/backup_g${gameN}/${file.name}`,
          gameN: parseInt(match[1]),
          setIndex: parseInt(match[2]),
          leftScore: parseInt(match[3]),
          rightScore: parseInt(match[4]),
          date: match[5],
          time: match[6],
          ms: match[7],
          created_at: file.created_at
        }
      }
      return {
        name: file.name,
        path: `backups/backup_g${gameN}/${file.name}`,
        created_at: file.created_at
      }
    })
  } catch (err) {
    console.error('[Logger] Error listing backups:', err)
    return []
  }
}

/**
 * Load a specific backup from cloud storage
 * @param {string} path - Full path to the backup file
 * @returns {Object} Parsed backup data
 */
export async function loadCloudBackup(path) {
  try {
    const { data, error } = await apiStorage
      .from('backup')
      .download(path)

    if (error) {
      console.error('[Logger] Failed to download backup:', error)
      return null
    }

    const text = await data.text()
    return JSON.parse(text)
  } catch (err) {
    console.error('[Logger] Error loading backup:', err)
    return null
  }
}

/**
 * Format backup timestamp for display
 * @param {string} date - Date string in yyyymmdd format
 * @param {string} time - Time string in hhmmss format
 * @param {string} ms - Milliseconds string
 * @returns {string} Formatted datetime string
 */
export function formatBackupTimestamp(date, time, ms) {
  if (!date || !time) return 'Unknown'

  // Parse yyyymmdd
  const year = date.substring(0, 4)
  const month = date.substring(4, 6)
  const day = date.substring(6, 8)

  // Parse hhmmss
  const hours = time.substring(0, 2)
  const minutes = time.substring(2, 4)
  const seconds = time.substring(4, 6)

  // Create date object
  const dateObj = new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}Z`)

  // Format for display (local time)
  return dateObj.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/**
 * Trigger backup on every action (non-blocking, with minimal delay between uploads)
 * @param {number} matchId - Match ID
 * @param {function} getBackupData - Async function that returns backup data
 * @param {string|number|null} gameNumber - Game number for human-readable paths
 */
export async function triggerContinuousBackup(matchId, getBackupData, gameNumber = null) {
  // Skip if backup already in progress, or signed out (the cloud would refuse it)
  if (isBackupInProgress || !hasStoredSession()) {
    return
  }

  // Minimum 2 seconds between backups to avoid flooding
  const now = Date.now()
  if (now - lastBackupTime < 2000) {
    return
  }

  isBackupInProgress = true
  lastBackupTime = now

  try {
    const backupData = await getBackupData()
    if (backupData) {
      // Upload in parallel (non-blocking)
      Promise.all([
        uploadBackupToCloud(matchId, backupData),
        // Logs: only the new lines, at most once a minute (set/match end send
        // at once), or at once when the buffer is filling up
        uploadLogsToCloud(matchId, gameNumber, {
          minIntervalMs: getUnsentLogs().length >= EARLY_UPLOAD_UNSENT ? 0 : LOG_UPLOAD_MIN_INTERVAL_MS
        })
      ]).catch(() => {
        // Silent fail - don't block UI
      })
    }
  } catch (err) {
    // Silent fail
  } finally {
    isBackupInProgress = false
  }
}
