/**
 * In-process LAN relay for the Electron desktop app (FULL offline).
 *
 * This is a CommonJS, HTTP-only port of ../server.js. Running it inside the
 * Electron main process (instead of spawning `node server.js`) means:
 *   - no external `node` binary is required in a packaged app,
 *   - no ESM/asar bundling problems (Electron's main can `require('ws')`),
 *   - clean start/stop lifecycle tied to the app window.
 *
 * The desktop window loads http://localhost:<PORT> from THIS server, and
 * tablets/phones on the same Wi-Fi reach it at http://<LAN-IP>:<PORT>. The
 * WebSocket relay lets the scoretable push live match data and the
 * referee/bench/livescore devices subscribe to it.
 *
 * The WebSocket message protocol and the relay-owned /api/match/* endpoints
 * come from ./lanRelayCore.cjs, the same module ../server.js and the Vite dev
 * plugin use, so clients talk to all of them interchangeably.
 */

const { createServer: createHttpServer } = require('http')
const { readFileSync, existsSync, statSync } = require('fs')
const { join, extname, basename, sep } = require('path')
const { WebSocketServer } = require('ws')
const { networkInterfaces } = require('os')

const { createLanRelay, createLocalAddressCheck, createMainInstanceGate, WS_MAX_PAYLOAD } = require('./lanRelayCore.cjs')
const signCore = require('./signSessionCore.cjs')

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
}

// The desktop app itself = loopback or this machine's own LAN IP (the app
// calls the relay on its LAN IP). Shared rule, see createMainInstanceGate.
const isLocalAddress = createLocalAddressCheck(networkInterfaces)

function getLocalIP() {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return '127.0.0.1'
}

// Module-level singleton so start()/stop()/getStatus() share one instance.
let httpServer = null
let wss = null
let activeRelay = null // for stop(): its sign sessions and timers
let status = { running: false, port: null, wsPort: null }

/**
 * Start the in-process relay.
 * @param {{port?:number, wsPort?:number, hostname?:string}} [opts]
 * @returns {Promise<object>} resolved status once listening
 */
