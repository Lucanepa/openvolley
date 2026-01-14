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
 * Generate backup filename with UTC timestamp
 * Format: backup_g[gameN]_set[setN]_scoreleft[left]_scoreright[right]_[yyyymmdd]_[hhmm].json
 */
export function generateBackupFilename(data) {
  const gameN = data?.match?.gameN || data?.match?.game_n || 1

  // Get latest set info
  let setIndex = 1
  let leftScore = 0
  let rightScore = 0
  if (data?.sets?.length > 0) {
    const latestSet = data.sets.sort((a, b) => (b.index || 0) - (a.index || 0))[0]
    if (latestSet) {
      setIndex = latestSet.index || 1
      leftScore = latestSet.homePoints || 0
      rightScore = latestSet.awayPoints || 0
    }
  }

  // Generate UTC timestamp in yyyymmdd_hhmm format
  const now = new Date()
  const utcDate = now.toISOString().slice(0, 10).replace(/-/g, '') // yyyymmdd
  const utcTime = now.toISOString().slice(11, 16).replace(':', '') // hhmm

  return `backup_g${gameN}_set${setIndex}_scoreleft${leftScore}_scoreright${rightScore}_${utcDate}_${utcTime}.json`
}

/**
 * Write match backup to file system (Chrome/Edge)
 */
