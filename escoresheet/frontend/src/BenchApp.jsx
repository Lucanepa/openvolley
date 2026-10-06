import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { validatePin, validatePinSupabase, listAvailableMatches, getWebSocketStatus, listAvailableMatchesForBenchSupabase, getMatchData, matchTeamNames, setRelayDevice, getRelayServerStatus } from './utils/serverDataSync'
import MatchEntry from './components/MatchEntry'
import DashboardHeader from './components/DashboardHeader'
import UpdateBanner from './components/UpdateBanner'
import ServerConnectionScreen from './components/ServerConnectionScreen'
import { setBackendOverride, isServedFromLocalServer } from './utils/backendConfig'
import mikasaVolleyball from './mikasa_v200w.png'

// Primary ball image (with mikasa as fallback)
const ballImage = `${import.meta.env.BASE_URL}ball.png`
import { supabase } from './lib/supabaseClient'
import { apiFrom } from './lib/apiClient'
import { CalendarX2, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { Button } from './ui/Button.jsx'
import { IconButton } from './ui/IconButton.jsx'
import { FormError } from './ui/Field.jsx'
import { EmptyState } from './ui/EmptyState.jsx'
import { RowList } from './ui/Row.jsx'
import { SkeletonRows } from './ui/Skeleton.jsx'
import { EntryPage, EntryCard, PinInput, ListLabel, GameRow, NarrowScreenOverlay } from './components/dashboards/EntryKit.jsx'

// Connection modes
const CONNECTION_MODES = {
  AUTO: 'auto',
  SUPABASE: 'supabase',
  WEBSOCKET: 'websocket'
}

// The connected bench survives a reload (like the referee's refereeMatchId /
// refereePin): { matchId, team, pin, gameNumber, homeTeamName, awayTeamName }.
// Re-validated against the server on load.
const BENCH_SESSION_KEY = 'bench_session'

export function readBenchSession() {
  try {
    const raw = localStorage.getItem(BENCH_SESSION_KEY)
    const s = raw ? JSON.parse(raw) : null
    if (!s || !s.matchId || (s.team !== 'home' && s.team !== 'away') || !/^\d{6}$/.test(String(s.pin || ''))) return null
    return s
  } catch {
    return null
  }
}

function writeBenchSession(session) {
  try {
    if (session) localStorage.setItem(BENCH_SESSION_KEY, JSON.stringify(session))
    else localStorage.removeItem(BENCH_SESSION_KEY)
  } catch { /* storage unavailable: the bench just asks again after a reload */ }
}

/**
 * Validate a bench PIN server-side: the backend's database check (cloud) and
 * the LAN relay, in the order the connection mode / match source suggests. The
 * cloud check is skipped in WebSocket mode and gives up after 3 s, so an
 * offline venue never waits.
 */
export async function validateBenchPin(pin, team, { connectionMode = CONNECTION_MODES.AUTO, preferLan = false } = {}) {
  const pinType = team === 'home' ? 'homeTeam' : 'awayTeam'
  const checkSupabase = async () => {
    const r = await validatePinSupabase(pin, team === 'home' ? 'bench_home' : 'bench_away')
    if (!r.success || !r.match) return r
    // The server only accepts a bench PIN while that bench is enabled; older
    // backends don't echo the flag, which would trip the disconnect check.
    const flag = team === 'home' ? 'homeTeamConnectionEnabled' : 'awayTeamConnectionEnabled'
    return r.match[flag] === undefined ? { ...r, match: { ...r.match, [flag]: true } } : r
  }
  const checkLan = () => validatePin(pin, pinType).catch((err) => ({ success: false, error: err.message }))
  const ok = (r) => r?.success && r.match
  let result
  if (connectionMode === CONNECTION_MODES.WEBSOCKET) {
    result = await checkLan()
  } else if (preferLan) {
    result = await checkLan()
    if (!ok(result) && connectionMode === CONNECTION_MODES.AUTO) result = await checkSupabase()
  } else {
    result = await checkSupabase()
    if (!ok(result)) result = await checkLan()
  }
  return result
}

/** "Game 12", or undefined while the game number is unknown (never "Game null"). */
export function benchGameLabel(t, gameNumber) {
  if (gameNumber == null || gameNumber === '') return undefined
  return `${t('benchDashboard.game')} ${gameNumber}`
}

export default function BenchApp() {
  const { t, i18n } = useTranslation()
  const [serverReady, setServerReady] = useState(isServedFromLocalServer())
  const [autoConnectMatch, setAutoConnectMatch] = useState(null)
  const [autoConnectTeam, setAutoConnectTeam] = useState(null)
  const [restoringSession, setRestoringSession] = useState(false)
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

  // Check URL params for auto-connect on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const matchParam = params.get('match')
    const serverParam = params.get('server')
    const teamParam = params.get('team')

    if (serverParam) {
      setBackendOverride(serverParam.startsWith('http') ? serverParam : `https://${serverParam}`)
    }

    if (matchParam) {
      setAutoConnectMatch(matchParam)
      if (teamParam === 'home' || teamParam === 'away') {
        setAutoConnectTeam(teamParam)
      }
      setServerReady(true)
    } else if (readBenchSession()) {
      // Reconnect a bench that was connected before the reload
      setRestoringSession(true)
      setServerReady(true)
    }
  }, [])

  // Restore the stored bench session: same PIN check as a fresh connect
  useEffect(() => {
    if (!restoringSession) return
    const session = readBenchSession()
    if (!session) {
      setRestoringSession(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const result = await validateBenchPin(session.pin, session.team, { connectionMode })
        if (cancelled) return
        if (result?.success && result.match && String(result.match.id) === String(session.matchId)) {
          const names = matchTeamNames(result.match)
          setSelectedMatch({
            id: result.match.id,
            gameNumber: result.match.gameNumber || session.gameNumber,
            homeTeamName: names.home || session.homeTeamName,
            awayTeamName: names.away || session.awayTeamName
          })
          setSelectedTeam(session.team)
          setRelayDevice('bench', session.team)
          setMatchId(result.match.id)
          setMatch(result.match)
          setView('match')
        } else {
          writeBenchSession(null)
        }
      } catch {
        // Server unreachable right now: keep the session for the next load
      } finally {
        if (!cancelled) setRestoringSession(false)
      }
    })()
    return () => { cancelled = true }
  }, [restoringSession, connectionMode])

  // Auto-connect to match from URL params
  useEffect(() => {
    if (!autoConnectMatch || !serverReady) return

    // A match link (QR code) preselects the match and, with team=, the team:
    // the bench still enters its PIN (the link alone is no access, and the PIN
    // check returns the match with its connection flags).
    const doAutoConnect = async () => {
      let linked = { id: autoConnectMatch, gameNumber: null }
      try {
        const result = await getMatchData(autoConnectMatch)
        if (result.success && result.match) {
          const names = matchTeamNames(result.match, { homeTeam: result.homeTeam, awayTeam: result.awayTeam })
          linked = {
            // The link's seed key: the relay copy's match.id is the scorer's
            // Dexie id, which is no match key (every device's first match is 1)
            id: autoConnectMatch,
            gameNumber: result.match.gameNumber || result.match.gameN || result.match.game_n || null,
            homeTeamName: names.home,
            awayTeamName: names.away
          }
        }
      } catch { /* the PIN step still works without the details */ }
      setSelectedMatch(linked)
      if (autoConnectTeam) setSelectedTeam(autoConnectTeam)
      setAutoConnectMatch(null)
      setAutoConnectTeam(null)
    }
    doAutoConnect()
  }, [autoConnectMatch, autoConnectTeam, serverReady])

  // Handle server connection established
  const handleServerConnected = useCallback(() => {
    setServerReady(true)
  }, [])

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
        connectionMode === CONNECTION_MODES.AUTO

      if (useSupabase) {
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

  // Load available matches on mount only (no auto-polling — use manual refresh button)
  useEffect(() => {
    loadMatches()
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
        try {
          const { error } = await apiFrom('matches').select('id').limit(1)
          supabaseConnected = !error
        } catch {
          supabaseConnected = false
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
        const serverStatus = await getRelayServerStatus()
        const wsStatus = matchId ? getWebSocketStatus(matchId) : 'no_match'

        const serverConnected = serverStatus?.running

        // Check Supabase connectivity with a simple query
        let supabaseConnected = false
        try {
          const { error } = await apiFrom('matches').select('id').limit(1)
          supabaseConnected = !error
        } catch {
          supabaseConnected = false
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
    const interval = setInterval(checkConnections, 15000) // Check every 15 seconds

    return () => clearInterval(interval)
  }, [matchId])

  // Disconnect if connection is disabled
  useEffect(() => {
    if (match && selectedTeam) {
      const connectionEnabled = selectedTeam === 'home'
        ? match.homeTeamConnectionEnabled === true
        : match.awayTeamConnectionEnabled === true
      
      if (connectionEnabled === false) {
        writeBenchSession(null)
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
      // Validate PIN server-side (no local IndexedDB), like RefereeApp: the
      // backend's Supabase check (the bench lists Supabase matches) and the LAN
      // relay. LAN first when the user chose WebSocket mode or the match list
      // came from the LAN relay.
      const pin = pinInput.trim()
      const result = await validateBenchPin(pin, selectedTeam, {
        connectionMode,
        preferLan: activeConnection === 'websocket'
      })

      if (result?.success && result.match) {
        const names = matchTeamNames(result.match)
        const gameNumber = result.match.gameNumber || selectedMatch?.gameNumber || null
        setSelectedMatch(prev => ({
          ...(prev || {}),
          id: result.match.id,
          gameNumber,
          homeTeamName: names.home || prev?.homeTeamName || null,
          awayTeamName: names.away || prev?.awayTeamName || null
        }))
        setRelayDevice('bench', selectedTeam)
        setMatchId(result.match.id)
        setMatch(result.match)
        writeBenchSession({
          matchId: result.match.id,
          team: selectedTeam,
          pin,
          gameNumber,
          homeTeamName: names.home || selectedMatch?.homeTeamName || null,
          awayTeamName: names.away || selectedMatch?.awayTeamName || null
        })
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
      // Leaving the match: no automatic reconnect after a reload
      writeBenchSession(null)
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

  // Get team names from selected match (list entries, PIN check and relay
  // bundles name them differently)
  const selectedNames = matchTeamNames(selectedMatch)
  const homeTeamName = selectedNames.home || 'Home team'
  const awayTeamName = selectedNames.away || 'Away team'

  // Label this tablet on the relay (scorer's tablet status). Set before the
  // match view mounts (PIN submit / restore): MatchEntry subscribes in its own
  // effect, which runs before this component's effects.
  useEffect(() => {
    if (!matchId || !selectedTeam) setRelayDevice(null)
  }, [matchId, selectedTeam])

  // Show server connection screen first (unless auto-connecting via URL params)
  if (!serverReady) {
    return <ServerConnectionScreen onConnected={handleServerConnected} />
  }

  // If view is selected, show the appropriate component wrapped with SimpleHeader
  if (matchId && view) {
    const teamName = selectedTeam === 'home' ? homeTeamName : awayTeamName

    return (
      <div style={{
        height: '100dvh',
        background: 'var(--bg)',
        color: 'var(--text)',
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
        minHeight: '100dvh',
        background: 'var(--bg)',
        color: 'var(--text)',
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

        <EntryPage>
          <EntryCard
            art={<img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Volleyball" className="h-20 w-20" />}
            title={teamName}
            subtitle={t('benchDashboard.enterPin')}
          >
            <form onSubmit={handlePinSubmit} className="flex flex-col gap-4">
              <PinInput
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                aria-label={t('benchDashboard.enterPin')}
                maxLength={6}
                invalid={!!error}
              />

              <FormError size="md" className="text-center">{error}</FormError>

              <Button type="submit" size="xl" block>
                {t('benchDashboard.connect')}
              </Button>
            </form>

            <Button variant="ghost" size="xl" block className="mt-3 font-medium" onClick={handleBack}>
              {t('benchDashboard.back')}
            </Button>
          </EntryCard>
        </EntryPage>
      </div>
    )
  }

  // Team selection (after match is selected)
  if (selectedMatch && !selectedTeam) {
    return (
      <div style={{
        minHeight: '100dvh',
        background: 'var(--bg)',
        color: 'var(--text)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <DashboardHeader
          title={t('benchDashboard.title')}
          subtitle={benchGameLabel(t, selectedMatch.gameNumber)}
          connectionStatuses={connectionStatuses}
          connectionDebugInfo={connectionDebugInfo}
          showWakeLock={true}
          wakeLockActive={wakeLockActive}
          onToggleWakeLock={toggleWakeLock}
          connectionMode={connectionMode}
          activeConnection={activeConnection}
          onConnectionModeChange={handleConnectionModeChange}
        />

        <EntryPage>
          <EntryCard
            art={<img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Volleyball" className="h-20 w-20" />}
            title={t('benchDashboard.selectTeam')}
            subtitle={benchGameLabel(t, selectedMatch.gameNumber)}
          >
            <div className="flex flex-col gap-3">
              <Button
                variant="secondary"
                size="xl"
                block
                iconRight={ChevronRight}
                className="h-auto min-h-14 justify-between py-3 text-left text-base whitespace-normal"
                onClick={() => handleTeamSelect('home')}
              >
                {homeTeamName}
              </Button>
              <Button
                variant="secondary"
                size="xl"
                block
                iconRight={ChevronRight}
                className="h-auto min-h-14 justify-between py-3 text-left text-base whitespace-normal"
                onClick={() => handleTeamSelect('away')}
              >
                {awayTeamName}
              </Button>
            </div>

            <Button variant="ghost" size="xl" block className="mt-6 font-medium" onClick={handleBack}>
              {t('benchDashboard.back')}
            </Button>
          </EntryCard>
        </EntryPage>
      </div>
    )
  }

  // Initial game selection
  return (
    <div style={{
      minHeight: '100dvh',
      background: 'var(--bg)',
      color: 'var(--text)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      {/* Narrow screen blocking overlay */}
      {(viewportWidth < 357 || viewportHeight < 650) && <NarrowScreenOverlay t={t} />}

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

      <EntryPage>
        <EntryCard
          width="md"
          art={<img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Volleyball" className="h-20 w-20" />}
          title={t('benchDashboard.title')}
        >
        {loadingMatches ? (
          <div role="status" className="text-left">
            <span className="sr-only">{t('benchDashboard.loadingGames')}</span>
            <SkeletonRows rows={3} pill={false} />
          </div>
        ) : availableMatches.length === 0 ? (
          <div onClick={handleTestModeClick} className="cursor-default select-none">
            <EmptyState
              icon={CalendarX2}
              className="py-6"
              action={
                <Button variant="secondary" size="xl" icon={RefreshCw} onClick={loadMatches} disabled={loadingMatches}>
                  {loadingMatches ? t('common.loading', 'Loading...') : t('benchDashboard.loadGames', 'Load games')}
                </Button>
              }
            >
              {t('benchDashboard.noActiveGames')}
            </EmptyState>
          </div>
        ) : (
          <div className="text-left">
            <ListLabel
              action={
                <IconButton
                  variant="outline"
                  className="h-11 w-11"
                  icon={loadingMatches ? <Loader2 size={16} className="animate-spin" aria-hidden /> : RefreshCw}
                  label={t('benchDashboard.loadGames', 'Load games')}
                  onClick={loadMatches}
                  disabled={loadingMatches}
                />
              }
            >
              {t('benchDashboard.selectGame')}
            </ListLabel>
            <RowList soft className="max-h-[300px] overflow-y-auto">
              {availableMatches.map((m) => (
                <GameRow
                  key={m.id}
                  match={m}
                  lang={i18n.language}
                  home={m.homeTeamName || t('common.home')}
                  away={m.awayTeamName || t('common.away')}
                  gameLabel={benchGameLabel(t, m.gameNumber)}
                  onOpen={() => handleMatchSelect(m)}
                  status={<ChevronRight size={16} className="text-stone-400" aria-hidden />}
                />
              ))}
            </RowList>
          </div>
        )}

        <FormError size="md" className="mt-4">{error}</FormError>
        </EntryCard>
      </EntryPage>
    </div>
  )
}

