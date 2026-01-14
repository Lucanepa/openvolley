/**
 * Comprehensive Logger - Captures every user interaction and function call
 * Stores logs LOCALLY (IndexedDB + memory) - no real-time API calls
 * Logs can be downloaded from menu or included in end-of-match ZIP
 */

import { db } from '../db/db'

// Configuration
const CONFIG = {
  MAX_BUFFER_SIZE: 50000,     // Max entries in memory (larger since no uploads)
  INDEXEDDB_FLUSH_SIZE: 1000, // Flush to IndexedDB every 1000 entries
  INDEXEDDB_FLUSH_INTERVAL: 30000, // Or every 30 seconds
  LOG_TO_CONSOLE: false,      // Set to true for debugging
  EXPORT_CHUNK_SIZE: 10000    // Entries per export chunk
}

// State
let logBuffer = []
let flushTimer = null
let gameNumber = null
let matchId = null
let sessionId = null
let isInitialized = false
let pendingFlush = false

/**
 * Generate a unique session ID
 */
function generateSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9)
}

/**
 * Generate a unique log entry ID
 */
function generateLogId() {
  return Date.now() + '_' + Math.random().toString(36).substr(2, 9)
}

/**
 * Initialize the comprehensive logger
 * @param {number|null} gameN - Game number for organizing logs
 * @param {string|null} mId - Match ID
 */
export function initComprehensiveLogger(gameN = null, mId = null) {
  if (isInitialized) {
    // Update game/match info if provided
    if (gameN !== null) gameNumber = gameN
    if (mId !== null) matchId = mId
    return
  }

  gameNumber = gameN
  matchId = mId
  sessionId = generateSessionId()
  isInitialized = true

  // Start periodic flush to IndexedDB
  startFlushTimer()

  // Recover any logs from previous session
  recoverFromStorage()

  // Log initialization
  log('system', 'init', 'ComprehensiveLogger', 'initialized', {
    sessionId,
    gameNumber,
    matchId,
    timestamp: new Date().toISOString()
  })

  // Sync on page visibility change (user leaving)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('beforeunload', handleBeforeUnload)

  console.log('[ComprehensiveLogger] Initialized (local-only mode) with session:', sessionId)
}

/**
 * Update the game number (call when match starts)
 * @param {number} gameN - Game number
 * @param {string|null} mId - Match ID
 */
export function setGameContext(gameN, mId = null) {
  gameNumber = gameN
  if (mId) matchId = mId
  log('system', 'config_change', 'ComprehensiveLogger', 'setGameContext', { gameNumber: gameN, matchId: mId })
}

/**
 * Deep sanitize an object for storage in IndexedDB (structured clone compatible)
 */
function sanitizeForStorage(obj) {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj

  // Handle common non-serializable types
  // Check for Event types - use multiple methods since instanceof can fail across frames
  const constructorName = obj.constructor?.name || ''
  if (
    obj instanceof Event ||
    (typeof PointerEvent !== 'undefined' && obj instanceof PointerEvent) ||
    (typeof MouseEvent !== 'undefined' && obj instanceof MouseEvent) ||
    (typeof TouchEvent !== 'undefined' && obj instanceof TouchEvent) ||
    (typeof KeyboardEvent !== 'undefined' && obj instanceof KeyboardEvent) ||
    constructorName.includes('Event') ||
    (obj.type && obj.target && typeof obj.preventDefault === 'function')
  ) {
    return { type: 'Event', eventType: obj.type || constructorName }
  }

  if (obj instanceof Element || obj instanceof Node) {
    return { type: 'Element', tagName: obj.tagName }
  }

  if (typeof obj === 'function') {
    return { type: 'Function', name: obj.name || 'anonymous' }
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForStorage)
  }

  // Handle plain objects
  try {
    const sanitized = {}
    for (const key of Object.keys(obj)) {
      sanitized[key] = sanitizeForStorage(obj[key])
    }
    return sanitized
  } catch (err) {
    return String(obj)
  }
}

/**
 * Core logging function
 * @param {string} category - 'ui' | 'function' | 'state' | 'navigation' | 'error' | 'system'
 * @param {string} type - Specific event type (click, input, handler_call, etc.)
 * @param {string} component - Component name where event occurred
 * @param {string} action - Handler/function name or action description
 * @param {object} payload - Event-specific data
 * @param {object|null} target - DOM target info for UI events
 */
