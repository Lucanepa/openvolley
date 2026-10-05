/**
 * lanRelayCore — ESM entry for the shared LAN relay protocol used by server.js
 * (standalone/prod static+WS server) and vite-plugin-api-routes.js (dev-server
 * replica). The implementation lives in ./electron/lanRelayCore.cjs so the
 * packaged Electron relay can require() the very same code; see that file for
 * the wire protocol. Extracting it prevents the drift the review found, where
 * PIN redaction and message shapes differed between relays.
 */
import core from './electron/lanRelayCore.cjs'

export const {
  MATCH_SECRET_FIELDS,
  WS_MAX_PAYLOAD,
  MAX_BODY_SIZE,
  stripMatchSecrets,
  stripMatchDataSecrets,
  normalizeMatchId,
  gamePinOf,
  toWireBundle,
  matchDataMessage,
  createRateLimiter,
  createLocalAddressCheck,
  createMainInstanceGate,
  createLanRelay,
} = core

export default core
