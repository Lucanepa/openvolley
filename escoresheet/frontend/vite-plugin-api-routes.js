/**
 * Vite Plugin for API Routes
 * Adds the same API routes from server.js to the Vite dev server
 */

import { WebSocketServer } from 'ws'
import { networkInterfaces } from 'os'

// Shared state (same as server.js)
const matchDataStore = new Map() // key: matchId, value: { match, teams, players, sets, events }
const pendingPinRequests = new Map() // key: requestId, value: { res, timeout, sendResponse }
const matchSubscriptions = new Map() // key: matchId, value: Set of WebSocket connections
const wsClients = new Set()
let mainInstanceId = null

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

// Broadcast function
function broadcast(data, excludeWs = null) {
  const message = JSON.stringify(data)
  wsClients.forEach((client) => {
    if (client !== excludeWs && client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(message)
      } catch (err) {
        console.error('[WebSocket] Error broadcasting:', err)
        wsClients.delete(client)
      }
    }
  })
}

export function vitePluginApiRoutes(options = {}) {
  const { wsPort = 8080 } = options
  let wss = null
  let viteServer = null

  return {
    name: 'vite-plugin-api-routes',
    enforce: 'pre', // Run before other plugins
    configureServer(server) {
      viteServer = server
      const protocol = server.config.server.https ? 'https' : 'http'
      const hostname = '0.0.0.0'

      // Create WebSocket server
      wss = new WebSocketServer({ 
        port: wsPort,
        perMessageDeflate: false
      })

      wss.on('connection', (ws, req) => {
        const clientIp = req.socket.remoteAddress
        console.log(`[WebSocket] New client connected from ${clientIp}`)
        
        wsClients.add(ws)
        
        ws.send(JSON.stringify({ 
          type: 'connected',
          message: 'Connected to eScoresheet WebSocket server',
          timestamp: Date.now()
        }))
        
        // Handle messages
        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString())
            
            if (message.type === 'sync-match-data') {
              // Store full match data from main scoresheet
              const { matchId, match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events } = message
              if (matchId && match) {
                matchDataStore.set(String(matchId), {
                  match,
                  homeTeam,
                  awayTeam,
                  homePlayers,
                  awayPlayers,
                  sets,
                  events
                })
                
                // Broadcast to subscribed clients
                const subscribers = matchSubscriptions.get(String(matchId))
                if (subscribers) {
                  subscribers.forEach((subscriber) => {
                    if (subscriber.readyState === 1) {
                      subscriber.send(JSON.stringify({
                        type: 'match-data-update',
                        matchId: String(matchId),
                        data: { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events }
                      }))
                    }
                  })
                }
              }
            } else if (message.type === 'subscribe-match') {
              const { matchId } = message
              if (!matchSubscriptions.has(String(matchId))) {
                matchSubscriptions.set(String(matchId), new Set())
              }
              matchSubscriptions.get(String(matchId)).add(ws)
              
              // Send current data if available
              const matchData = matchDataStore.get(String(matchId))
              if (matchData) {
                ws.send(JSON.stringify({
                  type: 'match-full-data',
                  matchId: String(matchId),
                  data: matchData
                }))
              }
            } else if (message.type === 'pin-validation-response') {
              const { requestId, success, match, fullData } = message
              const pending = pendingPinRequests.get(requestId)
              if (pending && pending.sendResponse) {
                if (fullData && fullData.matchId) {
                  matchDataStore.set(String(fullData.matchId), fullData)
                }
                pending.sendResponse(success ? 200 : 404, {
                  success,
                  match: match || null,
                  error: success ? undefined : 'No match found with this PIN'
                })
              }
            } else if (message.type === 'match-data-response') {
              const { requestId, matchData } = message
              const pending = pendingPinRequests.get(requestId)
              if (pending && pending.res && !pending.res.headersSent) {
                if (matchData) {
                  pending.res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                  })
                  pending.res.end(JSON.stringify({ success: true, ...matchData }))
                } else {
                  pending.res.writeHead(404, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                  })
                  pending.res.end(JSON.stringify({ success: false, error: 'Match not found' }))
                }
                if (pending.timeout) clearTimeout(pending.timeout)
                pendingPinRequests.delete(requestId)
              }
            } else if (message.type === 'game-number-response') {
              const { requestId, match, matchId } = message
              const pending = pendingPinRequests.get(requestId)
              if (pending && pending.res && !pending.res.headersSent) {
                if (match) {
                  pending.res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                  })
                  pending.res.end(JSON.stringify({ success: true, match, matchId }))
                } else {
                  pending.res.writeHead(404, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                  })
                  pending.res.end(JSON.stringify({ success: false, error: 'Match not found' }))
                }
                if (pending.timeout) clearTimeout(pending.timeout)
                pendingPinRequests.delete(requestId)
              }
            } else if (message.type === 'match-update-response') {
              const { requestId, success, error } = message
              const pending = pendingPinRequests.get(requestId)
              if (pending && pending.res && !pending.res.headersSent) {
                pending.res.writeHead(success ? 200 : 500, { 
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*'
                })
                pending.res.end(JSON.stringify({ success, error }))
                if (pending.timeout) clearTimeout(pending.timeout)
                pendingPinRequests.delete(requestId)
              }
            }
          } catch (err) {
            console.error('[WebSocket] Error parsing message:', err)
          }
        })
        
        ws.on('close', () => {
          console.log(`[WebSocket] Client disconnected`)
          wsClients.delete(ws)
          matchSubscriptions.forEach((subscribers) => {
            subscribers.delete(ws)
          })
        })
        
        ws.on('error', (error) => {
          console.error('[WebSocket] Error:', error)
          wsClients.delete(ws)
        })
      })

      console.log(`🔌 WebSocket Server running on port ${wsPort}`)
      console.log(`📡 API routes enabled for dev server`)

      // Add API middleware - must be added before Vite's default middleware
      server.middlewares.use('/api', (req, res, next) => {
        // Vite's connect middleware strips the prefix when using .use('/api', ...)
        // So /api/match/validate-pin becomes req.url = '/match/validate-pin'
        const urlPath = req.url.split('?')[0]
        
        // Debug logging
        console.log(`[API Plugin] ${req.method} ${urlPath} (req.url: ${req.url}, originalUrl: ${req.originalUrl || 'N/A'})`)
        
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Instance-ID')
        
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
            mainInstanceId,
            hasMainInstance: mainInstanceId !== null,
            protocol,
            wsProtocol,
            hostname: 'escoresheet.local',
            localIP,
            port,
            wsPort,
            urls: {
              main: `${protocol}://escoresheet.local:${port}/`,
              mainIP: `${protocol}://${localIP}:${port}/`,
              referee: `${protocol}://escoresheet.local:${port}/referee.html`,
              refereeIP: `${protocol}://${localIP}:${port}/referee.html`,
              bench: `${protocol}://escoresheet.local:${port}/bench.html`,
              benchIP: `${protocol}://${localIP}:${port}/bench.html`,
              livescore: `${protocol}://escoresheet.local:${port}/livescore.html`,
              livescoreIP: `${protocol}://${localIP}:${port}/livescore.html`,
              websocket: `${wsProtocol}://escoresheet.local:${wsPort}`,
              websocketIP: `${wsProtocol}://${localIP}:${wsPort}`
            }
          }))
          return
        }
        
        // Register main instance
        if (urlPath === '/server/register-main') {
          const instanceId = req.headers['x-instance-id'] || `instance-${Date.now()}`
          if (mainInstanceId === null) {
            mainInstanceId = instanceId
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, instanceId }))
          } else {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'Main instance already registered', existingInstanceId: mainInstanceId }))
          }
          return
        }
        
        // Unregister main instance
        if (urlPath === '/server/unregister-main') {
          const instanceId = req.headers['x-instance-id']
          if (instanceId === mainInstanceId) {
            mainInstanceId = null
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } else {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'Not the registered instance' }))
          }
          return
        }
        
        // Validate PIN
        if (urlPath === '/match/validate-pin' && req.method === 'POST') {
          let body = ''
          let responseSent = false
          
          const sendResponse = (statusCode, data) => {
            if (responseSent) return
            responseSent = true
            res.writeHead(statusCode, { 'Content-Type': 'application/json' })
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
              
              // Check match data store
              let matchFound = null
              for (const [matchId, matchData] of matchDataStore.entries()) {
                const match = matchData.match || matchData
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
                sendResponse(200, { success: true, match: matchFound })
              } else {
                // Request from main instance via WebSocket
                const requestId = `pin-request-${Date.now()}-${Math.random()}`
                
                broadcast({
                  type: 'pin-validation-request',
                  requestId,
                  pin: pinStr,
                  pinType: type,
                  timestamp: Date.now()
                })
                
                let timeoutCleared = false
                const sendResponseWrapper = (statusCode, data) => {
                  if (!responseSent && !timeoutCleared) {
                    responseSent = true
                    timeoutCleared = true
                    if (timeout) clearTimeout(timeout)
                    res.writeHead(statusCode, { 'Content-Type': 'application/json' })
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
                }, 5000)
                
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
        
        // Get match data
        if (urlPath.startsWith('/match/') && 
            urlPath !== '/match/validate-pin' &&
            urlPath !== '/match/by-game-number' && 
            req.method === 'GET') {
          const matchId = urlPath.split('/match/')[1]
          
          if (!matchId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'Match ID required' }))
            return
          }
          
          const matchData = matchDataStore.get(String(matchId))
          
          if (matchData) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, ...matchData }))
          } else {
            // Request from main instance
            const requestId = `match-data-request-${Date.now()}-${Math.random()}`
            
            broadcast({
              type: 'match-data-request',
              requestId,
              matchId: String(matchId)
            })
            
            const timeout = setTimeout(() => {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ 
                success: false, 
                error: 'Match data not found. Make sure the main scoresheet is running and connected.' 
              }))
              pendingPinRequests.delete(requestId)
            }, 5000)
            
            pendingPinRequests.set(requestId, { res, timeout, type: 'match-data' })
          }
          return
        }
        
        // Find match by game number
        if (urlPath === '/match/by-game-number' && req.method === 'GET') {
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
            res.end(JSON.stringify({ 
              success: true, 
              match: matchFound.match,
              matchId: matchFound.matchId
            }))
          } else {
            const requestId = `game-number-request-${Date.now()}-${Math.random()}`
            
            broadcast({
              type: 'game-number-request',
              requestId,
              gameNumber: String(gameNumber)
            })
            
            const timeout = setTimeout(() => {
              res.writeHead(404, { 'Content-Type': 'application/json' })
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
        
        // Update match data
        if (urlPath.startsWith('/match/') &&
            urlPath !== '/match/validate-pin' &&
            urlPath !== '/match/by-game-number' &&
            urlPath !== '/match/list' && 
            req.method === 'PATCH') {
          const matchId = urlPath.split('/match/')[1]
          let body = ''
          
          req.on('data', chunk => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const updates = JSON.parse(body)
              
              const requestId = `match-update-request-${Date.now()}-${Math.random()}`
              
              broadcast({
                type: 'match-update-request',
                requestId,
                matchId: String(matchId),
                updates
              })
              
              const timeout = setTimeout(() => {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ 
                  success: false, 
                  error: 'Update request timeout' 
                }))
                pendingPinRequests.delete(requestId)
              }, 5000)
              
              pendingPinRequests.set(requestId, { res, timeout, type: 'match-update' })
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: err.message }))
            }
          })
          return
        }
        
        // List available matches (for game number dropdown)
        if (urlPath === '/match/list' && req.method === 'GET') {
          const matches = Array.from(matchDataStore.entries()).map(([matchId, matchData]) => {
            const match = matchData.match || matchData
            return {
              id: Number(matchId),
              gameNumber: match.gameNumber || match.game_n || matchId,
              homeTeam: match.homeTeam?.name || match.homeTeamName || 'Home',
              awayTeam: match.awayTeam?.name || match.awayTeamName || 'Away',
              status: match.status,
              refereePin: match.refereePin,
              refereeConnectionEnabled: match.refereeConnectionEnabled !== false
            }
          }).filter(m => m.refereeConnectionEnabled && m.status !== 'final')
          
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ 
            success: true, 
            matches 
          }))
          return
        }
        
        // If no route matched, continue to next middleware
        console.log(`[API Plugin] No route matched for ${req.method} ${urlPath}, calling next()`)
        next()
      })
    },
    
    closeBundle() {
      if (wss) {
        wss.close()
        console.log('WebSocket server closed')
      }
    }
  }
}
