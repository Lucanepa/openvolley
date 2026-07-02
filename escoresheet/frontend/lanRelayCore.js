/**
 * lanRelayCore — shared helpers for the two frontend LAN-relay runtimes
 * (server.js, the standalone/prod static+WS server, and vite-plugin-api-routes.js,
 * the dev-server replica). Extracting these prevents the drift the review found,
 * where match-PIN redaction existed in one relay but not the other.
 */

// Secret fields on a match object that must never be returned to a client.
// PINs are the connection gate for referee/bench, so they are stripped from
// every match-returning response.
export const MATCH_SECRET_FIELDS = [
  'refereePin', 'homeTeamPin', 'awayTeamPin',
  'homeTeamUploadPin', 'awayTeamUploadPin',
  'connection_pins', 'connectionPins', 'game_pin', 'gamePin',
]

/**
 * Return a shallow copy of a match object with all PIN/secret fields removed.
 * @param {any} match
 */
export function stripMatchSecrets(match) {
  if (!match || typeof match !== 'object') return match
  const clean = { ...match }
  for (const k of MATCH_SECRET_FIELDS) delete clean[k]
  return clean
}

/**
 * Strip secrets from a stored match-data bundle ({ match, homeTeam, ... }),
 * redacting the nested `match` object which is where the PINs live.
 * @param {any} matchData
 */
export function stripMatchDataSecrets(matchData) {
  if (!matchData || typeof matchData !== 'object') return matchData
  return { ...matchData, match: stripMatchSecrets(matchData.match) }
}
