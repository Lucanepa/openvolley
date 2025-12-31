import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { getMatchData, subscribeToMatchData, listAvailableMatches, getWebSocketStatus, forceReconnect } from '../utils/serverDataSync'
import { useRealtimeConnection, CONNECTION_TYPES, CONNECTION_STATUS } from '../hooks/useRealtimeConnection'
import mikasaVolleyball from '../mikasa_v200w.png'
import { ConnectionManager } from '../utils/connectionManager'
import ConnectionStatus from './ConnectionStatus'
import WsDebugOverlay from './WsDebugOverlay'
import { db } from '../db/db'
import { Results } from '../../scoresheet_pdf/components/FooterSection'
import TestModeControls from './TestModeControls'
import { changelog } from '../CHANGELOG'
import { supabase } from '../lib/supabaseClient'

// Get current version from changelog
const currentVersion = changelog[0]?.version || '1.0.0'

export default function Referee({ matchId, onExit, isMasterMode }) {
  const { t } = useTranslation()
  const [refereeView, setRefereeView] = useState('2nd') // '1st' or '2nd'
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Modal states (from Scoreboard actions)
  const [timeoutModal, setTimeoutModal] = useState(null) // { team, countdown, started }
  const [showTimeoutModal, setShowTimeoutModal] = useState(false) // Modal visibility (separate from countdown state)

  // Flashing substitution state (like Scoreboard)
  const [recentlySubstitutedPlayers, setRecentlySubstitutedPlayers] = useState([]) // [{ team, playerNumber, timestamp }]
  const recentSubFlashTimeoutRef = useRef(null)

  // Referee view dropdown state
  const [refViewDropdownOpen, setRefViewDropdownOpen] = useState(false)

  // Connection type state (auto, supabase, websocket)
  const [connectionType, setConnectionType] = useState(CONNECTION_TYPES.AUTO)
  const [connectionDropdownOpen, setConnectionDropdownOpen] = useState(false)

  // Advanced mode state for reception formations
  const [advancedMode, setAdvancedMode] = useState({ left: false, right: false }) // Per-side advanced mode
  const [setterNumber, setSetterNumber] = useState({ left: null, right: null }) // Per-side setter number
  const [setterSelectionModal, setSetterSelectionModal] = useState(null) // 'left' | 'right' | null

  // Reception mode: 'standard' (grid layout) or 'reception' (formation positions)
  const [receptionMode, setReceptionMode] = useState({ left: 'standard', right: 'standard' })

  // Custom formation positions (drag and drop adjustments) per set
  const [customFormations, setCustomFormations] = useState({}) // { [setIndex]: { left: { [position]: { top, left } }, right: { ... } } }

  // Dragging state for player repositioning
  const [draggingPlayer, setDraggingPlayer] = useState(null) // { side: 'left'|'right', position: 'I'-'VI' }
  const courtRef = useRef({ left: null, right: null })

  // Timer ref for auto-revert to standard mode
  const receptionModeTimerRef = useRef({ left: null, right: null })

  // Connection state
  const [connectionStatuses, setConnectionStatuses] = useState({
    api: 'unknown',
    server: 'unknown',
    websocket: 'unknown',
    scoreboard: 'unknown',
    match: 'unknown',
    db: 'unknown'
  })
  const [connectionDebugInfo, setConnectionDebugInfo] = useState({})
  
  const wakeLockRef = useRef(null) // Wake lock to prevent screen sleep
  const [wakeLockActive, setWakeLockActive] = useState(false) // Track wake lock status
  const [betweenSetsCountdown, setBetweenSetsCountdown] = useState(null) // { countdown, started }
  const [showIntervalModal, setShowIntervalModal] = useState(false) // Modal visibility (separate from countdown state)
  const [peekingLineup, setPeekingLineup] = useState({ left: false, right: false }) // Track which team's lineup is being peeked

  // Reset peeking state on any mouseup/touchend (since overlay disappears when peeking)
  useEffect(() => {
    const resetPeeking = () => setPeekingLineup({ left: false, right: false })
    document.addEventListener('mouseup', resetPeeking)
    document.addEventListener('touchend', resetPeeking)
    return () => {
      document.removeEventListener('mouseup', resetPeeking)
      document.removeEventListener('touchend', resetPeeking)
    }
  }, [])

  // Request wake lock to prevent screen from sleeping
  useEffect(() => {
    const enableNativeWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          // Release existing lock first
          if (wakeLockRef.current) {
            try { await wakeLockRef.current.release() } catch (e) {}
          }
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          console.log('[WakeLock] Screen wake lock acquired (Referee)')
          setWakeLockActive(true)
          wakeLockRef.current.addEventListener('release', () => {
            console.log('[WakeLock] Screen wake lock released (Referee)')
            // Only set inactive if we're not re-acquiring
            if (!wakeLockRef.current) {
              setWakeLockActive(false)
            }
          })
          return true
        }
      } catch (err) {
        console.log('[WakeLock] Native wake lock failed:', err.message)
      }
      return false
    }

    const handleInteraction = async () => {
      const success = await enableNativeWakeLock()
      if (success) {
        console.log('[WakeLock] Enabled on user interaction')
    }
    }
    
    // Try to enable on mount
    enableNativeWakeLock()
    
    // Also try on user interaction (required by some browsers)
    document.addEventListener('click', handleInteraction, { once: true })
    document.addEventListener('touchstart', handleInteraction, { once: true })

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        await enableNativeWakeLock()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      document.removeEventListener('click', handleInteraction)
      document.removeEventListener('touchstart', handleInteraction)
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {})
        wakeLockRef.current = null
      }
    }
  }, [])

  // Match data state
  const [data, setData] = useState(null)

  // Helper function to update match data state
  const updateMatchDataState = useCallback((result) => {
    if (result && result.success) {
      const sets = (result.sets || []).sort((a, b) => a.index - b.index)
      const currentSet = sets.find(s => !s.finished) || null
      
      setData({
        match: result.match,
        homeTeam: result.homeTeam,
        awayTeam: result.awayTeam,
        homePlayers: (result.homePlayers || []).sort((a, b) => (a.number || 0) - (b.number || 0)),
        awayPlayers: (result.awayPlayers || []).sort((a, b) => (a.number || 0) - (b.number || 0)),
        sets,
        currentSet,
        events: result.events || [],
        liveState: result.liveState || null
      })
    }
  }, [])

  // Create mock data for master mode
  useEffect(() => {
    if (isMasterMode && !data) {
      setData({
        match: {
          id: -1,
          status: 'live',
          homeShortName: 'HOM',
          awayShortName: 'AWY',
          coinTossTeamA: 'home',
          firstServe: 'home'
        },
        homeTeam: { name: 'Home Team', color: '#ef4444' },
        awayTeam: { name: 'Away Team', color: '#3b82f6' },
        homePlayers: [
          { number: 1 }, { number: 2 }, { number: 3 },
          { number: 4 }, { number: 99 }, { number: 6 },
          { number: 7, libero: 'libero1' }
        ],
        awayPlayers: [
          { number: 11 }, { number: 12 }, { number: 13 },
          { number: 54 }, { number: 15 }, { number: 16 },
          { number: 17, libero: 'libero1' }
        ],
        sets: [{ index: 1, homePoints: 12, awayPoints: 10, finished: false }],
        currentSet: { index: 1, homePoints: 12, awayPoints: 10, finished: false },
        events: [
          { type: 'lineup', setIndex: 1, payload: { team: 'home', lineup: { I: 1, II: 2, III: 3, IV: 4, V: 99, VI: 6 } }},
          { type: 'lineup', setIndex: 1, payload: { team: 'away', lineup: { I: 11, II: 12, III: 13, IV: 54, V: 15, VI: 16 } }}
        ]
      })
        }
  }, [isMasterMode, data])

  // No heartbeat needed - Referee just listens for WebSocket updates from Scoreboard

  // Check connection statuses
  const checkConnectionStatuses = useCallback(async () => {
    const statuses = { api: 'unknown', server: 'unknown', websocket: 'unknown', scoreboard: 'unknown', match: 'unknown', db: 'unknown' }
    const debugInfo = {}
    
    try {
      const result = await listAvailableMatches()
      if (result.success) {
        statuses.api = 'connected'
        statuses.server = 'connected'
      } else {
        statuses.api = 'disconnected'
        statuses.server = 'disconnected'
      }
    } catch (err) {
      statuses.api = 'disconnected'
      statuses.server = 'disconnected'
    }
    
    statuses.scoreboard = statuses.server
    
    // Get WebSocket status
    if (isMasterMode) {
      statuses.websocket = 'test_mode'
    } else if (matchId) {
      statuses.websocket = getWebSocketStatus(matchId)
      } else {
              statuses.websocket = 'disconnected'
    }
    
    if (isMasterMode) {
      statuses.match = 'test_mode'
      debugInfo.match = { status: 'test_mode', message: 'Running in test mode' }
    } else if (matchId && data?.match) {
      statuses.match = data.match.status === 'live' ? 'live' : data.match.status === 'scheduled' ? 'scheduled' : 'final'
    } else {
      statuses.match = 'no_match'
    }
    
    try {
      await db.matches.count()
      statuses.db = 'connected'
    } catch (err) {
      statuses.db = 'error'
    }
    
    setConnectionStatuses(statuses)
    setConnectionDebugInfo(debugInfo)
  }, [matchId, data?.match, isMasterMode])

  useEffect(() => {
    checkConnectionStatuses()
    const interval = setInterval(checkConnectionStatuses, 60000) // 60s to reduce console spam
    return () => clearInterval(interval)
  }, [checkConnectionStatuses])

  // Force fetch fresh data from server
  const fetchFreshData = useCallback(async () => {
    if (isMasterMode || !matchId) return
      try {
      console.log('[Referee] Fetching fresh data from server...')
        const result = await getMatchData(matchId)
      if (result.success) {
        updateMatchDataState(result)
        console.log('[Referee] Fresh data received:', {
          currentSet: result.sets?.find(s => !s.finished)?.index,
          homePoints: result.sets?.find(s => !s.finished)?.homePoints,
          awayPoints: result.sets?.find(s => !s.finished)?.awayPoints
          })
        }
      } catch (err) {
      console.error('[Referee] Error fetching fresh data:', err)
        }
  }, [matchId, updateMatchDataState, isMasterMode])

  // Handle realtime data updates
  const handleRealtimeData = useCallback((result) => {
    if (!result || !result.success) return

    const receiveTimestamp = Date.now()
    console.log(`[Referee] 📥 Received match-data-update at ${new Date(receiveTimestamp).toISOString()}:`, {
      hasHomeTeam: !!result.homeTeam,
      hasAwayTeam: !!result.awayTeam,
      setsCount: result.sets?.length,
      eventsCount: result.events?.length
    })

    // Only update if data is complete (has teams and sets)
    if (result.homeTeam && result.awayTeam && result.sets?.length > 0) {
      updateMatchDataState(result)
    } else {
      console.debug('[Referee] Received partial data (missing teams/sets), skipping UI update')
    }
  }, [updateMatchDataState])

  // Handle realtime actions (timeout, substitution, set_end)
  const handleRealtimeAction = useCallback((action, actionData) => {
    const receiveTimestamp = Date.now()
    console.log(`[Referee] 📥 Received action '${action}' at ${new Date(receiveTimestamp).toISOString()}:`, actionData)

    if (action === 'timeout') {
      setTimeoutModal({
        team: actionData.team,
        countdown: actionData.countdown || 30,
        started: true
      })
      setShowTimeoutModal(true) // Show the modal overlay
    } else if (action === 'substitution') {
      // Add player to recently substituted list for flashing effect (no modal, just flash)
      setRecentlySubstitutedPlayers(prev => [...prev, { team: actionData.team, playerNumber: actionData.playerIn, timestamp: Date.now() }])

      // Clear the flash after 5 seconds
      if (recentSubFlashTimeoutRef.current) {
        clearTimeout(recentSubFlashTimeoutRef.current)
      }
      recentSubFlashTimeoutRef.current = setTimeout(() => {
        setRecentlySubstitutedPlayers([])
      }, 5000)
    } else if (action === 'set_end') {
      setBetweenSetsCountdown({
        countdown: actionData.countdown || 180,
        started: true,
        setIndex: actionData.setIndex,
        winner: actionData.winner
      })
      setShowIntervalModal(true) // Show the modal overlay
    } else if (action === 'end_timeout') {
      // Scoreboard ended the timeout - clear countdown and modal
      setTimeoutModal(null)
      setShowTimeoutModal(false)
    } else if (action === 'end_interval') {
      // Scoreboard ended the set interval - clear countdown and modal
      setBetweenSetsCountdown(null)
      setShowIntervalModal(false)
    }
  }, [])

  // Use realtime connection hook (handles Supabase + WebSocket with fallback)
  const {
    status: realtimeStatus,
    activeConnection,
    error: realtimeError,
    lastUpdate: realtimeLastUpdate,
    forceReconnect: realtimeReconnect
  } = useRealtimeConnection({
    matchId,
    preferredConnection: connectionType,
    onData: handleRealtimeData,
    onAction: handleRealtimeAction,
    enabled: !isMasterMode && !!matchId
  })

  // Initial data fetch when connection changes or component mounts
  useEffect(() => {
    if (!isMasterMode && matchId && realtimeStatus === CONNECTION_STATUS.CONNECTED) {
      fetchFreshData()
    }
  }, [isMasterMode, matchId, realtimeStatus, fetchFreshData])

  // Refetch data when page becomes visible (handles screen wake from sleep)
  useEffect(() => {
    if (isMasterMode || !matchId) return

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('[Referee] Page became visible, fetching fresh data...')
        fetchFreshData()
      }
    }
    
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [matchId, isMasterMode, fetchFreshData])

  // Track last processed event to avoid duplicates from Supabase realtime
  const lastProcessedEventRef = useRef(null)

  // Store Supabase UUID for realtime subscription (match_live_state.match_id is UUID, not seed_key)
  const [supabaseMatchUuid, setSupabaseMatchUuid] = useState(null)

  // Look up Supabase UUID from seed_key when matchId changes
  useEffect(() => {
    if (!supabase || !matchId) return

    const lookupUuid = async () => {
      const { data, error } = await supabase
        .from('matches')
        .select('id')
        .eq('external_id', matchId)
        .maybeSingle()

      if (!error && data?.id) {
        console.log('[Referee] Found Supabase UUID:', data.id, 'for matchId:', matchId)
        setSupabaseMatchUuid(data.id)
      } else {
        console.warn('[Referee] Could not find Supabase UUID for matchId:', matchId, error)
      }
    }

    lookupUuid()
  }, [matchId])

  // Supabase realtime subscription for live state updates (backup/alternative to WebSocket)
  useEffect(() => {
    if (!supabase || !supabaseMatchUuid || isMasterMode) return

    console.log('[Referee] Setting up realtime subscription for UUID:', supabaseMatchUuid)

    const channel = supabase
      .channel(`match_live_state:${supabaseMatchUuid}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'match_live_state',
          filter: `match_id=eq.${supabaseMatchUuid}`
        },
        (payload) => {
          const state = payload.new
          if (!state) return

          // Simple deduplication - only skip if exact same updated_at within 50ms
          const now = Date.now()
          const lastProcessed = lastProcessedEventRef.current
          if (lastProcessed && state.updated_at === lastProcessed.updatedAt && (now - lastProcessed.time) < 50) {
            console.log('[Referee] 📡 Skipping duplicate (same updated_at within 50ms)')
            return
          }
          lastProcessedEventRef.current = { time: now, updatedAt: state.updated_at }

          console.log(`[Referee] 📡 Supabase realtime: ${state.last_event_type || 'update'}`, {
            event: state.last_event_type,
            points: `${state.points_a || 0}-${state.points_b || 0}`,
            set: state.current_set,
            lineup_a: !!state.lineup_a,
            lineup_b: !!state.lineup_b
          })

          // A/B Model: Convert left/right to home/away using side_a (for modal handling)
          // side_a = 'left' or 'right' indicates which side Team A is on
          const localTeamAKey = data?.match?.coinTossTeamA || 'home'
          const sideA = state.side_a || 'left'
          const homeTeamOnLeft = (sideA === 'left') === (localTeamAKey === 'home')
          const getTeamFromSide = (side) => {
            if (side === 'left') return homeTeamOnLeft ? 'home' : 'away'
            return homeTeamOnLeft ? 'away' : 'home'
          }

          // Handle timeout
          if (state.last_event_type === 'timeout') {
            const team = getTeamFromSide(state.last_event_team)
            setTimeoutModal({
              team,
              countdown: state.last_event_data?.duration || 30,
              started: true
            })
            setShowTimeoutModal(true) // Show the modal overlay
          }

          // Handle substitution - flash effect only (no modal)
          if (state.last_event_type === 'substitution') {
            const team = getTeamFromSide(state.last_event_team)
            setRecentlySubstitutedPlayers(prev => [
              ...prev,
              { team, playerNumber: state.last_event_data?.playerIn, timestamp: Date.now() }
            ])
            if (recentSubFlashTimeoutRef.current) clearTimeout(recentSubFlashTimeoutRef.current)
            recentSubFlashTimeoutRef.current = setTimeout(() => setRecentlySubstitutedPlayers([]), 5000)
          }

          // Handle libero entry/exit/exchange
          if (['libero_entry', 'libero_exit', 'libero_exchange'].includes(state.last_event_type)) {
            const team = getTeamFromSide(state.last_event_team)
            const playerNumber = state.last_event_data?.liberoNumber || state.last_event_data?.playerIn
            if (playerNumber) {
              setRecentlySubstitutedPlayers(prev => [
                ...prev,
                { team, playerNumber, timestamp: Date.now() }
              ])
              if (recentSubFlashTimeoutRef.current) clearTimeout(recentSubFlashTimeoutRef.current)
              recentSubFlashTimeoutRef.current = setTimeout(() => setRecentlySubstitutedPlayers([]), 5000)
            }
          }

          // Handle set end (3-minute interval)
          if (state.last_event_type === 'set_end' || state.set_interval_active) {
            setBetweenSetsCountdown({
              countdown: 180,
              started: true,
              setIndex: state.last_event_data?.setIndex || state.current_set,
              winner: state.last_event_data?.winner
            })
            setShowIntervalModal(true) // Show the modal overlay
          }

          // ALWAYS refetch data on ANY change - handles points, lineups, subs, libero, sanctions, undoes, replays, etc.
          console.log('[Referee] 📡 Realtime change detected, refetching data...')
          fetchFreshData()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [supabaseMatchUuid, isMasterMode, data?.match?.coinTossTeamA, fetchFreshData])

  // Handle timeout countdown timer
  useEffect(() => {
    if (!timeoutModal || !timeoutModal.started) return
    
    if (timeoutModal.countdown <= 0) {
      setTimeoutModal(null)
      return
    }

    const timer = setInterval(() => {
      setTimeoutModal(prev => {
        if (!prev || !prev.started) return null
        const newCountdown = prev.countdown - 1
        if (newCountdown <= 0) {
          return null
        }
        return { ...prev, countdown: newCountdown }
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [timeoutModal])

  // Track last point count to detect when points change (rally ends)
  const lastPointsRef = useRef({ home: 0, away: 0 })

  // Auto-revert reception mode to standard after rally starts (3 seconds after point)
  useEffect(() => {
    if (!data?.currentSet) return

    const currentHomePoints = data.currentSet.homePoints || 0
    const currentAwayPoints = data.currentSet.awayPoints || 0

    const pointsChanged = currentHomePoints !== lastPointsRef.current.home ||
                          currentAwayPoints !== lastPointsRef.current.away

    // Update last points
    lastPointsRef.current = { home: currentHomePoints, away: currentAwayPoints }

    // If points changed (rally ended), start 3 second timer to revert to standard mode
    if (pointsChanged) {
      // Clear existing timers
      if (receptionModeTimerRef.current.left) {
        clearTimeout(receptionModeTimerRef.current.left)
      }
      if (receptionModeTimerRef.current.right) {
        clearTimeout(receptionModeTimerRef.current.right)
      }

      // Start new timer for both sides if in reception mode
      if (receptionMode.left === 'reception') {
        receptionModeTimerRef.current.left = setTimeout(() => {
          setReceptionMode(prev => ({ ...prev, left: 'standard' }))
        }, 3000)
      }
      if (receptionMode.right === 'reception') {
        receptionModeTimerRef.current.right = setTimeout(() => {
          setReceptionMode(prev => ({ ...prev, right: 'standard' }))
        }, 3000)
      }
    }

    return () => {
      if (receptionModeTimerRef.current.left) {
        clearTimeout(receptionModeTimerRef.current.left)
      }
      if (receptionModeTimerRef.current.right) {
        clearTimeout(receptionModeTimerRef.current.right)
      }
    }
  }, [data?.currentSet?.homePoints, data?.currentSet?.awayPoints, receptionMode.left, receptionMode.right])

  // Toggle reception mode for a side
  const toggleReceptionMode = useCallback((side) => {
    setReceptionMode(prev => ({
      ...prev,
      [side]: prev[side] === 'standard' ? 'reception' : 'standard'
    }))
  }, [])

  // Handle drag start for player repositioning
  const handleDragStart = useCallback((e, side, position) => {
    e.dataTransfer.effectAllowed = 'move'
    setDraggingPlayer({ side, position })
  }, [])

  // Handle drag over court
  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  // Handle drop on court - save custom position
  const handleDrop = useCallback((e, side) => {
    e.preventDefault()
    if (!draggingPlayer || draggingPlayer.side !== side) return

    const courtEl = courtRef.current[side]
    if (!courtEl) return

    const rect = courtEl.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    // Convert to percentage
    const leftPercent = (x / rect.width) * 100
    const topPercent = (y / rect.height) * 100

    // Clamp values to court bounds
    const clampedLeft = Math.max(5, Math.min(95, leftPercent))
    const clampedTop = Math.max(5, Math.min(95, topPercent))

    const setIndex = data?.currentSet?.index || 1

    setCustomFormations(prev => ({
      ...prev,
      [setIndex]: {
        ...prev[setIndex],
        [side]: {
          ...prev[setIndex]?.[side],
          [draggingPlayer.position]: { top: clampedTop, left: clampedLeft }
        }
      }
    }))

    setDraggingPlayer(null)
  }, [draggingPlayer, data?.currentSet?.index])

  // Calculate statistics
  const stats = useMemo(() => {
    // First, try to get stats from liveState (most accurate for Supabase-sourced data)
    if (data?.liveState) {
      const liveState = data.liveState
      const teamAIsHome = data.match?.coinTossTeamA === 'home'

      // Helper to get count from either array (new format) or number (old format)
      const getCount = (value) => {
        if (Array.isArray(value)) return value.length
        if (typeof value === 'number') return value
        return 0
      }

      return {
        home: {
          timeouts: teamAIsHome ? getCount(liveState.timeouts_a) : getCount(liveState.timeouts_b),
          substitutions: teamAIsHome ? getCount(liveState.subs_a) : getCount(liveState.subs_b)
        },
        away: {
          timeouts: teamAIsHome ? getCount(liveState.timeouts_b) : getCount(liveState.timeouts_a),
          substitutions: teamAIsHome ? getCount(liveState.subs_b) : getCount(liveState.subs_a)
        }
      }
    }

    // Fallback: count from events (when data comes from local IndexedDB or WebSocket)
    if (!data || !data.events || !data.currentSet) {
      return {
        home: { timeouts: 0, substitutions: 0 },
        away: { timeouts: 0, substitutions: 0 }
      }
    }

    const currentSetEvents = data.events.filter(
      e => (e.setIndex || 1) === (data.currentSet?.index || 1)
    )

    return {
      home: {
        timeouts: currentSetEvents.filter(e => e.type === 'timeout' && e.payload?.team === 'home').length,
        substitutions: currentSetEvents.filter(e => e.type === 'substitution' && e.payload?.team === 'home').length
      },
      away: {
        timeouts: currentSetEvents.filter(e => e.type === 'timeout' && e.payload?.team === 'away').length,
        substitutions: currentSetEvents.filter(e => e.type === 'substitution' && e.payload?.team === 'away').length
      }
    }
  }, [data])

  // Get lineup for current set - returns null for team if no lineup exists
  // Rich format: lineup positions contain { number, isServing, isLibero, replacedNumber, isSubstituted, substitutedFor, hasSanction, sanctions, isCaptain, isCourtCaptain }
  // Legacy format: lineup positions just contain player number
  const lineup = useMemo(() => {
    if (!data || !data.events || !data.currentSet) {
      return { home: null, away: null, isRichFormat: false }
    }

    const currentSetIndex = data.currentSet?.index || 1
    const currentSetEvents = data.events.filter(
      e => (e.setIndex || 1) === currentSetIndex
    )

    const homeLineupEvents = currentSetEvents.filter(e => e.type === 'lineup' && e.payload?.team === 'home')
    const awayLineupEvents = currentSetEvents.filter(e => e.type === 'lineup' && e.payload?.team === 'away')

    const latestHomeLineup = homeLineupEvents[homeLineupEvents.length - 1]
    const latestAwayLineup = awayLineupEvents[awayLineupEvents.length - 1]

    // Check if using rich format (position I has isServing field)
    const homeLineupData = latestHomeLineup?.payload?.lineup || null
    const awayLineupData = latestAwayLineup?.payload?.lineup || null
    const isRichFormat = latestHomeLineup?.payload?.isRichFormat ||
                         latestAwayLineup?.payload?.isRichFormat ||
                         homeLineupData?.I?.isServing !== undefined ||
                         awayLineupData?.I?.isServing !== undefined

    // Check if we're between sets (previous set finished, current set not started)
    // During set interval, only show lineup if we have lineup events for the NEW set
    const previousSetIndex = currentSetIndex - 1
    if (previousSetIndex >= 1) {
      const previousSet = data.sets?.find(s => s.index === previousSetIndex)
      const currentSetHasPoints = data.events?.some(e => e.type === 'point' && (e.setIndex || 1) === currentSetIndex)

      // If previous set is finished and current set has no points yet (between sets)
      // Only show lineups if we have lineup events specifically for the new set
      if (previousSet?.finished && !currentSetHasPoints) {
        const hasHomeLineupForNewSet = homeLineupEvents.length > 0
        const hasAwayLineupForNewSet = awayLineupEvents.length > 0

        // If no lineup events exist for the new set, return null for both
        if (!hasHomeLineupForNewSet && !hasAwayLineupForNewSet) {
          return { home: null, away: null, isRichFormat: false, isBetweenSets: true }
        }
      }
    }

    return {
      home: homeLineupData,
      away: awayLineupData,
      isRichFormat
    }
  }, [data])

  // Calculate set scores
  const setScore = useMemo(() => {
    if (!data) return { home: 0, away: 0 }
    
    const finishedSets = data.sets?.filter(s => s.finished) || []
    return {
      home: finishedSets.filter(s => s.homePoints > s.awayPoints).length,
      away: finishedSets.filter(s => s.awayPoints > s.homePoints).length
    }
  }, [data])

  // Determine who has serve
  const getCurrentServe = useMemo(() => {
    // First priority: use servingTeam from Supabase live state (most accurate)
    if (data?.currentSet?.servingTeam) {
      return data.currentSet.servingTeam
    }

    if (!data?.currentSet || !data?.match) {
      return data?.match?.firstServe || 'home'
    }

    const setIndex = data.currentSet.index
    const set1FirstServe = data.match.firstServe || 'home'
    const teamAKey = data.match.coinTossTeamA || 'home'
    const teamBKey = data.match.coinTossTeamB || 'away'

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
      .filter(e => e.type === 'point' && e.setIndex === data.currentSet.index)
      .sort((a, b) => {
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime
      })

    if (pointEvents.length === 0) {
      return currentSetFirstServe
    }

    return pointEvents[0].payload?.team || currentSetFirstServe
  }, [data?.events, data?.currentSet, data?.match])

  // Determine team labels
  const teamAKey = data?.match?.coinTossTeamA || 'home'
  const homeLabel = teamAKey === 'home' ? 'A' : 'B'
  const awayLabel = teamAKey === 'away' ? 'A' : 'B'

  // Determine which team is on the left (from referee's perspective)
  const homeOnLeftFor2ndRef = useMemo(() => {
    if (!data?.currentSet) return true
    if (data.currentSet.index === 1) return teamAKey === 'home'
    return teamAKey !== 'home'
  }, [data?.currentSet, teamAKey])

  const homeTeamOnLeft = refereeView === '1st' ? !homeOnLeftFor2ndRef : homeOnLeftFor2ndRef

  const leftTeam = homeTeamOnLeft ? 'home' : 'away'
  const rightTeam = homeTeamOnLeft ? 'away' : 'home'
  const leftTeamData = leftTeam === 'home' ? data?.homeTeam : data?.awayTeam
  const rightTeamData = rightTeam === 'home' ? data?.homeTeam : data?.awayTeam
  const leftLabel = leftTeam === 'home' ? homeLabel : awayLabel
  const rightLabel = rightTeam === 'home' ? homeLabel : awayLabel
  const leftLineup = leftTeam === 'home' ? lineup.home : lineup.away
  const rightLineup = rightTeam === 'home' ? lineup.home : lineup.away
  const leftStats = leftTeam === 'home' ? stats.home : stats.away
  const rightStats = rightTeam === 'home' ? stats.home : stats.away
  const leftScore = leftTeam === 'home' ? data?.currentSet?.homePoints || 0 : data?.currentSet?.awayPoints || 0
  const rightScore = rightTeam === 'home' ? data?.currentSet?.homePoints || 0 : data?.currentSet?.awayPoints || 0
  const leftSetScore = leftTeam === 'home' ? setScore.home : setScore.away
  const rightSetScore = rightTeam === 'home' ? setScore.home : setScore.away
  const leftServing = getCurrentServe === leftTeam
  const rightServing = getCurrentServe === rightTeam
  const leftColor = leftTeamData?.color || (leftTeam === 'home' ? '#ef4444' : '#3b82f6')
  const rightColor = rightTeamData?.color || (rightTeam === 'home' ? '#ef4444' : '#3b82f6')

  // Get team-level sanctions (formal warning, improper request, delay warning, bench sanctions)
  // Also returns player-level sanctions (warnings, penalties, expulsions, disqualifications)
  const getTeamSanctions = useCallback((teamKey) => {
    if (!data?.events) return {
      formalWarning: false, improperRequest: false, delayWarning: false, delayPenalty: false,
      benchSanctions: [], playerWarnings: [], playerPenalties: [], expulsions: [], disqualifications: []
    }

    const teamSanctions = data.events.filter(e =>
      e.type === 'sanction' && e.payload?.team === teamKey
    )

    // Player sanctions (on-court players with numbers)
    const playerWarnings = teamSanctions.filter(s => {
      const type = s.payload?.type || s.payload?.sanctionType
      const playerNum = s.payload?.playerNumber || s.payload?.player
      const playerType = s.payload?.playerType
      // Warning on a player (not team, not delay, not bench/official)
      return type === 'warning' &&
        playerNum && String(playerNum) !== 'D' &&
        playerType !== 'team' && playerType !== 'bench' && playerType !== 'official' &&
        !s.payload?.isTeamWarning
    }).map(s => ({ player: s.payload?.playerNumber || s.payload?.player, position: s.payload?.position }))

    const playerPenalties = teamSanctions.filter(s => {
      const type = s.payload?.type || s.payload?.sanctionType
      const playerNum = s.payload?.playerNumber || s.payload?.player
      const playerType = s.payload?.playerType
      // Penalty on a player (not delay)
      return type === 'penalty' &&
        playerNum && String(playerNum) !== 'D' &&
        playerType !== 'bench' && playerType !== 'official'
    }).map(s => ({ player: s.payload?.playerNumber || s.payload?.player, position: s.payload?.position }))

    const expulsions = teamSanctions.filter(s => {
      const type = s.payload?.type || s.payload?.sanctionType
      return type === 'expulsion'
    }).map(s => ({ player: s.payload?.playerNumber || s.payload?.player, position: s.payload?.position }))

    const disqualifications = teamSanctions.filter(s => {
      const type = s.payload?.type || s.payload?.sanctionType
      return type === 'disqualification'
    }).map(s => ({ player: s.payload?.playerNumber || s.payload?.player, position: s.payload?.position }))

    return {
      formalWarning: teamSanctions.some(s =>
        (s.payload?.type === 'warning' || s.payload?.sanctionType === 'warning') &&
        (s.payload?.playerType === 'team' || s.payload?.isTeamWarning)
      ),
      improperRequest: teamSanctions.some(s =>
        s.payload?.type === 'improper_request' || s.payload?.sanctionType === 'improper_request'
      ),
      delayWarning: teamSanctions.some(s =>
        (s.payload?.type === 'delay_warning' || s.payload?.sanctionType === 'delay_warning') ||
        ((s.payload?.type === 'warning' || s.payload?.sanctionType === 'warning') &&
         (String(s.payload?.playerNumber) === 'D' || String(s.payload?.player) === 'D'))
      ),
      delayPenalty: teamSanctions.some(s =>
        (s.payload?.type === 'delay_penalty' || s.payload?.sanctionType === 'delay_penalty') ||
        ((s.payload?.type === 'penalty' || s.payload?.sanctionType === 'penalty') &&
         (String(s.payload?.playerNumber) === 'D' || String(s.payload?.player) === 'D'))
      ),
      benchSanctions: teamSanctions.filter(s =>
        s.payload?.playerType === 'bench' || s.payload?.playerType === 'official'
      ),
      playerWarnings,
      playerPenalties,
      expulsions,
      disqualifications
    }
  }, [data?.events])

  const leftTeamSanctions = getTeamSanctions(leftTeam)
  const rightTeamSanctions = getTeamSanctions(rightTeam)

  // Get libero on court for a team - returns { position, liberoNumber, liberoType, playerNumber } or null
  const getLiberoOnCourt = useCallback((teamKey) => {
    if (!data?.events || !data?.currentSet) return null

    const currentSetEvents = data.events.filter(e => e.setIndex === data.currentSet.index)
    const lineupEvents = currentSetEvents
      .filter(e => e.type === 'lineup' && e.payload?.team === teamKey)
      .sort((a, b) => (a.seq || 0) - (b.seq || 0))

    if (lineupEvents.length === 0) return null

    const latestLineup = lineupEvents[lineupEvents.length - 1]
    const currentLineup = latestLineup?.payload?.lineup || {}
    const liberoSub = latestLineup?.payload?.liberoSubstitution

    // Get initial lineup (marked with isInitial: true)
    const initialLineupEvent = lineupEvents.find(e => e.payload?.isInitial === true)
    const initialLineup = initialLineupEvent?.payload?.lineup || {}

    const teamPlayers = teamKey === 'home' ? data.homePlayers : data.awayPlayers

    // Check each position to find if a libero is there
    for (const [position, posData] of Object.entries(currentLineup)) {
      // Handle both rich format (posData is object with number) and legacy format (posData is number)
      const playerNum = typeof posData === 'object' && posData?.number !== undefined ? posData.number : posData
      const player = teamPlayers?.find(p => String(p.number) === String(playerNum))
      if (player && (player.libero === 'libero1' || player.libero === 'libero2')) {
        // Found a libero on court - try to find which player they replaced
        let replacedPlayer = liberoSub?.playerNumber

        if (!replacedPlayer) {
          // Look through lineup history to find the original player at this position
          for (let i = lineupEvents.length - 2; i >= 0; i--) {
            const prevLineup = lineupEvents[i]?.payload?.lineup
            if (prevLineup && prevLineup[position]) {
              const prevPosData = prevLineup[position]
              const prevNum = typeof prevPosData === 'object' && prevPosData?.number !== undefined ? prevPosData.number : prevPosData
              const prevPlayer = teamPlayers?.find(p => String(p.number) === String(prevNum))
              if (prevPlayer && prevPlayer.libero !== 'libero1' && prevPlayer.libero !== 'libero2') {
                replacedPlayer = prevPlayer.number
                break
              }
            }
          }
        }

        // Fallback: Check initial lineup for who was at this position
        if (!replacedPlayer && initialLineup[position]) {
          const initPosData = initialLineup[position]
          const initNum = typeof initPosData === 'object' && initPosData?.number !== undefined ? initPosData.number : initPosData
          const initialPlayer = teamPlayers?.find(p => String(p.number) === String(initNum))
          if (initialPlayer && initialPlayer.libero !== 'libero1' && initialPlayer.libero !== 'libero2') {
            replacedPlayer = initialPlayer.number
          }
        }

        return {
          position,
          liberoNumber: player.number,
          liberoType: player.libero,
          playerNumber: replacedPlayer
        }
      }
    }

    return null
  }, [data?.events, data?.currentSet, data?.homePlayers, data?.awayPlayers])

  // Get substitution info for a player on court - returns { replacedNumber } or null
  const getSubstitutionInfo = useCallback((teamKey, playerNumber) => {
    if (!data?.events || !data?.currentSet) return null
    
    const currentSetSubs = data.events
      .filter(e => e.type === 'substitution' && e.payload?.team === teamKey && e.setIndex === data.currentSet.index)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))

    // Find if this player came in as a substitute
    const subIn = currentSetSubs.find(s => String(s.payload?.playerIn) === String(playerNumber))
    if (subIn) {
      return { replacedNumber: subIn.payload?.playerOut }
    }
    
    return null
  }, [data?.events, data?.currentSet])

  // Get sanctions for a player
  const getPlayerSanctions = useCallback((teamKey, playerNumber) => {
    if (!data?.events || !playerNumber) return []

    return data.events.filter(e =>
      e.type === 'sanction' &&
      e.payload?.team === teamKey &&
      (String(e.payload?.player) === String(playerNumber) || String(e.payload?.playerNumber) === String(playerNumber))
    )
  }, [data?.events])

  // Helper to determine if a color is bright
  const isBrightColor = (color) => {
    if (!color) return false
    const hex = color.replace('#', '')
    const r = parseInt(hex.substr(0, 2), 16)
    const g = parseInt(hex.substr(2, 2), 16)
    const b = parseInt(hex.substr(4, 2), 16)
    const brightness = (r * 299 + g * 587 + b * 114) / 1000
    return brightness > 155
  }

  // Get setter position (P1-P6) based on current lineup
  const getSetterPosition = useCallback((lineup, setterNum) => {
    if (!lineup || !setterNum) return null
    for (const [position, posData] of Object.entries(lineup)) {
      // Handle both rich format (posData is object with number) and legacy format (posData is number)
      const playerNum = typeof posData === 'object' && posData?.number !== undefined ? posData.number : posData
      if (String(playerNum) === String(setterNum)) {
        // Convert position (I, II, III, IV, V, VI) to P number (1-6)
        const posMap = { 'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6 }
        return posMap[position] || null
      }
    }
    return null
  }, [])

  // Reception formation positions based on setter position (P1-P6)
  // Positions are percentages: { top: %, left: % } from court perspective (net at top)
  // These are for a SINGLE side court view - approved from visualization
  const getReceptionFormation = useCallback((setterPos) => {
    // Standard positions for when no advanced mode
    const standard = {
      I: { top: 85, left: 85 },   // Back right
      II: { top: 15, left: 85 },  // Front right
      III: { top: 15, left: 50 }, // Front middle
      IV: { top: 15, left: 15 },  // Front left
      V: { top: 85, left: 15 },   // Back left
      VI: { top: 85, left: 50 }   // Back middle
    }

    if (!setterPos) return standard

    // Reception formations based on setter position (approved from visualization)
    const formations = {
      // P1: Setter in position I (back right corner)
      1: {
        I: { top: 88, left: 88 },   // Setter: back right corner
        II: { top: 70, left: 80 },  // Next to setter (top-left of I)
        III: { top: 28, left: 50 }, // 3m line, middle
        IV: { top: 28, left: 15 },  // 3m line, left
        V: { top: 80, left: 15 },   // Bottom left
        VI: { top: 78, left: 50 }   // Between II and V
      },
      // P2: Setter in position II (front right at net)
      2: {
        I: { top: 70, left: 85 },   // Back right area
        II: { top: 12, left: 88 },  // Setter: at net, right
        III: { top: 28, left: 50 }, // 3m line, middle
        IV: { top: 70, left: 15 },  // Same line as I and VI
        V: { top: 88, left: 40 },   // Back, beneath IV and VI
        VI: { top: 70, left: 50 }   // Same line as IV and I
      },
      // P3: Setter in position III (front middle at net)
      3: {
        I: { top: 70, left: 82 },   // Back right
        II: { top: 12, left: 82 },  // Front right at net
        III: { top: 13, left: 50 }, // Setter: at net, middle
        IV: { top: 67, left: 15 },  // Dropped back left
        V: { top: 70, left: 45 },   // Back center-left
        VI: { top: 88, left: 60 }   // Back, towards end line
      },
      // P4: Setter in position IV (front left at net)
      4: {
        I: { top: 88, left: 88 },   // Back right corner
        II: { top: 70, left: 35 },  // Dropped back
        III: { top: 40, left: 25 }, // Diagonally between IV and II
        IV: { top: 12, left: 15 },  // Setter: at net, left
        V: { top: 70, left: 55 },   // Back middle
        VI: { top: 70, left: 75 }   // Back right area
      },
      // P5: Setter in position V (back left, penetrating)
      5: {
        I: { top: 75, left: 82 },   // Back right
        II: { top: 12, left: 85 },  // Front right at net
        III: { top: 75, left: 35 }, // Dropped back for passing
        IV: { top: 12, left: 15 },  // Front left at net
        V: { top: 42, left: 33 },   // Setter: back left, penetrating
        VI: { top: 75, left: 58 }   // Back middle
      },
      // P6: Setter in position VI (back middle, penetrating)
      6: {
        I: { top: 78, left: 82 },   // Back right
        II: { top: 25, left: 82 },  // Towards 3m line
        III: { top: 12, left: 50 }, // At net, middle
        IV: { top: 72, left: 18 },  // Dropped back left
        V: { top: 78, left: 44 },   // Back center-left
        VI: { top: 42, left: 59 }   // Setter: penetrating from back middle
      }
    }

    return formations[setterPos] || standard
  }, [])

  // Get formation positions with custom overrides
  const getFormationWithCustom = useCallback((side, setterPos) => {
    const baseFormation = getReceptionFormation(setterPos)
    const setIndex = data?.currentSet?.index || 1
    const customPositions = customFormations[setIndex]?.[side]

    if (!customPositions) return baseFormation

    // Merge custom positions with base formation
    const merged = { ...baseFormation }
    for (const [pos, coords] of Object.entries(customPositions)) {
      if (coords) {
        merged[pos] = coords
      }
    }
    return merged
  }, [getReceptionFormation, customFormations, data?.currentSet?.index])

  // Re-enable wake lock (call this when entering fullscreen or on user interaction)
  const reEnableWakeLock = useCallback(async () => {
    // Try native Wake Lock API
    try {
      if ('wakeLock' in navigator) {
        if (wakeLockRef.current) {
          try { await wakeLockRef.current.release() } catch (e) {}
        }
        wakeLockRef.current = await navigator.wakeLock.request('screen')
        console.log('[WakeLock] Re-acquired wake lock')
        setWakeLockActive(true)
        wakeLockRef.current.addEventListener('release', () => {
          console.log('[WakeLock] Released')
        })
        return true
      }
    } catch (err) {
      console.log('[WakeLock] Failed to re-acquire:', err.message)
    }
    return false
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
      setWakeLockActive(false)
      console.log('[WakeLock] Manually disabled')
    } else {
      // Enable wake lock
      const success = await reEnableWakeLock()
      if (success) {
        console.log('[WakeLock] Manually enabled')
      } else {
        console.log('[WakeLock] Failed to enable manually - Wake Lock API may not be supported')
        // Show visual feedback that it's "on" even if API failed
        setWakeLockActive(true)
      }
    }
  }, [wakeLockActive, reEnableWakeLock])

  // Fullscreen handlers
  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
        setIsFullscreen(true)
        // Re-enable wake lock when entering fullscreen
        setTimeout(() => reEnableWakeLock(), 500)
      } else {
        await document.exitFullscreen()
        setIsFullscreen(false)
      }
    } catch (error) {
      console.error('Error toggling fullscreen:', error)
    }
  }, [reEnableWakeLock])

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFs = !!document.fullscreenElement
      setIsFullscreen(isFs)
      // Re-enable wake lock when entering fullscreen
      if (isFs) {
        reEnableWakeLock()
    }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [reEnableWakeLock])

  // Periodically re-enable wake lock in fullscreen mode (every 2 minutes)
  useEffect(() => {
    if (!isFullscreen) return
    
    const interval = setInterval(() => {
      reEnableWakeLock()
    }, 120000) // Every 2 minutes
    
    return () => clearInterval(interval)
  }, [isFullscreen, reEnableWakeLock])

  // Format countdown
  // Detect if we're between sets (previous set finished but current set not started)
  const isBetweenSets = useMemo(() => {
    if (!data?.sets || !data?.set) return false
    
    const currentSetIndex = data.set.index
    if (currentSetIndex <= 1) return false
    
    const previousSet = data.sets.find(s => s.index === currentSetIndex - 1)
    if (!previousSet || !previousSet.finished) return false
    
    // Check if current set has started (has points or set_start event)
    const hasSetStarted = data.events?.some(e =>
      (e.type === 'point' || e.type === 'set_start') && e.setIndex === currentSetIndex
    )
    
    return !hasSetStarted
  }, [data?.sets, data?.set, data?.events])

  // Check if this is the first rally of the set (no points scored yet)
  const isFirstRally = useMemo(() => {
    if (!data?.events || !data?.set) return true
    const hasPoints = data.events.some(e => e.type === 'point' && e.setIndex === data.set.index)
    return !hasPoints
  }, [data?.events, data?.set])

  // Start between-sets countdown when we detect we're between sets
  useEffect(() => {
    // Only start countdown if between sets AND countdown hasn't been started yet (null means never started)
    if (isBetweenSets && betweenSetsCountdown === null) {
      setBetweenSetsCountdown({ countdown: 180, started: true }) // 3 minutes = 180 seconds
      setShowIntervalModal(true) // Show the modal overlay
    } else if (!isBetweenSets) {
      // Reset to null only when no longer between sets (new set started)
      setBetweenSetsCountdown(null)
      setShowIntervalModal(false) // Hide the modal when set starts
    }
  }, [isBetweenSets]) // Remove betweenSetsCountdown from deps to prevent restart loop

  // Handle between-sets countdown timer
  useEffect(() => {
    if (!betweenSetsCountdown || !betweenSetsCountdown.started) return
    
    // Don't set interval if already at 0
    if (betweenSetsCountdown.countdown <= 0) return
    
    const timer = setInterval(() => {
      setBetweenSetsCountdown(prev => {
        if (!prev || !prev.started) return prev
        const newCountdown = prev.countdown - 1
        if (newCountdown <= 0) {
          // Stay at 0, don't reset to null
          return { countdown: 0, started: false }
        }
        return { ...prev, countdown: newCountdown }
      })
    }, 1000)
    
    return () => clearInterval(timer)
  }, [betweenSetsCountdown])

  // Calculate set results for Results component (must be before early return)
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

  // Check if match is waiting for coin toss (status is 'setup' or no data yet)
  // This must be checked BEFORE the !data return to show awaiting screen
  // A match is awaiting coin toss if: no data, status is 'setup', OR (no firstServe AND no coinTossTeamA AND not master mode AND no currentSet)
  const coinTossConfirmed = data?.match?.firstServe || data?.match?.coinTossTeamA || data?.match?.coin_toss_confirmed
  const isAwaitingCoinToss = !data || data?.match?.status === 'setup' || (!coinTossConfirmed && !isMasterMode && !data?.currentSet)

  // Show awaiting coin toss screen when connected but no match data yet
  if (isAwaitingCoinToss && !isMasterMode && realtimeStatus === CONNECTION_STATUS.CONNECTED) {
    return (
      <div style={{
        height: '100vh',
        width: '100vw',
        maxWidth: '800px',
        margin: '0 auto',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        display: 'flex',
        flexDirection: 'column'
      }}>
        {/* Header - same as main view */}
        <div style={{
          height: '40px',
          minHeight: '40px',
          maxHeight: '40px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 12px',
          background: 'rgba(0, 0, 0, 0.3)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={toggleFullscreen}
              style={{
                padding: '4px 10px',
                fontSize: '11px',
                fontWeight: 600,
                background: 'rgba(255,255,255,0.1)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              {isFullscreen ? `⛶ ${t('refereeDashboard.exitFullscreen')}` : '⛶'}
            </button>

            <button
              onClick={toggleWakeLock}
              style={{
                padding: '2px 8px',
                fontSize: '9px',
                fontWeight: 600,
                background: wakeLockActive ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255,255,255,0.1)',
                color: wakeLockActive ? '#22c55e' : '#fff',
                border: wakeLockActive ? '1px solid rgba(34, 197, 94, 0.5)' : '1px solid rgba(255,255,255,0.2)',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
              title={wakeLockActive ? t('refereeDashboard.screenWillStayOn') : t('refereeDashboard.screenMayTurnOff')}
            >
              {wakeLockActive ? `☀️ ${t('refereeDashboard.wakeLockOn')}` : `🌙 ${t('refereeDashboard.wakeLockOff')}`}
            </button>

            <ConnectionStatus
              connectionStatuses={connectionStatuses}
              connectionDebugInfo={{
                ...connectionDebugInfo,
                match: {
                  ...connectionDebugInfo?.match,
                  matchId: matchId,
                  homeTeam: data?.homeTeam?.name,
                  awayTeam: data?.awayTeam?.name
                }
              }}
              position="right"
              size="small"
            />
          </div>

          {/* Center - Refresh Button */}
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <button
              onClick={fetchFreshData}
              style={{
                padding: '6px 16px',
                fontSize: '12px',
                fontWeight: 600,
                background: 'rgba(59, 130, 246, 0.2)',
                color: '#3b82f6',
                border: '1px solid rgba(59, 130, 246, 0.4)',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
              title={t('refereeDashboard.refresh')}
            >
              🔄 {window.innerWidth >= 500 && t('refereeDashboard.refresh')}
            </button>
          </div>

          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            {/* Version */}
            <span style={{ fontSize: '10px', color: 'rgba(255, 255, 255, 0.5)' }}>
              v{currentVersion}
            </span>
            {/* Exit Button with Icon */}
            <button
              onClick={onExit}
              style={{
                padding: '4px 8px',
                fontSize: '14px',
                fontWeight: 600,
                background: 'rgba(239, 68, 68, 0.2)',
                color: '#ef4444',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: '4px',
                cursor: 'pointer',
                lineHeight: 1
              }}
              title="Exit"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '24px',
          padding: '20px'
        }}>
          {/* Team names if available */}
          {data?.homeTeam?.name && data?.awayTeam?.name && (
            <div style={{
              fontSize: 'clamp(18px, 4vw, 28px)',
              fontWeight: 700,
              textAlign: 'center',
              marginBottom: '16px'
            }}>
              {data.homeTeam.name} vs {data.awayTeam.name}
            </div>
          )}

          {/* Awaiting Coin Toss Message */}
          <div style={{
            fontSize: 'clamp(20px, 5vw, 32px)',
            fontWeight: 600,
            color: '#fbbf24',
            textAlign: 'center',
            textTransform: 'uppercase',
            letterSpacing: '2px'
          }}>
            {t('refereeDashboard.awaitingCoinToss', 'Awaiting Coin Toss')}
          </div>

          <div style={{
            fontSize: 'clamp(14px, 3vw, 18px)',
            color: 'rgba(255, 255, 255, 0.7)',
            textAlign: 'center',
            maxWidth: '400px'
          }}>
            {t('refereeDashboard.awaitingCoinTossDesc', 'The match will begin once the coin toss has been confirmed on the scoresheet.')}
          </div>

          {/* Loading indicator */}
          <div style={{
            width: '40px',
            height: '40px',
            border: '3px solid rgba(255, 255, 255, 0.2)',
            borderTopColor: '#fbbf24',
            borderRadius: '50%',
            animation: 'awaiting-spin 1s linear infinite'
          }} />

          {/* Debug State Info */}
          <div style={{
            marginTop: '24px',
            padding: '12px',
            background: 'rgba(0, 0, 0, 0.4)',
            borderRadius: '8px',
            fontSize: '11px',
            fontFamily: 'monospace',
            color: 'rgba(255, 255, 255, 0.6)',
            textAlign: 'left',
            maxWidth: '400px',
            width: '100%'
          }}>
            <div style={{ fontWeight: 600, marginBottom: '8px', color: '#fbbf24' }}>Debug State:</div>
            <div>data: {data ? 'exists' : 'null'}</div>
            <div>match.status: {data?.match?.status || 'N/A'}</div>
            <div>match.firstServe: {data?.match?.firstServe || 'N/A'}</div>
            <div>match.coinTossTeamA: {data?.match?.coinTossTeamA || 'N/A'}</div>
            <div>match.coin_toss_confirmed: {String(data?.match?.coin_toss_confirmed)}</div>
            <div>coinTossConfirmed: {String(!!coinTossConfirmed)} (value: {JSON.stringify(coinTossConfirmed)})</div>
            <div>currentSet: {data?.currentSet?.index || 'N/A'}</div>
            <div>isMasterMode: {String(isMasterMode)}</div>
            <div>realtimeStatus: {realtimeStatus}</div>
            <div>activeConnection: {activeConnection || 'none'}</div>
          </div>
        </div>

        <style>{`
          @keyframes awaiting-spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    )
  }

  if (!data) return null

  // Player circle component - BIG responsive sizing with all indicators
  // positionData: for rich format this is { number, isServing, isLibero, replacedNumber, isSubstituted, substitutedFor, hasSanction, sanctions, isCaptain, isCourtCaptain }
  //               for legacy format this is just a number
  const PlayerCircle = ({ number: legacyNumber, positionData, position, team, isServing: legacyIsServing }) => {
    // Support both rich format (positionData) and legacy format (number)
    // Rich format: positionData is { number, isServing, isLibero, ... }
    // Legacy format: positionData is just a number (or undefined, using legacyNumber)
    let isRichFormat = positionData && typeof positionData === 'object' && positionData.number !== undefined

    // Extract number - ensure it's always a primitive, never an object
    let number = isRichFormat ? positionData.number : (positionData || legacyNumber)

    // Extra safety: if positionData was passed as a number but we're in legacy mode,
    // but that "number" is actually an object (edge case from malformed data), handle it
    if (number && typeof number === 'object' && number.number !== undefined) {
      // The "number" is actually rich format data that wasn't detected
      isRichFormat = true
      positionData = number
      number = number.number
    }

    if (!number) return null

    const teamPlayers = team === 'home' ? data.homePlayers : data.awayPlayers
    const player = teamPlayers?.find(p => String(p.number) === String(number))

    // For rich format, use embedded data; for legacy, compute from player lookup and functions
    let isLibero, shouldShowBall, liberoReplacedPlayer, isSubstituted, substitutedFor
    let hasWarning, hasPenalty, hasExpulsion, hasDisqualification
    let isCaptain, isCourtCaptain

    if (isRichFormat) {
      // Rich format - all data is embedded in positionData
      isLibero = positionData.isLibero || false
      shouldShowBall = position === 'I' && positionData.isServing
      liberoReplacedPlayer = isLibero ? positionData.replacedNumber : null
      isSubstituted = positionData.isSubstituted || false
      substitutedFor = positionData.substitutedFor || null
      isCaptain = positionData.isCaptain || false
      isCourtCaptain = positionData.isCourtCaptain || false

      // Sanctions from rich format
      const sanctions = positionData.sanctions || []
      hasWarning = sanctions.some(s => s.type === 'warning')
      hasPenalty = sanctions.some(s => s.type === 'penalty')
      hasExpulsion = sanctions.some(s => s.type === 'expulsion')
      hasDisqualification = sanctions.some(s => s.type === 'disqualification')
    } else {
      // Legacy format - compute from player data and helper functions
      isLibero = player?.libero === 'libero1' || player?.libero === 'libero2'
      shouldShowBall = position === 'I' && legacyIsServing

      // Get libero info - if this is a libero, show which player they replaced
      const liberoOnCourt = getLiberoOnCourt(team)
      liberoReplacedPlayer = isLibero && liberoOnCourt?.playerNumber ? liberoOnCourt.playerNumber : null

      // Get substitution info - if this player came in as a substitute
      const subInfo = !isLibero ? getSubstitutionInfo(team, number) : null
      isSubstituted = !!subInfo
      substitutedFor = subInfo?.replacedNumber || null

      // Get sanctions for this player
      const sanctions = getPlayerSanctions(team, number)
      hasWarning = sanctions.some(s => s.payload?.type === 'warning')
      hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
      hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
      hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')

      // Check if this player is captain or court captain
      const teamCaptain = team === 'home' ? data.match?.homeCaptain : data.match?.awayCaptain
      const teamCourtCaptain = team === 'home' ? data.match?.homeCourtCaptain : data.match?.awayCourtCaptain
      isCaptain = player?.isCaptain || player?.captain || (teamCaptain && String(teamCaptain) === String(number))
      isCourtCaptain = !isCaptain && teamCourtCaptain && String(teamCourtCaptain) === String(number)
    }

    // Check if this player was recently substituted in (for flashing effect)
    const isRecentlySub = recentlySubstitutedPlayers.some(
      sub => sub.team === team && String(sub.playerNumber) === String(number)
    )

    // Determine what to show in top-right badge
    // Ensure badge values are primitives (not objects)
    const safeBadgeValue = (val) => {
      if (val && typeof val === 'object' && val.number !== undefined) return val.number
      return val
    }
    const topRightBadge = safeBadgeValue(liberoReplacedPlayer) || safeBadgeValue(substitutedFor) || null
    const isLiberoReplacementBadge = !!liberoReplacedPlayer

    // Get libero label for bottom-left
    const liberoLabel = isLibero ? (player?.libero === 'libero1' ? 'L1' : 'L2') : null
    const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
    const displayLiberoLabel = isLibero ? (liberoCount === 1 ? 'L' : liberoLabel) : null

    const showCaptainBadge = isCaptain || isCourtCaptain // Liberos can be captains too
    const isLiberoCaptain = isLibero && isCaptain // Special styling for libero who is also captain

    return (
      <div style={{
          position: 'relative',
        width: 'fit-content',
        aspectRatio: '1/1',
        padding: '4px',
        border: isRecentlySub ? '3px solid #22c55e' : '1px solid rgba(255, 255, 255, 0.4)',
        borderRadius: '50%',
        background: isRecentlySub ? '#86efac' : isLibero ? '#FFF8E7' : (team === leftTeam ? 'rgba(65, 66, 68, 0.9)' : 'rgba(12, 14, 100, 0.7)'),
          color: isRecentlySub ? '#000' : isLibero ? '#000' : '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 'clamp(33px, 9vw, 64px)',
        fontWeight: isRecentlySub ? 900 : 700,
        boxShadow: '0 3px 12px rgba(0, 0, 0, 0.5)',
        flexShrink: 0,
        animation: isRecentlySub ? 'recentSubFlash 0.5s ease-in-out infinite' : undefined
      }}>
        {/* Serve ball indicator */}
        {shouldShowBall && (
          <img
            src={mikasaVolleyball}
            alt="Ball"
            style={{
              position: 'absolute',
              // Position outside player box with 4px gap - responsive to box size
              left: team === rightTeam ? 'calc(100% + 4px)' : 'auto',
              right: team === leftTeam ? 'calc(100% + 4px)' : 'auto',
              top: '50%',
              transform: 'translateY(-50%)',
              width: 'clamp(12px, 5vw, 40px)',
              aspectRatio: '1/1',
              filter: 'drop-shadow(0 3px 8px rgba(0, 0, 0, 0.5))'
            }}
          />
        )}
        
        {/* Top-left: Position badge */}
        <span style={{
          position: 'absolute',
          top: '-6px',
          left: '-6px',
          width: 'clamp(16px, 4vw, 22px)',
          height: 'clamp(16px, 4vw, 22px)',
          background: 'rgba(15, 23, 42, 0.95)',
          border: '2px solid rgba(255, 255, 255, 0.5)',
          borderRadius: '4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 'clamp(9px, 2vw, 12px)',
          fontWeight: 700,
          color: '#fff'
        }}>
          {position}
        </span>
        
        {/* Top-right: Replaced player badge (white for libero replacement, yellow for substitution) */}
        {topRightBadge && (
          <span style={{
            position: 'absolute',
            top: '-6px',
            right: '-6px',
            minWidth: 'clamp(16px, 4vw, 22px)',
            height: 'clamp(16px, 4vw, 22px)',
            padding: '0 3px',
            background: isLiberoReplacementBadge ? '#ffffff' : '#fde047',
            border: isLiberoReplacementBadge ? '2px solid rgba(0, 0, 0, 0.3)' : '2px solid rgba(0, 0, 0, 0.25)',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 'clamp(9px, 2vw, 12px)',
            fontWeight: 700,
            color: '#0f172a',
            boxShadow: '0 2px 4px rgba(0, 0, 0, 0.25)'
          }}>
            {topRightBadge}
              </span>
        )}
        
        {/* Bottom-left: Libero indicator (L, L1, L2) - hide if libero-captain (only show C) */}
        {displayLiberoLabel && !isLiberoCaptain && (
          <span style={{
              position: 'absolute',
            bottom: '-6px',
            left: '-6px',
            minWidth: 'clamp(16px, 4vw, 22px)',
            height: 'clamp(16px, 4vw, 22px)',
            padding: '0 3px',
            background: '#3b82f6',
            border: '2px solid rgba(255, 255, 255, 0.3)',
            borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            fontSize: 'clamp(9px, 2vw, 12px)',
              fontWeight: 700,
            color: '#fff'
            }}>
            {displayLiberoLabel}
          </span>
        )}
        {/* Captain badge (C) - show for captains including libero-captains */}
        {showCaptainBadge && (
          <span style={{
            position: 'absolute',
            bottom: '-6px',
            // If libero but not libero-captain, position next to L badge; otherwise position at left
            left: (isLibero && !isLiberoCaptain) ? 'calc(clamp(16px, 4vw, 22px) + 2px)' : '-6px',
            minWidth: 'clamp(16px, 4vw, 22px)',
            height: 'clamp(16px, 4vw, 22px)',
            padding: '0 3px',
            // Libero-captain: green C on white bg; Regular captain: black bg with green border/text; Court captain: amber
            background: isLiberoCaptain ? '#ffffff' : 'rgba(15, 23, 42, 0.95)',
            border: isLiberoCaptain ? '2px solid #22c55e' : (isCaptain ? '2px solid #22c55e' : '2px solid #fbbf24'),
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 'clamp(9px, 2vw, 12px)',
            fontWeight: 700,
            // Libero-captain: green on white; Regular captain: green on black; Court captain: amber
            color: isLiberoCaptain ? '#22c55e' : (isCaptain ? '#22c55e' : '#fbbf24')
          }}>
            C
          </span>
        )}

        {/* Bottom-right: Sanction indicators - same height as corner badges */}
        {(hasWarning || hasPenalty || hasExpulsion || hasDisqualification) && (
          <div style={{
            position: 'absolute',
            bottom: '-6px',
            right: '-6px',
            display: 'flex',
            gap: '2px',
            background: 'rgba(0, 0, 0, 0.6)',
            padding: '2px 4px',
            borderRadius: '4px',
            height: 'clamp(16px, 4vw, 22px)',
            alignItems: 'center'
          }}>
            {hasWarning && (
              <div style={{ width: 'clamp(10px, 2.5vw, 14px)', height: 'clamp(14px, 3.5vw, 20px)', background: '#fde047', borderRadius: '2px' }} />
            )}
            {(hasPenalty || hasDisqualification) && (
              <div style={{ width: 'clamp(10px, 2.5vw, 14px)', height: 'clamp(14px, 3.5vw, 20px)', background: '#ef4444', borderRadius: '2px' }} />
            )}
            {hasExpulsion && (
              <div style={{ display: 'flex', gap: '1px' }}>
                <div style={{ width: 'clamp(8px, 2vw, 11px)', height: 'clamp(14px, 3.5vw, 20px)', background: '#fde047', borderRadius: '2px' }} />
                <div style={{ width: 'clamp(8px, 2vw, 11px)', height: 'clamp(14px, 3.5vw, 20px)', background: '#ef4444', borderRadius: '2px' }} />
              </div>
            )}
          </div>
        )}
        
        {/* Player number */}
        {number}
      </div>
    )
  }

  // Check if match is finished
  const isMatchFinished = setScore.home === 3 || setScore.away === 3

  // Match finished info
  const matchWinner = isMatchFinished && data
    ? (setScore.home > setScore.away
        ? (data.homeTeam?.name || 'Home')
        : (data.awayTeam?.name || 'Away'))
    : ''

  const matchResult = isMatchFinished
    ? `3:${Math.min(setScore.home, setScore.away)}`
    : ''

  // Team A/B short names for Results table (always available)
  const teamAShortName = data?.match?.coinTossTeamA === 'home'
    ? (data?.match?.homeShortName || data?.homeTeam?.shortName || data?.homeTeam?.name || 'Home')
    : (data?.match?.awayShortName || data?.awayTeam?.shortName || data?.awayTeam?.name || 'Away')
  const teamBShortName = data?.match?.coinTossTeamA === 'home'
    ? (data?.match?.awayShortName || data?.awayTeam?.shortName || data?.awayTeam?.name || 'Away')
    : (data?.match?.homeShortName || data?.homeTeam?.shortName || data?.homeTeam?.name || 'Home')

  // Show results when match is finished
  if (isMatchFinished) {
    return (
      <div style={{
        height: '100vh',
        width: '100vw',
        maxWidth: '800px',
        margin: '0 auto',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '24px',
        padding: '20px'
      }}>
        {/* Match Ended Banner */}
        <div style={{
          fontSize: '18px',
          fontWeight: 500,
          color: 'rgba(255, 255, 255, 0.7)',
          textTransform: 'uppercase',
          letterSpacing: '2px'
        }}>
          {t('refereeDashboard.matchHasEnded', 'The match has ended')}
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
            coinTossConfirmed={!!data?.match?.coinTossTeamA}
          />
        </div>

        <button
          onClick={onExit}
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
        >
          Exit
        </button>
      </div>
    )
  }

  return (
    <div style={{
      height: '100vh',
      width: '100vw',
      maxWidth: '800px',
      margin: '0 auto',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    }}>
      {/* Debug overlay - triple-tap to show */}
      {!isMasterMode && <WsDebugOverlay matchId={matchId} />}

      {/* Between Sets Countdown Modal */}
      {showIntervalModal && betweenSetsCountdown && (
        <div
          onClick={() => setShowIntervalModal(false)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.9)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
            zIndex: 9996,
            cursor: 'pointer'
          }}
        >
          <div style={{
            background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
            borderRadius: '24px',
            padding: '48px 64px',
            border: '2px solid rgba(255, 255, 255, 0.1)',
            textAlign: 'center',
            maxWidth: '90vw'
        }}>
          <div style={{
              fontSize: 'clamp(24px, 6vw, 40px)',
              fontWeight: 700,
              marginBottom: '24px',
              color: '#fbbf24',
              textTransform: 'uppercase',
              letterSpacing: '2px'
            }}>
              ⏱️ SET INTERVAL
            </div>
            <div style={{
              fontSize: 'clamp(60px, 20vw, 120px)',
            fontWeight: 800,
              fontVariantNumeric: 'tabular-nums',
              color: betweenSetsCountdown.countdown <= 30 ? '#ef4444' : '#fff',
            lineHeight: 1
          }}>
              {Math.floor(betweenSetsCountdown.countdown / 60)}:{String(betweenSetsCountdown.countdown % 60).padStart(2, '0')}
          </div>
            <div style={{
              marginTop: '24px',
              fontSize: '14px',
              color: 'rgba(255, 255, 255, 0.5)'
            }}>
              Tap anywhere to close
            </div>
          </div>
        </div>
      )}

      {/* Timeout Modal (from Scoreboard action) */}
      {showTimeoutModal && timeoutModal && timeoutModal.started && (
        <div
          onClick={() => setShowTimeoutModal(false)}
            style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9998,
              cursor: 'pointer'
            }}
          >
          <div style={{
            background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
            borderRadius: '24px',
            padding: '48px 64px',
            textAlign: 'center',
            border: '2px solid rgba(251, 146, 60, 0.5)',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
          }}>
            <div style={{
              fontSize: '18px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '2px',
              color: '#fb923c',
              marginBottom: '16px'
            }}>
              ⏱️ Timeout
        </div>
        <div style={{
              fontSize: '14px',
              color: 'rgba(255, 255, 255, 0.7)',
              marginBottom: '24px'
            }}>
              {timeoutModal.team === 'home' ? (data?.homeTeam?.shortName || data?.homeTeam?.name || 'Home') : (data?.awayTeam?.shortName || data?.awayTeam?.name || 'Away')}
            </div>
        <div style={{
              fontSize: 'clamp(60px, 20vw, 120px)',
              fontWeight: 800,
              fontVariantNumeric: 'tabular-nums',
              color: timeoutModal.countdown <= 10 ? '#ef4444' : '#fb923c',
              lineHeight: 1
        }}>
              {timeoutModal.countdown}"
            </div>
            <div style={{
              marginTop: '24px',
              fontSize: '14px',
              color: 'rgba(255, 255, 255, 0.5)'
            }}>
              Tap anywhere to close
            </div>
          </div>
        </div>
      )}

      {/* Setter Selection Modal for Advanced Mode */}
      {setterSelectionModal && (
        <div
          onClick={() => setSetterSelectionModal(null)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            cursor: 'pointer'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
              borderRadius: '24px',
              padding: '32px',
              textAlign: 'center',
              border: '2px solid rgba(139, 92, 246, 0.5)',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
              minWidth: '320px',
              maxWidth: '90vw',
              maxHeight: '80vh',
              overflow: 'auto'
            }}
          >
            <div style={{
              fontSize: '18px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '2px',
              color: '#8b5cf6',
              marginBottom: '8px'
            }}>
              🏐 Select Setter
            </div>
            <div style={{
              fontSize: '14px',
              color: 'rgba(255, 255, 255, 0.7)',
              marginBottom: '24px'
            }}>
              {setterSelectionModal === 'left' ? leftTeamData?.name : rightTeamData?.name}
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '12px',
              marginBottom: '20px'
            }}>
              {(() => {
                const teamLineup = setterSelectionModal === 'left' ? leftLineup : rightLineup
                const currentSetter = setterSelectionModal === 'left' ? setterNumber.left : setterNumber.right
                if (!teamLineup) return <div style={{ gridColumn: '1/-1', color: 'rgba(255,255,255,0.5)' }}>No lineup available</div>

                return Object.entries(teamLineup).map(([position, posData]) => {
                  // Handle both rich format (posData is object with number) and legacy format (posData is number)
                  const playerNum = typeof posData === 'object' && posData?.number !== undefined ? posData.number : posData
                  return (
                  <button
                    key={position}
                    onClick={() => {
                      const side = setterSelectionModal
                      setSetterNumber(prev => ({ ...prev, [side]: playerNum }))
                      setAdvancedMode(prev => ({ ...prev, [side]: true }))
                      setSetterSelectionModal(null)
                    }}
                    style={{
                      padding: '16px 12px',
                      fontSize: '20px',
                      fontWeight: 700,
                      background: String(playerNum) === String(currentSetter)
                        ? 'rgba(139, 92, 246, 0.4)'
                        : 'rgba(255, 255, 255, 0.1)',
                      color: String(playerNum) === String(currentSetter) ? '#a78bfa' : '#fff',
                      border: String(playerNum) === String(currentSetter)
                        ? '2px solid #8b5cf6'
                        : '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '12px',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '4px',
                      transition: 'all 0.2s'
                    }}
                  >
                    <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)' }}>{position}</span>
                    <span>#{playerNum}</span>
                  </button>
                )})
              })()}
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => {
                  const side = setterSelectionModal
                  setAdvancedMode(prev => ({ ...prev, [side]: false }))
                  setSetterNumber(prev => ({ ...prev, [side]: null }))
                  setSetterSelectionModal(null)
                }}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(239, 68, 68, 0.2)',
                  color: '#ef4444',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Exit Advanced
              </button>
              <button
                onClick={() => setSetterSelectionModal(null)}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: '#fff',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
              
      {/* SECTION 1: Header - 40px */}
              <div style={{
        height: '40px',
        minHeight: '40px',
        maxHeight: '40px',
                display: 'flex',
        justifyContent: 'space-between',
                alignItems: 'center',
        padding: '0 12px',
        background: 'rgba(0, 0, 0, 0.3)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
              }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={toggleFullscreen}
              style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontWeight: 600,
              background: 'rgba(255,255,255,0.1)',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            {isFullscreen ? `⛶ ${t('refereeDashboard.exitFullscreen')}` : '⛶'}
          </button>

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
            title={wakeLockActive ? t('refereeDashboard.screenWillStayOn') : t('refereeDashboard.screenMayTurnOff')}
          >
            {wakeLockActive ? `☀️ ${t('refereeDashboard.wakeLockOn')}` : `🌙 ${t('refereeDashboard.wakeLockOff')}`}
          </button>

          {!isMasterMode && (
            <ConnectionStatus
              connectionStatuses={connectionStatuses}
              connectionDebugInfo={{
                ...connectionDebugInfo,
                match: {
                  ...connectionDebugInfo?.match,
                  matchId: matchId,
                  homeTeam: data?.homeTeam?.name,
                  awayTeam: data?.awayTeam?.name,
                  gameNumber: data?.match?.gameNumber,
                  currentSet: data?.currentSet?.index
                }
              }}
              position="right"
              size="small"
            />
          )}

          {isMasterMode && (
              <span style={{
              padding: '2px 8px',
              fontSize: '10px',
              fontWeight: 700,
              background: 'rgba(251, 191, 36, 0.2)',
              border: '1px solid rgba(251, 191, 36, 0.5)',
              borderRadius: '4px',
              color: '#fbbf24'
              }}>
              {t('refereeDashboard.testMode')}
              </span>
          )}
            </div>

        {/* Center - Refresh Button */}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          {!isMasterMode && (
            <button
              onClick={fetchFreshData}
              style={{
                padding: '6px 16px',
                fontSize: '12px',
                fontWeight: 600,
                background: 'rgba(59, 130, 246, 0.2)',
                color: '#3b82f6',
                border: '1px solid rgba(59, 130, 246, 0.4)',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
              title={t('refereeDashboard.refresh')}
            >
              🔄 {window.innerWidth >= 500 && t('refereeDashboard.refresh')}
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {/* Version */}
          <span style={{ fontSize: '10px', color: 'rgba(255, 255, 255, 0.5)' }}>
            v{currentVersion}
          </span>
          {/* Connection Type Dropdown */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setConnectionDropdownOpen(!connectionDropdownOpen)}
              style={{
                padding: '4px 8px',
                fontSize: '10px',
                fontWeight: 600,
                background: activeConnection === 'supabase' ? 'rgba(34, 197, 94, 0.2)' :
                           activeConnection === 'websocket' ? 'rgba(59, 130, 246, 0.2)' :
                           'rgba(156, 163, 175, 0.2)',
                color: activeConnection === 'supabase' ? '#22c55e' :
                       activeConnection === 'websocket' ? '#3b82f6' :
                       '#9ca3af',
                border: `1px solid ${activeConnection === 'supabase' ? 'rgba(34, 197, 94, 0.4)' :
                                     activeConnection === 'websocket' ? 'rgba(59, 130, 246, 0.4)' :
                                     'rgba(156, 163, 175, 0.4)'}`,
                borderRadius: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '3px'
              }}
              title={`Connection: ${activeConnection || 'none'} (${realtimeStatus})`}
            >
              {activeConnection === 'supabase' ? '🗄️' : activeConnection === 'websocket' ? '📡' : '⚪'}
              <span style={{ fontSize: '8px' }}>{connectionDropdownOpen ? '▲' : '▼'}</span>
            </button>
            {connectionDropdownOpen && (
              <div style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: '2px',
                background: '#1a1a2e',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '4px',
                overflow: 'hidden',
                zIndex: 1000,
                minWidth: '140px'
              }}>
                <button
                  onClick={() => { setConnectionType(CONNECTION_TYPES.AUTO); setConnectionDropdownOpen(false); }}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '11px',
                    fontWeight: 500,
                    background: connectionType === CONNECTION_TYPES.AUTO ? 'rgba(var(--accent-rgb), 0.3)' : 'transparent',
                    color: connectionType === CONNECTION_TYPES.AUTO ? 'var(--accent)' : '#fff',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  🔄 {t('refereeDashboard.connection.auto')}
                  <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>{t('refereeDashboard.connection.autoDesc')}</div>
                </button>
                <button
                  onClick={() => { setConnectionType(CONNECTION_TYPES.SUPABASE); setConnectionDropdownOpen(false); }}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '11px',
                    fontWeight: 500,
                    background: connectionType === CONNECTION_TYPES.SUPABASE ? 'rgba(34, 197, 94, 0.2)' : 'transparent',
                    color: connectionType === CONNECTION_TYPES.SUPABASE ? '#22c55e' : '#fff',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  🗄️ {t('refereeDashboard.connection.dbOnly')}
                  <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>{t('refereeDashboard.connection.dbDesc')}</div>
                </button>
                <button
                  onClick={() => { setConnectionType(CONNECTION_TYPES.WEBSOCKET); setConnectionDropdownOpen(false); }}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '11px',
                    fontWeight: 500,
                    background: connectionType === CONNECTION_TYPES.WEBSOCKET ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                    color: connectionType === CONNECTION_TYPES.WEBSOCKET ? '#3b82f6' : '#fff',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  📡 {t('refereeDashboard.connection.directOnly')}
                  <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>{t('refereeDashboard.connection.directDesc')}</div>
                </button>
              </div>
            )}
          </div>
          {/* Collapsible 1R/2R Dropdown */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setRefViewDropdownOpen(!refViewDropdownOpen)}
              style={{
                padding: '4px 10px',
                fontSize: '11px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}
            >
              {refereeView === '1st' ? '1R' : '2R'}
              <span style={{ fontSize: '8px' }}>{refViewDropdownOpen ? '▲' : '▼'}</span>
            </button>
            {refViewDropdownOpen && (
              <div style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: '2px',
                background: '#1a1a2e',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '4px',
                overflow: 'hidden',
                zIndex: 1000,
                minWidth: '50px'
              }}>
                <button
                  onClick={() => { setRefereeView('1st'); setRefViewDropdownOpen(false); }}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '6px 12px',
                    fontSize: '11px',
                    fontWeight: 600,
                    background: refereeView === '1st' ? 'var(--accent)' : 'transparent',
                    color: refereeView === '1st' ? '#000' : '#fff',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  1R
                </button>
                <button
                  onClick={() => { setRefereeView('2nd'); setRefViewDropdownOpen(false); }}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '6px 12px',
                    fontSize: '11px',
                    fontWeight: 600,
                    background: refereeView === '2nd' ? 'var(--accent)' : 'transparent',
                    color: refereeView === '2nd' ? '#000' : '#fff',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  2R
                </button>
              </div>
            )}
          </div>
          {/* Exit Button with Icon */}
          <button
            onClick={onExit}
            style={{
              padding: '4px 8px',
              fontSize: '14px',
              fontWeight: 600,
              background: 'rgba(239, 68, 68, 0.2)',
              color: '#ef4444',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              borderRadius: '4px',
              cursor: 'pointer',
              lineHeight: 1
            }}
            title="Exit"
          >
            ✕
          </button>
        </div>
            </div>

      {/* Main content wrapper - percentage-based heights */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0
      }}>

      {/* SECTION 2A: Set Counter Row - 10% */}
      <div style={{ flex: '0 0 10%', padding: 'clamp(4px, 1vw, 8px) clamp(8px, 2vw, 16px)', background: 'rgba(0, 0, 0, 0.25)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', width: '100%', minHeight: 0, overflow: 'hidden' }}>
        {/* Left: Team Name (centered in its space) + A/B */}
        <div style={{ flex: '1 1 0', display: 'flex', alignItems: 'center', gap: 'clamp(6px, 1.5vw, 12px)', minWidth: 0 }}>
          <div style={{ flex: '1 1 0', display: 'flex', justifyContent: 'center', minWidth: 0 }}>
            <div style={{ padding: 'clamp(4px, 1vw, 8px) clamp(10px, 2.5vw, 18px)', background: leftColor, color: isBrightColor(leftColor) ? '#000' : '#fff', borderRadius: '6px', fontSize: 'clamp(16px, 4vw, 28px)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{(() => {
                const fullName = leftTeamData?.name || 'Team';
                const shortName = leftTeam === 'home' ? data?.match?.homeShortName : data?.match?.awayShortName;
                return shortName || fullName;
              })()}</div>
          </div>
          <div style={{ padding: 'clamp(4px, 1vw, 8px) clamp(10px, 2.5vw, 18px)', background: leftColor, color: isBrightColor(leftColor) ? '#000' : '#fff', borderRadius: '6px', fontSize: 'clamp(18px, 4.5vw, 32px)', fontWeight: 800, flexShrink: 0 }}>{leftLabel}</div>
        </div>

        {/* Center: Set scores + SET n */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(6px, 1.5vw, 12px)', flexShrink: 0, marginLeft: '8px', marginRight: '8px' }}>
          <div style={{ padding: 'clamp(4px, 1vw, 8px) clamp(12px, 3vw, 20px)', background: 'rgba(255, 255, 255, 0.15)', borderRadius: '8px', fontSize: 'clamp(12px, 3vw, 36px)', fontWeight: 800 }}>{leftSetScore}</div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ fontSize: 'clamp(15px, 4vw, 30px)', color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 600 }}>SET</span>
            <span style={{ fontSize: 'clamp(22px, 5.5vw, 40px)', fontWeight: 800 }}>{data?.currentSet?.index || 1}</span>
          </div>
          <div style={{ padding: 'clamp(4px, 1vw, 8px) clamp(12px, 3vw, 20px)', background: 'rgba(255, 255, 255, 0.15)', borderRadius: '8px', fontSize: 'clamp(12px, 3vw, 36px)', fontWeight: 800 }}>{rightSetScore}</div>
        </div>

        {/* Right: A/B + Team Name (centered in its space) */}
        <div style={{ flex: '1 1 0', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'clamp(6px, 1.5vw, 12px)', minWidth: 0 }}>
          <div style={{ padding: 'clamp(4px, 1vw, 8px) clamp(10px, 2.5vw, 18px)', background: rightColor, color: isBrightColor(rightColor) ? '#000' : '#fff', borderRadius: '6px', fontSize: 'clamp(18px, 4.5vw, 32px)', fontWeight: 800, flexShrink: 0 }}>{rightLabel}</div>
          <div style={{ flex: '1 1 0', display: 'flex', justifyContent: 'center', minWidth: 0 }}>
            <div style={{ padding: 'clamp(4px, 1vw, 8px) clamp(10px, 2.5vw, 18px)', background: rightColor, color: isBrightColor(rightColor) ? '#000' : '#fff', borderRadius: '6px', fontSize: 'clamp(16px, 4vw, 28px)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{(() => {
                const fullName = rightTeamData?.name || 'Team';
                const shortName = rightTeam === 'home' ? data?.match?.homeShortName : data?.match?.awayShortName;
                return shortName || fullName;
              })()}</div>
          </div>
        </div>
      </div>

      {/* SECTION 2B: Score & Serve - 20% */}
      <div style={{
        flex: '0 0 20%',
        padding: '4px 0',
        background: 'rgba(0, 0, 0, 0.2)',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        maxWidth: '100%',
        overflow: 'hidden',
        minHeight: 0
      }}>
        {/* LEFT COLUMN - Serve indicator (1/5) */}
              <div style={{
          flex: '0 0 15%',
                display: 'flex',
                alignItems: 'center',
              justifyContent: 'center',
          minHeight: '80px',
          minWidth: 0,
          overflow: 'hidden'
              }}>
          {leftServing && (
        <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
              gap: '2px'
              }}>
              <span style={{ fontSize: 'clamp(14px, 4vw, 30px)', color: 'var(--accent)', fontWeight: 700 }}>SERVE</span>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                padding: 'clamp(4px, 1vw, 14px)',
                background: 'rgba(34, 197, 94, 0.15)',
                border: '2px solid var(--accent)',
                borderRadius: '8px',
                aspectRatio: '1/1',
                width: 'clamp(40px, 12vw, 90px)'
              }}>
                <span style={{ fontSize: 'clamp(24px, 8vw, 70px)', fontWeight: 700, color: 'var(--accent)', lineHeight: '1', textAlign: 'center' }}>
                  {typeof leftLineup?.I === 'object' ? leftLineup?.I?.number : leftLineup?.I || ''}
                </span>
                  </div>
                </div>
              )}
            </div>

        {/* MIDDLE COLUMN - Score only (3/5) */}
        <div style={{ flex: '0 0 70%', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0, overflow: 'hidden' }}>
          {/* Score row - perfectly centered colon */}
        <div style={{
          display: 'flex',
                    alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
            maxWidth: '100%'
        }}>
            {/* Left team side */}
          <div style={{
              flex: '1 1 0',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              paddingRight: 'clamp(4px, 1.5vw, 12px)',
              minWidth: 0,
              overflow: 'hidden'
            }}>
              {/* Ball indicator (if serving) + Score */}
                <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'clamp(6px, 2vw, 20px)'
              }}>
                {/* Ball indicator for serving team */}
                <div style={{
                  width: 'clamp(30px, 8vw, 60px)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  {leftServing && (
                    <img
                      src={mikasaVolleyball}
                      alt="Serving"
                      style={{
                        width: 'clamp(24px, 6vw, 50px)',
                        height: 'clamp(24px, 6vw, 50px)',
                        filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
                      }}
                    />
                  )}
                </div>
              <span style={{
                  fontSize: 'clamp(48px, 18vw, 140px)',
            fontWeight: 800,
            color: 'var(--accent)',
                  lineHeight: 1,
                  textAlign: 'right'
              }}>
                {leftScore}
              </span>
            </div>
          </div>
          
            {/* Colon - fixed width, perfectly centered */}
            <div style={{
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <span style={{ fontSize: 'clamp(35px, 14vw, 110px)', fontWeight: 800, color: 'var(--muted)', lineHeight: 1 }}>:</span>
              </div>

            {/* Right team side */}
                  <div style={{
              flex: '1 1 0',
                    display: 'flex',
                    flexDirection: 'column',
              alignItems: 'flex-start',
              paddingLeft: 'clamp(4px, 1.5vw, 12px)',
              minWidth: 0,
              overflow: 'hidden'
                  }}>
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                gap: 'clamp(6px, 2vw, 20px)'
            }}>
              <span style={{
                  fontSize: 'clamp(48px, 18vw, 140px)',
                fontWeight: 800,
                color: 'var(--accent)',
                  lineHeight: 1,
                  textAlign: 'left'
                      }}>
                {rightScore}
              </span>
                {/* Ball indicator for serving team */}
                <div style={{
                  width: 'clamp(30px, 8vw, 60px)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  {rightServing && (
                    <img
                      src={mikasaVolleyball}
                      alt="Serving"
                      style={{
                        width: 'clamp(24px, 6vw, 50px)',
                        height: 'clamp(24px, 6vw, 50px)',
                        filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
                      }}
                    />
                  )}
                </div>
                      </div>
                      </div>
                    </div>
          </div>

        {/* RIGHT COLUMN - Serve indicator (1/5) */}
          <div style={{
          flex: '0 0 15%',
              display: 'flex',
              alignItems: 'center',
          justifyContent: 'center', 
          minHeight: '80px',
          minWidth: 0,
          overflow: 'hidden'
        }}>
          {rightServing && (
                <div style={{ 
          display: 'flex', 
              flexDirection: 'column',
          alignItems: 'center', 
              gap: '2px'
          }}>
              <span style={{ fontSize: 'clamp(14px, 4vw, 30px)', color: 'var(--accent)', fontWeight: 700 }}>SERVE</span>
                <div style={{ 
          display: 'flex',
                alignItems: 'center',
          justifyContent: 'center',
                padding: 'clamp(4px, 1vw, 14px)',
                background: 'rgba(34, 197, 94, 0.15)',
                border: '2px solid var(--accent)',
                borderRadius: '8px',
                aspectRatio: '1/1',
                width: 'clamp(40px, 12vw, 90px)'
              }}>
                <span style={{ fontSize: 'clamp(24px, 8vw, 70px)', fontWeight: 700, color: 'var(--accent)', lineHeight: '1', textAlign: 'center' }}>
                  {typeof rightLineup?.I === 'object' ? rightLineup?.I?.number : rightLineup?.I || ''}
                </span>
                </div>
                </div>
                )}
            </div>
            </div>

      {/* SECTION 3: Court Area - 40% (includes advanced mode buttons) */}
      <div style={{
        flex: '0 0 40%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0
      }}>
      {/* Advanced Mode Buttons - Above Court */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '2px 8px',
        background: 'rgba(0, 0, 0, 0.15)',
        flex: '0 0 auto'
      }}>
        {/* Left team advanced mode button - only show when receiving and 2R view */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          {refereeView === '2nd' && !leftServing && leftLineup && (
            <button
              onClick={() => setSetterSelectionModal('left')}
              style={{
                padding: '4px 12px',
                fontSize: '11px',
                fontWeight: 600,
                background: advancedMode.left ? 'rgba(139, 92, 246, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                color: advancedMode.left ? '#a78bfa' : 'rgba(255, 255, 255, 0.7)',
                border: advancedMode.left ? '1px solid rgba(139, 92, 246, 0.5)' : '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              {advancedMode.left ? (
                <>
                  <span style={{ color: '#8b5cf6' }}>P{getSetterPosition(leftLineup, setterNumber.left) || '?'}</span>
                  <span>#{setterNumber.left}</span>
                </>
              ) : (
                '⚙️ Advanced'
              )}
            </button>
          )}
        </div>
        {/* Right team advanced mode button - only show when receiving and 2R view */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          {refereeView === '2nd' && !rightServing && rightLineup && (
            <button
              onClick={() => setSetterSelectionModal('right')}
              style={{
                padding: '4px 12px',
                fontSize: '11px',
                fontWeight: 600,
                background: advancedMode.right ? 'rgba(139, 92, 246, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                color: advancedMode.right ? '#a78bfa' : 'rgba(255, 255, 255, 0.7)',
                border: advancedMode.right ? '1px solid rgba(139, 92, 246, 0.5)' : '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              {advancedMode.right ? (
                <>
                  <span style={{ color: '#8b5cf6' }}>P{getSetterPosition(rightLineup, setterNumber.right) || '?'}</span>
                  <span>#{setterNumber.right}</span>
                </>
              ) : (
                '⚙️ Advanced'
              )}
            </button>
          )}
        </div>
      </div>

      {/* Court visualization - takes remaining space in 40% */}
        <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '4px 4px',
        overflow: 'hidden',
        minHeight: 0
      }}>
          <div style={{
          width: '100%',
          maxWidth: '800px',
          aspectRatio: '2/1',
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
            borderRadius: '12px',
          background: 'linear-gradient(90deg, rgba(234, 179, 8, 0.12), rgba(234, 179, 8, 0.08))',
          border: '2px solid rgba(255, 255, 255, 0.1)',
          overflow: 'hidden'
          }}>
          {/* Net */}
            <div style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: '50%',
            width: '6px',
            transform: 'translateX(-50%)',
            background: 'repeating-linear-gradient(to bottom, rgba(248, 250, 252, 0.85), rgba(248, 250, 252, 0.85) 4px, rgba(148, 163, 184, 0.45) 4px, rgba(148, 163, 184, 0.45) 8px)',
            borderRadius: '3px',
            boxShadow: '0 0 10px rgba(241, 245, 249, 0.15)',
            zIndex: 2
          }} />

          {/* Attack lines */}
        <div style={{
                          position: 'absolute',
          top: 0,
          bottom: 0,
            left: 'calc(50% - 22.667%)',
            width: '2px',
            background: 'rgba(255, 255, 255, 0.15)',
            zIndex: 1
          }} />
                        <div style={{
                          position: 'absolute',
            top: 0,
            bottom: 0,
            left: 'calc(50% + 22.667%)',
            width: '2px',
            background: 'rgba(255, 255, 255, 0.15)',
            zIndex: 1
          }} />

          {/* Left side */}
          <div
            ref={(el) => { courtRef.current.left = el }}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, 'left')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              height: '100%'
            }}
          >
            {/* Circular arrows toggle for reception mode - only show when in advanced mode and receiving */}
            {advancedMode.left && !leftServing && (
              <button
                onClick={() => toggleReceptionMode('left')}
                style={{
                  position: 'absolute',
                  bottom: '8px',
                  left: '8px',
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: receptionMode.left === 'reception' ? 'rgba(139, 92, 246, 0.4)' : 'rgba(255, 255, 255, 0.15)',
                  border: receptionMode.left === 'reception' ? '2px solid #8b5cf6' : '1px solid rgba(255, 255, 255, 0.3)',
                  color: receptionMode.left === 'reception' ? '#a78bfa' : 'rgba(255, 255, 255, 0.7)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '16px',
                  zIndex: 10,
                  transition: 'all 0.2s'
                }}
                title={receptionMode.left === 'reception' ? 'Switch to standard view' : 'Switch to reception formation'}
              >
                🔄
              </button>
            )}

            {/* Standard grid layout when NOT in advanced mode OR when serving OR when in standard mode */}
            {(!advancedMode.left || leftServing || receptionMode.left === 'standard') ? (
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 1fr',
                gap: 'clamp(4px, 2vw, 12px)',
                width: '100%',
                height: '100%',
                padding: 'clamp(4px, 2vw, 12px)'
              }}>
                {/* Back row (V, VI, I) - left side of left court */}
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-around',
                  alignItems: 'center'
                }}>
                  <PlayerCircle positionData={leftLineup?.V} position="V" team={leftTeam} isServing={leftServing} />
                  <PlayerCircle positionData={leftLineup?.VI} position="VI" team={leftTeam} isServing={leftServing} />
                  <PlayerCircle positionData={leftLineup?.I} position="I" team={leftTeam} isServing={leftServing} />
                </div>
                {/* Front row (IV, III, II) - right side of left court (near net) */}
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-around',
                  alignItems: 'center'
                }}>
                  <PlayerCircle positionData={leftLineup?.IV} position="IV" team={leftTeam} isServing={leftServing} />
                  <PlayerCircle positionData={leftLineup?.III} position="III" team={leftTeam} isServing={leftServing} />
                  <PlayerCircle positionData={leftLineup?.II} position="II" team={leftTeam} isServing={leftServing} />
                </div>
              </div>
            ) : (
              /* Advanced mode + reception - absolute positioning for reception formations */
              /* Court perspective: Net is on RIGHT side (towards center), end line on LEFT */
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                {(() => {
                  const setterPos = getSetterPosition(leftLineup, setterNumber.left)
                  const formation = getFormationWithCustom('left', setterPos)
                  // For left court: Net is on right
                  // formation gives top (from net) and left (from left side looking at net from behind)
                  // For horizontal court with net in middle:
                  // - top in formation = distance from net = maps to distance from RIGHT edge of left half
                  // - left in formation = horizontal position = maps directly to vertical position
                  //   (left side of court = top, right side = bottom)
                  return ['I', 'II', 'III', 'IV', 'V', 'VI'].map(pos => {
                    const coords = formation[pos]
                    // Transform: formation top -> distance from net (right edge)
                    // formation left -> vertical position (left=top, right=bottom)
                    const rightPercent = coords.top // Distance from net
                    const topPercent = 100 - coords.left // Invert: formation left (0) = bottom, left (100) = top
                    return (
                      <div
                        key={pos}
                        draggable
                        onDragStart={(e) => handleDragStart(e, 'left', pos)}
                        style={{
                          position: 'absolute',
                          right: `${rightPercent}%`,
                          top: `${topPercent}%`,
                          transform: 'translate(50%, -50%) scale(0.8)',
                          zIndex: 3,
                          cursor: 'grab',
                          touchAction: 'none'
                        }}
                      >
                        <PlayerCircle positionData={leftLineup?.[pos]} position={pos} team={leftTeam} isServing={leftServing} />
                      </div>
                    )
                  })
                })()}
              </div>
            )}
            {/* Blur overlay when lineup is set but other team hasn't set theirs yet */}
            {leftLineup && !rightLineup && isFirstRally && !peekingLineup.left && (
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0, 0, 0, 0.75)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '12px',
                zIndex: 50,
                borderRadius: '8px'
              }}>
                <div style={{
                  fontSize: 'clamp(14px, 3vw, 20px)',
                  fontWeight: 700,
                  color: '#22c55e',
                  textAlign: 'center'
                }}>
                  {t('refereeDashboard.lineupSet', 'Line-up set')}
                </div>
                <button
                  onMouseDown={() => setPeekingLineup(prev => ({ ...prev, left: true }))}
                  onMouseUp={() => setPeekingLineup(prev => ({ ...prev, left: false }))}
                  onMouseLeave={() => setPeekingLineup(prev => ({ ...prev, left: false }))}
                  onTouchStart={() => setPeekingLineup(prev => ({ ...prev, left: true }))}
                  onTouchEnd={() => setPeekingLineup(prev => ({ ...prev, left: false }))}
                  style={{
                    padding: '8px 16px',
                    fontSize: 'clamp(10px, 2vw, 13px)',
                    fontWeight: 600,
                    background: 'rgba(59, 130, 246, 0.3)',
                    color: '#fff',
                    border: '1px solid rgba(59, 130, 246, 0.5)',
                    borderRadius: '6px',
                    cursor: 'pointer'
                  }}
                >
                  {t('refereeDashboard.showLineup', 'Show Line-up')}
                </button>
              </div>
            )}
          </div>

          {/* Right side */}
          <div
            ref={(el) => { courtRef.current.right = el }}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, 'right')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              height: '100%'
            }}
          >
            {/* Circular arrows toggle for reception mode - only show when in advanced mode and receiving */}
            {advancedMode.right && !rightServing && (
              <button
                onClick={() => toggleReceptionMode('right')}
                style={{
                  position: 'absolute',
                  bottom: '8px',
                  right: '8px',
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: receptionMode.right === 'reception' ? 'rgba(139, 92, 246, 0.4)' : 'rgba(255, 255, 255, 0.15)',
                  border: receptionMode.right === 'reception' ? '2px solid #8b5cf6' : '1px solid rgba(255, 255, 255, 0.3)',
                  color: receptionMode.right === 'reception' ? '#a78bfa' : 'rgba(255, 255, 255, 0.7)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '16px',
                  zIndex: 10,
                  transition: 'all 0.2s'
                }}
                title={receptionMode.right === 'reception' ? 'Switch to standard view' : 'Switch to reception formation'}
              >
                🔄
              </button>
            )}

            {/* Standard grid layout when NOT in advanced mode OR when serving OR when in standard mode */}
            {(!advancedMode.right || rightServing || receptionMode.right === 'standard') ? (
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1.5fr',
                gap: 'clamp(4px, 2vw, 12px)',
                width: '100%',
                height: '100%',
                padding: 'clamp(4px, 2vw, 12px)'
              }}>
                {/* Front row (II, III, IV) - left side of right court (near net) */}
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-around',
                  alignItems: 'center'
                }}>
                  <PlayerCircle positionData={rightLineup?.II} position="II" team={rightTeam} isServing={rightServing} />
                  <PlayerCircle positionData={rightLineup?.III} position="III" team={rightTeam} isServing={rightServing} />
                  <PlayerCircle positionData={rightLineup?.IV} position="IV" team={rightTeam} isServing={rightServing} />
                </div>
                {/* Back row (I, VI, V) - right side of right court */}
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-around',
                  alignItems: 'center'
                }}>
                  <PlayerCircle positionData={rightLineup?.I} position="I" team={rightTeam} isServing={rightServing} />
                  <PlayerCircle positionData={rightLineup?.VI} position="VI" team={rightTeam} isServing={rightServing} />
                  <PlayerCircle positionData={rightLineup?.V} position="V" team={rightTeam} isServing={rightServing} />
                </div>
              </div>
            ) : (
              /* Advanced mode + reception - absolute positioning for reception formations */
              /* Court perspective: Net is on LEFT side (towards center), end line on RIGHT */
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                {(() => {
                  const setterPos = getSetterPosition(rightLineup, setterNumber.right)
                  const formation = getFormationWithCustom('right', setterPos)
                  // For right court: Net is on left
                  // formation gives top (from net) and left (from left side looking at net from behind)
                  // For horizontal court with net in middle:
                  // - top in formation = distance from net = maps to distance from LEFT edge of right half
                  // - left in formation = horizontal position = maps to vertical position
                  return ['I', 'II', 'III', 'IV', 'V', 'VI'].map(pos => {
                    const coords = formation[pos]
                    // Transform: formation top -> distance from net (left edge)
                    // formation left -> vertical position (need to flip for right side view)
                    const leftPercent = coords.top // Distance from net
                    const topPercent = 100 - coords.left // Invert: formation left (0) = bottom, left (100) = top
                    return (
                      <div
                        key={pos}
                        draggable
                        onDragStart={(e) => handleDragStart(e, 'right', pos)}
                        style={{
                          position: 'absolute',
                          left: `${leftPercent}%`,
                          top: `${topPercent}%`,
                          transform: 'translate(-50%, -50%) scale(0.8)',
                          zIndex: 3,
                          cursor: 'grab',
                          touchAction: 'none'
                        }}
                      >
                        <PlayerCircle positionData={rightLineup?.[pos]} position={pos} team={rightTeam} isServing={rightServing} />
                      </div>
                    )
                  })
                })()}
              </div>
            )}
            {/* Blur overlay when lineup is set but other team hasn't set theirs yet */}
            {rightLineup && !leftLineup && isFirstRally && !peekingLineup.right && (
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0, 0, 0, 0.75)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '12px',
                zIndex: 50,
                borderRadius: '8px'
              }}>
                <div style={{
                  fontSize: 'clamp(14px, 3vw, 20px)',
                  fontWeight: 700,
                  color: '#22c55e',
                  textAlign: 'center'
                }}>
                  {t('refereeDashboard.lineupSet', 'Line-up set')}
                </div>
                <button
                  onMouseDown={() => setPeekingLineup(prev => ({ ...prev, right: true }))}
                  onMouseUp={() => setPeekingLineup(prev => ({ ...prev, right: false }))}
                  onMouseLeave={() => setPeekingLineup(prev => ({ ...prev, right: false }))}
                  onTouchStart={() => setPeekingLineup(prev => ({ ...prev, right: true }))}
                  onTouchEnd={() => setPeekingLineup(prev => ({ ...prev, right: false }))}
                  style={{
                    padding: '8px 16px',
                    fontSize: 'clamp(10px, 2vw, 13px)',
                    fontWeight: 600,
                    background: 'rgba(59, 130, 246, 0.3)',
                    color: '#fff',
                    border: '1px solid rgba(59, 130, 246, 0.5)',
                    borderRadius: '6px',
                    cursor: 'pointer'
                  }}
                >
                  {t('refereeDashboard.showLineup', 'Show Line-up')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      </div>{/* End SECTION 3: Court Area - 40% */}

      {/* SECTION 4: Teams with TO/SUB counters - 10% */}
      <div style={{
        flex: '0 0 10%',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto 1fr auto',
        alignItems: 'center',
        padding: '4px 12px',
        background: 'rgba(0, 0, 0, 0.15)',
        gap: '8px',
        minHeight: 0,
        overflow: 'hidden'
      }}>
        {/* Column 1: Left counters (far left) - grid for alignment */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '6px 6px',
          fontSize: 'clamp(14px, 3vw, 22px)',
          fontWeight: 700,
          alignItems: 'stretch',
          height: '100%'
        }}>
          <span style={{ fontWeight: 600, color: 'var(--muted)', fontSize: '0.75em', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>TO</span>
          <span style={{
            background: leftStats.timeouts >= 2 ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255, 255, 255, 0.15)',
            padding: '4px 10px',
            borderRadius: '4px',
            border: leftStats.timeouts >= 2 ? '1px solid rgba(239, 68, 68, 0.6)' : '1px solid rgba(255, 255, 255, 0.3)',
            minWidth: '32px',
            textAlign: 'center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: leftStats.timeouts >= 2 ? '#ef4444' : 'rgba(255, 255, 255, 0.9)'
          }}>{leftStats.timeouts}</span>
          <span style={{ fontWeight: 600, color: 'var(--muted)', fontSize: '0.75em', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>SUB</span>
          <span style={{
            background: leftStats.substitutions >= 6 ? 'rgba(239, 68, 68, 0.3)' : leftStats.substitutions >= 5 ? 'rgba(234, 179, 8, 0.3)' : 'rgba(255, 255, 255, 0.15)',
            padding: '4px 10px',
            borderRadius: '4px',
            border: leftStats.substitutions >= 6 ? '1px solid rgba(239, 68, 68, 0.6)' : leftStats.substitutions >= 5 ? '1px solid rgba(234, 179, 8, 0.6)' : '1px solid rgba(255, 255, 255, 0.3)',
            minWidth: '32px',
            textAlign: 'center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: leftStats.substitutions >= 6 ? '#ef4444' : leftStats.substitutions >= 5 ? '#eab308' : 'rgba(255, 255, 255, 0.9)'
          }}>{leftStats.substitutions}</span>
        </div>

        {/* Column 2: Left team name (fills space, text centered) */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden'
        }}>
          <span style={{
            fontSize: 'clamp(14px, 4vw, 24px)',
            fontWeight: 700,
            background: leftColor,
            color: isBrightColor(leftColor) ? '#000' : '#fff',
            padding: 'clamp(4px, 1vw, 8px) clamp(8px, 2vw, 14px)',
            borderRadius: '6px',
            textAlign: 'center',
            lineHeight: 1.1,
            wordBreak: 'break-word'
          }}>
            {leftTeamData?.name || 'Team'}
          </span>
        </div>

        {/* Column 3: VS circle (exact center, beneath net) */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 'clamp(36px, 6vw, 50px)',
          height: 'clamp(36px, 6vw, 50px)',
          background: 'rgba(255, 255, 255, 0.1)',
          border: '2px solid rgba(255, 255, 255, 0.3)',
          flexShrink: 0
        }}>
          <span style={{
            fontStyle: 'italic',
            fontSize: 'clamp(12px, 2.5vw, 18px)',
            fontWeight: 700,
            color: 'rgba(255, 255, 255, 0.7)'
          }}>VS</span>
        </div>

        {/* Column 4: Right team name (fills space, text centered) */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden'
        }}>
          <span style={{
            fontSize: 'clamp(14px, 4vw, 24px)',
            fontWeight: 700,
            background: rightColor,
            color: isBrightColor(rightColor) ? '#000' : '#fff',
            padding: 'clamp(4px, 1vw, 8px) clamp(8px, 2vw, 14px)',
            borderRadius: '6px',
            textAlign: 'center',
            lineHeight: 1.1,
            wordBreak: 'break-word'
          }}>
            {rightTeamData?.name || 'Team'}
          </span>
        </div>

        {/* Column 5: Right counters (far right) - grid for alignment */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: '6px 6px',
          fontSize: 'clamp(14px, 3vw, 22px)',
          fontWeight: 700,
          alignItems: 'stretch',
          height: '100%'
        }}>
          <span style={{
            background: rightStats.timeouts >= 2 ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255, 255, 255, 0.15)',
            padding: '4px 10px',
            borderRadius: '4px',
            border: rightStats.timeouts >= 2 ? '1px solid rgba(239, 68, 68, 0.6)' : '1px solid rgba(255, 255, 255, 0.3)',
            minWidth: '32px',
            textAlign: 'center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: rightStats.timeouts >= 2 ? '#ef4444' : 'rgba(255, 255, 255, 0.9)'
          }}>{rightStats.timeouts}</span>
          <span style={{ fontWeight: 600, color: 'var(--muted)', fontSize: '0.75em', textAlign: 'left', display: 'flex', alignItems: 'center' }}>TO</span>
          <span style={{
            background: rightStats.substitutions >= 6 ? 'rgba(239, 68, 68, 0.3)' : rightStats.substitutions >= 5 ? 'rgba(234, 179, 8, 0.3)' : 'rgba(255, 255, 255, 0.15)',
            padding: '4px 10px',
            borderRadius: '4px',
            border: rightStats.substitutions >= 6 ? '1px solid rgba(239, 68, 68, 0.6)' : rightStats.substitutions >= 5 ? '1px solid rgba(234, 179, 8, 0.6)' : '1px solid rgba(255, 255, 255, 0.3)',
            minWidth: '32px',
            textAlign: 'center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: rightStats.substitutions >= 6 ? '#ef4444' : rightStats.substitutions >= 5 ? '#eab308' : 'rgba(255, 255, 255, 0.9)'
          }}>{rightStats.substitutions}</span>
          <span style={{ fontWeight: 600, color: 'var(--muted)', fontSize: '0.75em', textAlign: 'left', display: 'flex', alignItems: 'center' }}>SUB</span>
        </div>
      </div>

      {/* SECTION 5: Team Sanctions Bar - fills remaining space */}
      <div style={{
        flex: '1 1 auto',
        display: 'grid',
        gridTemplateColumns: '20% 60% 20%',
        alignItems: 'center',
        alignContent: 'center',
        padding: '2px 12px',
        background: 'rgba(0, 0, 0, 0.1)',
        minHeight: 0,
        height: '100%',
        overflow: 'hidden'
      }}>
        {/* Left team sanctions */}
        <div style={{
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
          justifyContent: 'center',
          flexWrap: 'wrap',
          height: '100%'
        }}>
          {leftTeamSanctions.formalWarning && (
            <span style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#fde047',
              color: '#000',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>FW</span>
          )}
          {leftTeamSanctions.improperRequest && (
            <span style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#6b7280',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>Improper Request</span>
          )}
          {leftTeamSanctions.delayWarning && (
            <span style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#fde047',
              color: '#000',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>DW</span>
          )}
          {leftTeamSanctions.delayPenalty && (
            <span style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#ef4444',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>DP</span>
          )}
          {leftTeamSanctions.benchSanctions.length > 0 && (
            <span style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#a855f7',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>B×{leftTeamSanctions.benchSanctions.length}</span>
          )}
          {/* Player sanctions: warnings (yellow card) */}
          {leftTeamSanctions.playerWarnings.map((w, i) => (
            <span key={`w${i}`} style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#fde047',
              color: '#000',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>W#{w.player}</span>
          ))}
          {/* Player sanctions: penalties (red card) */}
          {leftTeamSanctions.playerPenalties.map((p, i) => (
            <span key={`p${i}`} style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#ef4444',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>P#{p.player}</span>
          ))}
          {/* Player sanctions: expulsions (red+yellow) */}
          {leftTeamSanctions.expulsions.map((e, i) => (
            <span key={`e${i}`} style={{
              fontSize: '14px',
              fontWeight: 700,
              background: 'linear-gradient(135deg, #ef4444 50%, #fde047 50%)',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px',
              textShadow: '0 0 2px #000'
            }}>E#{e.player}</span>
          ))}
          {/* Player sanctions: disqualifications */}
          {leftTeamSanctions.disqualifications.map((d, i) => (
            <span key={`d${i}`} style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#7f1d1d',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>DQ#{d.player}</span>
          ))}
        </div>

        {/* Center: Countdown when active, otherwise Favicon */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column'
        }}>
          {timeoutModal ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '10px', color: 'var(--muted)' }}>TIMEOUT</div>
              <div style={{ fontSize: 'clamp(24px, 6vw, 36px)', fontWeight: 800, color: 'var(--accent)' }}>
                {timeoutModal.countdown}"
              </div>
            </div>
          ) : betweenSetsCountdown && betweenSetsCountdown.countdown > 0 ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '10px', color: 'var(--muted)' }}>INTERVAL</div>
              <div style={{ fontSize: 'clamp(24px, 6vw, 36px)', fontWeight: 800, color: '#22c55e' }}>
                {Math.floor(betweenSetsCountdown.countdown / 60)}:{String(betweenSetsCountdown.countdown % 60).padStart(2, '0')}
              </div>
            </div>
          ) : (
            <img
              src="/favicon.png"
              alt="OpenVolley"
              style={{
                width: '100%',
                height: '100%',
                maxWidth: '120px',
                maxHeight: '120px',
                objectFit: 'contain',
                opacity: 0.7
              }}
            />
          )}
        </div>

        {/* Right team sanctions */}
        <div style={{
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
          justifyContent: 'center',
          flexWrap: 'wrap'
        }}>
          {rightTeamSanctions.formalWarning && (
            <span style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#fde047',
              color: '#000',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>FW</span>
          )}
          {rightTeamSanctions.improperRequest && (
            <span style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#6b7280',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>Improper Request</span>
          )}
          {rightTeamSanctions.delayWarning && (
            <span style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#fde047',
              color: '#000',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>DW</span>
          )}
          {rightTeamSanctions.delayPenalty && (
            <span style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#ef4444',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>DP</span>
          )}
          {rightTeamSanctions.benchSanctions.length > 0 && (
            <span style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#a855f7',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>B×{rightTeamSanctions.benchSanctions.length}</span>
          )}
          {/* Player sanctions: warnings (yellow card) */}
          {rightTeamSanctions.playerWarnings.map((w, i) => (
            <span key={`w${i}`} style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#fde047',
              color: '#000',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>W#{w.player}</span>
          ))}
          {/* Player sanctions: penalties (red card) */}
          {rightTeamSanctions.playerPenalties.map((p, i) => (
            <span key={`p${i}`} style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#ef4444',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>P#{p.player}</span>
          ))}
          {/* Player sanctions: expulsions (red+yellow) */}
          {rightTeamSanctions.expulsions.map((e, i) => (
            <span key={`e${i}`} style={{
              fontSize: '14px',
              fontWeight: 700,
              background: 'linear-gradient(135deg, #ef4444 50%, #fde047 50%)',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px',
              textShadow: '0 0 2px #000'
            }}>E#{e.player}</span>
          ))}
          {/* Player sanctions: disqualifications */}
          {rightTeamSanctions.disqualifications.map((d, i) => (
            <span key={`d${i}`} style={{
              fontSize: '14px',
              fontWeight: 700,
              background: '#7f1d1d',
              color: '#fff',
              padding: '3px 8px',
              borderRadius: '4px'
            }}>DQ#{d.player}</span>
          ))}
        </div>
      </div>

      </div>{/* End main content wrapper */}

      {/* Test Mode Controls - only shown in test mode */}
      {(matchId === -1 || data?.match?.test === true) && (
        <TestModeControls
          matchId={matchId}
          onRefresh={() => {
            // Force re-fetch data
            if (matchId && matchId !== -1) {
              getMatchData(matchId).then(result => {
                if (result.success) {
                  setData(result)
                }
              })
            }
          }}
        />
      )}
    </div>
  )
}
