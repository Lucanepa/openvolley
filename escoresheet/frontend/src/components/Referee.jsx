import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { getMatchData, subscribeToMatchData, listAvailableMatches, getWebSocketStatus } from '../utils/serverDataSync'
import mikasaVolleyball from '../mikasa_v200w.png'
import favicon from '../favicon.png'
import { ConnectionManager } from '../utils/connectionManager'
import ConnectionStatus from './ConnectionStatus'
import { db } from '../db/db'
import { Results } from '../../scoresheet_pdf/components/FooterSection'
import TestModeControls from './TestModeControls'
import { changelog } from '../CHANGELOG'

// Get current version from changelog
const currentVersion = changelog[0]?.version || '1.0.0'

export default function Referee({ matchId, onExit, isMasterMode }) {
  const [refereeView, setRefereeView] = useState('2nd') // '1st' or '2nd'
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Modal states (from Scoreboard actions)
  const [substitutionModal, setSubstitutionModal] = useState(null) // { team, teamName, position, playerIn, playerOut, isExceptional, timestamp }
  const [timeoutModal, setTimeoutModal] = useState(null) // { team, countdown, started }

  // Flashing substitution state (like Scoreboard)
  const [recentlySubstitutedPlayers, setRecentlySubstitutedPlayers] = useState([]) // [{ team, playerNumber, timestamp }]
  const recentSubFlashTimeoutRef = useRef(null)

  // Referee view dropdown state
  const [refViewDropdownOpen, setRefViewDropdownOpen] = useState(false)

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
        events: result.events || []
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

  // Subscribe to match data updates (skip in master mode)
  useEffect(() => {
    if (isMasterMode || !matchId) return

    let isMounted = true

    // Initial fetch
    fetchFreshData()

    // Subscribe to WebSocket updates - always replace data, never merge
    const unsubscribe = subscribeToMatchData(matchId, (updatedData) => {
      if (!isMounted) return
      
      // Check if this is an action (timeout, substitution, set_end)
      if (updatedData && updatedData._action) {
        const receiveTimestamp = Date.now()
        const serverTimestamp = updatedData._timestamp || receiveTimestamp
        const scoreboardTimestamp = updatedData._scoreboardTimestamp || receiveTimestamp
        const totalLatency = receiveTimestamp - scoreboardTimestamp
        const serverToRefereeLatency = receiveTimestamp - serverTimestamp
        
        const { _action, _actionData } = updatedData
        console.log(`[Referee] 📥 Received match-action '${_action}' at ${new Date(receiveTimestamp).toISOString()} (${receiveTimestamp}):`, {
          action: _action,
          data: _actionData,
          totalLatency: `${totalLatency}ms (Scoreboard → Referee)`,
          serverToRefereeLatency: `${serverToRefereeLatency}ms (Server → Referee)`
        })
        
        if (_action === 'timeout') {
          // Show timeout modal with countdown
          setTimeoutModal({
            team: _actionData.team,
            countdown: _actionData.countdown || 30,
            started: true
        })
        } else if (_action === 'substitution') {
          // Show substitution modal
          setSubstitutionModal({
            team: _actionData.team,
            teamName: _actionData.teamName,
            position: _actionData.position,
            playerOut: _actionData.playerOut,
            playerIn: _actionData.playerIn,
            isExceptional: _actionData.isExceptional,
            timestamp: Date.now()
          })
          // Auto-close substitution modal after 5 seconds
          setTimeout(() => {
            setSubstitutionModal(null)
          }, 5000)

          // Add player to recently substituted list for flashing effect
          setRecentlySubstitutedPlayers(prev => [...prev, { team: _actionData.team, playerNumber: _actionData.playerIn, timestamp: Date.now() }])

          // Clear the flash after 3 seconds
          if (recentSubFlashTimeoutRef.current) {
            clearTimeout(recentSubFlashTimeoutRef.current)
          }
          recentSubFlashTimeoutRef.current = setTimeout(() => {
            setRecentlySubstitutedPlayers([])
          }, 3000)
        } else if (_action === 'set_end') {
          // Start between-sets countdown
          setBetweenSetsCountdown({
            countdown: _actionData.countdown || 180,
            started: true,
            setIndex: _actionData.setIndex,
            winner: _actionData.winner
          })
        }
        return // Don't process as regular data update
      }
      
      if (updatedData && updatedData.match) {
        const receiveTimestamp = Date.now()
        const serverTimestamp = updatedData._timestamp || receiveTimestamp
        const scoreboardTimestamp = updatedData._scoreboardTimestamp || receiveTimestamp
        const totalLatency = receiveTimestamp - scoreboardTimestamp
        const serverToRefereeLatency = receiveTimestamp - serverTimestamp
        
        console.log(`[Referee] 📥 Received match-data-update at ${new Date(receiveTimestamp).toISOString()} (${receiveTimestamp}):`, {
          hasHomeTeam: !!updatedData.homeTeam,
          hasAwayTeam: !!updatedData.awayTeam,
          setsCount: updatedData.sets?.length,
          eventsCount: updatedData.events?.length,
          totalLatency: `${totalLatency}ms (Scoreboard → Referee)`,
          serverToRefereeLatency: `${serverToRefereeLatency}ms (Server → Referee)`
        })
        // Only update if data is complete (has teams and sets)
        if (updatedData.homeTeam && updatedData.awayTeam && updatedData.sets?.length > 0) {
          updateMatchDataState({ success: true, ...updatedData })
        } else {
          // This can happen during toggle changes from MatchSetup - expected, not an error
          console.debug('[Referee] Received partial data (missing teams/sets), skipping UI update')
        }
      }
    })

    // No polling - data comes from Scoreboard via WebSocket when actions occur

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [matchId, updateMatchDataState, isMasterMode, fetchFreshData])

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
  const lineup = useMemo(() => {
    if (!data || !data.events || !data.currentSet) {
      return { home: null, away: null }
    }

    const currentSetEvents = data.events.filter(
      e => (e.setIndex || 1) === (data.currentSet?.index || 1)
    )

    const homeLineupEvents = currentSetEvents.filter(e => e.type === 'lineup' && e.payload?.team === 'home')
    const awayLineupEvents = currentSetEvents.filter(e => e.type === 'lineup' && e.payload?.team === 'away')

    const latestHomeLineup = homeLineupEvents[homeLineupEvents.length - 1]
    const latestAwayLineup = awayLineupEvents[awayLineupEvents.length - 1]

    return {
      home: latestHomeLineup?.payload?.lineup || null,
      away: latestAwayLineup?.payload?.lineup || null
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

  // Determine which team is on the left
  const leftIsHomeFor2ndRef = useMemo(() => {
    if (!data?.currentSet) return true
    if (data.currentSet.index === 1) return teamAKey === 'home'
    return teamAKey !== 'home'
  }, [data?.currentSet, teamAKey])

  const leftIsHome = refereeView === '1st' ? !leftIsHomeFor2ndRef : leftIsHomeFor2ndRef
  
  const leftTeam = leftIsHome ? 'home' : 'away'
  const rightTeam = leftIsHome ? 'away' : 'home'
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
  
  // Get libero on court for a team - returns { position, liberoNumber, liberoType, playerNumber } or null
  const getLiberoOnCourt = useCallback((teamKey) => {
    if (!data?.events || !data?.currentSet) return null
    
    const currentSetEvents = data.events.filter(e => e.setIndex === data.currentSet.index)
    const lineupEvents = currentSetEvents.filter(e => e.type === 'lineup' && e.payload?.team === teamKey)
    
    if (lineupEvents.length === 0) return null
    
    const latestLineup = lineupEvents[lineupEvents.length - 1]
    const currentLineup = latestLineup?.payload?.lineup || {}
    const liberoSub = latestLineup?.payload?.liberoSubstitution
    
    const teamPlayers = teamKey === 'home' ? data.homePlayers : data.awayPlayers
    
    // Check each position to find if a libero is there
    for (const [position, playerNum] of Object.entries(currentLineup)) {
      const player = teamPlayers?.find(p => String(p.number) === String(playerNum))
      if (player && (player.libero === 'libero1' || player.libero === 'libero2')) {
        // Found a libero on court - try to find which player they replaced
        let replacedPlayer = liberoSub?.playerNumber
        
        if (!replacedPlayer) {
          // Look through lineup history to find the original player at this position
          for (let i = lineupEvents.length - 2; i >= 0; i--) {
            const prevLineup = lineupEvents[i]?.payload?.lineup
            if (prevLineup && prevLineup[position]) {
              const prevPlayer = teamPlayers?.find(p => String(p.number) === String(prevLineup[position]))
              if (prevPlayer && prevPlayer.libero !== 'libero1' && prevPlayer.libero !== 'libero2') {
                replacedPlayer = prevPlayer.number
                break
              }
            }
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
      String(e.payload?.player) === String(playerNumber)
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
    for (const [position, playerNum] of Object.entries(lineup)) {
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
    } else if (!isBetweenSets) {
      // Reset to null only when no longer between sets (new set started)
      setBetweenSetsCountdown(null)
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

  if (!data) return null

  // Player circle component - BIG responsive sizing with all indicators
  const PlayerCircle = ({ number, position, team, isServing }) => {
    if (!number) return null

    const teamPlayers = team === 'home' ? data.homePlayers : data.awayPlayers
    const player = teamPlayers?.find(p => String(p.number) === String(number))
    const isLibero = player?.libero === 'libero1' || player?.libero === 'libero2'
    const shouldShowBall = position === 'I' && isServing

    // Check if this player was recently substituted in (for flashing effect)
    const isRecentlySub = recentlySubstitutedPlayers.some(
      sub => sub.team === team && String(sub.playerNumber) === String(number)
    )

    // Get libero info - if this is a libero, show which player they replaced
    const liberoOnCourt = getLiberoOnCourt(team)
    const liberoReplacedPlayer = isLibero && liberoOnCourt?.playerNumber ? liberoOnCourt.playerNumber : null

    // Get substitution info - if this player came in as a substitute
    const subInfo = !isLibero ? getSubstitutionInfo(team, number) : null

    // Get sanctions for this player
    const sanctions = getPlayerSanctions(team, number)
    const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
    const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
    const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
    const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')

    // Determine what to show in top-right badge
    const topRightBadge = liberoReplacedPlayer || (subInfo?.replacedNumber) || null
    const isLiberoReplacementBadge = !!liberoReplacedPlayer

    // Get libero label for bottom-left
    const liberoLabel = isLibero ? (player?.libero === 'libero1' ? 'L1' : 'L2') : null
    const liberoCount = teamPlayers?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
    const displayLiberoLabel = isLibero ? (liberoCount === 1 ? 'L' : liberoLabel) : null

    return (
      <div style={{
          position: 'relative',
        width: 'fit-content',
        aspectRatio: '1/1',
        borderRadius: '0%',
        padding: '2px',
        border: isRecentlySub ? '3px solid  #fef08a' : '1px solid rgba(255, 255, 255, 0.4)',
        background: isRecentlySub ? '#fef08a' : isLibero ? '#FFF8E7' : (team === leftTeam ? 'rgba(65, 66, 68, 0.9)' : 'rgba(12, 14, 100, 0.7)'),
          color: isRecentlySub ? '#dc2626' : isLibero ? '#000' : '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 'clamp(33px, 9vw, 80px)',
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
        
        {/* Bottom-left: Libero indicator (L, L1, L2) */}
        {displayLiberoLabel && (
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
        
        {/* Bottom-right: Sanction indicators */}
        {(hasWarning || hasPenalty || hasExpulsion || hasDisqualification) && (
          <div style={{
            position: 'absolute',
            bottom: '-6px',
            right: '-6px',
            display: 'flex',
            gap: '2px',
            background: 'rgba(0, 0, 0, 0.6)',
            padding: '2px 4px',
            borderRadius: '4px'
          }}>
            {hasWarning && (
              <div style={{ width: '8px', height: '11px', background: '#fde047', borderRadius: '1px' }} />
                )}
                {(hasPenalty || hasDisqualification) && (
              <div style={{ width: '8px', height: '11px', background: '#ef4444', borderRadius: '1px' }} />
            )}
            {hasExpulsion && (
              <div style={{ display: 'flex', gap: '1px' }}>
                <div style={{ width: '6px', height: '11px', background: '#fde047', borderRadius: '1px' }} />
                <div style={{ width: '6px', height: '11px', background: '#ef4444', borderRadius: '1px' }} />
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

  // Show results when match is finished
  if (isMatchFinished) {
    const teamAShortName = data?.match?.coinTossTeamA === 'home'
      ? (data?.match?.homeShortName || data?.homeTeam?.shortName || data?.homeTeam?.name || 'Home')
      : (data?.match?.awayShortName || data?.awayTeam?.shortName || data?.awayTeam?.name || 'Away')
    const teamBShortName = data?.match?.coinTossTeamA === 'home'
      ? (data?.match?.awayShortName || data?.awayTeam?.shortName || data?.awayTeam?.name || 'Away')
      : (data?.match?.homeShortName || data?.homeTeam?.shortName || data?.homeTeam?.name || 'Home')

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
          The match has ended
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
      {/* Between Sets Countdown Modal */}
      {betweenSetsCountdown && (
        <div
          onClick={() => setBetweenSetsCountdown(null)}
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
      {timeoutModal && timeoutModal.started && (
        <div
          onClick={() => setTimeoutModal(null)}
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

      {/* Substitution Modal (from Scoreboard action) */}
      {substitutionModal && (
        <div
          onClick={() => setSubstitutionModal(null)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.85)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            zIndex: 9997,
            cursor: 'pointer'
          }}
        >
          <div style={{
            background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
            borderRadius: '24px',
            padding: '32px 48px',
            textAlign: 'center',
            border: '2px solid rgba(59, 130, 246, 0.5)',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
            minWidth: '300px'
            }}>
            <div style={{
              fontSize: '18px',
                fontWeight: 600,
                textTransform: 'uppercase',
              letterSpacing: '2px',
              color: '#3b82f6',
              marginBottom: '16px'
              }}>
              🔄 Substitution
            </div>
            <div style={{
              fontSize: '14px',
              color: 'rgba(255, 255, 255, 0.7)',
              marginBottom: '24px'
            }}>
              {substitutionModal.teamName || (substitutionModal.team === 'home' ? 'Home' : 'Away')}
              {substitutionModal.isExceptional && <span style={{ color: '#f59e0b', marginLeft: '8px' }}>(Exceptional)</span>}
            </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
              gap: '24px',
              fontSize: '48px',
              fontWeight: 700
          }}>
            <div style={{
              display: 'flex',
                flexDirection: 'column',
                alignItems: 'center'
              }}>
                <div style={{ color: '#ef4444' }}>#{substitutionModal.playerOut}</div>
                <div style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.5)' }}>OUT</div>
              </div>
              <div style={{ fontSize: '32px', color: 'rgba(255, 255, 255, 0.3)' }}>→</div>
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                alignItems: 'center'
                }}>
                <div style={{ color: '#22c55e' }}>#{substitutionModal.playerIn}</div>
                <div style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.5)' }}>IN</div>
              </div>
                  </div>
                  <div style={{
              marginTop: '16px',
              fontSize: '12px',
              color: 'rgba(255, 255, 255, 0.4)'
            }}>
              Position {substitutionModal.position} • Auto-closes in 5s
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

                return Object.entries(teamLineup).map(([position, playerNum]) => (
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
                ))
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
            {isFullscreen ? '⛶ Exit' : '⛶'}
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
            title={wakeLockActive ? 'Screen will stay on' : 'Screen may turn off'}
          >
            {wakeLockActive ? '☀️ On' : '🌙 Off'}
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
              TEST MODE
              </span>
          )}
            </div>

        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {/* Version */}
          <span style={{ fontSize: '10px', color: 'rgba(255, 255, 255, 0.5)' }}>
            v{currentVersion}
          </span>
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
                const useShort = shortName && (fullName.length > 10 || window.innerWidth < 600);
                return useShort ? shortName : fullName;
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
                const useShort = shortName && (fullName.length > 10 || window.innerWidth < 600);
                return useShort ? shortName : fullName;
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
                  {leftLineup?.I || ''}
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
                  {rightLineup?.I || ''}
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
                  <PlayerCircle number={leftLineup?.V} position="V" team={leftTeam} isServing={leftServing} />
                  <PlayerCircle number={leftLineup?.VI} position="VI" team={leftTeam} isServing={leftServing} />
                  <PlayerCircle number={leftLineup?.I} position="I" team={leftTeam} isServing={leftServing} />
                </div>
                {/* Front row (IV, III, II) - right side of left court (near net) */}
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-around',
                  alignItems: 'center'
                }}>
                  <PlayerCircle number={leftLineup?.IV} position="IV" team={leftTeam} isServing={leftServing} />
                  <PlayerCircle number={leftLineup?.III} position="III" team={leftTeam} isServing={leftServing} />
                  <PlayerCircle number={leftLineup?.II} position="II" team={leftTeam} isServing={leftServing} />
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
                          cursor: 'grab'
                        }}
                      >
                        <PlayerCircle number={leftLineup?.[pos]} position={pos} team={leftTeam} isServing={leftServing} />
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
                  Line-up set
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
                  Show Line-up
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
                  <PlayerCircle number={rightLineup?.II} position="II" team={rightTeam} isServing={rightServing} />
                  <PlayerCircle number={rightLineup?.III} position="III" team={rightTeam} isServing={rightServing} />
                  <PlayerCircle number={rightLineup?.IV} position="IV" team={rightTeam} isServing={rightServing} />
                </div>
                {/* Back row (I, VI, V) - right side of right court */}
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-around',
                  alignItems: 'center'
                }}>
                  <PlayerCircle number={rightLineup?.I} position="I" team={rightTeam} isServing={rightServing} />
                  <PlayerCircle number={rightLineup?.VI} position="VI" team={rightTeam} isServing={rightServing} />
                  <PlayerCircle number={rightLineup?.V} position="V" team={rightTeam} isServing={rightServing} />
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
                          cursor: 'grab'
                        }}
                      >
                        <PlayerCircle number={rightLineup?.[pos]} position={pos} team={rightTeam} isServing={rightServing} />
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
                  Line-up set
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
                  Show Line-up
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
            color: leftColor,
            textShadow: '0 1px 2px rgba(0,0,0,0.5)',
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
          padding: '3px',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden'
        }}>
          <span style={{
            fontSize: 'clamp(14px, 4vw, 24px)',
            fontWeight: 700,
            color: rightColor,
            textShadow: '0 1px 2px rgba(0,0,0,0.5)',
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

      {/* SECTION 5: Actions Area - 20% */}
        <div style={{
          flex: '0 0 20%',
          padding: '6px 12px',
          background: 'rgba(0, 0, 0, 0.2)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          overflow: 'hidden',
          minHeight: 0
        }}>
          {/* Show timeout countdown if active */}
          {timeoutModal && (
            <div style={{
              textAlign: 'center',
              padding: 'clamp(8px, 2vw, 16px)',
              background: 'rgba(251, 191, 36, 0.2)',
              borderRadius: '8px',
              border: '2px solid var(--accent)',
              width: '100%',
              maxWidth: '400px'
            }}>
              <div style={{ fontSize: 'clamp(12px, 3vw, 16px)', color: 'var(--muted)', marginBottom: 'clamp(4px, 1vw, 8px)' }}>TIMEOUT</div>
              <div style={{ fontSize: 'clamp(14px, 3.5vw, 18px)', fontWeight: 600 }}>
                {timeoutModal.team === 'home' ? (data?.homeTeam?.shortName || data?.homeTeam?.name || 'Home') : (data?.awayTeam?.shortName || data?.awayTeam?.name || 'Away')}
              </div>
              <div style={{ fontSize: 'clamp(32px, 8vw, 48px)', fontWeight: 800, color: 'var(--accent)' }}>
                {timeoutModal.countdown}"
              </div>
            </div>
          )}

          {/* Show between-sets countdown if active */}
          {betweenSetsCountdown && betweenSetsCountdown.countdown > 0 && (
            <div style={{
              textAlign: 'center',
              padding: 'clamp(8px, 2vw, 16px)',
              background: 'rgba(34, 197, 94, 0.2)',
              borderRadius: '8px',
              border: '2px solid #22c55e',
              width: '100%',
              maxWidth: '400px'
            }}>
              <div style={{ fontSize: 'clamp(12px, 3vw, 16px)', color: 'var(--muted)', marginBottom: 'clamp(4px, 1vw, 8px)' }}>INTERVAL</div>
              <div style={{ fontSize: 'clamp(32px, 8vw, 48px)', fontWeight: 800, color: '#22c55e' }}>
                {Math.floor(betweenSetsCountdown.countdown / 60)}:{String(betweenSetsCountdown.countdown % 60).padStart(2, '0')}
              </div>
            </div>
          )}

          {/* Show substitution modal info if active */}
          {substitutionModal && (
            <div style={{
              textAlign: 'center',
              padding: 'clamp(8px, 2vw, 16px)',
              background: 'rgba(59, 130, 246, 0.2)',
              borderRadius: '8px',
              border: '2px solid #3b82f6',
              width: '100%',
              maxWidth: '400px'
            }}>
              <div style={{ fontSize: 'clamp(12px, 3vw, 16px)', color: 'var(--muted)', marginBottom: 'clamp(4px, 1vw, 8px)' }}>
                {substitutionModal.isExceptional ? 'EXCEPTIONAL SUB' : 'SUBSTITUTION'}
              </div>
              <div style={{ fontSize: 'clamp(14px, 3.5vw, 18px)', fontWeight: 600, marginBottom: 'clamp(4px, 1vw, 8px)' }}>
                {substitutionModal.teamName}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'clamp(12px, 4vw, 24px)' }}>
                <span style={{ color: '#ef4444', fontWeight: 700, fontSize: 'clamp(24px, 6vw, 36px)' }}>#{substitutionModal.playerOut}</span>
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 'clamp(20px, 5vw, 28px)' }}>→</span>
                <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 'clamp(24px, 6vw, 36px)' }}>#{substitutionModal.playerIn}</span>
              </div>
            </div>
          )}

          {/* Default: Show favicon when no action */}
          {!timeoutModal && !substitutionModal && (!betweenSetsCountdown || betweenSetsCountdown.countdown <= 0) && (
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              minHeight: 0,
              overflow: 'hidden'
            }}>
              {data?.rallyStatus === 'in_play' ? (
                <div style={{
                  color: '#22c55e',
                  fontWeight: 600,
                  fontSize: 'clamp(18px, 5vw, 28px)',
                  textAlign: 'center'
                }}>
                  Rally in progress...
                </div>
              ) : (
                <img
                  src={favicon}
                  alt=""
                  style={{
                    maxHeight: '100%',
                    maxWidth: '100%',
                    width: 'auto',
                    height: 'auto',
                    objectFit: 'contain'
                  }}
                />
              )}
            </div>
          )}
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
