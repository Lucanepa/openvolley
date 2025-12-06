/**
 * Server Data Sync Service
 * Fetches match data from the main scoreboard server instead of using local IndexedDB
 */

// Get server URL from current location
function getServerUrl() {
  const protocol = window.location.protocol === 'https:' ? 'https' : 'http'
  const hostname = window.location.hostname
  const port = window.location.port || (protocol === 'https' ? '443' : '5173')
  return `${protocol}://${hostname}:${port}`
}

// Get WebSocket URL
function getWebSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const hostname = window.location.hostname
  const wsPort = 8080 // Default WebSocket port
  return `${protocol}://${hostname}:${wsPort}`
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

/**
 * Subscribe to match data updates via WebSocket
 */
export function subscribeToMatchData(matchId, onUpdate) {
  const wsUrl = getWebSocketUrl()
  let ws = null
  let reconnectTimeout = null

  const connect = () => {
    try {
      ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        console.log('[ServerDataSync] WebSocket connected')
        // Request match data subscription
        ws.send(JSON.stringify({
          type: 'subscribe-match',
          matchId: String(matchId)
        }))
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          
          if (message.type === 'match-data-update' && String(message.matchId) === String(matchId)) {
            // Match data updated, call callback
            onUpdate(message.data)
          } else if (message.type === 'match-full-data' && String(message.matchId) === String(matchId)) {
            // Full match data received
            onUpdate(message.data)
          }
        } catch (err) {
          console.error('[ServerDataSync] Error parsing message:', err)
        }
      }

      ws.onerror = (error) => {
        console.error('[ServerDataSync] WebSocket error:', error)
      }

      ws.onclose = () => {
        console.log('[ServerDataSync] WebSocket disconnected, reconnecting in 3 seconds...')
        reconnectTimeout = setTimeout(connect, 3000)
      }
    } catch (err) {
      console.error('[ServerDataSync] Connection error:', err)
      reconnectTimeout = setTimeout(connect, 3000)
    }
  }

  connect()

  // Return unsubscribe function
  return () => {
    if (reconnectTimeout) clearTimeout(reconnectTimeout)
    if (ws) ws.close()
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
