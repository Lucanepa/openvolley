// Runtime config for the LedBox bridge, read from the environment (see .env.example).
// Production has zero npm dependencies: the relay client uses Node's built-in global
// WebSocket (Node >= 22) and the LedBox client uses node:net.

export function loadConfig(env = process.env) {
  const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)))
  return {
    // OpenVolley LAN relay (the eScoresheet server) WebSocket endpoint to subscribe to.
    relayUrl: env.RELAY_URL || 'ws://127.0.0.1:8080',
    // Which match to mirror onto the LedBox (the numeric match id). Required unless MOCK.
    matchId: env.MATCH_ID || null,
    // Physical Tech4Sport LedBox. Default = its own Wi-Fi hotspot address.
    ledboxHost: env.LEDBOX_HOST || '172.24.1.1',
    ledboxPort: Number(env.LEDBOX_PORT || 8889),
    ledboxLayout: env.LEDBOX_LAYOUT || 'volleyball_matchscore',
    ledboxAlias: env.LEDBOX_ALIAS || 'openvolley',
    ledboxApiVersion: Number(env.LEDBOX_API_VERSION || 1.30),
    // Reconnect backoff (ms) for both the relay and the LedBox sockets.
    reconnectMs: Number(env.RECONNECT_MS || 3000),
    // Run an in-process mock LedBox instead of talking to real hardware (for testing).
    mock: bool(env.MOCK),
    // Verbose per-update logging.
    debug: bool(env.DEBUG),
  }
}
