/**
 * Server Manager for Electron
 *
 * Drives the in-process LAN relay (./relayServer.js). Previously this spawned a
 * child `node server.js`, which cannot work in a packaged app (no `node` on
 * PATH, server.js + `ws` not bundled). Running the relay in-process removes all
 * of that and gives a clean start/stop lifecycle.
 *
 * The exported API (startServer/stopServer/getServerStatus) is unchanged so the
 * renderer (MatchSetup/Scoreboard status polling + connect UI) keeps working.
 *
 * The desktop LAN relay runs over plain HTTP: the desktop window itself is on
 * http://localhost (a secure context, so its own camera/QR still work), and
 * tablets join over http://<LAN-IP> without certificate warnings.
 */

const relayServer = require('./relayServer')

const DEFAULT_PORT = 5173
const DEFAULT_WS_PORT = 8080

/**
 * Start the relay. Idempotent — returns the running status if already up.
 * @param {{port?:number, wsPort?:number, hostname?:string}} [options]
 */
async function startServer(options = {}) {
  const status = await relayServer.start({
    port: options.port || DEFAULT_PORT,
    wsPort: options.wsPort || DEFAULT_WS_PORT,
    hostname: options.hostname || 'localhost',
  })
  return status
}

async function stopServer() {
  const result = await relayServer.stop()
  return { success: true, message: 'Server stopped', ...result }
}

function getServerStatus() {
  return relayServer.getStatus()
}

function getLocalIP() {
  return relayServer.getLocalIP()
}

module.exports = {
  startServer,
  stopServer,
  getServerStatus,
  getLocalIP,
  DEFAULT_PORT,
  DEFAULT_WS_PORT,
}
