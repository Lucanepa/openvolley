import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { validatePin, listAvailableMatches, getWebSocketStatus, listAvailableMatchesForBenchSupabase } from './utils/serverDataSync'
import { getServerStatus } from './utils/networkInfo'
import MatchEntry from './components/MatchEntry'
import DashboardHeader from './components/DashboardHeader'
import UpdateBanner from './components/UpdateBanner'
import mikasaVolleyball from './mikasa_v200w.png'

// Primary ball image (with mikasa as fallback)
const ballImage = `${import.meta.env.BASE_URL}ball.png`
import { supabase } from './lib/supabaseClient'

// Connection modes
const CONNECTION_MODES = {
  AUTO: 'auto',
  SUPABASE: 'supabase',
  WEBSOCKET: 'websocket'
}

export default function BenchApp() {
  const { t } = useTranslation()
  const [availableMatches, setAvailableMatches] = useState([])
  const [loadingMatches, setLoadingMatches] = useState(false)
  const [selectedMatch, setSelectedMatch] = useState(null) // The selected match object
  const [selectedTeam, setSelectedTeam] = useState(null) // 'home' or 'away'
  const [pinInput, setPinInput] = useState('')
  const [matchId, setMatchId] = useState(null)
  const [error, setError] = useState('')
  const [view, setView] = useState(null) // 'roster' or 'match'
  const [match, setMatch] = useState(null)
  const wakeLockRef = useRef(null)
  const noSleepVideoRef = useRef(null)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [testModeClicks, setTestModeClicks] = useState(0)
  const testModeTimeoutRef = useRef(null)
  const [connectionStatuses, setConnectionStatuses] = useState({
    server: 'disconnected',
    websocket: 'disconnected',
    supabase: 'disconnected'
  })
  const [connectionDebugInfo, setConnectionDebugInfo] = useState({})
  const [connectionMode, setConnectionMode] = useState(() => {
    try {
      return localStorage.getItem('bench_connection_mode') || CONNECTION_MODES.AUTO
    } catch { return CONNECTION_MODES.AUTO }
  })
  const [activeConnection, setActiveConnection] = useState(null) // 'supabase' | 'websocket'
  const supabaseChannelRef = useRef(null)
  const [viewportWidth, setViewportWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 400)
  const [viewportHeight, setViewportHeight] = useState(() => typeof window !== 'undefined' ? window.innerHeight : 700)

  // Track viewport size for narrow screen blocking
  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth)
      setViewportHeight(window.innerHeight)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Preload assets that are used later (e.g., volleyball image)
  useEffect(() => {
    const assetsToPreload = [
      mikasaVolleyball
    ]

    assetsToPreload.forEach(src => {
      const img = new Image()
      img.src = src
    })
  }, [])

  // Request wake lock to prevent screen from sleeping
  useEffect(() => {
    const createNoSleepVideo = () => {
      if (noSleepVideoRef.current) return
      const mp4 = 'data:video/mp4;base64,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'
      const video = document.createElement('video')
      video.setAttribute('playsinline', '')
      video.setAttribute('muted', '')
      video.setAttribute('loop', '')
      video.setAttribute('src', mp4)
      video.style.position = 'fixed'
      video.style.top = '-9999px'
      video.style.left = '-9999px'
      video.style.width = '1px'
      video.style.height = '1px'
      document.body.appendChild(video)
      noSleepVideoRef.current = video
      return video
    }
    
    const enableNoSleep = async () => {
      try {
        if ('wakeLock' in navigator) {
          if (wakeLockRef.current) {
            try { await wakeLockRef.current.release() } catch (e) {}
          }
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          setWakeLockActive(true)
          wakeLockRef.current.addEventListener('release', () => {
            if (!wakeLockRef.current) {
              setWakeLockActive(false)
            }
          })
        }
      } catch (err) {
        // WakeLock failed, ignore
      }

      try {
        const video = createNoSleepVideo()
        if (video) {
          await video.play()
        }
      } catch (err) {
        // NoSleep video failed, ignore
      }
    }

    const handleInteraction = () => {
      enableNoSleep()
      document.removeEventListener('click', handleInteraction)
      document.removeEventListener('touchstart', handleInteraction)
    }
    
    enableNoSleep()
    document.addEventListener('click', handleInteraction, { once: true })
    document.addEventListener('touchstart', handleInteraction, { once: true })

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        enableNoSleep()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      document.removeEventListener('click', handleInteraction)
      document.removeEventListener('touchstart', handleInteraction)
      if (wakeLockRef.current) {
        wakeLockRef.current.release()
        wakeLockRef.current = null
      }
      if (noSleepVideoRef.current) {
        noSleepVideoRef.current.pause()
        noSleepVideoRef.current.remove()
        noSleepVideoRef.current = null
      }
    }
  }, [])

  // Toggle wake lock manually
  const toggleWakeLock = useCallback(async () => {
    if (wakeLockActive) {
      // Disable wake lock
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release()
          wakeLockRef.current = null
        } catch (e) {}
      }
      if (noSleepVideoRef.current) {
        noSleepVideoRef.current.pause()
      }
      setWakeLockActive(false)
      console.log('[WakeLock] Manually disabled')
    } else {
      // Enable wake lock
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          setWakeLockActive(true)
          console.log('[WakeLock] Manually enabled')
        }
        if (noSleepVideoRef.current) {
          await noSleepVideoRef.current.play()
        }
      } catch (err) {
        console.log('[WakeLock] Failed to enable:', err.message)
        setWakeLockActive(true) // Visual feedback even if API failed
      }
    }
  }, [wakeLockActive])

  // Load available matches function - extracted so it can be called manually
  const loadMatches = useCallback(async () => {
    setLoadingMatches(true)
    try {
      // Try Supabase first if in AUTO or SUPABASE mode
      const useSupabase = connectionMode === CONNECTION_MODES.SUPABASE ||
        (connectionMode === CONNECTION_MODES.AUTO && supabase)

      if (useSupabase && supabase) {
        const result = await listAvailableMatchesForBenchSupabase()
        if (result.success) {
          // Supabase is connected even if there are no matches
          setConnectionStatuses(prev => ({ ...prev, supabase: 'connected' }))
          if (result.matches && result.matches.length > 0) {
            setAvailableMatches(result.matches)
            setActiveConnection('supabase')
            setLoadingMatches(false)
            return
          }
        } else {
          // Supabase call failed
          setConnectionStatuses(prev => ({ ...prev, supabase: 'disconnected' }))
        }
      }

      // Fall back to WebSocket/server
      const result = await listAvailableMatches()
      if (result.success && result.matches) {
        setAvailableMatches(result.matches)
        setActiveConnection('websocket')
      }
    } catch (err) {
      console.error('[Bench] Error loading matches:', err)
    } finally {
      setLoadingMatches(false)
    }
  }, [connectionMode])

  // Load available matches on mount and periodically
  useEffect(() => {
    loadMatches()
    const interval = setInterval(loadMatches, 30000) // Refresh every 30 seconds

    return () => clearInterval(interval)
  }, [loadMatches])

  // Check connection status periodically
  useEffect(() => {
    // Check if we're on a static deployment (GitHub Pages, Cloudflare Pages, etc.)
    // Static deployments don't have a backend server - they rely on Supabase only
    const isStaticDeployment = !import.meta.env.DEV && (
      window.location.hostname.includes('github.io') ||
      window.location.hostname.endsWith('.openvolley.app') // All openvolley.app subdomains are static
    )
    const hasBackendUrl = !!import.meta.env.VITE_BACKEND_URL

    // For static deployments without backend, set server as not_available but check Supabase
    if (isStaticDeployment && !hasBackendUrl) {
      const checkSupabaseOnly = async () => {
        let supabaseConnected = false
        if (supabase) {
          try {
            const { error } = await supabase.from('matches').select('id').limit(1)
            supabaseConnected = !error
          } catch {
            supabaseConnected = false
          }
        }
        setConnectionStatuses(prev => ({
          ...prev,
          server: 'not_available',
          websocket: 'not_available',
          supabase: supabaseConnected ? 'connected' : 'disconnected'
        }))
      }
      setConnectionDebugInfo({
        server: {
          status: 'not_available',
          message: 'Static deployment - using Supabase only',
          details: 'Real-time WebSocket updates are not available. Match data is loaded from Supabase database.'
        }
      })
      checkSupabaseOnly()
      const interval = setInterval(checkSupabaseOnly, 10000)
      return () => clearInterval(interval)
    }

    const checkConnections = async () => {
      try {
        const serverStatus = await getServerStatus()
        const wsStatus = matchId ? getWebSocketStatus(matchId) : 'no_match'

        const serverConnected = serverStatus?.running

        // Check Supabase connectivity with a simple query
        let supabaseConnected = false
        if (supabase) {
          try {
            const { error } = await supabase.from('matches').select('id').limit(1)
            supabaseConnected = !error
          } catch {
            supabaseConnected = false
          }
        }

        setConnectionStatuses(prev => ({
          ...prev,
          server: serverConnected ? 'connected' : 'disconnected',
          websocket: matchId ? wsStatus : 'no_match',
          supabase: supabaseConnected ? 'connected' : 'disconnected'
        }))

        // Build debug info for disconnected services
        const debugInfo = {}
        if (!serverConnected) {
          debugInfo.server = {
            status: 'disconnected',
            message: 'Cannot reach the scoresheet server',
            details: 'Make sure the main scoresheet application is running and on the same network.'
          }
        }
        if (matchId && wsStatus !== 'connected' && wsStatus !== 'not_applicable') {
          debugInfo.websocket = {
            status: wsStatus,
            message: wsStatus === 'connecting' ? 'Attempting to connect...' : 'WebSocket connection lost',
            details: wsStatus === 'disconnected'
              ? 'Real-time updates are not available. The connection may have been interrupted or the match may have ended.'
              : wsStatus === 'connecting'
              ? 'Please wait while we establish a connection to the scoresheet.'
              : 'Unknown WebSocket state. Try refreshing the page.'
          }
        }
        setConnectionDebugInfo(prev => ({ ...prev, ...debugInfo }))
      } catch (err) {
        setConnectionStatuses(prev => ({
          ...prev, // Preserve supabase status
          server: 'disconnected',
          websocket: 'disconnected'
        }))
        setConnectionDebugInfo(prev => ({
          ...prev,
          server: {
            status: 'error',
            message: 'Failed to check server status',
            details: err.message || 'Network error occurred while checking connection.'
          }
        }))
      }
    }

    checkConnections()
    const interval = setInterval(checkConnections, 5000) // Check every 5 seconds

    return () => clearInterval(interval)
  }, [matchId])

  // Disconnect if connection is disabled
  useEffect(() => {
    if (match && selectedTeam) {
      const connectionEnabled = selectedTeam === 'home'
        ? match.homeTeamConnectionEnabled === true
        : match.awayTeamConnectionEnabled === true
      
      if (connectionEnabled === false) {
        setMatchId(null)
        setMatch(null)
        setView(null)
        setSelectedTeam(null)
        setPinInput('')
        setError('Connection has been disabled. Please enable the connection in the scoreboard and reconnect.')
      }
    }
  }, [match, selectedTeam])

  const handleTeamSelect = (team) => {
    setSelectedTeam(team)
    setPinInput('')
    setError('')
  }

  const handlePinSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!pinInput || pinInput.length !== 6) {
      setError('Please enter a 6-digit PIN code')
      return
    }

    if (!selectedTeam) {
      setError('Please select a team first')
      return
    }

    try {
      // Validate PIN with server (no local IndexedDB)
      const pinType = selectedTeam === 'home' ? 'homeTeam' : 'awayTeam'
      const result = await validatePin(pinInput.trim(), pinType)

      if (result.success && result.match) {
        setMatchId(result.match.id)
        setMatch(result.match)
        setView('match') // Go directly to match view (like RefereeApp)
      } else {
        setError('Invalid PIN code. Please check and try again.')
        setPinInput('')
      }
    } catch (err) {
      console.error('[Bench] Error validating PIN:', err)
      setError(err.message || 'Failed to validate PIN. Make sure the main scoresheet is running and connected.')
      setPinInput('')
    }
  }

  // Hidden test mode - 6 clicks on "No active game found"
  const handleTestModeClick = useCallback(() => {
    if (testModeTimeoutRef.current) {
      clearTimeout(testModeTimeoutRef.current)
    }

    setTestModeClicks(prev => {
      const newCount = prev + 1
      if (newCount >= 6) {
        // Create mock test match data
        const testMatch = {
          id: -1,
          gameNumber: 999,
          homeTeamName: 'Test Home',
          awayTeamName: 'Test Away',
          status: 'live'
        }
        setSelectedMatch(testMatch)
        setMatchId(-1)
        setMatch(testMatch)
        setSelectedTeam('home')
        return 0
      }
      return newCount
    })

    // Reset clicks after 2 seconds of no clicking
    testModeTimeoutRef.current = setTimeout(() => {
      setTestModeClicks(0)
    }, 2000)
  }, [])

  // Handle connection mode change
  const handleConnectionModeChange = useCallback((mode) => {
    setConnectionMode(mode)
    try {
      localStorage.setItem('bench_connection_mode', mode)
    } catch (e) {
      // Ignore localStorage errors
    }
    // Force reconnection by clearing states
    if (supabaseChannelRef.current) {
      supabase?.removeChannel(supabaseChannelRef.current)
      supabaseChannelRef.current = null
    }
    setActiveConnection(null)
  }, [connectionMode])

  const handleBack = () => {
    if (view) {
      setView(null)
    } else if (matchId) {
      setMatchId(null)
      setPinInput('')
      setError('')
    } else if (selectedTeam) {
      setSelectedTeam(null)
    } else if (selectedMatch) {
      setSelectedMatch(null)
      setError('')
    }
  }

  const handleMatchSelect = (matchObj) => {
    setSelectedMatch(matchObj)
    setError('')
  }

  // Get team names from selected match
  const homeTeamName = selectedMatch?.homeTeamName || 'Home Team'
  const awayTeamName = selectedMatch?.awayTeamName || 'Away Team'

  // If view is selected, show the appropriate component wrapped with SimpleHeader
  if (matchId && view) {
    const teamName = selectedTeam === 'home' ? homeTeamName : awayTeamName

    return (
      <div style={{
        height: '100vh',
        background: 'linear-gradient(135deg, rgb(82, 82, 113) 0%, rgb(62, 22, 27) 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        overflow: 'hidden'
      }}>
        <DashboardHeader
          title={teamName}
          subtitle={view === 'match' ? `${t('benchDashboard.game')} ${selectedMatch?.gameNumber || matchId}` : teamName}
          connectionStatuses={connectionStatuses}
          connectionDebugInfo={connectionDebugInfo}
          showWakeLock={true}
          wakeLockActive={wakeLockActive}
          onToggleWakeLock={toggleWakeLock}
          connectionMode={connectionMode}
          activeConnection={activeConnection}
          onConnectionModeChange={handleConnectionModeChange}
          onBack={handleBack}
          backLabel={t('benchDashboard.back')}
        />

        <div style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <MatchEntry
            matchId={matchId}
            team={selectedTeam}
            onBack={handleBack}
            embedded={true}
          />
        </div>
      </div>
    )
  }

  // If team is selected, show PIN entry
  if (selectedTeam) {
    const teamName = selectedTeam === 'home' ? homeTeamName : awayTeamName

    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, rgb(82, 82, 113) 0%, rgb(62, 22, 27) 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <DashboardHeader
          title={t('benchDashboard.title')}
          subtitle={teamName}
          connectionStatuses={connectionStatuses}
          connectionDebugInfo={connectionDebugInfo}
          showWakeLock={true}
          wakeLockActive={wakeLockActive}
          onToggleWakeLock={toggleWakeLock}
          connectionMode={connectionMode}
          activeConnection={activeConnection}
          onConnectionModeChange={handleConnectionModeChange}
        />

        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}>
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          padding: '40px',
          maxWidth: '400px',
          width: '100%',
          textAlign: 'center'
        }}>
          <img
            src={ballImage} onError={(e) => e.target.src = mikasaVolleyball}
            alt="Volleyball"
            style={{ width: '80px', height: '80px', marginBottom: '20px' }}
          />
          <h1 style={{
            fontSize: '24px',
            fontWeight: 700,
            marginBottom: '12px'
          }}>
            {teamName}
          </h1>
          <p style={{
            fontSize: '14px',
            color: 'var(--muted)',
            marginBottom: '32px'
          }}>
            {t('benchDashboard.enterPin')}
          </p>

          <form onSubmit={handlePinSubmit} style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center'
          }}>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              maxLength={6}
              style={{
                width: '80%',
                maxWidth: '280px',
                padding: '16px',
                fontSize: '24px',
                fontWeight: 700,
                textAlign: 'center',
                letterSpacing: '8px',
                background: 'var(--bg)',
                border: error ? '2px solid #ef4444' : '2px solid rgba(255,255,255,0.2)',
                borderRadius: '8px',
                color: 'var(--text)',
                marginBottom: '16px'
              }}
            />

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
              style={{
                width: '50%',
                maxWidth: '200px',
                padding: '16px',
                fontSize: '16px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                marginBottom: '16px'
              }}
            >
              {t('benchDashboard.connect')}
            </button>
          </form>

          <button
            onClick={handleBack}
            style={{
              width: '50%',
              maxWidth: '200px',
              padding: '12px',
              fontSize: '14px',
              fontWeight: 500,
              background: 'transparent',
              color: 'var(--muted)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            {t('benchDashboard.back')}
          </button>
        </div>
        </div>
      </div>
    )
  }

  // Team selection (after match is selected)
  if (selectedMatch && !selectedTeam) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, rgb(82, 82, 113) 0%, rgb(62, 22, 27) 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <DashboardHeader
          title={t('benchDashboard.title')}
          subtitle={`${t('benchDashboard.game')} ${selectedMatch.gameNumber}`}
          connectionStatuses={connectionStatuses}
          connectionDebugInfo={connectionDebugInfo}
          showWakeLock={true}
          wakeLockActive={wakeLockActive}
          onToggleWakeLock={toggleWakeLock}
          connectionMode={connectionMode}
          activeConnection={activeConnection}
          onConnectionModeChange={handleConnectionModeChange}
        />

        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}>
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          padding: '40px',
          maxWidth: '500px',
          width: '100%',
          textAlign: 'center'
        }}>
          <img
            src={ballImage} onError={(e) => e.target.src = mikasaVolleyball}
            alt="Volleyball"
            style={{ width: '80px', height: '80px', marginBottom: '20px' }}
          />
          <h1 style={{
            fontSize: '24px',
            fontWeight: 700,
            marginBottom: '12px'
          }}>
            {t('benchDashboard.selectTeam')}
          </h1>
          <p style={{
            fontSize: '14px',
            color: 'var(--muted)',
            marginBottom: '32px'
          }}>
            {t('benchDashboard.game')} {selectedMatch.gameNumber}
          </p>

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <button
              onClick={() => handleTeamSelect('home')}
              style={{
                width: '100%',
                padding: '20px',
                fontSize: '18px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'opacity 0.2s'
              }}
              onMouseOver={(e) => e.target.style.opacity = '0.9'}
              onMouseOut={(e) => e.target.style.opacity = '1'}
            >
              {homeTeamName}
            </button>

            <button
              onClick={() => handleTeamSelect('away')}
              style={{
                width: '100%',
                padding: '20px',
                fontSize: '18px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'opacity 0.2s'
              }}
              onMouseOver={(e) => e.target.style.opacity = '0.9'}
              onMouseOut={(e) => e.target.style.opacity = '1'}
            >
              {awayTeamName}
            </button>
          </div>

          <button
            onClick={handleBack}
            style={{
              marginTop: '24px',
              width: '100%',
              padding: '12px',
              fontSize: '14px',
              fontWeight: 500,
              background: 'transparent',
              color: 'var(--muted)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            {t('benchDashboard.back')}
          </button>
        </div>
        </div>
      </div>
    )
  }

  // Initial game selection
  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, rgb(82, 82, 113) 0%, rgb(62, 22, 27) 100%)',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      {/* Narrow screen blocking overlay */}
      {(viewportWidth < 357 || viewportHeight < 650) && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.95)',
          zIndex: 99999,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '64px', marginBottom: '24px' }}>📱</div>
          <h2 style={{
            fontSize: '24px',
            fontWeight: 700,
            color: '#ffffff',
            marginBottom: '16px'
          }}>
            {t('common.screenTooSmall', 'Screen too Small')}
          </h2>
          <p style={{
            fontSize: '16px',
            color: '#9ca3af',
            maxWidth: '300px',
            lineHeight: 1.5,
            marginBottom: '24px'
          }}>
            {t('common.screenTooSmallMessage', 'This app requires a minimum screen width of 357px. Please use a device with a wider screen or rotate your device to landscape mode.')}
          </p>
          <button
            onClick={() => {
              if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(() => {})
              }
            }}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              fontWeight: 600,
              background: 'var(--accent, #3b82f6)',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            <span>⛶</span>
            <span>{t('common.tryFullscreen', 'Try Fullscreen')}</span>
          </button>
          <p style={{
            fontSize: '12px',
            color: '#6b7280',
            marginTop: '12px'
          }}>
            {t('common.fullscreenHint', 'Fullscreen may provide more space by hiding browser UI.')}
          </p>
        </div>
      )}

      <UpdateBanner />

      <DashboardHeader
        title={t('benchDashboard.title')}
        connectionStatuses={connectionStatuses}
        connectionDebugInfo={connectionDebugInfo}
        onLoadGames={loadMatches}
        loadingMatches={loadingMatches}
        matchCount={availableMatches.length}
        showWakeLock={true}
        wakeLockActive={wakeLockActive}
        onToggleWakeLock={toggleWakeLock}
        connectionMode={connectionMode}
        activeConnection={activeConnection}
        onConnectionModeChange={handleConnectionModeChange}
      />

      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}>
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: '12px',
        padding: '40px',
        maxWidth: '500px',
        width: '100%',
        textAlign: 'center'
      }}>
        <img
          src={ballImage} onError={(e) => e.target.src = mikasaVolleyball}
          alt="Volleyball"
          style={{ width: '80px', height: '80px', marginBottom: '20px' }}
        />
        <h1 style={{
            fontSize: '32px',
            fontWeight: 700,
            marginBottom: '8px'
          }}>
            {t('benchDashboard.title')}
          </h1>

        {loadingMatches ? (
          <p style={{ color: 'var(--muted)', fontSize: '14px' }}>{t('benchDashboard.loadingGames')}</p>
        ) : availableMatches.length === 0 ? (
          <div
            onClick={handleTestModeClick}
            style={{
              padding: '24px',
              background: 'rgba(255, 255, 255, 0.05)',
              borderRadius: '12px',
              textAlign: 'center',
              cursor: 'default',
              userSelect: 'none'
            }}
          >
            <div style={{
              fontSize: '16px',
              color: 'var(--muted)',
              marginBottom: '8px'
            }}>
              {t('benchDashboard.noActiveGames')}
            </div>
           
          </div>
        ) : (
          <>
          <p style={{
            fontSize: '14px',
            color: 'var(--muted)',
            marginBottom: '32px'
          }}>
            {t('benchDashboard.selectGame')}
          </p>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            maxHeight: '300px',
            overflowY: 'auto'
          }}>
            {availableMatches.map((m) => (
              <button
                key={m.id}
                onClick={() => handleMatchSelect(m)}
                style={{
                  width: '100%',
                  padding: '16px',
                  fontSize: '16px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'opacity 0.2s',
                  textAlign: 'left'
                }}
                onMouseOver={(e) => e.target.style.opacity = '0.9'}
                onMouseOut={(e) => e.target.style.opacity = '1'}
              >
                <div style={{ fontWeight: 700, marginBottom: '4px' }}>
                  {t('benchDashboard.game')} {m.gameNumber}
                </div>
                <div style={{ fontSize: '14px', opacity: 0.8 }}>
                  {m.homeTeamName || t('common.home')} {t('benchDashboard.vs')} {m.awayTeamName || t('common.away')}
                </div>
              </button>
            ))}
          </div>
          </>
        )}

        {error && (
          <p style={{
            fontSize: '14px',
            color: '#ef4444',
            marginTop: '16px'
          }}>
            {error}
          </p>
        )}
      </div>
      </div>
    </div>
  )
}