export function log(category, type, component, action, payload = {}, target = null) {
  // Sanitize payload and target before storing to avoid DataCloneError in IndexedDB
  const safePayload = sanitizeForStorage(payload)
  const safeTarget = sanitizeForStorage(target)

  const entry = {
    id: generateLogId(),
    ts: Date.now(),
    timestamp: new Date().toISOString(),
    category,
    type,
    component,
    action,
    payload: safePayload,
    target: safeTarget,
    gameNumber,
    matchId,
    sessionId
  }

  logBuffer.push(entry)

  // Flush to IndexedDB if buffer is large
  if (logBuffer.length >= CONFIG.INDEXEDDB_FLUSH_SIZE && !pendingFlush) {
    flushToIndexedDB()
  }

  // Trim buffer if it exceeds max size (shouldn't happen with regular flushes)
  if (logBuffer.length > CONFIG.MAX_BUFFER_SIZE) {
    logBuffer = logBuffer.slice(-CONFIG.MAX_BUFFER_SIZE)
  }

  // Console output for debugging
  if (CONFIG.LOG_TO_CONSOLE) {
    console.log(`[CLog] ${category}:${type} ${component}.${action}`, payload)
  }

  return entry
}

/**
 * Log a UI event (click, input, etc.)
 */
export function logUI(type, component, action, payload = {}, target = null) {
  return log('ui', type, component, action, payload, target)
}

/**
 * Log a function/handler call
 */
export function logFunction(type, component, fnName, payload = {}) {
  return log('function', type, component, fnName, payload)
}

/**
 * Log a state change
 */
export function logState(component, action, payload = {}) {
  return log('state', 'state_change', component, action, payload)
}

/**
 * Log a navigation event
 */
export function logNavigation(type, component, action, payload = {}) {
  return log('navigation', type, component, action, payload)
}

/**
 * Log an error
 */
export function logError(component, action, error, payload = {}) {
  return log('error', 'error', component, action, {
    ...payload,
    error: {
      message: error?.message || String(error),
      stack: error?.stack,
      name: error?.name
    }
  })
}

/**
 * Start the periodic flush timer
 */
function startFlushTimer() {
  if (flushTimer) return

  flushTimer = setInterval(() => {
    if (logBuffer.length > 0) {
      flushToIndexedDB()
    }
  }, CONFIG.INDEXEDDB_FLUSH_INTERVAL)
}

/**
 * Stop the flush timer
 */
function stopFlushTimer() {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
}

/**
 * Handle visibility change (user switching tabs)
 */
function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    // User is leaving - flush to IndexedDB
    flushToIndexedDB()
  }
}

/**
 * Handle before unload (page close)
 */
function handleBeforeUnload() {
  // Synchronously persist to localStorage before page closes
  persistToLocalStorageSync()
}

/**
 * Flush buffer to IndexedDB
 */
async function flushToIndexedDB() {
  if (logBuffer.length === 0 || pendingFlush) return

  pendingFlush = true
  const entriesToFlush = [...logBuffer]
  logBuffer = []

  try {
    // Check if table exists
    if (!db.interaction_logs) {
      console.warn('[ComprehensiveLogger] interaction_logs table not available')
      // Put entries back
      logBuffer.unshift(...entriesToFlush)
      return
    }

    await db.interaction_logs.bulkAdd(entriesToFlush)

    if (CONFIG.LOG_TO_CONSOLE) {
      console.log(`[ComprehensiveLogger] Flushed ${entriesToFlush.length} entries to IndexedDB`)
    }

  } catch (err) {
    // If DataCloneError, try adding entries one by one, skipping problematic ones
    if (err.name === 'DataCloneError') {
      console.warn('[ComprehensiveLogger] DataCloneError - filtering problematic entries')
      let successCount = 0
      for (const entry of entriesToFlush) {
        try {
          await db.interaction_logs.add(entry)
          successCount++
        } catch (addErr) {
          // Skip this entry - it can't be cloned
          if (CONFIG.LOG_TO_CONSOLE) {
            console.warn('[ComprehensiveLogger] Skipped uncloneable entry:', entry.action)
          }
        }
      }
      if (CONFIG.LOG_TO_CONSOLE) {
        console.log(`[ComprehensiveLogger] Recovered ${successCount}/${entriesToFlush.length} entries`)
      }
    } else {
      console.error('[ComprehensiveLogger] IndexedDB flush failed:', err)
      // Put entries back at front of buffer
      logBuffer.unshift(...entriesToFlush)
    }
  } finally {
    pendingFlush = false
  }
}

