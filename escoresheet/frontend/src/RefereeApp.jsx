import { useState, useEffect, useRef, useCallback } from 'react'
import { validatePin, listAvailableMatches } from './utils/serverDataSync'
import Referee from './components/Referee'
import Modal from './components/Modal'
import ConnectionStatus from './components/ConnectionStatus'
import UpdateBanner from './components/UpdateBanner'
import refereeIcon from './ref.png'
import { db } from './db/db'
import changelog from './CHANGELOG'

// Master PIN for testing without a match
const MASTER_PIN = '123456'

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
  const [isMasterMode, setIsMasterMode] = useState(false)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [testModeClicks, setTestModeClicks] = useState(0)
  const wakeLockRef = useRef(null)
  const testModeTimeoutRef = useRef(null)

  // Get current version from changelog
  const currentVersion = changelog[0]?.version || '1.0.0'

  const [connectionStatuses, setConnectionStatuses] = useState({
    api: 'unknown',
    server: 'unknown',
    websocket: 'unknown',
    scoreboard: 'unknown',
    match: 'unknown',
    db: 'unknown'
  })
  const [connectionDebugInfo, setConnectionDebugInfo] = useState({})

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
    try {
      // Check if we have a configured backend URL (Railway/cloud backend)
      const backendUrl = import.meta.env.VITE_BACKEND_URL

      let wsUrl
      if (backendUrl) {
        // Use configured backend (Railway cloud)
        const url = new URL(backendUrl)
        const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        wsUrl = `${protocol}//${url.host}`
      } else {
        // Fallback to local WebSocket server
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
        const hostname = window.location.hostname
        const wsPort = 8080
        wsUrl = `${protocol}://${hostname}:${wsPort}`
      }

      const wsTest = new WebSocket(wsUrl)
      let resolved = false

      // Use longer timeout for cloud backends
      const connectionTimeout = backendUrl ? 10000 : 2000

      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            try { wsTest.close() } catch (e) {}
            statuses.websocket = 'disconnected'
            debugInfo.websocket = { status: 'disconnected', message: `Connection timeout after ${connectionTimeout / 1000}s` }
            resolve()
          }
        }, connectionTimeout)

        wsTest.onopen = () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            try { wsTest.close() } catch (e) {}
            statuses.websocket = 'connected'
            debugInfo.websocket = { status: 'connected', message: 'WebSocket server is reachable' }
            resolve()
          }
        }

        wsTest.onerror = () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            try { wsTest.close() } catch (e) {}
            statuses.websocket = 'disconnected'
            debugInfo.websocket = { status: 'disconnected', message: `WebSocket connection error` }
            resolve()
          }
        }
        
        wsTest.onclose = () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            statuses.websocket = 'disconnected'
            resolve()
          }
        }
      })
    } catch (err) {
      statuses.websocket = 'disconnected'
      debugInfo.websocket = { status: 'disconnected', message: `Error: ${err.message}` }
    }
    
    statuses.scoreboard = statuses.server
    debugInfo.scoreboard = debugInfo.server
    
    if (matchId && match) {
      statuses.match = match.status === 'live' ? 'live' : match.status === 'scheduled' ? 'scheduled' : 'final'
      debugInfo.match = { status: statuses.match, message: `Match status: ${statuses.match}` }
    } else if (isMasterMode) {
      statuses.match = 'test_mode'
      debugInfo.match = { status: 'test_mode', message: 'Running in test mode with master PIN' }
    } else {
      statuses.match = 'no_match'
      debugInfo.match = { status: 'no_match', message: 'No match connected.' }
    }
    
    try {
      await db.matches.count()
      statuses.db = 'connected'
      debugInfo.db = { status: 'connected', message: 'IndexedDB is accessible' }
    } catch (err) {
      statuses.db = 'disconnected'
      debugInfo.db = { status: 'disconnected', message: `IndexedDB error: ${err.message}` }
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
    }, 30000) // Check every 30 seconds
    
    return () => clearInterval(interval)
  }, [matchId, match, isMasterMode])
  
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
    }
  }
  
  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // Wake lock - request on mount
  useEffect(() => {
    const enableWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          if (wakeLockRef.current) {
            try { await wakeLockRef.current.release() } catch (e) {}
          }
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          console.log('[WakeLock] Screen wake lock acquired (RefereeApp)')
          setWakeLockActive(true)
          wakeLockRef.current.addEventListener('release', () => {
            console.log('[WakeLock] Screen wake lock released (RefereeApp)')
            if (!wakeLockRef.current) {
              setWakeLockActive(false)
            }
          })
        }
      } catch (err) {
        console.log('[WakeLock] Wake lock failed:', err.message)
      }
    }

    enableWakeLock()

    // Re-enable on visibility change
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        enableWakeLock()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {})
        wakeLockRef.current = null
      }
    }
  }, [])

  // Toggle wake lock manually
  const toggleWakeLock = useCallback(async () => {
    if (wakeLockActive) {
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release()
          wakeLockRef.current = null
        } catch (e) {}
      }
      setWakeLockActive(false)
      console.log('[WakeLock] Manually disabled')
    } else {
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          setWakeLockActive(true)
          console.log('[WakeLock] Manually enabled')
        }
      } catch (err) {
        console.log('[WakeLock] Failed to enable:', err.message)
        setWakeLockActive(true)
      }
    }
  }, [wakeLockActive])

  // Auto-connect on mount if we have stored credentials
  useEffect(() => {
    const storedMatchId = localStorage.getItem('refereeMatchId')
    const storedPin = localStorage.getItem('refereePin')
    const storedMasterMode = localStorage.getItem('refereeMasterMode')
    
    if (storedMasterMode === 'true') {
      setIsMasterMode(true)
      setMatchId(-1) // Use -1 as a sentinel for master mode
    } else if (storedMatchId && storedPin) {
      validatePin(storedPin, 'referee')
        .then(result => {
          if (result.success && result.match && String(result.match.id) === String(storedMatchId)) {
            setMatchId(Number(storedMatchId))
            setMatch(result.match)
            setPinInput(storedPin)
          } else {
            localStorage.removeItem('refereeMatchId')
            localStorage.removeItem('refereePin')
          }
        })
        .catch(() => {
          localStorage.removeItem('refereeMatchId')
          localStorage.removeItem('refereePin')
        })
    }
  }, [])
  
  const handleSelectGame = (gameNumber) => {
    setSelectedGameNumber(gameNumber)
    setShowGameModal(false)
  }

  // Monitor match connection status
  useEffect(() => {
    if (match && match.refereeConnectionEnabled === false) {
      setMatchId(null)
      setMatch(null)
      setPinInput('')
      setIsMasterMode(false)
      localStorage.removeItem('refereeMatchId')
      localStorage.removeItem('refereePin')
      localStorage.removeItem('refereeMasterMode')
      setError('Connection has been disabled.')
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

    // Check for master PIN first
    if (pinInput === MASTER_PIN) {
      setIsMasterMode(true)
      setMatchId(-1) // Use -1 as sentinel for master/test mode
      localStorage.setItem('refereeMasterMode', 'true')
      setIsLoading(false)
      return
    }

    try {
      const result = await validatePin(pinInput.trim(), 'referee')
      
      if (result.success && result.match) {
        setMatchId(result.match.id)
        setMatch(result.match)
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
      setError(err.message || 'Failed to validate PIN.')
      setPinInput('')
    } finally {
      setIsLoading(false)
    }
  }

  const handleExit = (reason) => {
    setMatchId(null)
    setMatch(null)
    setPinInput('')
    setIsMasterMode(false)
    localStorage.removeItem('refereeMatchId')
    localStorage.removeItem('refereePin')
    localStorage.removeItem('refereeMasterMode')
    
    if (reason === 'heartbeat_failure') {
      setError('Connection lost. Please reconnect.')
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

  // Hidden test mode - 6 clicks on "No active game found"
  const handleTestModeClick = useCallback(() => {
    if (testModeTimeoutRef.current) {
      clearTimeout(testModeTimeoutRef.current)
    }

    setTestModeClicks(prev => {
      const newCount = prev + 1
      if (newCount >= 6) {
        // Trigger test/master mode
        setIsMasterMode(true)
        setMatchId(-1)
        localStorage.setItem('refereeMasterMode', 'true')
        return 0
      }
      return newCount
    })

    // Reset clicks after 2 seconds of no clicking
    testModeTimeoutRef.current = setTimeout(() => {
      setTestModeClicks(0)
    }, 2000)
  }, [])

  // Render Referee component if connected (either to match or in master mode)
  if (matchId) {
    return <Referee matchId={matchId} onExit={handleExit} isMasterMode={isMasterMode} />
  }

  return (
    <div style={{
      height: '100vh',
      width: '100vw',
      maxWidth: '100vw',
      margin: '0 auto',
      overflow: 'hidden',
      background: 'linear-gradient(135deg, rgb(82, 82, 113) 0%, rgb(62, 22, 27) 100%)',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      boxSizing: 'border-box'
    }}>
      <UpdateBanner />

      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'rgba(0, 0, 0, 0.2)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        padding: '8px 16px',
        flexShrink: 0,
        height: '40px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '16px', fontWeight: 600 }}>Referee</span>
          <button
            onClick={toggleWakeLock}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontWeight: 600,
              background: wakeLockActive ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255,255,255,0.1)',
              color: wakeLockActive ? '#22c55e' : '#fff',
              border: wakeLockActive ? '1px solid rgba(34, 197, 94, 0.5)' : '1px solid rgba(255,255,255,0.2)',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
            title={wakeLockActive ? 'Screen will stay on' : 'Screen may turn off'}
          >
            {wakeLockActive ? '☀️ On' : '🌙 Off'}
          </button>
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flex: '0 0 auto'
        }}>
          <ConnectionStatus
            connectionStatuses={connectionStatuses}
            connectionDebugInfo={connectionDebugInfo}
            position="right"
            size="normal"
          />

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

          <div style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)' }}>
            v{currentVersion}
          </div>

          <button
            onClick={toggleFullscreen}
            style={{
              padding: '4px 10px',
              fontSize: '12px',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: '#fff',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            {isFullscreen ? '⛶ Exit' : '⛶ Fullscreen'}
          </button>
        </div>
      </div>
      
      {/* Main content */}
      <div style={{
        flex: '1 1 auto',
        display: 'flex',
        width: 'auto',
        maxWidth: '100vw',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        overflowY: 'hidden'
      }}>
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          padding: '40px',
          width: 'auto',
          textAlign: 'center'
        }}>
          <img 
            src={refereeIcon} 
            alt="Referee Icon" 
            style={{ width: 'auto', height: 'auto', marginBottom: '20px' }} 
          />
          <h1 style={{ fontSize: '32px', fontWeight: 700, marginBottom: '12px' }}>
            Referee Dashboard
          </h1>

          {/* Show "no active game" when server is connected but no games available */}
          {serverConnected && availableMatches.length === 0 && !loadingMatches ? (
            <div
              onClick={handleTestModeClick}
              style={{
                padding: '24px',
                width: 'auto',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '12px',
                textAlign: 'center',
                cursor: 'default',
                userSelect: 'none'
              }}
            >
              <div style={{
                fontSize: '16px',
                width: 'auto',
                color: 'var(--muted)',
                marginBottom: '8px'
              }}>
                No active game found
              </div>
              <div style={{
                fontSize: '13px',
                color: 'rgba(255, 255, 255, 0.4)'
              }}>
                Start a match on the main scoresheet to connect
              </div>
            </div>
          ) : (
          <form onSubmit={handlePinSubmit} style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '16px',
            width: '100%'
          }}>
            {availableMatches.length > 0 && (
              <div style={{ width: '80%' }}>
                <label style={{
                  display: 'block',
                  fontSize: '12px',
                  color: 'var(--muted)',
                  marginBottom: '8px',
                  fontWeight: 600
                }}>
                  Select game ({availableMatches.length} available)
                </label>
                <button
                  type="button"
                  onClick={() => setShowGameModal(true)}
                  disabled={isLoading}
                  style={{
                    width: 'auto',
                    padding: '12px',
                    fontSize: '16px',
                    background: 'var(--bg)',
                    border: '2px solid rgba(255,255,255,0.2)',
                    borderRadius: '8px',
                    color: 'var(--text)',
                    cursor: isLoading ? 'not-allowed' : 'pointer',
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
                      padding: '12px',
                      margin: '12px auto 0 auto',
                      width: '300px',
                      background: 'rgba(13, 16, 14, 0.1)',
                      border: '1px solid rgba(59, 130, 246, 0.3)',
                      borderRadius: '8px',
                      textAlign: 'center'
                    }}>
                      <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px' }}>
                        Game #{selected.gameNumber}
                      </div>
                      <div style={{ fontSize: '14px', marginBottom: '4px' }}>
                        {selected.homeTeam} <span style={{ color: 'var(--muted)' }}>vs</span> {selected.awayTeam}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                        {selected.dateTime || 'TBD'}
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}

            {/* Only show PIN input when offline OR when there are games */}
            {(!serverConnected || availableMatches.length > 0) && (
            <div style={{ width: '80%', maxWidth: '280px' }}>
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
                  padding: '16px',
                  fontSize: '24px',
                  fontWeight: 700,
                  textAlign: 'center',
                  letterSpacing: '8px',
                  background: 'var(--bg)',
                  border: error ? '2px solid #ef4444' : '2px solid rgba(255,255,255,0.2)',
                  borderRadius: '8px',
                  color: 'var(--text)',
                  boxSizing: 'border-box'
                }}
              />
            </div>
            )}

            {error && (
              <div style={{
                width: 'auto',
                padding: '12px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid #ef4444',
                borderRadius: '6px',
                color: '#ef4444',
                fontSize: '14px'
              }}>
                {error}
              </div>
            )}

            {(!serverConnected || availableMatches.length > 0) && (
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
                cursor: isLoading ? 'not-allowed' : 'pointer'
              }}
            >
              {isLoading ? 'Connecting...' : 'Enter'}
            </button>
            )}
          </form>
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
              No available games.
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
                  textAlign: 'left'
                }}
              >
                <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '4px' }}>
                  Game #{m.gameNumber}
                </div>
                <div style={{ fontSize: '16px', marginBottom: '4px' }}>
                  {m.homeTeam} <span style={{ color: 'var(--muted)' }}>vs</span> {m.awayTeam}
                </div>
                <div style={{ fontSize: '14px', color: 'var(--muted)' }}>
                  {m.dateTime || 'TBD'}
                </div>
              </button>
            ))
          )}
        </div>
      </Modal>
    </div>
  )
}
