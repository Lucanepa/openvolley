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

  // Validate PIN for referee/bench access
  if (url.pathname === '/api/match/validate-pin' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += chunk.toString() })
    req.on('end', () => {
      try {
        if (!body || body.trim() === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Empty request body' }))
          return
        }

        const { pin, type = 'referee' } = JSON.parse(body)

        if (!pin || String(pin).length !== 6) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Invalid PIN format' }))
          return
        }

        const pinStr = String(pin).trim()

        // Search active matches for matching PIN
        let matchFound = null
        for (const [matchId, matchData] of activeMatches.entries()) {
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
              matchFound = { ...match, id: matchId }
              break
            }
          }
        }

        if (matchFound) {
          console.log(`[API] PIN validated for ${type}: match ${matchFound.id}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, match: matchFound }))
        } else {
          console.log(`[API] PIN validation failed for ${type}: ${pinStr}`)
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: false,
            error: 'No match found with this PIN. Make sure the main scoresheet is running and connected.'
          }))
        }
      } catch (err) {
        console.error('[API] Error validating PIN:', err)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: err.message || 'Invalid request body' }))
      }
    })
    return
  }

  // List active matches (ephemeral - just for current session)
  // Only return matches where refereeConnectionEnabled is true
  if (url.pathname === '/api/match/list') {
    const allMatches = Array.from(activeMatches.values())
    const filteredMatches = allMatches.filter(m => {
      // Check if refereeConnectionEnabled is explicitly true
      return m.match?.refereeConnectionEnabled === true
    })
    console.log(`[API] /api/match/list - Total: ${allMatches.length}, Referee enabled: ${filteredMatches.length}`)
    allMatches.forEach(m => {
      console.log(`  - Game #${m.gameNumber || m.matchId}: refereeConnectionEnabled=${m.match?.refereeConnectionEnabled}`)
    })

    // Format response to match dev server (flat structure)
    const formattedMatches = filteredMatches.map(m => {
      // Format scheduled date/time
      let dateTime = 'TBD'
      if (m.match?.scheduledAt) {
        try {
          const scheduledDate = new Date(m.match.scheduledAt)
          const dateStr = scheduledDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          const timeStr = scheduledDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
          dateTime = `${dateStr} ${timeStr}`
        } catch (e) {
          dateTime = 'TBD'
        }
      }

      // Get team names - handle both object format {name: 'Team'} and string format 'Team'
      const homeTeamName = typeof m.homeTeam === 'object' ? m.homeTeam?.name : m.homeTeam
      const awayTeamName = typeof m.awayTeam === 'object' ? m.awayTeam?.name : m.awayTeam

      return {
        id: m.matchId,
        gameNumber: m.gameNumber || m.match?.gameNumber || m.match?.game_n || m.matchId,
        homeTeam: homeTeamName || 'Home',
        awayTeam: awayTeamName || 'Away',
        scheduledAt: m.match?.scheduledAt,
        dateTime,
        status: m.match?.status || 'scheduled',
        refereePin: m.match?.refereePin,
        refereeConnectionEnabled: m.match?.refereeConnectionEnabled === true
      }
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      success: true,
      matches: formattedMatches
    }))
    return
  }

  // Get match data by ID
  if (url.pathname.startsWith('/api/match/') &&
      url.pathname !== '/api/match/list' &&
      url.pathname !== '/api/match/validate-pin' &&
      url.pathname !== '/api/match/by-game-number' &&
      req.method === 'GET') {
    const matchId = url.pathname.replace('/api/match/', '')

    if (!matchId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: 'Match ID required' }))
      return
    }

    // Try to find match in activeMatches
    let matchData = activeMatches.get(matchId)

    // Also try with/without leading zeros or string conversion
    if (!matchData) {
      matchData = activeMatches.get(String(matchId))
    }
    if (!matchData) {
      matchData = activeMatches.get(Number(matchId))
    }

    if (matchData) {
      console.log(`[API] /api/match/${matchId} - Found match`)
      // Ensure team objects have the correct format
      const homeTeam = typeof matchData.homeTeam === 'object' ? matchData.homeTeam : { name: matchData.homeTeam || 'Home' }
      const awayTeam = typeof matchData.awayTeam === 'object' ? matchData.awayTeam : { name: matchData.awayTeam || 'Away' }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: true,
        match: matchData.match,
        homeTeam,
        awayTeam,
        homePlayers: matchData.homePlayers || [],
        awayPlayers: matchData.awayPlayers || [],
        sets: matchData.sets || [],
        events: matchData.events || []
      }))
    } else {
      console.log(`[API] /api/match/${matchId} - Match not found. Active matches: ${Array.from(activeMatches.keys()).join(', ')}`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: false,
        error: 'Match not found. Make sure the main scoresheet is running and connected.'
      }))
    }
    return
  }

  // Get detailed connection info for dashboard server UI
  if (url.pathname === '/api/server/connections') {
    const matchId = url.searchParams.get('matchId')

    // Build client list (exclude WebSocket object and filter by matchId if provided)
    const clients = []
    connections.forEach((client) => {
      // Skip if matchId filter is set and client is not in that match
      if (matchId && String(client.matchId) !== String(matchId)) {
        return
      }
      // Only include dashboard clients (referee, bench) - not scoreboard
      if (client.role && client.role !== 'scoreboard') {
        clients.push({
          id: client.id,
          ip: client.ip,
          role: client.role,
          team: client.team,
          matchId: client.matchId,
          connectedAt: client.connectedAt
        })
      }
    })

    // Count by role
    const refereesCount = clients.filter(c => c.role === 'referee').length
    const benchCount = clients.filter(c => c.role === 'bench').length

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      totalClients: connections.size,
      dashboardClients: clients.length,
      referees: refereesCount,
      benches: benchCount,
      clients,
      matchSubscriptions: Object.fromEntries(
        Array.from(rooms.entries()).map(([matchId, room]) => [matchId, room.clients.size])
      )
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
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  const clientInfo = {
    ws,
    id: clientId,
    ip: ip ? ip.replace('::ffff:', '') : 'unknown', // Clean up IPv6 prefix
    matchId: null,
    role: null, // 'scoreboard', 'referee', 'bench'
    team: null, // 'home' or 'away' for bench clients
    connectedAt: new Date().toISOString()
  }

  connections.set(clientId, clientInfo)

  console.log(`✅ Client connected: ${clientId} from ${clientInfo.ip} (Total: ${connections.size})`)

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

        case 'subscribe-match':
          // Frontend format for joining a match room (used by referee/bench/livescore)
          // Adapt to join_match format
          handleJoinMatch(clientInfo, {
            ...message,
            matchId: message.matchId,
            role: message.role || 'subscriber'
          })
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
  const { matchId, role, pin, team } = message

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
  clientInfo.team = team || null // 'home' or 'away' for bench clients

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
  // Support both formats:
  // Frontend format: { matchId, match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events }
  // Legacy format: { matchId, match, teams, players, sets, events }
  const { matchId, match, teams, players, sets, events } = message
  const homeTeam = message.homeTeam || teams?.[0]
  const awayTeam = message.awayTeam || teams?.[1]
  const homePlayers = message.homePlayers || players?.filter(p => p.teamId === match?.homeTeamId) || []
  const awayPlayers = message.awayPlayers || players?.filter(p => p.teamId === match?.awayTeamId) || []

  if (!matchId) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID required'
    }))
    return
  }

  // Store/update match in activeMatches with all the data
  activeMatches.set(String(matchId), {
    matchId: String(matchId),
    match,
    homeTeam,
    awayTeam,
    homePlayers,
    awayPlayers,
    sets,
    events,
    gameNumber: match?.gameN || match?.gameNumber || match?.game_n,
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
