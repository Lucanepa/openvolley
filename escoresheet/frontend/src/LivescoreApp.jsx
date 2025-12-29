import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { findMatchByGameNumber, getMatchData, subscribeToMatchData, listAvailableMatches, getWebSocketStatus, listAvailableMatchesSupabase } from './utils/serverDataSync'
import { getServerStatus } from './utils/networkInfo'
import SimpleHeader from './components/SimpleHeader'
import UpdateBanner from './components/UpdateBanner'
import TestModeControls from './components/TestModeControls'
import mikasaVolleyball from './mikasa_v200w.png'
import { Results } from '../scoresheet_pdf/components/FooterSection'
import { supabase } from './lib/supabaseClient'

// Connection modes
const CONNECTION_MODES = {
  AUTO: 'auto',
  SUPABASE: 'supabase',
  WEBSOCKET: 'websocket'
}

// Helper function to determine if a color is bright
const isBrightColor = (color) => {
  if (!color) return false
  const hex = color.replace('#', '')
  const r = parseInt(hex.substr(0, 2), 16)
  const g = parseInt(hex.substr(2, 2), 16)
  const b = parseInt(hex.substr(4, 2), 16)
  const brightness = (r * 299 + g * 587 + b * 114) / 1000
  return brightness > 155
}

export default function LivescoreApp() {
  const { t } = useTranslation()
  const [gameId, setGameId] = useState(null)
  const [gameIdInput, setGameIdInput] = useState('')
  const [error, setError] = useState('')
  const [sidesSwitched, setSidesSwitched] = useState(false)
  const [availableMatches, setAvailableMatches] = useState([])
  const [loadingMatches, setLoadingMatches] = useState(false)
  const [connectionStatuses, setConnectionStatuses] = useState({
    server: 'disconnected',
    websocket: 'disconnected',
    supabase: 'disconnected'
  })
  const [connectionDebugInfo, setConnectionDebugInfo] = useState({})
  const [connectionMode, setConnectionMode] = useState(() => {
    try {
      return localStorage.getItem('livescore_connection_mode') || CONNECTION_MODES.AUTO
    } catch { return CONNECTION_MODES.AUTO }
  })
  const [activeConnection, setActiveConnection] = useState(null) // 'supabase' | 'websocket'
  const supabaseChannelRef = useRef(null)
  const [supabaseLiveState, setSupabaseLiveState] = useState(null) // Data from match_live_state
  const wakeLockRef = useRef(null)
  const noSleepVideoRef = useRef(null)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [testModeClicks, setTestModeClicks] = useState(0)
  const testModeTimeoutRef = useRef(null)

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
      const mp4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAA1VtZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE1NSByMjkxNyAwYTg0ZDk4IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAxOCAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTMgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAbWWIhAAz//727L4FNf2f0JcRLMXaSnA+KqSAgHc0wAAAAwAAAwAAV/8iZ2P/4kTVAAIgAAABHQZ4iRPCv/wAAAwAAAwAAHxQSRJ2C2E0AAAMAAAMAYOLkAADAAAHPgVxpAAKGAAABvBqIAg5LAH4AABLNAAAAHEGeQniFfwAAAwAAAwACNQsIAADAAADABOvIgAAAABoBnmF0Rn8AAAMAAAMAAApFAADAAADAECGAAHUAAAAaAZ5jakZ/AAADAAADAAClYlVkAAADAAADAJdwAAAAVUGaZkmoQWyZTAhv//6qVQAAAwAACjIWAANXJ5AAVKLiPqsAAHG/pAALrZ6AAHUhqAAC8QOAAHo0KAAHqwIAAeNf4AAcfgdSAAGdg+sAAOCnAABH6AAAADdBnoRFESwn/wAAAwAAAwAB7YZ+YfJAAOwAkxZiAgABmtQACVrdYAAbcqMAAPMrOAAH1LsAAJ5gAAAAGgGeo3RGfwAAAwAAAwAAXHMAADAAADAEfmAAdQAAABoBnqVqRn8AAAMAAAMAAKReyQADAAADABYxgAAAAFVBmqpJqEFsmUwIb//+qlUAAAMAAAoWMAANXIYAAUZC4kLQAB8rCgABTxKAADq86AAFHAwAAe3E4AAdTHoAAahnMAAL7zYAAR9BcAAN0SgAASNvQAAAADdBnshFFSwn/wAAAwAAAwAB7YZ+YfJAAOwAkxZiAgABvNIACVqdYAAbcqMAAPcquAAH1LsAAJ5gAAAAGgGe53RGfwAAAwAAAwAAXHUAADAAADAEfmAAdQAAABoBnulqRn8AAAMAAAMAAKRhXQADAAADABVxgAAAAGhBmu5JqEFsmUwIb//+qlUAAAMAAH8yQAB7sgACKrBcSAAIKXS4AAd8MAAG7xwAApriMAASJiQAAXfPOAACmvmAACNqrgAB2OyYAAm0kwABRZvgABCrlAAC7SfAABqJMAAHpZugAAAzQZ8MRRUsJ/8AAAMAAAMA5nIA/VBzAADYASYsxBwAA3mjABLVOsAANuVGAAHuVnAACuYAAAAXAZ8rdEZ/AAADAAADABSsSqyAYAC6zAAAdQAAABkBny1qRn8AAAMAAAMAFGpKrIBgAMDOJKAAdQA='
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
    } else {
      // Enable wake lock
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          setWakeLockActive(true)
        }
        if (noSleepVideoRef.current) {
          await noSleepVideoRef.current.play()
        }
      } catch (err) {
        setWakeLockActive(true) // Visual feedback even if API failed
      }
    }
  }, [wakeLockActive])

  // Load available matches on mount and periodically
  useEffect(() => {
    const loadMatches = async () => {
      setLoadingMatches(true)
      try {
        // Try Supabase first if in AUTO or SUPABASE mode
        const useSupabase = connectionMode === CONNECTION_MODES.SUPABASE ||
          (connectionMode === CONNECTION_MODES.AUTO && supabase)

        if (useSupabase && supabase) {
          const result = await listAvailableMatchesSupabase()
          if (result.success && result.matches && result.matches.length > 0) {
            setAvailableMatches(result.matches)
            setConnectionStatuses(prev => ({ ...prev, supabase: 'connected' }))
            setActiveConnection('supabase')
            setLoadingMatches(false)
            return
          }
        }

        // Fall back to WebSocket/server
        const result = await listAvailableMatches()
        if (result.success && result.matches) {
          setAvailableMatches(result.matches)
          setActiveConnection('websocket')
        }
      } catch (err) {
        console.error('[Livescore] Error loading matches:', err)
      } finally {
        setLoadingMatches(false)
      }
    }

    loadMatches()
    const interval = setInterval(loadMatches, 30000)

    return () => clearInterval(interval)
  }, [connectionMode])

  // Check connection status periodically
  useEffect(() => {
    // Check if we're on a static deployment (GitHub Pages, Cloudflare Pages, etc.)
    // Static deployments don't have a backend server - they rely on Supabase only
    const isStaticDeployment = !import.meta.env.DEV && (
      window.location.hostname.includes('github.io') ||
      window.location.hostname.endsWith('.openvolley.app') // All openvolley.app subdomains are static
    )
    const hasBackendUrl = !!import.meta.env.VITE_BACKEND_URL

    // For static deployments without backend, set server as not_available but keep Supabase
    if (isStaticDeployment && !hasBackendUrl) {
      setConnectionStatuses(prev => ({
        ...prev, // Preserve supabase status
        server: 'not_available',
        websocket: 'not_available'
      }))
      setConnectionDebugInfo({
        server: {
          status: 'not_available',
          message: 'Static deployment - using Supabase only',
          details: 'Real-time WebSocket updates are not available. Match data is loaded from Supabase database.'
        }
      })
      return // Don't start polling for server status
    }

    const checkConnections = async () => {
      try {
        const serverStatus = await getServerStatus()
        const wsStatus = gameId ? getWebSocketStatus(gameId) : 'not_applicable'
        const serverConnected = serverStatus?.running

        setConnectionStatuses(prev => ({
          ...prev,
          server: serverConnected ? 'connected' : 'disconnected',
          websocket: gameId ? wsStatus : 'not_applicable'
          // supabase status is managed by the subscription effect
        }))

        // Update debug info
        const newDebugInfo = {}
        if (!serverConnected) {
          newDebugInfo.server = {
            status: 'disconnected',
            message: serverStatus?.error || 'Cannot reach backend server',
            details: `URL: ${import.meta.env.VITE_BACKEND_URL || 'Not configured'}`
          }
        }
        if (gameId && wsStatus !== 'connected') {
          newDebugInfo.websocket = {
            status: wsStatus,
            message: wsStatus === 'connecting' ? 'Attempting to connect...' :
                     wsStatus === 'disconnected' ? 'WebSocket connection lost' :
                     wsStatus === 'error' ? 'WebSocket error occurred' : 'Not connected',
            details: `Game ID: ${gameId}`
          }
        }
        setConnectionDebugInfo(prev => ({ ...prev, ...newDebugInfo }))
      } catch (err) {
        setConnectionStatuses(prev => ({
          ...prev,
          server: 'disconnected',
          websocket: 'disconnected'
        }))
        setConnectionDebugInfo(prev => ({
          ...prev,
          server: { status: 'error', message: err.message || 'Failed to check server status' },
          websocket: { status: 'disconnected', message: 'Cannot check WebSocket without server' }
        }))
      }
    }

    checkConnections()
    const interval = setInterval(checkConnections, 5000)

    return () => clearInterval(interval)
  }, [gameId])

  // Get gameId from URL (optional)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const gameIdParam = urlParams.get('gameId')
    if (gameIdParam) {
      const id = parseInt(gameIdParam)
      if (!isNaN(id)) {
        setGameId(id)
        setGameIdInput(String(id))
      }
    }
  }, [])

  // Handle game number input submission
  const handleGameIdSubmit = async (e) => {
    e.preventDefault()
    setError('')
    
    const gameNum = gameIdInput.trim()
    if (!gameNum) {
      setError(t('livescore.errors.enterGameNumber'))
      return
    }
    
    try {
      // Try to find match by game number from server
      const foundMatch = await findMatchByGameNumber(gameNum)
      if (foundMatch) {
        setGameId(foundMatch.id)
        setGameIdInput(String(foundMatch.id))
      } else {
        // Try as direct match ID
        const id = parseInt(gameNum)
        if (!isNaN(id) && id > 0) {
          setGameId(id)
        } else {
          setError(t('livescore.errors.matchNotFound'))
        }
      }
    } catch (err) {
      console.error('Error finding match:', err)
      setError(t('livescore.errors.failedToFindMatch'))
    }
  }

  // Load match data from server
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [dataError, setDataError] = useState('')

  useEffect(() => {
    if (!gameId) {
      setData(null)
      return
    }

    setLoading(true)
    setDataError('')

    // Fetch initial match data
    const fetchData = async () => {
      try {
        const result = await getMatchData(gameId)
        if (result.success) {
          const matchData = result
          const currentSet = (matchData.sets || []).find(s => !s.finished) || 
                           (matchData.sets || []).sort((a, b) => b.index - a.index)[0]
          
          setData({
            match: matchData.match,
            homeTeam: matchData.homeTeam,
            awayTeam: matchData.awayTeam,
            homePlayers: matchData.homePlayers || [],
            awayPlayers: matchData.awayPlayers || [],
            sets: matchData.sets || [],
            events: matchData.events || [],
            set: currentSet
          })
        } else {
          setDataError(t('livescore.errors.failedToLoadData'))
        }
      } catch (err) {
        console.error('Error fetching match data:', err)
        setDataError(t('livescore.errors.failedToLoadDataConnection'))
      } finally {
        setLoading(false)
      }
    }

    fetchData()

    // Determine which connection to use
    const useSupabase = connectionMode === CONNECTION_MODES.SUPABASE ||
      (connectionMode === CONNECTION_MODES.AUTO && supabase)
    const useWebSocket = connectionMode === CONNECTION_MODES.WEBSOCKET ||
      (connectionMode === CONNECTION_MODES.AUTO && !supabase)

    let wsUnsubscribe = null

    // Subscribe to Supabase match_live_state if using Supabase
    if (useSupabase && supabase) {
      setActiveConnection('supabase')

      // Fetch initial live state
      const fetchLiveState = async () => {
        try {
          const { data: liveState, error } = await supabase
            .from('match_live_state')
            .select('*')
            .eq('match_id', gameId)
            .maybeSingle()

          if (!error && liveState) {
            setSupabaseLiveState(liveState)
            setConnectionStatuses(prev => ({ ...prev, supabase: 'connected' }))
          }
        } catch (err) {
          console.error('[Livescore] Error fetching live state:', err)
        }
      }
      fetchLiveState()

      // Subscribe to realtime updates
      const channel = supabase
        .channel(`livescore-${gameId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'match_live_state',
            filter: `match_id=eq.${gameId}`
          },
          (payload) => {
            setSupabaseLiveState(payload.new)
          }
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setConnectionStatuses(prev => ({ ...prev, supabase: 'connected' }))
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            setConnectionStatuses(prev => ({ ...prev, supabase: 'error' }))
            // Fall back to WebSocket if AUTO mode
            if (connectionMode === CONNECTION_MODES.AUTO) {
              setActiveConnection('websocket')
            }
          }
        })

      supabaseChannelRef.current = channel
    }

    // Subscribe to WebSocket if using WebSocket
    if (useWebSocket || (connectionMode === CONNECTION_MODES.AUTO && !supabase)) {
      wsUnsubscribe = subscribeToMatchData(gameId, (updatedData) => {
        setActiveConnection('websocket')
        const currentSet = (updatedData.sets || []).find(s => !s.finished) ||
                          (updatedData.sets || []).sort((a, b) => b.index - a.index)[0]

        setData({
          match: updatedData.match,
          homeTeam: updatedData.homeTeam,
          awayTeam: updatedData.awayTeam,
          homePlayers: updatedData.homePlayers || [],
          awayPlayers: updatedData.awayPlayers || [],
          sets: updatedData.sets || [],
          events: updatedData.events || [],
          set: currentSet
        })
      })
    }

    // Refetch data when page becomes visible (handles screen wake from sleep)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchData()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      if (wsUnsubscribe) wsUnsubscribe()
      if (supabaseChannelRef.current) {
        supabase?.removeChannel(supabaseChannelRef.current)
        supabaseChannelRef.current = null
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [gameId, connectionMode])


  // Determine which team is A and which is B based on coin toss
  const teamAKey = useMemo(() => {
    if (!data?.match) return 'home'
    return data.match.coinTossTeamA || 'home'
  }, [data?.match])
  
  const teamBKey = useMemo(() => {
    if (!data?.match) return 'away'
    return data.match.coinTossTeamB || 'away'
  }, [data?.match])

  // Determine if home team is on left - used for non-Supabase mode
  const homeTeamOnLeft = useMemo(() => {
    // If sides are manually switched, override the computed value
    if (sidesSwitched) {
      // Get the base homeTeamOnLeft value
      if (!data?.set) return false

      const setIndex = data.set.index

      // Check for manual override first (for sets 1-4)
      if (setIndex >= 1 && setIndex <= 4 && data.match?.setLeftTeamOverrides) {
        const override = data.match.setLeftTeamOverrides[setIndex]
        if (override) {
          const leftTeamKey = override === 'A' ? teamAKey : teamBKey
          return leftTeamKey !== 'home' // Invert for switch
        }
      }

      // Set 1: Team A on left
      if (setIndex === 1) {
        return teamAKey !== 'home' // Invert for switch
      }

      // Set 5: Special case with court switch at 8 points
      if (setIndex === 5) {
        if (data.match?.set5LeftTeam) {
          const leftTeamKey = data.match.set5LeftTeam === 'A' ? teamAKey : teamBKey
          let isHome = leftTeamKey === 'home'
          if (data.match?.set5CourtSwitched) {
            isHome = !isHome
          }
          return !isHome // Invert for switch
        }
        let isHome = teamAKey !== 'home'
        if (data.match?.set5CourtSwitched) {
          isHome = !isHome
        }
        return !isHome // Invert for switch
      }

      // Sets 2, 3, 4: Teams alternate sides
      return setIndex % 2 === 1 ? (teamAKey !== 'home') : (teamAKey === 'home') // Invert for switch
    }

    // Normal computation (not switched)
    if (!data?.set) return true

    const setIndex = data.set.index

    // Check for manual override first (for sets 1-4)
    if (setIndex >= 1 && setIndex <= 4 && data.match?.setLeftTeamOverrides) {
      const override = data.match.setLeftTeamOverrides[setIndex]
      if (override) {
        const leftTeamKey = override === 'A' ? teamAKey : teamBKey
        return leftTeamKey === 'home'
      }
    }

    // Set 1: Team A on left
    if (setIndex === 1) {
      return teamAKey === 'home'
    }

    // Set 5: Special case with court switch at 8 points
    if (setIndex === 5) {
      if (data.match?.set5LeftTeam) {
        const leftTeamKey = data.match.set5LeftTeam === 'A' ? teamAKey : teamBKey
        let isHome = leftTeamKey === 'home'
        if (data.match?.set5CourtSwitched) {
          isHome = !isHome
        }
        return isHome
      }
      let isHome = teamAKey !== 'home'
      if (data.match?.set5CourtSwitched) {
        isHome = !isHome
      }
      return isHome
    }

    // Sets 2, 3, 4: Teams alternate sides
    return setIndex % 2 === 1 ? (teamAKey === 'home') : (teamAKey !== 'home')
  }, [data?.set, data?.match?.set5CourtSwitched, data?.match?.set5LeftTeam, data?.match?.setLeftTeamOverrides, teamAKey, sidesSwitched])

  // Calculate set score (number of sets won by each team) - prioritize Supabase data
  const setScore = useMemo(() => {
    // Use Supabase live state if available - use left/right directly, swap if sidesSwitched
    if (activeConnection === 'supabase' && supabaseLiveState) {
      const dataLeft = supabaseLiveState.set_score_left || 0
      const dataRight = supabaseLiveState.set_score_right || 0
      return sidesSwitched
        ? { left: dataRight, right: dataLeft }
        : { left: dataLeft, right: dataRight }
    }

    if (!data) return { left: 0, right: 0 }

    const allSets = data.sets || []
    const finishedSets = allSets.filter(s => s.finished)

    const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
    const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length

    const leftSetsWon = homeTeamOnLeft ? homeSetsWon : awaySetsWon
    const rightSetsWon = homeTeamOnLeft ? awaySetsWon : homeSetsWon

    return { left: leftSetsWon, right: rightSetsWon }
  }, [data, homeTeamOnLeft, activeConnection, supabaseLiveState, sidesSwitched])

  // Get current score - prioritize Supabase data
  const currentScore = useMemo(() => {
    // Use Supabase live state if available - swap if sidesSwitched
    if (activeConnection === 'supabase' && supabaseLiveState) {
      const dataLeft = supabaseLiveState.points_left || 0
      const dataRight = supabaseLiveState.points_right || 0
      return sidesSwitched
        ? { left: dataRight, right: dataLeft }
        : { left: dataLeft, right: dataRight }
    }

    if (!data?.set) return { left: 0, right: 0 }
    return {
      left: homeTeamOnLeft ? data.set.homePoints : data.set.awayPoints,
      right: homeTeamOnLeft ? data.set.awayPoints : data.set.homePoints
    }
  }, [data?.set, homeTeamOnLeft, activeConnection, supabaseLiveState, sidesSwitched])

  // Determine who has serve - prioritize Supabase data
  const currentServe = useMemo(() => {
    // Use Supabase live state if available
    if (activeConnection === 'supabase' && supabaseLiveState && supabaseLiveState.serving_team) {
      return supabaseLiveState.serving_team
    }

    if (!data?.set || !data?.match) {
      return data?.match?.firstServe || 'home'
    }

    const setIndex = data.set.index
    const set1FirstServe = data.match.firstServe || 'home'

    // Calculate first serve for current set based on alternation pattern
    let currentSetFirstServe
    if (setIndex === 5 && data.match?.set5FirstServe) {
      currentSetFirstServe = data.match.set5FirstServe === 'A' ? teamAKey : teamBKey
    } else if (setIndex === 5) {
      currentSetFirstServe = set1FirstServe
    } else {
      // Sets 1-4: odd sets (1, 3) same as Set 1, even sets (2, 4) opposite
      currentSetFirstServe = setIndex % 2 === 1 ? set1FirstServe : (set1FirstServe === 'home' ? 'away' : 'home')
    }

    if (!data?.events || data.events.length === 0) {
      return currentSetFirstServe
    }

    const pointEvents = data.events
      .filter(e => e.type === 'point' && e.setIndex === data.set.index)
      .sort((a, b) => {
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime
      })

    if (pointEvents.length === 0) {
      return currentSetFirstServe
    }

    return pointEvents[0].payload?.team || currentSetFirstServe
  }, [data?.set, data?.match, data?.events, teamAKey, teamBKey, activeConnection, supabaseLiveState])

  // Get current set index - prioritize Supabase data
  const currentSetIndex = useMemo(() => {
    if (activeConnection === 'supabase' && supabaseLiveState && supabaseLiveState.current_set) {
      return supabaseLiveState.current_set
    }
    return data?.set?.index || 1
  }, [data?.set?.index, activeConnection, supabaseLiveState])

  // Handle connection mode change
  const handleConnectionModeChange = useCallback((mode) => {
    setConnectionMode(mode)
    try {
      localStorage.setItem('livescore_connection_mode', mode)
    } catch (e) {
      console.warn('[Livescore] Failed to save connection mode:', e)
    }
    // Force reconnection by clearing states
    if (supabaseChannelRef.current) {
      supabase?.removeChannel(supabaseChannelRef.current)
      supabaseChannelRef.current = null
    }
    setSupabaseLiveState(null)
    setActiveConnection(null)
  }, [])

  // Get team labels
  const teamALabel = data?.match?.coinTossTeamA === 'home' ? 'A' : 'B'
  const teamBLabel = data?.match?.coinTossTeamB === 'home' ? 'A' : 'B'

  // Get left and right teams - use Supabase names when available, swap if sidesSwitched
  const leftTeam = useMemo(() => {
    // Use Supabase names when available (swap if sidesSwitched)
    if (activeConnection === 'supabase' && supabaseLiveState) {
      const name = sidesSwitched ? supabaseLiveState.team_right_name : supabaseLiveState.team_left_name
      const teamLetter = sidesSwitched ? supabaseLiveState.team_right : supabaseLiveState.team_left
      return {
        name: name || 'Left',
        color: data?.homeTeam?.color || data?.awayTeam?.color || '#ef4444',
        isTeamA: teamLetter === 'A'
      }
    }
    const team = homeTeamOnLeft ? data?.homeTeam : data?.awayTeam
    const teamKey = homeTeamOnLeft ? teamAKey : teamBKey
    return {
      name: team?.name || (homeTeamOnLeft ? 'Home' : 'Away'),
      color: team?.color || (homeTeamOnLeft ? '#ef4444' : '#3b82f6'),
      isTeamA: teamKey === teamAKey
    }
  }, [data, homeTeamOnLeft, teamAKey, activeConnection, supabaseLiveState, sidesSwitched])

  const rightTeam = useMemo(() => {
    // Use Supabase names when available (swap if sidesSwitched)
    if (activeConnection === 'supabase' && supabaseLiveState) {
      const name = sidesSwitched ? supabaseLiveState.team_left_name : supabaseLiveState.team_right_name
      const teamLetter = sidesSwitched ? supabaseLiveState.team_left : supabaseLiveState.team_right
      return {
        name: name || 'Right',
        color: data?.awayTeam?.color || data?.homeTeam?.color || '#3b82f6',
        isTeamA: teamLetter === 'A'
      }
    }
    const team = homeTeamOnLeft ? data?.awayTeam : data?.homeTeam
    const teamKey = homeTeamOnLeft ? teamBKey : teamAKey
    return {
      name: team?.name || (homeTeamOnLeft ? 'Away' : 'Home'),
      color: team?.color || (homeTeamOnLeft ? '#3b82f6' : '#ef4444'),
      isTeamA: teamKey === teamAKey
    }
  }, [data, homeTeamOnLeft, teamAKey, teamBKey, activeConnection, supabaseLiveState, sidesSwitched])

  // Determine serving team - Supabase uses 'left'/'right', local uses 'home'/'away'
  // Swap if sidesSwitched for Supabase mode
  const leftIsServing = activeConnection === 'supabase'
    ? (sidesSwitched ? currentServe === 'right' : currentServe === 'left')
    : currentServe === (homeTeamOnLeft ? 'home' : 'away')
  const rightIsServing = activeConnection === 'supabase'
    ? (sidesSwitched ? currentServe === 'left' : currentServe === 'right')
    : currentServe === (homeTeamOnLeft ? 'away' : 'home')

  // Calculate set results for Results component (when match ends)
  const calculateSetResults = useMemo(() => {
    if (!data) return []

    const { match, sets, events } = data
    const localTeamAKey = match?.coinTossTeamA || 'home'
    const localTeamBKey = localTeamAKey === 'home' ? 'away' : 'home'

    const results = []
    for (let setNum = 1; setNum <= 5; setNum++) {
      const setInfo = sets?.find(s => s.index === setNum)
      const setEvents = events?.filter(e => e.setIndex === setNum) || []

      const isSetFinished = setInfo?.finished === true

      const teamAPoints = isSetFinished
        ? (localTeamAKey === 'home' ? (setInfo?.homePoints || 0) : (setInfo?.awayPoints || 0))
        : null
      const teamBPoints = isSetFinished
        ? (localTeamBKey === 'home' ? (setInfo?.homePoints || 0) : (setInfo?.awayPoints || 0))
        : null

      const teamATimeouts = isSetFinished
        ? setEvents.filter(e => e.type === 'timeout' && e.payload?.team === localTeamAKey).length
        : null
      const teamBTimeouts = isSetFinished
        ? setEvents.filter(e => e.type === 'timeout' && e.payload?.team === localTeamBKey).length
        : null

      const teamASubstitutions = isSetFinished
        ? setEvents.filter(e => e.type === 'substitution' && e.payload?.team === localTeamAKey).length
        : null
      const teamBSubstitutions = isSetFinished
        ? setEvents.filter(e => e.type === 'substitution' && e.payload?.team === localTeamBKey).length
        : null

      const teamAWon = isSetFinished && teamAPoints !== null && teamBPoints !== null
        ? (teamAPoints > teamBPoints ? 1 : 0)
        : null
      const teamBWon = isSetFinished && teamAPoints !== null && teamBPoints !== null
        ? (teamBPoints > teamAPoints ? 1 : 0)
        : null

      let duration = ''
      if (isSetFinished && setInfo?.endTime) {
        let start
        if (setNum === 1 && match?.scheduledAt) {
          start = new Date(match.scheduledAt)
        } else if (setInfo?.startTime) {
          start = new Date(setInfo.startTime)
        } else {
          start = new Date()
        }
        const end = new Date(setInfo.endTime)
        const durationMs = end.getTime() - start.getTime()
        const minutes = Math.floor(durationMs / 60000)
        duration = minutes > 0 ? `${minutes}'` : ''
      }

      results.push({
        setNumber: setNum,
        teamATimeouts,
        teamASubstitutions,
        teamAWon,
        teamAPoints,
        teamBTimeouts,
        teamBSubstitutions,
        teamBWon,
        teamBPoints,
        duration
      })
    }
    return results
  }, [data])

  // Match finished info
  const isMatchFinished = useMemo(() => {
    if (!data?.match) return false
    return data.match.status === 'final' || setScore.left === 3 || setScore.right === 3
  }, [data?.match, setScore])

  const matchWinner = useMemo(() => {
    if (!isMatchFinished) return ''
    // Use Supabase names when available (account for sidesSwitched)
    if (activeConnection === 'supabase' && supabaseLiveState) {
      // setScore already has left/right swapped if sidesSwitched, so use consistent naming
      const visualLeftName = sidesSwitched ? supabaseLiveState.team_right_name : supabaseLiveState.team_left_name
      const visualRightName = sidesSwitched ? supabaseLiveState.team_left_name : supabaseLiveState.team_right_name
      return setScore.left > setScore.right
        ? (visualLeftName || 'Left')
        : (visualRightName || 'Right')
    }
    if (!data) return ''
    return setScore.left > setScore.right
      ? (homeTeamOnLeft ? data.homeTeam?.name : data.awayTeam?.name) || 'Left'
      : (homeTeamOnLeft ? data.awayTeam?.name : data.homeTeam?.name) || 'Right'
  }, [isMatchFinished, data, setScore, activeConnection, supabaseLiveState, homeTeamOnLeft, sidesSwitched])

  const matchResult = useMemo(() => {
    if (!isMatchFinished) return ''
    return `3:${Math.min(setScore.left, setScore.right)}`
  }, [isMatchFinished, setScore])

  // Check if game exists and is in progress (don't set error for finished matches - we show results instead)
  useEffect(() => {
    if (gameId && data?.match) {
      // Don't set error for finished matches - we'll show results
      setError('')
    } else if (gameId && dataError) {
      setError(dataError)
    } else if (gameId && !data && !loading) {
      setError(t('livescore.gameNotFound'))
    }
  }, [gameId, data, dataError, loading])

  // Handle test mode activation (6 clicks on "No active game found")
  const handleTestModeClick = useCallback(() => {
    if (testModeTimeoutRef.current) {
      clearTimeout(testModeTimeoutRef.current)
    }

    setTestModeClicks(prev => {
      const newCount = prev + 1
      if (newCount >= 6) {
        // Activate test mode with mock data
        const testData = {
          match: {
            id: -1,
            gameNumber: 999,
            status: 'live',
            firstServe: 'home',
            coinTossTeamA: 'home',
            coinTossTeamB: 'away'
          },
          homeTeam: { name: 'Test Home', color: '#ef4444' },
          awayTeam: { name: 'Test Away', color: '#3b82f6' },
          homePlayers: [],
          awayPlayers: [],
          sets: [{ index: 1, homePoints: 12, awayPoints: 10, finished: false }],
          events: [{ type: 'point', setIndex: 1, payload: { team: 'home' }, ts: Date.now() }],
          set: { index: 1, homePoints: 12, awayPoints: 10, finished: false }
        }
        setGameId(-1)
        setData(testData)
        return 0
      }
      return newCount
    })

    testModeTimeoutRef.current = setTimeout(() => {
      setTestModeClicks(0)
    }, 2000)
  }, [])

  // Show input form if no gameId is set
  if (!gameId) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <UpdateBanner />

        <SimpleHeader
          title={t('livescore.title')}
          wakeLockActive={wakeLockActive}
          toggleWakeLock={toggleWakeLock}
          connectionStatuses={connectionStatuses}
          connectionDebugInfo={connectionDebugInfo}
        />
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}>
        <div style={{
          textAlign: 'center',
          maxWidth: '400px',
          width: '100%'
        }}>
           <img
          src={mikasaVolleyball}
          alt="Volleyball"
          style={{ width: '80px', height: '80px', marginBottom: '20px' }}
        />
          <h1 style={{
            fontSize: '32px',
            fontWeight: 700,
            marginBottom: '8px'
          }}>
            {t('livescore.title')}
          </h1>

          {loadingMatches ? (
            <div style={{
              padding: '20px',
              color: 'rgba(255, 255, 255, 0.7)',
              fontSize: '16px'
            }}>
              {t('livescore.loadingGames')}
            </div>
          ) : availableMatches.length > 0 ? (
            <>
            <p style={{
              fontSize: '16px',
              color: 'rgba(255, 255, 255, 0.7)',
              marginBottom: '32px'
            }}>
              {t('livescore.selectGame')}
            </p>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              width: '100%'
            }}>
              {availableMatches.map((match) => (
                <button
                  key={match.id}
                  onClick={() => {
                    setGameId(match.id)
                    setGameIdInput(String(match.id))
                  }}
                  style={{
                    padding: '16px 20px',
                    background: 'rgba(255, 255, 255, 0.1)',
                    border: '2px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '12px',
                    color: '#fff',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    textAlign: 'left'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
                  }}
                >
                  <div style={{
                    fontSize: '14px',
                    fontWeight: 600,
                    color: 'var(--accent)',
                    marginBottom: '4px'
                  }}>
                    {t('livescore.game', { number: match.gameNumber || match.id })}
                  </div>
                  <div style={{
                    fontSize: '16px',
                    fontWeight: 500
                  }}>
                    {match.homeTeamName || t('common.home')} {t('livescore.vs')} {match.awayTeamName || t('common.away')}
                  </div>
                </button>
              ))}
            </div>
            </>
          ) : (
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
                {t('livescore.noActiveGame')}
              </div>
            </div>
          )}

          {error && (
            <div style={{
              padding: '12px',
              marginTop: '16px',
              background: 'rgba(239, 68, 68, 0.2)',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              borderRadius: '6px',
              color: '#ff6b6b',
              fontSize: '14px',
              width: '100%',
              textAlign: 'center'
            }}>
              {error}
            </div>
          )}
        </div>
        </div>
      </div>
    )
  }

  // Show error if game doesn't exist (but not for finished matches)
  if (error || !data?.match) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <SimpleHeader
          title={t('livescore.title')}
          wakeLockActive={wakeLockActive}
          toggleWakeLock={toggleWakeLock}
          connectionStatuses={connectionStatuses}
          connectionDebugInfo={connectionDebugInfo}
        />
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}>
        <div style={{
          textAlign: 'center',
          maxWidth: '400px',
          width: '100%'
        }}>
          <div style={{
            fontSize: '24px',
            fontWeight: 600,
            marginBottom: '16px'
          }}>
            {error || t('livescore.gameNotFound')}
          </div>
          <button
            onClick={() => {
              setGameId(null)
              setGameIdInput('')
              setError('')
            }}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: '#fff',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'background 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
            }}
          >
            {t('livescore.enterDifferentGame')}
          </button>
        </div>
        </div>
      </div>
    )
  }

  // Show results when match is finished
  if (isMatchFinished) {
    const teamAShortName = data.match?.coinTossTeamA === 'home'
      ? (data.match?.homeShortName || data.homeTeam?.shortName || data.homeTeam?.name || 'Home')
      : (data.match?.awayShortName || data.awayTeam?.shortName || data.awayTeam?.name || 'Away')
    const teamBShortName = data.match?.coinTossTeamA === 'home'
      ? (data.match?.awayShortName || data.awayTeam?.shortName || data.awayTeam?.name || 'Away')
      : (data.match?.homeShortName || data.homeTeam?.shortName || data.homeTeam?.name || 'Home')

    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <SimpleHeader
          title={t('livescore.matchFinished')}
          wakeLockActive={wakeLockActive}
          toggleWakeLock={toggleWakeLock}
          connectionStatuses={connectionStatuses}
          connectionDebugInfo={connectionDebugInfo}
          onBack={() => {
            setGameId(null)
            setGameIdInput('')
            setError('')
          }}
          backLabel={t('common.back')}
        />
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px',
          gap: '24px'
        }}>
          {/* Match Ended Banner */}
          <div style={{
            fontSize: '18px',
            fontWeight: 500,
            color: 'rgba(255, 255, 255, 0.7)',
            textTransform: 'uppercase',
            letterSpacing: '2px'
          }}>
            {t('livescore.matchEnded')}
          </div>

          {/* Winner and Result */}
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontSize: '32px',
              fontWeight: 700,
              marginBottom: '8px'
            }}>
              {matchWinner}
            </div>
            <div style={{
              fontSize: '48px',
              fontWeight: 800,
              color: 'var(--accent)'
            }}>
              {matchResult}
            </div>
          </div>

          {/* Results Table */}
          <div style={{
            width: '100%',
            maxWidth: '500px',
            background: 'white',
            borderRadius: '12px',
            overflow: 'hidden'
          }}>
            <Results
              teamAShortName={teamAShortName}
              teamBShortName={teamBShortName}
              setResults={calculateSetResults}
              winner={matchWinner}
              result={matchResult}
            />
          </div>

          <button
            onClick={() => {
              setGameId(null)
              setGameIdInput('')
              setError('')
            }}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: '#fff',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'background 0.2s',
              marginTop: '16px'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
            }}
          >
            {t('livescore.backToGames')}
          </button>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <SimpleHeader
          title={t('livescore.title')}
          wakeLockActive={wakeLockActive}
          toggleWakeLock={toggleWakeLock}
          connectionStatuses={connectionStatuses}
          connectionDebugInfo={connectionDebugInfo}
        />
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}>
          <div style={{
            textAlign: 'center',
            fontSize: '18px'
          }}>
            {t('common.loading')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      <SimpleHeader
        title={t('livescore.title')}
        subtitle={t('livescore.game', { number: gameId })}
        wakeLockActive={wakeLockActive}
        toggleWakeLock={toggleWakeLock}
        connectionStatuses={connectionStatuses}
        connectionDebugInfo={connectionDebugInfo}
        connectionMode={connectionMode}
        activeConnection={activeConnection}
        onConnectionModeChange={handleConnectionModeChange}
        showConnectionOptions={true}
        onBack={() => {
          setGameId(null)
          setGameIdInput('')
          setError('')
        }}
        backLabel={t('livescore.changeGame')}
        rightContent={
          <button
            onClick={() => setSidesSwitched(!sidesSwitched)}
            style={{
              padding: '4px 10px',
              fontSize: 'clamp(10px, 1.2vw, 12px)',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: '#fff',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'background 0.2s',
              whiteSpace: 'nowrap'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
            }}
          >
            {t('livescore.switchSides')}
          </button>
        }
      />


      {/* Score Counter */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(40px, 10vh, 100px) 20px',
        width: '100%',
        position: 'relative',
        gap: 'clamp(10px, 3vw, 20px)'
      }}>
        {/* Left Team Score */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
          position: 'relative',
          padding: '0 clamp(10px, 3vw, 20px) 0 clamp(24px, 6vw, 44px)',
          flex: '0 1 auto',
          minWidth: 0
        }}>
          {leftIsServing && (
            <img
              src={mikasaVolleyball}
              alt={t('livescore.servingTeam')}
              style={{
                width: 'clamp(40px, 10vw, 80px)',
                height: 'clamp(40px, 10vw, 80px)',
                position: 'absolute',
                left: 'clamp(-30px, -7vw, -50px)',
                top: '50%',
                transform: 'translateY(-50%)',
                filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))',
                marginRight: '20px'
              }}
            />
          )}
          <div style={{
            fontSize: 'clamp(60px, 25vw, 200px)',
            fontWeight: 700,
            color: '#fff',
            lineHeight: '1',
            textAlign: 'center'
          }}>
            {currentScore.left}
          </div>
          <div style={{
            fontSize: 'clamp(12px, 3vw, 20px)',
            fontWeight: 600,
            color: 'rgba(255, 255, 255, 0.7)',
            textTransform: 'uppercase'
          }}>
            {leftTeam.name}
          </div>
        </div>

        {/* Separator - Always Centered */}
        <div style={{
          fontSize: 'clamp(60px, 25vw, 200px)',
          fontWeight: 700,
          color: 'rgba(255, 255, 255, 0.5)',
          flexShrink: 0,
          width: '10px',
          textAlign: 'center',
          lineHeight: '1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          :
        </div>

        {/* Right Team Score */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
          position: 'relative',
          padding: '0 clamp(24px, 6vw, 44px) 0 clamp(10px, 3vw, 20px)',
          flex: '0 1 auto',
          minWidth: 0
        }}>
          {rightIsServing && (
            <img
              src={mikasaVolleyball}
              alt={t('livescore.servingTeam')}
              style={{
                width: 'clamp(40px, 10vw, 80px)',
                height: 'clamp(40px, 10vw, 80px)',
                position: 'absolute',
                right: 'clamp(-30px, -7vw, -50px)',
                top: '50%',
                transform: 'translateY(-50%)',
                filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))',
                marginLeft: '20px'
              }}
            />
          )}
          <div style={{
            fontSize: 'clamp(60px, 25vw, 200px)',
            fontWeight: 700,
            color: '#fff',
            lineHeight: '1',
            textAlign: 'center'
          }}>
            {currentScore.right}
          </div>
          <div style={{
            fontSize: 'clamp(12px, 3vw, 20px)',
            fontWeight: 600,
            color: 'rgba(255, 255, 255, 0.7)',
            textTransform: 'uppercase'
          }}>
            {rightTeam.name}
          </div>
        </div>
      </div>

      {/* Set Score and Set Number */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(10px, 3vh, 20px)',
        gap: 'clamp(12px, 4vw, 24px)'
      }}>
        <div style={{
          padding: 'clamp(4px, 1vw, 6px) clamp(8px, 2vw, 12px)',
          borderRadius: '6px',
          fontSize: 'clamp(40px, 12vw, 100px)',
          fontWeight: 700,
          background: 'rgba(255, 255, 255, 0.1)',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          color: 'var(--text)',
          textAlign: 'center',
          lineHeight: '1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          {setScore.left}
        </div>
        
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <span style={{
            fontSize: 'clamp(40px, 12vw, 100px)',
            fontWeight: 800,
            color: 'var(--text)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            gap: '10px',
            lineHeight: '1'
          }}>
            {t('livescore.set')}
          </span>
          <span style={{
              fontSize: 'clamp(40px, 12vw, 100px)',
              fontWeight: 800,
              color: 'var(--text)',
              lineHeight: '1'
            }}>
              {currentSetIndex}
            </span>
        </div>

        <div style={{
          padding: 'clamp(4px, 1vw, 6px) clamp(8px, 2vw, 12px)',
          borderRadius: '6px',
          fontSize: 'clamp(40px, 12vw, 100px)',
          fontWeight: 700,
          background: 'rgba(255, 255, 255, 0.1)',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          color: 'var(--text)',
          textAlign: 'center',
          lineHeight: '1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          {setScore.right}
        </div>
      </div>

      {/* Test Mode Controls - only shown in test mode */}
      {(data?.match?.id === -1 || data?.match?.test === true) && (
        <TestModeControls
          matchId={data?.match?.id}
          onRefresh={() => {
            // Trigger a data refresh by re-fetching
            if (gameId) {
              getMatchData(gameId).then(result => {
                if (result.success) {
                  const currentSet = (result.sets || []).find(s => !s.finished) ||
                                   (result.sets || []).sort((a, b) => b.index - a.index)[0]
                  setData({
                    match: result.match,
                    homeTeam: result.homeTeam,
                    awayTeam: result.awayTeam,
                    homePlayers: result.homePlayers || [],
                    awayPlayers: result.awayPlayers || [],
                    sets: result.sets || [],
                    events: result.events || [],
                    set: currentSet
                  })
                }
              })
            }
          }}
        />
      )}
    </div>
  )
}
