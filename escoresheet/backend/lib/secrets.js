/**
 * Secret database columns. server.js uses these to scrub /api/db responses,
 * and realtimeHub uses them (through its `redact` option) so db-change events
 * never carry them. Keep the one list here so both paths stay in step.
 *
 * Match PINs are the only access-control gate for referee/bench, so they are
 * stripped from every response (validation happens server-side via
 * /api/match/validate-connection-pin).
 */
export const SECRET_COLUMNS = Object.freeze({
  matches: Object.freeze(['game_pin', 'connection_pins']),
  events: Object.freeze(['game_pin']),
  match_live_state: Object.freeze(['game_pin', 'connection_pins'])
})

/**
 * Delete the secret columns of `table` from a row or an array of rows.
 * Mutates and returns its argument (null/undefined pass through).
 * @template T
 * @param {string} table
 * @param {T} rows
 * @returns {T}
 */
export function redactSecrets(table, rows) {
  const secrets = Object.prototype.hasOwnProperty.call(SECRET_COLUMNS, table) ? SECRET_COLUMNS[table] : null
  if (!secrets || rows == null) return rows
  const scrub = (row) => {
    if (row && typeof row === 'object') {
      for (const k of secrets) delete row[k]
    }
    return row
  }
  return Array.isArray(rows) ? rows.map(scrub) : scrub(rows)
}
