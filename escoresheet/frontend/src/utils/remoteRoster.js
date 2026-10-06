/**
 * Remote roster upload (coach -> Upload Roster app -> backend -> scorer).
 *
 * The coach's upload goes to POST /api/match/upload-roster, authorised by the
 * team's upload PIN of that match; the backend stores it in the match row as
 * connections.pending_home_roster / pending_away_roster (backend README
 * "Who may write a match"). The scorer reads it back from its own match row
 * and accepts or rejects it in Match Setup.
 *
 * For the PIN check to work the server must know the upload PINs as soon as
 * the scorer shows them, i.e. from "Create match" on: every match write
 * carries the full connection_pins built from the local match
 * (utils/connectionPins.js); the server stores them hashed (lib/pinHash.js).
 */
import { buildConnectionPins } from './connectionPins'
import { generateSecurePin } from './stringUtils'

// Local field -> connection_pins key, in the order they are generated
const PIN_FIELDS = [
  ['refereePin', 'referee'],
  ['homeTeamPin', 'bench_home'],
  ['awayTeamPin', 'bench_away'],
  ['homeTeamUploadPin', 'upload_home'],
  ['awayTeamUploadPin', 'upload_away']
]

const filled = (v) => v !== undefined && v !== null && String(v).trim() !== ''

/**
 * The connection PINs a local match is missing (referee, benches, uploads),
 * freshly generated and distinct from the ones it has. {} when complete.
 * @param {object|null|undefined} localMatch - Dexie match
 * @param {(existing: string[]) => string} [generate]
 */
export function missingConnectionPins(localMatch, generate = generateSecurePin) {
  const existing = PIN_FIELDS.map(([f]) => localMatch?.[f]).filter(filled).map((v) => String(v).trim())
  const updates = {}
  for (const [field] of PIN_FIELDS) {
    if (filled(localMatch?.[field])) continue
    const pin = String(generate(existing)).trim()
    updates[field] = pin
    existing.push(pin)
  }
  return updates
}

/**
 * A sync-queue job that writes the match's full connection_pins (the queue
 * fills them from the local match when it runs, see useSyncQueue
 * withFullConnectionPins). Queued after the match insert of "Create match",
 * the per-match FIFO sends it after the row exists.
 * @param {string} seedKey - the match's external_id
 */
export function connectionPinsSyncJob(seedKey, localMatch = null) {
  return {
    resource: 'match',
    action: 'update',
    payload: { id: seedKey, connection_pins: buildConnectionPins(localMatch) },
    ts: new Date().toISOString(),
    status: 'queued'
  }
}

const PENDING_KEY = { home: 'pending_home_roster', away: 'pending_away_roster' }

/**
 * Read the roster a coach uploaded for this match: the scorer's own match row
 * (external_id = seed key), connections.pending_{team}_roster. The scorer is
 * the match's creator or editor, so the backend returns its connections.
 * @param {(table: string) => any} from - apiFrom
 * @param {string} seedKey
 * @param {'home'|'away'} team
 * @returns {Promise<{ roster: object|null, error: object|null }>}
 */
export async function fetchPendingRoster(from, seedKey, team) {
  const key = PENDING_KEY[team]
  if (!key) throw new Error(`fetchPendingRoster: unknown team ${team}`)
  if (!seedKey) return { roster: null, error: null }
  const { data, error } = await from('matches')
    .select('connections')
    .eq('external_id', seedKey)
    .maybeSingle()
  if (error) return { roster: null, error }
  const roster = data?.connections?.[key]
  return { roster: roster && typeof roster === 'object' && !Array.isArray(roster) ? roster : null, error: null }
}

/**
 * A sync-queue job that clears the pending roster on the server once the
 * scorer accepted or rejected it, so the next search does not bring it back.
 * The match update merges connections, so the other keys stay.
 */
export function clearPendingRosterJob(seedKey, team) {
  const key = PENDING_KEY[team]
  if (!key) throw new Error(`clearPendingRosterJob: unknown team ${team}`)
  return {
    resource: 'match',
    action: 'update',
    payload: { id: seedKey, connections: { [key]: null } },
    ts: new Date().toISOString(),
    status: 'queued'
  }
}

/**
 * Upload Roster app: does the roster also go to the relay's PATCH
 * /api/match/:id? Only on a LAN / desktop relay (the app found the match over
 * the relay). The cloud backend has no PATCH route (and its CORS refuses the
 * method), and the cloud upload already reached the scorer's match row.
 * @param {'supabase'|'websocket'|null} activeConnection
 */
export function rosterGoesToRelay(activeConnection) {
  return activeConnection !== 'supabase'
}

/** A scorer date of birth the coin toss accepts (not empty, not the 01.01.1900 placeholder). */
export function isKnownDob(dob) {
  if (!filled(dob)) return false
  const s = String(dob).trim()
  return s !== '01.01.1900' && s !== '01/01/1900' && s !== '1900-01-01'
}
