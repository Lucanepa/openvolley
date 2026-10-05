/**
 * Vite Plugin for API Routes
 * Adds the same API routes and WebSocket relay as server.js to the Vite dev
 * server. Both use the shared protocol in ./lanRelayCore.js.
 */

import { WebSocketServer } from 'ws'
import { networkInterfaces } from 'os'
import { createServer as createHttpsServer } from 'https'
import { createServer as createHttpServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { createLanRelay, createLocalAddressCheck, createMainInstanceGate, WS_MAX_PAYLOAD } from './lanRelayCore.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Shared relay state + WS protocol (same module as server.js and the Electron relay)
const relay = createLanRelay()
// Same main-instance rule as every relay: only this machine may take/release it
const mainGate = createMainInstanceGate({ isLocal: createLocalAddressCheck(networkInterfaces) })

// Get local IP address
function getLocalIP() {
  const interfaces = networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}

export function vitePluginApiRoutes(options = {}) {
  const { wsPort = 8080 } = options
  let wss = null
  let viteServer = null
  let httpServer = null

  return {
    name: 'vite-plugin-api-routes',
    enforce: 'pre', // Run before other plugins
    configureServer(server) {
      viteServer = server
      const useHttps = !!server.config.server.https
      const protocol = useHttps ? 'wss' : 'ws'
      const hostname = '0.0.0.0'

      // Create WebSocket server with SSL support
      if (useHttps) {
        // Try to use the same certificates as Vite
        const certPath = resolve(__dirname, 'localhost.pem')
        const keyPath = resolve(__dirname, 'localhost-key.pem')
        
        if (existsSync(certPath) && existsSync(keyPath)) {
          const httpsOptions = {
            cert: readFileSync(certPath),
            key: readFileSync(keyPath)
          }
          httpServer = createHttpsServer(httpsOptions)
          wss = new WebSocketServer({ 
            server: httpServer,
            perMessageDeflate: false,
            maxPayload: WS_MAX_PAYLOAD
          })
          httpServer.listen(wsPort, hostname, () => {
            console.log(`🔒 Secure WebSocket Server (WSS) running on port ${wsPort}`)
          })
        } else {
          console.warn('⚠️  SSL certificates not found, falling back to non-secure WebSocket')
          wss = new WebSocketServer({ 
            port: wsPort,
            perMessageDeflate: false,
            maxPayload: WS_MAX_PAYLOAD
          })
        }
      } else {
        // Create non-secure WebSocket server
      wss = new WebSocketServer({ 
        port: wsPort,
        perMessageDeflate: false,
        maxPayload: WS_MAX_PAYLOAD
      })
      }

      wss.on('connection', (ws, req) => {
        // Sends the 'connected' welcome message
        relay.addClient(ws, { ip: req.socket.remoteAddress })
        // All message handling lives in lanRelayCore (shared with server.js)
        ws.on('message', (data) => relay.handleMessage(ws, data))
        ws.on('close', () => relay.removeClient(ws))
        ws.on('error', (error) => {
          console.error('[WebSocket] Error:', error)
          relay.removeClient(ws)
        })
      })

      if (!useHttps || !httpServer) {
      console.log(`🔌 WebSocket Server running on port ${wsPort}`)
      }
      console.log(`📡 API routes enabled for dev server`)

      // Add API middleware - must be added before Vite's default middleware
      // Use a function to ensure it's called for every request
      const apiMiddleware = (req, res, next) => {
        // Early return if not an API request (shouldn't happen due to .use('/api'), but just in case)
        if (!req.url.startsWith('/match/') && !req.url.startsWith('/server/')) {
          return next()
        }
        // Vite's connect middleware strips the prefix when using .use('/api', ...)
        // So /api/match/validate-pin becomes req.url = '/match/validate-pin'
        const urlPath = req.url.split('?')[0]
        
        // Ensure we handle the response properly
        if (res.headersSent) {
          return next()
        }
        
        // CORS headers — reflect only same-origin/localhost/LAN origins so an
        // arbitrary website a developer visits cannot read dev-server responses.
        const devOrigin = req.headers.origin
        if (devOrigin && /^https?:\/\/(localhost|127\.0\.0\.1|(\d{1,3}\.){3}\d{1,3})(:\d+)?$/.test(devOrigin)) {
          res.setHeader('Access-Control-Allow-Origin', devOrigin)
          res.setHeader('Vary', 'Origin')
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Instance-ID, X-OV-Match-Pin, X-OV-Match-Token')

        // Security headers
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('X-Frame-Options', 'SAMEORIGIN')
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')

        // Handle OPTIONS preflight
        if (req.method === 'OPTIONS') {
          res.writeHead(200)
          res.end()
          return
        }
        
        // Server status
        if (urlPath === '/server/status') {
          const localIP = getLocalIP()
          const protocol = server.config.server.https ? 'https' : 'http'
          const wsProtocol = server.config.server.https ? 'wss' : 'ws'
          const port = server.config.server.port || 5173
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            running: true,
            mainInstanceId: mainGate.mainInstanceId,
            hasMainInstance: mainGate.mainInstanceId !== null,
            protocol,
            wsProtocol,
            hostname: 'escoresheet.local',
            localIP,
            port,
            wsPort,
            urls: {
              main: `${protocol}://escoresheet.local:${port}/`,
              mainIP: `${protocol}://${localIP}:${port}/`,
              referee: `${protocol}://escoresheet.local:${port}/referee/`,
              refereeIP: `${protocol}://${localIP}:${port}/referee/`,
              bench: `${protocol}://escoresheet.local:${port}/bench/`,
              benchIP: `${protocol}://${localIP}:${port}/bench/`,
              livescore: `${protocol}://escoresheet.local:${port}/livescore/`,
              livescoreIP: `${protocol}://${localIP}:${port}/livescore/`,
              websocket: `${wsProtocol}://escoresheet.local:${wsPort}`,
              websocketIP: `${wsProtocol}://${localIP}:${wsPort}`
            }
          }))
          return
        }
        
        // Register / unregister the main instance (shared rule in lanRelayCore)
        if (mainGate.handleRequest(req, res, '/api' + urlPath)) {
          return
        }

        // Relay-owned endpoints (validate-pin, match/:id, list, by-game-number,
        // PATCH, server/connections) — one implementation in lanRelayCore.
        if (relay.handleApiRequest(req, res, '/api' + req.url)) {
          return
        }

        // If no route matched, continue to next middleware
        next()
      }
      
      // Register the middleware - use unshift to add it first
      // This ensures it runs before Vite's default handlers
      server.middlewares.use('/api', apiMiddleware)
    },
    
    closeBundle() {
      if (wss) {
        wss.close()
        console.log('WebSocket server closed')
      }
      if (httpServer) {
        httpServer.close()
        console.log('HTTPS server for WebSocket closed')
      }
    }
  }
}