export async function writeMatchBackup(matchId, directoryHandle) {
  const data = await exportMatchData(matchId)
  const filename = generateBackupFilename(data)

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
  const filename = generateBackupFilename(data)

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
 * WIPE & REPLACE: Clears all local match data, restores from backup, queues Supabase sync
 */
export async function restoreMatchFromJson(jsonData) {
  // Validate schema
  if (!jsonData.version || !jsonData.match) {
    throw new Error('Invalid backup file format')
  }

  const { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events } = jsonData

  // Get external_id for Supabase sync (seed_key in local, external_id in backup)
  const externalId = match.seed_key || match.seedKey || match.external_id
  if (!externalId) {
    console.warn('[Restore] No external_id found - Supabase sync will be skipped')
  }

  let restoredMatchId = null

  // Start transaction - WIPE then RESTORE
  await db.transaction('rw', db.matches, db.teams, db.players, db.sets, db.events, db.sync_queue, async () => {
    // STEP A: WIPE ALL existing match data from IndexedDB
    // (Keep teams/players/referees/scorers as they're reusable)
    console.log('[Restore] Wiping local IndexedDB: events, sets, matches, sync_queue')
    await db.events.clear()
    await db.sets.clear()
    await db.matches.clear()
    await db.sync_queue.clear()

    // STEP B: Create teams (reuse existing or create new)
    let homeTeamId = null
    let awayTeamId = null

    if (homeTeam) {
      const existingHome = await db.teams.where('name').equals(homeTeam.name).first()
      if (existingHome) {
        homeTeamId = existingHome.id
        await db.teams.update(homeTeamId, {
          ...homeTeam,
          id: homeTeamId,
          updatedAt: new Date().toISOString()
        })
      } else {
        homeTeamId = await db.teams.add({
          ...homeTeam,
          id: undefined,
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

    // Create match with ID=1 (always single match in session)
    const matchId = await db.matches.add({
      ...match,
      id: 1, // Fixed ID for single match
      homeTeamId,
      awayTeamId,
      seed_key: externalId, // Ensure seed_key is set for sync
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

    // Create sets with sequential IDs
    if (sets?.length) {
      for (let i = 0; i < sets.length; i++) {
        const set = sets[i]
        await db.sets.add({
          ...set,
          id: i + 1, // Sequential IDs
          matchId
        })
      }
    }

    // Create events with sequential IDs
    if (events?.length) {
      for (let i = 0; i < events.length; i++) {
        const event = events[i]
        await db.events.add({
          ...event,
          id: i + 1, // Sequential IDs
          matchId
        })
      }
    }

    // STEP C: Queue Supabase 'restore' sync job (DELETE first, then UPSERT)
    if (externalId) {
      console.log('[Restore] Queuing Supabase restore job for match:', externalId)

      // Build match payload for Supabase (convert local field names to Supabase column names)
      const matchPayload = {
        external_id: externalId,
        game_pin: match.gamePin || match.game_pin,
        game_n: match.gameN || match.game_n,
        status: match.status || 'live',
        home_team: homeTeam ? {
          name: homeTeam.name,
          short_name: homeTeam.shortName || homeTeam.short_name,
          color: homeTeam.color
        } : null,
        away_team: awayTeam ? {
          name: awayTeam.name,
          short_name: awayTeam.shortName || awayTeam.short_name,
          color: awayTeam.color
        } : null,
        players_home: homePlayers || [],
        players_away: awayPlayers || [],
        // Include match_info fields (stored as JSONB)
        match_info: {
          hall: match.hall,
          city: match.city,
          league: match.league,
          championship_type: match.championshipType || match.championship_type,
          ...(match.matchInfo || match.match_info || {})
        },
        coin_toss: {
          confirmed: match.coinTossConfirmed || match.coin_toss_confirmed,
          team_a: match.coinTossTeamA || match.coin_toss_team_a,
          team_b: match.coinTossTeamB || match.coin_toss_team_b,
          first_serve: match.firstServe || match.first_serve,
          ...(match.coinToss || match.coin_toss || {})
        }
      }

      // Build sets payload (convert local to Supabase format)
      const setsPayload = (sets || []).map(s => ({
        external_id: s.externalId || s.external_id || `${externalId}_set_${s.index}`,
        index: s.index,
        home_points: s.homePoints ?? s.home_points ?? 0,
        away_points: s.awayPoints ?? s.away_points ?? 0,
        finished: s.finished || false,
        start_time: s.startTime || s.start_time,
        end_time: s.endTime || s.end_time
      }))

      // Build events payload (convert local to Supabase format)
      const eventsPayload = (events || []).map(e => ({
        external_id: e.externalId || e.external_id || `${externalId}_event_${e.seq || e.id}`,
        set_index: e.setIndex ?? e.set_index,
        type: e.type,
        payload: e.payload,
        ts: e.ts,
        seq: e.seq
      }))

      // Build live state payload from latest set data
      const latestSet = sets?.length > 0
        ? [...sets].sort((a, b) => (b.index || 0) - (a.index || 0))[0]
        : null
      const finishedSets = (sets || []).filter(s => s.finished)
      const homeSetsWon = finishedSets.filter(s => (s.homePoints ?? s.home_points ?? 0) > (s.awayPoints ?? s.away_points ?? 0)).length
      const awaySetsWon = finishedSets.filter(s => (s.awayPoints ?? s.away_points ?? 0) > (s.homePoints ?? s.home_points ?? 0)).length

      const liveStatePayload = {
        current_set: latestSet?.index || 1,
        points_a: latestSet?.homePoints ?? latestSet?.home_points ?? 0,
        points_b: latestSet?.awayPoints ?? latestSet?.away_points ?? 0,
        sets_won_a: homeSetsWon,
        sets_won_b: awaySetsWon,
        status: match.status || 'live'
      }

      // Queue the restore job
      await db.sync_queue.add({
        resource: 'match',
        action: 'restore',
        payload: {
          match: matchPayload,
          sets: setsPayload,
          events: eventsPayload,
          liveState: liveStatePayload
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })

      console.log('[Restore] Restore job queued:', {
        matchId: externalId,
        setsCount: setsPayload.length,
        eventsCount: eventsPayload.length
      })
    }
  })

  return restoredMatchId
}

/**
 * Restore match in place - overwrite existing match with backup data
 * Used for cloud backup restore during active match
 * IMPORTANT: Queues sync job to update match_live_state in Supabase
 */
export async function restoreMatchInPlace(matchId, jsonData) {
  if (!jsonData.version || !jsonData.match) {
    throw new Error('Invalid backup file format')
  }

  const { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events } = jsonData

  // Get external_id for Supabase sync
  const externalId = match.seed_key || match.seedKey || match.external_id
  if (!externalId) {
    console.warn('[RestoreInPlace] No external_id found - Supabase sync will be skipped')
  }

  await db.transaction('rw', db.matches, db.sets, db.events, db.sync_queue, async () => {
    // Update match data (keep same ID)
    await db.matches.update(matchId, {
      ...match,
      id: matchId,
      seed_key: externalId, // Ensure seed_key is set for sync
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

    // Queue Supabase 'restore' sync job (same as restoreMatchFromJson)
    if (externalId) {
      console.log('[RestoreInPlace] Queuing Supabase restore job for match:', externalId)

      // Build match payload for Supabase
      const matchPayload = {
        external_id: externalId,
        game_pin: match.gamePin || match.game_pin,
        game_n: match.gameN || match.game_n,
        status: match.status || 'live',
        home_team: homeTeam ? {
          name: homeTeam.name,
          short_name: homeTeam.shortName || homeTeam.short_name,
          color: homeTeam.color
        } : (match.home_team || null),
        away_team: awayTeam ? {
          name: awayTeam.name,
          short_name: awayTeam.shortName || awayTeam.short_name,
          color: awayTeam.color
        } : (match.away_team || null),
        players_home: homePlayers || match.players_home || [],
        players_away: awayPlayers || match.players_away || [],
        // Include match_info fields (stored as JSONB)
        match_info: {
          hall: match.hall,
          city: match.city,
          league: match.league,
          championship_type: match.championshipType || match.championship_type,
          ...(match.matchInfo || match.match_info || {})
        },
        coin_toss: {
          confirmed: match.coinTossConfirmed || match.coin_toss_confirmed,
          team_a: match.coinTossTeamA || match.coin_toss_team_a,
          team_b: match.coinTossTeamB || match.coin_toss_team_b,
          first_serve: match.firstServe || match.first_serve,
          ...(match.coinToss || match.coin_toss || {})
        }
      }

      // Build sets payload
      const setsPayload = (sets || []).map(s => ({
        external_id: s.externalId || s.external_id || `${externalId}_set_${s.index}`,
        index: s.index,
        home_points: s.homePoints ?? s.home_points ?? 0,
        away_points: s.awayPoints ?? s.away_points ?? 0,
        finished: s.finished || false,
        start_time: s.startTime || s.start_time,
        end_time: s.endTime || s.end_time
      }))

      // Build events payload
      const eventsPayload = (events || []).map(e => ({
        external_id: e.externalId || e.external_id || `${externalId}_event_${e.seq || e.id}`,
        set_index: e.setIndex ?? e.set_index,
        type: e.type,
        payload: e.payload,
        ts: e.ts,
        seq: e.seq
      }))

      // Build live state payload from latest set data
      const latestSet = sets?.length > 0
        ? [...sets].sort((a, b) => (b.index || 0) - (a.index || 0))[0]
        : null
      const finishedSets = (sets || []).filter(s => s.finished)
      const homeSetsWon = finishedSets.filter(s => (s.homePoints ?? s.home_points ?? 0) > (s.awayPoints ?? s.away_points ?? 0)).length
      const awaySetsWon = finishedSets.filter(s => (s.awayPoints ?? s.away_points ?? 0) > (s.homePoints ?? s.home_points ?? 0)).length

      const liveStatePayload = {
        current_set: latestSet?.index || 1,
        points_a: latestSet?.homePoints ?? latestSet?.home_points ?? 0,
        points_b: latestSet?.awayPoints ?? latestSet?.away_points ?? 0,
        sets_won_a: homeSetsWon,
        sets_won_b: awaySetsWon,
        status: match.status || 'live'
      }

      // Queue the restore job
      await db.sync_queue.add({
        resource: 'match',
        action: 'restore',
        payload: {
          match: matchPayload,
          sets: setsPayload,
          events: eventsPayload,
          liveState: liveStatePayload
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })

      console.log('[RestoreInPlace] Restore job queued:', {
        matchId: externalId,
        setsCount: setsPayload.length,
        eventsCount: eventsPayload.length,
        liveState: liveStatePayload
      })
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

  // Fetch sets, events, and live state using the UUID match id
  const [setsResult, eventsResult, liveStateResult] = await Promise.all([
    supabase.from('sets').select('*').eq('match_id', matchData.id),
    supabase.from('events').select('*').eq('match_id', matchData.id),
    supabase.from('match_live_state').select('*').eq('match_id', matchData.id).maybeSingle()
  ])

  let events = eventsResult.data || []
  const liveState = liveStateResult.data

  console.log('[Restore] Fetched from Supabase:', {
    matchId: matchData.id,
    matchStatus: matchData.status,
    setsCount: setsResult.data?.length || 0,
    eventsCount: events.length,
    hasLiveState: !!liveState,
    liveStatePoints: liveState ? `${liveState.points_a}-${liveState.points_b}` : 'N/A',
    liveStateSet: liveState?.current_set,
    hasLineupA: !!liveState?.lineup_a,
    hasLineupB: !!liveState?.lineup_b
  })

  // Helper: Extract player numbers from rich format lineup
  const extractLineupNumbers = (lineup) => {
    if (!lineup) return null
    const result = {}
    for (const pos of ['I', 'II', 'III', 'IV', 'V', 'VI']) {
      if (lineup[pos]) {
        // Rich format has { number, isServing, ... }, legacy format is just a number
        result[pos] = typeof lineup[pos] === 'object' && lineup[pos].number !== undefined
          ? lineup[pos].number
          : lineup[pos]
      }
    }
    return Object.keys(result).length > 0 ? result : null
  }

  // Helper: Extract libero substitution info from rich format lineup
  const extractLiberoSubstitution = (lineup) => {
    if (!lineup) return null
    for (const pos of ['I', 'II', 'III', 'IV', 'V', 'VI']) {
      const posData = lineup[pos]
      if (posData && typeof posData === 'object' && posData.isLibero && posData.replacedNumber) {
        return {
          position: pos,
          liberoNumber: posData.number,
          playerNumber: posData.replacedNumber,
          liberoType: posData.liberoType
        }
      }
    }
    return null
  }

  // Check if events already have lineup type events
  const hasLineupTypeEvents = events.some(e => e.type === 'lineup')

  // If no lineup type events, create them from event lineup_left/lineup_right columns
  // or from match_live_state
  if (!hasLineupTypeEvents) {
    const teamAIsHome = matchData.coin_toss_team_a === 'home'

    // First try: get lineup from the latest event that has lineup_left/lineup_right
    const eventWithLineup = [...events]
      .sort((a, b) => (b.seq || 0) - (a.seq || 0))
      .find(e => e.lineup_left || e.lineup_right)

    if (eventWithLineup) {
      const setIndex = eventWithLineup.set_index || 1
      // Determine left/right to home/away mapping from the event
      // lineup_left/lineup_right are stored by court position, need to map to team
      // For now, use coin_toss_team_a to determine
      const leftIsHome = (setIndex % 2 === 1) ? (teamAIsHome) : (!teamAIsHome)

      const homeRawLineup = leftIsHome ? eventWithLineup.lineup_left : eventWithLineup.lineup_right
      const awayRawLineup = leftIsHome ? eventWithLineup.lineup_right : eventWithLineup.lineup_left
      const homeLineup = extractLineupNumbers(homeRawLineup)
      const awayLineup = extractLineupNumbers(awayRawLineup)
      const homeLiberoSub = extractLiberoSubstitution(homeRawLineup)
      const awayLiberoSub = extractLiberoSubstitution(awayRawLineup)

      console.log('[Restore] Creating lineup from event lineup_left/lineup_right:', {
        eventSeq: eventWithLineup.seq,
        setIndex,
        leftIsHome,
        homeLineup,
        awayLineup,
        homeLiberoSub,
        awayLiberoSub,
        rawLineupLeft: eventWithLineup.lineup_left,
        rawLineupRight: eventWithLineup.lineup_right
      })

      if (homeLineup) {
        const payload = { team: 'home', lineup: homeLineup, isInitial: true }
        if (homeLiberoSub) payload.liberoSubstitution = homeLiberoSub
        events.push({
          type: 'lineup',
          set_index: setIndex,
          seq: 0.5,
          payload,
          ts: eventWithLineup.ts || new Date().toISOString()
        })
      }
      if (awayLineup) {
        const payload = { team: 'away', lineup: awayLineup, isInitial: true }
        if (awayLiberoSub) payload.liberoSubstitution = awayLiberoSub
        events.push({
          type: 'lineup',
          set_index: setIndex,
          seq: 0.6,
          payload,
          ts: eventWithLineup.ts || new Date().toISOString()
        })
      }
    } else if (liveState) {
      // Fallback: get lineup from match_live_state
      const currentSet = liveState.current_set || 1
      const lineupANumbers = extractLineupNumbers(liveState.lineup_a)
      const lineupBNumbers = extractLineupNumbers(liveState.lineup_b)
      const liberoSubA = extractLiberoSubstitution(liveState.lineup_a)
      const liberoSubB = extractLiberoSubstitution(liveState.lineup_b)

      console.log('[Restore] Creating lineup from match_live_state:', {
        currentSet,
        teamAIsHome,
        lineupANumbers,
        lineupBNumbers,
        liberoSubA,
        liberoSubB,
        rawLineupA: liveState.lineup_a,
        rawLineupB: liveState.lineup_b
      })

      if (lineupANumbers) {
        const payload = {
          team: teamAIsHome ? 'home' : 'away',
          lineup: lineupANumbers,
          isInitial: true
        }
        if (liberoSubA) payload.liberoSubstitution = liberoSubA
        events.push({
          type: 'lineup',
          set_index: currentSet,
          seq: 0.5,
          payload,
          ts: liveState.updated_at || new Date().toISOString()
        })
      }

      if (lineupBNumbers) {
        const payload = {
          team: teamAIsHome ? 'away' : 'home',
          lineup: lineupBNumbers,
          isInitial: true
        }
        if (liberoSubB) payload.liberoSubstitution = liberoSubB
        events.push({
          type: 'lineup',
          set_index: currentSet,
          seq: 0.6,
          payload,
          ts: liveState.updated_at || new Date().toISOString()
        })
      }
    }
  }

  // Log summary of what will be restored
  const lineupEvents = events.filter(e => e.type === 'lineup')
  const pointEvents = events.filter(e => e.type === 'point')
  console.log('[Restore] Summary - will restore:', {
    match: matchData.external_id,
    homeTeam: matchData.home_team?.name,
    awayTeam: matchData.away_team?.name,
    sets: (setsResult.data || []).map(s => ({ index: s.index, home: s.home_points, away: s.away_points, finished: s.finished })),
    totalEvents: events.length,
    lineupEvents: lineupEvents.length,
    pointEvents: pointEvents.length,
    lineupTeams: lineupEvents.map(e => e.payload?.team),
    lineupSetIndices: lineupEvents.map(e => e.set_index)
  })

  return {
    match: matchData,
    // JSONB data is already in matchData: home_team, away_team, players_home, players_away, bench_home, bench_away, officials
    sets: setsResult.data || [],
    events,
    liveState // Include live state for additional data
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

    // Create local teams (always create new teams for imported matches to avoid duplicates)
    let homeTeamId = null
    let awayTeamId = null

    if (homeTeamData.name) {
      homeTeamId = await db.teams.add({
        name: homeTeamData.name,
        shortName: homeTeamData.short_name,
        color: homeTeamData.color,
        createdAt: new Date().toISOString()
      })
    }

    if (awayTeamData.name) {
      awayTeamId = await db.teams.add({
        name: awayTeamData.name,
        shortName: awayTeamData.short_name,
        color: awayTeamData.color,
        createdAt: new Date().toISOString()
      })
    }

    // Extract JSONB data with fallback to legacy columns
    const matchInfo = match.match_info || {}
    const coinToss = match.coin_toss || {}
    const signatures = match.signatures || {}
    const results = match.results || {}
    const approval = match.approval || {}
    const connections = match.connections || {}
    const connectionPins = match.connection_pins || {}

    // Create match with all JSONB data (prefer JSONB, fallback to legacy)
    const localMatchId = await db.matches.add({
      homeTeamId,
      awayTeamId,
      status: match.status,
      scheduledAt: match.scheduled_at,
      // Match info: prefer JSONB, fallback to legacy
      hall: matchInfo.hall || match.hall,
      city: matchInfo.city || match.city,
      league: matchInfo.league || match.league,
      championshipType: matchInfo.championship_type || match.championship_type,
      refereePin: match.referee_pin,
      gamePin: match.game_pin,
      gameN: match.game_n,
      gameNumber: match.game_n ? String(match.game_n) : null, // Also set gameNumber
      test: match.test || false,
      seed_key: match.external_id,
      // Short names at match level (for easy access)
      homeShortName: homeTeamData.short_name || null,
      awayShortName: awayTeamData.short_name || null,
      // JSONB data stored locally
      officials: match.officials || [],
      bench_home: match.bench_home || [],
      bench_away: match.bench_away || [],
      // Signatures: prefer JSONB, fallback to legacy
      homeCoachSignature: signatures.home_coach || match.home_coach_signature,
      homeCaptainSignature: signatures.home_captain || match.home_captain_signature,
      awayCoachSignature: signatures.away_coach || match.away_coach_signature,
      awayCaptainSignature: signatures.away_captain || match.away_captain_signature,
      homeCoachPostGameSignature: signatures.home_coach_post_game || match.home_coach_post_game_signature,
      homeCaptainPostGameSignature: signatures.home_captain_post_game || match.home_captain_post_game_signature,
      awayCoachPostGameSignature: signatures.away_coach_post_game || match.away_coach_post_game_signature,
      awayCaptainPostGameSignature: signatures.away_captain_post_game || match.away_captain_post_game_signature,
      refereeSignature: signatures.referee || match.referee_signature,
      scorerSignature: signatures.scorer || match.scorer_signature,
      // Coin toss: prefer JSONB, fallback to legacy
      coinTossConfirmed: coinToss.confirmed !== undefined ? coinToss.confirmed : match.coin_toss_confirmed,
      coinTossTeamA: coinToss.team_a || match.coin_toss_team_a,
      coinTossTeamB: coinToss.team_b || match.coin_toss_team_b,
      coinTossServeA: coinToss.serve_a !== undefined ? coinToss.serve_a : match.coin_toss_serve_a,
      firstServe: coinToss.first_serve || match.first_serve,
      // Match result: prefer JSONB, fallback to legacy
      setResults: results.set_results || match.set_results,
      winner: results.winner || match.winner,
      finalScore: results.final_score || match.final_score,
      sanctions: results.sanctions || match.sanctions,
      // Approval: prefer JSONB, fallback to legacy
      approved: approval.approved !== undefined ? approval.approved : match.approved,
      approvedAt: approval.approved_at || match.approved_at,
      // Connection settings: prefer JSONB, fallback to legacy
      refereeConnectionEnabled: connections.referee_enabled !== undefined ? connections.referee_enabled : match.referee_connection_enabled,
      homeTeamConnectionEnabled: connections.home_bench_enabled !== undefined ? connections.home_bench_enabled : match.home_team_connection_enabled,
      awayTeamConnectionEnabled: connections.away_bench_enabled !== undefined ? connections.away_bench_enabled : match.away_team_connection_enabled,
      homeTeamPin: connectionPins.bench_home || match.bench_home_pin,
      awayTeamPin: connectionPins.bench_away || match.bench_away_pin,
      refereePin: connectionPins.referee || match.referee_pin,
      homeTeamUploadPin: connectionPins.upload_home || match.home_team_upload_pin,
      awayTeamUploadPin: connectionPins.upload_away || match.away_team_upload_pin,
      // Pending rosters: prefer JSONB, fallback to legacy
      pendingHomeRoster: connections.pending_home_roster || match.pending_home_roster,
      pendingAwayRoster: connections.pending_away_roster || match.pending_away_roster,
      // Import metadata
      importedFrom: 'supabase',
      importedAt: new Date().toISOString(),
      createdAt: match.created_at || new Date().toISOString(),
      // Mark match info as confirmed since we're restoring an existing match
      matchInfoConfirmedAt: match.created_at || new Date().toISOString()
    })

    importedMatchId = localMatchId

    // Create players from JSONB arrays (fresh teams, so no duplicates)
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

    // If no sets exist but match has coin toss confirmed or has events, create Set 1
    // This handles the case where a match was started but no rallies were played yet
    if (sets.length === 0 && (match.coin_toss_confirmed || events.length > 0)) {
      console.log('[Import] No sets found, creating Set 1 for match with coin toss confirmed or events')
      await db.sets.add({
        matchId: localMatchId,
        index: 1,
        homePoints: 0,
        awayPoints: 0,
        finished: false
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
 * List cloud backups from Supabase storage for a match
 * @param {string} gamePin - The 6-digit game PIN
 * @param {number} gameN - The game number (default 1)
 * @returns {Array} Array of backup file info
 */
export async function listCloudBackups(gamePin, gameN = 1) {
  if (!supabase) {
    throw new Error('Supabase not configured')
  }

  // Use the same path format as logger.js continuous backups
  const folderPath = `backups/backup_g${gameN}`

  const { data, error } = await supabase
    .storage
    .from('backup')
    .list(folderPath, {
      sortBy: { column: 'name', order: 'desc' }
    })

  if (error) throw error

  // Parse filenames to extract useful info
  // Format: backup_g785111_set2_scoreleft23_scoreright23_20260105_113229_798.json
  return (data || [])
    .filter(f => f.name.endsWith('.json'))
    .map(f => {
      const match = f.name.match(/^backup_g(\d+)_set(\d+)_scoreleft(\d+)_scoreright(\d+)_(\d{8})_(\d{6})_(\d{3})\.json$/)
      if (match) {
        return {
          name: f.name,
          path: `${folderPath}/${f.name}`,
          gameN: parseInt(match[1]),
          setIndex: parseInt(match[2]),
          leftScore: parseInt(match[3]),
          rightScore: parseInt(match[4]),
          date: match[5],
          time: match[6],
          ms: match[7],
          created: f.created_at,
          size: f.metadata?.size || 0
        }
      }
      // Fallback for files that don't match the pattern
      return {
        name: f.name,
        path: `${folderPath}/${f.name}`,
        created: f.created_at,
        size: f.metadata?.size || 0
      }
    })
}

/**
 * Fetch a cloud backup file content
 * @param {string} path - Full path to the backup file
 * @returns {Object} Parsed JSON backup data
 */
export async function fetchCloudBackup(path) {
  if (!supabase) {
    throw new Error('Supabase not configured')
  }

  const { data, error } = await supabase
    .storage
    .from('backup')
    .download(path)

  if (error) throw error

  const text = await data.text()
  return JSON.parse(text)
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
