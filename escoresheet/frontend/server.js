/**
 * Production Server for eScoresheet
 * Serves static files and provides WebSocket server for real-time connections
 * Supports both HTTP/HTTPS and WS/WSS
 */

import { createServer as createHttpServer } from 'http'
import { createServer as createHttpsServer } from 'https'
import { readFileSync, existsSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, extname } from 'path'
import { WebSocketServer } from 'ws'
import { networkInterfaces } from 'os'

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

// HTTPS configuration - default to true for production
const useHttps = process.env.HTTPS !== 'false' && (process.env.HTTPS === 'true' || process.env.USE_HTTPS === 'true' || process.env.NODE_ENV === 'production')
let httpsOptions = null

if (useHttps) {
  const certPath = process.env.SSL_CERT_PATH || join(__dirname, 'localhost.pem')
  const keyPath = process.env.SSL_KEY_PATH || join(__dirname, 'localhost-key.pem')
  
  if (existsSync(certPath) && existsSync(keyPath)) {
    httpsOptions = {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath)
    }
    console.log('🔒 HTTPS enabled with custom certificates')
  } else {
    console.warn('⚠️  HTTPS requested but certificates not found. Falling back to HTTP.')
    console.warn(`   Expected certificates at: ${certPath} and ${keyPath}`)
    console.warn('   Run "npm run generate-certs" to create self-signed certificates for development')
  }
}

// Singleton tracking for main scoresheet instance
let mainInstanceId = null
const mainInstanceStartTime = null
const allowedPaths = ['/referee', '/referee.html', '/bench', '/bench.html', '/livescore', '/livescore.html', '/upload_roster', '/upload_roster.html', '/scoresheet', '/scoresheet.html']

// Shared match data store (populated by main scoresheet via WebSocket)
const matchDataStore = new Map() // key: matchId, value: { match, teams, players, sets, events }
const pendingPinRequests = new Map() // key: requestId, value: { res, timeout }
const matchSubscriptions = new Map() // key: matchId, value: Set of WebSocket connections

// MIME types for static files
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
  '.pdf': 'application/pdf'
}

// WebSocket clients storage
const wsClients = new Set()

