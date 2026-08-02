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
import { getSport, DEFAULT_SPORT } from './sports.js'
import { livePushFromEnv } from './livePush.js'
import { SourceManager } from './sourceManager.js'
import { createControlServer } from './controlServer.js'
import { Settings } from './settings.js'

const ts = () => new Date().toISOString()

export async function startAppliance(config = loadConfig()) {
  const log = (...a) => console.log(ts(), ...a)

  // Load settings first: the active sport selects the Source, the match layout and the
  // state→sections mapper built below (see src/sports.js). Preferences live beside the code so
  // they survive restarts and reboots.
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
  const settings = new Settings(path.resolve(webDir, '..', 'settings.json'))
  const sport = getSport(settings.values.sport || DEFAULT_SPORT)
  log(`[appliance] sport: ${sport.key} (${sport.label})`)

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
    sport: sport.key,
    ...sport.layouts,        // match + idle + crest layout names for this sport
    mapper: sport.mapper,    // per-sport state→sections (only the match screen differs)
    apiVersion: config.ledboxApiVersion,
    reconnectMs: config.reconnectMs,
    // A fresh boot with no match settles on the KSC Wiedikon crest idle screen (rather than a
    // blank scoreboard). Asserted inside connect() after the handshake so it survives the
    // board's own boot-default layout and reconnects.
    defaultIdle: true,
  })
  ledbox.on('ready', () => log(`[ledbox] ready (${ledbox.host}:${ledboxPort}, ${sport.key}, layout ${sport.layouts.layout})`))
  ledbox.on('close', () => log('[ledbox] disconnected'))
  ledbox.on('error', (e) => log('[ledbox] error:', e.message))

  const manualSource = new sport.Source()
  const sourceManager = new SourceManager()
  // Whatever the active source emits gets painted onto the board. Fire-and-forget:
  // swallow push rejections (e.g. a timeout while the board is down) so they don't
  // surface as unhandled rejections and crash the process.
  sourceManager.on('state', (s) => { ledbox.pushState(s).catch((e) => log('[ledbox] push failed:', e.message)) })
  // A source failing (e.g. the LAN relay is unreachable) must not crash the appliance.
  sourceManager.on('error', (e) => log('[source] error:', e.message))

  // Mirror the board to wiedisync so members can follow the match at /live.
  // Attached to the SourceManager, not to the scoring source, so a LINKED LAN
  // match publishes too. A no-op stub unless DIRECTUS_URL + LIVE_PUBLISH_TOKEN
  // are set, and every failure inside it is swallowed — it can never reach the
  // board. The sport is fixed at boot (switching it restarts the appliance).
  const livePush = livePushFromEnv(process.env, sport.key)
  livePush.attach(sourceManager)
  log(`[livePush] ${livePush.enabled ? `publishing ${sport.key} to ${process.env.DIRECTUS_URL}` : 'disabled (no DIRECTUS_URL / LIVE_PUBLISH_TOKEN)'}`)

  log(`[appliance] settings: ${JSON.stringify(settings.values)}`)
  // Seed the counter-colour thresholds from saved settings before the first paint.
  ledbox.setLimits({
    totalTimeouts: settings.values.totalTimeouts,
    totalSubs: settings.values.totalSubs,
    idleFullNames: settings.values.idleFullNames,
    idleFontMax: settings.values.idleFontMax,
    clubName: settings.values.clubName,
  })
  const server = createControlServer({
    sourceManager,
    manualSource,
    ledbox,
    relayHttpUrl: config.relayHttpUrl,
    relayUrl: config.relayUrl,
    reconnectMs: config.reconnectMs,
    settings,
    webDir,
  })

  // The default screen on a fresh boot (the KSC Wiedikon crest) is asserted by the client
  // itself after the handshake (see `defaultIdle` above), so it survives the board's own
  // boot-default layout and every reconnect. /api/action, /api/manual and /api/link lift
  // idle when a match starts so the scoreboard paints.
  ledbox.connect()

  await new Promise((resolve) => server.listen(config.controlPort, '0.0.0.0', resolve))
  const port = server.address().port
  log(`[appliance] control UI on http://0.0.0.0:${port}  (Tailscale: http://openvolley:${port})`)

  const close = async () => {
    livePush.detach()
    sourceManager.stop()
    await new Promise((r) => server.close(r))
    ledbox.disconnect()
    if (mock) await mock.close()
  }

  return { server, sourceManager, manualSource, ledbox, livePush, close }
}

// Run directly (node src/appliance.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  // An appliance must stay up through a match: a stray unhandled rejection (most often a
  // board write that timed out) or a non-fatal exception should be logged, not terminate
  // the process. Node's default is to crash on an unhandled rejection.
  process.on('unhandledRejection', (reason) => console.error(ts(), '[appliance] unhandledRejection:', reason))
  process.on('uncaughtException', (err) => console.error(ts(), '[appliance] uncaughtException:', err))
  startAppliance().then(({ close }) => {
    const shutdown = async () => { await close(); process.exit(0) }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }).catch((err) => {
    console.error('[appliance] fatal:', err)
    process.exit(1)
  })
}
