/**
 * Production Server for eScoresheet
 * Serves static files and provides WebSocket server for real-time connections
 * Supports both HTTP/HTTPS and WS/WSS
 */

import { createServer as createHttpServer } from 'http'
import { createServer as createHttpsServer } from 'https'
import { createServer as createNetServer } from 'net'
import { readFileSync, existsSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, extname, basename, sep } from 'path'
import { WebSocketServer } from 'ws'
import { networkInterfaces } from 'os'
import { createLanRelay, createLocalAddressCheck, createMainInstanceGate, WS_MAX_PAYLOAD } from './lanRelayCore.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Configuration
// Default to port 5173 (same as Vite dev server)
// For tablet/phone access, run: npm run start:prod (builds and starts server)
// Or: npm run build && npm run start
const PORT = process.env.PORT || 5173
const WS_PORT = process.env.WS_PORT || 8080
const DIST_DIR = join(__dirname, 'dist')
const HOSTNAME = process.env.HOSTNAME || 'escoresheet.local' // Custom hostname instead of localhost

// The WS protocol and /api/match/* endpoints come from ./lanRelayCore.js (shared
// with the dev plugin and the Electron relay).

// HTTPS configuration - default to true for production
const useHttps = process.env.HTTPS !== 'false' && (process.env.HTTPS === 'true' || process.env.USE_HTTPS === 'true' || process.env.NODE_ENV === 'production')
let httpsOptions = null

if (useHttps) {
  // Support for base64-encoded certificates (for cloud deployment)
  if (process.env.SSL_CERT_BASE64 && process.env.SSL_KEY_BASE64) {
    try {
      httpsOptions = {
        cert: Buffer.from(process.env.SSL_CERT_BASE64, 'base64').toString('utf-8'),
        key: Buffer.from(process.env.SSL_KEY_BASE64, 'base64').toString('utf-8')
      }
      console.log('🔒 HTTPS enabled with base64-encoded certificates (cloud deployment)')
    } catch (err) {
      console.error('❌ Failed to decode base64 certificates:', err.message)
    }
  } else {
    // Look for Cloudflare origin certificates in project root first, then local
    const certPath = process.env.SSL_CERT_PATH ||
      (existsSync(join(__dirname, '..', '..', 'cert.pem'))
        ? join(__dirname, '..', '..', 'cert.pem')  // C:\Users\lcane\Desktop\openvolley\cert.pem
        : join(__dirname, 'localhost.pem'))
    const keyPath = process.env.SSL_KEY_PATH ||
      (existsSync(join(__dirname, '..', '..', 'key.pem'))
        ? join(__dirname, '..', '..', 'key.pem')   // C:\Users\lcane\Desktop\openvolley\key.pem
        : join(__dirname, 'localhost-key.pem'))

    if (existsSync(certPath) && existsSync(keyPath)) {
      httpsOptions = {
        cert: readFileSync(certPath),
        key: readFileSync(keyPath)
      }
      const isCloudflare = certPath.includes('cert.pem') && !certPath.includes('localhost')
      console.log(`🔒 HTTPS enabled with ${isCloudflare ? 'Cloudflare Origin Certificate' : 'custom certificates'}`)
      console.log(`   Certificate: ${certPath}`)
      console.log(`   Private Key: ${keyPath}`)
    } else {
      console.warn('⚠️  HTTPS requested but certificates not found. Falling back to HTTP.')
      console.warn(`   Expected certificates at: ${certPath} and ${keyPath}`)
      console.warn('   Run "npm run generate-certs" to create self-signed certificates for development')
    }
  }
}

// Single main-scoresheet lock (same rule as the Electron/Tauri relays and the
// dev plugin): only this machine itself — loopback or its own LAN IP — may
// register or release it, so a LAN device cannot lock anyone out of "/".
const isLocalAddress = createLocalAddressCheck(networkInterfaces)
const mainGate = createMainInstanceGate({ isLocal: isLocalAddress })

// Shared match data store + WS protocol (populated by the scoreboard via WebSocket)
const relay = createLanRelay()

// MIME types for static files
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
  '.pdf': 'application/pdf'
}

// WebSocket clients storage
const wsClients = new Set()

// Helper to get local IP address
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

