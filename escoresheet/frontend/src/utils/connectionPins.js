/**
 * connection_pins (matches JSONB column) built from the local Dexie match.
 *
 * The /api/db proxy strips connection_pins from every read, so a client
 * read-merge-write always starts from {} and a partial update (one role's PIN)
 * erases the other roles' PINs on the server, where validate-connection-pin reads
 * them. The local match is the source of truth for PINs, so every write sends the
 * full object instead.
 */
export function buildConnectionPins(localMatch) {
  if (!localMatch) return {}
  const pins = {
    referee: localMatch.refereePin,
    bench_home: localMatch.homeTeamPin,
    bench_away: localMatch.awayTeamPin,
    upload_home: localMatch.homeTeamUploadPin,
    upload_away: localMatch.awayTeamUploadPin
  }
  const out = {}
  for (const [key, value] of Object.entries(pins)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') out[key] = String(value).trim()
  }
  return out
}
