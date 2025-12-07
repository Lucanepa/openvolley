import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import MatchSetup from './components/MatchSetup'
import Scoreboard from './components/Scoreboard'
import MatchEnd from './components/MatchEnd'
import Modal from './components/Modal'
import GuideModal from './components/GuideModal'
import ConnectionStatus from './components/ConnectionStatus'
import { useSyncQueue } from './hooks/useSyncQueue'
import mikasaVolleyball from './mikasa_v200w.png'
import favicon from './favicon.png'
import {
  TEST_REFEREE_SEED_DATA,
  TEST_SCORER_SEED_DATA,
  TEST_TEAM_SEED_DATA
} from './constants/testSeeds'
import { supabase } from './lib/supabaseClient'
import { checkMatchSession, lockMatchSession, unlockMatchSession, verifyGamePin } from './utils/sessionManager'

const TEST_MATCH_SEED_KEY = 'test-match-default'
const TEST_MATCH_EXTERNAL_ID = 'test-match-default'
const TEST_HOME_TEAM_EXTERNAL_ID = 'test-team-alpha'
const TEST_AWAY_TEAM_EXTERNAL_ID = 'test-team-bravo'
const TEST_MATCH_DEFAULTS = {
  hall: 'Kantonsschule Wiedikon (Halle A)',
  city: 'Zürich',
  league: '3L B',
  gameNumber: '123456'
}

const TEST_HOME_BENCH = [
  { role: 'Coach', firstName: 'Marco', lastName: 'Frei', dob: '15/05/1975' },
  { role: 'Assistant Coach 1', firstName: 'Jan', lastName: 'Widmer', dob: '21/09/1980' },
  { role: 'Physiotherapist', firstName: 'Eva', lastName: 'Gerber', dob: '03/12/1985' }
]

const TEST_AWAY_BENCH = [
  { role: 'Coach', firstName: 'Stefan', lastName: 'Keller', dob: '08/02/1976' },
  { role: 'Assistant Coach 1', firstName: 'Lars', lastName: 'Brunner', dob: '27/07/1981' },
  { role: 'Physiotherapist', firstName: 'Mia', lastName: 'Schmid', dob: '14/04/1987' }
]

function getNextTestMatchStartTime() {
  const now = new Date()
  const kickoff = new Date(now)
  kickoff.setHours(20, 0, 0, 0)
  if (kickoff <= now) {
    kickoff.setDate(kickoff.getDate() + 1)
  }
  return kickoff.toISOString()
}

function parseDateTime(dateTime) {
  const [datePart, timePart] = dateTime.split(' ')
  const [day, month, year] = datePart.split('.').map(Number)
  const [hours, minutes] = timePart.split(':').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hours, minutes))
  return date.toISOString()
}

