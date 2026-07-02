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
  'set_results', 'final_score', 'sanctions', 'winner', 'sport_type'
]

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
