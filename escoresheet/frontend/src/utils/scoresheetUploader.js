import { apiStorage } from '../lib/apiClient'

/**
 * Upload scoresheet data as JSON to Supabase storage.
 * PDFs are generated on-demand at scoresheet.openvolley.app/storage
 * Uploads to: scoresheets/{scheduled_date}/game{n}.json (or game{n}_final.json if final=true)
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

    // Determine storage path: {scheduled_date}/game{n}.json or game{n}_final.json
    const scheduledDate = match.scheduledAt
      ? new Date(match.scheduledAt).toISOString().slice(0, 10) // YYYY-MM-DD
      : new Date().toISOString().slice(0, 10)

    const gameNumber = match.gameNumber || match.externalId || match.game_n || 'unknown'
    const suffix = final ? '_final' : ''
    const storagePath = `${scheduledDate}/game${gameNumber}${suffix}.json`

    // Upload to Supabase storage
    const { error: uploadError } = await apiStorage
      .from('scoresheets')
      .upload(storagePath, jsonBlob, {
        contentType: 'application/json',
        upsert: true // Overwrite if exists
      })

    if (uploadError) {
      console.warn('[scoresheetUploader] Failed to upload:', uploadError)
      return { success: false, error: uploadError.message }
    }

    console.log('[scoresheetUploader] Uploaded successfully:', storagePath)
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
        console.log('[scoresheetUploader] Background upload complete:', result.path)
      } else {
        console.warn('[scoresheetUploader] Background upload failed:', result.error)
      }
    })
    .catch(err => {
      console.error('[scoresheetUploader] Background upload error:', err)
    })
}