// Known HTML entry points from vite.config.js
const HTML_ENTRY_POINTS = [
  'index.html',
  'referee.html',
  'scoresheet.html',
  'bench.html',
  'livescore.html',
  'upload_roster.html'
]

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
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    res.end(JSON.stringify({
      running: true,
      mainInstanceId,
      hasMainInstance: mainInstanceId !== null,
      protocol,
      wsProtocol,
      hostname: HOSTNAME,
      localIP,
      port: PORT,
      wsPort: WS_PORT,
      urls: {
        main: `${protocol}://${HOSTNAME}:${PORT}/`,
        mainIP: `${protocol}://${localIP}:${PORT}/`,
        referee: `${protocol}://${HOSTNAME}:${PORT}/referee.html`,
        refereeIP: `${protocol}://${localIP}:${PORT}/referee.html`,
        bench: `${protocol}://${HOSTNAME}:${PORT}/bench.html`,
        benchIP: `${protocol}://${localIP}:${PORT}/bench.html`,
        livescore: `${protocol}://${HOSTNAME}:${PORT}/livescore.html`,
        livescoreIP: `${protocol}://${localIP}:${PORT}/livescore.html`,
        websocket: `${wsProtocol}://${HOSTNAME}:${WS_PORT}`,
        websocketIP: `${wsProtocol}://${localIP}:${WS_PORT}`
      }
    }))
    return
  }
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Instance-ID'
    })
    res.end()
    return
  }
  
  if (urlPath === '/api/server/register-main') {
    const instanceId = req.headers['x-instance-id'] || `instance-${Date.now()}`
    if (mainInstanceId === null) {
      mainInstanceId = instanceId
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(JSON.stringify({ success: true, instanceId }))
    } else {
      res.writeHead(409, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(JSON.stringify({ success: false, error: 'Main instance already registered', existingInstanceId: mainInstanceId }))
    }
    return
  }
  
  if (urlPath === '/api/server/unregister-main') {
    const instanceId = req.headers['x-instance-id']
    if (instanceId === mainInstanceId) {
      mainInstanceId = null
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(JSON.stringify({ success: true }))
    } else {
      res.writeHead(403, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(JSON.stringify({ success: false, error: 'Not the registered instance' }))
    }
    return
  }
  
  // API endpoint to validate PIN and get match data
  if (urlPath === '/api/match/validate-pin' && req.method === 'POST') {
    let body = ''
    let responseSent = false
    
    const sendResponse = (statusCode, data) => {
      if (responseSent) return
      responseSent = true
      res.writeHead(statusCode, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(JSON.stringify(data))
    }
    
    req.on('data', chunk => { body += chunk.toString() })
    req.on('end', () => {
      try {
        if (!body || body.trim() === '') {
          sendResponse(400, { success: false, error: 'Empty request body' })
          return
        }
        
        const { pin, type = 'referee' } = JSON.parse(body)
        
        if (!pin || pin.length !== 6) {
          sendResponse(400, { success: false, error: 'Invalid PIN format' })
          return
        }
        
        const pinStr = String(pin).trim()
        
        // First, check the match data store
        let matchFound = null
        for (const [matchId, matchData] of matchDataStore.entries()) {
          // matchData structure: { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events }
          const match = matchData.match || matchData // Support both structures
          
          if (!match) continue
          
          let matchPin = null
          if (type === 'referee') {
            matchPin = match.refereePin
          } else if (type === 'homeTeam') {
            matchPin = match.homeTeamPin
          } else if (type === 'awayTeam') {
            matchPin = match.awayTeamPin
          }
          
          if (matchPin && String(matchPin).trim() === pinStr) {
            // Check if connection is enabled
            let connectionEnabled = true
            if (type === 'referee') {
              connectionEnabled = match.refereeConnectionEnabled !== false
            } else if (type === 'homeTeam') {
              connectionEnabled = match.homeTeamConnectionEnabled !== false
            } else if (type === 'awayTeam') {
              connectionEnabled = match.awayTeamConnectionEnabled !== false
            }
            
            if (connectionEnabled && match.status !== 'final') {
              matchFound = { ...match, id: Number(matchId) }
              break
            }
          }
        }
        
        if (matchFound) {
          sendResponse(200, { 
            success: true, 
            match: matchFound 
          })
        } else {
          // Request match data from main instance via WebSocket
          const requestId = `pin-request-${Date.now()}-${Math.random()}`
          
          // Broadcast request to all connected clients (main scoresheet should respond)
          broadcast({
            type: 'pin-validation-request',
            requestId,
            pin: pinStr,
            pinType: type,
            timestamp: Date.now()
          })
          
          // Store the request and wait for response (with timeout)
          let timeoutCleared = false
          const sendResponseWrapper = (statusCode, data) => {
            if (!responseSent && !timeoutCleared) {
              responseSent = true
              timeoutCleared = true
              if (timeout) clearTimeout(timeout)
              res.writeHead(statusCode, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              })
              res.end(JSON.stringify(data))
              pendingPinRequests.delete(requestId)
            }
          }
          
          const timeout = setTimeout(() => {
            if (!responseSent) {
              sendResponseWrapper(404, { 
                success: false, 
                error: 'No match found with this PIN. Make sure the main scoresheet is running and connected.' 
              })
            }
          }, 5000) // 5 second timeout
          
          pendingPinRequests.set(requestId, { 
            res, 
            timeout,
            sendResponse: sendResponseWrapper
          })
        }
      } catch (err) {
        console.error('Error validating PIN:', err)
        sendResponse(400, { success: false, error: err.message || 'Invalid request body' })
      }
    })
    return
  }
  
  // API endpoint to get full match data (match, teams, players, sets, events)
  if (urlPath.startsWith('/api/match/') && urlPath !== '/api/match/validate-pin' && urlPath !== '/api/match/by-game-number' && req.method === 'GET') {
    const matchId = urlPath.split('/api/match/')[1]
    
    if (!matchId) {
      res.writeHead(400, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(JSON.stringify({ success: false, error: 'Match ID required' }))
      return
    }
    
    const matchData = matchDataStore.get(String(matchId))
    
    if (!matchData) {
      // Request from main instance via WebSocket
      const requestId = `match-data-request-${Date.now()}-${Math.random()}`
      
      broadcast({
        type: 'match-data-request',
        requestId,
        matchId: String(matchId)
      })
      
      const timeout = setTimeout(() => {
        res.writeHead(404, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        })
        res.end(JSON.stringify({ 
          success: false, 
          error: 'Match data not found. Make sure the main scoresheet is running and connected.' 
        }))
        pendingPinRequests.delete(requestId)
      }, 5000)
      
      pendingPinRequests.set(requestId, { res, timeout, type: 'match-data' })
      return
    }
    
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify({ 
      success: true, 
      ...matchData 
    }))
    return
  }
  
  // API endpoint to list available matches (for game number dropdown)
  if (urlPath === '/api/match/list' && req.method === 'GET') {
    const matches = Array.from(matchDataStore.entries()).map(([matchId, matchData]) => {
      const match = matchData.match || matchData
      // matchData structure: { match, homeTeam, awayTeam, ... }
      // So we need to access matchData.homeTeam, not match.homeTeam
      const homeTeamName = matchData.homeTeam?.name || match.homeTeamName || match.homeTeam?.name || 'Home'
      const awayTeamName = matchData.awayTeam?.name || match.awayTeamName || match.awayTeam?.name || 'Away'
      
      // Format scheduled date/time
      let dateTime = 'TBD'
      if (match.scheduledAt) {
        try {
          const scheduledDate = new Date(match.scheduledAt)
          const dateStr = scheduledDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          const timeStr = scheduledDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
          dateTime = `${dateStr} ${timeStr}`
        } catch (e) {
          dateTime = 'TBD'
        }
      }
      
      return {
        id: Number(matchId),
        gameNumber: match.gameNumber || match.game_n || matchId,
        homeTeam: homeTeamName,
        awayTeam: awayTeamName,
        scheduledAt: match.scheduledAt,
        dateTime,
        status: match.status,
        refereePin: match.refereePin,
        refereeConnectionEnabled: match.refereeConnectionEnabled !== false
      }
    }).filter(m => {
      // Only show matches that are:
      // 1. Referee connection enabled
      // 2. Not final (status !== 'final')
      // 3. Status is 'scheduled' or 'live' (open/in progress)
      return m.refereeConnectionEnabled && 
             m.status !== 'final' && 
             (m.status === 'scheduled' || m.status === 'live')
    })
    
    // Sort by scheduledAt (most recent first) and take only the first one
    // This ensures only 1 match is shown at a time
    matches.sort((a, b) => {
      const dateA = a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0
      const dateB = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0
      return dateB - dateA // Most recent first
    })
    
    // Only return the most recent open/in-progress match
    const activeMatch = matches.length > 0 ? [matches[0]] : []
    
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify({ 
      success: true, 
      matches: activeMatch 
    }))
    return
  }
  
  // API endpoint to find match by game number
  if (urlPath === '/api/match/by-game-number' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const gameNumber = url.searchParams.get('gameNumber')
    
    if (!gameNumber) {
      res.writeHead(400, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(JSON.stringify({ success: false, error: 'Game number required' }))
      return
    }
    
    // Search in match data store
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
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(JSON.stringify({ 
        success: true, 
        match: matchFound.match,
        matchId: matchFound.matchId
      }))
    } else {
      // Request from main instance
      const requestId = `game-number-request-${Date.now()}-${Math.random()}`
      
      broadcast({
        type: 'game-number-request',
        requestId,
        gameNumber: String(gameNumber)
      })
      
      const timeout = setTimeout(() => {
        res.writeHead(404, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        })
        res.end(JSON.stringify({ 
          success: false, 
          error: 'Match not found with this game number' 
        }))
        pendingPinRequests.delete(requestId)
      }, 5000)
      
      pendingPinRequests.set(requestId, { res, timeout, type: 'game-number' })
    }
    return
  }
  
  // API endpoint to update match data (PATCH)
  if (urlPath.startsWith('/api/match/') && urlPath !== '/api/match/validate-pin' && urlPath !== '/api/match/by-game-number' && req.method === 'PATCH') {
    const matchId = urlPath.split('/api/match/')[1]
    let body = ''
    req.on('data', chunk => { body += chunk.toString() })
    req.on('end', () => {
      try {
        const updates = JSON.parse(body)
        
        // Forward update request to main instance via WebSocket
        const requestId = `match-update-${Date.now()}-${Math.random()}`
        
        console.log(`[API] Broadcasting match-update-request for match ${matchId}, requestId: ${requestId}, connected clients: ${wsClients.size}`)
        
        broadcast({
          type: 'match-update-request',
          requestId,
          matchId: String(matchId),
          updates
        })
        
        const timeout = setTimeout(() => {
          console.warn(`[API] Match update request ${requestId} timed out after 5 seconds`)
          res.writeHead(500, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          })
          res.end(JSON.stringify({ 
            success: false, 
            error: 'Update request timeout. Make sure the main scoresheet is running.' 
          }))
          pendingPinRequests.delete(requestId)
        }, 5000)
        
        pendingPinRequests.set(requestId, { res, timeout, type: 'match-update' })
        console.log(`[API] Waiting for response to requestId: ${requestId}`)
      } catch (err) {
        res.writeHead(400, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        })
        res.end(JSON.stringify({ success: false, error: 'Invalid request body' }))
      }
    })
    return
  }
  
  // Check if accessing main page and block if another instance exists
  const isMainPage = urlPath === '/' || urlPath === '/index.html'
  if (isMainPage && mainInstanceId !== null) {
    const requestingInstanceId = req.headers['x-instance-id']
    if (requestingInstanceId !== mainInstanceId) {
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
            <li><a href="/referee.html">Referee App</a></li>
            <li><a href="/bench.html">Bench App</a></li>
            <li><a href="/livescore.html">Livescore App</a></li>
          </ul>
        </body>
        </html>
      `)
      return
    }
  }
  
  // Allow access to referee, bench, livescore, etc. even if main instance exists
  let filePath = join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath)
  
  // Security: prevent directory traversal
  if (!filePath.startsWith(DIST_DIR)) {
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
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000'
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

// Create WebSocket server (WSS if HTTPS is enabled)
const wss = new WebSocketServer({ 
  port: WS_PORT,
  perMessageDeflate: false, // Disable compression for better performance
  ...(httpsOptions && { 
    // If HTTPS is enabled, we can upgrade HTTPS connections to WSS
    // Otherwise, use regular WS
  })
})

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress
  console.log(`[WebSocket] New client connected from ${clientIp}`)
  
  wsClients.add(ws)
  
  // Send welcome message
  ws.send(JSON.stringify({ 
    type: 'connected',
    message: 'Connected to eScoresheet WebSocket server',
    timestamp: Date.now()
  }))
  
  // Handle messages from client
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString())
      console.log(`[WebSocket] Received message from ${clientIp}:`, data.type || 'unknown')
      
      // Handle different message types
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
      } else if (data.type === 'sync-match-data') {
        // Main scoresheet is syncing full match data
        // SCOREBOARD IS SOURCE OF TRUTH - This ALWAYS overwrites existing data
        // Handle both formats: { matchId, matchData: {...} } and { matchId, match, homeTeam, ... }
        if (data.matchId) {
          let matchData
          
          if (data.matchData) {
            // Format 1: Nested in matchData
            matchData = data.matchData
          } else if (data.match) {
            // Format 2: Flat structure (from Scoreboard component)
            matchData = {
              match: data.match,
              homeTeam: data.homeTeam,
              awayTeam: data.awayTeam,
              homePlayers: data.homePlayers || [],
              awayPlayers: data.awayPlayers || [],
              sets: data.sets || [],
              events: data.events || []
            }
          }
          
          if (matchData) {
            // ALWAYS overwrite - scoreboard data is authoritative
            matchDataStore.set(String(data.matchId), matchData)
            console.log(`[WebSocket] Synced full match data for match ${data.matchId} (overwrote existing)`)
          
          // Broadcast update to subscribed clients
          const subscribers = matchSubscriptions.get(String(data.matchId))
          if (subscribers) {
            subscribers.forEach(client => {
              if (client !== ws && client.readyState === 1) {
                try {
                  client.send(JSON.stringify({
                    type: 'match-data-update',
                    matchId: String(data.matchId),
                      data: matchData
                  }))
                } catch (err) {
                  console.error('[WebSocket] Error sending update to subscriber:', err)
                }
              }
            })
            }
          }
        }
      } else if (data.type === 'delete-match') {
        // Main scoresheet is deleting a match - remove from server store
        const matchId = String(data.matchId)
        if (matchDataStore.has(matchId)) {
          matchDataStore.delete(matchId)
          console.log(`[WebSocket] Deleted match ${matchId} from server store`)
          
          // Remove subscriptions for this match
          matchSubscriptions.delete(matchId)
          
          // Notify subscribed clients that match was deleted
          const subscribers = matchSubscriptions.get(matchId)
          if (subscribers) {
            subscribers.forEach(client => {
              if (client.readyState === 1) {
                try {
                  client.send(JSON.stringify({
                    type: 'match-deleted',
                    matchId: matchId
                  }))
                } catch (err) {
                  console.error('[WebSocket] Error notifying subscriber of match deletion:', err)
                }
              }
            })
          }
        }
      } else if (data.type === 'clear-all-matches') {
        // Scoreboard is clearing all matches (source of truth - no active match)
        // Optionally keep one match if keepMatchId is specified
        const keepMatchId = data.keepMatchId ? String(data.keepMatchId) : null
        
        const matchesToDelete = []
        for (const [storedMatchId] of matchDataStore.entries()) {
          if (!keepMatchId || storedMatchId !== keepMatchId) {
            matchesToDelete.push(storedMatchId)
          }
        }
        
        matchesToDelete.forEach(matchIdToDelete => {
          matchDataStore.delete(matchIdToDelete)
          matchSubscriptions.delete(matchIdToDelete)
          
          // Notify subscribed clients
          const subscribers = matchSubscriptions.get(matchIdToDelete)
          if (subscribers) {
            subscribers.forEach(client => {
              if (client.readyState === 1) {
                try {
                  client.send(JSON.stringify({
                    type: 'match-deleted',
                    matchId: matchIdToDelete
                  }))
                } catch (err) {
                  console.error('[WebSocket] Error notifying subscriber of match deletion:', err)
                }
              }
            })
          }
        })
        
        console.log(`[WebSocket] Cleared ${matchesToDelete.length} match(es) from server store${keepMatchId ? ` (kept match ${keepMatchId})` : ''}`)
      } else if (data.type === 'subscribe-match') {
        // Client wants to subscribe to match updates
        const matchId = String(data.matchId)
        if (!matchSubscriptions.has(matchId)) {
          matchSubscriptions.set(matchId, new Set())
        }
        matchSubscriptions.get(matchId).add(ws)
        console.log(`[WebSocket] Client subscribed to match ${matchId}`)
        
        // Send current match data if available
        const matchData = matchDataStore.get(matchId)
        if (matchData) {
          ws.send(JSON.stringify({
            type: 'match-full-data',
            matchId,
            data: matchData
          }))
        }
      } else if (data.type === 'pin-validation-response') {
        // Main scoresheet responded to a PIN validation request
        const requestId = data.requestId
        const pending = pendingPinRequests.get(requestId)
        if (pending) {
          // Clear timeout if it exists
          if (pending.timeout) {
            clearTimeout(pending.timeout)
          }
          
          if (data.success && data.match) {
            // Store the match data for future requests
            if (data.fullData) {
              matchDataStore.set(String(data.match.id), data.fullData)
            } else {
              matchDataStore.set(String(data.match.id), { match: data.match })
            }
            
            // Use sendResponse wrapper to ensure proper cleanup
            if (pending.sendResponse) {
              pending.sendResponse(200, { 
                success: true, 
                match: data.match 
              })
            } else {
              // Fallback to direct response
              try {
                pending.res.writeHead(200, { 
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*'
                })
                pending.res.end(JSON.stringify({ 
                  success: true, 
                  match: data.match 
                }))
              } catch (err) {
                console.error('[WebSocket] Error sending PIN validation response:', err)
              }
              pendingPinRequests.delete(requestId)
            }
          } else {
            // Use sendResponse wrapper to ensure proper cleanup
            if (pending.sendResponse) {
              pending.sendResponse(404, { 
                success: false, 
                error: data.error || 'No match found with this PIN' 
              })
            } else {
              // Fallback to direct response
              try {
                pending.res.writeHead(404, { 
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*'
                })
                pending.res.end(JSON.stringify({ 
                  success: false, 
                  error: data.error || 'No match found with this PIN' 
                }))
              } catch (err) {
                console.error('[WebSocket] Error sending PIN validation error:', err)
              }
              pendingPinRequests.delete(requestId)
            }
          }
        }
      } else if (data.type === 'match-data-response') {
        // Main scoresheet responded to match data request
        const requestId = data.requestId
        const pending = pendingPinRequests.get(requestId)
        if (pending && pending.type === 'match-data') {
          clearTimeout(pending.timeout)
          pendingPinRequests.delete(requestId)
          
          if (data.success && data.data) {
            matchDataStore.set(String(data.matchId), data.data)
            pending.res.writeHead(200, { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            })
            pending.res.end(JSON.stringify({ 
              success: true, 
              ...data.data 
            }))
          } else {
            pending.res.writeHead(404, { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            })
            pending.res.end(JSON.stringify({ 
              success: false, 
              error: data.error || 'Match data not found' 
            }))
          }
        }
      } else if (data.type === 'game-number-response') {
        // Main scoresheet responded to game number request
        const requestId = data.requestId
        const pending = pendingPinRequests.get(requestId)
        if (pending && pending.type === 'game-number') {
          clearTimeout(pending.timeout)
          pendingPinRequests.delete(requestId)
          
          if (data.success && data.match) {
            pending.res.writeHead(200, { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            })
            pending.res.end(JSON.stringify({ 
              success: true, 
              match: data.match,
              matchId: data.matchId
            }))
          } else {
            pending.res.writeHead(404, { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            })
            pending.res.end(JSON.stringify({ 
              success: false, 
              error: data.error || 'Match not found' 
            }))
          }
        }
      } else if (data.type === 'match-update-response') {
        // Main scoresheet responded to match update request
        const requestId = data.requestId
        console.log(`[WebSocket] Received match-update-response for requestId: ${requestId}, success: ${data.success}`)
        const pending = pendingPinRequests.get(requestId)
        if (pending && pending.type === 'match-update') {
          console.log(`[WebSocket] Found pending request, responding to HTTP client`)
          clearTimeout(pending.timeout)
          pendingPinRequests.delete(requestId)
          
          if (data.success) {
            // Update local store if full data provided
            if (data.data) {
              matchDataStore.set(String(data.matchId), data.data)
            }
            
            pending.res.writeHead(200, { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            })
            pending.res.end(JSON.stringify({ 
              success: true,
              ...(data.data || {})
            }))
          } else {
            pending.res.writeHead(500, { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            })
            pending.res.end(JSON.stringify({ 
              success: false, 
              error: data.error || 'Update failed' 
            }))
          }
        } else {
          console.warn(`[WebSocket] Received match-update-response but no pending request found for requestId: ${requestId}`)
          console.log(`[WebSocket] Available pending requests:`, Array.from(pendingPinRequests.keys()))
        }
      } else {
        // Broadcast to all other clients (for other message types)
        broadcast(data, ws)
      }
    } catch (err) {
      console.error('[WebSocket] Error parsing message:', err)
    }
  })
  
  // Handle client disconnect - remove from subscriptions
  ws.on('close', () => {
    console.log(`[WebSocket] Client disconnected from ${clientIp}`)
    wsClients.delete(ws)
    
    // Remove from all match subscriptions
    matchSubscriptions.forEach((subscribers, matchId) => {
      subscribers.delete(ws)
      if (subscribers.size === 0) {
        matchSubscriptions.delete(matchId)
      }
    })
  })
  
  
  // Handle errors
  ws.on('error', (error) => {
    console.error(`[WebSocket] Error from ${clientIp}:`, error)
    wsClients.delete(ws)
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
console.log(`🔌 WebSocket Server running`)
console.log(`   ${wsProtocol}://${HOSTNAME}:${WS_PORT}`)
console.log(`   ${wsProtocol}://${localIP}:${WS_PORT}`)

// Export server info and control functions
export { broadcast, getLocalIP, mainInstanceId }

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...')
  httpServer.close(() => {
    console.log('HTTP server closed')
  })
  wss.close(() => {
    console.log('WebSocket server closed')
  })
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
  process.exit(0)
})

// Export broadcast function for potential use in other modules
export { broadcast }
