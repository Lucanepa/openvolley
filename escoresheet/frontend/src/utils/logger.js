/**
 * Logger - Captures console logs and backs up to Supabase storage
 */

import { supabase } from '../lib/supabaseClient'

// In-memory log buffer
let logBuffer = []
const MAX_BUFFER_SIZE = 1000

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
  const timestamp = new Date().toISOString()
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

  return { timestamp, level, message }
}

/**
 * Add entry to buffer
 */
function addToBuffer(entry) {
  logBuffer.push(entry)
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer = logBuffer.slice(-MAX_BUFFER_SIZE)
  }
}

/**
 * Intercept console methods
 */
export function initLogger() {
  console.log = (...args) => {
    addToBuffer(formatLogEntry('log', args))
    originalConsole.log(...args)
  }

  console.warn = (...args) => {
    addToBuffer(formatLogEntry('warn', args))
    originalConsole.warn(...args)
  }

  console.error = (...args) => {
    addToBuffer(formatLogEntry('error', args))
    originalConsole.error(...args)
  }

  console.info = (...args) => {
    addToBuffer(formatLogEntry('info', args))
    originalConsole.info(...args)
  }

  console.debug = (...args) => {
    addToBuffer(formatLogEntry('debug', args))
    originalConsole.debug(...args)
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

/**
 * Upload logs to Supabase storage
 */
export async function uploadLogsToCloud(matchId = null) {
  if (!supabase) {
    console.warn('[Logger] Supabase not configured - cannot upload logs')
    return null
  }

  const text = exportLogsAsText()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = matchId
    ? `logs/match_${matchId}/${timestamp}.txt`
    : `logs/general/${timestamp}.txt`

  try {
    const { data, error } = await supabase.storage
      .from('backups')
      .upload(filename, text, {
        contentType: 'text/plain',
        upsert: true
      })

    if (error) {
      console.error('[Logger] Failed to upload logs:', error)
      return null
    }

    console.log('[Logger] Logs uploaded to cloud:', filename)
    return data?.path || filename
  } catch (err) {
    console.error('[Logger] Error uploading logs:', err)
    return null
  }
}

/**
 * Upload match backup JSON to Supabase storage
 */
export async function uploadBackupToCloud(matchId, backupData) {
  if (!supabase) {
    console.warn('[Logger] Supabase not configured - cannot upload backup')
    return null
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `backups/match_${matchId}/${timestamp}.json`

  try {
    const { data, error } = await supabase.storage
      .from('backups')
      .upload(filename, JSON.stringify(backupData, null, 2), {
        contentType: 'application/json',
        upsert: true
      })

    if (error) {
      console.error('[Logger] Failed to upload backup:', error)
      return null
    }

    console.log('[Logger] Backup uploaded to cloud:', filename)
    return data?.path || filename
  } catch (err) {
    console.error('[Logger] Error uploading backup:', err)
    return null
  }
}
