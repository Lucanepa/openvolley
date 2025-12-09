/**
 * Server Data Sync Service
 * Fetches match data from the main scoreboard server instead of using local IndexedDB
 */

// Get server URL - checks for configured backend first, then falls back to current location
function getServerUrl() {
  // Check if we have a configured backend URL (Railway/cloud backend)
  const backendUrl = import.meta.env.VITE_BACKEND_URL

  if (backendUrl) {
    console.log('📡 Using configured backend URL:', backendUrl)
    return backendUrl
  }

  // Fallback to local server (development or Electron)
  const protocol = window.location.protocol === 'https:' ? 'https' : 'http'
  const hostname = window.location.hostname
  const port = window.location.port || (protocol === 'https' ? '443' : '5173')
  const localUrl = `${protocol}://${hostname}:${port}`
  console.log('💻 Using local server URL:', localUrl)
  return localUrl
}

// Get WebSocket URL - checks for configured backend first, then falls back to current location
function getWebSocketUrl() {
  // Check if we have a configured backend URL (Railway/cloud backend)
  const backendUrl = import.meta.env.VITE_BACKEND_URL

  if (backendUrl) {
    const url = new URL(backendUrl)
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${url.host}`
    console.log('📡 Using configured WebSocket URL:', wsUrl)
    return wsUrl
  }

  // Fallback to local WebSocket server (development or Electron)
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const hostname = window.location.hostname
  const wsPort = 8080 // Default WebSocket port
  const localWsUrl = `${protocol}://${hostname}:${wsPort}`
  console.log('💻 Using local WebSocket URL:', localWsUrl)
  return localWsUrl
}

/**
 * Validate PIN and get match data from server
 */
export async function validatePin(pin, type = 'referee') {
  const serverUrl = getServerUrl()
  
  try {
    const response = await fetch(`${serverUrl}/api/match/validate-pin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pin: String(pin).trim(),
        type
      })
    })

    if (!response.ok) {
      let errorMessage = 'Failed to validate PIN'
      try {
        const errorData = await response.json()
        errorMessage = errorData.error || errorMessage
      } catch (e) {
        // If response is not JSON, use status text
        errorMessage = response.statusText || errorMessage
      }
      throw new Error(errorMessage)
    }

    // Check if response has content
    const text = await response.text()
    if (!text || text.trim() === '') {
      throw new Error('Empty response from server. Make sure the main scoresheet is running and connected.')
    }

    try {
      const result = JSON.parse(text)
      return result
    } catch (e) {
      console.error('Invalid JSON response:', text)
      throw new Error('Invalid response from server. Make sure the main scoresheet is running and connected.')
    }
  } catch (error) {
    console.error('Error validating PIN:', error)
    // If it's already an Error with a message, re-throw it
    if (error instanceof Error) {
      throw error
    }
    // Otherwise, wrap it
    throw new Error(error.message || 'Failed to validate PIN. Make sure the main scoresheet is running and connected.')
  }
}

/**
 * Get full match data from server (match, teams, players, sets, events)
 */
export async function getMatchData(matchId) {
  const serverUrl = getServerUrl()
  
  try {
    const response = await fetch(`${serverUrl}/api/match/${matchId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error('Failed to fetch match data')
    }

    const result = await response.json()
    return result
  } catch (error) {
    console.error('Error fetching match data:', error)
    throw error
  }
}

// Global WebSocket connection manager to prevent multiple connections
const wsConnections = new Map() // Map<matchId, { ws, subscribers, reconnectTimeout, reconnectAttempts, isIntentionallyClosed }>

/**
 * Subscribe to match data updates via WebSocket
 */
export function subscribeToMatchData(matchId, onUpdate) {
  const wsUrl = getWebSocketUrl()
  const matchIdStr = String(matchId)
  
  // Get or create connection manager for this match
  let connection = wsConnections.get(matchIdStr)
  if (!connection) {
    connection = {
      ws: null,
      subscribers: new Set(),
      reconnectTimeout: null,
      reconnectAttempts: 0,
      isIntentionallyClosed: false
    }
    wsConnections.set(matchIdStr, connection)
  }
  
  // Add this subscriber
  connection.subscribers.add(onUpdate)
  
  const maxReconnectDelay = 10000 // Max 10 seconds

  const connect = () => {
    // Don't reconnect if intentionally closed or already connected
    if (connection.isIntentionallyClosed) return
    if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
      // Already connected, just send subscription message
      try {
        connection.ws.send(JSON.stringify({
          type: 'subscribe-match',
          matchId: matchIdStr
        }))
      } catch (err) {
        console.error('[ServerDataSync] Error sending subscription:', err)
      }
      return
    }
    if (connection.ws && connection.ws.readyState === WebSocket.CONNECTING) {
      // Already connecting, wait for it
      return
    }

    try {
      // Close existing connection if any (but not if it's already closed)
      if (connection.ws && connection.ws.readyState !== WebSocket.CLOSED) {
        connection.ws.close()
      }

      connection.ws = new WebSocket(wsUrl)

      connection.ws.onopen = () => {
        // Skip if intentionally closed (cleanup ran before connection opened)
        if (connection.isIntentionallyClosed || !connection.ws) return
        
        connection.reconnectAttempts = 0 // Reset on successful connection
        console.log(`[ServerDataSync] WebSocket connected for match ${matchIdStr}`)
        // Request match data subscription
        try {
          connection.ws.send(JSON.stringify({
            type: 'subscribe-match',
            matchId: matchIdStr
          }))
        } catch (err) {
          console.error('[ServerDataSync] Error sending subscription:', err)
        }
      }

      connection.ws.onmessage = (event) => {
        // Skip if intentionally closed
        if (connection.isIntentionallyClosed) return
        
        try {
          const message = JSON.parse(event.data)
          
          if (message.type === 'match-data-update' && String(message.matchId) === matchIdStr) {
            // Match data updated, notify all subscribers
            // Pass through timestamp fields for latency tracking
            const dataWithTimestamps = {
              ...message.data,
              _timestamp: message._timestamp,
              _scoreboardTimestamp: message._scoreboardTimestamp
            }
            connection.subscribers.forEach(subscriber => {
              try {
                subscriber(dataWithTimestamps)
              } catch (err) {
                console.error('[ServerDataSync] Error in subscriber callback:', err)
              }
            })
          } else if (message.type === 'match-full-data' && String(message.matchId) === matchIdStr) {
            // Full match data received, notify all subscribers
            connection.subscribers.forEach(subscriber => {
              try {
                subscriber(message.data)
              } catch (err) {
                console.error('[ServerDataSync] Error in subscriber callback:', err)
              }
            })
          } else if (message.type === 'match-action' && String(message.matchId) === matchIdStr) {
            // Action received from scoreboard (timeout, substitution, set_end, etc.)
            console.log('[ServerDataSync] Received match-action:', message.action, message.data)
            connection.subscribers.forEach(subscriber => {
              try {
                // Pass the action with a special _action wrapper, including timestamps for latency tracking
                subscriber({ 
                  _action: message.action, 
                  _actionData: message.data, 
                  _timestamp: message._timestamp || message.timestamp,
                  _scoreboardTimestamp: message._scoreboardTimestamp || message.timestamp
                })
              } catch (err) {
                console.error('[ServerDataSync] Error in subscriber callback for action:', err)
              }
            })
          }
        } catch (err) {
          console.error('[ServerDataSync] Error parsing message:', err)
        }
      }

      connection.ws.onerror = (error) => {
        // Skip if ws is null (cleanup already happened) or intentionally closed
        if (!connection.ws || connection.isIntentionallyClosed) return
        
        // Only log if it's not a connection error (which is expected during initial connection)
        // Connection errors are usually handled by onclose
        if (connection.ws.readyState === WebSocket.CONNECTING) {
          // This is expected during initial connection attempts, don't log as error
          return
        }
        console.warn('[ServerDataSync] WebSocket error (will attempt reconnect):', error)
      }

      connection.ws.onclose = (event) => {
        // Don't reconnect if intentionally closed or ws is null
        if (connection.isIntentionallyClosed || !connection.ws) return

        // Don't reconnect on normal closure (code 1000)
        if (event.code === 1000) {
          console.log('[ServerDataSync] WebSocket closed normally')
          return
        }

        // Only reconnect if there are still subscribers
        if (connection.subscribers.size === 0) {
          console.log('[ServerDataSync] No subscribers, not reconnecting')
          return
        }

        // Exponential backoff for reconnection
        connection.reconnectAttempts++
        const delay = Math.min(3000 * connection.reconnectAttempts, maxReconnectDelay)
        console.log(`[ServerDataSync] WebSocket disconnected, reconnecting in ${delay/1000} seconds... (attempt ${connection.reconnectAttempts})`)
        connection.reconnectTimeout = setTimeout(connect, delay)
      }
    } catch (err) {
      console.error('[ServerDataSync] Connection error:', err)
      // Exponential backoff for reconnection
      connection.reconnectAttempts++
      const delay = Math.min(3000 * connection.reconnectAttempts, maxReconnectDelay)
      connection.reconnectTimeout = setTimeout(connect, delay)
    }
  }

  // Connect if not already connected
  if (!connection.ws || connection.ws.readyState === WebSocket.CLOSED) {
    connect()
  } else if (connection.ws.readyState === WebSocket.OPEN) {
    // Already connected, send subscription immediately
    try {
      connection.ws.send(JSON.stringify({
        type: 'subscribe-match',
        matchId: matchIdStr
      }))
    } catch (err) {
      console.error('[ServerDataSync] Error sending subscription:', err)
    }
  }

  // Return unsubscribe function
  return () => {
    // Remove this subscriber
    connection.subscribers.delete(onUpdate)
    
    // If no more subscribers, close the connection
    if (connection.subscribers.size === 0) {
      connection.isIntentionallyClosed = true
      if (connection.reconnectTimeout) {
        clearTimeout(connection.reconnectTimeout)
        connection.reconnectTimeout = null
      }
      if (connection.ws) {
        connection.ws.close(1000, 'Unsubscribing') // Normal closure
        connection.ws = null
      }
      // Remove from map
      wsConnections.delete(matchIdStr)
    }
  }
}

/**
 * Get WebSocket connection status for a match
 * Returns: 'connected', 'connecting', 'disconnected', or 'unknown'
 */
export function getWebSocketStatus(matchId) {
  const matchIdStr = String(matchId)
  const connection = wsConnections.get(matchIdStr)
  
  if (!connection || !connection.ws) {
    return 'disconnected'
  }
  
  switch (connection.ws.readyState) {
    case WebSocket.CONNECTING:
      return 'connecting'
    case WebSocket.OPEN:
      return 'connected'
    case WebSocket.CLOSING:
    case WebSocket.CLOSED:
      return 'disconnected'
    default:
      return 'unknown'
  }
}

/**
 * Find match by game number from server
 */
export async function findMatchByGameNumber(gameNumber) {
  const serverUrl = getServerUrl()
  
  try {
    const response = await fetch(`${serverUrl}/api/match/by-game-number?gameNumber=${encodeURIComponent(gameNumber)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      return null
    }

    const result = await response.json()
    return result.match || null
  } catch (error) {
    console.error('Error finding match by game number:', error)
    return null
  }
}

/**
 * Update match data on server (for upload roster, etc.)
 */
export async function updateMatchData(matchId, updates) {
  const serverUrl = getServerUrl()
  
  try {
    const response = await fetch(`${serverUrl}/api/match/${matchId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    })

    if (!response.ok) {
      throw new Error('Failed to update match data')
    }

    const result = await response.json()
    return result
  } catch (error) {
    console.error('Error updating match data:', error)
    throw error
  }
}

/**
 * List available matches from server (for game number dropdown)
 */
export async function listAvailableMatches() {
  const serverUrl = getServerUrl()
  
  try {
    const response = await fetch(`${serverUrl}/api/match/list`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      return { success: false, matches: [] }
    }

    const result = await response.json()
    return result
  } catch (error) {
    console.error('Error listing matches:', error)
    return { success: false, matches: [] }
  }
}
