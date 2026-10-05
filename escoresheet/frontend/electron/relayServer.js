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
 * IMPORTANT: the WebSocket message protocol and the /api/* endpoints here MUST
 * stay in sync with ../server.js (the standalone LAN server used by
 * `npm run start`) — clients talk to both interchangeably. When you change the
 * relay protocol in one, change it in the other.
 */

const { createServer: createHttpServer } = require('http')
const { readFileSync, existsSync, statSync } = require('fs')
const { join, extname, basename, sep } = require('path')
const { WebSocketServer } = require('ws')
const { networkInterfaces } = require('os')

// --- Secret redaction (mirrors ../lanRelayCore.js, inlined for CJS) ---
const MATCH_SECRET_FIELDS = [
  'refereePin', 'homeTeamPin', 'awayTeamPin',
  'homeTeamUploadPin', 'awayTeamUploadPin',
  'connection_pins', 'connectionPins', 'game_pin', 'gamePin',
]
function stripMatchSecrets(match) {
  if (!match || typeof match !== 'object') return match
  const clean = { ...match }
  for (const k of MATCH_SECRET_FIELDS) delete clean[k]
  return clean
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
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

const MAX_BODY_SIZE = 1024 * 1024 // 1MB
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX_REQUESTS = 10

// Loopback = the desktop app itself. Tablets connect over the LAN IP, so the
// loopback check lets the local scoretable reload without tripping the
// single-main-instance gate, while still gating a second device on the LAN.
function isLoopback(addr) {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

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

    // Relay state
    const matchDataStore = new Map() // matchId -> { match, homeTeam, ... }
    const pendingRequests = new Map() // requestId -> pending HTTP response
    const matchSubscriptions = new Map() // matchId -> Set<ws>
    const wsClients = new Set()
    const rateLimitMap = new Map()
    let mainInstanceId = null

    function isRateLimited(ip) {
      const now = Date.now()
      const entry = rateLimitMap.get(ip)
      if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
        rateLimitMap.set(ip, { count: 1, windowStart: now })
        return false
      }
      entry.count++
      return entry.count > RATE_LIMIT_MAX_REQUESTS
    }

    function broadcast(data, excludeWs = null) {
      const message = JSON.stringify(data)
      wsClients.forEach((client) => {
        if (client !== excludeWs && client.readyState === 1) {
          try { client.send(message) } catch { wsClients.delete(client) }
        }
      })
    }

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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Instance-ID')
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
          mainInstanceId,
          hasMainInstance: mainInstanceId !== null,
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

      if (urlPath === '/api/server/register-main') {
        const instanceId = req.headers['x-instance-id'] || `instance-${Date.now()}`
        // The desktop app (loopback) is always allowed to (re)claim main.
        if (mainInstanceId === null || isLoopback(remote)) {
          mainInstanceId = instanceId
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, instanceId }))
        } else {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Main instance already registered', existingInstanceId: mainInstanceId }))
        }
        return
      }

      if (urlPath === '/api/server/unregister-main') {
        const instanceId = req.headers['x-instance-id']
        if (instanceId === mainInstanceId || isLoopback(remote)) {
          mainInstanceId = null
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Not the registered instance' }))
        }
        return
      }

      // --- PIN validation ---
      if (urlPath === '/api/match/validate-pin' && req.method === 'POST') {
        const clientIp = remote || 'unknown'
        if (isRateLimited(clientIp)) {
          res.writeHead(429, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Too many attempts. Please wait a minute before trying again.' }))
          return
        }

        let body = ''
        let responseSent = false
        const sendResponse = (statusCode, data) => {
          if (responseSent) return
          responseSent = true
          res.writeHead(statusCode, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        }

        req.on('data', (chunk) => {
          body += chunk.toString()
          if (body.length > MAX_BODY_SIZE) req.destroy()
        })
        req.on('end', () => {
          try {
            if (!body || body.trim() === '') {
              sendResponse(400, { success: false, error: 'Empty request body' })
              return
            }
            const { pin, type = 'referee' } = JSON.parse(body)
            if (!pin || String(pin).length !== 6) {
              sendResponse(400, { success: false, error: 'Invalid PIN format' })
              return
            }
            const pinStr = String(pin).trim()

            let matchFound = null
            for (const [matchId, matchData] of matchDataStore.entries()) {
              const match = matchData.match || matchData
              if (!match) continue
              let matchPin = null
              let connectionEnabled = true
              if (type === 'referee') { matchPin = match.refereePin; connectionEnabled = match.refereeConnectionEnabled === true }
              else if (type === 'homeTeam') { matchPin = match.homeTeamPin; connectionEnabled = match.homeTeamConnectionEnabled === true }
              else if (type === 'awayTeam') { matchPin = match.awayTeamPin; connectionEnabled = match.awayTeamConnectionEnabled === true }

              if (matchPin && String(matchPin).trim() === pinStr && connectionEnabled && match.status !== 'final') {
                matchFound = { ...match, id: Number(matchId) }
                break
              }
            }

            if (matchFound) {
              sendResponse(200, { success: true, match: matchFound })
              return
            }

            // Ask the main scoretable over WS (it may hold a match not yet synced).
            const requestId = `pin-request-${Date.now()}-${Math.random()}`
            broadcast({ type: 'pin-validation-request', requestId, pin: pinStr, pinType: type, timestamp: Date.now() })
            const timeout = setTimeout(() => {
              sendResponse(404, { success: false, error: 'No match found with this PIN. Make sure the main scoresheet is running and connected.' })
              pendingRequests.delete(requestId)
            }, 5000)
            pendingRequests.set(requestId, { res, timeout, sendResponse })
          } catch (err) {
            sendResponse(400, { success: false, error: err.message || 'Invalid request body' })
          }
        })
        return
      }

      // --- Get full match data (PINs stripped) ---
      if (urlPath.startsWith('/api/match/') && urlPath !== '/api/match/validate-pin' && urlPath !== '/api/match/by-game-number' && urlPath !== '/api/match/list' && req.method === 'GET') {
        const matchId = urlPath.split('/api/match/')[1]
        if (!matchId) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Match ID required' }))
          return
        }
        const matchData = matchDataStore.get(String(matchId))
        if (!matchData) {
          const requestId = `match-data-request-${Date.now()}-${Math.random()}`
          broadcast({ type: 'match-data-request', requestId, matchId: String(matchId) })
          const timeout = setTimeout(() => {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'Match data not found. Make sure the main scoresheet is running and connected.' }))
            pendingRequests.delete(requestId)
          }, 5000)
          pendingRequests.set(requestId, { res, timeout, type: 'match-data' })
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, ...matchData, match: stripMatchSecrets(matchData.match) }))
        return
      }

      // --- List available matches (most recent open one) ---
      if (urlPath === '/api/match/list' && req.method === 'GET') {
        const matches = Array.from(matchDataStore.entries()).map(([matchId, matchData]) => {
          const match = matchData.match || matchData
          const homeTeamName = matchData.homeTeam?.name || match.homeTeamName || match.homeTeam?.name || 'Home'
          const awayTeamName = matchData.awayTeam?.name || match.awayTeamName || match.awayTeam?.name || 'Away'
          let dateTime = 'TBD'
          if (match.scheduledAt) {
            try {
              const d = new Date(match.scheduledAt)
              const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
              dateTime = `${dateStr} ${timeStr}`
            } catch { dateTime = 'TBD' }
          }
          return {
            id: Number(matchId),
            gameNumber: match.gameNumber || match.game_n || matchId,
            homeTeam: homeTeamName,
            awayTeam: awayTeamName,
            scheduledAt: match.scheduledAt,
            dateTime,
            status: match.status,
            refereeConnectionEnabled: match.refereeConnectionEnabled === true,
          }
        }).filter((m) => m.refereeConnectionEnabled && m.status !== 'final' && (m.status === 'scheduled' || m.status === 'live'))

        matches.sort((a, b) => {
          const da = a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0
          const db = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0
          return db - da
        })
        const activeMatch = matches.length > 0 ? [matches[0]] : []
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, matches: activeMatch }))
        return
      }

      // --- Find match by game number ---
      if (urlPath === '/api/match/by-game-number' && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`)
        const gameNumber = url.searchParams.get('gameNumber')
        if (!gameNumber) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Game number required' }))
          return
        }
        let matchFound = null
        for (const [matchId, matchData] of matchDataStore.entries()) {
          const match = matchData.match
          if (match && (
            String(match.gameNumber || '') === String(gameNumber) ||
            String(match.game_n || '') === String(gameNumber) ||
            String(match.id) === String(gameNumber)
          )) {
            matchFound = { matchId, ...matchData }
            break
          }
        }
        if (matchFound) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, match: stripMatchSecrets(matchFound.match), matchId: matchFound.matchId }))
        } else {
          const requestId = `game-number-request-${Date.now()}-${Math.random()}`
          broadcast({ type: 'game-number-request', requestId, gameNumber: String(gameNumber) })
          const timeout = setTimeout(() => {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'Match not found with this game number' }))
            pendingRequests.delete(requestId)
          }, 5000)
          pendingRequests.set(requestId, { res, timeout, type: 'game-number' })
        }
        return
      }

      // --- Update match data (PATCH forwarded to the main scoretable) ---
      if (urlPath.startsWith('/api/match/') && urlPath !== '/api/match/validate-pin' && urlPath !== '/api/match/by-game-number' && req.method === 'PATCH') {
        const matchId = urlPath.split('/api/match/')[1]
        let body = ''
        req.on('data', (chunk) => {
          body += chunk.toString()
          if (body.length > MAX_BODY_SIZE) req.destroy()
        })
        req.on('end', () => {
          try {
            const updates = JSON.parse(body)
            const requestId = `match-update-${Date.now()}-${Math.random()}`
            broadcast({ type: 'match-update-request', requestId, matchId: String(matchId), updates })
            const timeout = setTimeout(() => {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: 'Update request timeout. Make sure the main scoresheet is running.' }))
              pendingRequests.delete(requestId)
            }, 5000)
            pendingRequests.set(requestId, { res, timeout, type: 'match-update' })
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'Invalid request body' }))
          }
        })
        return
      }

      // --- Single main-instance gate (skipped for the loopback desktop app) ---
      const isMainPage = urlPath === '/' || urlPath === '/index.html'
      if (isMainPage && mainInstanceId !== null && !isLoopback(remote)) {
        const requestingInstanceId = req.headers['x-instance-id']
        if (requestingInstanceId !== mainInstanceId) {
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
        })
        res.end(content)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      }
    }

    // --- WebSocket relay ---
    function handleWsMessage(ws, message) {
      let data
      try { data = JSON.parse(message.toString()) } catch { return }

      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
        return
      }

      if (data.type === 'sync-match-data' && data.matchId) {
        let matchData
        if (data.matchData) {
          matchData = data.matchData
        } else if (data.match) {
          matchData = {
            match: data.match,
            homeTeam: data.homeTeam,
            awayTeam: data.awayTeam,
            homePlayers: data.homePlayers || [],
            awayPlayers: data.awayPlayers || [],
            sets: data.sets || [],
            events: data.events || [],
          }
        }
        if (matchData) {
          matchDataStore.set(String(data.matchId), matchData)
          const subscribers = matchSubscriptions.get(String(data.matchId))
          if (subscribers) {
            subscribers.forEach((client) => {
              if (client !== ws && client.readyState === 1) {
                try { client.send(JSON.stringify({ type: 'match-data-update', matchId: String(data.matchId), data: matchData })) } catch { /* ignore */ }
              }
            })
          }
        }
        return
      }

      if (data.type === 'delete-match') {
        const matchId = String(data.matchId)
        if (matchDataStore.has(matchId)) {
          matchDataStore.delete(matchId)
          const subscribers = matchSubscriptions.get(matchId)
          if (subscribers) {
            subscribers.forEach((client) => {
              if (client.readyState === 1) {
                try { client.send(JSON.stringify({ type: 'match-deleted', matchId })) } catch { /* ignore */ }
              }
            })
          }
          matchSubscriptions.delete(matchId)
        }
        return
      }

      if (data.type === 'clear-all-matches') {
        const keepMatchId = data.keepMatchId ? String(data.keepMatchId) : null
        const toDelete = []
        for (const [storedId] of matchDataStore.entries()) {
          if (!keepMatchId || storedId !== keepMatchId) toDelete.push(storedId)
        }
        toDelete.forEach((id) => {
          const subscribers = matchSubscriptions.get(id)
          if (subscribers) {
            subscribers.forEach((client) => {
              if (client.readyState === 1) {
                try { client.send(JSON.stringify({ type: 'match-deleted', matchId: id })) } catch { /* ignore */ }
              }
            })
          }
          matchDataStore.delete(id)
          matchSubscriptions.delete(id)
        })
        return
      }

      if (data.type === 'subscribe-match') {
        const matchId = String(data.matchId)
        if (!matchSubscriptions.has(matchId)) matchSubscriptions.set(matchId, new Set())
        matchSubscriptions.get(matchId).add(ws)
        const matchData = matchDataStore.get(matchId)
        if (matchData) {
          ws.send(JSON.stringify({ type: 'match-full-data', matchId, data: matchData }))
        }
        return
      }

      if (data.type === 'pin-validation-response') {
        const pending = pendingRequests.get(data.requestId)
        if (pending) {
          if (pending.timeout) clearTimeout(pending.timeout)
          pendingRequests.delete(data.requestId)
          if (data.success && data.match) {
            if (data.fullData) matchDataStore.set(String(data.match.id), data.fullData)
            else matchDataStore.set(String(data.match.id), { match: data.match })
            pending.sendResponse
              ? pending.sendResponse(200, { success: true, match: data.match })
              : (pending.res.writeHead(200, { 'Content-Type': 'application/json' }), pending.res.end(JSON.stringify({ success: true, match: data.match })))
          } else {
            pending.sendResponse
              ? pending.sendResponse(404, { success: false, error: data.error || 'No match found with this PIN' })
              : (pending.res.writeHead(404, { 'Content-Type': 'application/json' }), pending.res.end(JSON.stringify({ success: false, error: data.error || 'No match found with this PIN' })))
          }
        }
        return
      }

      if (data.type === 'match-data-response') {
        const pending = pendingRequests.get(data.requestId)
        if (pending && pending.type === 'match-data') {
          clearTimeout(pending.timeout)
          pendingRequests.delete(data.requestId)
          if (data.success && data.data) {
            matchDataStore.set(String(data.matchId), data.data)
            pending.res.writeHead(200, { 'Content-Type': 'application/json' })
            pending.res.end(JSON.stringify({ success: true, ...data.data, match: stripMatchSecrets(data.data.match) }))
          } else {
            pending.res.writeHead(404, { 'Content-Type': 'application/json' })
            pending.res.end(JSON.stringify({ success: false, error: data.error || 'Match data not found' }))
          }
        }
        return
      }

      if (data.type === 'game-number-response') {
        const pending = pendingRequests.get(data.requestId)
        if (pending && pending.type === 'game-number') {
          clearTimeout(pending.timeout)
          pendingRequests.delete(data.requestId)
          if (data.success && data.match) {
            pending.res.writeHead(200, { 'Content-Type': 'application/json' })
            pending.res.end(JSON.stringify({ success: true, match: stripMatchSecrets(data.match), matchId: data.matchId }))
          } else {
            pending.res.writeHead(404, { 'Content-Type': 'application/json' })
            pending.res.end(JSON.stringify({ success: false, error: data.error || 'Match not found' }))
          }
        }
        return
      }

      if (data.type === 'match-update-response') {
        const pending = pendingRequests.get(data.requestId)
        if (pending && pending.type === 'match-update') {
          clearTimeout(pending.timeout)
          pendingRequests.delete(data.requestId)
          if (data.success) {
            if (data.data) matchDataStore.set(String(data.matchId), data.data)
            pending.res.writeHead(200, { 'Content-Type': 'application/json' })
            pending.res.end(JSON.stringify({ success: true, ...(data.data || {}) }))
          } else {
            pending.res.writeHead(500, { 'Content-Type': 'application/json' })
            pending.res.end(JSON.stringify({ success: false, error: data.error || 'Update failed' }))
          }
        }
        return
      }

      // Fallback: relay to other clients (e.g. live match-action events).
      broadcast(data, ws)
    }

    httpServer = createHttpServer(requestHandler)

    httpServer.on('error', (err) => {
      httpServer = null
      reject(err)
    })

    httpServer.listen(PORT, '0.0.0.0', () => {
      // WS server only after HTTP is up, so a port clash rejects cleanly.
      wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0', perMessageDeflate: false })
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
        ws.send(JSON.stringify({ type: 'connected', message: 'Connected to eScoresheet WebSocket server', timestamp: Date.now() }))
        ws.on('message', (msg) => handleWsMessage(ws, msg))
        ws.on('close', () => {
          wsClients.delete(ws)
          matchSubscriptions.forEach((subs, matchId) => {
            subs.delete(ws)
            if (subs.size === 0) matchSubscriptions.delete(matchId)
          })
        })
        ws.on('error', () => { wsClients.delete(ws) })
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
