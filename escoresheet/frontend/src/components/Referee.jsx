import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { getMatchData, subscribeToMatchData, listAvailableMatches, getWebSocketStatus } from '../utils/serverDataSync'
import mikasaVolleyball from '../mikasa_v200w.png'
import { ConnectionManager } from '../utils/connectionManager'
import ConnectionStatus from './ConnectionStatus'
import { db } from '../db/db'

export default function Referee({ matchId, onExit, isMasterMode }) {
  const [refereeView, setRefereeView] = useState('2nd') // '1st' or '2nd'
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Modal states (from Scoreboard actions)
  const [substitutionModal, setSubstitutionModal] = useState(null) // { team, teamName, position, playerIn, playerOut, isExceptional, timestamp }
  const [timeoutModal, setTimeoutModal] = useState(null) // { team, countdown, started }

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
          { number: 4 }, { number: 5 }, { number: 6 },
          { number: 7, libero: 'libero1' }
        ],
        awayPlayers: [
          { number: 11 }, { number: 12 }, { number: 13 },
          { number: 14 }, { number: 15 }, { number: 16 },
          { number: 17, libero: 'libero1' }
        ],
        sets: [{ index: 1, homePoints: 12, awayPoints: 10, finished: false }],
        currentSet: { index: 1, homePoints: 12, awayPoints: 10, finished: false },
        events: [
          { type: 'lineup', setIndex: 1, payload: { team: 'home', I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }},
          { type: 'lineup', setIndex: 1, payload: { team: 'away', I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 }}
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
    const interval = setInterval(checkConnectionStatuses, 5000)
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
          console.warn('[Referee] Received incomplete WebSocket data, skipping update')
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
    
    if (!data?.events || data.events.length === 0) {
      return data.match.firstServe || 'home'
    }
    
    const pointEvents = data.events
      .filter(e => e.type === 'point' && e.setIndex === data.currentSet.index)
      .sort((a, b) => {
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime
      })
    
    if (pointEvents.length === 0) {
      return data.match.firstServe || 'home'
    }
    
    return pointEvents[0].payload?.team || data.match.firstServe || 'home'
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

  if (!data) return null

  // Player circle component - BIG responsive sizing with all indicators
  const PlayerCircle = ({ number, position, team, isServing }) => {
    if (!number) return null
    
    const teamPlayers = team === 'home' ? data.homePlayers : data.awayPlayers
    const player = teamPlayers?.find(p => String(p.number) === String(number))
    const isLibero = player?.libero === 'libero1' || player?.libero === 'libero2'
    const shouldShowBall = position === 'I' && isServing
    
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
    const displayLiberoLabel = liberoCount === 1 ? 'L' : liberoLabel
    
    return (
      <div style={{
          position: 'relative',
        width: 'clamp(44px, 10vw, 70px)',
        height: 'clamp(44px, 10vw, 70px)',
        borderRadius: '50%',
        border: '3px solid rgba(255, 255, 255, 0.4)',
        background: isLibero ? '#FFF8E7' : (team === leftTeam ? 'rgba(65, 66, 68, 0.9)' : 'rgba(12, 14, 100, 0.7)'),
        color: isLibero ? '#000' : '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 'clamp(18px, 5vw, 28px)',
        fontWeight: 700,
        boxShadow: '0 3px 12px rgba(0, 0, 0, 0.5)',
        flexShrink: 0
      }}>
        {/* Serve ball indicator */}
        {shouldShowBall && (
          <img 
            src={mikasaVolleyball} 
            alt="Ball" 
            style={{
              position: 'absolute',
              left: team === leftTeam ? 'clamp(-38px, -10vw, -55px)' : 'auto',
              right: team === rightTeam ? 'clamp(-38px, -10vw, -55px)' : 'auto',
              top: '50%',
              transform: 'translateY(-50%)',
              width: 'clamp(24px, 6vw, 38px)',
              height: 'clamp(24px, 6vw, 38px)',
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
            {isFullscreen ? '⛶ Exit' : '⛶ Full'}
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
              
          <ConnectionStatus
            connectionStatuses={connectionStatuses}
            connectionDebugInfo={connectionDebugInfo}
            position="right"
            size="small"
          />
          
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
          <button
            onClick={() => setRefereeView('1st')}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontWeight: 600,
              background: refereeView === '1st' ? 'var(--accent)' : 'rgba(255,255,255,0.1)',
              color: refereeView === '1st' ? '#000' : '#fff',
              border: refereeView === '1st' ? 'none' : '1px solid rgba(255,255,255,0.2)',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            1R
          </button>
          <button
            onClick={() => setRefereeView('2nd')}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontWeight: 600,
              background: refereeView === '2nd' ? 'var(--accent)' : 'rgba(255,255,255,0.1)',
              color: refereeView === '2nd' ? '#000' : '#fff',
              border: refereeView === '2nd' ? 'none' : '1px solid rgba(255,255,255,0.2)',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            2R
          </button>
          <button
            onClick={onExit}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              fontWeight: 600,
              background: 'rgba(239, 68, 68, 0.2)',
              color: '#ef4444',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Exit
          </button>
        </div>
            </div>

      {/* SECTION 2: Score & Set Counter - 3 COLUMNS */}
            <div style={{ 
        flex: '1 1 auto',
        padding: '8px 0',
        background: 'rgba(0, 0, 0, 0.2)',
            display: 'flex',
        flexDirection: 'row',
            alignItems: 'center',
          justifyContent: 'center',
        width: '100%',
        maxWidth: '100%',
        overflow: 'hidden'
        }}>
        {/* LEFT COLUMN - Serve indicator (1/5) */}
              <div style={{
          flex: '0 0 20%',
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

        {/* MIDDLE COLUMN - Set & Score (3/5) */}
        <div style={{ 
          flex: '0 0 60%',
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          justifyContent: 'center', 
          gap: '4px',
          minWidth: 0,
          overflow: 'hidden'
        }}>
          {/* Set indicator row */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
            justifyContent: 'center',
            gap: 'clamp(8px, 2vw, 16px)'
        }}>
            <div style={{
              padding: 'clamp(2px, 0.5vw, 4px) clamp(8px, 2vw, 14px)',
              background: 'rgba(255, 255, 255, 0.1)',
              borderRadius: '6px',
              fontSize: 'clamp(14px, 3vw, 22px)',
              fontWeight: 700
            }}>
              {leftSetScore}
            </div>
                <div style={{
            display: 'flex', 
                  flexDirection: 'column',
              alignItems: 'center'
          }}>
              <span style={{ fontSize: 'clamp(8px, 1.5vw, 11px)', color: 'var(--muted)', textTransform: 'uppercase' }}>SET</span>
              <span style={{ fontSize: 'clamp(16px, 3.5vw, 24px)', fontWeight: 700 }}>{data?.currentSet?.index || 1}</span>
                </div>
                  <div style={{
              padding: 'clamp(2px, 0.5vw, 4px) clamp(8px, 2vw, 14px)',
              background: 'rgba(255, 255, 255, 0.1)',
              borderRadius: '6px',
              fontSize: 'clamp(14px, 3vw, 22px)',
              fontWeight: 700
                  }}>
              {rightSetScore}
              </div>
            </div>
            
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
              {/* A/B box with team name below */}
                <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'clamp(6px, 2vw, 20px)'
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{
                    padding: 'clamp(4px, 1vw, 8px) clamp(10px, 2.5vw, 20px)',
                    background: leftColor,
                    color: isBrightColor(leftColor) ? '#000' : '#fff',
                    borderRadius: '6px',
                    fontSize: 'clamp(20px, 5vw, 40px)',
                    fontWeight: 700
                }}>
                  {leftLabel}
            </span>
                  <span style={{ fontSize: 'clamp(9px, 1.5vw, 12px)', color: 'var(--muted)', marginTop: '2px' }}>
                  {leftTeam === 'home' ? (data?.match?.homeShortName || leftTeamData?.name?.substring(0, 3).toUpperCase() || 'HOM') : (data?.match?.awayShortName || leftTeamData?.name?.substring(0, 3).toUpperCase() || 'AWY')}
                </span>
                </div>
              <span style={{
                  fontSize: 'clamp(36px, 12vw, 100px)',
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
              <span style={{ fontSize: 'clamp(28px, 10vw, 80px)', fontWeight: 800, color: 'var(--muted)', lineHeight: 1 }}>:</span>
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
                  fontSize: 'clamp(36px, 12vw, 100px)',
                fontWeight: 800,
                color: 'var(--accent)',
                  lineHeight: 1,
                  textAlign: 'left'
                      }}>
                {rightScore}
              </span>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{
                    padding: 'clamp(4px, 1vw, 8px) clamp(10px, 2.5vw, 20px)',
                    background: rightColor,
                    color: isBrightColor(rightColor) ? '#000' : '#fff',
                    borderRadius: '6px',
                    fontSize: 'clamp(20px, 5vw, 40px)',
                    fontWeight: 700
                  }}>
                  {rightLabel}
                </span>
                  <span style={{ fontSize: 'clamp(9px, 1.5vw, 12px)', color: 'var(--muted)', marginTop: '2px' }}>
                  {rightTeam === 'home' ? (data?.match?.homeShortName || rightTeamData?.name?.substring(0, 3).toUpperCase() || 'HOM') : (data?.match?.awayShortName || rightTeamData?.name?.substring(0, 3).toUpperCase() || 'AWY')}
                </span>
                      </div>
                      </div>
                      </div>
                    </div>
          </div>

        {/* RIGHT COLUMN - Serve indicator (1/5) */}
          <div style={{
          flex: '0 0 20%',
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

      {/* SECTION 3: Court - responsive with aspect ratio */}
        <div style={{
        flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        padding: '4px 4px',
        overflow: 'hidden'
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
          <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
            position: 'relative',
            height: '100%'
          }}>
          <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
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
        </div>

          {/* Right side */}
        <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            position: 'relative',
            height: '100%'
              }}>
              <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
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
              </div>
            </div>
          </div>

      {/* SECTION 4: Results & TO/SUB Counters - TWO ROWS */}
        <div style={{
        flex: '1 1 auto',
        padding: '6px 12px',
        background: 'rgba(0, 0, 0, 0.2)',
          display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
        }}>
        {/* ROW 1: TO/SUB Counters (1/3 height) */}
          <div style={{
          flex: '0 0 auto',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 8px',
          marginBottom: '6px'
                }}>
          {/* Left team TO/SUB - left aligned, same row */}
                <div style={{
                  display: 'flex',
            flexDirection: 'row',
            gap: '12px',
            alignItems: 'center'
          }}>
            <div style={{
              background: timeoutModal?.team === leftTeam ? 'rgba(251, 191, 36, 0.2)' : 'rgba(255, 255, 255, 0.05)',
              borderRadius: '6px',
              padding: '6px 12px',
              textAlign: 'center',
              border: timeoutModal?.team === leftTeam ? '2px solid var(--accent)' : '1px solid rgba(255, 255, 255, 0.1)',
              cursor: timeoutModal?.team === leftTeam ? 'pointer' : 'default',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px'
                    }}
            onClick={() => timeoutModal?.team === leftTeam && setTimeoutModal(null)}
                  >
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>TO</span>
              {timeoutModal?.team === leftTeam ? (
                <span style={{ fontSize: '20px', fontWeight: 800, color: 'var(--accent)' }}>
                  {timeoutModal.countdown}"
                </span>
              ) : (
                <span style={{
                  fontSize: '20px',
                  fontWeight: 700,
                  color: leftStats.timeouts >= 2 ? '#ef4444' : 'inherit'
                  }}>
                  {leftStats.timeouts}
                </span>
              )}
                  </div>
                <div style={{
              background: 'rgba(255, 255, 255, 0.05)',
              borderRadius: '6px',
              padding: '6px 12px',
              textAlign: 'center',
              border: '1px solid rgba(255, 255, 255, 0.1)',
                  display: 'flex',
              alignItems: 'center',
                  gap: '8px'
                }}>
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>SUB</span>
              <span style={{
                fontSize: '20px',
                  fontWeight: 700,
                color: leftStats.substitutions >= 6 ? '#ef4444' : leftStats.substitutions >= 5 ? '#eab308' : 'inherit'
                  }}>
                {leftStats.substitutions}
              </span>
                  </div>
          </div>

          {/* Right team TO/SUB - right aligned, same row */}
                <div style={{
                  display: 'flex',
            flexDirection: 'row',
                  gap: '12px',
            alignItems: 'center'
                    }}>
                <div style={{
              background: timeoutModal?.team === rightTeam ? 'rgba(251, 191, 36, 0.2)' : 'rgba(255, 255, 255, 0.05)',
              borderRadius: '6px',
              padding: '6px 12px',
              textAlign: 'center',
              border: timeoutModal?.team === rightTeam ? '2px solid var(--accent)' : '1px solid rgba(255, 255, 255, 0.1)',
              cursor: timeoutModal?.team === rightTeam ? 'pointer' : 'default',
                  display: 'flex',
              alignItems: 'center',
                  gap: '8px'
            }}
            onClick={() => timeoutModal?.team === rightTeam && setTimeoutModal(null)}
            >
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>TO</span>
              {timeoutModal?.team === rightTeam ? (
                <span style={{ fontSize: '20px', fontWeight: 800, color: 'var(--accent)' }}>
                  {timeoutModal.countdown}"
                </span>
              ) : (
                <span style={{
                  fontSize: '20px',
                  fontWeight: 700,
                  color: rightStats.timeouts >= 2 ? '#ef4444' : 'inherit'
                }}>
                  {rightStats.timeouts}
                </span>
              )}
                  </div>
                <div style={{
              background: 'rgba(255, 255, 255, 0.05)',
              borderRadius: '6px',
              padding: '6px 12px',
              textAlign: 'center',
              border: '1px solid rgba(255, 255, 255, 0.1)',
                  display: 'flex',
              alignItems: 'center',
              gap: '8px'
                }}>
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>SUB</span>
              <span style={{
                fontSize: '20px',
                fontWeight: 700,
                color: rightStats.substitutions >= 6 ? '#ef4444' : rightStats.substitutions >= 5 ? '#eab308' : 'inherit'
              }}>
                {rightStats.substitutions}
              </span>
                  </div>
                </div>
        </div>

        {/* ROW 2: Results table (2/3 height, full width) */}
                <div style={{
          flex: '1 1 auto',
                  display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          overflow: 'auto'
                }}>
          <div style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: '2px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '10px',
            padding: '10px 16px',
            width: '100%',
            maxWidth: '500px'
          }}>
            <h4 style={{ margin: '0 0 8px', fontSize: '16px', fontWeight: 700, textAlign: 'center' }}>
              Results
            </h4>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '15px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.2)' }}>
                  <th style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700 }}>T</th>
                  <th style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700 }}>S</th>
                  <th style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700, borderRight: '2px solid rgba(255,255,255,0.2)' }}>P</th>
                  <th style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700, borderRight: '2px solid rgba(255,255,255,0.2)' }}>SET</th>
                  <th style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700, borderLeft: '2px solid rgba(255,255,255,0.2)' }}>P</th>
                  <th style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700 }}>S</th>
                  <th style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700 }}>T</th>
                </tr>
              </thead>
              <tbody>
                {(data?.sets || []).filter(set => set.index <= (data?.currentSet?.index || 1)).map((set, idx) => {
                  const setEvents = data?.events?.filter(e => e.setIndex === set.index) || []
                  const leftSetPoints = leftTeam === 'home' ? set.homePoints : set.awayPoints
                  const rightSetPoints = rightTeam === 'home' ? set.homePoints : set.awayPoints
                  const leftSetTimeouts = setEvents.filter(e => e.type === 'timeout' && e.payload?.team === leftTeam).length
                  const rightSetTimeouts = setEvents.filter(e => e.type === 'timeout' && e.payload?.team === rightTeam).length
                  const leftSetSubs = setEvents.filter(e => e.type === 'substitution' && e.payload?.team === leftTeam).length
                  const rightSetSubs = setEvents.filter(e => e.type === 'substitution' && e.payload?.team === rightTeam).length
                  
                  return (
                    <tr key={set.id || idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                      <td style={{ padding: '6px 10px', textAlign: 'center', fontSize: '15px' }}>{leftSetTimeouts}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', fontSize: '15px' }}>{leftSetSubs}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', fontSize: '17px', fontWeight: 600, borderRight: '2px solid rgba(255,255,255,0.2)' }}>{leftSetPoints || 0}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 700, fontSize: '17px', borderRight: '2px solid rgba(255,255,255,0.2)' }}>{set.index}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', fontSize: '17px', fontWeight: 600, borderLeft: '2px solid rgba(255,255,255,0.2)' }}>{rightSetPoints || 0}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', fontSize: '15px' }}>{rightSetSubs}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', fontSize: '15px' }}>{rightSetTimeouts}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
                </div>
          </div>
    </div>
    </div>
  )
}
