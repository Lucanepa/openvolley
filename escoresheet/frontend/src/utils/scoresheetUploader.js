import { apiStorage } from '../lib/apiClient'
import { scoresheetGameId, scoresheetObjectPath, redactScoresheetPath } from '../../scoresheet_pdf/utils/scoresheetStorage'
import { getScoresheetKey } from './scoresheetKey'
import { SCORESHEET_UPLOAD_RESOURCE } from './syncIds'

/**
 * Where a match's scoresheet file goes in the 'scoresheets' bucket:
 * {scheduled UTC date}/game{n}_{key}[_final].{json|pdf}, n = scoresheetGameId
 * (game number, else external id), key = this device's random part for the
 * match (scoresheetKey.js). null when the match has no game number or id.
 */
export function scoresheetUploadPath(match, { final = false, ext = 'json' } = {}) {
  const game = scoresheetGameId(match)
  if (!game) return null
  const when = match.scheduledAt ? new Date(match.scheduledAt) : new Date()
  const date = (Number.isNaN(when.getTime()) ? new Date() : when).toISOString().slice(0, 10)
  return scoresheetObjectPath(date, game, getScoresheetKey(match), { final, ext })
}

// Never in the stored file: every PIN (gamePin, refereePin, the bench and
// upload PINs, connection_pins) and this device's session / cloud state. The
// server keeps PINs only hashed (privacy policy); the file is kept as sent.
const SHEET_DROPPED_KEY = /pins?$/i
const SHEET_DROPPED_KEYS = new Set(['sessionId', 'cloudBlock'])
// officials' contact data: the sheet shows names and roles only
const OFFICIAL_CONTACT_KEYS = ['email', 'phone', 'mobile']

/** The match row as the scoresheet file stores it (see above). */
export function scoresheetMatch(match) {
  if (!match || typeof match !== 'object') return match
  const out = {}
  for (const [k, v] of Object.entries(match)) {
    if (SHEET_DROPPED_KEY.test(k) || SHEET_DROPPED_KEYS.has(k)) continue
    out[k] = v
  }
  if (Array.isArray(out.officials)) {
    out.officials = out.officials.map((o) => {
      if (!o || typeof o !== 'object') return o
      const copy = { ...o }
      for (const k of OFFICIAL_CONTACT_KEYS) delete copy[k]
      return copy
    })
  }
  return out
}

/** The scoresheet JSON file of a match (what uploadScoresheet stores). */
export function scoresheetJsonBlob({ match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events }) {
  const scoresheetData = {
    match: scoresheetMatch(match),
    homeTeam,
    awayTeam,
    homePlayers,
    awayPlayers,
    sets,
    events,
    uploadedAt: new Date().toISOString()
  }
  return new Blob([JSON.stringify(scoresheetData)], { type: 'application/json' })
}

/**
 * A sync_queue job that stores one scoresheet file (the approval's PDF or
 * final JSON) in the 'scoresheets' bucket. The job carries the file itself (a
 * Blob, kept by IndexedDB), so the queue retries it like the match's other
 * writes until it is stored, also after Close match has removed the match
 * from this device. They were uploaded once, at the approval: an approval
 * made offline (most halls) or a connection reset left the cloud without the
 * PDF for good, with nothing but a console warning (stress test 2026-10-25).
 */
export function scoresheetUploadJob(match, path, file, contentType) {
  return {
    resource: SCORESHEET_UPLOAD_RESOURCE,
    action: 'upload',
    // match_external_id: the match the file belongs to (jobMatchKey)
    payload: { path, file, contentType, match_external_id: match?.seed_key || null },
    ts: new Date().toISOString(),
    status: 'queued'
  }
}

// A scoresheet upload job not sent yet: waiting, backing off, or refused
const UNSENT_STATUSES = ['queued', 'error', 'failed']

/**
 * Before a new approval's files are queued: the older scoresheet uploads of
 * the same match (or the same file) that were not sent yet are marked
 * 'superseded', their file dropped. Only the latest approval's files are
 * worth sending: after a reopen and a new approval both approvals use the
 * same paths, the queue sends its jobs in turn, and after the close the
 * backend keeps the approval's first PDF (db/033; replaced only within
 * minutes), so the older one could stay the match's scoresheet. A job in
 * flight ('sending') is left alone.
 * @param {object} queue - db.sync_queue
 * @param {object[]} jobs - the new scoresheetUploadJob()s
 * @returns {Promise<number>} the jobs superseded
 */
