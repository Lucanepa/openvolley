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
 * Upload logs to Supabase storage - appends to a single log file per game
 * @param {string|null} matchId - Match ID for organizing logs
 * @param {string|number|null} gameNumber - Game number for human-readable folder names
 */
export async function uploadLogsToCloud(matchId = null, gameNumber = null) {
  if (!supabase) {
    console.warn('[Logger] Supabase not configured - cannot upload logs')
    return null
  }

  const newLogs = exportLogsAsText()
  // Use gameNumber if available for human-readable paths, fall back to matchId
  const folderName = gameNumber ? `game_${gameNumber}` : (matchId ? `match_${matchId}` : 'general')
  const filename = `logs/${folderName}/logs.txt` // Single file name, not timestamped

  try {
    // Try to download existing log file
    let existingLogs = ''
    const { data: existingData, error: downloadError } = await supabase.storage
      .from('backup')
      .download(filename)

    if (!downloadError && existingData) {
      // File exists, read its contents
      existingLogs = await existingData.text()
    }

    // Append new logs to existing logs
    const combinedLogs = existingLogs
      ? `${existingLogs}\n${newLogs}`
      : newLogs

    // Upload combined logs (will replace the file)
    const { data, error } = await supabase.storage
      .from('backup')
      .upload(filename, combinedLogs, {
        contentType: 'text/plain',
        upsert: true // Replace existing file
      })

    if (error) {
      console.error('[Logger] Failed to upload logs:', error)
      return null
    }

    console.log('[Logger] Logs appended to cloud:', filename)
    return data?.path || filename
  } catch (err) {
    console.error('[Logger] Error uploading logs:', err)
    return null
  }
}

/**
 * Upload match backup JSON to Supabase storage (sequential, with state summary)
 * Uses game_pin for folder structure so backups can be found by PIN
 */
export async function uploadBackupToCloud(matchId, backupData) {
  if (!supabase) {
    console.warn('[Logger] Supabase not configured - cannot upload backup')
    return null
  }

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
 * List all cloud backups for a game
 * @param {string} gamePin - Game PIN (unused but kept for API compatibility)
 * @param {number} gameN - Game number
 * @returns {Array} List of backup files with name and metadata
 */
export async function listCloudBackups(gamePin, gameN = 1) {
  if (!supabase) {
    console.warn('[Logger] Supabase not configured')
    return []
  }

  try {
    const { data, error } = await supabase.storage
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
        uploadLogsToCloud(matchId, gameNumber)
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
