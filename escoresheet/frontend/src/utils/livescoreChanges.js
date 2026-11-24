/**
 * Livescore list reducer for realtime match_live_state changes.
 *
 * Rows are keyed by match_id. The relay realtime shim (lib/relayRealtime.js)
 * delivers changes from two sources: the HTTP write-through and the
 * scoreboard's relay live-state-update. A relay UPDATE carries only the
 * live-state columns, and may arrive for a game this list has not loaded yet
 * (the write-through of the first upsert can lose the race), so:
 *   - INSERT and UPDATE both upsert by match_id;
 *   - an existing row is merged ({...old, ...new}) so the joined `matches`
 *     (set_results) from the initial select survives;
 *   - an UPDATE for an unknown match_id is treated as an insert;
 *   - rows with match_status 'probe' (the monitoring canary) are never shown.
 */

export const isProbeRow = (row) => row?.match_status === 'probe'

/** Drop probe rows from a fetched list. */
export function visibleGames(rows) {
  return (rows || []).filter((g) => g && !isProbeRow(g))
}

/**
 * @param {object[]} games  current list (newest first)
 * @param {{eventType: string, new?: object, old?: object}} payload
 * @returns {object[]} the next list (the same array when nothing changed)
 */
export function applyLiveChange(games, payload) {
  const type = payload?.eventType
  if (type === 'DELETE') {
    const id = payload.old?.match_id
    if (id == null) return games
    const next = games.filter((g) => g.match_id !== id)
    return next.length === games.length ? games : next
  }
  if (type !== 'INSERT' && type !== 'UPDATE') return games
  const row = payload.new
  if (!row || row.match_id == null) return games
  const index = games.findIndex((g) => g.match_id === row.match_id)
  if (isProbeRow(row)) {
    return index === -1 ? games : games.filter((_, i) => i !== index)
  }
  if (index === -1) return [row, ...games]
  const next = games.slice()
  next[index] = { ...games[index], ...row }
  return next
}
