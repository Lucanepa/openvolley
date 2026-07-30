// LedBox appliance — a self-contained controller for a Tech4Sport LedBox with a web UI.
// Serves a manual scoreboard controller plus a "link to a live LAN match" mode, pushing
// the resulting liveState onto the LedBox.
//
//   web UI --HTTP--> controlServer --> SourceManager --liveState--> LedboxClient --> LedBox
//
// Run: node src/appliance.js   (configure via environment; see .env.example)

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadConfig } from './config.js'
import { LedboxClient } from './ledboxClient.js'
import { MockLedbox } from './mockLedbox.js'
import { ManualSource } from './manualSource.js'
import { SourceManager } from './sourceManager.js'
import { createControlServer } from './controlServer.js'

const ts = () => new Date().toISOString()

export async function startAppliance(config = loadConfig()) {
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
    log(`[appliance] MOCK LedBox on ${ledboxHosts[0]}:${ledboxPort}`)
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

  const manualSource = new ManualSource()
  const sourceManager = new SourceManager()
  // Whatever the active source emits gets painted onto the board. Fire-and-forget:
  // swallow push rejections (e.g. a timeout while the board is down) so they don't
  // surface as unhandled rejections and crash the process.
  sourceManager.on('state', (s) => { ledbox.pushState(s).catch((e) => log('[ledbox] push failed:', e.message)) })
  // A source failing (e.g. the LAN relay is unreachable) must not crash the appliance.
  sourceManager.on('error', (e) => log('[source] error:', e.message))

  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
  const server = createControlServer({
    sourceManager,
    manualSource,
    ledbox,
    relayHttpUrl: config.relayHttpUrl,
    relayUrl: config.relayUrl,
    reconnectMs: config.reconnectMs,
    webDir,
  })

  // Once the board is up, default to MANUAL so it shows a neutral scoreboard immediately.
  ledbox.on('ready', () => {
    if (!sourceManager.getState() && sourceManager.status.mode === 'idle') {
      sourceManager.setSource(manualSource, { mode: 'manual' })
    }
  })
  ledbox.connect()

  await new Promise((resolve) => server.listen(config.controlPort, '0.0.0.0', resolve))
  const port = server.address().port
  log(`[appliance] control UI on http://0.0.0.0:${port}  (Tailscale: http://openvolley:${port})`)

  const close = async () => {
    sourceManager.stop()
    await new Promise((r) => server.close(r))
    ledbox.disconnect()
    if (mock) await mock.close()
  }

  return { server, sourceManager, manualSource, ledbox, close }
}

// Run directly (node src/appliance.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  startAppliance().then(({ close }) => {
    const shutdown = async () => { await close(); process.exit(0) }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }).catch((err) => {
    console.error('[appliance] fatal:', err)
    process.exit(1)
  })
}
