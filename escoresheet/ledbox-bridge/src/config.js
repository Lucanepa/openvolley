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
    // Physical Tech4Sport LedBox. The board answers on a DIFFERENT address depending on
    // how you reached it — 172.24.1.1 when everyone is on the board's own Wi-Fi (the
    // venue setup), 192.168.5.1 over the ethernet cable (the bench setup). Pinning one
    // means the other silently fails, so accept a comma-separated list and try each in
    // turn on every connect. LEDBOX_HOST still works for a single address.
    ledboxHosts: (env.LEDBOX_HOST || '172.24.1.1,192.168.5.1')
      .split(',').map((h) => h.trim()).filter(Boolean),
    ledboxPort: Number(env.LEDBOX_PORT || 8889),
    ledboxLayout: env.LEDBOX_LAYOUT || 'volleyball_matchscore_02',
    ledboxAlias: env.LEDBOX_ALIAS || 'openvolley',
    ledboxApiVersion: Number(env.LEDBOX_API_VERSION || 2),
    // Reconnect backoff (ms) for both the relay and the LedBox sockets.
    reconnectMs: Number(env.RECONNECT_MS || 3000),
    // Run an in-process mock LedBox instead of talking to real hardware (for testing).
    mock: bool(env.MOCK),
    // Verbose per-update logging.
    debug: bool(env.DEBUG),
    // Log level the appliance RECORDS at: debug | info | warn | error. DEBUG=1 is the historical
    // shorthand for debug. Also switchable at runtime from the /logs page, so this is only the
    // level it boots with.
    logLevel: ['debug', 'info', 'warn', 'error'].includes(String(env.LOG_LEVEL || '').toLowerCase())
      ? String(env.LOG_LEVEL).toLowerCase()
      : (bool(env.DEBUG) ? 'debug' : 'info'),
    // Appliance web control server (manual + LAN link UI) listen port.
    controlPort: Number(env.CONTROL_PORT || 8890),
    // OpenVolley relay HTTP base (for /api/match/list). Derived from relayUrl if unset:
    // ws->http, wss->https, and the relay's HTTP port is 5173 (Vite dev server / API host).
    relayHttpUrl: env.RELAY_HTTP_URL || httpFromWs(env.RELAY_URL || 'ws://127.0.0.1:8080'),
  }
}

// Derive the relay HTTP base from its WS url: swap scheme and force port 5173.
function httpFromWs(wsUrl) {
  try {
    const u = new URL(wsUrl)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.port = '5173'
    return u.origin
  } catch {
    return 'http://127.0.0.1:5173'
  }
}