// Request handler for static files
const requestHandler = (req, res) => {
  let urlPath = req.url.split('?')[0] // Remove query string

  // --- Centralized CORS headers ---
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
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://app.openvolley.app')
  }
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Instance-ID, X-OV-Match-Pin, X-OV-Match-Token')

  // --- Security headers ---
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')

  // Debug logging for API routes
  if (urlPath.startsWith('/api/')) {
    console.log(`[API] ${req.method} ${urlPath} from ${req.socket.remoteAddress}`)
  }
  
  // API endpoints
  if (urlPath === '/api/server/status') {
    const localIP = getLocalIP()
    const protocol = httpsOptions ? 'https' : 'http'
    const wsProtocol = httpsOptions ? 'wss' : 'ws'
    res.writeHead(200, {
      'Content-Type': 'application/json'
    })
    res.end(JSON.stringify({
      running: true,
      mainInstanceId: mainGate.mainInstanceId,
      hasMainInstance: mainGate.mainInstanceId !== null,
      protocol,
      wsProtocol,
      hostname: HOSTNAME,
      localIP,
      port: PORT,
      wsPort: WS_PORT,
      urls: {
        main: `${protocol}://${HOSTNAME}:${PORT}/`,
        mainIP: `${protocol}://${localIP}:${PORT}/`,
        referee: `${protocol}://${HOSTNAME}:${PORT}/referee`,
        refereeIP: `${protocol}://${localIP}:${PORT}/referee`,
        bench: `${protocol}://${HOSTNAME}:${PORT}/bench`,
        benchIP: `${protocol}://${localIP}:${PORT}/bench`,
        livescore: `${protocol}://${HOSTNAME}:${PORT}/livescore`,
        livescoreIP: `${protocol}://${localIP}:${PORT}/livescore`,
        websocket: `${wsProtocol}://${HOSTNAME}:${WS_PORT}`,
        websocketIP: `${wsProtocol}://${localIP}:${WS_PORT}`
      }
    }))
    return
  }
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }
  
  if (mainGate.handleRequest(req, res, urlPath)) return

  // Relay-owned endpoints (validate-pin, match/:id, list, by-game-number,
  // PATCH, server/connections) — one implementation in lanRelayCore.
  if (urlPath.startsWith('/api/')) {
    if (relay.handleApiRequest(req, res, req.url)) return
    // Unknown API routes get JSON, not the SPA's index.html with a 200.
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, error: 'Not found' }))
    return
  }

  // Check if accessing main page and block if another instance exists
  const isMainPage = urlPath === '/' || urlPath === '/index.html'
  if (isMainPage) {
    if (mainGate.blocksMainPage(req.socket.remoteAddress, req.headers['x-instance-id'])) {
      res.writeHead(403, { 'Content-Type': 'text/html' })
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Main Instance Already Running</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            h1 { color: #ef4444; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <h1>Main Scoresheet Already Running</h1>
          <p>Another instance of the main scoresheet is already active.</p>
          <p>Only one main scoresheet instance can run at a time.</p>
          <p>You can still access:</p>
          <ul style="list-style: none; padding: 0;">
            <li><a href="/referee">Referee App</a></li>
            <li><a href="/bench">Bench App</a></li>
            <li><a href="/livescore">Livescore App</a></li>
          </ul>
        </body>
        </html>
      `)
      return
    }
  }
  
  // Allow access to referee, bench, livescore, etc. even if main instance exists
  let filePath = join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath)

  // Security: prevent directory traversal. Require a path separator after
  // DIST_DIR so sibling dirs like "dist-backup" cannot pass a bare prefix check.
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden')
    return
  }
  
  // Check if file exists
  if (!existsSync(filePath)) {
    // If URL doesn't have .html extension, try adding it
    if (!urlPath.endsWith('.html') && !urlPath.includes('.')) {
      const htmlPath = urlPath.startsWith('/') ? urlPath.substring(1) + '.html' : urlPath + '.html'
      const htmlFilePath = join(DIST_DIR, htmlPath)
      if (existsSync(htmlFilePath)) {
        filePath = htmlFilePath
      }
    } else if (urlPath.endsWith('.html')) {
      // Legacy /referee.html links: Vite builds folder pages (referee/index.html).
      const folderIndex = join(DIST_DIR, urlPath.slice(0, -'.html'.length), 'index.html')
      if (folderIndex.startsWith(DIST_DIR + sep) && existsSync(folderIndex)) {
        filePath = folderIndex
      }
    }
    
    // If still not found, try index.html for SPA fallback
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
  
  // Check if it's a directory, serve index.html
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
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
    return
  }
  
  // Read and serve file
  try {
    const content = readFileSync(filePath)
    const ext = extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    
    res.writeHead(200, { 
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' || ext === '.json' || basename(filePath) === 'sw.js' || ext === '.webmanifest'
        ? 'no-cache'
        : 'public, max-age=31536000'
    })
    res.end(content)
  } catch (err) {
    console.error('Error serving file:', err)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Internal Server Error')
  }
}

// Create HTTP or HTTPS server for static files
const httpServer = httpsOptions 
  ? createHttpsServer(httpsOptions, requestHandler)
  : createHttpServer(requestHandler)

// Create WebSocket server. With HTTPS on, pages are served over https:// and
// browsers refuse ws:// (mixed content), so the relay accepts wss:// with the
// same certificate — exactly what /api/server/status advertises. Plain ws:// is
// still accepted on the SAME port (the first byte of a TLS handshake is 0x16),
// so LAN clients that predate HTTPS — the LedBox bridge defaults to
// ws://127.0.0.1:8080 — keep working with zero setup.
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false, // Disable compression for better performance
  maxPayload: WS_MAX_PAYLOAD
})
const wsOnly = (req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' })
  res.end('WebSocket only')
}
const wsPlainServer = createHttpServer(wsOnly)
const wsTlsServer = httpsOptions ? createHttpsServer(httpsOptions, wsOnly) : null
for (const server of [wsPlainServer, wsTlsServer]) {
  server?.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
}
const wsListener = createNetServer((socket) => {
  socket.on('error', () => socket.destroy())
  if (!wsTlsServer) {
    wsPlainServer.emit('connection', socket)
    return
  }
  // Peek the first byte to route TLS vs plain; the byte is pushed back unread.
  socket.setTimeout(10000, () => socket.destroy())
  socket.once('readable', function route() {
    const first = socket.read(1)
    if (first === null) {
      socket.once('readable', route)
      return
    }
    socket.unshift(first)
    socket.setTimeout(0)
    ;(first[0] === 0x16 ? wsTlsServer : wsPlainServer).emit('connection', socket)
  })
})
wsListener.listen(WS_PORT, '0.0.0.0') // Bind to all interfaces for LAN access

// Socket churn: connectivity checks open and close a socket every few
// seconds, so per-socket lines (with the client IP) would flood the log. One
// summary line a minute instead, like backend/server.js; OV_LOG_CONNECTIONS=1
// brings back per-socket lines (without IPs) for debugging.
const LOG_EACH_CONNECTION = process.env.OV_LOG_CONNECTIONS === '1'
const wsChurn = { opened: 0, closed: 0, since: Date.now() }
setInterval(() => {
  if (wsChurn.opened === 0 && wsChurn.closed === 0) { wsChurn.since = Date.now(); return }
  const secs = Math.max(1, Math.round((Date.now() - wsChurn.since) / 1000))
  console.log(`[WebSocket] last ${secs}s: ${wsChurn.opened} sockets opened, ${wsChurn.closed} sockets closed, open now ${wsClients.size}`)
  wsChurn.opened = 0
  wsChurn.closed = 0
  wsChurn.since = Date.now()
}, 60_000).unref()

wss.on('connection', (ws, req) => {
  // Connection limit for LAN server
  if (wsClients.size >= 20) {
    console.warn('[WebSocket] Connection rejected: max clients (20) reached')
    ws.close(1013, 'Maximum connections reached')
    return
  }

  const clientIp = req.socket.remoteAddress
  wsChurn.opened++
  if (LOG_EACH_CONNECTION) console.log(`[WebSocket] Client connected (total ${wsClients.size + 1})`)

  wsClients.add(ws)
  // Sends the 'connected' welcome message
  relay.addClient(ws, { ip: clientIp })

  // All message handling (sync, subscribe, actions, PIN-free fan-out,
  // scoreboard ownership) lives in lanRelayCore.
  ws.on('message', (message) => relay.handleMessage(ws, message))

  // Handle client disconnect - remove from subscriptions
  ws.on('close', () => {
    wsClients.delete(ws)
    wsChurn.closed++
    if (LOG_EACH_CONNECTION) console.log(`[WebSocket] Client disconnected (total ${wsClients.size})`)
    relay.removeClient(ws)
  })

  // Handle errors
  ws.on('error', (error) => {
    console.error('[WebSocket] Socket error:', error?.message || error)
    wsClients.delete(ws)
    relay.removeClient(ws)
  })
})

// Broadcast function to send data to all connected clients
function broadcast(data, excludeWs = null) {
  const message = JSON.stringify(data)
  wsClients.forEach((client) => {
    if (client !== excludeWs && client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(message)
      } catch (err) {
        console.error('[WebSocket] Error broadcasting to client:', err)
        wsClients.delete(client)
      }
    }
  })
}

// Start HTTP/HTTPS server
const protocol = httpsOptions ? 'https' : 'http'
const localIP = getLocalIP()
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ${protocol.toUpperCase()} Server running`)
  console.log(`   ${protocol}://${HOSTNAME}:${PORT}`)
  console.log(`   ${protocol}://${localIP}:${PORT}`)
  console.log(`   ${protocol}://localhost:${PORT}`)
  console.log(`📁 Serving files from: ${DIST_DIR}`)
  console.log(`🔐 Main instance protection: Enabled`)
  console.log(`📡 API endpoints available at /api/*`)
  console.log(`📱 For tablet/phone access, use: ${protocol}://${localIP}:${PORT}`)
})

// WebSocket server started
const wsProtocol = httpsOptions ? 'wss' : 'ws'
console.log(`🔌 WebSocket Server running${httpsOptions ? ' (wss:// and ws:// on the same port)' : ''}`)
console.log(`   ${wsProtocol}://${HOSTNAME}:${WS_PORT}`)
console.log(`   ${wsProtocol}://${localIP}:${WS_PORT}`)

// Export server info and control functions
export { broadcast, getLocalIP, mainGate }

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...')
  httpServer.close(() => {
    console.log('HTTP server closed')
  })
  wss.close(() => {
    console.log('WebSocket server closed')
  })
  wsListener.close()
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...')
  httpServer.close(() => {
    console.log('HTTP server closed')
  })
  wss.close(() => {
    console.log('WebSocket server closed')
  })
  wsListener.close()
  process.exit(0)
})
