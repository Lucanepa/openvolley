// LedBox bridge — mirrors an OpenVolley match's live score onto a Tech4Sport LedBox.
//
//   LAN relay (WS) --liveState--> volleyballMapper --SetSections--> LedboxClient --gzip/TCP:8889--> LedBox
//
// Run: node src/bridge.js   (configure via environment; see .env.example)

import { loadConfig } from './config.js'
import { LedboxClient } from './ledboxClient.js'
import { RelaySubscriber } from './relaySubscriber.js'
import { MockLedbox } from './mockLedbox.js'

const ts = () => new Date().toISOString()

export async function startBridge(config = loadConfig()) {
  const log = (...a) => console.log(ts(), ...a)

  // Target: the real LedBox, or an in-process mock on an ephemeral port for testing.
  // Accept either the config's host list or a single (possibly comma-separated) host,
  // so hand-built configs and the tests keep working.
  let ledboxHosts = config.ledboxHosts
    || String(config.ledboxHost || '172.24.1.1').split(',').map((h) => h.trim()).filter(Boolean)
  let { ledboxPort } = config
  let mock = null
  if (config.mock) {
    mock = new MockLedbox()
    const addr = await mock.listen(0, '127.0.0.1')
    ledboxHosts = ['127.0.0.1']
    ledboxPort = addr.port
    log(`[bridge] MOCK LedBox on ${ledboxHosts[0]}:${ledboxPort}`)
  }

  const ledbox = new LedboxClient({
    hosts: ledboxHosts,
    port: ledboxPort,
    alias: config.ledboxAlias,
    layout: config.ledboxLayout,
    apiVersion: config.ledboxApiVersion,
    reconnectMs: config.reconnectMs,
  })
  ledbox.on('ready', () => log(`[ledbox] ready (${ledbox.host}:${ledboxPort}, layout ${config.ledboxLayout})`))
  ledbox.on('close', () => log('[ledbox] disconnected'))
  ledbox.on('error', (e) => log('[ledbox] error:', e.message))
  ledbox.connect()

  const relay = new RelaySubscriber({
    url: config.relayUrl,
    matchId: config.matchId,
    reconnectMs: config.reconnectMs,
  })
  relay.on('open', () => log(`[relay] connected ${config.relayUrl}; following match ${config.matchId ?? '(NONE SET)'}`))
  relay.on('close', () => log('[relay] disconnected'))
  relay.on('error', (e) => log('[relay] error:', e.message))
  relay.on('nostate', () => { if (config.debug) log('[relay] raw match sync without liveState (ignored)') })
  relay.on('match-gone', () => log('[relay] match ended/deleted'))
  relay.on('state', (liveState) => {
    if (config.debug) {
      log('[state]', `${liveState.points_a}-${liveState.points_b}`,
        `sets ${liveState.sets_won_a}-${liveState.sets_won_b}`, `serve ${liveState.serving_team}`)
    }
    ledbox.pushState(liveState)
  })
  relay.start()

  const shutdown = () => {
    log('[bridge] shutting down')
    relay.stop()
    ledbox.disconnect()
    if (mock) mock.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return { ledbox, relay, mock }
}

// Run directly (node src/bridge.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig()
  if (!cfg.mock && !cfg.matchId) {
    console.error('MATCH_ID is required (or set MOCK=1). See .env.example.')
    process.exit(2)
  }
  startBridge(cfg).catch((err) => {
    console.error('[bridge] fatal:', err)
    process.exit(1)
  })
}