/**
 * Synchronous persist to localStorage (for beforeunload)
 */
function persistToLocalStorageSync() {
  if (logBuffer.length === 0) return

  try {
    const key = `comprehensive_logs_emergency_${sessionId}`
    const existing = localStorage.getItem(key)
    const existingLogs = existing ? JSON.parse(existing) : []
    const combined = [...existingLogs, ...logBuffer].slice(-5000) // Keep last 5000
    localStorage.setItem(key, JSON.stringify(combined))
  } catch (err) {
    // Silent fail
  }
}

/**
 * Recover logs from previous session
 */
async function recoverFromStorage() {
  try {
    // Check localStorage emergency backup
    const emergencyKeys = Object.keys(localStorage).filter(k => k.startsWith('comprehensive_logs_emergency_'))
    for (const key of emergencyKeys) {
      try {
        const logs = JSON.parse(localStorage.getItem(key))
        if (Array.isArray(logs) && logs.length > 0) {
          // Store in IndexedDB
          if (db.interaction_logs) {
            await db.interaction_logs.bulkAdd(logs)
            console.log(`[ComprehensiveLogger] Recovered ${logs.length} entries from emergency backup`)
          }
        }
        localStorage.removeItem(key)
      } catch {
        localStorage.removeItem(key)
      }
    }
  } catch (err) {
    console.error('[ComprehensiveLogger] Recovery failed:', err)
  }
}

/**
 * Get all logs for current game/match (from IndexedDB + buffer)
 * @param {number|null} gameN - Game number filter (null for all)
 * @returns {Promise<Array>} All log entries
 */
export async function getAllLogs(gameN = null) {
  const filterGame = gameN ?? gameNumber

  try {
    let indexedDBLogs = []

    if (db.interaction_logs) {
      if (filterGame !== null) {
        indexedDBLogs = await db.interaction_logs
          .where('gameNumber')
          .equals(filterGame)
          .toArray()
      } else {
        indexedDBLogs = await db.interaction_logs.toArray()
      }
    }

    // Combine with current buffer
    const bufferLogs = filterGame !== null
      ? logBuffer.filter(e => e.gameNumber === filterGame)
      : [...logBuffer]

    // Merge and sort by timestamp
    const allLogs = [...indexedDBLogs, ...bufferLogs]
    allLogs.sort((a, b) => a.ts - b.ts)

    return allLogs

  } catch (err) {
    console.error('[ComprehensiveLogger] Error getting logs:', err)
    return [...logBuffer]
  }
}

/**
 * Get log count
 * @param {number|null} gameN - Game number filter
 */
export async function getLogCount(gameN = null) {
  const filterGame = gameN ?? gameNumber

  try {
    let indexedDBCount = 0

    if (db.interaction_logs) {
      if (filterGame !== null) {
        indexedDBCount = await db.interaction_logs
          .where('gameNumber')
          .equals(filterGame)
          .count()
      } else {
        indexedDBCount = await db.interaction_logs.count()
      }
    }

    const bufferCount = filterGame !== null
      ? logBuffer.filter(e => e.gameNumber === filterGame).length
      : logBuffer.length

    return indexedDBCount + bufferCount

  } catch (err) {
    return logBuffer.length
  }
}

/**
 * Export logs as NDJSON string (for download or ZIP inclusion)
 * @param {number|null} gameN - Game number filter
 * @returns {Promise<string>} NDJSON formatted logs
 */
export async function exportLogsAsNDJSON(gameN = null) {
  const logs = await getAllLogs(gameN)
  return logs.map(entry => JSON.stringify(entry)).join('\n')
}

/**
 * Export logs as formatted JSON string
 * @param {number|null} gameN - Game number filter
 * @returns {Promise<string>} Formatted JSON
 */
export async function exportLogsAsJSON(gameN = null) {
  const logs = await getAllLogs(gameN)
  return JSON.stringify({
    exportDate: new Date().toISOString(),
    gameNumber: gameN ?? gameNumber,
    matchId,
    sessionId,
    totalLogs: logs.length,
    logs
  }, null, 2)
}

