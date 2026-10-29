/**
 * Backup Manager - Handles automatic backup to file system
 *
 * Chrome/Edge: Uses File System Access API for direct folder writes
 * Safari/Firefox: Falls back to periodic auto-downloads
 */

import { db } from '../db/db'
import { wipeMatchEvents, withoutEventHistory } from '../db/eventHistory'
import { apiFrom, apiStorage, apiMatchRestoreByPin } from '../lib/apiClient'
import { sanitizeSimple } from './stringUtils'
import { getCloudApiUrl } from './backendConfig'
import { filterMatchPayload, localFromMatchInfo, matchInfoFromLocal, remarksForServer } from '../db/matchRepository'
import { getSideAForSet, getLeftTeamLabelForSet } from '../domain/rules'
import { swappedSides, liveRowTeamA } from '../domain/coinToss'
import { setExtId, eventExtId, jobMatchKey, parseExtId } from './syncIds'
import { buildConnectionPins } from './connectionPins'
import { missingConnectionPins } from './remoteRoster'
import { generateSecurePin } from './stringUtils'
import { isScorerEntry } from './appEntry'
import { queueScorerClaim, retireSupersededMatches, supersededClaimsOf } from './matchHandover'
import { isKnownClosedOnServer, CLOSING_STATUSES } from './matchReopen'
import { postMatchSignaturesFromServer } from '../domain/signatureEdits'
import { signatureSourcesFromApproval } from '../domain/phoneSignature'
import { liveClockOffset, liveClockOffsetAfter, liveStateNow } from './serverDataSync'

// IndexedDB key for storing file system directory handle
const BACKUP_DB_NAME = 'escoresheet_backup'
const BACKUP_DIR_HANDLE_KEY = 'backup_directory_handle'

// filterMatchPayload now imported from ../db/matchRepository (shared). The local
// copy here was missing `sport_type`, silently dropping it from restore payloads.

// The backup's remarks for the restore job (db/017). A backup without the
// field (an app before 017) sends none, so the server keeps what it has.
function restoreRemarks(match) {
  return typeof match?.remarks === 'string' ? { remarks: remarksForServer(match.remarks) } : {}
}

// Roster in the same snake_case shape as the normal match sync (CoinToss), so a
// restored match reads back with names (importMatchFromSupabase reads first_name).
function toCloudPlayers(players) {
  return (players || []).map(p => ({
    number: p.number,
    first_name: p.firstName ?? p.first_name ?? '',
    last_name: p.lastName ?? p.last_name ?? '',
    dob: p.dob || null,
    libero: p.libero || '',
    is_captain: !!(p.isCaptain ?? p.is_captain),
    is_lfp: !!(p.isLfp ?? p.is_lfp)
  }))
}

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
 * Download match backup as file (Safari/Firefox fallback). Only the
 * scoretable page saves backups: a referee / bench / livescore page opened
 * from a tablet QR code never downloads a match file (utils/appEntry).
 */
export async function downloadMatchBackup(matchId) {
  if (!isScorerEntry()) {
    throw new Error('Match backups are saved by the scoretable only')
  }
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

// Local key of a match (seed_key; older rows used seedKey / externalId)
const localMatchKey = (m) => m?.seed_key || m?.seedKey || m?.externalId || m?.external_id || null

const LOCAL_PIN_FIELDS = ['gamePin', 'refereePin', 'homeTeamPin', 'awayTeamPin', 'homeTeamUploadPin', 'awayTeamUploadPin']
const hasValue = (v) => v !== undefined && v !== null && String(v).trim() !== ''

/**
 * The PINs of a match restored from an app backup file, which carries none
 * (utils/nativeBackup/redact): those of the local copy it replaces, else new
 * ones (a new game PIN only for an official match). {} for other backups.
 * @param {object} jsonData the backup
 * @param {object|null} previous the local copy being replaced
 */
export function pinsForRestore(jsonData, previous) {
  if (!jsonData?.secretsRemoved) return {}
  const match = jsonData.match || {}
  const pins = {}
  for (const f of LOCAL_PIN_FIELDS) {
    if (!hasValue(match[f]) && hasValue(previous?.[f])) pins[f] = previous[f]
  }
  const merged = { ...match, ...pins }
  Object.assign(pins, missingConnectionPins(merged))
  if (!match.test && !hasValue(merged.gamePin) && !hasValue(match.game_pin)) {
    pins.gamePin = generateSecurePin(Object.values(pins).map(String))
  }
  return pins
}

// Full connection_pins for the restore upsert, or nothing when the backup has no
// PINs (an empty object would wipe the cloud PINs the referee/bench check reads).
function restorePins(localMatch) {
  const pins = buildConnectionPins(localMatch)
  return Object.keys(pins).length > 0 ? { connection_pins: pins } : {}
}

// How long a restore waits for the server's answer before it goes on without
// it: the restore's Confirm must never wait long on a slow backend.
const SERVER_CLOSED_TIMEOUT_MS = 4000
const TIMED_OUT = Symbol('timedOut')

// Public columns behind a public filter (backend/lib/publicColumns.js), so
// this also works signed out and sees every match, not only this account's.
const readServerStatus = (key) =>
  apiFrom('matches').select('external_id, status, test').eq('external_id', key).maybeSingle()

/**
 * Is this match closed on the server? Closed is the server guard's rule
 * (db/007): a non-test match at approved/final (closed_at is set on the first
 * such write and is not a public column; an admin reopen writes 'ended').
 * true / false, or null when unknown: no key, offline, the read failed or did
 * not answer within timeoutMs. A match the server does not have is not closed.
 * @param {string} externalId
 * @param {{read?: (key: string) => PromiseLike<{data: object|null, error: object|null}>, timeoutMs?: number}} [options]
 * @returns {Promise<boolean|null>}
 */
export async function serverClosedState(externalId, { read = readServerStatus, timeoutMs = SERVER_CLOSED_TIMEOUT_MS } = {}) {
  if (!externalId) return null
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null
  let timer
  try {
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs) })
    const result = await Promise.race([read(externalId), timeout])
    if (result === TIMED_OUT || !result || result.error) return null
    const row = result.data
    if (!row) return false
    return row.test !== true && CLOSING_STATUSES.includes(row.status)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// The match's live state in the cloud (its updated_at): matches.id by the
// key, then match_live_state by it (public columns, no session needed)
async function readServerLiveState(key) {
  const m = await apiFrom('matches').select('id').eq('external_id', key).maybeSingle()
  if (m?.error || !m?.data?.id) return { data: null, error: m?.error || null }
  return apiFrom('match_live_state').select('updated_at').eq('match_id', m.data.id).maybeSingle()
}

/**
 * The cloud's live state of a match (`{ updated_at }`), or null: no key,
 * offline, none there, the read failed or did not answer within timeoutMs.
 * A backup restored on a device continues the match there: its live states
 * must be stamped after this one (serverDataSync.liveClockOffsetAfter).
 * @returns {Promise<object|null>}
 */
export async function serverLiveState(externalId, { read = readServerLiveState, timeoutMs = SERVER_CLOSED_TIMEOUT_MS } = {}) {
  if (!externalId) return null
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null
  let timer
  try {
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs) })
    const result = await Promise.race([read(externalId), timeout])
    if (result === TIMED_OUT || !result || result.error) return null
    return result.data || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The error a restore of a match closed on the server is refused with. */
export function closedOnServerError(externalId, gameN) {
  const err = new Error('This match is closed on the server')
  err.code = 'OV_MATCH_CLOSED'
  err.externalId = externalId
  err.gameN = gameN ?? null
  return err
}

// 2026-10-20, match 406970: a backup of a match the server had closed was
// restored as a live copy whose restore job the server refuses for good
// (409 OV_MATCH_CLOSED). Refuse such a restore before anything is replaced.
// The server's answer decides; an explicit "open" (an admin reopened it) wins
// over stale local evidence. Only when the server cannot be asked does local
// evidence decide: the backup row or a local copy known closed there.
async function refuseIfClosedOnServer(externalId, backupMatch, localCopies, checkServer) {
  const server = await checkServer(externalId)
  const closed = server === true ||
    (server == null && (isKnownClosedOnServer(backupMatch) || localCopies.some(isKnownClosedOnServer)))
  if (closed) {
    console.warn('[Restore] Refused: match is closed on the server:', externalId)
    throw closedOnServerError(externalId, backupMatch?.gameN ?? backupMatch?.game_n ?? localCopies[0]?.gameN)
  }
}

