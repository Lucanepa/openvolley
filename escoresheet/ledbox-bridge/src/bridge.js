// LedBox bridge — mirrors an OpenVolley match's live score onto a Tech4Sport LedBox.
//
//   LAN relay (WS) --liveState--> volleyballMapper --SetSections--> LedboxClient --gzip/TCP:8889--> LedBox
//
// Run: node src/bridge.js   (configure via environment; see .env.example)

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadConfig } from './config.js'
import { LedboxClient } from './ledboxClient.js'
import { RelaySubscriber } from './relaySubscriber.js'
import { MockLedbox } from './mockLedbox.js'
import { log as logStore, installProcessLogging } from './logStore.js'

export async function startBridge(config = loadConfig()) {
  // The headless bridge gets the same log store as the appliance, in its own file — it has no
  // web UI, so this trail plus journalctl is all there is.
  logStore.configure({
    file: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'logs', 'bridge.jsonl'),
    level: config.logLevel || (config.debug ? 'debug' : 'info'),
  })
  const log = logStore.child('bridge')
  const boardLog = logStore.child('ledbox')
  log.info('starting', { node: process.version, pid: process.pid, relayUrl: config.relayUrl, matchId: config.matchId, ledboxHosts: config.ledboxHosts, mock: config.mock })

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
    log.info(`MOCK LedBox on ${ledboxHosts[0]}:${ledboxPort}`, { host: ledboxHosts[0], port: ledboxPort })
  }

  const ledbox = new LedboxClient({
    hosts: ledboxHosts,
    port: ledboxPort,
    alias: config.ledboxAlias,
    layout: config.ledboxLayout,
    apiVersion: config.ledboxApiVersion,
    reconnectMs: config.reconnectMs,
  })
  ledbox.on('connect', () => boardLog.info('tcp connected', { host: ledbox.host, port: ledboxPort }))
  ledbox.on('ready', (info) => boardLog.info(`ready (${ledbox.host}:${ledboxPort}, layout ${config.ledboxLayout})`, { host: ledbox.host, port: ledboxPort, layout: config.ledboxLayout, device: info }))
  ledbox.on('close', () => boardLog.warn('disconnected', { host: ledbox.host }))
  ledbox.on('error', (e) => boardLog.error(`error: ${e.message}`, e))
  ledbox.connect()

  const relay = new RelaySubscriber({
    url: config.relayUrl,
    matchId: config.matchId,
    reconnectMs: config.reconnectMs,
  })
  // The relay's own socket lifecycle (connect/close/retry/bad message) is logged inside
  // RelaySubscriber, so only the match-level facts are added here.
  relay.on('match-gone', () => log.warn('the followed match ended or was deleted', { matchId: config.matchId }))
  relay.on('state', (liveState) => {
    logStore.debug('state', `${liveState.points_a}-${liveState.points_b}`, {
      score: `${liveState.points_a}-${liveState.points_b}`,
      sets: `${liveState.sets_won_a}-${liveState.sets_won_b}`,
      serve: liveState.serving_team ?? null,
    })
    ledbox.pushState(liveState).catch((e) => boardLog.error(`push failed: ${e.message}`, { error: e.message }))
  })
  relay.start()

  const shutdown = () => {
    log.info('shutting down')
    logStore.flush()
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
  installProcessLogging()
  startBridge(cfg).catch((err) => {
    logStore.error('bridge', 'fatal — could not start', err)
    logStore.flush()
    process.exit(1)
  })
}
