import { useState, useEffect } from 'react'
import { validatePin, listAvailableMatches } from './utils/serverDataSync'
import Referee from './components/Referee'
import Modal from './components/Modal'
import ConnectionStatus from './components/ConnectionStatus'
import refereeIcon from './ref.png'
import { db } from './db/db'
export default function RefereeApp() {
  const [pinInput, setPinInput] = useState('')
  const [matchId, setMatchId] = useState(null)
  const [error, setError] = useState('')
  const [match, setMatch] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [availableMatches, setAvailableMatches] = useState([])
  const [selectedGameNumber, setSelectedGameNumber] = useState('')
  const [loadingMatches, setLoadingMatches] = useState(false)
  const [showGameModal, setShowGameModal] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [serverConnected, setServerConnected] = useState(false)
  const [showConnectionMenu, setShowConnectionMenu] = useState(false)
  const [connectionStatuses, setConnectionStatuses] = useState({
    api: 'unknown',
    server: 'unknown',
    websocket: 'unknown',
    scoreboard: 'unknown',
    match: 'unknown',
    db: 'unknown'
  })
  const [connectionDebugInfo, setConnectionDebugInfo] = useState({})
  const [showDebugMenu, setShowDebugMenu] = useState(null) // Which connection type to show debug for

  // Check connection statuses
  const checkConnectionStatuses = async () => {
    const statuses = {
      api: 'unknown',
      server: 'unknown',
      websocket: 'unknown',
      scoreboard: 'unknown',
      match: 'unknown',
      db: 'unknown'
    }
    const debugInfo = {}
    
    // Check API/Server connection
    try {
      const result = await listAvailableMatches()
      if (result.success) {
        statuses.api = 'connected'
        statuses.server = 'connected'
        setServerConnected(true)
        debugInfo.api = { status: 'connected', message: 'API endpoint responding' }
        debugInfo.server = { status: 'connected', message: 'Server is reachable' }
      } else {
        statuses.api = 'disconnected'
        statuses.server = 'disconnected'
        setServerConnected(false)
        debugInfo.api = { status: 'disconnected', message: `API request failed: ${result.error || 'Unknown error'}` }
        debugInfo.server = { status: 'disconnected', message: `Server request failed: ${result.error || 'Unknown error'}` }
      }
    } catch (err) {
      statuses.api = 'disconnected'
      statuses.server = 'disconnected'
      setServerConnected(false)
      debugInfo.api = { status: 'disconnected', message: `Network error: ${err.message || 'Failed to connect to API'}` }
      debugInfo.server = { status: 'disconnected', message: `Network error: ${err.message || 'Failed to connect to server'}` }
    }
    
    // Check WebSocket server availability
    // Test if WebSocket server is reachable (even if not actively connected)
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const hostname = window.location.hostname
      const wsPort = 8080 // Default WebSocket port
      const wsUrl = `${protocol}://${hostname}:${wsPort}`
      
      // Try to connect to WebSocket server with a short timeout
      const wsTest = new WebSocket(wsUrl)
      let resolved = false
      
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            try {
              if (wsTest.readyState === WebSocket.CONNECTING || wsTest.readyState === WebSocket.OPEN) {
                wsTest.close()
              }
            } catch (e) {
              // Ignore errors when closing
            }
            statuses.websocket = 'disconnected'
            debugInfo.websocket = { 
              status: 'disconnected', 
              message: `Connection timeout after 2 seconds. Server may not be running on port ${wsPort}.`,
              details: `Attempted to connect to ${wsUrl}`
            }
            resolve()
          }
        }, 2000) // 2 second timeout
        
        wsTest.onopen = () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            try {
              wsTest.close()
            } catch (e) {
              // Ignore errors when closing
            }
            statuses.websocket = 'connected'
            debugInfo.websocket = { status: 'connected', message: 'WebSocket server is reachable' }
            resolve()
          }
        }
        
        wsTest.onerror = () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            try {
              if (wsTest.readyState === WebSocket.CONNECTING || wsTest.readyState === WebSocket.OPEN) {
                wsTest.close()
              }
            } catch (e) {
              // Ignore errors when closing
            }
            statuses.websocket = 'disconnected'
            debugInfo.websocket = { 
              status: 'disconnected', 
              message: `WebSocket connection error. Server may not be running or port ${wsPort} is blocked.`,
              details: `Failed to connect to ${wsUrl}`
            }
            resolve() // Don't reject, just mark as disconnected
          }
        }
        
        wsTest.onclose = (event) => {
          // If we haven't resolved yet and connection closed, mark as disconnected
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            statuses.websocket = 'disconnected'
            if (!debugInfo.websocket) {
              debugInfo.websocket = { 
                status: 'disconnected', 
                message: `Connection closed unexpectedly (code: ${event.code}).`,
                details: `WebSocket server on port ${wsPort} may not be running`
              }
            }
            resolve()
          }
        }
      })
    } catch (err) {
      // If connection fails, mark as disconnected
      statuses.websocket = 'disconnected'
      debugInfo.websocket = { 
        status: 'disconnected', 
        message: `Error creating WebSocket connection: ${err.message || 'Unknown error'}`,
        details: 'Check if WebSocket server is running'
      }
    }
    
    // Check Scoreboard connection (same as server for now)
    statuses.scoreboard = statuses.server
    debugInfo.scoreboard = debugInfo.server
    
    // Check Match status
    if (matchId && match) {
      statuses.match = match.status === 'live' ? 'live' : match.status === 'scheduled' ? 'scheduled' : 'final'
      debugInfo.match = { status: statuses.match, message: `Match status: ${statuses.match}` }
    } else {
      statuses.match = 'no_match'
      debugInfo.match = { status: 'no_match', message: 'No match connected. Enter a PIN to connect to a match.' }
    }
    
    // Check DB (IndexedDB) - always available in browser
    try {
      await db.matches.count()
      statuses.db = 'connected'
      debugInfo.db = { status: 'connected', message: 'IndexedDB is accessible' }
    } catch (err) {
      statuses.db = 'disconnected'
      debugInfo.db = { status: 'disconnected', message: `IndexedDB error: ${err.message || 'Database not accessible'}` }
    }
    
    setConnectionStatuses(statuses)
    setConnectionDebugInfo(debugInfo)
  }

  // Load available matches on mount and periodically
  useEffect(() => {
    const loadMatches = async () => {
      setLoadingMatches(true)
      try {
        const result = await listAvailableMatches()
        if (result.success && result.matches) {
          setAvailableMatches(result.matches)
          setServerConnected(true)
        } else {
          setServerConnected(false)
        }
      } catch (err) {
        console.error('Error loading matches:', err)
        setServerConnected(false)
      } finally {
        setLoadingMatches(false)
      }
    }
    
    loadMatches()
    checkConnectionStatuses()
    const interval = setInterval(() => {
      loadMatches()
      checkConnectionStatuses()
    }, 5000) // Refresh every 5 seconds
    
    return () => clearInterval(interval)
  }, [matchId, match])
  
  // Fullscreen functionality
  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
        setIsFullscreen(true)
      } else {
        await document.exitFullscreen()
        setIsFullscreen(false)
      }
    } catch (error) {
      console.error('Error toggling fullscreen:', error)
      // Fallback: try alternative fullscreen methods
      const doc = document.documentElement
      if (doc.webkitRequestFullscreen) {
        doc.webkitRequestFullscreen()
        setIsFullscreen(true)
      } else if (doc.msRequestFullscreen) {
        doc.msRequestFullscreen()
        setIsFullscreen(true)
      } else if (doc.mozRequestFullScreen) {
        doc.mozRequestFullScreen()
        setIsFullscreen(true)
      }
    }
  }
  
  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    document.addEventListener('msfullscreenchange', handleFullscreenChange)
    document.addEventListener('mozfullscreenchange', handleFullscreenChange)

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
      document.removeEventListener('msfullscreenchange', handleFullscreenChange)
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange)
    }
  }, [])

  // Auto-connect on mount if we have stored credentials
  useEffect(() => {
    const storedMatchId = localStorage.getItem('refereeMatchId')
    const storedPin = localStorage.getItem('refereePin')
    
    if (storedMatchId && storedPin) {
      // Validate stored PIN with server
      validatePin(storedPin, 'referee')
        .then(result => {
          if (result.success && result.match && String(result.match.id) === String(storedMatchId)) {
            setMatchId(Number(storedMatchId))
            setMatch(result.match)
            setPinInput(storedPin)
          } else {
            // Clear invalid stored credentials
            localStorage.removeItem('refereeMatchId')
            localStorage.removeItem('refereePin')
          }
        })
        .catch(() => {
          // Clear invalid stored credentials
          localStorage.removeItem('refereeMatchId')
          localStorage.removeItem('refereePin')
        })
    }
  }, [])
  
  const handleSelectGame = (gameNumber) => {
    setSelectedGameNumber(gameNumber)
    // DO NOT auto-fill PIN - it's a security check that must be entered manually
    setShowGameModal(false)
  }

  // Monitor match connection status
  useEffect(() => {
    if (match && match.refereeConnectionEnabled === false) {
      setMatchId(null)
      setMatch(null)
      setPinInput('')
      localStorage.removeItem('refereeMatchId')
      localStorage.removeItem('refereePin')
      setError('Connection has been disabled. Please enable the connection in the scoreboard and reconnect.')
    }
  }, [match])

  const handlePinSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    if (!pinInput || pinInput.length !== 6) {
      setError('Please enter a 6-digit PIN code')
      setIsLoading(false)
      return
    }

    try {
      // Validate PIN with server (no local IndexedDB)
      const result = await validatePin(pinInput.trim(), 'referee')
      
      if (result.success && result.match) {
        setMatchId(result.match.id)
        setMatch(result.match)
        // Store matchId and PIN in localStorage for persistence
        localStorage.setItem('refereeMatchId', String(result.match.id))
        localStorage.setItem('refereePin', pinInput)
      } else {
        setError('Invalid PIN code. Please check and try again.')
        setPinInput('')
        localStorage.removeItem('refereeMatchId')
        localStorage.removeItem('refereePin')
      }
    } catch (err) {
      console.error('Error validating PIN:', err)
      setError(err.message || 'Failed to validate PIN. Make sure the main scoresheet is running and connected.')
      setPinInput('')
      localStorage.removeItem('refereeMatchId')
      localStorage.removeItem('refereePin')
    } finally {
      setIsLoading(false)
    }
  }

  const handleExit = (reason) => {
    setMatchId(null)
    setMatch(null)
    setPinInput('')
    // Clear stored credentials on exit (including auto-reset after failures)
    localStorage.removeItem('refereeMatchId')
    localStorage.removeItem('refereePin')
    
    // Set appropriate error message based on reason
    if (reason === 'heartbeat_failure') {
      setError('Connection lost after multiple failed attempts. Please reconnect with a new PIN.')
    } else {
      setError('')
    }
  }

  // Monitor match status - clear credentials if match becomes final
  useEffect(() => {
    if (match && match.status === 'final') {
      localStorage.removeItem('refereeMatchId')
      localStorage.removeItem('refereePin')
      setMatchId(null)
      setMatch(null)
      setPinInput('')
      setError('Match has ended.')
    }
  }, [match])

  // Debug function to check games in progress
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.debugCheckGamesInProgress = async () => {
        try {
          console.log('🔍 Checking games from two sources:')
          console.log('   1. Local IndexedDB (what debug function sees)')
          console.log('   2. Server API (what Referee Dashboard sees)')
          console.log('')
          
          // 1. Check local IndexedDB
          const allMatches = await db.matches.toArray()
          const inProgressMatches = allMatches.filter(m => 
            m.status === 'live' || m.status === 'scheduled'
          )
          
          console.log(`📦 Local IndexedDB: ${inProgressMatches.length} match(es)`)
          
          // 2. Check server API (what Referee Dashboard actually uses)
          let serverMatches = []
          try {
            const serverResult = await listAvailableMatches()
            if (serverResult.success && serverResult.matches) {
              serverMatches = serverResult.matches
            }
          } catch (err) {
            console.warn('⚠️ Could not fetch from server API:', err.message)
          }
          
          console.log(`🌐 Server API: ${serverMatches.length} match(es) available in Referee Dashboard`)
          console.log('')
          
          if (serverMatches.length > 0 && inProgressMatches.length === 0) {
            console.log('⚠️ DISCREPANCY DETECTED!')
            console.log('   Server has matches but local DB does not.')
            console.log('   This means matches exist in server memory but not synced to local DB.')
            console.log('')
          }
          
          // Show server matches (what actually appears in dropdown)
          if (serverMatches.length > 0) {
            console.log('📋 Matches available in Referee Dashboard dropdown:')
            console.table(serverMatches.map(m => ({
              id: m.id,
              gameNumber: m.gameNumber,
              homeTeam: m.homeTeam,
              awayTeam: m.awayTeam,
              status: m.status,
              dateTime: m.dateTime,
              refereeConnectionEnabled: m.refereeConnectionEnabled
            })))
            
            serverMatches.forEach((m, idx) => {
              console.log(`\n🎮 Server Match ${idx + 1}:`)
              console.log(`   ID: ${m.id}`)
              console.log(`   Game #: ${m.gameNumber}`)
              console.log(`   Teams: ${m.homeTeam} vs ${m.awayTeam}`)
              console.log(`   Status: ${m.status}`)
              console.log(`   Date/Time: ${m.dateTime}`)
              console.log(`   Referee Connection: ${m.refereeConnectionEnabled ? '✅ Enabled' : '❌ Disabled'}`)
            })
          }
          
          // Show local DB matches with details
          if (inProgressMatches.length > 0) {
            const matchesWithDetails = await Promise.all(
              inProgressMatches.map(async (match) => {
                const homeTeam = match.homeTeamId ? await db.teams.get(match.homeTeamId) : null
                const awayTeam = match.awayTeamId ? await db.teams.get(match.awayTeamId) : null
                const sets = await db.sets.where('matchId').equals(match.id).toArray()
                const currentSet = sets.find(s => !s.finished) || sets[sets.length - 1]
                const eventCount = await db.events.where('matchId').equals(match.id).count()
                
                return {
                  id: match.id,
                  gameNumber: match.gameNumber || match.externalId || 'N/A',
                  homeTeam: homeTeam?.name || 'Unknown',
                  awayTeam: awayTeam?.name || 'Unknown',
                  status: match.status,
                  isLive: match.status === 'live',
                  currentSet: currentSet ? {
                    index: currentSet.index,
                    homePoints: currentSet.homePoints,
                    awayPoints: currentSet.awayPoints
                  } : null,
                  totalSets: sets.length,
                  eventCount: eventCount,
                  refereeConnectionEnabled: match.refereeConnectionEnabled !== false
                }
              })
            )
            
            console.log('\n📦 Local IndexedDB matches:')
            console.table(matchesWithDetails)
          }
          
          return { 
            localDB: { matches: inProgressMatches, count: inProgressMatches.length },
            serverAPI: { matches: serverMatches, count: serverMatches.length }
          }
        } catch (error) {
          console.error('❌ Error checking games in progress:', error)
          return { localDB: { matches: [], count: 0 }, serverAPI: { matches: [], count: 0 }, error: error.message }
        }
      }
    }
    
    return () => {
      if (typeof window !== 'undefined' && window.debugCheckGamesInProgress) {
        delete window.debugCheckGamesInProgress
      }
    }
  }, [])

  // Close connection menu when matchId changes
  useEffect(() => {
    if (matchId) {
      setShowConnectionMenu(false)
    }
  }, [matchId])

  if (matchId) {
    return <Referee matchId={matchId} onExit={handleExit} />
  }

  return (
    <div style={{
      minHeight: '100vh',
      width: '100%',
      maxWidth: '100vw',
      overflowX: 'hidden',
      overflowY: 'auto',
      background: 'linear-gradient(135deg,rgb(82, 82, 113) 0%,rgb(62, 22, 27) 100%)',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      boxSizing: 'border-box'
    }}>
      {/* Header */}
      <div 
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 20px',
          background: 'rgba(0, 0, 0, 0.2)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          flexShrink: 0,
          gap: '16px'
        }}
        onClick={(e) => {
          // Close connection menu and debug menu when clicking outside
          if (showConnectionMenu && !e.target.closest('[data-connection-menu]')) {
            setShowConnectionMenu(false)
          }
          if (showDebugMenu && !e.target.closest('[data-debug-menu]')) {
            setShowDebugMenu(null)
          }
        }}
      >
        {/* Left: Exit button (only show when NOT in home) */}
        {matchId && (
          <div style={{ flex: '0 0 auto', minWidth: '80px' }}>
            <button
              onClick={() => {
                handleExit()
              }}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                fontWeight: 600,
                background: 'rgba(255, 255, 255, 0.1)',
                color: '#fff',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
              }}
            >
              ← Exit
            </button>
          </div>
        )}
        {!matchId && <div style={{ flex: '0 0 auto', minWidth: '80px' }}></div>}
        
        
        {/* Spacer for right side to balance left side */}
        <div style={{ flex: '0 0 auto', minWidth: '80px' }}></div>
        
        {/* Right: Status indicators and fullscreen button */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '12px',
          flex: '0 0 auto',
          position: 'relative',
          minWidth: '80px',
          justifyContent: 'flex-end'
        }}>
          {/* Connection Status Indicator */}
          <ConnectionStatus
            connectionStatuses={connectionStatuses}
            connectionDebugInfo={connectionDebugInfo}
            position="right"
            size="normal"
          />
          
          {/* Available matches indicator */}
          {availableMatches.length > 0 && (
            <div style={{
              fontSize: '12px',
              padding: '4px 8px',
              background: 'rgba(59, 130, 246, 0.2)',
              border: '1px solid rgba(59, 130, 246, 0.5)',
              borderRadius: '4px',
              fontWeight: 600
            }}>
              {availableMatches.length} {availableMatches.length === 1 ? 'game' : 'games'}
            </div>
          )}
          
          {/* Fullscreen button */}
          <button
            onClick={toggleFullscreen}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: '#fff',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
            }}
            title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          >
            {isFullscreen ? '⛶ Exit' : '⛶ Fullscreen'}
          </button>
        </div>
      </div>
      
      {/* Main content */}
      <div style={{
        flex: '1 1 auto',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
        overflowY: 'auto'
    }}>
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: '12px',
        padding: '40px',
          maxWidth: 'min(400px, calc(100vw - 40px))',
        width: '100%',
          textAlign: 'center',
          boxSizing: 'border-box'
      }}>
        <img 
          src={refereeIcon} 
          alt="Referee Icon" 
          style={{ width: 'auto', height: 'auto', marginBottom: '20px' }} 
        />
        <h1 style={{ 
          fontSize: '24px', 
          fontWeight: 700, 
          marginBottom: '12px' 
        }}>
          Referee <br />
          Dashboard
        </h1>

        {availableMatches.length > 0 ? (
        <form onSubmit={handlePinSubmit} style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '16px',
            width: '100%',
            maxWidth: '100%',
            boxSizing: 'border-box'
        }}>
          {availableMatches.length > 0 && (
            <div style={{ width: '80%', maxWidth: '280px', boxSizing: 'border-box' }}>
              <label style={{
                display: 'block',
                fontSize: '12px',
                color: 'var(--muted)',
                marginBottom: '8px',
                fontWeight: 600
              }}>
                Select game {availableMatches.length > 0 && `(${availableMatches.length} available)`}
              </label>
              <button
                type="button"
                onClick={() => setShowGameModal(true)}
                disabled={isLoading}
                style={{
                  width: '100%',
                  padding: '12px',
                  fontSize: '16px',
                  background: 'var(--bg)',
                  border: '2px solid rgba(255,255,255,0.2)',
                  borderRadius: '8px',
                  color: 'var(--text)',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  opacity: isLoading ? 0.6 : 1,
                  fontWeight: 600
                }}
              >
                Select game
              </button>
              
              {selectedGameNumber && (() => {
                const selected = availableMatches.find(m => String(m.gameNumber) === String(selectedGameNumber))
                if (!selected) return null
                
                return (
                  <div style={{
                    marginTop: '12px',
                    padding: '12px',
                    background: 'rgba(59, 246, 78, 0.1)',
                    border: '1px solid rgba(59, 130, 246, 0.3)',
                    borderRadius: '8px',
                    textAlign: 'left'
                  }}>
                    <div style={{
                      fontSize: '16px',
                      fontWeight: 600,
                      marginBottom: '6px',
                      color: 'var(--text)'
                    }}>
                      Game #{selected.gameNumber}
                    </div>
                    <div style={{
                      fontSize: '14px',
                      color: 'var(--text)',
                      marginBottom: '4px'
                    }}>
                      {selected.homeTeam} <span style={{ color: 'var(--muted)', margin: '0 4px' }}>vs</span> {selected.awayTeam}
                    </div>
                    <div style={{
                      fontSize: '12px',
                      color: 'var(--muted)'
                    }}>
                      {selected.dateTime || 'TBD'}
                    </div>
                  </div>
                )
              })()}
            </div>
          )}
          
          <div style={{ width: '80%', maxWidth: '280px', boxSizing: 'border-box' }}>
            <label style={{
              display: 'block',
              fontSize: '12px',
              color: 'var(--muted)',
              marginBottom: '8px',
              fontWeight: 600
            }}>
              Connection PIN
            </label>
            <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ''))}
            placeholder="000000"
            maxLength={6}
            disabled={isLoading}
            style={{
              width: '100%',
              maxWidth: '100%',
              padding: '16px',
              fontSize: '24px',
              fontWeight: 700,
              textAlign: 'center',
              letterSpacing: '8px',
              background: 'var(--bg)',
              border: error ? '2px solid #ef4444' : '2px solid rgba(255,255,255,0.2)',
              borderRadius: '8px',
              color: 'var(--text)',
              opacity: isLoading ? 0.6 : 1,
              cursor: isLoading ? 'not-allowed' : 'text',
              boxSizing: 'border-box'
            }}
          />
          </div>
          
          {error && (
            <div style={{
              width: '100%',
              padding: '12px',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid #ef4444',
              borderRadius: '6px',
              color: '#ef4444',
              fontSize: '14px',
              marginBottom: '16px',
              textAlign: 'center'
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            style={{
              width: '50%',
              maxWidth: '200px',
              padding: '16px',
              fontSize: '16px',
              fontWeight: 600,
              background: isLoading ? 'rgba(255,255,255,0.3)' : 'var(--accent)',
              color: isLoading ? '#fff' : '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.7 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px'
            }}
          >
            {isLoading ? (
              <>
                <span style={{
                  display: 'inline-block',
                  width: '16px',
                  height: '16px',
                  border: '2px solid rgba(255,255,255,0.3)',
                  borderTopColor: '#fff',
                  borderRadius: '50%',
                  animation: 'spin 0.6s linear infinite'
                }}></span>
                Connecting...
              </>
            ) : (
              'Enter'
            )}
          </button>
        </form>
        ) : (
          <div style={{
            padding: '40px 20px',
            textAlign: 'center',
            color: 'var(--text)'
          }}>
            <div style={{
              fontSize: '20px',
              fontWeight: 700,
              marginBottom: '12px',
              color: 'rgba(255, 255, 255, 0.9)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '8px',
              padding: '12px'
            }}>
              AWAIT MATCH INITIALIZATION
            </div>
          </div>
        )}
      </div>
      </div>
      
      <Modal
        title="Select Game"
        open={showGameModal}
        onClose={() => setShowGameModal(false)}
        width={600}
      >
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          maxHeight: '70vh',
          overflowY: 'auto'
        }}>
          {loadingMatches ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
              Loading games...
            </div>
          ) : availableMatches.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
              No available games. Make sure the main scoresheet is running and has an active match with referee connection enabled.
            </div>
          ) : (
            availableMatches.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => handleSelectGame(m.gameNumber)}
                style={{
                  width: '100%',
                  padding: '16px',
                  background: selectedGameNumber === String(m.gameNumber) 
                    ? 'rgba(59, 130, 246, 0.2)' 
                    : 'rgba(255, 255, 255, 0.05)',
                  border: selectedGameNumber === String(m.gameNumber)
                    ? '2px solid rgba(59, 130, 246, 0.5)'
                    : '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '8px',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.2s',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px'
                }}
                onMouseEnter={(e) => {
                  if (selectedGameNumber !== String(m.gameNumber)) {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedGameNumber !== String(m.gameNumber)) {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                  }
                }}
              >
                <div style={{
                  fontSize: '18px',
                  fontWeight: 600,
                  marginBottom: '4px'
                }}>
                  Game #{m.gameNumber}
                </div>
                <div style={{
                  fontSize: '16px',
                  color: 'var(--text)',
                  marginBottom: '4px'
                }}>
                  {m.homeTeam} <span style={{ color: 'var(--muted)', margin: '0 8px' }}>vs</span> {m.awayTeam}
                </div>
                <div style={{
                  fontSize: '14px',
                  color: 'var(--muted)'
                }}>
                  {m.dateTime || 'TBD'}
                </div>
              </button>
            ))
          )}
        </div>
      </Modal>
      
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}

