/**
 * Vite Plugin for API Routes
 * Adds the same API routes from server.js to the Vite dev server
 */

import { WebSocketServer } from 'ws'
import { networkInterfaces } from 'os'
import { createServer as createHttpsServer } from 'https'
import { createServer as createHttpServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

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
            perMessageDeflate: false
          })
          httpServer.listen(wsPort, hostname, () => {
            console.log(`🔒 Secure WebSocket Server (WSS) running on port ${wsPort}`)
          })
        } else {
          console.warn('⚠️  SSL certificates not found, falling back to non-secure WebSocket')
          wss = new WebSocketServer({ 
            port: wsPort,
            perMessageDeflate: false
          })
        }
      } else {
        // Create non-secure WebSocket server
      wss = new WebSocketServer({ 
        port: wsPort,
        perMessageDeflate: false
      })
      }

      wss.on('connection', (ws, req) => {
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
              // SCOREBOARD IS SOURCE OF TRUTH - This ALWAYS overwrites existing data
              // Handle both formats: { matchId, match, ... } and { matchId, matchData: { match, ... } }
              const receiveTimestamp = Date.now()
              const scoreboardTimestamp = message._timestamp || receiveTimestamp
              const serverLatency = receiveTimestamp - scoreboardTimestamp
              
              let matchId = message.matchId
              let match = message.match
              let homeTeam = message.homeTeam
              let awayTeam = message.awayTeam
              let homePlayers = message.homePlayers
              let awayPlayers = message.awayPlayers
              let sets = message.sets
              let events = message.events

              console.log(`[Server] 📥 Received sync-match-data at ${new Date(receiveTimestamp).toISOString()} (${receiveTimestamp}) for match ${matchId}:`, {
                hasMatch: !!match,
                hasHomeTeam: !!homeTeam,
                hasAwayTeam: !!awayTeam,
                setsCount: sets?.length,
                eventsCount: events?.length,
                serverLatency: `${serverLatency}ms`
              })
              
              // If data is nested in matchData, extract it
              if (message.matchData) {
                match = message.matchData.match || match
                homeTeam = message.matchData.homeTeam || homeTeam
                awayTeam = message.matchData.awayTeam || awayTeam
                homePlayers = message.matchData.homePlayers || homePlayers
                awayPlayers = message.matchData.awayPlayers || awayPlayers
                sets = message.matchData.sets || sets
                events = message.matchData.events || events
              }
              
              if (matchId && match) {
                // ALWAYS overwrite - scoreboard data is authoritative
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
                if (subscribers && subscribers.size > 0) {
                  const broadcastTimestamp = Date.now()
                  const broadcastLatency = broadcastTimestamp - receiveTimestamp
                  console.log(`[Server] 📡 Broadcasting match-data-update at ${new Date(broadcastTimestamp).toISOString()} (${broadcastTimestamp}) to ${subscribers.size} subscribers for match ${matchId} (broadcast latency: ${broadcastLatency}ms, total from scoreboard: ${broadcastTimestamp - scoreboardTimestamp}ms)`)
                  subscribers.forEach((subscriber) => {
                    if (subscriber.readyState === 1) {
                      subscriber.send(JSON.stringify({
                        type: 'match-data-update',
                        matchId: String(matchId),
                        data: { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events },
                        _timestamp: broadcastTimestamp, // When server broadcasted
                        _scoreboardTimestamp: scoreboardTimestamp // Original scoreboard send time
                      }))
                    }
                  })
                } else {
                  console.log(`[Server] No subscribers for match ${matchId} - data stored but not broadcasted`)
                }
              }
            } else if (message.type === 'delete-match') {
              // Main scoresheet is deleting a match - remove from server store
              const matchId = String(message.matchId)
              if (matchDataStore.has(matchId)) {
                matchDataStore.delete(matchId)
                
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
            } else if (message.type === 'clear-all-matches') {
              // Scoreboard is clearing all matches (source of truth - no active match)
              // Optionally keep one match if keepMatchId is specified
              const keepMatchId = message.keepMatchId ? String(message.keepMatchId) : null
              
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
            } else if (message.type === 'subscribe-match') {
              const { matchId } = message
              if (!matchSubscriptions.has(String(matchId))) {
                matchSubscriptions.set(String(matchId), new Set())
              }
              matchSubscriptions.get(String(matchId)).add(ws)
              console.log(`[WebSocket] Client subscribed to match ${matchId}. Total subscribers: ${matchSubscriptions.get(String(matchId)).size}`)
              
              // Send current data if available
              const matchData = matchDataStore.get(String(matchId))
              if (matchData) {
                console.log(`[WebSocket] Sending stored match-full-data to new subscriber for match ${matchId}`)
                ws.send(JSON.stringify({
                  type: 'match-full-data',
                  matchId: String(matchId),
                  data: matchData
                }))
              } else {
                console.log(`[WebSocket] No stored data for match ${matchId} - new subscriber will wait for scoreboard sync`)
              }
            } else if (message.type === 'match-action') {
              // Forward action from scoreboard to all subscribers (referee, bench, etc.)
              const receiveTimestamp = Date.now()
              const scoreboardTimestamp = message._timestamp || message.timestamp || receiveTimestamp
              const serverLatency = receiveTimestamp - scoreboardTimestamp
              const { matchId, action, data, timestamp } = message
              const subscribers = matchSubscriptions.get(String(matchId))
              if (subscribers && subscribers.size > 0) {
                const broadcastTimestamp = Date.now()
                const broadcastLatency = broadcastTimestamp - receiveTimestamp
                console.log(`[Server] 📡 Broadcasting match-action '${action}' at ${new Date(broadcastTimestamp).toISOString()} (${broadcastTimestamp}) to ${subscribers.size} subscribers for match ${matchId} (server latency: ${serverLatency}ms, broadcast latency: ${broadcastLatency}ms, total: ${broadcastTimestamp - scoreboardTimestamp}ms)`)
                subscribers.forEach((subscriber) => {
                  if (subscriber.readyState === 1) {
                    subscriber.send(JSON.stringify({
                      type: 'match-action',
                      matchId: String(matchId),
                      action,
                      data,
                      timestamp,
                      _timestamp: broadcastTimestamp,
                      _scoreboardTimestamp: scoreboardTimestamp
                    }))
                  }
                })
              } else {
                console.log(`[Server] No subscribers for match ${matchId} - action '${action}' not broadcasted`)
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
              const { requestId, success, error, data, matchId } = message
              const pending = pendingPinRequests.get(requestId)
              if (pending && pending.res && !pending.res.headersSent) {
                pending.res.writeHead(success ? 200 : 500, { 
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*'
                })
                pending.res.end(JSON.stringify({ success, error }))
                if (pending.timeout) clearTimeout(pending.timeout)
                pendingPinRequests.delete(requestId)
                
                // Update the matchDataStore with the new data so polling returns correct data
                if (success && data && matchId) {
                  matchDataStore.set(String(matchId), data)
                  console.log(`[WebSocket] Updated matchDataStore for match ${matchId}`)
                  
                  // Broadcast the updated data to all subscribers immediately
                  const subscribers = matchSubscriptions.get(String(matchId))
                  if (subscribers && subscribers.size > 0) {
                    const updateMessage = JSON.stringify({
                      type: 'match-data-update',
                      matchId: String(matchId),
                      data: data
                    })
                    subscribers.forEach(client => {
                      if (client.readyState === 1) { // WebSocket.OPEN
                        try {
                          client.send(updateMessage)
                        } catch (err) {
                          console.error('[WebSocket] Error broadcasting update:', err)
                        }
                      }
                    })
                    console.log(`[WebSocket] Broadcasted update to ${subscribers.size} subscribers for match ${matchId}`)
                  }
                }
              }
            }
          } catch (err) {
            console.error('[WebSocket] Error parsing message:', err)
          }
        })
        
        ws.on('close', () => {
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

        // Get connection count
        if (urlPath === '/server/connections') {
          const subscriptionCounts = {}
          for (const [matchId, subscribers] of matchSubscriptions.entries()) {
            subscriptionCounts[matchId] = subscribers.size
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            totalClients: wsClients.size,
            matchSubscriptions: subscriptionCounts
          }))
          return
        }

        // List available matches (for game number dropdown) - check this BEFORE other /match/ routes
        if (urlPath === '/match/list' && req.method === 'GET') {
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
              refereeConnectionEnabled: match.refereeConnectionEnabled === true
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
          
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ 
            success: true, 
            matches: activeMatch 
          }))
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
                    connectionEnabled = match.refereeConnectionEnabled === true
                  } else if (type === 'homeTeam') {
                    connectionEnabled = match.homeTeamConnectionEnabled === true
                  } else if (type === 'awayTeam') {
                    connectionEnabled = match.awayTeamConnectionEnabled === true
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