/**
 * Export logs as Blob (for file download)
 * @param {number|null} gameN - Game number filter
 * @param {string} format - 'ndjson' or 'json'
 * @returns {Promise<Blob>} Blob containing logs
 */
export async function exportLogsAsBlob(gameN = null, format = 'ndjson') {
  const content = format === 'json'
    ? await exportLogsAsJSON(gameN)
    : await exportLogsAsNDJSON(gameN)

  const mimeType = format === 'json'
    ? 'application/json'
    : 'application/x-ndjson'

  return new Blob([content], { type: mimeType })
}

/**
 * Download logs as file
 * @param {number|null} gameN - Game number filter
 * @param {string} format - 'ndjson' or 'json'
 */
export async function downloadLogs(gameN = null, format = 'ndjson') {
  try {
    const blob = await exportLogsAsBlob(gameN, format)
    const extension = format === 'json' ? 'json' : 'ndjson'
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const gameStr = (gameN ?? gameNumber) ? `_game${gameN ?? gameNumber}` : ''
    const filename = `comprehensive_logs${gameStr}_${timestamp}.${extension}`

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    console.log(`[ComprehensiveLogger] Downloaded logs: ${filename}`)
    return filename

  } catch (err) {
    console.error('[ComprehensiveLogger] Download failed:', err)
    throw err
  }
}

/**
 * Get logs summary (for display in menu)
 */
export async function getLogsSummary(gameN = null) {
  const count = await getLogCount(gameN)
  const logs = await getAllLogs(gameN)

  const categories = {}
  for (const entry of logs) {
    categories[entry.category] = (categories[entry.category] || 0) + 1
  }

  return {
    totalCount: count,
    categories,
    oldestEntry: logs[0]?.timestamp,
    newestEntry: logs[logs.length - 1]?.timestamp,
    sessionId,
    gameNumber: gameN ?? gameNumber
  }
}

/**
 * Clear logs for a specific game or all logs
 * @param {number|null} gameN - Game number to clear (null for all)
 */
export async function clearLogs(gameN = null) {
  try {
    if (db.interaction_logs) {
      if (gameN !== null) {
        await db.interaction_logs
          .where('gameNumber')
          .equals(gameN)
          .delete()
      } else {
        await db.interaction_logs.clear()
      }
    }

    // Clear buffer
    if (gameN !== null) {
      logBuffer = logBuffer.filter(e => e.gameNumber !== gameN)
    } else {
      logBuffer = []
    }

    console.log(`[ComprehensiveLogger] Cleared logs${gameN !== null ? ` for game ${gameN}` : ''}`)

  } catch (err) {
    console.error('[ComprehensiveLogger] Clear failed:', err)
  }
}

/**
 * Cleanup and shutdown
 */
export function shutdownLogger() {
  // Flush remaining logs
  flushToIndexedDB()

  // Stop timer
  stopFlushTimer()

  // Remove event listeners
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  window.removeEventListener('beforeunload', handleBeforeUnload)

  isInitialized = false
  console.log('[ComprehensiveLogger] Shutdown complete')
}

/**
 * Get current buffer contents (for debugging)
 */
export function getBufferedLogs() {
  return [...logBuffer]
}

/**
 * Get buffer size
 */
export function getBufferSize() {
  return logBuffer.length
}

/**
 * Check if logger is initialized
 */
export function isLoggerInitialized() {
  return isInitialized
}

/**
 * Get current session ID
 */
export function getSessionId() {
  return sessionId
}

/**
 * Create a throttled version of a function
 * @param {Function} fn - Function to throttle
 * @param {number} delay - Throttle delay in ms
 */
export function throttle(fn, delay) {
  let lastCall = 0
  let lastResult = null

  return function throttled(...args) {
    const now = Date.now()
    if (now - lastCall >= delay) {
      lastCall = now
      lastResult = fn.apply(this, args)
    }
    return lastResult
  }
}

/**
 * Create a debounced version of a function
 * @param {Function} fn - Function to debounce
 * @param {number} delay - Debounce delay in ms
 */
export function debounce(fn, delay) {
  let timeoutId = null

  return function debounced(...args) {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    timeoutId = setTimeout(() => {
      fn.apply(this, args)
      timeoutId = null
    }, delay)
  }
}

// Export config for external access
export { CONFIG as LOGGER_CONFIG }
