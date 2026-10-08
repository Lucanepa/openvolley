/**
 * matchRepository — single source of truth for how a match/set/event/live_state
 * is shaped and written to Supabase (via the backend proxy).
 *
 * This consolidates logic that was duplicated (and had drifted) across
 * useSyncQueue, useSequentialSync, and backupManager — e.g. the valid-columns
 * whitelist (backupManager's copy was missing `sport_type`) and the JSONB
 * merge-column list. Keeping it in one module also makes a future backend swap
 * (self-hosted Postgres / PocketBase) a single-file change.
 */

// Valid columns on the Supabase `matches` table. Payloads are filtered to these
// so stale/legacy backup formats don't send columns that don't exist.
export const VALID_MATCH_COLUMNS = [
  'external_id', 'game_n', 'game_pin', 'status', 'connections', 'connection_pins',
  'scheduled_at', 'match_info', 'officials', 'home_team', 'players_home', 'bench_home',
  'away_team', 'players_away', 'bench_away', 'coin_toss', 'results', 'signatures',
  'approval', 'test', 'created_at', 'updated_at', 'manual_changes', 'current_set',
  'set_results', 'final_score', 'sanctions', 'winner', 'sport_type',
  // db/017: the scoresheet REMARKS box (text). Not public on the server.
  'remarks'
]

// db/017's CHECK on matches.remarks (characters, not bytes)
export const REMARKS_MAX = 8000

/**
 * The remarks text as the server takes it: a string ('' when there are none),
 * at most REMARKS_MAX characters (code points, like Postgres length()). The
 * local text is never shortened; only what is sent is. The box on the sheet
 * holds far less, so this only stops a runaway text from failing its job.
 * @param {unknown} remarks
 * @returns {string}
 */
export function remarksForServer(remarks) {
  const text = typeof remarks === 'string' ? remarks : ''
  if (text.length <= REMARKS_MAX) return text
  const chars = Array.from(text)
  return chars.length <= REMARKS_MAX ? text : chars.slice(0, REMARKS_MAX).join('')
}

// JSONB columns that must be MERGED with existing values on update (not replaced),
// so concurrent writers of different fields don't clobber each other.
export const JSONB_COLUMNS = [
  'connections', 'connection_pins', 'team_a', 'team_b',
  'officials', 'coin_toss', 'set_results', 'sanctions'
]

/**
 * Keep only columns that exist on the `matches` table.
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
export function filterMatchPayload(payload) {
  if (!payload || typeof payload !== 'object') return {}
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => VALID_MATCH_COLUMNS.includes(key))
  )
}

/**
 * True if the update touches any JSONB column that needs merge-on-write.
 * @param {Record<string, unknown>} updateData
 */
export function hasJsonbColumns(updateData) {
  return JSONB_COLUMNS.some((col) => updateData && updateData[col] !== undefined)
}

/**
 * Deep-merge JSONB columns of an update over the existing row's values so
 * partial writes don't drop sibling keys. Non-JSONB fields pass through.
 * @param {Record<string, unknown>} updateData - the incoming update
 * @param {Record<string, unknown>} existing - the current row (only JSONB cols read)
 */
export function mergeJsonbColumns(updateData, existing) {
  const merged = { ...updateData }
  if (!existing) return merged
  for (const col of JSONB_COLUMNS) {
    if (updateData[col] !== undefined && existing[col] && typeof existing[col] === 'object' && typeof updateData[col] === 'object') {
      merged[col] = { ...existing[col], ...updateData[col] }
    }
  }
  return merged
}

/**
 * Queue an update of the cloud match row (sync_queue, resource 'match',
 * action 'update'): sent when the device is online, in order with the
 * match's other jobs, retried when it fails. Never for test matches or
 * matches without a seed_key. Arrays are full snapshots (they replace the
 * stored value), so an older queued update is safely superseded by a newer
 * one (useSyncQueue payloadCovers / supersedeStaleUpdates).
 * @param {import('dexie').Dexie} database
 * @param {string} seedKey the match's seed_key (cloud external_id)
 * @param {Record<string, unknown>} fields cloud columns (VALID_MATCH_COLUMNS)
 * @param {{ test?: boolean }} [opts]
 * @returns {Promise<number|null>} the job id, or null when nothing was queued
 */
export async function queueMatchUpdate(database, seedKey, fields, { test = false } = {}) {
  if (!database?.sync_queue || !seedKey || test === true) return null
  const payload = filterMatchPayload(fields)
  if (Object.keys(payload).length === 0) return null
  return database.sync_queue.add({
    resource: 'match',
    action: 'update',
    payload: { id: seedKey, ...payload },
    ts: new Date().toISOString(),
    status: 'queued'
  })
}