function start(opts = {}) {
  return new Promise((resolve, reject) => {
    if (httpServer) {
      return resolve({ ...getStatus(), alreadyRunning: true })
    }

    const PORT = Number(opts.port) || 5173
    const WS_PORT = Number(opts.wsPort) || 8080
    const HOSTNAME = opts.hostname || 'localhost'
    const DIST_DIR = join(__dirname, '..', 'dist')

    // Relay state + WS protocol (shared with ../server.js and the dev plugin)
    // Sign on phone (/api/sign/*): the desktop app itself may start a session
    const relay = createLanRelay({ signCore, isLocal: isLocalAddress })
    activeRelay = relay
    const wsClients = new Set()
    const mainGate = createMainInstanceGate({ isLocal: isLocalAddress })

    const requestHandler = (req, res) => {
      const urlPath = req.url.split('?')[0]
      const remote = req.socket.remoteAddress

      // --- CORS (LAN http/https + localhost + openvolley.app) ---
      const origin = req.headers.origin
      if (origin && (
        origin.match(/^https:\/\/[a-z0-9-]+\.openvolley\.app$/) ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin.startsWith('https://localhost:') ||
        origin.startsWith('https://127.0.0.1:') ||
        origin.match(/^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/) ||
        origin.match(/^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/) ||
        origin.match(/^https?:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$/)
      )) {
        res.setHeader('Access-Control-Allow-Origin', origin)
      }
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Instance-ID, X-OV-Match-Pin, X-OV-Match-Token')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Frame-Options', 'SAMEORIGIN')
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      // --- Lightweight health check (used by ServerConnectionScreen) ---
      if (urlPath === '/health' || urlPath === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', running: true }))
        return
      }

      // --- Server status / URLs ---
      if (urlPath === '/api/server/status') {
        const localIP = getLocalIP()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          running: true,
          mainInstanceId: mainGate.mainInstanceId,
          hasMainInstance: mainGate.mainInstanceId !== null,
          protocol: 'http',
          wsProtocol: 'ws',
          hostname: HOSTNAME,
          localIP,
          port: PORT,
          wsPort: WS_PORT,
          urls: {
            main: `http://${HOSTNAME}:${PORT}/`,
            mainIP: `http://${localIP}:${PORT}/`,
            referee: `http://${HOSTNAME}:${PORT}/referee`,
            refereeIP: `http://${localIP}:${PORT}/referee`,
            bench: `http://${HOSTNAME}:${PORT}/bench`,
            benchIP: `http://${localIP}:${PORT}/bench`,
            livescore: `http://${HOSTNAME}:${PORT}/livescore`,
            livescoreIP: `http://${localIP}:${PORT}/livescore`,
            websocket: `ws://${HOSTNAME}:${WS_PORT}`,
            websocketIP: `ws://${localIP}:${WS_PORT}`,
          },
        }))
        return
      }

      // --- Single main-instance lock (only this machine may take or release it) ---
      if (mainGate.handleRequest(req, res, urlPath)) return

      // --- Relay-owned endpoints (validate-pin, match/:id, list, by-game-number,
      // PATCH, server/connections) — one implementation in lanRelayCore ---
      if (urlPath.startsWith('/api/')) {
        if (relay.handleApiRequest(req, res, req.url)) return
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Not found' }))
        return
      }

      // --- Single main-instance gate (skipped for the desktop app itself) ---
      const isMainPage = urlPath === '/' || urlPath === '/index.html'
      if (isMainPage) {
        if (mainGate.blocksMainPage(remote, req.headers['x-instance-id'])) {
          res.writeHead(403, { 'Content-Type': 'text/html' })
          res.end(`<!DOCTYPE html><html><head><title>Main Instance Already Running</title>
            <style>body{font-family:Arial,sans-serif;text-align:center;padding:50px}h1{color:#ef4444}p{color:#666}</style>
            </head><body><h1>Main Scoresheet Already Running</h1>
            <p>Another instance of the main scoresheet is already active.</p>
            <p>You can still access:</p>
            <ul style="list-style:none;padding:0">
            <li><a href="/referee">Referee App</a></li>
            <li><a href="/bench">Bench App</a></li>
            <li><a href="/livescore">Livescore App</a></li>
            </ul></body></html>`)
          return
        }
      }

      // --- Static file serving with SPA fallback ---
      let filePath = join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath)
      if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }

      if (!existsSync(filePath)) {
        if (!urlPath.endsWith('.html') && !urlPath.includes('.')) {
          const htmlPath = (urlPath.startsWith('/') ? urlPath.substring(1) : urlPath) + '.html'
          const htmlFilePath = join(DIST_DIR, htmlPath)
          if (existsSync(htmlFilePath)) filePath = htmlFilePath
        } else if (urlPath.endsWith('.html')) {
          // Legacy /referee.html links: Vite builds folder pages (referee/index.html).
          const folderIndex = join(DIST_DIR, urlPath.slice(0, -'.html'.length), 'index.html')
          if (folderIndex.startsWith(DIST_DIR + sep) && existsSync(folderIndex)) filePath = folderIndex
        }
        if (!existsSync(filePath)) {
          const indexPath = join(DIST_DIR, 'index.html')
          if (existsSync(indexPath)) {
            filePath = indexPath
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Not Found')
            return
          }
        }
      }

      try {
        const stats = statSync(filePath)
        if (stats.isDirectory()) {
          filePath = join(filePath, 'index.html')
          if (!existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Not Found')
            return
          }
        }
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
        return
      }

      try {
        const content = readFileSync(filePath)
        const ext = extname(filePath).toLowerCase()
        const contentType = MIME_TYPES[ext] || 'application/octet-stream'
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': ext === '.html' || ext === '.json' || basename(filePath) === 'sw.js' || ext === '.webmanifest'
            ? 'no-cache'
            : 'public, max-age=31536000',
          // The phone signing page (/sign): strict CSP, no referrer, no-cache
          ...(signCore.isSignPagePath(urlPath) ? signCore.SIGN_PAGE_HEADERS : {}),
        })
        res.end(content)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      }
    }

    httpServer = createHttpServer(requestHandler)

    httpServer.on('error', (err) => {
      httpServer = null
      reject(err)
    })

    httpServer.listen(PORT, '0.0.0.0', () => {
      // WS server only after HTTP is up, so a port clash rejects cleanly.
      wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0', perMessageDeflate: false, maxPayload: WS_MAX_PAYLOAD })
      wss.on('error', (err) => {
        // HTTP already listening; surface WS failure by tearing down.
        try { httpServer.close() } catch { /* ignore */ }
        httpServer = null
        wss = null
        reject(err)
      })
      wss.on('connection', (ws, req) => {
        if (wsClients.size >= 20) {
          ws.close(1013, 'Maximum connections reached')
          return
        }
        wsClients.add(ws)
        relay.addClient(ws, { ip: req.socket.remoteAddress }) // sends 'connected'
        ws.on('message', (msg) => relay.handleMessage(ws, msg))
        ws.on('close', () => {
          wsClients.delete(ws)
          relay.removeClient(ws)
        })
        ws.on('error', () => {
          wsClients.delete(ws)
          relay.removeClient(ws)
        })
      })
      wss.on('listening', () => {
        status = { running: true, port: PORT, wsPort: WS_PORT, hostname: HOSTNAME, localIP: getLocalIP(), protocol: 'http', wsProtocol: 'ws' }
        resolve(getStatus())
      })
    })
  })
}

function stop() {
  return new Promise((resolve) => {
    const closeWs = () => new Promise((r) => { wss ? wss.close(() => r()) : r() })
    const closeHttp = () => new Promise((r) => { httpServer ? httpServer.close(() => r()) : r() })
    Promise.all([closeWs(), closeHttp()]).then(() => {
      if (activeRelay) activeRelay.close()
      activeRelay = null
      httpServer = null
      wss = null
      status = { running: false, port: null, wsPort: null }
      resolve({ success: true })
    })
  })
}

function getStatus() {
  return { ...status, localIP: getLocalIP() }
}

module.exports = { start, stop, getStatus, getLocalIP }
