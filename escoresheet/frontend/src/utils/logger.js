/**
 * Logger - Captures console logs and backs up to Supabase storage
 */

import { supabase } from '../lib/supabaseClient'

// In-memory log buffer
let logBuffer = []
const MAX_BUFFER_SIZE = 1000

// Last backup tracking to avoid duplicate uploads
let lastBackupTime = 0
let isBackupInProgress = false
let backupSequence = 0 // Sequential counter for backups

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
      .from('backup')
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
 * Upload match backup JSON to Supabase storage (sequential, with state summary)
 */
export async function uploadBackupToCloud(matchId, backupData) {
  if (!supabase) {
    console.warn('[Logger] Supabase not configured - cannot upload backup')
    return null
  }

  // Increment sequence
  backupSequence++

  // Build state summary for filename (e.g., "set2_15-12")
  let stateSummary = ''
  if (backupData?.sets?.length > 0) {
    const latestSet = backupData.sets.sort((a, b) => (b.index || 0) - (a.index || 0))[0]
    if (latestSet) {
      stateSummary = `_set${latestSet.index || 1}_${latestSet.homePoints || 0}-${latestSet.awayPoints || 0}`
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const seqStr = String(backupSequence).padStart(5, '0')
  const filename = `backups/match_${matchId}/${seqStr}${stateSummary}_${timestamp}.json`

  try {
    const { data, error } = await supabase.storage
      .from('backup')
      .upload(filename, JSON.stringify(backupData, null, 2), {
        contentType: 'application/json',
        upsert: false // Don't overwrite - create new file
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

/**
 * List all cloud backups for a match
 * @param {number} matchId - Match ID
 * @returns {Array} List of backup files with name and metadata
 */
export async function listCloudBackups(matchId) {
  if (!supabase) {
    console.warn('[Logger] Supabase not configured')
    return []
  }

  try {
    const { data, error } = await supabase.storage
      .from('backup')
      .list(`backups/match_${matchId}`, {
        sortBy: { column: 'name', order: 'desc' }
      })

    if (error) {
      console.error('[Logger] Failed to list backups:', error)
      return []
    }

    // Parse filenames to extract state info
    return (data || []).map(file => {
      // Parse filename like "00015_set2_15-12_2025-12-21T11-00-00-000Z.json"
      const match = file.name.match(/^(\d+)_set(\d+)_(\d+)-(\d+)_(.+)\.json$/)
      if (match) {
        return {
          name: file.name,
          path: `backups/match_${matchId}/${file.name}`,
          sequence: parseInt(match[1]),
          setIndex: parseInt(match[2]),
          homePoints: parseInt(match[3]),
          awayPoints: parseInt(match[4]),
          timestamp: match[5].replace(/-/g, ':').replace('T', ' ').replace('Z', ''),
          created_at: file.created_at
        }
      }
      return {
        name: file.name,
        path: `backups/match_${matchId}/${file.name}`,
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
  if (!supabase) {
    console.warn('[Logger] Supabase not configured')
    return null
  }

  try {
    const { data, error } = await supabase.storage
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
 * Trigger backup on every action (non-blocking, with minimal delay between uploads)
 * @param {number} matchId - Match ID
 * @param {function} getBackupData - Async function that returns backup data
 */
export async function triggerContinuousBackup(matchId, getBackupData) {
  // Skip if backup already in progress
  if (isBackupInProgress) {
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
        uploadLogsToCloud(matchId)
      ]).catch(err => {
        // Silent fail - don't block UI
      })
    }
  } catch (err) {
    // Silent fail
  } finally {
    isBackupInProgress = false
  }
}