// A restore the guard let through drops this device's "closed on the server"
// evidence (the OV_MATCH_CLOSED block, the server's closed_at) from the rows
// it writes. Rows carrying it pass the guard only when the server answered
// open (an admin reopened the match), but every backup taken after the first
// refusal keeps it (exportMatchData writes the whole row): restored with it,
// the copy would open as closed on the server instead of the scoring screen.
// If the match is still closed, the restore job's own refusal records it again.
function withoutClosedEvidence(...rows) {
  const changes = {}
  if (rows.some(r => r?.cloudBlock?.code === 'OV_MATCH_CLOSED')) changes.cloudBlock = null
  if (rows.some(r => r?.closed_at)) changes.closed_at = null
  return changes
}

// A JSON file that is not a match backup, and a file that cannot be read
// (damaged, cut off): restoreErrorText says these in the user's words.
export const BACKUP_FORMAT_ERROR = 'OV_BACKUP_FORMAT'
export const BACKUP_UNREADABLE_ERROR = 'OV_BACKUP_UNREADABLE'

/**
 * The match backup inside a whole-database export: "match stopped" and the
 * Match menu's export (Scoreboard), and the set-end download of the app
 * before 2026-10-26, write every table of the device as { exportDate,
 * matchId, matches, teams, players, sets, events, ... }. The set-end one is
 * a browser's only automatic backup offline, and the restore refused it
 * (stress test 2026-10-25).
 * The match of its `matchId` with its teams, players, sets and events, in
 * exportMatchData's shape; null for any other file.
 * @param {object} jsonData a parsed backup file
 */
export function matchBackupFromDatabaseExport(jsonData) {
  if (!jsonData || jsonData.match || !Array.isArray(jsonData.matches)) return null
  const match = jsonData.matches.find(m => m && m.id != null && String(m.id) === String(jsonData.matchId))
  if (!match) return null
  const rows = (list) => (Array.isArray(list) ? list.filter(Boolean) : [])
  const teamOf = (id) => (id != null ? rows(jsonData.teams).find(t => t.id === id) || null : null)
  const playersOf = (id) => (id != null ? rows(jsonData.players).filter(p => p.teamId === id) : [])
  return {
    version: 1,
    lastUpdated: jsonData.exportDate || null,
    match,
    homeTeam: teamOf(match.homeTeamId),
    awayTeam: teamOf(match.awayTeamId),
    homePlayers: playersOf(match.homeTeamId),
    awayPlayers: playersOf(match.awayTeamId),
    sets: rows(jsonData.sets).filter(r => r.matchId === match.id),
    events: rows(jsonData.events).filter(r => r.matchId === match.id)
  }
}

/**
 * The match backup inside a file Match End writes: the MatchData_*.json in
 * the ZIP that Approve downloads, as the app wrote it before 2026-10-29
 * ({ match: { ...the match row, homeTeam, awayTeam }, homePlayers,
 * awayPlayers, sets, events, exportedAt }), and the scoresheet JSON the
 * approval stores in the cloud (scoresheetJsonBlob: the teams beside the
 * match, uploadedAt). Neither has `version`: the restore refused the one
 * file a scorer keeps of an approved match.
 * In exportMatchData's shape (the teams taken out of the match row); null for
 * any other file.
 * @param {object} jsonData a parsed backup file
 */
export function matchBackupFromMatchEndExport(jsonData) {
  const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!isRecord(jsonData) || jsonData.version || !isRecord(jsonData.match)) return null
  if (!Array.isArray(jsonData.sets) && !Array.isArray(jsonData.events)) return null
  const { homeTeam, awayTeam, ...match } = jsonData.match
  const rows = (list) => (Array.isArray(list) ? list.filter(Boolean) : [])
  return {
    version: 1,
    lastUpdated: jsonData.exportedAt || jsonData.uploadedAt || null,
    match,
    homeTeam: isRecord(jsonData.homeTeam) ? jsonData.homeTeam : (isRecord(homeTeam) ? homeTeam : null),
    awayTeam: isRecord(jsonData.awayTeam) ? jsonData.awayTeam : (isRecord(awayTeam) ? awayTeam : null),
    homePlayers: rows(jsonData.homePlayers),
    awayPlayers: rows(jsonData.awayPlayers),
    sets: rows(jsonData.sets),
    events: rows(jsonData.events)
  }
}

/**
 * A match file in the shape the restores read (exportMatchData's): a backup
 * file as it is, a whole-database export or a Match End file converted.
 * Every picked file and both restores go through it.
 * @param {object} jsonData a parsed backup file
 */
export function matchBackupFromFile(jsonData) {
  return matchBackupFromDatabaseExport(jsonData) || matchBackupFromMatchEndExport(jsonData) || jsonData
}

/**
 * The MatchData_*.json of the match-end ZIP (MatchEnd, Approve): the backup
 * file format (exportMatchData), so Restore match takes it back as it is,
 * with the time it was written as exportedAt too.
 * @param {{ match: object, homeTeam?: object, awayTeam?: object, homePlayers?: object[], awayPlayers?: object[], sets?: object[], events?: object[] }} data
 * @param {Date} [now]
 */
export function matchEndExportData({ match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events }, now = new Date()) {
  const at = now.toISOString()
  return {
    version: 1,
    lastUpdated: at,
    match,
    homeTeam: homeTeam || null,
    awayTeam: awayTeam || null,
    homePlayers: homePlayers || [],
    awayPlayers: awayPlayers || [],
    sets: sets || [],
    events: events || [],
    exportedAt: at
  }
}

/**
 * What the Restore dialogs say when a backup cannot be loaded or restored:
 * a file that cannot be read and a file that is not a match backup in the
 * user's words, anything else with the error's own text.
 * @param {Error} err
 * @param {(key: string, opts?: object) => string} t
 */
export function restoreErrorText(err, t) {
  if (err?.code === BACKUP_UNREADABLE_ERROR || err?.name === 'SyntaxError') return t('settings.backup.restoreErrors.unreadable')
  if (err?.code === BACKUP_FORMAT_ERROR) return t('settings.backup.restoreErrors.notABackup')
  return t('settings.backup.restoreErrors.failed', { error: err?.message || String(err ?? '') })
}

/**
 * Restore match from JSON backup data
 * REPLACE: removes this match's local rows (other local matches are kept),
 * restores it from the backup and queues the Supabase restore.
 * Refused (err.code 'OV_MATCH_CLOSED', nothing changed) for a match closed on
 * the server; a test backup never asks.
 * @param {object} jsonData the backup
 * @param {{checkServer?: (externalId: string) => Promise<boolean|null>}} [options]
 */
