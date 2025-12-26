/**
 * Backup Manager - Handles automatic backup to file system
 *
 * Chrome/Edge: Uses File System Access API for direct folder writes
 * Safari/Firefox: Falls back to periodic auto-downloads
 */

import { db } from '../db/db'
import { supabase } from '../lib/supabaseClient'
import { sanitizeSimple } from './stringUtils'

// IndexedDB key for storing file system directory handle
const BACKUP_DB_NAME = 'escoresheet_backup'
const BACKUP_DIR_HANDLE_KEY = 'backup_directory_handle'

/**
 * Check if File System Access API is available
 */
export function isFileSystemAccessSupported() {
  return 'showDirectoryPicker' in window
}

/**
 * Store directory handle in IndexedDB for persistence
 */
export async function storeDirectoryHandle(handle) {
  return new Promise((resolve, reject) => {
    const dbRequest = indexedDB.open(BACKUP_DB_NAME, 1)

    dbRequest.onerror = () => reject(dbRequest.error)
    dbRequest.onupgradeneeded = (event) => {
      const database = event.target.result
      if (!database.objectStoreNames.contains('handles')) {
        database.createObjectStore('handles')
      }
    }
    dbRequest.onsuccess = () => {
      const database = dbRequest.result
      const tx = database.transaction('handles', 'readwrite')
      const store = tx.objectStore('handles')
      store.put(handle, BACKUP_DIR_HANDLE_KEY)
      tx.oncomplete = () => {
        database.close()
        resolve()
      }
      tx.onerror = () => {
        database.close()
        reject(tx.error)
      }
    }
  })
}

/**
 * Retrieve stored directory handle from IndexedDB
 */
export async function getStoredDirectoryHandle() {
  return new Promise((resolve, reject) => {
    const dbRequest = indexedDB.open(BACKUP_DB_NAME, 1)

    dbRequest.onerror = () => reject(dbRequest.error)
    dbRequest.onupgradeneeded = (event) => {
      const database = event.target.result
      if (!database.objectStoreNames.contains('handles')) {
        database.createObjectStore('handles')
      }
    }
    dbRequest.onsuccess = () => {
      const database = dbRequest.result
      const tx = database.transaction('handles', 'readonly')
      const store = tx.objectStore('handles')
      const request = store.get(BACKUP_DIR_HANDLE_KEY)
      request.onsuccess = () => {
        database.close()
        resolve(request.result || null)
      }
      request.onerror = () => {
        database.close()
        reject(request.error)
      }
    }
  })
}

/**
 * Clear stored directory handle from IndexedDB
 */
export async function clearStoredDirectoryHandle() {
  return new Promise((resolve, reject) => {
    const dbRequest = indexedDB.open(BACKUP_DB_NAME, 1)

    dbRequest.onerror = () => reject(dbRequest.error)
    dbRequest.onupgradeneeded = (event) => {
      const database = event.target.result
      if (!database.objectStoreNames.contains('handles')) {
        database.createObjectStore('handles')
      }
    }
    dbRequest.onsuccess = () => {
      const database = dbRequest.result
      const tx = database.transaction('handles', 'readwrite')
      const store = tx.objectStore('handles')
      store.delete(BACKUP_DIR_HANDLE_KEY)
      tx.oncomplete = () => {
        database.close()
        resolve()
      }
      tx.onerror = () => {
        database.close()
        reject(tx.error)
      }
    }
  })
}

/**
 * Request permission for directory handle
 */
export async function verifyDirectoryPermission(handle) {
  if (!handle) return false

  try {
    const permission = await handle.queryPermission({ mode: 'readwrite' })
    if (permission === 'granted') return true

    const requestResult = await handle.requestPermission({ mode: 'readwrite' })
    return requestResult === 'granted'
  } catch {
    return false
  }
}

/**
 * Select backup directory using File System Access API
 */
export async function selectBackupDirectory() {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API not supported in this browser')
  }

  const handle = await window.showDirectoryPicker({
    mode: 'readwrite',
    startIn: 'documents'
  })

  await storeDirectoryHandle(handle)
  return handle
}

/**
 * Export a single match with all related data
 */
