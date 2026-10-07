/**
 * lanRelayCore — ESM entry for the shared LAN relay protocol used by server.js
 * (standalone/prod static+WS server) and vite-plugin-api-routes.js (dev-server
 * replica). The implementation lives in ./electron/lanRelayCore.cjs so the
 * packaged Electron relay can require() the very same code; see that file for
 * the wire protocol. Extracting it prevents the drift the review found, where
 * PIN redaction and message shapes differed between relays.
 */
import core from './electron/lanRelayCore.cjs'
import signCore from './electron/signSessionCore.cjs'

export const {
  MATCH_SECRET_FIELDS,
  WS_MAX_PAYLOAD,
  MAX_BODY_SIZE,
  stripMatchSecrets,
  stripMatchDataSecrets,
  PERSON_PRIVATE_FIELDS,
  MATCH_PRIVATE_FIELDS,
  MATCH_ROSTER_FIELDS,
  publicMatch,
  publicPeople,
  normalizeMatchId,
  gamePinOf,
  relayKeyOf,
  carryMatchSecrets,
  toWireBundle,
  matchDataMessage,
  relaySummaryBundle,
  pinGrantsAccess,
  SUMMARY_MATCH_FIELDS,
  SUMMARY_TEAM_FIELDS,
  SUMMARY_SET_FIELDS,
  matchListEntry,
  createRateLimiter,
  createLocalAddressCheck,
  createMainInstanceGate,
  OTHER_COURT_COOKIE,
  MAX_OWNED_PER_IP,
} = core

/**
 * One relay instance, with Sign on phone (/api/sign/*) wired to
 * ./electron/signSessionCore.cjs (the .cjs core may not require() it).
 * @param {Parameters<typeof core.createLanRelay>[0]} [options]
 */
export function createLanRelay(options = {}) {
  return core.createLanRelay({ signCore, ...options })
}

export { signCore }

export default core