export async function supersedeUnsentScoresheetUploads(queue, jobs) {
  const paths = new Set(jobs.map(j => j.payload?.path).filter(Boolean))
  const matches = new Set(jobs.map(j => j.payload?.match_external_id).filter(Boolean))
  return supersedeUnsent(queue, j => paths.has(j.payload?.path) || matches.has(j.payload?.match_external_id))
}

/**
 * The match `matchKey` (its seed_key) is reopened: MatchEnd's Reopen match,
 * or its cloud copy loaded open again. Its scoresheet uploads not sent yet
 * are the earlier approval's: marked 'superseded', their file dropped, as
 * above. Sent while the match is open, the old PDF would be stored as the
 * next approval's (backend db/033), and after the next close the corrected
 * one is taken only for minutes. A reopened match always gets a new approval
 * with new files.
 * @param {object} queue - db.sync_queue
 * @param {string} matchKey
 * @returns {Promise<number>} the jobs superseded
 */
export async function supersedeUnsentScoresheetUploadsOf(queue, matchKey) {
  if (!matchKey || !queue) return 0
  return supersedeUnsent(queue, j => j.payload?.match_external_id === matchKey)
}

async function supersedeUnsent(queue, picks) {
  const stale = (await queue.where('resource').equals(SCORESHEET_UPLOAD_RESOURCE).toArray())
    .filter(j => UNSENT_STATUSES.includes(j.status) && picks(j))
  for (const j of stale) await queue.update(j.id, { status: 'superseded', payload: { ...j.payload, file: null } })
  return stale.length
}

/**
 * Store the file of a scoresheetUploadJob ({ data, error } as apiStorage). The
 * match goes with it: the backend stores a PDF only for a match this account
 * may write (backend db/033; 404 OV_MATCH_NOT_FOUND while the match is not in
 * the cloud yet).
 */
export function uploadQueuedScoresheet({ path, file, contentType, match_external_id: matchExternalId } = {}) {
  return apiStorage.from('scoresheets').upload(path, file, { contentType, upsert: true, matchExternalId: matchExternalId || undefined })
}

/**
 * Upload scoresheet data as JSON to the backend storage ('scoresheets' bucket).
 * Only the signed-in account that uploads it can read it back (backend README
 * "Who can read a scoresheet"). Path: see scoresheetUploadPath.
 *
 * @param {Object} options
 * @param {Object} options.match - Match data
 * @param {Object} options.homeTeam - Home team data
 * @param {Object} options.awayTeam - Away team data
 * @param {Array} options.homePlayers - Home players
 * @param {Array} options.awayPlayers - Away players
 * @param {Array} options.sets - Sets data
 * @param {Array} options.events - Events data
 * @param {boolean} options.final - If true, uploads as game{n}_final.json (approved match)
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
export async function uploadScoresheet({
  match,
  homeTeam,
  awayTeam,
  homePlayers,
  awayPlayers,
  sets,
  events,
  final = false
}) {
  // Skip if no match
  if (!match) {
    console.log('[scoresheetUploader] Skipping - no match')
    return { success: false, error: 'No match' }
  }

  // Skip test matches
  if (match.test) {
    console.log('[scoresheetUploader] Skipping test match')
    return { success: false, error: 'Test match' }
  }

  try {
    const jsonBlob = scoresheetJsonBlob({ match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events })

    const storagePath = scoresheetUploadPath(match, { final })
    if (!storagePath) {
      console.warn('[scoresheetUploader] Skipping - match has no game number or id')
      return { success: false, error: 'No game number' }
    }

    const { error: uploadError } = await apiStorage
      .from('scoresheets')
      .upload(storagePath, jsonBlob, {
        contentType: 'application/json',
        upsert: true // replaces this device's earlier upload of the same match
      })

    if (uploadError) {
      console.warn('[scoresheetUploader] Failed to upload:', uploadError)
      return { success: false, error: uploadError.message }
    }

    console.log('[scoresheetUploader] Uploaded successfully:', redactScoresheetPath(storagePath))
    return { success: true, path: storagePath }

  } catch (error) {
    console.error('[scoresheetUploader] Error:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Upload scoresheet in the background (fire and forget)
 * Logs result but doesn't block the caller
 */
export function uploadScoresheetAsync(options) {
  uploadScoresheet(options)
    .then(result => {
      if (result.success) {
        console.log('[scoresheetUploader] Background upload complete:', redactScoresheetPath(result.path))
      } else {
        console.warn('[scoresheetUploader] Background upload failed:', result.error)
      }
    })
    .catch(err => {
      console.error('[scoresheetUploader] Background upload error:', err)
    })
}