function generateRefereePin() {
  const chars = '0123456789'
  let pin = ''
  for (let i = 0; i < 6; i++) {
    pin += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return pin
}

export default function App() {
  const [matchId, setMatchId] = useState(null)
  const [showMatchSetup, setShowMatchSetup] = useState(false)
  const [showCoinToss, setShowCoinToss] = useState(false)
  const [showMatchEnd, setShowMatchEnd] = useState(false)
  const [deleteMatchModal, setDeleteMatchModal] = useState(null)
  const [newMatchModal, setNewMatchModal] = useState(null)
  const [testMatchLoading, setTestMatchLoading] = useState(false)
  const [alertModal, setAlertModal] = useState(null) // { message: string }
  const [confirmModal, setConfirmModal] = useState(null) // { message: string, onConfirm: function, onCancel: function }
  const [homeCardModal, setHomeCardModal] = useState(null) // 'official' | 'test' | null
  const [homeOptionsModal, setHomeOptionsModal] = useState(false)
  const [homeGuideModal, setHomeGuideModal] = useState(false)
  const [manageCaptainOnCourt, setManageCaptainOnCourt] = useState(() => {
    // Load from localStorage
    const saved = localStorage.getItem('manageCaptainOnCourt')
    return saved === 'true'
  })
  const { syncStatus, isOnline } = useSyncQueue()
  const canUseSupabase = Boolean(supabase)
  const [serverStatus, setServerStatus] = useState(null)
  const [showConnectionMenu, setShowConnectionMenu] = useState(false)
  const [connectionStatuses, setConnectionStatuses] = useState({
    api: 'unknown',
    server: 'unknown',
    websocket: 'unknown',
    scoreboard: 'unknown',
    match: 'unknown',
    db: 'unknown',
    supabase: 'unknown'
  })
  const [connectionDebugInfo, setConnectionDebugInfo] = useState({})
  const [showDebugMenu, setShowDebugMenu] = useState(null) // Which connection type to show debug for
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Fetch server status periodically
  useEffect(() => {
    const fetchServerStatus = async () => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'https' : 'http'
        const hostname = window.location.hostname
        const port = window.location.port || (protocol === 'https' ? '443' : '5173')
        const response = await fetch(`${protocol}://${hostname}:${port}/api/server/status`)
        if (response.ok) {
          const status = await response.json()
          setServerStatus(status)
        }
      } catch (err) {
        // Server might not be running, that's okay
        console.log('[App] Server status not available:', err.message)
      }
    }
    
    fetchServerStatus()
    const interval = setInterval(fetchServerStatus, 10000) // Check every 10 seconds
    return () => clearInterval(interval)
  }, [])

  const activeMatch = useLiveQuery(async () => {
    try {
      return await db.matches
        .where('status')
        .equals('live')
        .first()
    } catch (error) {
      console.error('Unable to load active match', error)
      return null
    }
  }, [])

  // Get current match (most recent match that's not final)
  const currentMatch = useLiveQuery(async () => {
    try {
      // First try to get a live match
      const liveMatch = await db.matches.where('status').equals('live').first()
      if (liveMatch) return liveMatch

      // Otherwise get the most recent match that's not final
      const matches = await db.matches.orderBy('createdAt').reverse().toArray()
      const nonFinalMatch = matches.find(m => m.status !== 'final')
      return nonFinalMatch || null
    } catch (error) {
      console.error('Unable to load current match', error)
      return null
    }
  }, [])

  const currentOfficialMatch = useLiveQuery(async () => {
    try {
      const matches = await db.matches.orderBy('createdAt').reverse().toArray()
      return matches.find(m => m.test !== true && m.status !== 'final') || null
    } catch (error) {
      console.error('Unable to load official match', error)
      return null
    }
  }, [])

  // Fullscreen functionality
  const toggleFullscreen = useCallback(async () => {
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
  }, [])

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

  // Check connection statuses
  const checkConnectionStatuses = useCallback(async () => {
    const statuses = {
      api: 'unknown',
      server: 'unknown',
      websocket: 'unknown',
      scoreboard: 'unknown',
      match: 'unknown',
      db: 'unknown',
      supabase: 'unknown'
    }
    const debugInfo = {}
    
    // Check API/Server connection
    try {
      const response = await fetch('/api/match/list')
      if (response.ok) {
        statuses.api = 'connected'
        statuses.server = 'connected'
        debugInfo.api = { status: 'connected', message: 'API endpoint responding' }
        debugInfo.server = { status: 'connected', message: 'Server is reachable' }
      } else {
        statuses.api = 'disconnected'
        statuses.server = 'disconnected'
        debugInfo.api = { status: 'disconnected', message: `API returned status ${response.status}: ${response.statusText}` }
        debugInfo.server = { status: 'disconnected', message: `Server returned status ${response.status}: ${response.statusText}` }
      }
    } catch (err) {
      statuses.api = 'disconnected'
      statuses.server = 'disconnected'
      debugInfo.api = { status: 'disconnected', message: `Network error: ${err.message || 'Failed to connect to API'}` }
      debugInfo.server = { status: 'disconnected', message: `Network error: ${err.message || 'Failed to connect to server'}` }
    }
    
    // Check WebSocket server availability
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const hostname = window.location.hostname
      const wsPort = serverStatus?.wsPort || 8080
      const wsUrl = `${protocol}://${hostname}:${wsPort}`
      
      const wsTest = new WebSocket(wsUrl)
      let resolved = false
      let errorMessage = ''
      
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
        }, 2000)
        
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
        
        wsTest.onerror = (error) => {
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
            resolve()
          }
        }
        
        wsTest.onclose = (event) => {
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
    if (currentOfficialMatch) {
      statuses.match = currentOfficialMatch.status === 'live' ? 'live' : currentOfficialMatch.status === 'scheduled' ? 'scheduled' : currentOfficialMatch.status === 'final' ? 'final' : 'unknown'
      debugInfo.match = { status: statuses.match, message: `Match status: ${statuses.match}` }
    } else {
      statuses.match = 'no_match'
      debugInfo.match = { status: 'no_match', message: 'No official match found. Create a new match to start.' }
    }
    
    // Check DB (IndexedDB)
    try {
      await db.matches.count()
      statuses.db = 'connected'
      debugInfo.db = { status: 'connected', message: 'IndexedDB is accessible' }
    } catch (err) {
      statuses.db = 'disconnected'
      debugInfo.db = { status: 'disconnected', message: `IndexedDB error: ${err.message || 'Database not accessible'}` }
    }
    
    // Check Supabase status (based on syncStatus and canUseSupabase)
    // First check if Supabase is configured at all
    if (!canUseSupabase) {
      statuses.supabase = 'not_configured'
      const envUrl = import.meta.env.VITE_SUPABASE_URL
      const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      debugInfo.supabase = { 
        status: 'not_configured', 
        message: 'Supabase is not configured',
        details: `Environment variables missing: ${!envUrl ? 'VITE_SUPABASE_URL' : ''}${!envUrl && !envKey ? ' and ' : ''}${!envKey ? 'VITE_SUPABASE_ANON_KEY' : ''}. Set these in your .env file to enable Supabase sync.`
      }
    } else if (syncStatus === 'synced' || syncStatus === 'syncing') {
      statuses.supabase = 'connected'
      debugInfo.supabase = { status: 'connected', message: 'Supabase is connected and syncing' }
    } else if (syncStatus === 'online_no_supabase') {
      // This shouldn't happen if canUseSupabase is true, but handle it anyway
      statuses.supabase = 'not_configured'
      debugInfo.supabase = { 
        status: 'not_configured', 
        message: 'Supabase client not initialized',
        details: 'Supabase environment variables may be set but client failed to initialize. Check your .env file.'
      }
    } else if (syncStatus === 'connecting') {
      statuses.supabase = 'connecting'
      debugInfo.supabase = { status: 'connecting', message: 'Connecting to Supabase...' }
    } else if (syncStatus === 'error') {
      statuses.supabase = 'error'
      debugInfo.supabase = { 
        status: 'error', 
        message: 'Supabase connection error',
        details: 'Check your Supabase credentials and network connection'
      }
    } else if (syncStatus === 'offline') {
      statuses.supabase = 'offline'
      debugInfo.supabase = { status: 'offline', message: 'Device is offline or Supabase is unreachable' }
    } else {
      statuses.supabase = 'unknown'
      debugInfo.supabase = { status: 'unknown', message: 'Supabase status unknown' }
    }
    
    setConnectionStatuses(statuses)
    setConnectionDebugInfo(debugInfo)
  }, [currentOfficialMatch, syncStatus, serverStatus])

  // Periodically check connection statuses
  useEffect(() => {
    checkConnectionStatuses()
    const interval = setInterval(checkConnectionStatuses, 5000) // Check every 5 seconds
    return () => clearInterval(interval)
  }, [checkConnectionStatuses])

  const currentTestMatch = useLiveQuery(async () => {
    try {
      const matches = await db.matches.orderBy('createdAt').reverse().toArray()
      const testMatch = matches.find(m => m.test === true && m.status !== 'final')
      // Return test match if it exists, regardless of setup status
      return testMatch || null
    } catch (error) {
      console.error('Unable to load test match', error)
      return null
    }
  }, [])

  // Get match status and details
  const matchStatus = useLiveQuery(async () => {
    if (!currentMatch) return null

    // For test matches that have been restarted (no signatures, only initial set, no events), don't show status
    if (currentMatch.test === true) {
      const hasSignatures = currentMatch.homeCoachSignature || 
                           currentMatch.homeCaptainSignature || 
                           currentMatch.awayCoachSignature || 
                           currentMatch.awayCaptainSignature
      
      if (!hasSignatures) {
        const sets = await db.sets.where('matchId').equals(currentMatch.id).toArray()
        const events = await db.events.where('matchId').equals(currentMatch.id).toArray()
        // If only initial set exists and no events, it's been restarted - don't show status
        if (sets.length === 1 && events.length === 0) {
          return null
        }
      }
    }

    const homeTeamPromise = currentMatch.homeTeamId ? db.teams.get(currentMatch.homeTeamId) : Promise.resolve(null)
    const awayTeamPromise = currentMatch.awayTeamId ? db.teams.get(currentMatch.awayTeamId) : Promise.resolve(null)

    const setsPromise = db.sets.where('matchId').equals(currentMatch.id).toArray()
    const eventsPromise = db.events.where('matchId').equals(currentMatch.id).toArray()
    const homePlayersPromise = currentMatch.homeTeamId
      ? db.players.where('teamId').equals(currentMatch.homeTeamId).count()
      : Promise.resolve(0)
    const awayPlayersPromise = currentMatch.awayTeamId
      ? db.players.where('teamId').equals(currentMatch.awayTeamId).count()
      : Promise.resolve(0)

    const [homeTeam, awayTeam, sets, events, homePlayers, awayPlayers] = await Promise.all([
      homeTeamPromise,
      awayTeamPromise,
      setsPromise,
      eventsPromise,
      homePlayersPromise,
      awayPlayersPromise
    ])

    const signaturesComplete = Boolean(
      currentMatch.homeCoachSignature &&
      currentMatch.homeCaptainSignature &&
      currentMatch.awayCoachSignature &&
      currentMatch.awayCaptainSignature
    )

    const infoConfigured = Boolean(
      (currentMatch.scheduledAt && String(currentMatch.scheduledAt).trim() !== '') ||
      (currentMatch.city && String(currentMatch.city).trim() !== '') ||
      (currentMatch.hall && String(currentMatch.hall).trim() !== '') ||
      (currentMatch.league && String(currentMatch.league).trim() !== '')
    )

    const rostersReady = homePlayers >= 6 && awayPlayers >= 6
    const matchReadyForPlay = infoConfigured && signaturesComplete && rostersReady

    const hasActiveSet = sets.some(set => {
      return Boolean(
        set.finished ||
        set.startTime ||
        set.homePoints > 0 ||
        set.awayPoints > 0
      )
    })

    const hasEventActivity = events.some(event =>
      ['set_start', 'rally_start', 'point'].includes(event.type)
    )

    let status = 'No data'
    if (currentMatch.status === 'final' || (sets.length > 0 && sets.every(s => s.finished))) {
      status = 'Match ended'
    } else if ((currentMatch.status === 'live' || hasActiveSet || hasEventActivity) && matchReadyForPlay) {
      status = 'Match recording'
    } else if (homePlayers > 0 || awayPlayers > 0 || currentMatch.homeCoachSignature || currentMatch.awayCoachSignature) {
      if (signaturesComplete) {
        status = 'Coin toss'
      } else {
        status = 'Setup'
      }
    }

    return {
      match: currentMatch,
      homeTeam,
      awayTeam,
      status
    }
  }, [currentMatch])

  const restoredRef = useRef(false)

  // Preload volleyball image when app loads
  useEffect(() => {
    // Preload the image
    const img = new Image()
    img.src = mikasaVolleyball
    
    // Also add a preload link to the document head for early loading
    const link = document.createElement('link')
    link.rel = 'preload'
    link.as = 'image'
    link.href = mikasaVolleyball
    document.head.appendChild(link)
    
    return () => {
      // Cleanup: remove preload link if component unmounts
      const existingLink = document.querySelector(`link[href="${mikasaVolleyball}"]`)
      if (existingLink) {
        document.head.removeChild(existingLink)
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const disableRefreshKeys = event => {
      const key = event.key?.toLowerCase?.()
      const isRefresh =
        key === 'f5' ||
        ((event.ctrlKey || event.metaKey) && key === 'r') ||
        ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'r') || // Ctrl+Shift+R
        (event.shiftKey && key === 'f5')

      if (isRefresh) {
        event.preventDefault()
        event.stopPropagation()
        return false
      }
    }

    const disableBackspaceNavigation = event => {
      // Prevent backspace from navigating back (but allow it in input fields)
      if (event.key === 'Backspace' || event.keyCode === 8) {
        const target = event.target || event.srcElement
        const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
        if (!isInput) {
          event.preventDefault()
          return false
        }
      }
    }

    const blockHistoryNavigation = event => {
      // Push a new state to prevent back/forward navigation
      history.pushState(null, '', window.location.href)
    }

    // Push initial state to prevent back navigation
    try {
      history.pushState(null, '', window.location.href)
    } catch (err) {
      // Ignore history errors (e.g., older browsers or restricted environments)
    }

    // Prevent browser back/forward buttons
    window.addEventListener('popstate', blockHistoryNavigation)
    
    // Prevent refresh keyboard shortcuts
    window.addEventListener('keydown', disableRefreshKeys, { passive: false })
    
    // Prevent backspace navigation (except in input fields)
    window.addEventListener('keydown', disableBackspaceNavigation, { passive: false })

    // Also prevent context menu refresh option (right-click refresh)
    window.addEventListener('contextmenu', event => {
      // Allow context menu but we can't prevent refresh from it directly
      // The keydown handler will catch Ctrl+R if user tries that
    })

    return () => {
      window.removeEventListener('keydown', disableRefreshKeys)
      window.removeEventListener('keydown', disableBackspaceNavigation)
      window.removeEventListener('popstate', blockHistoryNavigation)
    }
  }, [])


  useEffect(() => {
    if (activeMatch) {
      if (!restoredRef.current && !matchId) {
        setMatchId(activeMatch.id)
        restoredRef.current = true
      }
    } else {
      restoredRef.current = false
    }
  }, [activeMatch, matchId])

  // Check for pending roster upload on mount
  useEffect(() => {
    if (!currentMatch) return

    // Check if there are pending rosters
    const hasPendingHomeRoster = currentMatch.pendingHomeRoster !== null && currentMatch.pendingHomeRoster !== undefined
    const hasPendingAwayRoster = currentMatch.pendingAwayRoster !== null && currentMatch.pendingAwayRoster !== undefined

    // If there are pending rosters and we're not already in match setup, open it
    if ((hasPendingHomeRoster || hasPendingAwayRoster) && !showMatchSetup) {
      setMatchId(currentMatch.id)
      setShowMatchSetup(true)
    }
  }, [currentMatch, matchId, showMatchSetup])

  // Update document title based on match type
  useEffect(() => {
    if (!currentMatch) {
      document.title = 'Openvolley eScoresheet'
      return
    }

    const isTestMatch = currentMatch.test === true

    if (isTestMatch) {
      // Test matches don't have a game number - just show base title
      document.title = 'Openvolley eScoresheet'
    } else {
      // Official match - show game number only
      const gameNumber = currentMatch.externalId || 'Official Match'
      document.title = `Openvolley eScoresheet - ${gameNumber}`
    }
  }, [currentMatch])

  // Connect to WebSocket server and sync match data (works from any view)
  // Use refs to prevent unnecessary reconnections
  const wsRef = useRef(null)
  const syncIntervalRef = useRef(null)
  const reconnectTimeoutRef = useRef(null)
  const currentMatchIdRef = useRef(null)
  const currentMatchRef = useRef(null)
  const isIntentionallyClosedRef = useRef(false)

  // Update currentMatch ref whenever it changes
  useEffect(() => {
    currentMatchRef.current = currentMatch
  }, [currentMatch])

  useEffect(() => {
    const activeMatchId = matchId || currentMatch?.id
    if (!activeMatchId || !currentMatch) {
      // Clean up if we had a connection for a different match
      if (wsRef.current) {
        isIntentionallyClosedRef.current = true
        wsRef.current.close()
        wsRef.current = null
      }
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
        syncIntervalRef.current = null
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      currentMatchIdRef.current = null
      return
    }

    // Only reconnect if matchId actually changed
    if (currentMatchIdRef.current === activeMatchId && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.log('[App WebSocket] Already connected for matchId:', activeMatchId)
      return
    }

    // If matchId changed, close old connection and clear old match from server
    if (currentMatchIdRef.current !== activeMatchId && currentMatchIdRef.current && wsRef.current) {
      const oldMatchId = currentMatchIdRef.current
      console.log('[App WebSocket] Match ID changed, closing old connection and clearing old match:', oldMatchId)
      
      // Clear old match from server
      if (wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({
            type: 'delete-match',
            matchId: String(oldMatchId)
          }))
          console.log('[App WebSocket] Deleted old match from server:', oldMatchId)
        } catch (err) {
          console.error('[App WebSocket] Error deleting old match:', err)
        }
      }
      
      isIntentionallyClosedRef.current = true
      wsRef.current.close()
      wsRef.current = null
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
        syncIntervalRef.current = null
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
    }
    
    // If no active match, clear all matches from server (scoreboard is source of truth)
    if (!activeMatchId) {
      const clearAllMatches = () => {
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'clear-all-matches'
            }))
            console.log('[App WebSocket] Cleared all matches from server (no active match)')
          } catch (err) {
            console.error('[App WebSocket] Error clearing all matches:', err)
          }
        }
      }
      
      // Try to clear immediately if WebSocket is open
      clearAllMatches()
      
      // Also set up a connection to clear when WebSocket opens
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const hostname = window.location.hostname
      const wsPort = serverStatus?.wsPort || 8080
      const wsUrl = `${protocol}://${hostname}:${wsPort}`
      
      const tempWs = new WebSocket(wsUrl)
      tempWs.onopen = () => {
        tempWs.send(JSON.stringify({ type: 'clear-all-matches' }))
        tempWs.close()
      }
      tempWs.onerror = () => {
        // Ignore - server might not be running
      }
      
      return () => {
        if (tempWs.readyState === WebSocket.OPEN || tempWs.readyState === WebSocket.CONNECTING) {
          tempWs.close()
        }
      }
    }

    currentMatchIdRef.current = activeMatchId
    isIntentionallyClosedRef.current = false

    const connectWebSocket = async () => {
      // Don't reconnect if intentionally closed or matchId changed
      if (isIntentionallyClosedRef.current || currentMatchIdRef.current !== activeMatchId) {
        return
      }

      // Close existing connection if any
      if (wsRef.current) {
        const oldWs = wsRef.current
        const oldState = oldWs.readyState
        
        // Remove all handlers first to prevent error logs
        try {
          oldWs.onerror = null
          oldWs.onclose = null
          oldWs.onopen = null
          oldWs.onmessage = null
        } catch (err) {
          // Ignore if handlers can't be set
        }
        
        // Only try to close if not already closed/closing
        if (oldState === WebSocket.OPEN) {
          try {
            oldWs.close(1000, 'Reconnecting')
          } catch (err) {
            // Ignore errors when closing
          }
        } else if (oldState === WebSocket.CONNECTING) {
          // For connecting state, just null the ref - let it fail naturally
          // Don't try to close as it causes browser errors
        }
        wsRef.current = null
      }

      try {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
        const hostname = window.location.hostname
        let wsPort = 8080
        if (serverStatus?.wsPort) {
          wsPort = serverStatus.wsPort
        }
        const wsUrl = `${protocol}://${hostname}:${wsPort}`

        wsRef.current = new WebSocket(wsUrl)
        
        // Set error handler first to catch any immediate errors
        wsRef.current.onerror = () => {
          // Suppress - browser will show native errors if needed
        }

        wsRef.current.onopen = () => {
          // Verify we're still on the same match
          if (isIntentionallyClosedRef.current || currentMatchIdRef.current !== activeMatchId) {
            if (wsRef.current) {
              wsRef.current.close()
            }
            return
          }
          
          // Clear all other matches first (scoreboard is source of truth - only current match should exist)
          try {
            wsRef.current.send(JSON.stringify({
              type: 'clear-all-matches',
              keepMatchId: String(activeMatchId) // Keep only the current match
            }))
            console.log('[App WebSocket] Cleared all matches except current match:', activeMatchId)
          } catch (err) {
            console.error('[App WebSocket] Error clearing other matches:', err)
          }
          
          syncMatchData()
          syncIntervalRef.current = setInterval(syncMatchData, 5000)
        }

        wsRef.current.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data)
            
            if (message.type === 'pin-validation-request') {
              handlePinValidationRequest(message)
            } else if (message.type === 'match-data-request') {
              handleMatchDataRequest(message)
            } else if (message.type === 'game-number-request') {
              handleGameNumberRequest(message)
            } else if (message.type === 'match-update-request') {
              handleMatchUpdateRequest(message)
            }
          } catch (err) {
            console.error('[App WebSocket] Error parsing message:', err)
          }
        }

        wsRef.current.onclose = (event) => {
          // Don't reconnect if intentionally closed or matchId changed
          if (isIntentionallyClosedRef.current || currentMatchIdRef.current !== activeMatchId) {
            return
          }

          // Don't reconnect on normal closure
          if (event.code === 1000) {
            return
          }

          if (syncIntervalRef.current) {
            clearInterval(syncIntervalRef.current)
            syncIntervalRef.current = null
          }

          // Reconnect after 5 seconds
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, 5000)
        }
      } catch (err) {
        console.error('[App WebSocket] Connection error:', err)
        if (!isIntentionallyClosedRef.current && currentMatchIdRef.current === activeMatchId) {
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, 5000)
        }
      }
    }

    const syncMatchData = async () => {
      // Use current values from refs
      const ws = wsRef.current
      const currentActiveMatchId = currentMatchIdRef.current
      const currentMatchData = currentMatchRef.current // Use ref to get latest value

      if (!ws || ws.readyState !== WebSocket.OPEN || !currentMatchData || currentActiveMatchId !== (matchId || currentMatchData?.id)) {
        return
      }

      try {
        // Load full match data
        const [homeTeam, awayTeam, sets, events, homePlayers, awayPlayers] = await Promise.all([
          currentMatchData.homeTeamId ? db.teams.get(currentMatchData.homeTeamId) : null,
          currentMatchData.awayTeamId ? db.teams.get(currentMatchData.awayTeamId) : null,
          db.sets.where('matchId').equals(currentActiveMatchId).sortBy('index'),
          db.events.where('matchId').equals(currentActiveMatchId).toArray(),
          currentMatchData.homeTeamId ? db.players.where('teamId').equals(currentMatchData.homeTeamId).sortBy('number') : [],
          currentMatchData.awayTeamId ? db.players.where('teamId').equals(currentMatchData.awayTeamId).sortBy('number') : []
        ])

        // Prepare full match object - scoreboard is source of truth, always overwrite
        const fullMatch = {
          ...currentMatchData,
          id: currentMatchData.id,
          // Ensure all fields are included for complete overwrite
          refereePin: currentMatchData.refereePin,
          homeTeamPin: currentMatchData.homeTeamPin,
          awayTeamPin: currentMatchData.awayTeamPin,
          refereeConnectionEnabled: currentMatchData.refereeConnectionEnabled,
          homeTeamConnectionEnabled: currentMatchData.homeTeamConnectionEnabled,
          awayTeamConnectionEnabled: currentMatchData.awayTeamConnectionEnabled,
          status: currentMatchData.status,
          gameNumber: currentMatchData.gameNumber,
          game_n: currentMatchData.game_n,
          externalId: currentMatchData.externalId,
          scheduledAt: currentMatchData.scheduledAt
        }
        
        // Sync full match data to server - this ALWAYS overwrites existing data (scoreboard is source of truth)
        const syncPayload = {
          type: 'sync-match-data',
          matchId: currentActiveMatchId,
          match: fullMatch,
          homeTeam,
          awayTeam,
          homePlayers,
          awayPlayers,
          sets,
          events
        }
        
        console.log('[App WebSocket] Syncing match data (overwriting server):', {
          matchId: currentActiveMatchId,
          status: fullMatch.status,
          gameNumber: fullMatch.gameNumber || fullMatch.game_n || fullMatch.externalId
        })
        
        ws.send(JSON.stringify(syncPayload))
      } catch (err) {
        console.error('[App WebSocket] Error syncing match data:', err)
      }
    }

    const handlePinValidationRequest = async (request) => {
      const ws = wsRef.current
      const currentActiveMatchId = currentMatchIdRef.current
      const currentMatchData = currentMatchRef.current // Use ref to get latest value

      if (!ws || ws.readyState !== WebSocket.OPEN || !currentMatchData) return

      try {
        const { pin, pinType, requestId } = request
        const pinStr = String(pin).trim()

        let matchPin = null
        let connectionEnabled = false

        if (pinType === 'referee') {
          matchPin = currentMatchData.refereePin
          connectionEnabled = currentMatchData.refereeConnectionEnabled !== false
        } else if (pinType === 'homeTeam') {
          matchPin = currentMatchData.homeTeamPin
          connectionEnabled = currentMatchData.homeTeamConnectionEnabled !== false
        } else if (pinType === 'awayTeam') {
          matchPin = currentMatchData.awayTeamPin
          connectionEnabled = currentMatchData.awayTeamConnectionEnabled !== false
        }

        if (matchPin && String(matchPin).trim() === pinStr && connectionEnabled && currentMatchData.status !== 'final') {
          // Load full data for response
          const [homeTeam, awayTeam, sets, events, homePlayers, awayPlayers] = await Promise.all([
            currentMatchData.homeTeamId ? db.teams.get(currentMatchData.homeTeamId) : null,
            currentMatchData.awayTeamId ? db.teams.get(currentMatchData.awayTeamId) : null,
            db.sets.where('matchId').equals(currentActiveMatchId).sortBy('index'),
            db.events.where('matchId').equals(currentActiveMatchId).toArray(),
            currentMatchData.homeTeamId ? db.players.where('teamId').equals(currentMatchData.homeTeamId).sortBy('number') : [],
            currentMatchData.awayTeamId ? db.players.where('teamId').equals(currentMatchData.awayTeamId).sortBy('number') : []
          ])

          ws.send(JSON.stringify({
            type: 'pin-validation-response',
            requestId,
            success: true,
            match: currentMatchData,
            fullData: {
              match: currentMatchData,
              homeTeam,
              awayTeam,
              homePlayers,
              awayPlayers,
              sets,
              events
            }
          }))
        } else {
          ws.send(JSON.stringify({
            type: 'pin-validation-response',
            requestId,
            success: false,
            error: connectionEnabled === false ? 'Connection is disabled' : 'Invalid PIN code'
          }))
        }
      } catch (err) {
        console.error('[App WebSocket] Error handling PIN validation:', err)
      }
    }

    const handleMatchDataRequest = async (request) => {
      const ws = wsRef.current
      const currentActiveMatchId = currentMatchIdRef.current
      const currentMatchData = currentMatchRef.current // Use ref to get latest value

      if (!ws || ws.readyState !== WebSocket.OPEN || !currentMatchData) return

      try {
        const { requestId, matchId: requestedMatchId } = request
        
        if (String(requestedMatchId) !== String(currentActiveMatchId)) {
          ws.send(JSON.stringify({
            type: 'match-data-response',
            requestId,
            success: false,
            error: 'Match ID mismatch'
          }))
          return
        }

        const [homeTeam, awayTeam, sets, events, homePlayers, awayPlayers] = await Promise.all([
          currentMatchData.homeTeamId ? db.teams.get(currentMatchData.homeTeamId) : null,
          currentMatchData.awayTeamId ? db.teams.get(currentMatchData.awayTeamId) : null,
          db.sets.where('matchId').equals(currentActiveMatchId).sortBy('index'),
          db.events.where('matchId').equals(currentActiveMatchId).toArray(),
          currentMatchData.homeTeamId ? db.players.where('teamId').equals(currentMatchData.homeTeamId).sortBy('number') : [],
          currentMatchData.awayTeamId ? db.players.where('teamId').equals(currentMatchData.awayTeamId).sortBy('number') : []
        ])

        ws.send(JSON.stringify({
          type: 'match-data-response',
          requestId,
          matchId: currentActiveMatchId,
          success: true,
          matchData: {
            match: currentMatchData,
            homeTeam,
            awayTeam,
            homePlayers,
            awayPlayers,
            sets,
            events
          }
        }))
      } catch (err) {
        console.error('[App WebSocket] Error handling match data request:', err)
      }
    }

    const handleGameNumberRequest = async (request) => {
      const ws = wsRef.current
      const currentActiveMatchId = currentMatchIdRef.current
      const currentMatchData = currentMatchRef.current // Use ref to get latest value

      if (!ws || ws.readyState !== WebSocket.OPEN || !currentMatchData) return

      try {
        const { requestId, gameNumber } = request
        const gameNumStr = String(gameNumber).trim()
        const matchGameNumber = String(currentMatchData.gameNumber || '')
        const matchGameN = String(currentMatchData.game_n || '')
        const matchIdStr = String(currentMatchData.id || '')
        
        if (matchGameNumber === gameNumStr || matchGameN === gameNumStr || matchIdStr === gameNumStr) {
          ws.send(JSON.stringify({
            type: 'game-number-response',
            requestId,
            success: true,
            match: currentMatchData,
            matchId: currentActiveMatchId
          }))
        } else {
          ws.send(JSON.stringify({
            type: 'game-number-response',
            requestId,
            success: false,
            error: 'Match not found'
          }))
        }
      } catch (err) {
        console.error('[App WebSocket] Error handling game number request:', err)
      }
    }

    const handleMatchUpdateRequest = async (request) => {
      const ws = wsRef.current
      const currentActiveMatchId = currentMatchIdRef.current
      const currentMatchData = currentMatchRef.current // Use ref to get latest value
      const { requestId, matchId: requestedMatchId, updates } = request
      console.log('[App WebSocket] Received match-update-request:', { requestId, requestedMatchId, currentActiveMatchId, wsState: ws?.readyState, hasMatch: !!currentMatchData })

      // Always send a response, even if conditions aren't met
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Try to send error response if WebSocket exists but isn't open
        if (ws && ws.readyState === WebSocket.CONNECTING) {
          // Wait a bit for connection, but don't block too long
          setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'match-update-response',
                requestId,
                matchId: requestedMatchId,
                success: false,
                error: 'WebSocket was connecting, please retry'
              }))
            }
          }, 1000)
        }
        // If WebSocket doesn't exist or is closed, we can't send a response
        // The server will timeout, which is expected behavior
        console.warn('[App WebSocket] Cannot respond to match-update-request: WebSocket not connected')
        return
      }

      if (!currentMatchData) {
        ws.send(JSON.stringify({
          type: 'match-update-response',
          requestId,
          matchId: requestedMatchId,
          success: false,
          error: 'Match data not loaded'
        }))
        return
      }

      try {
        if (String(requestedMatchId) !== String(currentActiveMatchId)) {
          const errorResponse = {
            type: 'match-update-response',
            requestId,
            matchId: requestedMatchId,
            success: false,
            error: 'Match ID mismatch'
          }
          console.log('[App WebSocket] Sending match-update-response (error):', errorResponse)
          ws.send(JSON.stringify(errorResponse))
          return
        }

        await db.matches.update(currentActiveMatchId, updates)
        const updatedMatch = await db.matches.get(currentActiveMatchId)
        
        const response = {
          type: 'match-update-response',
          requestId,
          matchId: currentActiveMatchId,
          success: true,
          data: {
            match: updatedMatch
          }
        }
        console.log('[App WebSocket] Sending match-update-response:', { requestId, success: true })
        ws.send(JSON.stringify(response))
      } catch (err) {
        console.error('[App WebSocket] Error handling match update request:', err)
        if (ws && ws.readyState === WebSocket.OPEN) {
          const errorResponse = {
            type: 'match-update-response',
            requestId,
            matchId: requestedMatchId,
            success: false,
            error: err.message || 'Error updating match'
          }
          console.log('[App WebSocket] Sending match-update-response (error):', errorResponse)
          ws.send(JSON.stringify(errorResponse))
        }
      }
    }

    connectWebSocket()

    return () => {
      isIntentionallyClosedRef.current = true
      
      // Clear all matches from server when component unmounts (scoreboard is source of truth)
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({
            type: 'clear-all-matches'
          }))
          console.log('[App WebSocket] Cleared all matches from server (component unmounting)')
        } catch (err) {
          console.error('[App WebSocket] Error clearing matches on unmount:', err)
        }
      }
      
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
        syncIntervalRef.current = null
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      if (wsRef.current) {
        const ws = wsRef.current
        const readyState = ws.readyState
        
        // Remove all handlers first to prevent error logs
        try {
          ws.onerror = null
          ws.onclose = null
          ws.onopen = null
          ws.onmessage = null
        } catch (err) {
          // Ignore if handlers can't be set
        }
        
        // Only try to close if connection is OPEN
        // Don't close if CONNECTING - let it fail naturally to avoid browser errors
        if (readyState === WebSocket.OPEN) {
          try {
            ws.close(1000, 'Component unmounting')
          } catch (err) {
            // Ignore errors during cleanup
          }
        }
        // For CONNECTING or CLOSING states, just null the ref
        wsRef.current = null
      }
    }
  }, [matchId, currentMatch?.id, serverStatus?.wsPort]) // Only depend on matchId and wsPort, not the full objects

  async function finishSet(cur) {
    const matchRecord = await db.matches.get(cur.matchId)
    const isTestMatch = matchRecord?.test === true
    
    // Calculate current set scores
    const sets = await db.sets.where({ matchId: cur.matchId }).toArray()
    const finishedSets = sets.filter(s => s.finished)
    const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
    const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length
    
    // Check if either team has won 3 sets (match win)
    const isMatchEnd = homeSetsWon >= 3 || awaySetsWon >= 3
    
    if (isMatchEnd) {
      // IMPORTANT: When match ends, preserve ALL data in database:
      // - All sets remain in db.sets
      // - All events remain in db.events
      // - All players remain in db.players
      // - All teams remain in db.teams
      // - Only update match status to 'final' - DO NOT DELETE ANYTHING
      await db.matches.update(cur.matchId, { status: 'final' })
      
      // Unlock session when match ends
      try {
        await unlockMatchSession(cur.matchId)
      } catch (error) {
        console.error('Error unlocking session:', error)
      }
      
      // Only sync official matches
      if (!isTestMatch) {
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: String(cur.matchId),
            status: 'final'
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }
      
      // Notify server to delete match from matchDataStore (since it's now final)
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'delete-match',
            matchId: String(cur.matchId)
          }))
          console.log('[App WebSocket] Notified server to delete ended match:', cur.matchId)
        } catch (err) {
          console.error('[App WebSocket] Error notifying server of match end:', err)
        }
      }
      
      // Show match end screen
      setShowMatchEnd(true)
      return
    }
    
    // Continue to next set (legacy logic - shouldn't reach here with new logic)
    const setId = await db.sets.add({ matchId: cur.matchId, index: cur.index + 1, homePoints: 0, awayPoints: 0, finished: false })
    
    // Only sync official matches
    if (!isTestMatch) {
      await db.sync_queue.add({
        resource: 'set',
        action: 'insert',
        payload: {
          external_id: String(setId),
          match_id: matchRecord?.externalId || String(cur.matchId),
          index: cur.index + 1,
          home_points: 0,
          away_points: 0,
          finished: false,
          created_at: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })
    }
  }

  const openMatchSetup = () => setMatchId(null)
  
  const openMatchSetupView = () => setShowMatchSetup(true)
  
  const openCoinTossView = () => {
    setShowMatchSetup(true)
    setShowCoinToss(true)
  }
  
  const returnToMatch = () => setShowMatchSetup(false)
  
  const goHome = async () => {
    // Unlock session if match was open
    if (matchId) {
      try {
        await unlockMatchSession(matchId)
      } catch (error) {
        console.error('Error unlocking session:', error)
      }
    }
    setMatchId(null)
    setShowMatchSetup(false)
  }

  async function clearLocalTestData() {
    await db.transaction('rw', db.events, db.sets, db.matches, db.players, db.teams, async () => {
      const testMatches = await db.matches
        .filter(m => m.test === true || m.externalId === TEST_MATCH_EXTERNAL_ID)
        .toArray()
      for (const match of testMatches) {
        await db.events.where('matchId').equals(match.id).delete()
        await db.sets.where('matchId').equals(match.id).delete()
        await db.matches.delete(match.id)
      }

      const testTeams = await db.teams
        .filter(
          t =>
            t.externalId === TEST_HOME_TEAM_EXTERNAL_ID ||
            t.externalId === TEST_AWAY_TEAM_EXTERNAL_ID ||
            (t.seedKey && t.seedKey.startsWith('test-'))
        )
        .toArray()

      for (const team of testTeams) {
        await db.players.where('teamId').equals(team.id).delete()
        await db.teams.delete(team.id)
      }
    })

  }

  async function resetSupabaseTestMatch() {
    if (!supabase) {
      throw new Error('Supabase client is not configured.')
    }

    const { data: matchRecord, error: matchLookupError } = await supabase
      .from('matches')
      .select('id')
      .eq('external_id', TEST_MATCH_EXTERNAL_ID)
      .single()

    if (matchLookupError) {
      throw new Error(matchLookupError.message)
    }
    if (!matchRecord) {
      throw new Error('Test match not found on Supabase.')
    }

    const matchUuid = matchRecord.id

    const { error: deleteEventsError } = await supabase
      .from('events')
      .delete()
      .eq('match_id', matchUuid)
    if (deleteEventsError) {
      throw new Error(deleteEventsError.message)
    }

    const { error: deleteSetsError } = await supabase
      .from('sets')
      .delete()
      .eq('match_id', matchUuid)
    if (deleteSetsError) {
      throw new Error(deleteSetsError.message)
    }

    const newScheduled = getNextTestMatchStartTime()
    const { error: updateMatchError } = await supabase
      .from('matches')
      .update({
        status: 'scheduled',
        scheduled_at: newScheduled,
        updated_at: new Date().toISOString()
      })
      .eq('id', matchUuid)

    if (updateMatchError) {
      throw new Error(updateMatchError.message)
    }
  }

  async function loadTestMatchFromSupabase({ resetRemote = false, targetView = 'setup' } = {}) {
    if (!supabase) {
      throw new Error('Supabase client is not configured.')
    }

    if (resetRemote) {
      await resetSupabaseTestMatch()
    }

    const { data: matchData, error: matchError } = await supabase
      .from('matches')
      .select('*')
      .eq('external_id', TEST_MATCH_EXTERNAL_ID)
      .single()

    if (matchError) {
      throw new Error(matchError.message)
    }
    if (!matchData) {
      throw new Error('Test match not found on Supabase.')
    }


    const [homeTeamRes, awayTeamRes] = await Promise.all([
      supabase.from('teams').select('*').eq('id', matchData.home_team_id).single(),
      supabase.from('teams').select('*').eq('id', matchData.away_team_id).single()
    ])

    if (homeTeamRes.error) {
      throw new Error(homeTeamRes.error.message)
    }
    if (awayTeamRes.error) {
      throw new Error(awayTeamRes.error.message)
    }

    const homeTeamData = homeTeamRes.data
    const awayTeamData = awayTeamRes.data


    const { data: playersData, error: playersError } = await supabase
      .from('players')
      .select('*')
      .in('team_id', [matchData.home_team_id, matchData.away_team_id])

    if (playersError) {
      throw new Error(playersError.message)
    }

    const { data: setsData, error: setsError } = await supabase
      .from('sets')
      .select('*')
      .eq('match_id', matchData.id)
      .order('index')

    if (setsError) {
      throw new Error(setsError.message)
    }

    const { data: eventsData, error: eventsError } = await supabase
      .from('events')
      .select('*')
      .eq('match_id', matchData.id)
      .order('ts')

    if (eventsError) {
      throw new Error(eventsError.message)
    }

    await clearLocalTestData()

    const normalizeBenchMember = member => ({
      role: member?.role || '',
      firstName: member?.firstName || member?.first_name || '',
      lastName: member?.lastName || member?.last_name || '',
      dob: member?.dob || member?.date_of_birth || member?.dateOfBirth || ''
    })

    const homeBenchRaw = Array.isArray(homeTeamData?.bench_staff)
      ? homeTeamData.bench_staff
      : Array.isArray(matchData.bench_home)
        ? matchData.bench_home
        : TEST_HOME_BENCH

    const awayBenchRaw = Array.isArray(awayTeamData?.bench_staff)
      ? awayTeamData.bench_staff
      : Array.isArray(matchData.bench_away)
        ? matchData.bench_away
        : TEST_AWAY_BENCH

    const homeBench = (() => {
      const normalized = homeBenchRaw.map(normalizeBenchMember)
      const hasNamedMember = normalized.some(member => member.firstName || member.lastName)
      return hasNamedMember ? normalized : TEST_HOME_BENCH.map(normalizeBenchMember)
    })()

    const awayBench = (() => {
      const normalized = awayBenchRaw.map(normalizeBenchMember)
      const hasNamedMember = normalized.some(member => member.firstName || member.lastName)
      return hasNamedMember ? normalized : TEST_AWAY_BENCH.map(normalizeBenchMember)
    })()

    const homeTeamId = await db.teams.add({
      name: homeTeamData?.name || 'Home',
      color: homeTeamData?.color || '#3b82f6',
      seedKey: homeTeamData?.seed_key || TEST_HOME_TEAM_EXTERNAL_ID,
      externalId: homeTeamData?.external_id || TEST_HOME_TEAM_EXTERNAL_ID,
      benchStaff: homeBench,
      test: true,
      createdAt: homeTeamData?.created_at || new Date().toISOString()
    })

    const awayTeamId = await db.teams.add({
      name: awayTeamData?.name || 'Away',
      color: awayTeamData?.color || '#ef4444',
      seedKey: awayTeamData?.seed_key || TEST_AWAY_TEAM_EXTERNAL_ID,
      externalId: awayTeamData?.external_id || TEST_AWAY_TEAM_EXTERNAL_ID,
      benchStaff: awayBench,
      test: true,
      createdAt: awayTeamData?.created_at || new Date().toISOString()
    })

    const normalizePlayer = (player, teamId) => ({
      teamId,
      number: player.number,
      name: `${player.last_name || ''} ${player.first_name || ''}`.trim(),
      lastName: player.last_name || '',
      firstName: player.first_name || '',
      dob: player.dob || '',
      libero: player.libero || '',
      isCaptain: player.is_captain || false,
      functions: Array.isArray(player.functions) && player.functions.length > 0 ? player.functions : ['player'],
      test: player.test ?? true,
      createdAt: player.created_at || new Date().toISOString(),
      externalId: player.external_id
    })

    const buildFallbackPlayers = (seedKey) => {
      const teamSeed = TEST_TEAM_SEED_DATA.find(t => t.seedKey === seedKey)
      if (!teamSeed) return []
      return teamSeed.players.map(player => ({
        team_id: null,
        number: player.number,
        first_name: player.firstName,
        last_name: player.lastName,
        dob: player.dob,
        libero: player.libero || '',
        is_captain: player.isCaptain || false,
        functions: player.functions || (player.libero ? ['player'] : ['player'])
      }))
    }

    let homePlayersData = (playersData || []).filter(p => p.team_id === matchData.home_team_id)
    if (!homePlayersData.length) {
      homePlayersData = buildFallbackPlayers('test-team-alpha')
      console.warn('[TestMatch] Supabase returned no home players, using fallback seed roster')
    }

    let awayPlayersData = (playersData || []).filter(p => p.team_id === matchData.away_team_id)
    if (!awayPlayersData.length) {
      awayPlayersData = buildFallbackPlayers('test-team-bravo')
      console.warn('[TestMatch] Supabase returned no away players, using fallback seed roster')
    }

    const fetchOfficialByExternalId = async (table, externalId) => {
      if (!externalId) return null
      const { data, error } = await supabase.from(table).select('first_name,last_name,country,dob').eq('external_id', externalId).maybeSingle()
      if (error) {
        console.warn(`Unable to load ${table} ${externalId}:`, error.message)
        return null
      }
      return data
    }

    const resolvedOfficials = async () => {
      const officialTemplates = [
        {
          role: '1st referee',
          table: 'referees',
          defaultExternalId: 'test-referee-alpha',
          fallback: TEST_REFEREE_SEED_DATA[0] || {}
        },
        {
          role: '2nd referee',
          table: 'referees',
          defaultExternalId: 'test-referee-bravo',
          fallback: TEST_REFEREE_SEED_DATA[1] || TEST_REFEREE_SEED_DATA[0] || {}
        },
        {
          role: 'scorer',
          table: 'scorers',
          defaultExternalId: 'test-scorer-alpha',
          fallback: TEST_SCORER_SEED_DATA[0] || {}
        },
        {
          role: 'assistant scorer',
          table: 'scorers',
          defaultExternalId: 'test-scorer-bravo',
          fallback: TEST_SCORER_SEED_DATA[1] || TEST_SCORER_SEED_DATA[0] || {}
        }
      ]

      const sourceOfficials = Array.isArray(matchData.officials) ? matchData.officials : []

      const normalizeOfficialEntry = async (template) => {
        const record = sourceOfficials.find(o => o.role === template.role) || {}
        const externalId = record.external_id || record.externalId || template.defaultExternalId

        let fetched = null
        if (externalId && (!record.firstName && !record.lastName) && (!record.first_name && !record.last_name)) {
          fetched = await fetchOfficialByExternalId(template.table, externalId)
        }

        const firstName = record.firstName || record.first_name || fetched?.first_name || template.fallback.firstName || ''
        const lastName = record.lastName || record.last_name || fetched?.last_name || template.fallback.lastName || ''
        const country = record.country || fetched?.country || template.fallback.country || 'CH'
        const dob = record.dob || fetched?.dob || template.fallback.dob || ''

        return {
          role: template.role,
          firstName,
          lastName,
          country,
          dob,
          externalId
        }
      }

      const results = await Promise.all(officialTemplates.map(normalizeOfficialEntry))
      const missingNames = results.filter(o => !o.firstName || !o.lastName)

      if (missingNames.length === 0) {
        return results
      }

      // As a safety fallback, merge with seed data for any remaining blanks
      return results.map(entry => {
        if (entry.firstName && entry.lastName) return entry
        const fallback = officialTemplates.find(t => t.role === entry.role)?.fallback || {}
        return {
          ...entry,
          firstName: entry.firstName || fallback.firstName || '',
          lastName: entry.lastName || fallback.lastName || '',
          country: entry.country || fallback.country || 'CH',
          dob: entry.dob || fallback.dob || ''
        }
      })
    }

    const officials = await resolvedOfficials()

    if (homePlayersData.length) {
      await db.players.bulkAdd(homePlayersData.map(p => normalizePlayer(p, homeTeamId)))
    }
    if (awayPlayersData.length) {
      await db.players.bulkAdd(awayPlayersData.map(p => normalizePlayer(p, awayTeamId)))
    }

    const matchDexieId = await db.matches.add({
      status: matchData.status || 'scheduled',
      scheduledAt: matchData.scheduled_at,
      hall: matchData.hall || TEST_MATCH_DEFAULTS.hall,
      city: matchData.city || TEST_MATCH_DEFAULTS.city,
      league: matchData.league || TEST_MATCH_DEFAULTS.league,
      gameNumber: matchData.game_number || TEST_MATCH_DEFAULTS.gameNumber,
      refereePin: matchData.referee_pin || generateRefereePin(),
      homeTeamId,
      awayTeamId,
      bench_home: homeBench,
      bench_away: awayBench,
      officials,
      test: matchData.test ?? true,
      createdAt: matchData.created_at || new Date().toISOString(),
      updatedAt: matchData.updated_at || new Date().toISOString(),
      externalId: matchData.external_id,
      seedKey: TEST_MATCH_SEED_KEY,
      supabaseId: matchData.id,
      homeCoachSignature: matchData.home_coach_signature || null,
      homeCaptainSignature: matchData.home_captain_signature || null,
      awayCoachSignature: matchData.away_coach_signature || null,
      awayCaptainSignature: matchData.away_captain_signature || null,
      coinTossTeamA: matchData.coin_toss_team_a || null,
      coinTossTeamB: matchData.coin_toss_team_b || null,
      coinTossServeA: matchData.coin_toss_serve_a ?? null,
      coinTossServeB: matchData.coin_toss_serve_b ?? null
    })
    console.log('[TestMatch] Created Dexie match', matchDexieId)

    if (Array.isArray(setsData) && setsData.length > 0) {
      await db.sets.bulkAdd(setsData.map(set => ({
        matchId: matchDexieId,
        index: set.index ?? set.set_index ?? 1,
        homePoints: set.home_points ?? 0,
        awayPoints: set.away_points ?? 0,
        finished: set.finished ?? false,
        startTime: set.start_time || null,
        endTime: set.end_time || null,
        externalId: set.external_id,
        createdAt: set.created_at,
        updatedAt: set.updated_at
      })))
    } else {
      await db.sets.add({
        matchId: matchDexieId,
        index: 1,
        homePoints: 0,
        awayPoints: 0,
        finished: false
      })
    }

    if (Array.isArray(eventsData) && eventsData.length > 0) {
      await db.events.bulkAdd(eventsData.map(event => ({
        matchId: matchDexieId,
        setIndex: event.set_index ?? 1,
        type: event.type,
        payload: event.payload || {},
        ts: event.ts || new Date().toISOString()
      })))
    }

    setMatchId(matchDexieId)
    setShowCoinToss(false)
    setShowMatchSetup(targetView === 'setup')
  }


  const firstNames = ['Max', 'Luca', 'Tom', 'Jonas', 'Felix', 'Noah', 'David', 'Simon', 'Daniel', 'Michael', 'Anna', 'Sarah', 'Lisa', 'Emma', 'Sophie', 'Laura', 'Julia', 'Maria', 'Nina', 'Sara']
  const lastNames = ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun']
  
  function randomDate(start, end) {
    const startDate = new Date(start).getTime()
    const endDate = new Date(end).getTime()
    const randomTime = startDate + Math.random() * (endDate - startDate)
    const date = new Date(randomTime)
    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const year = date.getFullYear()
    return `${day}/${month}/${year}`
  }

  function formatISODateToDisplay(dateString) {
    if (!dateString) return null
    const date = new Date(dateString)
    if (Number.isNaN(date.getTime())) {
      return dateString
    }
    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const year = date.getFullYear()
    return `${day}/${month}/${year}`
  }

  function generateRandomPlayers(teamId, config = {}) {
    // Config options: { totalPlayers: 12, liberoCount: 1 } or { totalPlayers: 11, liberoCount: 1 }
    // Valid combinations: 11+1, 12+0, 11+2, 12+2
    // At least 6 non-libero players required
    const { totalPlayers = 12, liberoCount = 1 } = config
    const nonLiberoCount = totalPlayers - liberoCount
    
    if (nonLiberoCount < 6) {
      throw new Error('At least 6 non-libero players required')
    }
    
    const numbers = Array.from({ length: totalPlayers }, (_, i) => i + 1)
    const shuffled = numbers.sort(() => Math.random() - 0.5)
    
    let captainAssigned = false
    
    return shuffled.slice(0, totalPlayers).map((number, idx) => {
      const firstName = firstNames[Math.floor(Math.random() * firstNames.length)]
      const lastName = lastNames[Math.floor(Math.random() * lastNames.length)]
      const dob = randomDate('1990-01-01', '2005-12-31')
      
      // Assign libero roles
      let libero = ''
      if (idx < liberoCount) {
        libero = idx === 0 ? 'libero1' : 'libero2'
      }
      
      // Assign captain to first non-libero player
      let isCaptain = false
      if (!captainAssigned && libero === '') {
        isCaptain = true
        captainAssigned = true
      }
      
      return {
        teamId,
        number,
        name: `${lastName} ${firstName}`,
        lastName,
        firstName,
        dob,
        libero,
        isCaptain,
        role: null,
        createdAt: new Date().toISOString()
      }
    })
  }

  async function showDeleteMatchModal() {
    const matchToDelete = currentOfficialMatch || currentMatch
    if (!matchToDelete) return

    const [homeTeam, awayTeam] = await Promise.all([
      matchToDelete.homeTeamId ? db.teams.get(matchToDelete.homeTeamId) : null,
      matchToDelete.awayTeamId ? db.teams.get(matchToDelete.awayTeamId) : null
    ])
    const matchName = `${homeTeam?.name || 'Home'} vs ${awayTeam?.name || 'Away'}`
    
    setDeleteMatchModal({
      matchName,
      matchId: matchToDelete.id
    })
  }

  async function confirmDeleteMatch() {
    if (!deleteMatchModal) return

    const matchIdToDelete = deleteMatchModal.matchId

    await db.transaction('rw', db.matches, db.sets, db.events, db.players, db.teams, db.sync_queue, db.match_setup, async () => {
      // Delete sets
      const sets = await db.sets.where('matchId').equals(matchIdToDelete).toArray()
      if (sets.length > 0) {
        await db.sets.bulkDelete(sets.map(s => s.id))
      }
      
      // Delete events
      const events = await db.events.where('matchId').equals(matchIdToDelete).toArray()
      if (events.length > 0) {
        await db.events.bulkDelete(events.map(e => e.id))
      }
      
      // Get match to find team IDs
      const match = await db.matches.get(matchIdToDelete)
      
      // Delete players
      if (match?.homeTeamId) {
        await db.players.where('teamId').equals(match.homeTeamId).delete()
      }
      if (match?.awayTeamId) {
        await db.players.where('teamId').equals(match.awayTeamId).delete()
      }
      
      // Delete teams
      if (match?.homeTeamId) {
        await db.teams.delete(match.homeTeamId)
      }
      if (match?.awayTeamId) {
        await db.teams.delete(match.awayTeamId)
      }
      
      // Delete all sync queue items (since we can't filter by matchId easily)
      await db.sync_queue.clear()
      
      // Delete match setup draft
      await db.match_setup.clear()
      
      // Delete match
      await db.matches.delete(matchIdToDelete)
    })

    // Notify server to delete match from matchDataStore
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: 'delete-match',
          matchId: String(matchIdToDelete)
        }))
        console.log('[App WebSocket] Notified server to delete match:', matchIdToDelete)
      } catch (err) {
        console.error('[App WebSocket] Error notifying server of match deletion:', err)
      }
    }

    setDeleteMatchModal(null)
    setMatchId(null)
    setShowMatchSetup(false)
  }

  function cancelDeleteMatch() {
    setDeleteMatchModal(null)
  }

  async function createNewOfficialMatch() {
    // Check if match is ongoing
    if (matchStatus?.status === 'Match recording') {
      return // Don't allow creating new match when one is ongoing
    }

    // Delete current match if exists
    if (currentMatch) {
      setNewMatchModal({
        type: 'official',
        message: 'There is an existing match. Do you want to delete it and create a new official match?'
      })
      return
    }

    // Create new blank match
    const newMatchId = await db.matches.add({
      status: 'scheduled',
      refereePin: generateRefereePin(),
      createdAt: new Date().toISOString()
    })

    setMatchId(newMatchId)
    setShowMatchSetup(true)
    setShowCoinToss(false) // Ensure we go to match setup, not coin toss
  }

  async function confirmNewMatch() {
    if (!newMatchModal) return

    // Delete current match first
    if (currentMatch) {
      await db.transaction('rw', db.matches, db.sets, db.events, db.players, db.teams, db.sync_queue, db.match_setup, async () => {
        // Delete sets
        const sets = await db.sets.where('matchId').equals(currentMatch.id).toArray()
        if (sets.length > 0) {
          await db.sets.bulkDelete(sets.map(s => s.id))
        }
        
        // Delete events
        const events = await db.events.where('matchId').equals(currentMatch.id).toArray()
        if (events.length > 0) {
          await db.events.bulkDelete(events.map(e => e.id))
        }
        
        // Delete players
        if (currentMatch.homeTeamId) {
          await db.players.where('teamId').equals(currentMatch.homeTeamId).delete()
        }
        if (currentMatch.awayTeamId) {
          await db.players.where('teamId').equals(currentMatch.awayTeamId).delete()
        }
        
        // Delete teams
        if (currentMatch.homeTeamId) {
          await db.teams.delete(currentMatch.homeTeamId)
        }
        if (currentMatch.awayTeamId) {
          await db.teams.delete(currentMatch.awayTeamId)
        }
        
        // Delete all sync queue items
        await db.sync_queue.clear()
        
        // Delete match setup draft
        await db.match_setup.clear()
        
        // Delete match
        await db.matches.delete(currentMatch.id)
      })
    }

    setNewMatchModal(null)

    if (newMatchModal.type === 'official') {
      // Create new blank match
      const newMatchId = await db.matches.add({
        status: 'scheduled',
        refereePin: generateRefereePin(),
        createdAt: new Date().toISOString()
      })
      setMatchId(newMatchId)
      setShowMatchSetup(true)
      setShowCoinToss(false) // Ensure we go to match setup, not coin toss
    } else if (newMatchModal.type === 'test') {
      // Create test match (reuse the existing createNewTestMatch logic)
      await createTestMatchData()
      setShowCoinToss(false) // Ensure we go to match setup, not coin toss
    }
  }

  function cancelNewMatch() {
    setNewMatchModal(null)
  }

  const halls = ['Kantonsschule Wiedikon (Halle A)', 'Kantonsschule Wiedikon (Halle B)', 'Kantonsschule Wiedikon C', 'Sporthalle Zürich', 'Hallenstadion', 'Sporthalle Basel', 'Sporthalle Bern']
  const cities = ['Zürich', 'Basel', 'Bern', 'Luzern', 'Genf', 'Lausanne', 'St. Gallen', 'Winterthur']
  const leagues = ['3L A', '3L B', '2L A', '2L B', '1L', 'NLA', 'NLB']

  useEffect(() => {
    ensureSeedTestTeams().catch(error => {
      console.error('Failed to ensure seeded test teams:', error)
    })
    ensureSeedTestOfficials().catch(error => {
      console.error('Failed to ensure seeded officials:', error)
    })
  }, [])

  async function ensureSeedTestTeams() {
    const seededTeams = []

    await db.transaction('rw', db.teams, db.players, db.sync_queue, async () => {
      for (const definition of TEST_TEAM_SEED_DATA) {
        let team = await db.teams.filter(t => t.seedKey === definition.seedKey).first()
        const isTestSeed = definition.seedKey?.startsWith('test-')

        if (!team) {
          const timestamp = new Date().toISOString()
          const teamId = await db.teams.add({
            name: definition.name,
            color: definition.color,
            seedKey: definition.seedKey,
            test: true,
            createdAt: timestamp
          })

          // Don't sync test seed data to Supabase - it comes from the seed script

          const playersToCreate = definition.players.map(player => ({
            teamId,
            number: player.number,
            name: `${player.lastName} ${player.firstName}`,
            lastName: player.lastName,
            firstName: player.firstName,
            dob: player.dob,
            libero: player.libero || '',
            isCaptain: player.isCaptain,
            role: null,
            test: true,
            createdAt: timestamp
          }))

          await db.players.bulkAdd(playersToCreate, undefined, { allKeys: true })
          // Don't sync test seed players to Supabase - they come from the seed script

          team = {
            id: teamId,
            name: definition.name,
            color: definition.color,
            seedKey: definition.seedKey,
            test: true,
            createdAt: timestamp
          }
        } else {
          const playerCount = await db.players.where('teamId').equals(team.id).count()
          if (playerCount === 0) {
            const timestamp = new Date().toISOString()
            const playersToCreate = definition.players.map(player => ({
              teamId: team.id,
              number: player.number,
              name: `${player.lastName} ${player.firstName}`,
              lastName: player.lastName,
              firstName: player.firstName,
              dob: player.dob,
              libero: player.libero || '',
              isCaptain: player.isCaptain,
              role: null,
              test: true,
              createdAt: timestamp
            }))

            await db.players.bulkAdd(playersToCreate)
          }
        }

        seededTeams.push(team)
      }
    })

    return seededTeams
  }

  async function ensureSeedTestOfficials() {
    const seededReferees = []
    const seededScorers = []

    await db.transaction('rw', db.referees, db.scorers, db.sync_queue, async () => {
      const queueRefereeRecord = async (record, timestamp = new Date().toISOString()) => {
        if (!record) return
        if (record.seedKey?.startsWith('test-')) return
        const createdAt = record.createdAt || timestamp
        await db.sync_queue.add({
          resource: 'referee',
          action: 'insert',
          payload: {
            external_id: String(record.id),
            seed_key: record.seedKey,
            first_name: record.firstName,
            last_name: record.lastName,
            country: record.country || null,
            dob: record.dob || null,
            test: true,
            created_at: createdAt
          },
          ts: timestamp,
          status: 'queued'
        })
        await db.referees.update(record.id, { synced: false })
      }

      const queueScorerRecord = async (record, timestamp = new Date().toISOString()) => {
        if (!record) return
        if (record.seedKey?.startsWith('test-')) return
        const createdAt = record.createdAt || timestamp
        await db.sync_queue.add({
          resource: 'scorer',
          action: 'insert',
          payload: {
            external_id: String(record.id),
            seed_key: record.seedKey,
            first_name: record.firstName,
            last_name: record.lastName,
            country: record.country || null,
            dob: record.dob || null,
            test: true,
            created_at: createdAt
          },
          ts: timestamp,
          status: 'queued'
        })
        await db.scorers.update(record.id, { synced: false })
      }

      for (const definition of TEST_REFEREE_SEED_DATA) {
        let referee = await db.referees.filter(r => r.seedKey === definition.seedKey).first()
        let queued = false

        if (!referee) {
          const timestamp = new Date().toISOString()
          const baseRecord = {
            seedKey: definition.seedKey,
            firstName: definition.firstName,
            lastName: definition.lastName,
            country: definition.country,
            dob: definition.dob,
            test: true,
            createdAt: timestamp,
            synced: false
          }
          const refereeId = await db.referees.add(baseRecord)
          referee = { id: refereeId, ...baseRecord }
          await queueRefereeRecord(referee, timestamp)
          queued = true
        } else {
          const definitionChanged =
            referee.firstName !== definition.firstName ||
            referee.lastName !== definition.lastName ||
            referee.country !== definition.country ||
            referee.dob !== definition.dob

          if (definitionChanged) {
            const timestamp = new Date().toISOString()
            await db.referees.update(referee.id, {
              firstName: definition.firstName,
              lastName: definition.lastName,
              country: definition.country,
              dob: definition.dob,
              synced: false
            })
            referee = {
              ...referee,
              firstName: definition.firstName,
              lastName: definition.lastName,
              country: definition.country,
              dob: definition.dob,
              synced: false
            }
            await queueRefereeRecord(referee, timestamp)
            queued = true
          }
        }

        if (referee && !queued) {
          if (referee.synced === true) {
            await db.referees.update(referee.id, { synced: false })
            referee = { ...referee, synced: false }
          }
          await queueRefereeRecord(referee)
          queued = true
        }

        seededReferees.push(referee)
      }

      for (const definition of TEST_SCORER_SEED_DATA) {
        let scorer = await db.scorers.filter(s => s.seedKey === definition.seedKey).first()
        let queued = false

        if (!scorer) {
          const timestamp = new Date().toISOString()
          const baseRecord = {
            seedKey: definition.seedKey,
            firstName: definition.firstName,
            lastName: definition.lastName,
            country: definition.country,
            dob: definition.dob,
            test: true,
            createdAt: timestamp,
            synced: false
          }
          const scorerId = await db.scorers.add(baseRecord)
          scorer = { id: scorerId, ...baseRecord }
          await queueScorerRecord(scorer, timestamp)
          queued = true
        } else {
          const definitionChanged =
            scorer.firstName !== definition.firstName ||
            scorer.lastName !== definition.lastName ||
            scorer.country !== definition.country ||
            scorer.dob !== definition.dob

          if (definitionChanged) {
            const timestamp = new Date().toISOString()
            await db.scorers.update(scorer.id, {
              firstName: definition.firstName,
              lastName: definition.lastName,
              country: definition.country,
              dob: definition.dob,
              synced: false
            })
            scorer = {
              ...scorer,
              firstName: definition.firstName,
              lastName: definition.lastName,
              country: definition.country,
              dob: definition.dob,
              synced: false
            }
            await queueScorerRecord(scorer, timestamp)
            queued = true
          }
        }

        if (scorer && !queued) {
          if (scorer.synced === true) {
            await db.scorers.update(scorer.id, { synced: false })
            scorer = { ...scorer, synced: false }
          }
          await queueScorerRecord(scorer)
          queued = true
        }

        seededScorers.push(scorer)
      }
    })

    return { referees: seededReferees, scorers: seededScorers }
  }

  async function createTestMatchData() {
    const seededTeams = await ensureSeedTestTeams()
    const { referees, scorers } = await ensureSeedTestOfficials()
    if (seededTeams.length < 2) {
      console.error('Not enough seeded test teams available.')
      return
    }

    const [homeTeam, awayTeam] = seededTeams
    const scheduledAt = getNextTestMatchStartTime()
    const timestamp = new Date().toISOString()

    const findSeededRecord = (collection, seed) => {
      if (!seed) return null
      if (!collection?.length) return seed
      const seeded = collection.find(item => item.seedKey === seed.seedKey)
      return seeded || collection[0] || seed
    }

    const firstRef = findSeededRecord(referees, TEST_REFEREE_SEED_DATA[0])
    const secondRef = findSeededRecord(referees, TEST_REFEREE_SEED_DATA[1] || TEST_REFEREE_SEED_DATA[0])
    const primaryScorer = findSeededRecord(scorers, TEST_SCORER_SEED_DATA[0])
    const assistantScorer = findSeededRecord(scorers, TEST_SCORER_SEED_DATA[1] || TEST_SCORER_SEED_DATA[0])

    const officials = [
      {
        role: '1st referee',
        firstName: firstRef?.firstName || 'Claudia',
        lastName: firstRef?.lastName || 'Moser',
        country: firstRef?.country || 'CH',
        dob: firstRef?.dob ? formatISODateToDisplay(firstRef.dob) : formatISODateToDisplay('1982-04-19')
      },
      {
        role: '2nd referee',
        firstName: secondRef?.firstName || 'Martin',
        lastName: secondRef?.lastName || 'Kunz',
        country: secondRef?.country || 'CH',
        dob: secondRef?.dob ? formatISODateToDisplay(secondRef.dob) : formatISODateToDisplay('1979-09-02')
      },
      {
        role: 'scorer',
        firstName: primaryScorer?.firstName || 'Petra',
        lastName: primaryScorer?.lastName || 'Schneider',
        country: primaryScorer?.country || 'CH',
        dob: primaryScorer?.dob ? formatISODateToDisplay(primaryScorer.dob) : formatISODateToDisplay('1990-01-15')
      },
      {
        role: 'assistant scorer',
        firstName: assistantScorer?.firstName || 'Lukas',
        lastName: assistantScorer?.lastName || 'Baumann',
        country: assistantScorer?.country || 'CH',
        dob: assistantScorer?.dob ? formatISODateToDisplay(assistantScorer.dob) : formatISODateToDisplay('1988-06-27')
      }
    ]

    let createdMatchId = null

    await db.transaction('rw', db.matches, db.sets, db.events, db.sync_queue, async () => {
      let existingMatch =
        (await db.matches.filter(m => m.seedKey === TEST_MATCH_SEED_KEY).first()) ||
        (await db.matches.filter(m => m.test === true && !m.seedKey).first())

      if (existingMatch && existingMatch.seedKey !== TEST_MATCH_SEED_KEY) {
        await db.matches.update(existingMatch.id, { seedKey: TEST_MATCH_SEED_KEY })
        existingMatch = await db.matches.get(existingMatch.id)
      }

      const baseMatchData = {
        status: 'scheduled',
        homeTeamId: homeTeam.id,
        awayTeamId: awayTeam.id,
        hall: TEST_MATCH_DEFAULTS.hall,
        city: TEST_MATCH_DEFAULTS.city,
        league: TEST_MATCH_DEFAULTS.league,
        gameNumber: TEST_MATCH_DEFAULTS.gameNumber,
        scheduledAt,
        refereePin: generateRefereePin(),
        bench_home: TEST_HOME_BENCH,
        bench_away: TEST_AWAY_BENCH,
        officials,
        homeCoachSignature: null,
        homeCaptainSignature: null,
        awayCoachSignature: null,
        awayCaptainSignature: null,
        test: true,
        seedKey: TEST_MATCH_SEED_KEY,
        externalId: TEST_MATCH_EXTERNAL_ID
      }

      if (existingMatch) {
        await db.events.where('matchId').equals(existingMatch.id).delete()
        await db.sets.where('matchId').equals(existingMatch.id).delete()

        await db.matches.update(existingMatch.id, {
          ...baseMatchData,
          // Preserve existing refereePin if it exists
          refereePin: existingMatch.refereePin || baseMatchData.refereePin,
          createdAt: existingMatch.createdAt || timestamp,
          updatedAt: timestamp
        })

        createdMatchId = existingMatch.id
        // Don't sync test match metadata to Supabase - it comes from the seed script
      } else {
        const newMatchId = await db.matches.add({
          ...baseMatchData,
          createdAt: timestamp,
          updatedAt: timestamp
        })

        createdMatchId = newMatchId
        // Don't sync test match metadata to Supabase - it comes from the seed script
      }
    })

    if (createdMatchId) {
      setMatchId(createdMatchId)
      setShowMatchSetup(true)
      setShowCoinToss(false)
    }
  }

  async function createNewTestMatch() {
    if (testMatchLoading) return

    const officialMatchRecording = matchStatus?.status === 'Match recording' && currentOfficialMatch
    if (officialMatchRecording) {
      setConfirmModal({
        message: 'An official match is still recording. Starting a new test match will wipe the previous test session. Continue?',
        onConfirm: async () => {
          setConfirmModal(null)
          setTestMatchLoading(true)
          try {
            await clearLocalTestData()
            await createTestMatchData()
          } catch (error) {
            console.error('Failed to prepare test match:', error)
            setAlertModal(`Unable to prepare the test match: ${error.message || error}`)
          } finally {
            setTestMatchLoading(false)
          }
        },
        onCancel: () => {
          setConfirmModal(null)
        }
      })
      return
    }

    setTestMatchLoading(true)

    try {
      // Clear previous test match locally
      await clearLocalTestData()

      // Create test match locally only - no Supabase interaction
      await createTestMatchData()
    } catch (error) {
      console.error('Failed to prepare test match:', error)
      setAlertModal(`Unable to prepare the test match: ${error.message || error}`)
    } finally {
      setTestMatchLoading(false)
    }
  }

  async function continueTestMatch() {
    if (testMatchLoading) return

    // Use toArray and filter to avoid index requirement
    const matches = await db.matches.orderBy('createdAt').reverse().toArray()
    const existing = matches.find(m => m.test === true && m.status !== 'final')
    if (existing) {
      // Check if coin toss is confirmed
      const isCoinTossConfirmed = existing.coinTossTeamA !== null && 
                                   existing.coinTossTeamA !== undefined &&
                                   existing.coinTossTeamB !== null && 
                                   existing.coinTossTeamB !== undefined &&
                                   existing.coinTossServeA !== null && 
                                   existing.coinTossServeA !== undefined &&
                                   existing.coinTossServeB !== null && 
                                   existing.coinTossServeB !== undefined
      
      // PIN check removed - no longer required
      
      // Check match state to determine where to continue
      const isMatchSetupComplete = existing.homeCoachSignature && 
                                    existing.homeCaptainSignature && 
                                    existing.awayCoachSignature && 
                                    existing.awayCaptainSignature
      
      setMatchId(existing.id)
      
      // Determine where to continue based on status
      if (existing.status === 'live' || existing.status === 'final') {
        // Go directly to scoreboard
        setShowMatchSetup(false)
        setShowCoinToss(false)
      } else if (isMatchSetupComplete && isCoinTossConfirmed) {
        // Match setup and coin toss complete - go to scoreboard
        setShowMatchSetup(false)
        setShowCoinToss(false)
      } else if (isMatchSetupComplete) {
        // Match setup complete but coin toss not done - go to coin toss
        setShowMatchSetup(false)
        setShowCoinToss(true)
      } else {
        // Match setup not complete - go to match setup
        setShowMatchSetup(true)
        setShowCoinToss(false)
      }
    } else {
      setAlertModal('No test match found. Please create a new test match first.')
    }
  }

  async function restartTestMatch() {
    if (testMatchLoading) return

    // Set loading state immediately to disable buttons
    setTestMatchLoading(true)
    
    setConfirmModal({
      message: 'This will delete the test match and all its data. Continue?',
      onConfirm: async () => {
        setConfirmModal(null)
        try {
          // Find the test match - use toArray and filter to avoid index requirement
          const matches = await db.matches.orderBy('createdAt').reverse().toArray()
          const testMatch = matches.find(m => m.test === true && m.status !== 'final')
          if (!testMatch) {
            setAlertModal('No test match found.')
            setTestMatchLoading(false)
            return
          }

          // Delete all test match data
          await clearLocalTestData()

          // Clear matchId to return to home view
          setMatchId(null)
          setShowMatchSetup(false)
          setShowCoinToss(false)

          setAlertModal('Test match deleted successfully.')
        } catch (error) {
          console.error('Failed to delete test match:', error)
          setAlertModal(`Unable to delete test match: ${error.message || error}`)
        } finally {
          setTestMatchLoading(false)
        }
      },
      onCancel: () => {
        setConfirmModal(null)
        setTestMatchLoading(false)
      }
    })
  }

  async function continueMatch(matchIdParam) {
    const targetMatchId = matchIdParam || currentOfficialMatch?.id
    if (!targetMatchId) return
    
    try {
    // Get the match to check its status
      const match = await db.matches.get(targetMatchId)
      if (!match) return
      
      // Check session lock (only for non-test matches)
      if (!match.test) {
        const sessionCheck = await checkMatchSession(targetMatchId)
        
        if (sessionCheck.locked && !sessionCheck.isCurrentSession) {
          // Match is locked by another session - just take over (no PIN required)
          await lockMatchSession(targetMatchId)
        } else if (!sessionCheck.locked) {
          // Match is not locked - lock it for this session
          await lockMatchSession(targetMatchId)
        }
        // If isCurrentSession is true, we already own it - no need to lock again
      }
      
      // PIN check removed - no longer required
      
      // Check if coin toss is confirmed (for navigation logic)
      const isCoinTossConfirmed = match.coinTossTeamA !== null && 
                                   match.coinTossTeamA !== undefined &&
                                   match.coinTossTeamB !== null && 
                                   match.coinTossTeamB !== undefined &&
                                   match.coinTossServeA !== null && 
                                   match.coinTossServeA !== undefined &&
                                   match.coinTossServeB !== null && 
                                   match.coinTossServeB !== undefined
      
      // If coin toss is confirmed and match is live, allow test matches to go to scoreboard
      // (This handles the case when coin toss is just confirmed)
      if (match.test === true && match.status === 'live' && isCoinTossConfirmed) {
        // Go directly to scoreboard for test matches after coin toss confirmation
        setMatchId(targetMatchId)
        setShowMatchSetup(false)
        setShowCoinToss(false)
        return
      }
      
      // Reject test matches for other cases
      if (match.test === true) {
        setAlertModal('This is a test match. Use "Continue test match" instead.')
        return
      }
      
      // Determine where to continue based on status
      if (match.status === 'live' || match.status === 'final') {
        // Go directly to scoreboard
        setMatchId(targetMatchId)
        setShowMatchSetup(false)
        setShowCoinToss(false)
      } else {
        // Go to match setup
        setMatchId(targetMatchId)
        setShowMatchSetup(true)
      }
    } catch (error) {
      console.error('Error continuing match:', error)
      setAlertModal('Error opening match. Please try again.')
    }
  }

  return (
    <div style={{ position: 'relative', minHeight: '100vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => {
      // Close connection menu and debug menu when clicking outside
      if (showConnectionMenu && !e.target.closest('[data-connection-menu]')) {
        setShowConnectionMenu(false)
      }
      if (showDebugMenu && !e.target.closest('[data-debug-menu]')) {
        setShowDebugMenu(null)
      }
    }}>
      {/* Global Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 20px',
        background: 'rgba(0, 0, 0, 0.2)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        flexShrink: 0,
        gap: '16px',
        zIndex: 100
      }}>
        {/* Left: Version */}
        <div style={{ flex: '0 0 auto', fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)' }}>
          Version {__APP_VERSION__ || '1.0.0'}
        </div>
        
        {/* Right: Connection Status and Fullscreen */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '12px',
          flex: '0 0 auto'
        }}>
          {/* Connection Status Indicator */}
          <ConnectionStatus
            connectionStatuses={connectionStatuses}
            connectionDebugInfo={connectionDebugInfo}
            position="right"
            size="normal"
          />
          
          {/* Fullscreen Button */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              toggleFullscreen()
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
            title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          >
            {isFullscreen ? '⛶ Exit' : '⛶ Fullscreen'}
          </button>
        </div>
      </div>

      <div className="container" style={{ flex: '1 1 auto', overflow: 'auto' }}>

      {!matchId && matchStatus && (
        <div className="match-status-banner">
          <div className="match-status-content">
            <span className="match-status-label">Current Match:</span>
            <span className="match-status-teams">
              {matchStatus.homeTeam?.name || 'Home'} vs {matchStatus.awayTeam?.name || 'Away'}
            </span>
            <span className="match-status-value">{matchStatus.status}</span>
          </div>
        </div>
      )}

      <div className="panel">
        {showMatchSetup && matchId ? (
          <MatchSetup matchId={matchId} onStart={continueMatch} onReturn={returnToMatch} onGoHome={goHome} showCoinToss={showCoinToss} onCoinTossClose={() => setShowCoinToss(false)} />
        ) : showMatchEnd && matchId ? (
          <MatchEnd 
            matchId={matchId} 
            onShowScoresheet={() => {
              // TODO: Implement scoresheet view
            }}
            onGoHome={() => {
              setMatchId(null)
              setShowMatchEnd(false)
            }}
          />
        ) : !matchId ? (
          <div className="home-view">
            <div className="home-content">
              <h1 className="home-title" style={{ whiteSpace: 'nowrap' }}>Openvolley eScoresheet Indoor</h1>
              <div className="home-logo" style={{ width: '200px' }}>
                <img src={favicon} alt="Openvolley" style={{ width: '100%' }} />
              </div>
              
              <div className="home-match-section" style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <div className="home-card home-card--clickable" style={{ flex: '1 1 0', minWidth: '280px', maxWidth: '400px' }} onClick={(e) => {
                  // Don't open modal if clicking on connection menu or debug menu
                  if (!e.target.closest('[data-connection-menu]') && !e.target.closest('[data-debug-menu]')) {
                    setHomeCardModal('official')
                  }
                }}>
                  <div className="home-card-header">
                    <h2>Official Match</h2>
                  </div>
                </div>
                
                <div className="home-card home-card--test home-card--clickable" style={{ flex: '1 1 0', minWidth: '280px', maxWidth: '400px' }} onClick={() => setHomeCardModal('test')}>
                  <div className="home-card-header">
                    <h2>Test Match</h2>
                  </div>
                </div>
              </div>
              
              <div style={{ marginTop: '24px' }}>
                <button
                  onClick={() => setHomeOptionsModal(true)}
                  style={{
                    padding: '10px 20px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: 'rgba(255, 255, 255, 0.1)',
                    color: 'var(--text)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '8px',
                    cursor: 'pointer'
                  }}
                >
                  Options
                </button>
              </div>
            </div>
          </div>
        ) : (
          <Scoreboard 
            matchId={matchId} 
            onFinishSet={finishSet} 
            onOpenSetup={openMatchSetup} 
            onOpenMatchSetup={openMatchSetupView} 
            onOpenCoinToss={openCoinTossView}
            manageCaptainOnCourt={manageCaptainOnCourt}
          />
        )}
      </div>

      {/* Delete Match Modal */}
      {deleteMatchModal && (
        <Modal
          title="Delete Match"
          open={true}
          onClose={cancelDeleteMatch}
          width={400}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              Are you sure you want to delete all data for: <strong>{deleteMatchModal.matchName}</strong>?
            </p>
            <p style={{ marginBottom: '24px', fontSize: '14px', color: 'var(--muted)' }}>
              This will delete all sets, events, players, and team data for this match.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmDeleteMatch}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: '#ef4444',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Delete
              </button>
              <button
                onClick={cancelDeleteMatch}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* New Match Modal */}
      {newMatchModal && (
        <Modal
          title="Create New Match"
          open={true}
          onClose={cancelNewMatch}
          width={400}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              {newMatchModal.message}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmNewMatch}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Yes
              </button>
              <button
                onClick={cancelNewMatch}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Alert Modal */}
      {alertModal && (
        <Modal
          title="Alert"
          open={true}
          onClose={() => setAlertModal(null)}
          width={400}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              {alertModal}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => setAlertModal(null)}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                OK
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Confirm Modal */}
      {confirmModal && (
        <Modal
          title="Confirm"
          open={true}
          onClose={confirmModal.onCancel}
          width={400}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              {confirmModal.message}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmModal.onConfirm}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Yes
              </button>
              <button
                onClick={confirmModal.onCancel}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Official Match Modal */}
      {homeCardModal === 'official' && (
        <Modal
          title="Official Match"
          open={true}
          onClose={() => setHomeCardModal(null)}
          width={500}
        >
          <div style={{ padding: '24px' }}>
            {currentOfficialMatch?.gamePin && (
              <div style={{ 
                marginBottom: '24px', 
                padding: '12px 16px', 
                background: 'rgba(255, 255, 255, 0.05)', 
                borderRadius: '8px',
                textAlign: 'center'
              }}>
                <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '4px' }}>Game PIN</div>
                <div style={{ fontSize: '20px', fontWeight: 700, fontFamily: 'monospace', letterSpacing: '2px' }}>
                  {currentOfficialMatch.gamePin}
                </div>
              </div>
            )}
            <div className="home-card-actions" style={{ flexDirection: 'column', marginTop: 0 }}>
              <button 
                onClick={() => {
                  setHomeCardModal(null)
                  createNewOfficialMatch()
                }}
                disabled={matchStatus?.status === 'Match recording'}
                className={matchStatus?.status === 'Match recording' ? 'disabled' : ''}
              >
                New official match
              </button>
              <button 
                onClick={() => {
                  setHomeCardModal(null)
                  if (currentOfficialMatch) continueMatch(currentOfficialMatch.id)
                }}
                disabled={!currentOfficialMatch}
                className={!currentOfficialMatch ? 'disabled' : ''}
              >
                Continue official match
              </button>
              <button 
                onClick={() => {
                  setHomeCardModal(null)
                  showDeleteMatchModal()
                }}
                disabled={!currentOfficialMatch}
                className={'danger ' + (!currentOfficialMatch ? 'disabled' : '')}
              >
                Delete official match
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Test Match Modal */}
      {homeCardModal === 'test' && (
        <Modal
          title="Test Match"
          open={true}
          onClose={() => setHomeCardModal(null)}
          width={500}
        >
          <div style={{ padding: '24px' }}>
            <div className="home-card-actions" style={{ flexDirection: 'column', marginTop: 0 }}>
              <button 
                onClick={() => {
                  setHomeCardModal(null)
                  createNewTestMatch()
                }}
                disabled={testMatchLoading}
                className={testMatchLoading ? 'test-button disabled' : 'test-button'}
              >
                {testMatchLoading ? 'Preparing…' : 'New test match'}
              </button>
              <button 
                onClick={() => {
                  setHomeCardModal(null)
                  continueTestMatch()
                }}
                disabled={testMatchLoading || !currentTestMatch}
                className={(testMatchLoading || !currentTestMatch) ? 'test-button disabled' : 'test-button'}
              >
                {testMatchLoading ? 'Loading…' : 'Continue test match'}
              </button>
              <button 
                onClick={() => {
                  setHomeCardModal(null)
                  restartTestMatch()
                }}
                disabled={testMatchLoading || !currentTestMatch}
                className={(testMatchLoading || !currentTestMatch) ? 'test-button test-button--danger disabled' : 'test-button test-button--danger'}
              >
                {testMatchLoading ? 'Clearing…' : 'Clear test match'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Home Options Modal */}
      {homeOptionsModal && (
        <Modal
          title="Options"
          open={true}
          onClose={() => setHomeOptionsModal(false)}
          width={500}
        >
          <div style={{ padding: '24px' }}>
            <div style={{ marginBottom: '24px' }}>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'space-between',
                marginBottom: '8px'
              }}>
                <span style={{ fontSize: '16px', fontWeight: 500 }}>Manage Captain on Court</span>
                <label style={{ 
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  position: 'relative',
                  width: '48px',
                  height: '24px'
                }}>
                  <input
                    type="checkbox"
                    checked={manageCaptainOnCourt}
                    onChange={(e) => {
                      const value = e.target.checked
                      setManageCaptainOnCourt(value)
                      localStorage.setItem('manageCaptainOnCourt', value.toString())
                    }}
                    style={{
                      opacity: 0,
                      width: 0,
                      height: 0
                    }}
                  />
                  <span style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: manageCaptainOnCourt ? 'var(--accent)' : 'rgba(255, 255, 255, 0.2)',
                    borderRadius: '24px',
                    transition: 'background-color 0.2s',
                    cursor: 'pointer'
                  }}>
                    <span style={{
                      position: 'absolute',
                      top: '2px',
                      left: manageCaptainOnCourt ? '26px' : '2px',
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      backgroundColor: '#fff',
                      transition: 'left 0.2s',
                      boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)'
                    }} />
                  </span>
                </label>
              </div>
              <div style={{ 
                fontSize: '14px', 
                color: 'var(--muted)',
                lineHeight: '1.5'
              }}>
                When enabled, the scorer on the scoreboard can designate a captain on court when the team captain is not playing.
              </div>
            </div>
            
            <div style={{ marginBottom: '24px', paddingTop: '24px', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
              <button
                onClick={() => {
                  setHomeOptionsModal(false)
                  setHomeGuideModal(true)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px 16px',
                  fontSize: '16px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  width: '100%',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                }}
              >
                <span style={{ fontSize: '20px' }}>?</span>
                <span>Show Guide</span>
              </button>
            </div>
            
            <div style={{ marginBottom: '24px', paddingTop: '24px', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
              <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', fontWeight: 600 }}>Download Desktop App</h3>
              {(() => {
                const githubRepo = import.meta.env.VITE_GITHUB_REPO || 'lucacanepa/openvolley'
                const releasesUrl = `https://github.com/Lucanepa/openvolley/releases`
                
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ 
                      padding: '12px 16px',
                      fontSize: '14px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: '8px',
                      color: 'var(--muted)',
                      textAlign: 'center'
                    }}>
                      Build installers and upload to GitHub Releases to enable downloads.
                    </div>
                    
                    <a
                      href={releasesUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '12px 16px',
                        fontSize: '16px',
                        fontWeight: 600,
                        background: 'rgba(255, 255, 255, 0.1)',
                        color: 'var(--text)',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '8px',
                        textDecoration: 'none',
                        transition: 'all 0.2s',
                        justifyContent: 'center'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                      }}
                    >
                      <span>📦 View Releases & Downloads</span>
                      <span style={{ fontSize: '14px', opacity: 0.7 }}>→</span>
                    </a>
                    
                    <div style={{ 
                      marginTop: '8px', 
                      fontSize: '12px', 
                      color: 'var(--muted)',
                      padding: '8px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: '6px'
                    }}>
                      <strong>To build installers:</strong><br />
                      Run <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 4px', borderRadius: '4px' }}>npm run electron:build:win</code> (or mac/linux)<br />
                      Then upload files from <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 4px', borderRadius: '4px' }}>dist-electron/</code> to a GitHub Release
                    </div>
                  </div>
                )
              })()}
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '24px' }}>
              <button
                onClick={() => setHomeOptionsModal(false)}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
            
            <div style={{ 
              marginTop: '24px', 
              paddingTop: '24px', 
              borderTop: '1px solid rgba(255, 255, 255, 0.1)',
              textAlign: 'center',
              fontSize: '12px',
              color: 'var(--muted)'
            }}>
              Support: luca.canepa@gmail.com
            </div>
          </div>
        </Modal>
      )}

      {/* Home Guide Modal */}
      <GuideModal
        open={homeGuideModal}
        onClose={() => setHomeGuideModal(false)}
      />

      </div>
    </div>
  )
}