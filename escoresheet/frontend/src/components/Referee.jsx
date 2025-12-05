import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import mikasaVolleyball from '../mikasa_v200w.png'
import { ConnectionManager } from '../utils/connectionManager'
import Modal from './Modal'

export default function Referee({ matchId, onExit }) {
  const [refereeView, setRefereeView] = useState('2nd') // '1st' or '2nd'
  const [activeTimeout, setActiveTimeout] = useState(null) // { team: 'home'|'away', countdown: number, eventId: number }
  const [processedTimeouts, setProcessedTimeouts] = useState(new Set()) // Track which timeout events we've already shown
  const [activeSubstitution, setActiveSubstitution] = useState(null) // { team: 'home'|'away', playerOut, playerIn, eventId: number, countdown: 5 }
  const [processedSubstitutions, setProcessedSubstitutions] = useState(new Set()) // Track which substitution events we've already shown
  const [betweenSetsCountdown, setBetweenSetsCountdown] = useState(null) // { countdown: number, started: boolean, finished?: boolean } | null
  const [captainOnCourtModal, setCaptainOnCourtModal] = useState(null) // { team: 'home'|'away', playersOnCourt: number[], lineup: object } | null
  const [processedCaptainRequests, setProcessedCaptainRequests] = useState(new Set()) // Track which requests we've processed
  
  // Connection state
  const [connectionModal, setConnectionModal] = useState(null) // 'bluetooth' | 'lan' | 'internet' | null
  const [connectionType, setConnectionType] = useState(null) // 'bluetooth' | 'lan' | 'internet' | 'database'
  const [connectionStatus, setConnectionStatus] = useState('disconnected') // 'connected' | 'disconnected' | 'connecting' | 'error'
  const [connectionError, setConnectionError] = useState('')
  const [lanIP, setLanIP] = useState('')
  const [lanPort, setLanPort] = useState('8080')
  const [internetURL, setInternetURL] = useState('')
  const connectionManagerRef = useRef(null)
  
  // Send heartbeat to indicate referee is connected (only if connection is enabled)
  useEffect(() => {
    // Check if referee connection is enabled before starting heartbeat
    const checkAndStartHeartbeat = async () => {
      const match = await db.matches.get(matchId)
      if (match?.refereeConnectionEnabled === false) return null
      
      const updateHeartbeat = async () => {
        try {
          const heartbeatData = refereeView === '1st' 
            ? { lastReferee1Heartbeat: new Date().toISOString() }
            : { lastReferee2Heartbeat: new Date().toISOString() }
          await db.matches.update(matchId, heartbeatData)
        } catch (error) {
          console.error('Failed to update referee heartbeat:', error)
        }
      }
      
      // Initial heartbeat
      updateHeartbeat()
      
      // Update heartbeat every 5 seconds
      return setInterval(updateHeartbeat, 5000)
    }
    
    let interval = null
    checkAndStartHeartbeat().then(id => { interval = id })
    
    return () => {
      if (interval) clearInterval(interval)
      // Clear heartbeat on unmount
      const clearData = refereeView === '1st'
        ? { lastReferee1Heartbeat: null }
        : { lastReferee2Heartbeat: null }
      db.matches.update(matchId, clearData)
        .catch(err => console.error('Failed to clear heartbeat:', err))
    }
  }, [matchId, refereeView])

  // Initialize connection manager
  useEffect(() => {
    const handleData = (data) => {
      // Handle incoming data from connection
      // This would sync match data, events, etc.
      console.log('Received data via connection:', data)
    }

    const handleError = (error) => {
      setConnectionError(error.message || 'Connection error')
      setConnectionStatus('error')
    }

    const handleDisconnect = () => {
      setConnectionStatus('disconnected')
      setConnectionType('database') // Fallback to database
    }

    connectionManagerRef.current = new ConnectionManager(handleData, handleError, handleDisconnect)

    return () => {
      if (connectionManagerRef.current) {
        connectionManagerRef.current.disconnect()
      }
    }
  }, [])

  // Handle Bluetooth connection
  const handleConnectBluetooth = useCallback(async () => {
    setConnectionStatus('connecting')
    setConnectionError('')
    try {
      const result = await connectionManagerRef.current.connectBluetooth()
      setConnectionType('bluetooth')
      setConnectionStatus('connected')
      setConnectionModal(null)
    } catch (error) {
      setConnectionError(error.message || 'Failed to connect via Bluetooth')
      setConnectionStatus('error')
    }
  }, [])

  // Handle LAN connection
  const handleConnectLAN = useCallback(async () => {
    if (!lanIP || !lanPort) {
      setConnectionError('Please enter IP address and port')
      return
    }
    setConnectionStatus('connecting')
    setConnectionError('')
    try {
      const port = parseInt(lanPort, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('Invalid port number')
      }
      const result = await connectionManagerRef.current.connectLAN(lanIP, port)
      setConnectionType('lan')
      setConnectionStatus('connected')
      setConnectionModal(null)
    } catch (error) {
      setConnectionError(error.message || 'Failed to connect via LAN')
      setConnectionStatus('error')
    }
  }, [lanIP, lanPort])

  // Handle Internet connection
  const handleConnectInternet = useCallback(async () => {
    if (!internetURL) {
      setConnectionError('Please enter a WebSocket URL')
      return
    }
    setConnectionStatus('connecting')
    setConnectionError('')
    try {
      const result = await connectionManagerRef.current.connectInternet(internetURL)
      setConnectionType('internet')
      setConnectionStatus('connected')
      setConnectionModal(null)
    } catch (error) {
      setConnectionError(error.message || 'Failed to connect via Internet')
      setConnectionStatus('error')
    }
  }, [internetURL])

  // Handle disconnect
  const handleDisconnect = useCallback(async () => {
    try {
      await connectionManagerRef.current.disconnect()
      setConnectionType('database')
      setConnectionStatus('disconnected')
      setConnectionError('')
    } catch (error) {
      console.error('Error disconnecting:', error)
    }
  }, [])

  // Check connection status periodically
  useEffect(() => {
    if (connectionType && connectionType !== 'database') {
      const interval = setInterval(() => {
        const isConnected = connectionManagerRef.current?.isConnected()
        if (isConnected && connectionStatus !== 'connected') {
          setConnectionStatus('connected')
        } else if (!isConnected && connectionStatus === 'connected') {
          setConnectionStatus('disconnected')
        }
      }, 1000)
      return () => clearInterval(interval)
    }
  }, [connectionType, connectionStatus])

  const data = useLiveQuery(async () => {
    const match = await db.matches.get(matchId)
    if (!match) return null

    const [homeTeam, awayTeam] = await Promise.all([
      match?.homeTeamId ? db.teams.get(match.homeTeamId) : null,
      match?.awayTeamId ? db.teams.get(match.awayTeamId) : null
    ])

    const [homePlayers, awayPlayers] = await Promise.all([
      match?.homeTeamId
        ? db.players.where('teamId').equals(match.homeTeamId).sortBy('number')
        : [],
      match?.awayTeamId
        ? db.players.where('teamId').equals(match.awayTeamId).sortBy('number')
        : []
    ])

    const sets = await db.sets
      .where('matchId')
      .equals(matchId)
      .sortBy('index')

    const currentSet = sets.find(s => !s.finished) || null

    const events = await db.events
      .where('matchId')
      .equals(matchId)
      .toArray()

    return {
      match,
      homeTeam,
      awayTeam,
      homePlayers,
      awayPlayers,
      sets,
      currentSet,
      events
    }
  }, [matchId])

  // Calculate rally status
  const rallyStatus = useMemo(() => {
    if (!data?.events || !data?.currentSet || data.events.length === 0) return 'idle'
    
    // Get events for current set only and sort by sequence number (most recent first)
    const currentSetEvents = data.events
      .filter(e => e.setIndex === data.currentSet.index)
      .sort((a, b) => {
        // Sort by sequence number if available, otherwise by timestamp
        const aSeq = a.seq || 0
        const bSeq = b.seq || 0
        if (aSeq !== 0 || bSeq !== 0) {
          return bSeq - aSeq // Descending by sequence (most recent first)
        }
        // Fallback to timestamp for legacy events
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime
      })
    
    if (currentSetEvents.length === 0) return 'idle'
    
    const lastEvent = currentSetEvents[0] // Most recent event is now first
    
    // Check if last event is point or replay first (these end the rally)
    if (lastEvent.type === 'point' || lastEvent.type === 'replay') {
      return 'idle'
    }
    
    if (lastEvent.type === 'rally_start') {
      return 'in_play'
    }
    
    // set_start means set is ready but rally hasn't started yet
    if (lastEvent.type === 'set_start') {
      return 'idle'
    }
    
    // For lineup events after points, the rally is idle (waiting for next rally_start)
    return 'idle'
  }, [data?.events, data?.currentSet])

  // Get last action description
  const lastAction = useMemo(() => {
    if (!data?.events || !data?.currentSet || data.events.length === 0) return null
    
    // Get events for current set only and sort by sequence number (most recent first)
    const currentSetEvents = data.events
      .filter(e => e.setIndex === data.currentSet.index)
      .sort((a, b) => {
        const aSeq = a.seq || 0
        const bSeq = b.seq || 0
        if (aSeq !== 0 || bSeq !== 0) {
          return bSeq - aSeq
        }
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime
      })
    
    if (currentSetEvents.length === 0) return null
    
    const event = currentSetEvents[0]
    if (!event) return null
    
    const teamName = event.payload?.team === 'home' 
      ? (data.homeTeam?.name || 'Home')
      : event.payload?.team === 'away'
      ? (data.awayTeam?.name || 'Away')
      : null
    
    // Determine team labels (A or B)
    const teamAKey = data?.match?.coinTossTeamA || 'home'
    const homeLabel = teamAKey === 'home' ? 'A' : 'B'
    const awayLabel = teamAKey === 'away' ? 'A' : 'B'
    
    // Calculate score at time of event
    const setIdx = event.setIndex || 1
    const setEvents = data.events?.filter(e => (e.setIndex || 1) === setIdx) || []
    const eventIndex = setEvents.findIndex(e => e.id === event.id)
    
    let homeScore = 0
    let awayScore = 0
    for (let i = 0; i <= eventIndex; i++) {
      const e = setEvents[i]
      if (e.type === 'point') {
        if (e.payload?.team === 'home') {
          homeScore++
        } else if (e.payload?.team === 'away') {
          awayScore++
        }
      }
    }
    
    let eventDescription = ''
    if (event.type === 'point') {
      eventDescription = `${teamName} point (${homeLabel} ${homeScore}:${awayScore} ${awayLabel})`
    } else if (event.type === 'timeout') {
      eventDescription = `Timeout — ${teamName}`
    } else if (event.type === 'substitution') {
      const playerOut = event.payload?.playerOut || '?'
      const playerIn = event.payload?.playerIn || '?'
      eventDescription = `Sub — ${teamName} (${playerOut}→${playerIn})`
    } else if (event.type === 'rally_start') {
      eventDescription = 'Rally started'
    } else if (event.type === 'replay') {
      eventDescription = 'Replay'
    } else if (event.type === 'sanction') {
      const sanctionType = event.payload?.type || 'warning'
      const playerNumber = event.payload?.playerNumber
      const typeLabel = sanctionType === 'warning' ? 'W' : sanctionType === 'penalty' ? 'P' : sanctionType === 'expulsion' ? 'E' : 'D'
      if (playerNumber) {
        eventDescription = `Sanction — ${teamName} #${playerNumber} (${typeLabel})`
      } else {
        eventDescription = `Sanction — ${teamName} (${typeLabel})`
      }
    } else if (event.type === 'libero_entry') {
      const liberoNumber = event.payload?.liberoIn || '?'
      const liberoType = event.payload?.liberoType === 'libero1' ? 'L1' : 'L2'
      eventDescription = `Libero in — ${teamName} (${liberoType}#${liberoNumber})`
    } else if (event.type === 'libero_exit') {
      const liberoNumber = event.payload?.liberoOut || '?'
      const liberoType = event.payload?.liberoType === 'libero1' ? 'L1' : 'L2'
      eventDescription = `Libero out — ${teamName} (${liberoType}#${liberoNumber})`
    } else {
      return null // Skip other event types
    }
    
    return eventDescription
  }, [data?.events, data?.currentSet, data?.homeTeam, data?.awayTeam, data?.match])

  // Calculate statistics
  const stats = useMemo(() => {
    if (!data || !data.events || !data.currentSet) {
      return {
        home: { timeouts: 0, substitutions: 0, sanctions: [] },
        away: { timeouts: 0, substitutions: 0, sanctions: [] }
      }
    }

    const currentSetEvents = data.events.filter(
      e => (e.setIndex || 1) === (data.currentSet?.index || 1)
    )

    const homeTimeouts = currentSetEvents.filter(
      e => e.type === 'timeout' && e.payload?.team === 'home'
    ).length

    const awayTimeouts = currentSetEvents.filter(
      e => e.type === 'timeout' && e.payload?.team === 'away'
    ).length

    const homeSubstitutions = currentSetEvents.filter(
      e => e.type === 'substitution' && e.payload?.team === 'home'
    ).length

    const awaySubstitutions = currentSetEvents.filter(
      e => e.type === 'substitution' && e.payload?.team === 'away'
    ).length

    // Get sanctions for entire match (sanctions persist across sets)
    const homeSanctions = data.events
      .filter(e => 
        e.type === 'sanction' && e.payload?.team === 'home'
      )
      .map(e => ({
        type: e.payload?.sanctionType || e.payload?.type || 'unknown',
        target: e.payload?.playerNumber 
          ? `#${e.payload.playerNumber}`
          : e.payload?.role || '',
        timestamp: e.ts,
        setIndex: e.setIndex || 1
      }))

    const awaySanctions = data.events
      .filter(e => 
        e.type === 'sanction' && e.payload?.team === 'away'
      )
      .map(e => ({
        type: e.payload?.sanctionType || e.payload?.type || 'unknown',
        target: e.payload?.playerNumber 
          ? `#${e.payload.playerNumber}`
          : e.payload?.role || '',
        timestamp: e.ts,
        setIndex: e.setIndex || 1
      }))

    return {
      home: { timeouts: homeTimeouts, substitutions: homeSubstitutions, sanctions: homeSanctions },
      away: { timeouts: awayTimeouts, substitutions: awaySubstitutions, sanctions: awaySanctions }
    }
  }, [data])

  // Get lineup for current set with libero substitution info
  const lineup = useMemo(() => {
    if (!data || !data.events || !data.currentSet) {
      return { 
        home: { lineup: {}, liberoSubs: {} }, 
        away: { lineup: {}, liberoSubs: {} } 
      }
    }

    const currentSetEvents = data.events.filter(
      e => (e.setIndex || 1) === (data.currentSet?.index || 1)
    )

    // Find latest lineup events
    const homeLineupEvents = currentSetEvents.filter(
      e => e.type === 'lineup' && e.payload?.team === 'home'
    )
    const awayLineupEvents = currentSetEvents.filter(
      e => e.type === 'lineup' && e.payload?.team === 'away'
    )

    const latestHomeLineup = homeLineupEvents[homeLineupEvents.length - 1]
    const latestAwayLineup = awayLineupEvents[awayLineupEvents.length - 1]

    // Build libero substitution map (position -> {liberoNumber, playerNumber, liberoType})
    const buildLiberoSubMap = (lineupEvent) => {
      const liberoSubs = {}
      if (lineupEvent?.payload?.liberoSubstitution) {
        const sub = lineupEvent.payload.liberoSubstitution
        liberoSubs[sub.position] = sub
      }
      return liberoSubs
    }

    return {
      home: {
        lineup: latestHomeLineup?.payload?.lineup || {},
        liberoSubs: buildLiberoSubMap(latestHomeLineup)
      },
      away: {
        lineup: latestAwayLineup?.payload?.lineup || {},
        liberoSubs: buildLiberoSubMap(latestAwayLineup)
      }
    }
  }, [data])

  // Calculate set scores
  const setScore = useMemo(() => {
    if (!data) return { home: 0, away: 0 }
    
    const finishedSets = data.sets?.filter(s => s.finished) || []
    const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
    const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length
    
    return { home: homeSetsWon, away: awaySetsWon }
  }, [data])

  // Check if we're between sets
  const isBetweenSets = useMemo(() => {
    if (!data?.sets || !data?.currentSet) return false
    const finishedSets = data.sets.filter(s => s.finished)
    const currentSetIndex = data.currentSet.index
    // If the last finished set is not the current set, we're between sets
    const lastFinishedSet = finishedSets[finishedSets.length - 1]
    return lastFinishedSet && lastFinishedSet.index < currentSetIndex
  }, [data?.sets, data?.currentSet])

  // Format countdown (M'SS'' or SS'')
  const formatCountdown = useCallback((seconds) => {
    if (seconds < 60) {
      return `${seconds}''`
    }
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    if (remainingSeconds === 0) {
      return `${minutes}'`
    }
    return `${minutes}' ${remainingSeconds}''`
  }, [])

  // Stop timeout countdown
  const stopTimeout = useCallback(() => {
    setActiveTimeout(null)
  }, [])

  // Hide between sets countdown
  const hideBetweenSetsCountdown = useCallback(() => {
    setBetweenSetsCountdown(null)
  }, [])

  // Initialize between sets countdown
  useEffect(() => {
    if (isBetweenSets && !betweenSetsCountdown) {
      setBetweenSetsCountdown({ countdown: 180, started: true }) // 3 minutes = 180 seconds
    } else if (!isBetweenSets && betweenSetsCountdown) {
      setBetweenSetsCountdown(null)
    }
  }, [isBetweenSets, betweenSetsCountdown])

  // Countdown timer for between sets
  useEffect(() => {
    if (!betweenSetsCountdown || !betweenSetsCountdown.started || betweenSetsCountdown.finished) return

    if (betweenSetsCountdown.countdown <= 0) {
      setBetweenSetsCountdown({ ...betweenSetsCountdown, finished: true, started: false })
      return
    }

    const timer = setInterval(() => {
      setBetweenSetsCountdown(prev => {
        if (!prev || !prev.started) return prev
        const newCountdown = prev.countdown - 1
        if (newCountdown <= 0) {
          return { ...prev, finished: true, started: false }
        }
        return { ...prev, countdown: newCountdown }
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [betweenSetsCountdown])

  // Determine who has serve based on events
  const getCurrentServe = useMemo(() => {
    if (!data?.currentSet || !data?.match) {
      return data?.match?.firstServe || 'home'
    }
    
    if (!data?.events || data.events.length === 0) {
      // First rally: use firstServe from match
      return data.match.firstServe || 'home'
    }
    
    // Find the last point event in the current set to determine serve
    const pointEvents = data.events
      .filter(e => e.type === 'point' && e.setIndex === data.currentSet.index)
      .sort((a, b) => {
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime // Most recent first
      })
    
    if (pointEvents.length === 0) {
      // No points yet, use firstServe
      return data.match.firstServe || 'home'
    }
    
    // The team that scored the last point now has serve
    const lastPoint = pointEvents[0]
    return lastPoint.payload?.team || data.match.firstServe || 'home'
  }, [data?.events, data?.currentSet, data?.match])

  // Determine team labels (A or B)
  const teamAKey = data?.match?.coinTossTeamA || 'home'
  const homeLabel = teamAKey === 'home' ? 'A' : 'B'
  const awayLabel = teamAKey === 'away' ? 'A' : 'B'

  // Determine which team is on the left based on set index and referee view
  // In set 1, Team A is always on the left (for 2nd referee view)
  // In subsequent sets, teams switch sides
  const leftIsHomeFor2ndRef = useMemo(() => {
    if (!data?.currentSet) return true
    
    // Set 1: Team A on left
    if (data.currentSet.index === 1) {
      return teamAKey === 'home'
    }
    
    // Set 5: Special case with court switch at 8 points
    if (data.currentSet.index === 5) {
      // Set 5 starts with teams switched (like set 2+)
      let isHome = teamAKey !== 'home'
      
      // If court switch has happened at 8 points, switch again
      if (data.match?.set5CourtSwitched) {
        isHome = !isHome
      }
      
      return isHome
    }
    
    // Set 2, 3, 4: Teams switch sides (Team A goes right, Team B goes left)
    return teamAKey !== 'home'
  }, [data?.currentSet, data?.match?.set5CourtSwitched, teamAKey])

  // For 1st referee, reverse the sides (they see from opposite end)
  const leftIsHome = refereeView === '1st' ? !leftIsHomeFor2ndRef : leftIsHomeFor2ndRef
  
  // Monitor for captain on court requests
  useEffect(() => {
    if (!data?.match) return
    
    const homeRequest = data.match.homeCaptainOnCourtRequest
    const awayRequest = data.match.awayCaptainOnCourtRequest
    
    // Check if manageCaptainOnCourt is enabled (stored in localStorage)
    const manageCaptainOnCourt = localStorage.getItem('manageCaptainOnCourt') === 'true'
    if (!manageCaptainOnCourt) return
    
    // Process home team request
    if (homeRequest && homeRequest.timestamp) {
      const requestKey = `home-${homeRequest.timestamp}`
      if (!processedCaptainRequests.has(requestKey)) {
        setCaptainOnCourtModal({
          team: 'home',
          playersOnCourt: homeRequest.playersOnCourt || [],
          lineup: homeRequest.lineup || {},
          timestamp: homeRequest.timestamp
        })
        setProcessedCaptainRequests(prev => new Set([...prev, requestKey]))
      }
    }
    
    // Process away team request
    if (awayRequest && awayRequest.timestamp) {
      const requestKey = `away-${awayRequest.timestamp}`
      if (!processedCaptainRequests.has(requestKey)) {
        setCaptainOnCourtModal({
          team: 'away',
          playersOnCourt: awayRequest.playersOnCourt || [],
          lineup: awayRequest.lineup || {},
          timestamp: awayRequest.timestamp
        })
        setProcessedCaptainRequests(prev => new Set([...prev, requestKey]))
      }
    }
  }, [data?.match?.homeCaptainOnCourtRequest, data?.match?.awayCaptainOnCourtRequest, processedCaptainRequests])
  
  // Handle captain on court selection
  const handleSelectCaptainOnCourt = useCallback(async (playerNumber) => {
    if (!captainOnCourtModal || !matchId) return
    
    const { team } = captainOnCourtModal
    const field = team === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain'
    const requestField = team === 'home' ? 'homeCaptainOnCourtRequest' : 'awayCaptainOnCourtRequest'
    
    // Save the selected captain on court
    await db.matches.update(matchId, {
      [field]: playerNumber,
      [requestField]: null // Clear the request
    })
    
    setCaptainOnCourtModal(null)
  }, [captainOnCourtModal, matchId])
  
  // Handle cancel (no captain selected)
  const handleCancelCaptainOnCourt = useCallback(async () => {
    if (!captainOnCourtModal || !matchId) return
    
    const { team } = captainOnCourtModal
    const requestField = team === 'home' ? 'homeCaptainOnCourtRequest' : 'awayCaptainOnCourtRequest'
    
    // Clear the request
    await db.matches.update(matchId, {
      [requestField]: null
    })
    
    setCaptainOnCourtModal(null)
  }, [captainOnCourtModal, matchId])
  
  const leftTeam = leftIsHome ? 'home' : 'away'
  const rightTeam = leftIsHome ? 'away' : 'home'

  const leftTeamData = leftTeam === 'home' ? data?.homeTeam : data?.awayTeam
  const rightTeamData = rightTeam === 'home' ? data?.homeTeam : data?.awayTeam
  const leftLabel = leftTeam === 'home' ? homeLabel : awayLabel
  const rightLabel = rightTeam === 'home' ? homeLabel : awayLabel
  const leftLineupData = leftTeam === 'home' ? lineup.home : lineup.away
  const rightLineupData = rightTeam === 'home' ? lineup.home : lineup.away
  const leftLineup = leftLineupData.lineup
  const rightLineup = rightLineupData.lineup
  const leftLiberoSubs = leftLineupData.liberoSubs
  const rightLiberoSubs = rightLineupData.liberoSubs
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
  
  // Count liberos for each team
  const leftLiberoCount = (leftTeam === 'home' ? data?.homePlayers : data?.awayPlayers)?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
  const rightLiberoCount = (rightTeam === 'home' ? data?.homePlayers : data?.awayPlayers)?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
  
  // Build substitution history for active replacement tracking
  const leftTeamSubstitutionHistory = useMemo(() => {
    if (!data?.events) return []
    return data.events
      .filter(e => e.type === 'substitution' && e.payload?.team === leftTeam)
      .sort((a, b) => (a.seq || 0) - (b.seq || 0))
  }, [data?.events, leftTeam])

  const rightTeamSubstitutionHistory = useMemo(() => {
    if (!data?.events) return []
    return data.events
      .filter(e => e.type === 'substitution' && e.payload?.team === rightTeam)
      .sort((a, b) => (a.seq || 0) - (b.seq || 0))
  }, [data?.events, rightTeam])

  // Build active replacement map
  const buildActiveReplacementMap = (substitutions = []) => {
    const activeMap = new Map()

    substitutions.forEach(sub => {
      const playerOut = sub.payload?.playerOut
      const playerIn = sub.payload?.playerIn
      if (!playerOut || !playerIn) return

      const playerOutStr = String(playerOut)
      const playerInStr = String(playerIn)
      const previouslyReplaced = activeMap.get(playerOutStr)

      activeMap.delete(playerOutStr)

      if (previouslyReplaced && previouslyReplaced === playerInStr) {
        // Original player returning, do not mark as replacement
        return
      }

      activeMap.set(playerInStr, playerOutStr)
    })

    return activeMap
  }

  const leftTeamActiveReplacements = useMemo(
    () => buildActiveReplacementMap(leftTeamSubstitutionHistory),
    [leftTeamSubstitutionHistory]
  )

  const rightTeamActiveReplacements = useMemo(
    () => buildActiveReplacementMap(rightTeamSubstitutionHistory),
    [rightTeamSubstitutionHistory]
  )

  const resolveReplacementNumber = (playerNumber, team, activeReplacementMap, liberoSubInfo) => {
    if (!playerNumber || playerNumber === '') {
      return null
    }

    // Priority: libero substitution
    if (liberoSubInfo?.playerNumber) {
      return String(liberoSubInfo.playerNumber)
    }

    // Check active replacement map
    if (!activeReplacementMap) return null

    return activeReplacementMap.get(String(playerNumber)) || null
  }

  const getReplacementBadgeStyle = (isLiberoReplacement) => {
    const baseStyle = {
      position: 'absolute',
      top: '-8px',
      right: '-8px',
      width: '18px',
      height: '18px',
      borderRadius: '4px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '10px',
      fontWeight: 700,
      zIndex: 6
    }

    if (isLiberoReplacement) {
      return {
        ...baseStyle,
        background: '#ffffff',
        border: '2px solid rgba(255, 255, 255, 0.8)',
        color: '#0f172a',
        boxShadow: '0 2px 6px rgba(15, 23, 42, 0.35)'
      }
    }

    return {
      ...baseStyle,
      background: '#fde047',
      border: '2px solid rgba(0, 0, 0, 0.25)',
      color: '#0f172a',
      boxShadow: '0 2px 4px rgba(15, 23, 42, 0.25)'
    }
  }
  
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

  // Check if scoresheet is connected (updating within last 15 seconds)
  const isScoresheetConnected = useMemo(() => {
    if (!data?.match?.updatedAt) return false
    const lastUpdate = new Date(data.match.updatedAt).getTime()
    const currentTime = new Date().getTime()
    return (currentTime - lastUpdate) < 30000 // 30 seconds threshold
  }, [data?.match?.updatedAt])

  // Reset processed timeouts and substitutions when set changes
  useEffect(() => {
    setProcessedTimeouts(new Set())
    setProcessedSubstitutions(new Set())
  }, [data?.currentSet?.index])

  // Monitor timeout events and start countdown
  useEffect(() => {
    if (!data?.events || !data?.currentSet) return
    
    // Find the most recent timeout event in current set
    const currentSetEvents = data.events.filter(e => 
      e.type === 'timeout' && 
      (e.setIndex || 1) === (data.currentSet?.index || 1)
    )
    
    if (currentSetEvents.length === 0) {
      return
    }
    
    const latestTimeout = currentSetEvents[currentSetEvents.length - 1]
    
    // Check if this timeout was logged recently (within last 35 seconds)
    const timeoutTime = new Date(latestTimeout.ts).getTime()
    const now = Date.now()
    const timeSinceTimeout = (now - timeoutTime) / 1000 // in seconds
    
    // Only show countdown if timeout is recent (within 35 seconds)
    if (timeSinceTimeout > 35) {
      return
    }
    
    // Check if we've already processed this timeout
    if (processedTimeouts.has(latestTimeout.id)) {
      return
    }
    
    // Calculate remaining time based on when timeout was logged
    const remainingTime = Math.max(0, Math.ceil(30 - timeSinceTimeout))
    
    if (remainingTime <= 0) {
      return
    }
    
    // Mark as processed and start countdown
    setProcessedTimeouts(prevSet => new Set([...prevSet, latestTimeout.id]))
    setActiveTimeout({
      team: latestTimeout.payload?.team,
      countdown: remainingTime,
      eventId: latestTimeout.id,
      startTime: now
    })
  }, [data?.events, data?.currentSet, processedTimeouts])
  
  // Countdown timer for active timeout
  useEffect(() => {
    if (!activeTimeout) return
    
    if (activeTimeout.countdown <= 0) {
      setActiveTimeout(null)
      return
    }
    
    const timer = setInterval(() => {
      setActiveTimeout(prev => {
        if (!prev) return null
        const newCountdown = prev.countdown - 1
        if (newCountdown <= 0) {
          return null
        }
        return { ...prev, countdown: newCountdown }
      })
    }, 1000)
    
    return () => clearInterval(timer)
  }, [activeTimeout])

  // Monitor substitution events and show notification
  useEffect(() => {
    if (!data?.events || !data?.currentSet) return
    
    // Find the most recent substitution event in current set
    const currentSetEvents = data.events.filter(e => 
      e.type === 'substitution' && 
      (e.setIndex || 1) === (data.currentSet?.index || 1)
    )
    
    if (currentSetEvents.length === 0) {
      return
    }
    
    const latestSubstitution = currentSetEvents[currentSetEvents.length - 1]
    
    // Check if this substitution was logged recently (within last 10 seconds)
    const substitutionTime = new Date(latestSubstitution.ts).getTime()
    const now = Date.now()
    const timeSinceSubstitution = (now - substitutionTime) / 1000 // in seconds
    
    // Only show notification if substitution is recent (within 10 seconds)
    if (timeSinceSubstitution > 10) {
      return
    }
    
    // Check if we've already processed this substitution
    if (processedSubstitutions.has(latestSubstitution.id)) {
      return
    }
    
    // Mark as processed and show notification
    setProcessedSubstitutions(prevSet => new Set([...prevSet, latestSubstitution.id]))
    setActiveSubstitution({
      team: latestSubstitution.payload?.team,
      playerOut: latestSubstitution.payload?.playerOut,
      playerIn: latestSubstitution.payload?.playerIn,
      eventId: latestSubstitution.id,
      countdown: 5
    })
  }, [data?.events, data?.currentSet, processedSubstitutions])
  
  // Countdown timer for active substitution (auto-dismiss after 5 seconds)
  useEffect(() => {
    if (!activeSubstitution) return
    
    if (activeSubstitution.countdown <= 0) {
      setActiveSubstitution(null)
      return
    }
    
    const timer = setInterval(() => {
      setActiveSubstitution(prev => {
        if (!prev) return null
        const newCountdown = prev.countdown - 1
        if (newCountdown <= 0) {
          return null
        }
        return { ...prev, countdown: newCountdown }
      })
    }, 1000)
    
    return () => clearInterval(timer)
  }, [activeSubstitution])

  if (!data) return null

  // Check if referee connection is disabled
  if (data.match.refereeConnectionEnabled === false) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          padding: '40px',
          maxWidth: '400px',
          width: '100%',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '48px', marginBottom: '20px' }}>🚫</div>
          <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '16px' }}>
            Referee Connection Disabled
          </h2>
          <p style={{ fontSize: '14px', color: 'var(--muted)', marginBottom: '24px' }}>
            The referee connection has been disabled for this match. Please contact the scorekeeper to enable it.
          </p>
          <button
            onClick={onExit}
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
            Exit
          </button>
        </div>
      </div>
    )
  }

  const PlayerCircle = ({ number, position, team, isServing, liberoSubInfo, teamLiberoCount }) => {
    if (!number) return null
    
    // Find player data
    const teamPlayers = team === 'home' ? data.homePlayers : data.awayPlayers
    const player = teamPlayers?.find(p => String(p.number) === String(number))
    const isLibero = player?.libero === 'libero1' || player?.libero === 'libero2'
    const liberoType = player?.libero === 'libero1' ? 'L1' : player?.libero === 'libero2' ? 'L2' : null
    const isCaptain = player?.isCaptain || player?.captain
    
    // Get sanctions for this player from events (same logic as scoreboard)
    const teamKey = team
    const playerSanctionsCurrentSet = data?.events?.filter(e =>
      e.type === 'sanction' &&
      e.payload?.team === teamKey &&
      e.payload?.playerNumber === number &&
      e.setIndex === data?.currentSet?.index
    ) || []
    
    // Check disqualification across ALL sets (disqualified players are out for entire match)
    const playerDisqualifications = data?.events?.filter(e =>
      e.type === 'sanction' &&
      e.payload?.team === teamKey &&
      e.payload?.playerNumber === number &&
      e.payload?.type === 'disqualification'
    ) || []
    
    const hasWarning = playerSanctionsCurrentSet.some(s => s.payload?.type === 'warning')
    const hasPenalty = playerSanctionsCurrentSet.some(s => s.payload?.type === 'penalty')
    const hasExpulsion = playerSanctionsCurrentSet.some(s => s.payload?.type === 'expulsion')
    const hasDisqualification = playerDisqualifications.length > 0
    
    // Ball should show for position I when team is serving
    const shouldShowBall = position === 'I' && isServing
    
    // Determine libero label for bottom-left corner
    const liberoLabel = isLibero ? (teamLiberoCount === 1 ? 'L' : liberoType) : null
    
    // Get substituted player number (for top-right badge)
    const activeReplacementMap = team === leftTeam ? leftTeamActiveReplacements : rightTeamActiveReplacements
    const replacementNumber = resolveReplacementNumber(number, team, activeReplacementMap, liberoSubInfo)
    const isLiberoReplacement = !!liberoSubInfo?.playerNumber
    
    return (
      <div 
        className="court-player"
        style={{
          position: 'relative',
          background: isLibero ? '#FFF8E7' : undefined,
          color: isLibero ? '#000' : undefined,
          width: '48px', // Maximum width
          height: '48px',
          fontSize: '25px', // Maximum font size
          maxWidth: '80px'
        }}
      >
        {/* Substituted player indicator (top-right) */}
        {replacementNumber && (
          <span style={getReplacementBadgeStyle(isLiberoReplacement)}>
            {replacementNumber}
          </span>
        )}
        {shouldShowBall && (
          <img 
            src={mikasaVolleyball} 
            alt="Volleyball" 
            style={{
              position: 'absolute',
              left: team === leftTeam ? '-35px' : 'auto',
              right: team === rightTeam ? '-35px' : 'auto',
              top: '50%',
              transform: 'translateY(-50%)',
              width: '22px', // 40% smaller than 36px
              height: '22px',
              zIndex: 5,
              filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
            }}
          />
        )}
        <span 
          className="court-player-position"
          style={{
            width: '12.4px', // 20% smaller than 18px
            height: '12.4px',
            fontSize: '6px', // 20% smaller than 11px
            top: '-6.4px', // 20% smaller offset
            left: '-6.4px'
          }}
        >
          {position}
        </span>
        {isCaptain && (() => {
          if (isLibero) {
            return (
              <span 
                className="court-player-captain"
                style={{
                  width: '12px', // 20% smaller (adjusted for content)
                  height: '12px',
                  fontSize: '6px', // 20% smaller
                  bottom: '-6.4px',
                  left: '-6.4px'
                }}
              >
                {liberoLabel}
              </span>
            )
          }
          return (
            <span 
              className="court-player-captain"
              style={{
                width: '12px', // 20% smaller than 18px
                height: '12px',
                fontSize: '6px', // 20% smaller than 11px
                bottom: '-6.4px', // 20% smaller offset
                left: '-6.4px'
              }}
            >
              C
            </span>
          )
        })()}
        {/* Libero indicator (bottom-left) */}
        {liberoLabel && (
          <span 
            className={isCaptain ? "court-player-captain" : ""}
            style={{
              position: 'absolute',
              bottom: '-6.4px',
              left: '-6.4px',
              width: '12px', // 20% smaller
              height: '12px', // 20% smaller
              background: isCaptain ? 'rgba(15, 23, 42, 0.95)' : '#3b82f6',
              border: isCaptain ? '1.6px solid var(--accent)' : '1.6px solid rgba(255, 255, 255, 0.4)',
              borderRadius: '3.2px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '6px', // 20% smaller
              fontWeight: 700,
              color: '#fff',
              zIndex: 5
            }}>
            {liberoLabel}
          </span>
        )}
        {number}
        
        {/* Sanction cards indicator */}
        {(hasWarning || hasPenalty || hasExpulsion || hasDisqualification) && (
          <div style={{
            position: 'absolute',
            bottom: '-6.4px', // 20% smaller offset
            right: '-6.4px',
            zIndex: 10
          }}>
            {hasExpulsion ? (
              // Expulsion: overlapping rotated cards
              <div style={{ position: 'relative', width: '9.6px', height: '9.6px' }}>
                <div 
                  style={{ 
                    width: '6.4px', // 20% smaller than 8px
                    height: '8.8px', // 20% smaller than 11px
                    background: 'linear-gradient(160deg, #fde047, #facc15)',
                    borderRadius: '1px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                    position: 'absolute',
                    left: '0',
                    top: '0',
                    transform: 'rotate(-8deg)',
                    zIndex: 1
                  }}
                />
                <div 
                  style={{ 
                    width: '6.4px', // 20% smaller than 8px
                    height: '8.8px', // 20% smaller than 11px
                    background: 'linear-gradient(160deg, #ef4444, #b91c1c)',
                    borderRadius: '1px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                    position: 'absolute',
                    right: '0',
                    top: '0',
                    transform: 'rotate(8deg)',
                    zIndex: 2
                  }}
                />
              </div>
            ) : (
              // Other sanctions: separate cards
              <div style={{ display: 'flex', gap: '1.6px' }}>
                {(hasWarning || hasDisqualification) && (
                  <div 
                    style={{ 
                      width: '6.4px', // 20% smaller than 8px
                      height: '8.8px', // 20% smaller than 11px
                      background: 'linear-gradient(160deg, #fde047, #facc15)',
                      borderRadius: '1px',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.8)'
                    }}
                  />
                )}
                {(hasPenalty || hasDisqualification) && (
                  <div 
                    style={{ 
                      width: '6.4px', // 20% smaller than 8px
                      height: '8.8px', // 20% smaller than 11px
                      background: 'linear-gradient(160deg, #ef4444, #b91c1c)',
                      borderRadius: '1px',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.8)'
                    }}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const dismissRefereeCall = async () => {
    try {
      await db.matches.update(matchId, {
        refereeCallActive: false
      })
    } catch (error) {
      console.error('Failed to dismiss referee call:', error)
    }
  }

  return (
    <div style={{
      minHeight: '60vh',
      maxHeight: '100vh',
      overflow: 'hidden',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      padding: '6px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      display: 'flex',
      flexDirection: 'column'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '4px',
        gap: '6px',
        flexShrink: 0,
        flexWrap: 'wrap',
        minHeight: '28px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', flex: '1 1 auto', minWidth: 0 }}>
          <button
            onClick={onExit}
            style={{
              padding: '4px 8px',
              fontSize: '10px',
              fontWeight: 600,
              background: 'rgba(255,255,255,0.1)',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Exit
          </button>
          
          {/* Scoresheet Connection Status */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '3px 6px',
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '4px',
            fontSize: '9px'
          }}>
            <div style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: isScoresheetConnected ? '#22c55e' : '#ef4444',
              boxShadow: isScoresheetConnected 
                ? '0 0 6px rgba(34, 197, 94, 0.6)' 
                : 'none'
            }} />
            <span style={{ color: 'var(--muted)' }}>
              Score
            </span>
          </div>

          {/* Connection Type Indicator */}
          {connectionType && connectionType !== 'database' && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '3px 6px',
              background: connectionStatus === 'connected' 
                ? 'rgba(34, 197, 94, 0.15)' 
                : connectionStatus === 'connecting'
                ? 'rgba(251, 191, 36, 0.15)'
                : 'rgba(239, 68, 68, 0.15)',
              borderRadius: '4px',
              fontSize: '9px',
              border: `1px solid ${connectionStatus === 'connected' 
                ? 'rgba(34, 197, 94, 0.4)' 
                : connectionStatus === 'connecting'
                ? 'rgba(251, 191, 36, 0.4)'
                : 'rgba(239, 68, 68, 0.4)'}`
            }}>
              <div style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: connectionStatus === 'connected' 
                  ? '#22c55e' 
                  : connectionStatus === 'connecting'
                  ? '#eab308'
                  : '#ef4444',
                boxShadow: connectionStatus === 'connected' 
                  ? '0 0 6px rgba(34, 197, 94, 0.6)' 
                  : 'none'
              }} />
              <span style={{ 
                color: connectionStatus === 'connected' 
                  ? '#22c55e' 
                  : connectionStatus === 'connecting'
                  ? '#eab308'
                  : '#ef4444',
                fontWeight: 600
              }}>
                {connectionType === 'bluetooth' ? 'BT' : connectionType === 'lan' ? 'LAN' : 'NET'}
              </span>
              {connectionStatus === 'connected' && (
                <button
                  onClick={handleDisconnect}
                  style={{
                    padding: '1px 4px',
                    fontSize: '7px',
                    background: 'rgba(255,255,255,0.1)',
                    border: '1px solid rgba(255,255,255,0.2)',
                    borderRadius: '3px',
                    color: 'var(--text)',
                    cursor: 'pointer',
                    marginLeft: '4px'
                  }}
                  title="Disconnect"
                >
                  ×
                </button>
              )}
            </div>
          )}

          {/* Connection Button */}
          {(!connectionType || connectionType === 'database') && (
            <button
              onClick={() => setConnectionModal('select')}
              style={{
                padding: '3px 6px',
                fontSize: '9px',
                fontWeight: 600,
                background: 'rgba(255,255,255,0.1)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
              title="Connect via Bluetooth, LAN, or Internet"
            >
              Connect
            </button>
          )}

          {/* Rally Status */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '3px 6px',
            background: rallyStatus === 'in_play' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255,255,255,0.05)',
            borderRadius: '4px',
            fontSize: '9px',
            border: rallyStatus === 'in_play' ? '1px solid rgba(34, 197, 94, 0.4)' : 'none'
          }}>
            <div style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: rallyStatus === 'in_play' ? '#22c55e' : '#6b7280',
              boxShadow: rallyStatus === 'in_play' 
                ? '0 0 6px rgba(34, 197, 94, 0.6)' 
                : 'none'
            }} />
            <span style={{ color: rallyStatus === 'in_play' ? '#22c55e' : 'var(--muted)', fontWeight: rallyStatus === 'in_play' ? 600 : 400 }}>
              {rallyStatus === 'in_play' ? 'Rally' : 'Idle'}
            </span>
          </div>

          {/* Last Action */}
          {lastAction && (
            <div style={{
              padding: '3px 6px',
              background: 'rgba(255,255,255,0.05)',
              borderRadius: '4px',
              fontSize: '8px',
              color: 'var(--muted)',
              maxWidth: '100px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flexShrink: 1
            }}>
              {lastAction}
            </div>
          )}
        </div>
        
        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
          <button
            onClick={() => setRefereeView('1st')}
            style={{
              padding: '4px 10px',
              fontSize: '10px',
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
              fontSize: '10px',
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
        </div>
      </div>

      {/* Score Display or Between Sets Countdown */}
      {betweenSetsCountdown ? (
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '6px',
          padding: '16px',
          marginBottom: '4px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '12px',
          flexShrink: 0
        }}>
          <div style={{
            fontSize: '48px',
            fontWeight: 800,
            color: 'var(--accent)',
            lineHeight: 1
          }}>
            {formatCountdown(betweenSetsCountdown.countdown)}
          </div>
          <button
            onClick={hideBetweenSetsCountdown}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 600,
              background: 'rgba(255,255,255,0.1)',
              color: 'var(--text)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Hide countdown
          </button>
        </div>
      ) : (
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: '6px',
        padding: '8px',
        marginBottom: '4px',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'column',
          gap: '8px',
        flexShrink: 0
      }}>
          {/* Sets Counter - Above (like livescore) - Centered horizontally on whole page */}
        <div style={{
          display: 'flex',
          width: '100%',
          justifyContent: 'center',
          alignItems: 'center',
            gap: '12px',
            position: 'relative'
        }}>
            {/* Left Set Score Box */}
            <div style={{
              padding: '6px 12px',
              borderRadius: '6px',
                fontSize: '16px',
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
              {leftSetScore}
            </div>
            
            {/* SET # Indicator - Centered on whole page */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '2px',
              position: 'absolute',
              left: '50%',
              transform: 'translateX(-50%)'
            }}>
              <span style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                lineHeight: '1'
              }}>
                SET
            </span>
              <span style={{
                fontSize: '20px',
                fontWeight: 700,
                color: 'var(--text)',
                lineHeight: '1'
              }}>
                {data?.currentSet?.index || 1}
              </span>
            </div>
            
            {/* Right Set Score Box */}
            <div style={{
              padding: '6px 12px',
              borderRadius: '6px',
              fontSize: '16px',
              fontWeight: 700,
              background: 'rgba(255, 255, 255, 0.1)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              color: 'var(--text)',
              textAlign: 'center',
              lineHeight: '1',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginLeft: '30px',
            }}>
              {rightSetScore}
            </div>
          </div>
          
          {/* Score Counter - Layout: SERVE # | Label (short name) | Ball (reserved) | Score | : (centered) | Score | Ball (reserved) | Label (short name) | SERVE # */}
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            width: '100%',
            gap: '8px',
            position: 'relative'
          }}>
            {/* Left side: SERVE #, Label, Ball (reserved), Score */}
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '8px',
              flex: 1,
              justifyContent: 'flex-end'
            }}>
              {/* SERVE # indicator */}
              {leftServing && leftLineup?.I && (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                  marginRight: '30px' // Gap from team label
                }}>
                  <div style={{
                    fontSize: '12px',
                    fontWeight: 700,
                    color: 'var(--text)',
                    textTransform: 'uppercase',
                    letterSpacing: '1px'
                  }}>
                    SERVE
                  </div>
                  <div style={{
                    fontSize: '24px',
                    fontWeight: 700,
                    color: 'var(--accent)',
                    width: '48px',
                    height: '48px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(34, 197, 94, 0.1)',
                    border: '3px solid var(--accent)',
                    borderRadius: '12px'
                  }}>
                    {leftLineup.I}
                  </div>
                </div>
              )}
              
              {/* Team Label with short name */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '2px',
                marginRight: '30px',
                marginLeft: '30px',
              }}>
            <span
              className="team-badge"
              style={{
                    background: leftColor,
                    color: isBrightColor(leftColor) ? '#000' : '#fff',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '16px',
                fontWeight: 700,
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)'
              }}
            >
                  {leftLabel}
            </span>
                <span style={{
                  fontSize: '10px',
                  color: 'var(--muted)',
                  fontWeight: 600
                }}>
                  {leftTeam === 'home' ? (data?.match?.homeShortName || leftTeamData?.name?.substring(0, 3).toUpperCase() || 'HOM') : (data?.match?.awayShortName || leftTeamData?.name?.substring(0, 3).toUpperCase() || 'AWY')}
                </span>
        </div>

              {/* Ball - reserved space */}
              <div style={{
                width: '20px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
          {leftServing && (
            <img
              src={mikasaVolleyball}
              alt="Serving team"
              style={{
                width: '20px',
                height: '20px',
                filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
              }}
            />
          )}
              </div>
              
              {/* Score */}
              <span style={{
                fontSize: '56px',
            fontWeight: 800,
            color: 'var(--accent)',
                lineHeight: 1
              }}>
                {leftScore}
              </span>
            </div>

            {/* Colon - Centered on net */}
            <div style={{
              fontSize: '56px',
              fontWeight: 800,
              color: 'var(--muted)',
              width: '16px',
              textAlign: 'center',
              lineHeight: 1,
              flexShrink: 0
            }}>
              :
            </div>

            {/* Right side: Score, Ball (reserved), Label, SERVE # */}
            <div style={{ 
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
              flex: 1,
              justifyContent: 'flex-start'
            }}>
              {/* Score */}
              <span style={{
                fontSize: '56px',
                fontWeight: 800,
                color: 'var(--accent)',
            lineHeight: 1
          }}>
                {rightScore}
              </span>
              
              {/* Ball - reserved space */}
              <div style={{
                width: '20px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
          {rightServing && (
            <img
              src={mikasaVolleyball}
              alt="Serving team"
              style={{
                width: '20px',
                height: '20px',
                filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
              }}
            />
          )}
        </div>
              
              {/* Team Label with short name */}
        <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '2px',
                marginRight: '30px',
                marginLeft: '30px',
              }}>
                <span
                  className="team-badge"
                  style={{
                    background: rightColor,
                    color: isBrightColor(rightColor) ? '#000' : '#fff',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    fontSize: '16px',
                    fontWeight: 700,
                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)'
                  }}
                >
                  {rightLabel}
                </span>
                <span style={{
                  fontSize: '10px',
          color: 'var(--muted)',
                  fontWeight: 600
        }}>
                  {rightTeam === 'home' ? (data?.match?.homeShortName || rightTeamData?.name?.substring(0, 3).toUpperCase() || 'HOM') : (data?.match?.awayShortName || rightTeamData?.name?.substring(0, 3).toUpperCase() || 'AWY')}
                </span>
        </div>
              
              {/* SERVE # indicator */}
              {rightServing && rightLineup?.I && (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                  marginLeft: '16px' // Gap from team label
                }}>
                  <div style={{
                    fontSize: '12px',
                    fontWeight: 700,
                    color: 'var(--text)',
                    textTransform: 'uppercase',
                    letterSpacing: '1px'
                  }}>
                    SERVE
      </div>
                  <div style={{
                    fontSize: '24px',
                    fontWeight: 700,
                    color: 'var(--accent)',
                    width: '48px',
                    height: '48px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(34, 197, 94, 0.1)',
                    border: '3px solid var(--accent)',
                    borderRadius: '12px'
                  }}>
                    {rightLineup.I}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Court */}
      {(!leftLineup || Object.keys(leftLineup).length === 0) && (!rightLineup || Object.keys(rightLineup).length === 0) ? (
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
          padding: '40px',
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: '14px',
          marginBottom: '12px'
        }}>
          Waiting for lineups to be set...
        </div>
      ) : (
        <div style={{ marginBottom: '4px', flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {/* Court */}
          <div style={{ width: '100%', maxWidth: '800px', display: 'flex', justifyContent: 'center' }}>
            <div className="court" style={{ minHeight: '240px', maxHeight: '280px', height: '260px', flex: '0 0 auto', width: '100%', maxWidth: '600px' }}>
          <div className="court-attack-line court-attack-left" />
          <div className="court-attack-line court-attack-right" />
          
          <div className="court-side court-side-left">
            <div className="court-team court-team-left">
              <div className="court-row court-row-front">
                <PlayerCircle number={leftLineup?.IV} position="IV" team={leftTeam} isServing={leftServing} liberoSubInfo={leftLiberoSubs?.IV} teamLiberoCount={leftLiberoCount} />
                <PlayerCircle number={leftLineup?.III} position="III" team={leftTeam} isServing={leftServing} liberoSubInfo={leftLiberoSubs?.III} teamLiberoCount={leftLiberoCount} />
                <PlayerCircle number={leftLineup?.II} position="II" team={leftTeam} isServing={leftServing} liberoSubInfo={leftLiberoSubs?.II} teamLiberoCount={leftLiberoCount} />
              </div>
              <div className="court-row court-row-back">
                <PlayerCircle number={leftLineup?.V} position="V" team={leftTeam} isServing={leftServing} liberoSubInfo={leftLiberoSubs?.V} teamLiberoCount={leftLiberoCount} />
                <PlayerCircle number={leftLineup?.VI} position="VI" team={leftTeam} isServing={leftServing} liberoSubInfo={leftLiberoSubs?.VI} teamLiberoCount={leftLiberoCount} />
                <PlayerCircle number={leftLineup?.I} position="I" team={leftTeam} isServing={leftServing} liberoSubInfo={leftLiberoSubs?.I} teamLiberoCount={leftLiberoCount} />
              </div>
            </div>
          </div>
          
          <div className="court-net" />
          
          <div className="court-side court-side-right">
            <div className="court-team court-team-right">
              <div className="court-row court-row-front">
                <PlayerCircle number={rightLineup?.II} position="II" team={rightTeam} isServing={rightServing} liberoSubInfo={rightLiberoSubs?.II} teamLiberoCount={rightLiberoCount} />
                <PlayerCircle number={rightLineup?.III} position="III" team={rightTeam} isServing={rightServing} liberoSubInfo={rightLiberoSubs?.III} teamLiberoCount={rightLiberoCount} />
                <PlayerCircle number={rightLineup?.IV} position="IV" team={rightTeam} isServing={rightServing} liberoSubInfo={rightLiberoSubs?.IV} teamLiberoCount={rightLiberoCount} />
              </div>
              <div className="court-row court-row-back">
                <PlayerCircle number={rightLineup?.I} position="I" team={rightTeam} isServing={rightServing} liberoSubInfo={rightLiberoSubs?.I} teamLiberoCount={rightLiberoCount} />
                <PlayerCircle number={rightLineup?.VI} position="VI" team={rightTeam} isServing={rightServing} liberoSubInfo={rightLiberoSubs?.VI} teamLiberoCount={rightLiberoCount} />
                <PlayerCircle number={rightLineup?.V} position="V" team={rightTeam} isServing={rightServing} liberoSubInfo={rightLiberoSubs?.V} teamLiberoCount={rightLiberoCount} />
              </div>
            </div>
          </div>
        </div>
        </div>

          {/* TO and SUB beneath court - Centered horizontally on whole page */}
      <div style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
            width: '100%',
            maxWidth: '800px',
            marginTop: '8px',
            flexShrink: 0,
            gap: '16px'
      }}>
            {/* Left Column - Left Team TO/SUB */}
        <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              alignItems: 'center',
              flexShrink: 0
            }}>
            <div 
                onClick={() => activeTimeout && activeTimeout.team === leftTeam && stopTimeout()}
              style={{ 
                background: activeTimeout && activeTimeout.team === leftTeam 
                  ? 'rgba(251, 191, 36, 0.15)' 
                  : 'rgba(255, 255, 255, 0.05)', 
                borderRadius: '4px', 
                  padding: '6px 12px',
                textAlign: 'center',
                border: activeTimeout && activeTimeout.team === leftTeam
                  ? '2px solid var(--accent)'
                  : '1px solid rgba(255, 255, 255, 0.1)',
                  cursor: activeTimeout && activeTimeout.team === leftTeam ? 'pointer' : 'default',
                  minWidth: '60px'
              }}
            >
                <div style={{ fontSize: '8px', color: 'var(--muted)', marginBottom: '2px' }}>TO</div>
              {activeTimeout && activeTimeout.team === leftTeam ? (
                <div style={{ 
                    fontSize: '16px', 
                  fontWeight: 800,
                  color: 'var(--accent)',
                  lineHeight: 1
                }}>
                    {formatCountdown(activeTimeout.countdown)}
                </div>
              ) : (
                <div style={{ 
                  fontSize: '16px', 
                  fontWeight: 700,
                  color: leftStats.timeouts >= 2 ? '#ef4444' : 'inherit'
                }}>
                  {leftStats.timeouts}
                </div>
              )}
                {activeTimeout && activeTimeout.team === leftTeam && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      stopTimeout()
                    }}
                    style={{
                      marginTop: '4px',
                      padding: '2px 6px',
                      fontSize: '16px',
                      fontWeight: 600,
                      background: 'rgba(255,255,255,0.1)',
                      color: 'var(--text)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: '3px',
                      cursor: 'pointer'
                    }}
                  >
                    Stop TO
                  </button>
                )}
            </div>
            <div style={{ 
              background: 'rgba(255, 255, 255, 0.05)', 
              borderRadius: '4px', 
                padding: '6px 12px',
              textAlign: 'center',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                minWidth: '60px'
            }}>
                <div style={{ fontSize: '8px', color: 'var(--muted)', marginBottom: '2px' }}>SUB</div>
              <div style={{ 
                fontSize: '16px', 
                fontWeight: 700,
                color: leftStats.substitutions >= 6 ? '#ef4444' : leftStats.substitutions >= 5 ? '#eab308' : 'inherit'
              }}>{leftStats.substitutions}</div>
            </div>
          </div>
          
            {/* Middle Column - Results and Sanctions */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              flex: '0 1 auto',
              minWidth: 0
            }}>
              {/* Results Table */}
              {(() => {
                const allSets = data?.sets || []
                const currentSetIndex = data?.currentSet?.index || 1
                const completedSets = allSets.filter(set => set.finished)
                
                return (
                  <div style={{ 
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '8px',
                    padding: '8px',
                    fontSize: '16px',
                    minWidth: '400px'
                  }}>
                    <h4 style={{ margin: '0 0 6px', fontSize: '20px', fontWeight: 600, textAlign: 'center' }}>
                      Results
                    </h4>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '16px' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.2)' }}>
                          <th style={{ padding: '3px 1px', textAlign: 'center', fontWeight: 600, fontSize: '16px' }}>T</th>
                          <th style={{ padding: '3px 1px', textAlign: 'center', fontWeight: 600, fontSize: '16px' }}>S</th>
                          <th style={{ padding: '3px 1px', textAlign: 'center', fontWeight: 600, fontSize: '16px' }}>W</th>
                          <th style={{ padding: '3px 1px', textAlign: 'center', fontWeight: 600, fontSize: '16px' }}>P</th>
                          <th style={{ padding: '1px 1px', textAlign: 'center', fontWeight: 600, fontSize: '16px', borderRight: '1px solid rgba(255,255,255,0.2)' }}>SET</th>
                          <th style={{ padding: '1px 1px', textAlign: 'center', fontWeight: 600, fontSize: '16px', borderLeft: '1px solid rgba(255,255,255,0.2)' }}>Dur</th>
                          <th style={{ padding: '3px 1px', textAlign: 'center', fontWeight: 600, fontSize: '16px' }}>P</th>
                          <th style={{ padding: '3px 1px', textAlign: 'center', fontWeight: 600, fontSize: '16px' }}>W</th>
                          <th style={{ padding: '3px 1px', textAlign: 'center', fontWeight: 600, fontSize: '16px' }}>S</th>
                          <th style={{ padding: '3px 1px', textAlign: 'center', fontWeight: 600, fontSize: '16px' }}>T</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allSets.filter(set => set.index <= currentSetIndex).map((set, idx) => {
                          const setEvents = data?.events?.filter(e => e.setIndex === set.index) || []
                          const leftSetPoints = set.homePoints || 0
                          const rightSetPoints = set.awayPoints || 0
                          const leftSetWon = set.finished && leftSetPoints > rightSetPoints
                          const rightSetWon = set.finished && rightSetPoints > leftSetPoints
                          const leftSetTimeouts = setEvents.filter(e => e.type === 'timeout' && e.payload?.team === (leftTeam === 'home' ? 'home' : 'away')).length
                          const rightSetTimeouts = setEvents.filter(e => e.type === 'timeout' && e.payload?.team === (rightTeam === 'home' ? 'home' : 'away')).length
                          const leftSetSubs = setEvents.filter(e => e.type === 'substitution' && e.payload?.team === (leftTeam === 'home' ? 'home' : 'away')).length
                          const rightSetSubs = setEvents.filter(e => e.type === 'substitution' && e.payload?.team === (rightTeam === 'home' ? 'home' : 'away')).length
                          const setDuration = set.finished && set.endTime && set.startTime 
                            ? Math.round((new Date(set.endTime) - new Date(set.startTime)) / 1000 / 60)
                            : set.startTime 
                            ? Math.round((Date.now() - new Date(set.startTime)) / 1000 / 60)
                            : '-'
                          
                          return (
                            <tr key={set.id || idx} style={{ 
                              borderBottom: '1px solid rgba(255,255,255,0.1)',
                              background: set.finished 
                                ? (leftSetWon ? 'rgba(34, 197, 94, 0.1)' : rightSetWon ? 'rgba(239, 68, 68, 0.1)' : 'transparent')
                                : 'transparent'
                            }}>
                              <td style={{ padding: '2px 1px', textAlign: 'center' }}>{leftSetTimeouts}</td>
                              <td style={{ padding: '2px 1px', textAlign: 'center' }}>{leftSetSubs}</td>
                              <td style={{ padding: '2px 1px', textAlign: 'center' }}>{leftSetWon ? '1' : rightSetWon ? '0' : '-'}</td>
                              <td style={{ padding: '2px 1px', textAlign: 'center' }}>{leftSetPoints}</td>
                              <td style={{ padding: '1px 2px', textAlign: 'center', fontWeight: 600, borderRight: '1px solid rgba(255,255,255,0.2)' }}>{set.index}</td>
                              <td style={{ padding: '1px 2px', textAlign: 'center', borderLeft: '1px solid rgba(255,255,255,0.2)' }}>{setDuration}{setDuration !== '-' ? "'" : ''}</td>
                              <td style={{ padding: '2px 1px', textAlign: 'center' }}>{rightSetPoints}</td>
                              <td style={{ padding: '2px 1px', textAlign: 'center' }}>{rightSetWon ? '1' : leftSetWon ? '0' : '-'}</td>
                              <td style={{ padding: '2px 1px', textAlign: 'center' }}>{rightSetSubs}</td>
                              <td style={{ padding: '2px 1px', textAlign: 'center' }}>{rightSetTimeouts}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
              </div>
                )
              })()}
              
              {/* Sanctions Table */}
              {(() => {
                const leftSanctionsWithTeam = (leftStats.sanctions || []).map(s => ({ ...s, team: 'left' }))
                const rightSanctionsWithTeam = (rightStats.sanctions || []).map(s => ({ ...s, team: 'right' }))
                const allSanctions = [...leftSanctionsWithTeam, ...rightSanctionsWithTeam]
                if (allSanctions.length === 0) return null
                
                return (
                  <div style={{ 
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '8px',
                    padding: '8px',
                    fontSize: '8px'
                  }}>
                    <h4 style={{ margin: '0 0 6px', fontSize: '10px', fontWeight: 600, textAlign: 'center' }}>
                      Sanctions
                    </h4>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '3px', maxHeight: '120px', overflowY: 'auto' }}>
                      {allSanctions.map((s, i) => {
                        const teamLabel = s.team === 'left' ? leftLabel : rightLabel
                        return (
                  <div key={i} style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '1px',
                    padding: '3px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    borderRadius: '3px',
                    border: '1px solid rgba(255, 255, 255, 0.08)'
                  }}>
                    {s.type === 'improper_request' ? (
                      <div style={{
                        fontSize: '14px',
                        fontWeight: 700,
                        color: '#9ca3af',
                        width: '12px',
                        height: '14px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>✕</div>
                    ) : s.type === 'delay_warning' ? (
                      <div style={{
                        width: '12px',
                        height: '14px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        position: 'relative'
                      }}>
                        <svg width="11" height="11" viewBox="0 0 14 14" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }}>
                          <circle cx="7" cy="7" r="6" fill="#fbbf24" stroke="#d97706" strokeWidth="1"/>
                          <line x1="7" y1="7" x2="7" y2="4" stroke="#000" strokeWidth="1.5" strokeLinecap="round"/>
                          <line x1="7" y1="7" x2="9.5" y2="7" stroke="#000" strokeWidth="1.5" strokeLinecap="round"/>
                          <circle cx="7" cy="7" r="0.8" fill="#000"/>
                        </svg>
                      </div>
                    ) : s.type === 'delay_penalty' ? (
                      <div style={{
                        width: '12px',
                        height: '14px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        position: 'relative'
                      }}>
                        <svg width="11" height="11" viewBox="0 0 14 14" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }}>
                          <circle cx="7" cy="7" r="6" fill="#ef4444" stroke="#b91c1c" strokeWidth="1"/>
                          <line x1="7" y1="7" x2="7" y2="4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                          <line x1="7" y1="7" x2="9.5" y2="7" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                          <circle cx="7" cy="7" r="0.8" fill="#fff"/>
                        </svg>
                      </div>
                    ) : s.type === 'disqualification' ? (
                              <div style={{ display: 'flex', gap: '1px', alignItems: 'center' }}>
                        <div style={{ 
                                  width: '6px', 
                                  height: '10px',
                          flexShrink: 0,
                                  borderRadius: '1px',
                          background: 'linear-gradient(160deg, #fde047, #facc15)'
                        }}></div>
                        <div style={{ 
                                  width: '6px', 
                                  height: '10px',
                          flexShrink: 0,
                                  borderRadius: '1px',
                          background: 'linear-gradient(160deg, #ef4444, #b91c1c)'
                        }}></div>
                      </div>
                    ) : s.type === 'expulsion' ? (
                              <div style={{ position: 'relative', width: '11px', height: '12px' }}>
                        <div style={{ 
                                  width: '6px', 
                                  height: '10px',
                          position: 'absolute',
                          left: '0',
                          top: '1px',
                          transform: 'rotate(-8deg)',
                          zIndex: 1,
                                  borderRadius: '1px',
                          background: 'linear-gradient(160deg, #fde047, #facc15)'
                        }}></div>
                        <div style={{ 
                                  width: '6px', 
                                  height: '10px',
                          position: 'absolute',
                          right: '0',
                                  top: '0',
                          transform: 'rotate(8deg)',
                          zIndex: 2,
                                  borderRadius: '1px',
                          background: 'linear-gradient(160deg, #ef4444, #b91c1c)'
                        }}></div>
                      </div>
                            ) : s.type === 'warning' ? (
                      <div style={{ 
                                width: '8px', 
                                height: '10px',
                                borderRadius: '1px',
                                background: 'linear-gradient(160deg, #fde047, #facc15)'
                      }}></div>
                            ) : s.type === 'penalty' ? (
                              <div style={{ 
                                width: '8px', 
                                height: '10px',
                                borderRadius: '1px',
                                background: 'linear-gradient(160deg, #ef4444, #b91c1c)'
                              }}></div>
                            ) : null}
                            <div style={{ fontSize: '6px', fontWeight: 600, textAlign: 'center', marginTop: '1px' }}>
                      {s.type === 'improper_request' ? 'IR' :
                       s.type === 'delay_warning' ? 'DW' :
                       s.type === 'delay_penalty' ? 'DP' :
                       s.type === 'warning' ? 'W' :
                       s.type === 'penalty' ? 'P' :
                       s.type === 'expulsion' ? 'E' :
                       s.type === 'disqualification' ? 'D' : s.type}
                    </div>
                            <div style={{ fontSize: '7px', fontWeight: 600, color: 'var(--text)' }}>
                              {teamLabel} {s.target || ''}
                    </div>
                  </div>
                        )
                      })}
              </div>
            </div>
                )
              })()}
        </div>

            {/* Right Column - Right Team TO/SUB */}
        <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              alignItems: 'center',
              flexShrink: 0
            }}>
            <div 
                onClick={() => activeTimeout && activeTimeout.team === rightTeam && stopTimeout()}
              style={{ 
                background: activeTimeout && activeTimeout.team === rightTeam 
                  ? 'rgba(251, 191, 36, 0.15)' 
                  : 'rgba(255, 255, 255, 0.05)', 
                borderRadius: '4px', 
                  padding: '6px 12px',
                textAlign: 'center',
                border: activeTimeout && activeTimeout.team === rightTeam
                  ? '2px solid var(--accent)'
                  : '1px solid rgba(255, 255, 255, 0.1)',
                  cursor: activeTimeout && activeTimeout.team === rightTeam ? 'pointer' : 'default',
                  minWidth: '60px'
              }}
            >
                <div style={{ fontSize: '8px', color: 'var(--muted)', marginBottom: '2px' }}>TO</div>
              {activeTimeout && activeTimeout.team === rightTeam ? (
                <div style={{ 
                    fontSize: '16px', 
                  fontWeight: 800,
                  color: 'var(--accent)',
                  lineHeight: 1
                }}>
                    {formatCountdown(activeTimeout.countdown)}
                </div>
              ) : (
                <div style={{ 
                  fontSize: '16px', 
                  fontWeight: 700,
                  color: rightStats.timeouts >= 2 ? '#ef4444' : 'inherit'
                }}>
                  {rightStats.timeouts}
                </div>
              )}
                {activeTimeout && activeTimeout.team === rightTeam && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      stopTimeout()
                    }}
                    style={{
                      marginTop: '4px',
                      padding: '2px 6px',
                      fontSize: '8px',
                      fontWeight: 600,
                      background: 'rgba(255,255,255,0.1)',
                      color: 'var(--text)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: '3px',
                      cursor: 'pointer'
                    }}
                  >
                    Stop TO
                  </button>
                )}
            </div>
            <div style={{ 
              background: 'rgba(255, 255, 255, 0.05)', 
              borderRadius: '4px', 
                padding: '6px 12px',
              textAlign: 'center',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                minWidth: '60px'
            }}>
                <div style={{ fontSize: '8px', color: 'var(--muted)', marginBottom: '2px' }}>SUB</div>
              <div style={{ 
                fontSize: '16px', 
                fontWeight: 700,
                color: rightStats.substitutions >= 6 ? '#ef4444' : rightStats.substitutions >= 5 ? '#eab308' : 'inherit'
              }}>{rightStats.substitutions}</div>
            </div>
          </div>
              </div>
                      </div>
      )}

      {/* Court Switch Waiting Modal */}
      {data?.match && data.currentSet?.index === 5 && 
       (data.currentSet.homePoints === 8 || data.currentSet.awayPoints === 8) && 
       !data.match.set5CourtSwitched && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0, 0, 0, 0.9)',
          zIndex: 9999
        }}>
          <div style={{
            background: 'var(--bg-secondary)',
            borderRadius: '12px',
            padding: '32px',
            maxWidth: '400px',
            width: '90%',
            textAlign: 'center',
            border: '4px solid var(--accent)',
            boxShadow: '0 0 40px rgba(251, 191, 36, 0.6)'
          }}>
            <div style={{
              fontSize: '48px',
              marginBottom: '16px'
            }}>
              🔄
            </div>
            <h2 style={{
              fontSize: '20px',
              fontWeight: 700,
              marginBottom: '16px',
              color: 'var(--accent)'
            }}>
              Court Switch Required
            </h2>
            <p style={{
              fontSize: '16px',
              marginBottom: '16px',
              color: 'var(--text)'
            }}>
              Set 5 — A team has reached 8 points
            </p>
            <p style={{
              fontSize: '14px',
              color: 'var(--muted)'
            }}>
              Waiting for scorer to confirm court switch...
            </p>
          </div>
        </div>
      )}

      {/* Referee Call Alert Modal */}
      {data?.match?.refereeCallActive && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0, 0, 0, 0.8)',
          zIndex: 9999,
          animation: 'blink 2s infinite'
        }}>
          <style>{`
            @keyframes blink {
              0%, 50% { opacity: 1; }
              51%, 100% { opacity: 0.4; }
            }
          `}</style>
          <div style={{
            background: '#dc2626',
            borderRadius: '12px',
            padding: '32px',
            maxWidth: '400px',
            width: '90%',
            textAlign: 'center',
            border: '4px solid #991b1b',
            boxShadow: '0 0 40px rgba(220, 38, 38, 0.8)'
          }}>
            <div style={{
              fontSize: '48px',
              marginBottom: '16px'
            }}>
              ⚠️
            </div>
            <h2 style={{
              fontSize: '24px',
              fontWeight: 700,
              marginBottom: '16px',
              color: '#fff'
            }}>
              Scorer Requires Attention
            </h2>
            <p style={{
              fontSize: '16px',
              marginBottom: '24px',
              color: 'rgba(255, 255, 255, 0.9)'
            }}>
              The scorer has requested referee assistance
            </p>
            <button
              onClick={dismissRefereeCall}
              style={{
                padding: '14px 32px',
                fontSize: '16px',
                fontWeight: 600,
                background: '#fff',
                color: '#dc2626',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
              }}
            >
              Acknowledged
            </button>
          </div>
        </div>
      )}

      {/* Substitution Notification */}
      {activeSubstitution && (() => {
        const teamData = activeSubstitution.team === 'home' ? data?.homeTeam : data?.awayTeam
        const teamName = teamData?.name || (activeSubstitution.team === 'home' ? 'Home' : 'Away')
        const teamAKey = data?.match?.coinTossTeamA || 'home'
        const teamLabel = activeSubstitution.team === teamAKey ? 'A' : 'B'
        const teamColor = teamData?.color || (activeSubstitution.team === 'home' ? '#ef4444' : '#3b82f6')
        
        return (
          <div 
            onClick={() => setActiveSubstitution(null)}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0, 0, 0, 0.5)',
              zIndex: 9998,
              cursor: 'pointer'
            }}
          >
            <div 
              style={{
                background: 'rgba(0, 0, 0, 1)',
                borderRadius: '12px',
                padding: '20px 32px',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6)',
                border: `3px solid ${teamColor}`,
                minWidth: '300px',
                textAlign: 'center'
              }}
            >
              <div style={{
                fontSize: '14px',
                fontWeight: 700,
                marginBottom: '12px',
                color: 'var(--text)'
              }}>
                Substitution — Team {teamLabel}
              </div>
              <div style={{
                fontSize: '12px',
                color: 'var(--muted)',
                marginBottom: '8px'
              }}>
                {teamName}
              </div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '24px',
                fontSize: '28px',
                fontWeight: 700
              }}>
                <div style={{ 
                  display: 'flex', 
                  flexDirection: 'column', 
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <div style={{ fontSize: '10px', color: '#ef4444', fontWeight: 700 }}>OUT</div>
                  <div style={{ color: '#ef4444' }}>{activeSubstitution.playerOut}</div>
                  <div style={{ fontSize: '24px', color: '#ef4444' }}>↓</div>
                </div>
                <div style={{ 
                  display: 'flex', 
                  flexDirection: 'column', 
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <div style={{ fontSize: '10px', color: '#22c55e', fontWeight: 700 }}>IN</div>
                  <div style={{ color: '#22c55e' }}>{activeSubstitution.playerIn}</div>
                  <div style={{ fontSize: '24px', color: '#22c55e' }}>↑</div>
                </div>
              </div>
              <div style={{
                marginTop: '12px',
                fontSize: '10px',
                color: 'var(--muted)'
              }}>
                Tap to dismiss
              </div>
            </div>
          </div>
        )
      })()}

      {/* Connection Modal */}
      {connectionModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0, 0, 0, 0.8)',
          zIndex: 10000
        }}>
          <div style={{
            background: 'var(--bg-secondary)',
            borderRadius: '12px',
            padding: '24px',
            maxWidth: '400px',
            width: '90%',
            border: '2px solid rgba(255, 255, 255, 0.1)'
          }}>
            {connectionModal === 'select' ? (
              <>
                <h2 style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  marginBottom: '16px',
                  textAlign: 'center'
                }}>
                  Connect to Scoreboard
                </h2>
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px'
                }}>
                  <button
                    onClick={() => setConnectionModal('bluetooth')}
                    style={{
                      padding: '12px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: 'rgba(59, 130, 246, 0.2)',
                      color: '#fff',
                      border: '2px solid rgba(59, 130, 246, 0.4)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px'
                    }}
                  >
                    <span>📶</span>
                    <span>Bluetooth</span>
                  </button>
                  <button
                    onClick={() => setConnectionModal('lan')}
                    style={{
                      padding: '12px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: 'rgba(34, 197, 94, 0.2)',
                      color: '#fff',
                      border: '2px solid rgba(34, 197, 94, 0.4)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px'
                    }}
                  >
                    <span>🌐</span>
                    <span>LAN (Local Network)</span>
                  </button>
                  <button
                    onClick={() => setConnectionModal('internet')}
                    style={{
                      padding: '12px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: 'rgba(139, 92, 246, 0.2)',
                      color: '#fff',
                      border: '2px solid rgba(139, 92, 246, 0.4)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px'
                    }}
                  >
                    <span>🌍</span>
                    <span>Internet</span>
                  </button>
                  <button
                    onClick={() => setConnectionModal(null)}
                    style={{
                      padding: '8px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: 'rgba(255,255,255,0.1)',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      marginTop: '8px'
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : connectionModal === 'bluetooth' ? (
              <>
                <h2 style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  marginBottom: '16px',
                  textAlign: 'center'
                }}>
                  Connect via Bluetooth
                </h2>
                <p style={{
                  fontSize: '12px',
                  color: 'var(--muted)',
                  marginBottom: '16px',
                  textAlign: 'center'
                }}>
                  Make sure the scoreboard is advertising Bluetooth and is nearby.
                </p>
                {connectionError && (
                  <div style={{
                    padding: '8px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '6px',
                    color: '#ef4444',
                    fontSize: '12px',
                    marginBottom: '16px'
                  }}>
                    {connectionError}
                  </div>
                )}
                <div style={{
                  display: 'flex',
                  gap: '8px'
                }}>
                  <button
                    onClick={handleConnectBluetooth}
                    disabled={connectionStatus === 'connecting'}
                    style={{
                      flex: 1,
                      padding: '12px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: connectionStatus === 'connecting' 
                        ? 'rgba(255,255,255,0.1)' 
                        : 'var(--accent)',
                      color: connectionStatus === 'connecting' ? 'var(--muted)' : '#000',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: connectionStatus === 'connecting' ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {connectionStatus === 'connecting' ? 'Connecting...' : 'Connect'}
                  </button>
                  <button
                    onClick={() => {
                      setConnectionModal(null)
                      setConnectionError('')
                    }}
                    style={{
                      padding: '12px 16px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: 'rgba(255,255,255,0.1)',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: '8px',
                      cursor: 'pointer'
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : connectionModal === 'lan' ? (
              <>
                <h2 style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  marginBottom: '16px',
                  textAlign: 'center'
                }}>
                  Connect via LAN
                </h2>
                <p style={{
                  fontSize: '12px',
                  color: 'var(--muted)',
                  marginBottom: '16px',
                  textAlign: 'center'
                }}>
                  Enter the IP address and port of the scoreboard device.
                </p>
                {connectionError && (
                  <div style={{
                    padding: '8px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '6px',
                    color: '#ef4444',
                    fontSize: '12px',
                    marginBottom: '16px'
                  }}>
                    {connectionError}
                  </div>
                )}
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  marginBottom: '16px'
                }}>
                  <div>
                    <label style={{
                      display: 'block',
                      fontSize: '12px',
                      fontWeight: 600,
                      marginBottom: '4px',
                      color: 'var(--text)'
                    }}>
                      IP Address
                    </label>
                    <input
                      type="text"
                      value={lanIP}
                      onChange={(e) => setLanIP(e.target.value)}
                      placeholder="192.168.1.100"
                      style={{
                        width: '100%',
                        padding: '10px',
                        fontSize: '14px',
                        background: 'rgba(255,255,255,0.1)',
                        border: '1px solid rgba(255,255,255,0.2)',
                        borderRadius: '6px',
                        color: '#fff',
                        outline: 'none'
                      }}
                    />
                  </div>
                  <div>
                    <label style={{
                      display: 'block',
                      fontSize: '12px',
                      fontWeight: 600,
                      marginBottom: '4px',
                      color: 'var(--text)'
                    }}>
                      Port
                    </label>
                    <input
                      type="number"
                      value={lanPort}
                      onChange={(e) => setLanPort(e.target.value)}
                      placeholder="8080"
                      min="1"
                      max="65535"
                      style={{
                        width: '100%',
                        padding: '10px',
                        fontSize: '14px',
                        background: 'rgba(255,255,255,0.1)',
                        border: '1px solid rgba(255,255,255,0.2)',
                        borderRadius: '6px',
                        color: '#fff',
                        outline: 'none'
                      }}
                    />
                  </div>
                </div>
                <div style={{
                  display: 'flex',
                  gap: '8px'
                }}>
                  <button
                    onClick={handleConnectLAN}
                    disabled={connectionStatus === 'connecting' || !lanIP || !lanPort}
                    style={{
                      flex: 1,
                      padding: '12px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: (connectionStatus === 'connecting' || !lanIP || !lanPort)
                        ? 'rgba(255,255,255,0.1)' 
                        : 'var(--accent)',
                      color: (connectionStatus === 'connecting' || !lanIP || !lanPort) ? 'var(--muted)' : '#000',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: (connectionStatus === 'connecting' || !lanIP || !lanPort) ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {connectionStatus === 'connecting' ? 'Connecting...' : 'Connect'}
                  </button>
                  <button
                    onClick={() => {
                      setConnectionModal(null)
                      setConnectionError('')
                      setLanIP('')
                      setLanPort('8080')
                    }}
                    style={{
                      padding: '12px 16px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: 'rgba(255,255,255,0.1)',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: '8px',
                      cursor: 'pointer'
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : connectionModal === 'internet' ? (
              <>
                <h2 style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  marginBottom: '16px',
                  textAlign: 'center'
                }}>
                  Connect via Internet
                </h2>
                <p style={{
                  fontSize: '12px',
                  color: 'var(--muted)',
                  marginBottom: '16px',
                  textAlign: 'center'
                }}>
                  Enter the WebSocket URL of the scoreboard server (e.g., wss://example.com:8080 or ws://example.com:8080)
                </p>
                {connectionError && (
                  <div style={{
                    padding: '8px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '6px',
                    color: '#ef4444',
                    fontSize: '12px',
                    marginBottom: '16px'
                  }}>
                    {connectionError}
                  </div>
                )}
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  marginBottom: '16px'
                }}>
                  <div>
                    <label style={{
                      display: 'block',
                      fontSize: '12px',
                      fontWeight: 600,
                      marginBottom: '4px',
                      color: 'var(--text)'
                    }}>
                      WebSocket URL
                    </label>
                    <input
                      type="text"
                      value={internetURL}
                      onChange={(e) => setInternetURL(e.target.value)}
                      placeholder="wss://scoreboard.example.com:8080"
                      style={{
                        width: '100%',
                        padding: '10px',
                        fontSize: '14px',
                        background: 'rgba(255,255,255,0.1)',
                        border: '1px solid rgba(255,255,255,0.2)',
                        borderRadius: '6px',
                        color: '#fff',
                        outline: 'none'
                      }}
                    />
                    <p style={{
                      fontSize: '10px',
                      color: 'var(--muted)',
                      marginTop: '4px',
                      marginBottom: 0
                    }}>
                      Use wss:// for secure (HTTPS) or ws:// for non-secure (HTTP) connections
                    </p>
                  </div>
                </div>
                <div style={{
                  display: 'flex',
                  gap: '8px'
                }}>
                  <button
                    onClick={handleConnectInternet}
                    disabled={connectionStatus === 'connecting' || !internetURL}
                    style={{
                      flex: 1,
                      padding: '12px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: (connectionStatus === 'connecting' || !internetURL)
                        ? 'rgba(255,255,255,0.1)' 
                        : 'var(--accent)',
                      color: (connectionStatus === 'connecting' || !internetURL) ? 'var(--muted)' : '#000',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: (connectionStatus === 'connecting' || !internetURL) ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {connectionStatus === 'connecting' ? 'Connecting...' : 'Connect'}
                  </button>
                  <button
                    onClick={() => {
                      setConnectionModal(null)
                      setConnectionError('')
                      setInternetURL('')
                    }}
                    style={{
                      padding: '12px 16px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: 'rgba(255,255,255,0.1)',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: '8px',
                      cursor: 'pointer'
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* Captain on Court Modal */}
      {captainOnCourtModal && (
        <Modal
          title={`Select Captain on Court - Team ${captainOnCourtModal.team === 'home' ? (data?.homeTeam?.name || 'Home') : (data?.awayTeam?.name || 'Away')}`}
          open={true}
          onClose={handleCancelCaptainOnCourt}
          width={600}
        >
          <div style={{ padding: '24px' }}>
            <p style={{ marginBottom: '20px', fontSize: '16px' }}>
              The team captain is not on court. Please select which player is acting as captain on court:
            </p>
            
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(3, 1fr)', 
              gap: '12px',
              marginBottom: '24px'
            }}>
              {(() => {
                const teamPlayers = captainOnCourtModal.team === 'home' 
                  ? (data?.homePlayers || []) 
                  : (data?.awayPlayers || [])
                const playersOnCourt = captainOnCourtModal.playersOnCourt || []
                const lineup = captainOnCourtModal.lineup || {}
                
                // Get players currently on court (including liberos)
                const playersOnCourtList = []
                const positionOrder = ['I', 'II', 'III', 'IV', 'V', 'VI']
                
                positionOrder.forEach(pos => {
                  const playerNumber = lineup[pos]
                  if (playerNumber) {
                    const player = teamPlayers.find(p => String(p.number) === String(playerNumber))
                    if (player) {
                      playersOnCourtList.push({
                        number: player.number,
                        name: player.name || `${player.firstName || ''} ${player.lastName || ''}`.trim(),
                        position: pos,
                        isLibero: !!(player.libero && player.libero !== ''),
                        isTeamCaptain: !!(player.isCaptain || player.captain)
                      })
                    }
                  }
                })
                
                return playersOnCourtList.map((player) => (
                  <button
                    key={player.number}
                    onClick={() => handleSelectCaptainOnCourt(player.number)}
                    style={{
                      padding: '16px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '2px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      textAlign: 'center'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
                    }}
                  >
                    <div style={{ fontSize: '24px', fontWeight: 700, marginBottom: '4px' }}>
                      #{player.number}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '4px' }}>
                      {player.name || 'Player'}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--muted)' }}>
                      Position {player.position}
                      {player.isLibero && ' (Libero)'}
                    </div>
                  </button>
                ))
              })()}
            </div>
            
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={handleCancelCaptainOnCourt}
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
                Cancel (No Captain)
              </button>
            </div>
          </div>
        </Modal>
      )}

    </div>
  )
}
