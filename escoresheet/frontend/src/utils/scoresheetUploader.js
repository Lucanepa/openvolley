import { apiStorage } from '../lib/apiClient'
import { scoresheetGameId, scoresheetObjectPath, redactScoresheetPath } from '../../scoresheet_pdf/utils/scoresheetStorage'
import { getScoresheetKey } from './scoresheetKey'

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
    // Prepare scoresheet data as JSON
    const scoresheetData = {
      match,
      homeTeam,
      awayTeam,
      homePlayers,
      awayPlayers,
      sets,
      events,
      uploadedAt: new Date().toISOString()
    }

    // Convert to JSON string
    const jsonString = JSON.stringify(scoresheetData)
    const jsonBlob = new Blob([jsonString], { type: 'application/json' })

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
