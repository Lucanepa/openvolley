/**
 * Optional Backend Server for eScoresheet
 * Provides WebSocket relay for local network connections
 * This is OPTIONAL - the app works fully offline without this server
 *
 * Use cases:
 * 1. Local network: Scoreboard ↔ Referee/Bench sync (no internet needed)
 * 2. Cloud relay: Multiple locations (requires internet)
 *
 * Deploy to Railway.app (free tier) for cloud relay
 * Or run locally for local network only
 */

import { createServer } from 'http'
import { WebSocketServer } from 'ws'

const PORT = process.env.PORT || 8080
const IS_CLOUD = process.env.RAILWAY_ENVIRONMENT || process.env.RENDER

// In-memory storage for active matches
// NOTE: This resets on server restart - Supabase is the source of truth for persistence
const activeMatches = new Map()
const connections = new Map()
const rooms = new Map() // Match rooms for isolated communication

// Create HTTP server
const server = createServer((req, res) => {
  // Enable CORS for all origins
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host}`)

  // Health check
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'healthy',
      mode: IS_CLOUD ? 'cloud' : 'local',
      uptime: process.uptime(),
      connections: connections.size,
      activeRooms: rooms.size
    }))
    return
  }

  // Server status
  if (url.pathname === '/api/server/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'online',
      mode: IS_CLOUD ? 'cloud' : 'local',
      wsPort: PORT,
      connections: connections.size,
      matches: activeMatches.size,
      rooms: rooms.size,
      uptime: process.uptime()
    }))
    return
  }

  // List active matches (ephemeral - just for current session)
  if (url.pathname === '/api/match/list') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      success: true,
      matches: Array.from(activeMatches.values())
    }))
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

// Create WebSocket server
const wss = new WebSocketServer({
  server,
  // Increase limits for match data
  maxPayload: 100 * 1024 * 1024, // 100MB
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024
  }
})

wss.on('connection', (ws, req) => {
  const clientId = Math.random().toString(36).substring(7)
  const clientInfo = {
    ws,
    id: clientId,
    matchId: null,
    role: null, // 'scoreboard', 'referee', 'bench'
    connectedAt: new Date().toISOString()
  }

  connections.set(clientId, clientInfo)

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log(`✅ Client connected: ${clientId} from ${ip} (Total: ${connections.size})`)

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    mode: IS_CLOUD ? 'cloud' : 'local',
    timestamp: new Date().toISOString()
  }))

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString())

      // Handle different message types
      switch (message.type) {
        case 'join_match':
          // Client joins a match room
          handleJoinMatch(clientInfo, message)
          break

        case 'leave_match':
          // Client leaves match room
          handleLeaveMatch(clientInfo)
          break

        case 'match_update':
          // Scoreboard sends match state update
          handleMatchUpdate(clientInfo, message)
          break

        case 'sync-match-data':
          // Scoreboard sends match data sync (frontend uses this format)
          handleSyncMatchData(clientInfo, message)
          break

        case 'match-action':
          // Scoreboard sends action (timeout, substitution, etc.) - frontend format
          handleMatchAction(clientInfo, message)
          break

        case 'action':
          // Scoreboard sends action (timeout, substitution, etc.) - legacy format
          handleAction(clientInfo, message)
          break

        case 'clear-all-matches':
          // Clear all matches (or all except one)
          handleClearMatches(message)
          break

        case 'delete-match':
          // Delete a specific match
          handleDeleteMatch(message)
          break

        case 'ping':
          // Heartbeat
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
          break

        default:
          console.log(`❓ Unknown message type: ${message.type}`)
      }
    } catch (err) {
      console.error('❌ Error parsing message:', err)
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }))
    }
  })

  ws.on('close', () => {
    handleClientDisconnect(clientInfo)
  })

  ws.on('error', (err) => {
    console.error(`❌ WebSocket error for ${clientId}:`, err.message)
  })
})

// Handle client joining a match room
function handleJoinMatch(clientInfo, message) {
  const { matchId, role, pin } = message

  if (!matchId) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID required'
    }))
    return
  }

  // Leave previous room if any
  if (clientInfo.matchId) {
    handleLeaveMatch(clientInfo)
  }

  // Update client info
  clientInfo.matchId = matchId
  clientInfo.role = role || 'unknown'

  // Create room if doesn't exist
  if (!rooms.has(matchId)) {
    rooms.set(matchId, {
      matchId,
      clients: new Set(),
      createdAt: new Date().toISOString()
    })
  }

  // Add client to room
  const room = rooms.get(matchId)
  room.clients.add(clientInfo.id)

  console.log(`🎯 ${clientInfo.id} (${role}) joined match ${matchId} (Room size: ${room.clients.size})`)

  // Notify client
  clientInfo.ws.send(JSON.stringify({
    type: 'joined_match',
    matchId,
    role,
    roomSize: room.clients.size
  }))

  // Notify other clients in room
  broadcastToRoom(matchId, {
    type: 'client_joined',
    clientId: clientInfo.id,
    role,
    roomSize: room.clients.size
  }, clientInfo.id) // Exclude sender
}

// Handle client leaving match room
function handleLeaveMatch(clientInfo) {
  if (!clientInfo.matchId) return

  const room = rooms.get(clientInfo.matchId)
  if (room) {
    room.clients.delete(clientInfo.id)

    console.log(`👋 ${clientInfo.id} left match ${clientInfo.matchId} (Room size: ${room.clients.size})`)

    // Notify other clients
    broadcastToRoom(clientInfo.matchId, {
      type: 'client_left',
      clientId: clientInfo.id,
      role: clientInfo.role,
      roomSize: room.clients.size
    }, clientInfo.id)

    // Clean up empty room
    if (room.clients.size === 0) {
      rooms.delete(clientInfo.matchId)
      activeMatches.delete(clientInfo.matchId)
      console.log(`🗑️  Empty room deleted: ${clientInfo.matchId}`)
    }
  }

  clientInfo.matchId = null
  clientInfo.role = null
}

// Handle match update from scoreboard
function handleMatchUpdate(clientInfo, message) {
  const { matchId, data } = message

  if (!matchId || !data) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID and data required'
    }))
    return
  }

  // Store match data (ephemeral)
  activeMatches.set(matchId, {
    matchId,
    data,
    updatedAt: new Date().toISOString(),
    updatedBy: clientInfo.id
  })

  // Broadcast to all clients in the same room
  broadcastToRoom(matchId, {
    type: 'match_update',
    matchId,
    data,
    timestamp: new Date().toISOString()
  }, clientInfo.id) // Exclude sender to avoid echo

  console.log(`📤 Match update broadcasted to room ${matchId}`)
}

// Handle action (timeout, substitution, etc.)
function handleAction(clientInfo, message) {
  const { matchId, action } = message

  if (!matchId || !action) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID and action required'
    }))
    return
  }

  // Broadcast action to all clients in the room
  broadcastToRoom(matchId, {
    type: 'action',
    matchId,
    action,
    timestamp: new Date().toISOString(),
    from: clientInfo.id
  }, clientInfo.id) // Exclude sender

  console.log(`⚡ Action broadcasted to room ${matchId}: ${action.type}`)
}

// Handle client disconnect
function handleClientDisconnect(clientInfo) {
  handleLeaveMatch(clientInfo)
  connections.delete(clientInfo.id)
  console.log(`❌ Client disconnected: ${clientInfo.id} (Total: ${connections.size})`)
}

// Handle sync-match-data from frontend scoreboard
function handleSyncMatchData(clientInfo, message) {
  const { matchId, match, teams, players, sets, events } = message

  if (!matchId) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID required'
    }))
    return
  }

  // Store/update match in activeMatches with all the data
  activeMatches.set(matchId, {
    matchId,
    match,
    teams,
    players,
    sets,
    events,
    gameNumber: match?.gameN || match?.gameNumber,
    homeTeam: teams?.[0]?.name || 'Home',
    awayTeam: teams?.[1]?.name || 'Away',
    updatedAt: new Date().toISOString(),
    updatedBy: clientInfo.id
  })

  // Ensure room exists
  if (!rooms.has(matchId)) {
    rooms.set(matchId, {
      matchId,
      clients: new Set(),
      createdAt: new Date().toISOString()
    })
  }

  // Add client to room if not already there
  const room = rooms.get(matchId)
  if (!room.clients.has(clientInfo.id)) {
    room.clients.add(clientInfo.id)
    clientInfo.matchId = matchId
    clientInfo.role = 'scoreboard'
  }

  // Broadcast to other clients in the room
  broadcastToRoom(matchId, {
    type: 'match-data-update',
    matchId,
    match,
    teams,
    players,
    sets,
    events,
    timestamp: new Date().toISOString()
  }, clientInfo.id)

  console.log(`📤 Match data synced for ${matchId} (Game #${match?.gameN || 'unknown'})`)
}

// Handle match-action from frontend
function handleMatchAction(clientInfo, message) {
  const { matchId, action, actionData } = message

  if (!matchId || !action) {
    return
  }

  // Broadcast action to all clients in the room
  broadcastToRoom(matchId, {
    type: 'match-action',
    matchId,
    action,
    data: actionData,
    timestamp: new Date().toISOString(),
    from: clientInfo.id
  }, clientInfo.id)

  console.log(`⚡ Match action broadcasted to room ${matchId}: ${action}`)
}

// Handle clear-all-matches
function handleClearMatches(message) {
  const keepMatchId = message.keepMatchId

  if (keepMatchId) {
    // Clear all matches except the specified one
    const keysToDelete = []
    activeMatches.forEach((_, matchId) => {
      if (String(matchId) !== String(keepMatchId)) {
        keysToDelete.push(matchId)
      }
    })
    keysToDelete.forEach(matchId => {
      activeMatches.delete(matchId)
      rooms.delete(matchId)
    })
    console.log(`🗑️  Cleared ${keysToDelete.length} matches (kept ${keepMatchId})`)
  } else {
    // Clear all matches
    const count = activeMatches.size
    activeMatches.clear()
    rooms.clear()
    console.log(`🗑️  Cleared all ${count} matches`)
  }
}

// Handle delete-match
function handleDeleteMatch(message) {
  const { matchId } = message

  if (!matchId) return

  activeMatches.delete(matchId)
  rooms.delete(matchId)
  console.log(`🗑️  Deleted match ${matchId}`)
}

// Broadcast message to all clients in a specific room
function broadcastToRoom(matchId, message, excludeClientId = null) {
  const room = rooms.get(matchId)
  if (!room) return

  const data = JSON.stringify(message)
  let sent = 0

  room.clients.forEach((clientId) => {
    if (clientId === excludeClientId) return

    const clientInfo = connections.get(clientId)
    if (clientInfo && clientInfo.ws.readyState === 1) { // WebSocket.OPEN
      clientInfo.ws.send(data)
      sent++
    }
  })

  console.log(`📡 Broadcasted to ${sent} clients in room ${matchId}`)
}

// Periodic cleanup of stale connections
setInterval(() => {
  connections.forEach((clientInfo, clientId) => {
    if (clientInfo.ws.readyState === 3) { // WebSocket.CLOSED
      handleClientDisconnect(clientInfo)
    }
  })
}, 30000) // Every 30 seconds

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🏐 eScoresheet WebSocket Server                          ║
║                                                            ║
║  Mode:     ${IS_CLOUD ? 'CLOUD RELAY' : 'LOCAL NETWORK'}                             ║
║  Port:     ${PORT}                                          ║
║  Status:   READY                                           ║
║                                                            ║
║  Endpoints:                                                ║
║  • Health:  http://localhost:${PORT}/health                 ║
║  • Status:  http://localhost:${PORT}/api/server/status      ║
║  • WS:      ws://localhost:${PORT}                          ║
╚════════════════════════════════════════════════════════════╝
  `)
})