export async function restoreMatchFromJson(jsonData, { checkServer = serverClosedState, cloudLiveState = serverLiveState } = {}) {
  // A whole-database export holds the match it was written for, a Match End
  // file the match in its own shape
  jsonData = matchBackupFromFile(jsonData)
  // Validate schema
  if (!jsonData?.version || !jsonData.match) {
    throw Object.assign(new Error('Invalid backup file format'), { code: BACKUP_FORMAT_ERROR })
  }

  const { homeTeam, awayTeam, homePlayers, awayPlayers, sets, events } = jsonData
  let match = jsonData.match

  // Get external_id for Supabase sync (seed_key in local, external_id in backup)
  const externalId = match.seed_key || match.seedKey || match.external_id
  if (!externalId) {
    console.warn('[Restore] No external_id found - Supabase sync will be skipped')
  }

  // Before anything is deleted, added or queued (test matches never sync)
  const guarded = !!externalId && !match.test
  // The cloud's last live state, read alongside: this device stamps its own
  // after it (the previous device's clock may be ahead of this one's)
  const cloudLive = guarded ? cloudLiveState(externalId).catch(() => null) : Promise.resolve(null)
  if (guarded) {
    const localCopies = await db.matches.filter(m => localMatchKey(m) === externalId).toArray()
    await refuseIfClosedOnServer(externalId, match, localCopies, checkServer)
  }
  const liveClockOffsetMs = liveClockOffsetAfter(await cloudLive)

  let restoredMatchId = null

  // Start transaction - REPLACE this match only
  await db.transaction('rw', db.matches, db.teams, db.players, db.sets, db.events, db.sync_queue, async () => {
    // STEP A: remove THIS match's local copy (by seed_key) with its sets,
    // events, teams and players. Other local matches (and a team row one of
    // them still uses), referees and scorers are kept.
    const previous = externalId ? await db.matches.filter(m => localMatchKey(m) === externalId).toArray() : []
    // An app backup file has no PINs: keep the replaced copy's, or make new ones
    match = { ...match, ...pinsForRestore(jsonData, previous[0] || null) }
    if (externalId) {
      const replacedIds = new Set(previous.map(old => old.id))
      for (const old of previous) {
        // replaced, not undone: the restored events are not voided (db/eventHistory)
        await wipeMatchEvents(db, old.id)
        await db.sets.where('matchId').equals(old.id).delete()
        await db.matches.delete(old.id)
        for (const teamId of [old.homeTeamId, old.awayTeamId]) {
          if (teamId == null) continue
          const usedElsewhere = await db.matches.filter(m => !replacedIds.has(m.id) && (m.homeTeamId === teamId || m.awayTeamId === teamId)).toArray()
          if (usedElsewhere.length) continue
          await db.players.where('teamId').equals(teamId).delete()
          await db.teams.delete(teamId)
        }
      }
      if (previous.length) console.log(`[Restore] Replaced ${previous.length} local copy/copies of match ${externalId}`)
    }
    // Keep other matches' jobs (unsynced writes and the sent history their
    // retries are trimmed against); drop this match's jobs (the local match they
    // describe is gone and the restore job below replaces them) and anything
    // that cannot be attributed to a match.
    const queuedJobs = await db.sync_queue.toArray()
    const keepJob = (j) => !!jobMatchKey(j) && jobMatchKey(j) !== externalId
    await db.sync_queue.bulkDelete(queuedJobs.filter(j => !keepJob(j)).map(j => j.id))

    // STEP B: the restored match's own team rows, always new. A team found
    // by name belonged to another local match (last week's home match of the
    // same club): the restore overwrote it and replaced its roster, and both
    // matches shared one row, which deleting either match then removed
    // (stress test 2026-10-25).
    let homeTeamId = null
    let awayTeamId = null

    if (homeTeam) {
      homeTeamId = await db.teams.add({
        ...homeTeam,
        id: undefined,
        createdAt: new Date().toISOString()
      })
    }

    if (awayTeam) {
      awayTeamId = await db.teams.add({
        ...awayTeam,
        id: undefined,
        createdAt: new Date().toISOString()
      })
    }

    // New auto-increment id: other local matches keep theirs
    const matchId = await db.matches.add({
      ...match,
      ...(guarded ? withoutClosedEvidence(match) : {}),
      id: undefined,
      homeTeamId,
      awayTeamId,
      seed_key: externalId, // Ensure seed_key is set for sync
      // This device's own live-state clock (serverDataSync.liveClockOffset),
      // never the one of the device that wrote the backup: its states come
      // after the cloud's last one. 2026-10-26: a match continued from a
      // backup row kept the file's offset (or none), and with the previous
      // device's clock ahead the referee and benches dropped every new state.
      liveClockOffsetMs,
      // A claim of its own on the venue relays (made at the next relay sync,
      // matchHandover scorerClaimOf): never the file's, which may be a claim
      // another device has taken over since. The file's claims are older
      // copies from now on: a venue relay refuses them even after a restart
      scorerClaim: null,
      supersededClaims: supersededClaimsOf(match),
      restoredAt: new Date().toISOString()
    })

    restoredMatchId = matchId

    // Create players (the teams are new: no players to replace)
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

    // Create sets and events with new auto-increment ids (fixed ids would collide
    // with other local matches' rows); the cloud external_id is built from them.
    const newSetIds = []
    for (const set of sets || []) {
      newSetIds.push(await db.sets.add({ ...set, id: undefined, matchId }))
    }
    const newEventIds = []
    for (const event of events || []) {
      newEventIds.push(await db.events.add({ ...event, id: undefined, matchId }))
    }

    // STEP C: Queue Supabase 'restore' sync job (DELETE first, then UPSERT)
    // Test matches never sync (same rule as logEvent/App): restoring a test backup
    // must not rewrite the shared cloud test match.
    if (externalId && !match.test) {
      console.log('[Restore] Queuing Supabase restore job for match:', externalId)

      // Build match payload for Supabase (convert local field names to Supabase column names)
      const matchPayload = {
        external_id: externalId,
        game_pin: match.gamePin || match.game_pin,
        game_n: match.gameN || match.game_n,
        status: match.status || 'live',
        ...restorePins(match),
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
        players_home: toCloudPlayers(homePlayers),
        players_away: toCloudPlayers(awayPlayers),
        ...restoreRemarks(match),
        // Include match_info fields (stored as JSONB)
        match_info: {
          // every key: the server replaces match_info whole
          ...matchInfoFromLocal(match),
          ...(match.matchInfo || match.match_info || {})
        },
        coin_toss: {
          confirmed: match.coinTossConfirmed || match.coin_toss_confirmed,
          team_a: match.coinTossTeamA || match.coin_toss_team_a,
          team_b: match.coinTossTeamB || match.coin_toss_team_b,
          first_serve: match.firstServe || match.first_serve,
          serve_a: match.coinTossServeA ?? match.coin_toss_serve_a,
          ...(match.coinToss || match.coin_toss || {})
        }
      }

      // Build sets payload (convert local to Supabase format)
      // external_id is derived from the NEW local id (above): later set updates
      // from the scoreboard send setExtId(seed, localId), so the cloud row must
      // carry that id or those updates match nothing.
      const setsPayload = (sets || []).map((s, i) => ({
        external_id: setExtId(externalId, newSetIds[i]),
        index: s.index,
        home_points: s.homePoints ?? s.home_points ?? 0,
        away_points: s.awayPoints ?? s.away_points ?? 0,
        finished: s.finished || false,
        start_time: s.startTime || s.start_time,
        end_time: s.endTime || s.end_time
      }))

      // Build events payload (convert local to Supabase format)
      const eventsPayload = (events || []).map((e, i) => ({
        external_id: eventExtId(externalId, newEventIds[i]),
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
        match_status: match.status || 'live',
        // On this device's live-state clock, as its next states: stamped by
        // the server's clock instead (the column default), the restored score
        // looked newer than this device's next states whenever its clock is
        // behind the server's, and the realtime hub and the viewers kept it
        updated_at: new Date(Date.now() + liveClockOffsetMs).toISOString()
      }

      // Queue the restore job (filter payload to valid columns only)
      await db.sync_queue.add({
        resource: 'match',
        action: 'restore',
        payload: {
          match: filterMatchPayload(matchPayload),
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

  await afterJoin(restoredMatchId)
  return restoredMatchId
}

/**
 * Restore match in place - overwrite existing match with backup data
 * Used for cloud backup restore during active match
 * IMPORTANT: Queues sync job to update match_live_state in Supabase
 * Refused like restoreMatchFromJson for a match closed on the server.
 */
export async function restoreMatchInPlace(matchId, jsonData, { checkServer = serverClosedState } = {}) {
  jsonData = matchBackupFromFile(jsonData)
  if (!jsonData.version || !jsonData.match) {
    throw new Error('Invalid backup file format')
  }

  const { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events } = jsonData

  // Get external_id for Supabase sync
  const externalId = match.seed_key || match.seedKey || match.external_id
  if (!externalId) {
    console.warn('[RestoreInPlace] No external_id found - Supabase sync will be skipped')
  }

  // Refuse to overwrite the open match with another match's backup. Cloud backup
  // folders are keyed by game number only, so a listing can contain backups of
  // other matches that share it.
  const currentMatch = await db.matches.get(matchId)
  const currentKey = currentMatch?.seed_key || currentMatch?.seedKey || currentMatch?.externalId
  if (currentKey && externalId && currentKey !== externalId) {
    throw new Error('This backup belongs to a different match')
  }

  // Before the open match is overwritten (test matches never sync)
  const guarded = !!externalId && !match.test
  if (guarded) {
    await refuseIfClosedOnServer(externalId, match, currentMatch ? [currentMatch] : [], checkServer)
  }

  await db.transaction('rw', db.matches, db.sets, db.events, db.sync_queue, async () => {
    // Update match data (keep same ID). The backup is merged over the current
    // row, so the current row's closed evidence is dropped as well.
    await db.matches.update(matchId, {
      ...match,
      ...(guarded ? withoutClosedEvidence(match, currentMatch) : {}),
      id: matchId,
      // The backup's team ids are local ids of the device that wrote it
      // (another match's teams here, or none): the open match keeps its own
      ...(currentMatch ? { homeTeamId: currentMatch.homeTeamId, awayTeamId: currentMatch.awayTeamId } : {}),
      // ... and its own live-state clock (a backup made on another device
      // carries that one's, serverDataSync.liveClockOffset)
      liveClockOffsetMs: liveClockOffset(currentMatch),
      // ... and a new claim on the venue relays: this device continues the
      // match from the backup (matchHandover scorerClaimOf), whose claims
      // are older copies from now on (supersededClaimsOf)
      scorerClaim: null,
      supersededClaims: supersededClaimsOf(match),
      seed_key: externalId, // Ensure seed_key is set for sync
      restoredAt: new Date().toISOString()
    })

    // Delete existing sets and events for this match
    await db.sets.where('matchId').equals(matchId).delete()
    await wipeMatchEvents(db, matchId)

    // Recreate sets (keep the new local ids: the cloud external_id is built from them)
    const newSetIds = []
    if (sets?.length) {
      for (const set of sets) {
        newSetIds.push(await db.sets.add({
          ...set,
          id: undefined,
          matchId
        }))
      }
    }

    // Recreate events
    const newEventIds = []
    if (events?.length) {
      for (const event of events) {
        newEventIds.push(await db.events.add({
          ...event,
          id: undefined,
          matchId
        }))
      }
    }

    // Queue Supabase 'restore' sync job (same as restoreMatchFromJson; never for test matches)
    if (externalId && !match.test) {
      console.log('[RestoreInPlace] Queuing Supabase restore job for match:', externalId)

      // Pending set/event jobs of this match describe rows the restore replaces
      // (events that no longer exist locally); an older pending restore is
      // superseded too. Match insert/update jobs are KEPT: they carry columns the
      // restore payload does not (officials, signatures, connections, ...), and
      // have lower ids, so they run before the restore job.
      const pendingJobs = await db.sync_queue.toArray()
      const replacedByRestore = (j) => (j.resource === 'set' || j.resource === 'event' || (j.resource === 'match' && j.action === 'restore'))
      await db.sync_queue.bulkDelete(pendingJobs
        .filter(j => (j.status === 'queued' || j.status === 'error') && replacedByRestore(j) && jobMatchKey(j) === externalId)
        .map(j => j.id))

      // PINs from the local match after the update above (backup fields over the
      // current ones, so PINs the backup lacks - app backup files have none -
      // are still sent)
      const restoredLocal = await db.matches.get(matchId)

      // Build match payload for Supabase
      const matchPayload = {
        external_id: externalId,
        game_pin: match.gamePin || match.game_pin || restoredLocal?.gamePin,
        game_n: match.gameN || match.game_n,
        status: match.status || 'live',
        ...restorePins(restoredLocal || match),
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
        players_home: toCloudPlayers(homePlayers || match.players_home),
        players_away: toCloudPlayers(awayPlayers || match.players_away),
        ...restoreRemarks(match),
        // Include match_info fields (stored as JSONB)
        match_info: {
          // every key: the server replaces match_info whole
          ...matchInfoFromLocal(match),
          ...(match.matchInfo || match.match_info || {})
        },
        coin_toss: {
          confirmed: match.coinTossConfirmed || match.coin_toss_confirmed,
          team_a: match.coinTossTeamA || match.coin_toss_team_a,
          team_b: match.coinTossTeamB || match.coin_toss_team_b,
          first_serve: match.firstServe || match.first_serve,
          serve_a: match.coinTossServeA ?? match.coin_toss_serve_a,
          ...(match.coinToss || match.coin_toss || {})
        }
      }

      // Build sets payload (external_id from the new local ids, see restoreMatchFromJson)
      const setsPayload = (sets || []).map((s, i) => ({
        external_id: setExtId(externalId, newSetIds[i]),
        index: s.index,
        home_points: s.homePoints ?? s.home_points ?? 0,
        away_points: s.awayPoints ?? s.away_points ?? 0,
        finished: s.finished || false,
        start_time: s.startTime || s.start_time,
        end_time: s.endTime || s.end_time
      }))

      // Build events payload
      const eventsPayload = (events || []).map((e, i) => ({
        external_id: eventExtId(externalId, newEventIds[i]),
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
        match_status: match.status || 'live',
        // on the match's live-state clock, as the device's next states
        // (restoreMatchFromJson)
        updated_at: new Date(liveStateNow(restoredLocal)).toISOString()
      }

      // Queue the restore job (filter payload to valid columns only)
      await db.sync_queue.add({
        resource: 'match',
        action: 'restore',
        payload: {
          match: filterMatchPayload(matchPayload),
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

const isAB = (v) => v === 'A' || v === 'B'
const flipAB = (v) => (v === 'A' ? 'B' : 'A')
const isSide = (v) => v === 'left' || v === 'right'
const timeOf = (v) => {
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/**
 * The court sides the scorer last saved, for a restore by PIN, as the match
 * fields the court reads (domain/rules getSideAForSet): setLeftTeamOverrides
 * and set5LeftTeam ('A' / 'B', the LEFT team) and set5CourtSwitched.
 *  - The latest synced event's state snapshot: its set 5 coin toss and change
 *    of courts, and its set's side (sideA) as an override when it is not the
 *    set number's side. Its labels are by its own Team A (teamAKey): when A
 *    and B were swapped since (a coin toss correction, nothing moved), the
 *    same team stays on each side: every set 1-4 pinned, set 5 flipped.
 *  - Then the live state (the latest side), unless it is older than the
 *    snapshot's event (its write failed while the queued events synced
 *    later): sets 1-4 its side_a as an override when not the set number's
 *    side. Set 5 as its coin toss side (set5LeftTeam, what the set 5 toss and
 *    its corrections write), never an
 *    override [5], with the change of courts at 8 apart (set5CourtSwitched):
 *    the live side is after the change, so saved as the toss side the change
 *    at 8 would flip it once more. Switched when a team has 8; only a
 *    snapshot whose courts did not follow its score keeps its toss side, and
 *    is switched when that is not the live side.
 * {} when neither says.
 * @param {Array} events  server event rows (seq, created_at, state_snapshot)
 * @param {object|null} liveState  match_live_state row (last_event_ts)
 * @param {'home'|'away'} teamAKey  the match's Team A
 * @param {'home'|'away'} [liveTeamAKey]  the live row's own Team A (its side_a is that team's)
 * @returns {{ setLeftTeamOverrides?: object, set5LeftTeam?: 'A'|'B', set5CourtSwitched?: boolean }}
 */
export function savedCourtSides(events, liveState, teamAKey = 'home', liveTeamAKey = teamAKey) {
  const out = {}
  const overrides = {}
  const leftLabel = (set) => getLeftTeamLabelForSet(set, { setLeftTeamOverrides: overrides })

  const snapEvent = [...(events || [])]
    .sort((a, b) => (b.seq || 0) - (a.seq || 0))
    .find(e => {
      const s = e?.state_snapshot
      return s && typeof s === 'object' &&
        (s.setLeftTeamOverrides || isAB(s.set5LeftTeam) || isSide(s.sideA))
    })
  const snap = snapEvent?.state_snapshot
  if (snap) {
    // The snapshot's sides in its own labels (its Team A, teamAKey): its
    // overrides, and its set's side (sideA) where that is not the set
    // number's side
    const own = {}
    for (const [set, v] of Object.entries(snap.setLeftTeamOverrides || {})) {
      if (isAB(v)) own[set] = v
    }
    const set = Number(snap.currentSetIndex)
    if (set >= 1 && set <= 4 && isSide(snap.sideA)) {
      const ownLeft = snap.sideA === 'left' ? 'A' : 'B'
      if (ownLeft !== getLeftTeamLabelForSet(set, { setLeftTeamOverrides: own })) own[set] = ownLeft
    }
    // A and B swapped since ("Swap A/B": a coin toss correction, nothing
    // moved): the same team on each side, in the restored match's labels.
    // Every set 1-4 is pinned: a set without a side follows the set number
    // (A left in odd sets), which in the new labels is the other team
    // (domain/coinToss swappedSides)
    const swapped = (snap.teamAKey === 'home' || snap.teamAKey === 'away') && snap.teamAKey !== teamAKey
    if (swapped) {
      Object.assign(overrides, swappedSides({ setLeftTeamOverrides: own }))
    } else {
      Object.assign(overrides, own)
    }
    const label = (v) => (swapped ? flipAB(v) : v)
    if (isAB(snap.set5LeftTeam)) out.set5LeftTeam = label(snap.set5LeftTeam)
    if (snap.set5CourtSwitched === true) out.set5CourtSwitched = true
  }

  // The live side only when not older than the snapshot's event: the
  // scorer's last live state write may have failed (offline) while the
  // queued events synced later, and its stale side would undo what the
  // snapshot saved since. Both times are the scorer device's clock (event
  // created_at from its ts, last_event_ts); a time unknown keeps the live side.
  const liveAt = timeOf(liveState?.last_event_ts || liveState?.updated_at)
  const snapAt = snapEvent ? timeOf(snapEvent.created_at || snapEvent.ts) : null
  const liveIsStale = liveAt != null && snapAt != null && liveAt < snapAt

  const set = Number(liveState?.current_set)
  if (!liveIsStale && set >= 1 && isSide(liveState.side_a)) {
    // side_a is the live row's own Team A's (liveRowTeamAKey): the other team
    // than the match's while a swap of A and B is still in the sync queue
    const left = (liveState.side_a === 'left') === (liveTeamAKey === teamAKey) ? 'A' : 'B'
    if (set === 5) {
      // The courts follow the score (FIVB 18.2.2: changed once a team has 8,
      // Scoreboard askCourtSwitchIfDue): the toss side is the live side, or
      // the other one after the change. A toss side corrected since the
      // snapshot ("Switch sides", no event) included: kept as the snapshot's
      // with the courts "changed" at 5:3, the next point asked to change back.
      // Only a snapshot whose courts do not follow its score (a change at 8,
      // or back, not confirmed when it was taken, or still not) keeps its
      // toss side, the live side telling whether the change was made since.
      const reached8 = Math.max(Number(liveState.points_a) || 0, Number(liveState.points_b) || 0) >= 8
      if (isAB(out.set5LeftTeam) && reached8 !== (out.set5CourtSwitched === true)) {
        out.set5CourtSwitched = left !== out.set5LeftTeam
      } else {
        out.set5LeftTeam = reached8 ? flipAB(left) : left
        out.set5CourtSwitched = reached8
      }
    } else if (left !== leftLabel(set)) {
      overrides[set] = left
    }
  }

  // A live row of the other Team A than the restored match's (a "Swap A/B"
  // made after it, at the match end): its sets without a saved side had the
  // set number's side in its labels, the same teams on the left now. Pinned,
  // or the restored labels would put the other team there (not a stale row:
  // the newer snapshot's sides stand)
  if (liveState && !liveIsStale && (liveTeamAKey === 'home' || liveTeamAKey === 'away') && liveTeamAKey !== teamAKey) {
    for (const s of [1, 2, 3, 4]) {
      if (!isAB(overrides[s])) overrides[s] = flipAB(getLeftTeamLabelForSet(s))
    }
  }

  if (Object.keys(overrides).length) out.setLeftTeamOverrides = overrides
  return out
}

/**
 * The live row's own Team A ('home' / 'away'), from its team names against
 * the match's (domain/coinToss liveRowTeamA). It can name the other team than
 * the cloud coin toss: "Switch sides" in sets 1-4 of older versions swapped A
 * and B, the coin toss queued (sync queue) and the live state written at
 * once, so until the queue had run the cloud coin toss named the other team;
 * a "Swap A/B" in Manual adjustments at the match end changes the coin toss
 * and leaves the live row as it was. null when the names do not tell
 * (missing, or the same on both teams).
 * @param {object|null} liveState
 * @param {object} matchData  the cloud match row (home_team / away_team)
 * @returns {'home'|'away'|null}
 */
export function liveRowTeamAKey(liveState, matchData) {
  return liveRowTeamA(liveState, matchData?.home_team?.name, matchData?.away_team?.name)
}

/**
 * Is the live row older than the latest synced event (its last write failed
 * and the queue synced events after it)? false when a time is unknown.
 * @param {object|null} liveState
 * @param {Array} events  server event rows (created_at / ts)
 */
/**
 * Whether the cloud coin toss was corrected ("Swap A/B" in Manual
 * adjustments: its manual_changes entry, synced in the same job as the coin
 * toss) after the live row was written: the coin toss then names the teams,
 * not the live row, which keeps its own Team A.
 * @param {object} matchData  the cloud match row (manual_changes)
 * @param {object|null} liveState
 */
export function designationCorrectedAfterLive(matchData, liveState) {
  const liveAt = timeOf(liveState?.last_event_ts || liveState?.updated_at)
  if (liveAt == null) return false
  const changes = Array.isArray(matchData?.manual_changes) ? matchData.manual_changes : []
  return changes.some(c => c?.field === 'teamDesignation' && (timeOf(c.ts) ?? -Infinity) > liveAt)
}

function liveOlderThanEvents(liveState, events) {
  const liveAt = timeOf(liveState?.last_event_ts || liveState?.updated_at)
  if (liveAt == null) return false
  return (events || []).some(e => {
    const at = timeOf(e?.created_at || e?.ts)
    return at != null && at > liveAt
  })
}

/**
 * Which team a synced event row put on the left, from the row itself: the
 * row writer marks the serving team's lineup (position I isServing) and names
 * that team (serve_team). Rows written before 8df87d4e placed set 5 by the
 * set number (A left before the change of courts), not by its coin toss, so
 * no rule replays them. null when the row cannot tell (no serve_team, no
 * lineup, or both lineups or neither marked).
 * @param {object} row  server event row
 * @returns {boolean|null}
 */
function rowLeftIsHome(row) {
  const serving = row?.serve_team
  if (serving !== 'home' && serving !== 'away') return null
  const marked = (lineup) => !!lineup && typeof lineup === 'object' &&
    Object.values(lineup).some(p => p && typeof p === 'object' && p.isServing === true)
  const left = marked(row.lineup_left)
  if (left === marked(row.lineup_right)) return null
  return left === (serving === 'home')
}

/**
 * Fetch a match from the cloud by Game N and Game PIN.
 * POST /api/match/restore-by-pin: exact match on both, attempt-limited on the
 * server (game_pin can no longer be used as a /api/db filter). Returns the
 * match (secrets stripped), its sets (by index), events (by seq) and live state.
 * Uses JSONB columns for team/player data (teams/players tables were dropped)
 * `claim` (and `externalId`, apiMatchRestoreByPin): this device continues the
 * match; `scorerClaimed` in the result: the server made it the scoring
 * device already (importMatchFromSupabase then queues no claim).
 */
export async function fetchMatchByPin(gamePin, gameN, { claim = false, externalId = null } = {}) {
  const pin = String(gamePin ?? '').trim()
  const n = parseInt(gameN, 10)
  if (!pin || !Number.isInteger(n)) throw new Error('Game number and game PIN are required')

  const { data, error } = await apiMatchRestoreByPin(n, pin, { claim, externalId })
  if (error) {
    if (error.code === 'OV_NOT_FOUND' || error.status === 404) throw new Error('Match not found with this ID and PIN')
    if (error.code === 'OV_TOO_MANY_ATTEMPTS' || error.status === 429) {
      throw new Error('Too many attempts. Please wait a few minutes before trying again.')
    }
    throw Object.assign(new Error(error.message || 'Match lookup failed'), { code: error.code, status: error.status })
  }
  if (!data?.match) throw new Error('Match not found with this ID and PIN')

  // The server never returns the PINs; the caller just proved the game PIN.
  let matchData = { ...data.match, game_pin: pin }
  const setsResult = { data: data.sets || [] }
  let events = data.events || []
  const liveState = data.liveState || null

  console.log('[Restore] Fetched from the cloud:', {
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

  // Team A from the coin toss: the matches table has the coin_toss JSON, no
  // coin_toss_team_a column (reading only that put Team A on away always)
  let teamAKey = matchData.coin_toss?.team_a || matchData.coin_toss_team_a || 'home'
  const cloudTeamAKey = teamAKey
  // The live row's own Team A (its team names). An older version's "Switch
  // sides" in sets 1-4 swapped A and B, the coin toss queued and the live
  // state written at once, so with the swap still in the sync queue the
  // cloud coin toss names the other team: a live row not older than the
  // latest event is the scorer's latest, its Team A is the restored match's
  // (the swap as swapTeamDesignation made it: the first server kept, the A /
  // B serve flag follows). Not when the coin toss was corrected after the
  // live row ("Swap A/B" at the match end leaves the live row as it was).
  // Its side_a and lineup_a are always read for its own Team A.
  const liveTeamAKey = liveRowTeamAKey(liveState, matchData) || teamAKey
  const cloudTeamA = matchData.coin_toss?.team_a
  if ((cloudTeamA === 'home' || cloudTeamA === 'away') && liveTeamAKey !== cloudTeamA &&
      !liveOlderThanEvents(liveState, events) && !designationCorrectedAfterLive(matchData, liveState)) {
    const toss = matchData.coin_toss
    const firstServe = toss.first_serve === 'home' || toss.first_serve === 'away'
      ? toss.first_serve
      : (typeof toss.serve_a === 'boolean' ? (toss.serve_a ? cloudTeamA : liveTeamAKey) : null)
    teamAKey = liveTeamAKey
    matchData = {
      ...matchData,
      coin_toss: {
        ...toss,
        team_a: liveTeamAKey,
        team_b: cloudTeamA,
        ...(firstServe ? { serve_a: firstServe === liveTeamAKey, first_serve: firstServe } : {}),
        ...(firstServe && 'serve_b' in toss ? { serve_b: firstServe === cloudTeamA } : {})
      }
    }
  }
  const liveAIsHome = liveTeamAKey === 'home'
  // The match's court sides as the scorer last saved them: the imported
  // match keeps them, and they place a row's court-side lineups below
  const courtSides = savedCourtSides(events, liveState, teamAKey, liveTeamAKey)

  // If no lineup type events, create them from event lineup_left/lineup_right columns
  // or from match_live_state
  if (!hasLineupTypeEvents) {

    // First try: get lineup from the latest event that has lineup_left/lineup_right
    const eventWithLineup = [...events]
      .sort((a, b) => (b.seq || 0) - (a.seq || 0))
      .find(e => e.lineup_left || e.lineup_right)

    if (eventWithLineup) {
      const setIndex = eventWithLineup.set_index || 1
      // lineup_left / lineup_right are by court side. The event's state
      // snapshot has the lineups by team (A / B), so no side is guessed: the
      // set number (odd: A left) is wrong in set 5 whenever its coin toss put
      // B on the left, and after its change of courts at 8. Without a
      // snapshot (an older row), the side the row itself marks (the serving
      // team's lineup), else the court's rule (getSideAForSet) with the
      // match's saved sides (set 5's coin toss and change of courts included).
      const snap = eventWithLineup.state_snapshot
      // (the snapshot's own set only: one taken in another set has that set's lineups)
      const bySnapshot = !!(snap && (snap.lineupA || snap.lineupB) &&
        (snap.currentSetIndex == null || Number(snap.currentSetIndex) === Number(setIndex)))
      // The row's own Team A: its snapshot's, else the cloud coin toss's (a
      // row synced before a swap still in the sync queue, not the live row's
      // Team A the restored match takes): its lineupA / lineupB. The court
      // sides are the restored match's, in its Team A (a "Swap A/B" keeps
      // each team on its side: savedCourtSides)
      const rowTeamAKey = snap?.teamAKey === 'home' || snap?.teamAKey === 'away' ? snap.teamAKey : cloudTeamAKey
      const snapAIsHome = rowTeamAKey === 'home'
      const markedLeft = rowLeftIsHome(eventWithLineup)
      const leftIsHome = markedLeft !== null
        ? markedLeft
        : (getSideAForSet(Number(setIndex), courtSides) === 'left') === (teamAKey === 'home')

      const homeRawLineup = bySnapshot
        ? (snapAIsHome ? snap.lineupA : snap.lineupB)
        : (leftIsHome ? eventWithLineup.lineup_left : eventWithLineup.lineup_right)
      const awayRawLineup = bySnapshot
        ? (snapAIsHome ? snap.lineupB : snap.lineupA)
        : (leftIsHome ? eventWithLineup.lineup_right : eventWithLineup.lineup_left)
      const homeLineup = extractLineupNumbers(homeRawLineup)
      const awayLineup = extractLineupNumbers(awayRawLineup)
      const homeLiberoSub = extractLiberoSubstitution(homeRawLineup)
      const awayLiberoSub = extractLiberoSubstitution(awayRawLineup)

      console.log('[Restore] Creating lineup from event lineup_left/lineup_right:', {
        eventSeq: eventWithLineup.seq,
        setIndex,
        bySnapshot,
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
        liveAIsHome,
        lineupANumbers,
        lineupBNumbers,
        liberoSubA,
        liberoSubB,
        rawLineupA: liveState.lineup_a,
        rawLineupB: liveState.lineup_b
      })

      if (lineupANumbers) {
        const payload = {
          team: liveAIsHome ? 'home' : 'away',
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
          team: liveAIsHome ? 'away' : 'home',
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
    liveState, // Include live state for additional data
    // The court sides the scorer last saved (setLeftTeamOverrides /
    // set5LeftTeam / set5CourtSwitched): the imported match keeps them
    courtSides,
    // The highest set / event ids the match has used on the server (voided
    // events included): the ids the importing device gives out stay above
    idFloor: data.idFloor || null,
    // This device scores the match already (asked with claim, db/019)
    scorerClaimed: data.scorer?.mine === true
  }
}

/**
 * The restore dialog's Confirm on the match found by game number and PIN:
 * this device continues it. The match is read again, with the claim: the
 * server makes the device its scorer first (signed in or not; signed out,
 * the queued claim never went through and the relay refused the device's
 * syncs, 2026-10-26), then reads it, so a rally of the previous device is
 * either in what is imported or refused - not sent between the read and
 * the claim and then overwritten. The preview was read when the scorer
 * searched; the match as it is now is imported. Offline, refused, or another
 * match found: the preview, and the claim is queued as before.
 * @param {object} preview  fetchMatchByPin's result shown in the preview
 * @returns {Promise<object>} cloudData for importMatchFromSupabase
 */
export async function fetchMatchToContinue(preview) {
  const m = preview?.match
  const ext = m?.external_id
  if (!ext || m.game_pin == null || m.game_n == null) return preview
  try {
    const fresh = await fetchMatchByPin(m.game_pin, m.game_n, { claim: true, externalId: ext })
    return fresh?.match?.external_id === ext ? fresh : preview
  } catch (err) {
    console.warn('[Restore] Could not read the match again to continue it, restoring what was previewed:', err?.message)
    return preview
  }
}

/**
 * Set 5's first server for a restored match, from its coin toss: the latest
 * set5_coin_toss event (the set 5 setup's confirmation; a restore by PIN
 * leaves undone ones out). Its team key, as the label of the restored Team A
 * (A and B may have been swapped since). No snapshot or live field carries
 * set5FirstServe, and the event, restored, hides the set 5 setup panel: set 5
 * was then served by set 1's first server (domain/rules getFirstServeForSet).
 * @param {Array} events  server event rows
 * @param {'home'|'away'} teamAKey  the restored match's Team A
 * @returns {{ set5FirstServe?: 'A'|'B' }}
 */
export function set5TossFromEvents(events, teamAKey) {
  const toss = [...(events || [])]
    .filter(e => e?.type === 'set5_coin_toss')
    .sort((a, b) => (b.seq || 0) - (a.seq || 0))[0]
  const key = toss?.payload?.firstServeTeamKey
  const isTeam = (v) => v === 'home' || v === 'away'
  if (!isTeam(key) || !isTeam(teamAKey)) return {}
  return { set5FirstServe: key === teamAKey ? 'A' : 'B' }
}

/**
 * Import match data from Supabase to local Dexie
 * Uses JSONB columns for team/player data (teams/players tables were dropped)
 */
/**
 * Best of 3 or 5 of a cloud match row. The server keeps it only in
 * match_info.best_of (MatchSetup writes it there); without it a restored
 * best-of-3 match was scored as best of 5.
 */
export function cloudBestOf(match) {
  const b = Number(match?.bestOf ?? match?.best_of ?? match?.match_info?.best_of)
  return b === 3 ? 3 : 5
}

export async function importMatchFromSupabase(cloudData) {
  const { match, sets, events } = cloudData
  const courtSides = cloudData.courtSides || {}

  let importedMatchId = null

  await db.transaction('rw', db.matches, db.teams, db.players, db.sets, db.events, db.sync_queue, async () => {
    // The cloud copy REPLACES this device's own copy of the match (a join
    // with the game PIN on a device that had it, "Take back scoring here"):
    // two local copies of one match key would both sync, and the older one's
    // unsent writes would overwrite the score the other device left. Its sets
    // and events go (replaced, not undone: nothing is voided on the server),
    // its unsent jobs are superseded; other local matches are kept.
    await replaceLocalCopies(match.external_id)

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
      // Match info: prefer JSONB, fallback to legacy. All of it: the match
      // type, gender and level too (they were left out, and the sheet of a
      // match taken over on another device had only "Regional" X'd)
      ...localFromMatchInfo(matchInfo, match),
      bestOf: cloudBestOf(match),
      refereePin: match.referee_pin,
      gamePin: match.game_pin,
      gameN: match.game_n,
      gameNumber: match.game_n ? String(match.game_n) : null, // Also set gameNumber
      test: match.test || false,
      seed_key: match.external_id,
      // Its live states are stamped after the last one in the cloud, also
      // when this device's clock is behind the previous one's
      // (serverDataSync.liveClockOffset)
      liveClockOffsetMs: liveClockOffsetAfter(cloudData.liveState),
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
      // The closing ones (captains, assistant scorer, scorer, referees) in
      // the fields Match end and the sheet read: a slot missing here would
      // show "Tap to sign" again, and the next signature drawn on this
      // device sends the whole object back, which erased it on the server
      ...postMatchSignaturesFromServer(signatures),
      // Where they were made ("Signed on phone"), kept only by an approval
      signatureSources: signatureSourcesFromApproval(approval, coinToss.team_a || match.coin_toss_team_a),
      // Coin toss: prefer JSONB, fallback to legacy
      coinTossConfirmed: coinToss.confirmed !== undefined ? coinToss.confirmed : match.coin_toss_confirmed,
      coinTossTeamA: coinToss.team_a || match.coin_toss_team_a,
      coinTossTeamB: coinToss.team_b || match.coin_toss_team_b,
      coinTossServeA: coinToss.serve_a !== undefined ? coinToss.serve_a : match.coin_toss_serve_a,
      firstServe: coinToss.first_serve || match.first_serve,
      // Court sides (domain/rules getSideAForSet): without them the court
      // showed the set number's sides whatever the court was
      ...(courtSides.setLeftTeamOverrides ? { setLeftTeamOverrides: { ...courtSides.setLeftTeamOverrides } } : {}),
      ...(isAB(courtSides.set5LeftTeam) ? { set5LeftTeam: courtSides.set5LeftTeam } : {}),
      ...(typeof courtSides.set5CourtSwitched === 'boolean' ? { set5CourtSwitched: courtSides.set5CourtSwitched } : {}),
      // Set 5's first server (its coin toss, the set 5 setup's confirmation):
      // that event hides the setup panel, so without it set 5 was served
      // by set 1's first server
      ...set5TossFromEvents(events, coinToss.team_a || match.coin_toss_team_a),
      // Match result: prefer JSONB, fallback to legacy
      setResults: results.set_results || match.set_results,
      winner: results.winner || match.winner,
      finalScore: results.final_score || match.final_score,
      sanctions: results.sanctions || match.sanctions,
      // Scoresheet remarks (db/017; '' when the server has none)
      remarks: typeof match.remarks === 'string' ? match.remarks : '',
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

    // Create players from JSONB arrays (fresh teams, so no duplicates). With
    // their LFP flag: the restored sheet had lost every LFP mark
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
          isLfp: !!p.is_lfp,
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
          isLfp: !!p.is_lfp,
          createdAt: new Date().toISOString()
        })
      }
    }

    // Sets and events keep the local ids their cloud rows are keyed with
    // (`<match>:s:<id>`, `<match>:e:<id>`, utils/syncIds): every later write
    // of this device derives the external_id from the local id (the running
    // set score, the set end, an undo's revision). Imported under new ids,
    // they wrote rows the cloud did not have: device A's set 1 (':s:6')
    // stayed at the score of the hand-over for every reader while this device
    // updated ':s:1', and its new rallies (':e:32' ...) overwrote A's own
    // events once they reached A's range (stress test 2026-10-25, the game
    // 406970 scenario of db/019).
    const seedKey = match.external_id
    const setIds = sets.map(s => cloudLocalId(seedKey, 'set', s.external_id))
    // Events without an external_id are not cloud rows (the line-ups
    // fetchMatchByPin makes up from the live state): new ids, never sent
    const cloudEvents = events.filter(e => e.external_id != null)
    const eventIds = cloudEvents.map(e => cloudLocalId(seedKey, 'event', e.external_id))
    const keepIds = await idsAreFree(db.sets, setIds) && await idsAreFree(db.events, eventIds)
    // Ids this device gives out from now on stay above every id the match has
    // used on the server (voided events and revisions of events never
    // uploaded too, restore-by-pin's idFloor): a new rally under the id of an
    // event voided there is "born voided" (db/015), it would never count
    const floor = cloudData.idFloor || {}
    const setFloor = Math.max(Number(floor.set) || 0, ...setIds.map(id => id || 0))
    const eventFloor = Math.max(Number(floor.event) || 0, ...eventIds.map(id => id || 0))

    const setRow = (set) => ({
      matchId: localMatchId,
      index: set.index,
      homePoints: set.home_points,
      awayPoints: set.away_points,
      finished: set.finished,
      startTime: set.start_time,
      endTime: set.end_time,
      externalId: set.external_id
    })
    const eventRow = (event) => ({
      matchId: localMatchId,
      setIndex: event.set_index,
      type: event.type,
      payload: event.payload,
      ts: event.ts,
      seq: event.seq,
      externalId: event.external_id
    })

    // Imported as they are: no history of their own on this device
    await withoutEventHistory(localMatchId, async () => {
      const newSetIds = []
      const newEventIds = []
      if (keepIds) {
        for (let i = 0; i < sets.length; i++) await db.sets.add({ ...setRow(sets[i]), id: setIds[i] })
        for (let i = 0; i < cloudEvents.length; i++) await db.events.add({ ...eventRow(cloudEvents[i]), id: eventIds[i] })
      }
      await raiseIdGenerator(db.sets, setFloor, { matchId: localMatchId, index: 0 })
      await raiseIdGenerator(db.events, eventFloor, { matchId: localMatchId, type: 'rally_start', setIndex: 0, seq: 0 })
      if (!keepIds) {
        for (const set of sets) newSetIds.push(await db.sets.add(setRow(set)))
        for (const event of cloudEvents) newEventIds.push(await db.events.add(eventRow(event)))
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

      for (const event of events) {
        if (event.external_id == null) await db.events.add(eventRow(event))
      }

      if (!keepIds && !match.test) {
        // Another local match holds one of the ids (or a cloud id is not this
        // match's own): the cloud rows move to this device's new ids instead,
        // in one server transaction (POST /api/match/restore, as a backup
        // restore does; test matches never sync). `rekey` names the cloud id
        // each row had: the server renames those rows in place and deletes
        // nothing else (the match's voided events, a row sent after this
        // read); an older server ignores it and replaces the whole match.
        console.warn(`[Import] ${seedKey}: the cloud ids cannot be kept on this device; re-keying the cloud rows`)
        const newSetExt = sets.map((s, i) => setExtId(seedKey, newSetIds[i]))
        const newEventExt = cloudEvents.map((e, i) => eventExtId(seedKey, newEventIds[i]))
        await db.sync_queue.add({
          resource: 'match',
          action: 'restore',
          payload: {
            match: filterMatchPayload({ external_id: seedKey, status: match.status }),
            sets: sets.map((s, i) => ({ ...cloudChildRow(s), external_id: newSetExt[i] })),
            events: cloudEvents.map((e, i) => ({ ...cloudChildRow(e), external_id: newEventExt[i] })),
            liveState: cloudData.liveState ? cloudChildRow(cloudData.liveState) : null,
            rekey: {
              sets: Object.fromEntries(sets.map((s, i) => [newSetExt[i], s.external_id])),
              events: Object.fromEntries(cloudEvents.map((e, i) => [newEventExt[i], e.external_id]))
            }
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }
    })
  })

  // (restore-by-pin with claim made this device the scorer already)
  await afterJoin(importedMatchId, { claim: cloudData.scorerClaimed !== true })
  return importedMatchId
}

// The local id a cloud set/event row of match `seedKey` is keyed with
// (`<seedKey>:s:<id>` / `<seedKey>:e:<id>`), or null
function cloudLocalId(seedKey, kind, externalId) {
  const p = parseExtId(externalId)
  return p && p.seedKey === seedKey && p.kind === kind && Number.isSafeInteger(p.localId) && p.localId > 0 ? p.localId : null
}

// Can rows be stored under these ids: each one its own, none in use?
async function idsAreFree(table, ids) {
  if (ids.some(id => id == null) || new Set(ids).size !== ids.length) return false
  if (ids.length === 0) return true
  const rows = await table.bulkGet(ids)
  return rows.every(row => row === undefined)
}

// Make `table` give out ids above `floor` from now on. IndexedDB moves its
// key generator past every numeric key added explicitly, so a row is added
// under `floor` and removed again; an id in use means it is past it already.
async function raiseIdGenerator(table, floor, row) {
  if (!Number.isSafeInteger(floor) || floor <= 0) return
  if ((await table.get(floor)) !== undefined) return
  await table.add({ ...row, id: floor })
  await table.delete(floor)
}

// A cloud row as a restore job sends it back: the server's own keys left out
// eslint-disable-next-line no-unused-vars
const cloudChildRow = ({ id: _id, match_id: _matchId, updated_at: _updated, ...row }) => row

// Remove the local copies of match `externalId` (inside the caller's
// transaction: matches, sets, events, sync_queue); their unsent jobs are
// superseded by the cloud copy.
async function replaceLocalCopies(externalId) {
  if (!externalId) return 0
  const previous = await db.matches.filter(m => localMatchKey(m) === externalId).toArray()
  if (!previous.length) return 0
  for (const old of previous) {
    await wipeMatchEvents(db, old.id)
    await db.sets.where('matchId').equals(old.id).delete()
    await db.matches.delete(old.id)
  }
  const open = await db.sync_queue.where('status').anyOf('queued', 'error', 'failed').toArray()
  // (the writes of the match's score; a "My Matches" link still goes)
  const ids = open.filter(j => ['match', 'set', 'event'].includes(j.resource) && jobMatchKey(j) === externalId).map(j => j.id)
  for (const id of ids) await db.sync_queue.update(id, { status: 'superseded', superseded_by: 'cloud-copy' })
  console.log(`[Import] Replaced ${previous.length} local copy/copies of match ${externalId} with the cloud copy (${ids.length} unsent job(s) superseded)`)
  return previous.length
}

/**
 * This device continues a cloud match (a restore by game PIN, a backup
 * restore; utils/matchHandover): it becomes the match's scoring device (the
 * claim job; a backup restore claims through its restore job instead), and
 * this device's own refused copy of the same game is retired. Never throws:
 * the restore itself is done.
 */
async function afterJoin(localMatchId, { claim = false } = {}) {
  try {
    const joined = localMatchId != null ? await db.matches.get(localMatchId) : null
    if (!joined) return
    if (claim) await queueScorerClaim(db, joined)
    await retireSupersededMatches(db, joined)
  } catch (err) {
    console.warn('[Restore] Could not hand the match over to this device:', err?.message)
  }
}

// A backup file's JSON; a file that is not JSON (damaged, cut off by a full
// disk) throws BACKUP_UNREADABLE_ERROR
function parseBackupText(text) {
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('Invalid JSON file'), { code: BACKUP_UNREADABLE_ERROR })
  }
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
          description: 'JSON backup files',
          accept: { 'application/json': ['.json'] }
        }],
        multiple: false
      })
      const file = await fileHandle.getFile()
      const text = await file.text()
      return parseBackupText(text)
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
        resolve(parseBackupText(text))
      } catch (error) {
        reject(error)
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

const CLOUD_BACKUP_LIST_LIMIT = 100

/**
 * List cloud backups from Supabase storage for a match (newest first). Throws on
 * error so callers can show it.
 * @param {string} gamePin - Unused (folders are keyed by game number)
 * @param {number} gameN - The game number (default 1)
 * @returns {Array} Array of backup file info
 */
export async function listCloudBackups(gamePin, gameN = 1) {
  // Use the same path format as logger.js continuous backups
  const folderPath = `backups/backup_g${gameN}`

  // Newest first with an explicit page size: the name sort is not chronological
  // (scores are unpadded), so the default page could miss the latest backups.
  const { data, error } = await apiStorage
    .from('backup')
    .list(folderPath, {
      limit: CLOUD_BACKUP_LIST_LIMIT,
      sortBy: { column: 'created_at', order: 'desc' }
    })

  if (error) throw error

  // Parse filenames to extract useful info
  // Format: backup_g785111_set2_scoreleft23_scoreright23_20260105_113229_798.json
  const backups = (data || [])
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
          created_at: f.created_at,
          size: f.metadata?.size || 0
        }
      }
      // Fallback for files that don't match the pattern
      return {
        name: f.name,
        path: `${folderPath}/${f.name}`,
        created: f.created_at,
        created_at: f.created_at,
        size: f.metadata?.size || 0
      }
    })

  // Chronological order from the timestamp in the name (yyyymmdd_hhmmss_ms),
  // falling back to the storage created_at.
  const sortKey = (b) => {
    if (b.date && b.time) return `${b.date}${b.time}${b.ms || '000'}`
    const t = b.created ? new Date(b.created) : null
    return t && !isNaN(t) ? t.toISOString().replace(/\D/g, '').slice(0, 17) : ''
  }
  return backups.sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
}

/**
 * Fetch a cloud backup file content
 * @param {string} path - Full path to the backup file
 * @returns {Object} Parsed JSON backup data
 */
export async function fetchCloudBackup(path) {
  const { data, error } = await apiStorage
    .from('backup')
    .download(path)

  if (error) throw error

  const text = await data.text()
  return JSON.parse(text)
}

/**
 * Get backup settings from localStorage. The apps (native: true) keep their own
 * switch, on by default; browsers default to off.
 */
const autoBackupKey = (native) => (native ? 'nativeAutoBackupEnabled' : 'autoBackupEnabled')

export function getBackupSettings({ native = false } = {}) {
  const stored = localStorage.getItem(autoBackupKey(native))
  return {
    autoBackupEnabled: stored === null ? native : stored === 'true',
    backupFrequencyMinutes: parseInt(localStorage.getItem('backupFrequencyMinutes') || '5', 10)
  }
}

/**
 * Save backup settings to localStorage
 */
export function saveBackupSettings(settings, { native = false } = {}) {
  if (settings.autoBackupEnabled !== undefined) {
    localStorage.setItem(autoBackupKey(native), String(settings.autoBackupEnabled))
  }
  if (settings.backupFrequencyMinutes !== undefined) {
    localStorage.setItem('backupFrequencyMinutes', String(settings.backupFrequencyMinutes))
  }
}

/**
 * List matches stored in PocketBase (server-side backup)
 * @param {number} gameN - Game number to filter by (optional)
 * @returns {Array} Array of backup entries compatible with BackupTable
 */
export async function listPocketBaseBackups(gameN) {
  const params = new URLSearchParams()
  if (gameN) params.set('game_number', String(gameN))
  const url = getCloudApiUrl(`/api/pocketbase/matches?${params.toString()}`)
  if (!url) return []
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const { data } = await res.json()
    return (data || []).map(record => {
      const lastSet = record.sets?.at?.(-1)
      return {
        source: 'pocketbase',
        match_id: record.match_id,
        name: `Game #${record.game_number || '?'} — ${record.home_team?.name || 'Home'} vs ${record.away_team?.name || 'Away'}`,
        gameN: record.game_number,
        status: record.status,
        updated_at: record.updated_at,
        created: record.updated_at,
        setIndex: record.sets?.length || 0,
        leftScore: lastSet?.homePoints ?? lastSet?.home_points ?? 0,
        rightScore: lastSet?.awayPoints ?? lastSet?.away_points ?? 0,
      }
    })
  } catch {
    return []
  }
}

/**
 * Fetch full match snapshot from PocketBase for restoration
 * @param {string} matchId - The PocketBase match_id
 * @param {string} [gamePin] - The match's game PIN; the backend returns the
 *   connection PINs (referee / bench) only to a caller that presents it.
 * @returns {Object} Match data in standard restore format
 */
export async function fetchPocketBaseMatch(matchId, gamePin) {
  const query = gamePin ? `?gamePin=${encodeURIComponent(String(gamePin).trim())}` : ''
  const url = getCloudApiUrl(`/api/pocketbase/matches/${encodeURIComponent(matchId)}${query}`)
  if (!url) throw new Error('Backend not available')
  const res = await fetch(url)
  if (res.status === 403) throw new Error('The game PIN does not match this backup')
  if (!res.ok) throw new Error('PocketBase match not found')
  const { data } = await res.json()
  return {
    version: 1,
    match: data.match_data,
    homeTeam: data.home_team,
    awayTeam: data.away_team,
    homePlayers: data.home_players,
    awayPlayers: data.away_players,
    sets: data.sets,
    events: data.events,
  }
}
