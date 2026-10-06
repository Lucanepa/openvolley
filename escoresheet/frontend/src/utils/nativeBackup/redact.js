/**
 * What the app backup files leave out of the match row, and what the
 * coalescing key ignores.
 *
 * The files are written to a folder the tablet owner (and on Android 10 and
 * older, other apps) can read, and on Android they stay after an uninstall.
 * Connection PINs and session ids are access secrets, not scoring data: a
 * restore keeps the PINs of the local copy it replaces or makes new ones
 * (backupManager.restoreMatchFromJson). The cloud and the "download backup"
 * file are unchanged.
 */

import { VOLATILE_MATCH_KEY } from './matchWriteHook'

// The match-row PINs (serverDataSync RELAY_PIN_FIELDS + cloud spellings)
export const MATCH_SECRET_FIELDS = [
  'gamePin', 'game_pin',
  'refereePin', 'referee_pin',
  'homeTeamPin', 'awayTeamPin',
  'homeTeamUploadPin', 'awayTeamUploadPin',
  'connection_pins', 'connectionPins',
  'sessionId', 'session_id'
]
// Any other PIN- or session-id-like key, so a new field is never written by accident
const SECRET_KEY = /(^|[a-z0-9_])pins?$|session_?id$|token$|secret/i

/** Marker in the file: the restore must not expect PINs in it. */
export const SECRETS_REMOVED = 'secretsRemoved'

/** The match row without PINs and session ids (a copy). */
export function redactMatch(match) {
  if (!match || typeof match !== 'object') return match
  const out = {}
  for (const [key, value] of Object.entries(match)) {
    if (MATCH_SECRET_FIELDS.includes(key) || SECRET_KEY.test(key)) continue
    out[key] = value
  }
  return out
}

/** The match row without its bookkeeping fields (heartbeats, sessions, sync stamps, updatedAt). */
export function stableMatch(match) {
  if (!match || typeof match !== 'object') return match
  const out = {}
  for (const [key, value] of Object.entries(match)) {
    if (!VOLATILE_MATCH_KEY.test(key)) out[key] = value
  }
  return out
}
