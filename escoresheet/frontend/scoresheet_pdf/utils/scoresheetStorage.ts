/**
 * Approved scoresheets in cloud storage: where they live and who may read them.
 *
 * The scorer app uploads the approved match to
 *   scoresheets/{YYYY-MM-DD}/game{n}_final.json
 * (scoresheetUploader: the UTC date of scheduledAt, n = the game number). The
 * backend serves such a file ONLY to the signed-in account that uploaded it
 * (backend/lib/storage.js uploaderReadBuckets, backend/README "Who can read a
 * scoresheet"): no session -> 401, another account -> 403
 * OV_STORAGE_FORBIDDEN, a missing file -> OV_STORAGE_NOT_FOUND.
 */

export const finalScoresheetPath = (date: string, game: string | number) => `${date}/game${game}_final.json`

/**
 * Viewer URL (scorer app origin, where the session lives) of a match's approved
 * scoresheet, from a cloud matches row; null when it cannot be located (no
 * scheduled date or game number) or the match is not final yet.
 */
export function finalScoresheetUrl(match: { status?: string | null, scheduled_at?: string | null, game_n?: number | string | null } | null | undefined): string | null {
  if (!match || match.status !== 'final') return null
  if (match.game_n === null || match.game_n === undefined || match.game_n === '') return null
  const when = match.scheduled_at ? new Date(match.scheduled_at) : null
  if (!when || Number.isNaN(when.getTime())) return null
  const date = when.toISOString().slice(0, 10)
  return `/scoresheet/?date=${encodeURIComponent(date)}&game=${encodeURIComponent(String(match.game_n))}`
}

export type ScoresheetLoadError = { kind: 'signin' | 'forbidden' | 'notfound' | 'offline' | 'error', title: string, message: string }

/** What to tell the viewer when the storage download of a scoresheet failed. */
export function describeScoresheetLoadError(error: { status?: number, code?: string, message?: string, network?: boolean } | null | undefined, storagePath: string): ScoresheetLoadError {
  const status = error?.status
  const code = error?.code
  if (status === 401 || code === 'missing_token' || code === 'invalid_token') {
    return {
      kind: 'signin',
      title: 'Sign-in Required',
      message: 'Approved scoresheets can only be opened by the scorer account that uploaded them. Sign in to the scorer app with that account and open the match from My Matches.'
    }
  }
  if (status === 403 || code === 'OV_STORAGE_FORBIDDEN') {
    return {
      kind: 'forbidden',
      title: 'Not Your Scoresheet',
      message: 'This scoresheet can only be opened by the scorer account that uploaded it.'
    }
  }
  if (status === 404 || code === 'OV_STORAGE_NOT_FOUND') {
    return { kind: 'notfound', title: 'Scoresheet Not Found', message: `Scoresheet not found: ${storagePath}` }
  }
  if (error?.network || status === 0) {
    return { kind: 'offline', title: 'Server Not Reachable', message: 'The scoresheet could not be loaded: the server is not reachable. Check the connection and try again.' }
  }
  return { kind: 'error', title: 'Scoresheet Not Available', message: error?.message || 'Failed to load scoresheet' }
}