export async function exportMatchData(matchId) {
  const match = await db.matches.get(matchId)
  if (!match) throw new Error('Match not found')

  // Get related data
  const [homeTeam, awayTeam] = await Promise.all([
    match.homeTeamId ? db.teams.get(match.homeTeamId) : null,
    match.awayTeamId ? db.teams.get(match.awayTeamId) : null
  ])

  const [homePlayers, awayPlayers] = await Promise.all([
    match.homeTeamId ? db.players.where('teamId').equals(match.homeTeamId).toArray() : [],
    match.awayTeamId ? db.players.where('teamId').equals(match.awayTeamId).toArray() : []
  ])

  const sets = await db.sets.where('matchId').equals(matchId).toArray()
  const events = await db.events.where('matchId').equals(matchId).toArray()

  return {
    version: 1, // Schema version for future compatibility
    lastUpdated: new Date().toISOString(),
    match,
    homeTeam,
    awayTeam,
    homePlayers,
    awayPlayers,
    sets,
    events
  }
}

/**
 * Generate backup filename
 */
export function generateBackupFilename(matchId) {
  return `match_${matchId}.json`
}

/**
 * Write match backup to file system (Chrome/Edge)
 */
export async function writeMatchBackup(matchId, directoryHandle) {
  const data = await exportMatchData(matchId)
  const filename = generateBackupFilename(matchId)

  try {
    const fileHandle = await directoryHandle.getFileHandle(filename, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(data, null, 2))
    await writable.close()
    return { success: true, filename }
  } catch (error) {
    console.error('Error writing backup:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Download match backup as file (Safari/Firefox fallback)
 */
export async function downloadMatchBackup(matchId) {
  const data = await exportMatchData(matchId)
  const match = data.match

  // Generate a more descriptive filename for downloads
  const date = new Date().toISOString().split('T')[0]
  const homeName = data.homeTeam?.shortName || data.homeTeam?.name?.substring(0, 10) || 'home'
  const awayName = data.awayTeam?.shortName || data.awayTeam?.name?.substring(0, 10) || 'away'
  const filename = `match_${matchId}_${sanitizeSimple(homeName, 15)}_vs_${sanitizeSimple(awayName, 15)}_${date}.json`

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
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
 * Restore match from JSON backup data
 */
export async function restoreMatchFromJson(jsonData) {
  // Validate schema
  if (!jsonData.version || !jsonData.match) {
    throw new Error('Invalid backup file format')
  }

  const { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events } = jsonData

  let restoredMatchId = null

  // Start transaction
  await db.transaction('rw', db.matches, db.teams, db.players, db.sets, db.events, async () => {
    // Create teams
    let homeTeamId = null
    let awayTeamId = null

    if (homeTeam) {
      // Check if team with same name exists
      const existingHome = await db.teams.where('name').equals(homeTeam.name).first()
      if (existingHome) {
        homeTeamId = existingHome.id
        // Update team data
        await db.teams.update(homeTeamId, {
          ...homeTeam,
          id: homeTeamId,
          updatedAt: new Date().toISOString()
        })
      } else {
        homeTeamId = await db.teams.add({
          ...homeTeam,
          id: undefined, // Let Dexie auto-generate
          createdAt: new Date().toISOString()
        })
      }
    }

    if (awayTeam) {
      const existingAway = await db.teams.where('name').equals(awayTeam.name).first()
      if (existingAway) {
        awayTeamId = existingAway.id
        await db.teams.update(awayTeamId, {
          ...awayTeam,
          id: awayTeamId,
          updatedAt: new Date().toISOString()
        })
      } else {
        awayTeamId = await db.teams.add({
          ...awayTeam,
          id: undefined,
          createdAt: new Date().toISOString()
        })
      }
    }

    // Create match with new ID
    const matchId = await db.matches.add({
      ...match,
      id: undefined, // Let Dexie auto-generate new ID
      homeTeamId,
      awayTeamId,
      restoredFrom: match.id, // Track original ID
      restoredAt: new Date().toISOString()
    })

    restoredMatchId = matchId

    // Delete existing players for these teams and recreate
    if (homeTeamId) {
      await db.players.where('teamId').equals(homeTeamId).delete()
    }
    if (awayTeamId) {
      await db.players.where('teamId').equals(awayTeamId).delete()
    }

    // Create players
    if (homePlayers?.length && homeTeamId) {
      for (const player of homePlayers) {
        await db.players.add({
          ...player,
          id: undefined,
          teamId: homeTeamId
        })
      }
    }

    if (awayPlayers?.length && awayTeamId) {
      for (const player of awayPlayers) {
        await db.players.add({
          ...player,
          id: undefined,
          teamId: awayTeamId
        })
      }
    }

    // Create sets
    if (sets?.length) {
      for (const set of sets) {
        await db.sets.add({
          ...set,
          id: undefined,
          matchId
        })
      }
    }

    // Create events
    if (events?.length) {
      for (const event of events) {
        await db.events.add({
          ...event,
          id: undefined,
          matchId
        })
      }
    }
  })

  return restoredMatchId
}

/**
 * Restore match in place - overwrite existing match with backup data
 * Used for cloud backup restore during active match
 */
export async function restoreMatchInPlace(matchId, jsonData) {
  if (!jsonData.version || !jsonData.match) {
    throw new Error('Invalid backup file format')
  }

  const { match, sets, events } = jsonData

  await db.transaction('rw', db.matches, db.sets, db.events, async () => {
    // Update match data (keep same ID)
    await db.matches.update(matchId, {
      ...match,
      id: matchId,
      restoredAt: new Date().toISOString()
    })

    // Delete existing sets and events for this match
    await db.sets.where('matchId').equals(matchId).delete()
    await db.events.where('matchId').equals(matchId).delete()

    // Recreate sets
    if (sets?.length) {
      for (const set of sets) {
        await db.sets.add({
          ...set,
          id: undefined,
          matchId
        })
      }
    }

    // Recreate events
    if (events?.length) {
      for (const event of events) {
        await db.events.add({
          ...event,
          id: undefined,
          matchId
        })
      }
    }
  })

  return matchId
}

/**
 * Fetch match from Supabase by Game N and Game PIN
 * Uses JSONB columns for team/player data (teams/players tables were dropped)
 */
export async function fetchMatchByPin(gamePin, gameN) {
  if (!supabase) {
    throw new Error('Supabase not configured')
  }

  // Find match by game_n and game_pin
  let query = supabase
    .from('matches')
    .select('*')
    .eq('game_pin', gamePin)

  // If gameN provided, also filter by game_n
  if (gameN) {
    query = query.eq('game_n', parseInt(gameN, 10))
  }

  const { data: matchData, error: matchError } = await query.maybeSingle()

  if (matchError) throw matchError
  if (!matchData) throw new Error('Match not found with this ID and PIN')

  // Fetch sets and events (teams/players are now in JSONB columns)
  const [setsResult, eventsResult] = await Promise.all([
    supabase.from('sets').select('*').eq('match_id', matchData.external_id),
    supabase.from('events').select('*').eq('match_id', matchData.external_id)
  ])

  return {
    match: matchData,
    // JSONB data is already in matchData: home_team, away_team, players_home, players_away, bench_home, bench_away, officials
    sets: setsResult.data || [],
    events: eventsResult.data || []
  }
}

/**
 * Import match data from Supabase to local Dexie
 * Uses JSONB columns for team/player data (teams/players tables were dropped)
 */
export async function importMatchFromSupabase(cloudData) {
  const { match, sets, events } = cloudData

  let importedMatchId = null

  await db.transaction('rw', db.matches, db.teams, db.players, db.sets, db.events, async () => {
    // Extract team data from JSONB columns
    const homeTeamData = match.home_team || {}
    const awayTeamData = match.away_team || {}
    const playersHome = match.players_home || []
    const playersAway = match.players_away || []

    // Create local teams
    let homeTeamId = null
    let awayTeamId = null

    if (homeTeamData.name) {
      const existingHome = await db.teams.where('name').equals(homeTeamData.name).first()
      if (existingHome) {
        homeTeamId = existingHome.id
        await db.teams.update(homeTeamId, {
          shortName: homeTeamData.short_name,
          color: homeTeamData.color,
          updatedAt: new Date().toISOString()
        })
      } else {
        homeTeamId = await db.teams.add({
          name: homeTeamData.name,
          shortName: homeTeamData.short_name,
          color: homeTeamData.color,
          createdAt: new Date().toISOString()
        })
      }
    }

    if (awayTeamData.name) {
      const existingAway = await db.teams.where('name').equals(awayTeamData.name).first()
      if (existingAway) {
        awayTeamId = existingAway.id
        await db.teams.update(awayTeamId, {
          shortName: awayTeamData.short_name,
          color: awayTeamData.color,
          updatedAt: new Date().toISOString()
        })
      } else {
        awayTeamId = await db.teams.add({
          name: awayTeamData.name,
          shortName: awayTeamData.short_name,
          color: awayTeamData.color,
          createdAt: new Date().toISOString()
        })
      }
    }

    // Create match with all JSONB data
    const localMatchId = await db.matches.add({
      homeTeamId,
      awayTeamId,
      status: match.status,
      scheduledAt: match.scheduled_at,
      hall: match.hall,
      city: match.city,
      league: match.league,
      refereePin: match.referee_pin,
      gamePin: match.game_pin,
      gameN: match.game_n,
      test: match.test || false,
      seed_key: match.external_id,
      // JSONB data stored locally
      officials: match.officials || [],
      bench_home: match.bench_home || [],
      bench_away: match.bench_away || [],
      // Signatures
      homeCoachSignature: match.home_coach_signature,
      homeCaptainSignature: match.home_captain_signature,
      awayCoachSignature: match.away_coach_signature,
      awayCaptainSignature: match.away_captain_signature,
      // Coin toss
      coinTossConfirmed: match.coin_toss_confirmed,
      coinTossTeamA: match.coin_toss_team_a,
      coinTossTeamB: match.coin_toss_team_b,
      firstServe: match.first_serve,
      // Match result
      setResults: match.set_results,
      winner: match.winner,
      finalScore: match.final_score,
      // Import metadata
      importedFrom: 'supabase',
      importedAt: new Date().toISOString(),
      createdAt: match.created_at || new Date().toISOString()
    })

    importedMatchId = localMatchId

    // Create players from JSONB arrays
    if (playersHome.length && homeTeamId) {
      for (const p of playersHome) {
        await db.players.add({
          teamId: homeTeamId,
          number: p.number,
          name: `${p.last_name || ''} ${p.first_name || ''}`.trim(),
          firstName: p.first_name,
          lastName: p.last_name,
          dob: p.dob,
          libero: p.libero,
          isCaptain: p.is_captain,
          createdAt: new Date().toISOString()
        })
      }
    }

    if (playersAway.length && awayTeamId) {
      for (const p of playersAway) {
        await db.players.add({
          teamId: awayTeamId,
          number: p.number,
          name: `${p.last_name || ''} ${p.first_name || ''}`.trim(),
          firstName: p.first_name,
          lastName: p.last_name,
          dob: p.dob,
          libero: p.libero,
          isCaptain: p.is_captain,
          createdAt: new Date().toISOString()
        })
      }
    }

    // Create sets
    for (const set of sets) {
      await db.sets.add({
        matchId: localMatchId,
        index: set.index,
        homePoints: set.home_points,
        awayPoints: set.away_points,
        finished: set.finished,
        startTime: set.start_time,
        endTime: set.end_time,
        externalId: set.external_id
      })
    }

    // Create events
    for (const event of events) {
      await db.events.add({
        matchId: localMatchId,
        setIndex: event.set_index,
        type: event.type,
        payload: event.payload,
        ts: event.ts,
        seq: event.seq,
        externalId: event.external_id
      })
    }
  })

  return importedMatchId
}

/**
 * Select a backup file using file picker
 * Returns parsed JSON data or null if cancelled
 */
export async function selectBackupFile() {
  // Try File System Access API first (Chrome/Edge)
  if ('showOpenFilePicker' in window) {
    try {
      const [fileHandle] = await window.showOpenFilePicker({
        types: [{
          description: 'JSON Backup Files',
          accept: { 'application/json': ['.json'] }
        }],
        multiple: false
      })
      const file = await fileHandle.getFile()
      const text = await file.text()
      return JSON.parse(text)
    } catch (error) {
      if (error.name === 'AbortError') {
        return null // User cancelled
      }
      throw error
    }
  }

  // Fallback for Safari/Firefox - use hidden input
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'

    input.onchange = async (e) => {
      const file = e.target.files?.[0]
      if (!file) {
        resolve(null)
        return
      }

      try {
        const text = await file.text()
        const data = JSON.parse(text)
        resolve(data)
      } catch (error) {
        reject(new Error('Invalid JSON file'))
      }
    }

    input.oncancel = () => resolve(null)

    // Safari doesn't fire oncancel, so we use a focus event workaround
    const handleFocus = () => {
      setTimeout(() => {
        if (!input.files?.length) {
          resolve(null)
        }
        window.removeEventListener('focus', handleFocus)
      }, 300)
    }
    window.addEventListener('focus', handleFocus)

    input.click()
  })
}

/**
 * Get backup settings from localStorage
 */
export function getBackupSettings() {
  return {
    autoBackupEnabled: localStorage.getItem('autoBackupEnabled') === 'true',
    backupFrequencyMinutes: parseInt(localStorage.getItem('backupFrequencyMinutes') || '5', 10)
  }
}

/**
 * Save backup settings to localStorage
 */
export function saveBackupSettings(settings) {
  if (settings.autoBackupEnabled !== undefined) {
    localStorage.setItem('autoBackupEnabled', String(settings.autoBackupEnabled))
  }
  if (settings.backupFrequencyMinutes !== undefined) {
    localStorage.setItem('backupFrequencyMinutes', String(settings.backupFrequencyMinutes))
  }
}
