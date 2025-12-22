import { useState, useEffect, useMemo, useCallback } from 'react'
import { getMatchData, subscribeToMatchData, updateMatchData } from '../utils/serverDataSync'
import { db } from '../db/db'
import mikasaVolleyball from '../mikasa_v200w.png'
import { Results } from '../../scoresheet_pdf/components/FooterSection'
import TestModeControls from './TestModeControls'

export default function MatchEntry({ matchId, team, onBack, embedded = false }) {
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Send heartbeat to indicate bench connection is active (only if connection is enabled)
  useEffect(() => {
    if (!matchId || !team || matchId === -1) return // Skip in test mode

    const checkAndStartHeartbeat = async () => {
      const match = await db.matches.get(matchId)
      if (!match) return null
      const connectionEnabled = team === 'home'
        ? match.homeTeamConnectionEnabled === true
        : match.awayTeamConnectionEnabled === true
      if (connectionEnabled === false) return null
      
      const updateHeartbeat = async () => {
        try {
          const heartbeatField = team === 'home' 
            ? 'lastHomeTeamHeartbeat' 
            : 'lastAwayTeamHeartbeat'
          await db.matches.update(matchId, {
            [heartbeatField]: new Date().toISOString()
          })
        } catch (error) {
          console.error('Failed to update bench heartbeat:', error)
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
      // Clear heartbeat on unmount (skip in test mode)
      // Use local DB instead of server API since this runs in bench context
      if (matchId !== -1) {
        const heartbeatField = team === 'home'
          ? 'lastHomeTeamHeartbeat'
          : 'lastAwayTeamHeartbeat'
        db.matches.update(matchId, { [heartbeatField]: null })
          .catch(() => {}) // Silently fail - not critical
      }
    }
  }, [matchId, team])

  // Load match data from server
  const [data, setData] = useState(null)

  useEffect(() => {
    if (!matchId) {
      setData(null)
      return
    }

    // Test mode: use mock data
    if (matchId === -1) {
      setData({
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
        set: { index: 1, homePoints: 12, awayPoints: 10, finished: false },
        allSets: [{ index: 1, homePoints: 12, awayPoints: 10, finished: false }],
        events: [],
        homePlayers: [
          { id: 1, number: 1, firstName: 'Test', lastName: 'Player 1' },
          { id: 2, number: 5, firstName: 'Test', lastName: 'Player 2' },
          { id: 3, number: 7, firstName: 'Test', lastName: 'Player 3' },
          { id: 4, number: 10, firstName: 'Test', lastName: 'Player 4' },
          { id: 5, number: 12, firstName: 'Test', lastName: 'Player 5' },
          { id: 6, number: 15, firstName: 'Test', lastName: 'Player 6' }
        ],
        awayPlayers: [
          { id: 7, number: 2, firstName: 'Test', lastName: 'Away 1' },
          { id: 8, number: 4, firstName: 'Test', lastName: 'Away 2' },
          { id: 9, number: 8, firstName: 'Test', lastName: 'Away 3' },
          { id: 10, number: 11, firstName: 'Test', lastName: 'Away 4' },
          { id: 11, number: 13, firstName: 'Test', lastName: 'Away 5' },
          { id: 12, number: 16, firstName: 'Test', lastName: 'Away 6' }
        ]
      })
      return
    }

    // Fetch initial match data
    const fetchData = async () => {
      try {
        const result = await getMatchData(matchId)
        if (result.success) {
          const allSets = (result.sets || []).sort((a, b) => a.index - b.index)
          const currentSet = allSets.find(s => !s.finished) || null
          const events = (result.events || []).sort((a, b) => {
            const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
            const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
            return aTime - bTime
          })
          
          setData({
            match: result.match,
            homeTeam: result.homeTeam,
            awayTeam: result.awayTeam,
            set: currentSet,
            allSets,
            events,
            homePlayers: (result.homePlayers || []).sort((a, b) => (a.number || 0) - (b.number || 0)),
            awayPlayers: (result.awayPlayers || []).sort((a, b) => (a.number || 0) - (b.number || 0))
          })
        }
      } catch (err) {
        console.error('Error fetching match data:', err)
      }
    }

    fetchData()

    // Subscribe to match data updates
    const unsubscribe = subscribeToMatchData(matchId, (updatedData) => {
      const allSets = (updatedData.sets || []).sort((a, b) => a.index - b.index)
      const currentSet = allSets.find(s => !s.finished) || null
      const events = (updatedData.events || []).sort((a, b) => {
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return aTime - bTime
      })
      
      setData({
        match: updatedData.match,
        homeTeam: updatedData.homeTeam,
        awayTeam: updatedData.awayTeam,
        set: currentSet,
        allSets,
        events,
        homePlayers: (updatedData.homePlayers || []).sort((a, b) => (a.number || 0) - (b.number || 0)),
        awayPlayers: (updatedData.awayPlayers || []).sort((a, b) => (a.number || 0) - (b.number || 0))
      })
    })

    return () => {
      unsubscribe()
    }
  }, [matchId])

  // Determine which side the team is on (same logic as Scoreboard)
  const teamSide = useMemo(() => {
    if (!data?.set || !data?.match) return 'left'
    
    // Get Team A and Team B from coin toss
    const teamAKey = data.match.coinTossTeamA || 'home'
    const teamBKey = data.match.coinTossTeamB || 'away'
    
    // Set 1: Team A on left
    if (data.set.index === 1) {
      return team === teamAKey ? 'left' : 'right'
    }
    
    // Set 5: Special case with court switch at 8 points
    if (data.set.index === 5) {
      // Use set5LeftTeam if specified
      if (data.match.set5LeftTeam) {
        const leftTeamKey = data.match.set5LeftTeam === 'A' ? teamAKey : teamBKey
        let isLeft = team === leftTeamKey
        
        // If court switch has happened at 8 points, switch again
        if (data.match.set5CourtSwitched) {
          isLeft = !isLeft
        }
        
        return isLeft ? 'left' : 'right'
      }
      
      // Fallback: Set 5 starts with teams switched (like set 2+)
      let isLeft = team !== teamAKey
      
      // If court switch has happened at 8 points, switch again
      if (data.match.set5CourtSwitched) {
        isLeft = !isLeft
      }
      
      return isLeft ? 'left' : 'right'
    }
    
    // Set 2, 3, 4: Teams switch sides (Team A goes right, Team B goes left)
    return team === teamAKey ? 'right' : 'left'
  }, [data?.set, data?.match, team])

  // Get team info
  const teamInfo = useMemo(() => {
    if (!data) return null
    const isHome = team === 'home'
    return {
      name: isHome ? data.homeTeam?.name : data.awayTeam?.name,
      color: isHome ? data.homeTeam?.color : data.awayTeam?.color,
      players: isHome ? data.homePlayers : data.awayPlayers,
      bench: isHome ? (data.match?.bench_home || []) : (data.match?.bench_away || [])
    }
  }, [data, team])

  // Get opponent team info
  const opponentInfo = useMemo(() => {
    if (!data) return null
    const isHome = team === 'home'
    return {
      name: isHome ? data.awayTeam?.name : data.homeTeam?.name,
      color: isHome ? data.awayTeam?.color : data.homeTeam?.color,
      players: isHome ? data.awayPlayers : data.homePlayers,
      bench: isHome ? (data.match?.bench_away || []) : (data.match?.bench_home || [])
    }
  }, [data, team])

  // Get current set points
  const points = useMemo(() => {
    if (!data?.set) return { team: 0, opponent: 0 }
    if (team === 'home') {
      return { team: data.set.homePoints, opponent: data.set.awayPoints }
    } else {
      return { team: data.set.awayPoints, opponent: data.set.homePoints }
    }
  }, [data?.set, team])

  // Get set score
  const setScore = useMemo(() => {
    if (!data?.allSets) return { team: 0, opponent: 0 }
    let teamWins = 0
    let opponentWins = 0
    for (const set of data.allSets) {
      if (set.finished) {
        if (team === 'home') {
          if (set.homePoints > set.awayPoints) teamWins++
          else if (set.awayPoints > set.homePoints) opponentWins++
        } else {
          if (set.awayPoints > set.homePoints) teamWins++
          else if (set.homePoints > set.awayPoints) opponentWins++
        }
      }
    }
    return { team: teamWins, opponent: opponentWins }
  }, [data?.allSets, team])

  // Check if match is finished
  const isMatchFinished = useMemo(() => {
    return setScore.team === 3 || setScore.opponent === 3
  }, [setScore])

  // Calculate set results for Results component
  const calculateSetResults = useMemo(() => {
    if (!data) return []

    const { match, allSets, events } = data
    const localTeamAKey = match?.coinTossTeamA || 'home'
    const localTeamBKey = localTeamAKey === 'home' ? 'away' : 'home'

    const results = []
    for (let setNum = 1; setNum <= 5; setNum++) {
      const setInfo = allSets?.find(s => s.index === setNum)
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
  const matchWinner = useMemo(() => {
    if (!isMatchFinished || !data) return ''
    const teamWon = setScore.team > setScore.opponent
    return teamWon ? teamInfo.name : opponentInfo.name
  }, [isMatchFinished, data, setScore, teamInfo, opponentInfo])

  const matchResult = useMemo(() => {
    if (!isMatchFinished) return ''
    return `3:${Math.min(setScore.team, setScore.opponent)}`
  }, [isMatchFinished, setScore])

  // Get timeouts used in current set
  const timeoutsUsed = useMemo(() => {
    if (!data?.events || !data?.set) return 0
    return data.events.filter(
      event => event.type === 'timeout' && 
      event.setIndex === data.set.index && 
      event.payload?.team === team
    ).length
  }, [data?.events, data?.set, team])

  // Get substitutions used in current set
  const substitutionsUsed = useMemo(() => {
    if (!data?.events || !data?.set) return 0
    return data.events.filter(
      event => event.type === 'substitution' && 
      event.setIndex === data.set.index && 
      event.payload?.team === team
    ).length
  }, [data?.events, data?.set, team])

  // Get who is serving
  const isServing = useMemo(() => {
    if (!data?.events || !data?.set) return false
    // Find the last serve event in current set
    const serveEvents = data.events
      .filter(e => e.type === 'point' && e.setIndex === data.set.index)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    
    if (serveEvents.length === 0) {
      // Check first serve from match
      const firstServe = data.match?.firstServe
      return firstServe === team
    }
    
    const lastPoint = serveEvents[0]
    return lastPoint.payload?.team === team
  }, [data?.events, data?.set, data?.match, team])

  // Get players on court
  const playersOnCourt = useMemo(() => {
    if (!data?.events || !data?.set) {
      // Return empty placeholders if no set data
      return ['I', 'II', 'III', 'IV', 'V', 'VI'].map(pos => ({
        number: null,
        position: pos,
        isCaptain: false,
        isLibero: false,
        liberoType: null
      }))
    }
    
    // Get lineup events for current set
    const lineupEvents = data.events
      .filter(e => e.type === 'lineup' && e.setIndex === data.set.index && e.payload?.team === team)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    
    const positions = ['I', 'II', 'III', 'IV', 'V', 'VI']
    
    // If no lineup events, return empty placeholders
    if (lineupEvents.length === 0) {
      return positions.map(pos => ({
        number: null,
        position: pos,
        isCaptain: false,
        isLibero: false,
        liberoType: null
      }))
    }
    
    const latestLineupEvent = lineupEvents[0]
    const latestLineup = latestLineupEvent?.payload?.lineup
    
    // Lineup is stored as an object { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
    // Convert to array in correct order: I, II, III (front), IV, V, VI (back)
    if (!latestLineup || typeof latestLineup !== 'object') {
      return positions.map(pos => ({
        number: null,
        position: pos,
        isCaptain: false,
        isLibero: false,
        liberoType: null,
        substitutedPlayerNumber: null
      }))
    }
    
    const players = positions.map((pos) => {
      const playerNum = latestLineup[pos]
      if (!playerNum) {
        return {
          number: null,
          position: pos,
          isCaptain: false,
          isLibero: false,
          liberoType: null,
          substitutedPlayerNumber: null
        }
      }
      
      const player = teamInfo?.players?.find(p => p.number === playerNum)
      
      // Check for libero substitution (substituted player number)
      const liberoSub = latestLineupEvent?.payload?.liberoSubstitution
      const substitutedPlayerNumber = liberoSub && 
        String(liberoSub.liberoNumber) === String(playerNum) && 
        liberoSub.position === pos
        ? liberoSub.playerNumber
        : null
      
      return {
        number: playerNum,
        position: pos,
        isCaptain: player?.isCaptain || false,
        isLibero: player?.libero === 'libero1' || player?.libero === 'libero2',
        liberoType: player?.libero,
        substitutedPlayerNumber: substitutedPlayerNumber
      }
    })
    
    return players
  }, [data?.events, data?.set, team, teamInfo])

  // Get player sanctions
  const getPlayerSanctions = useCallback((playerNumber) => {
    if (!data?.events) return []
    return data.events.filter(
      e => e.type === 'sanction' && 
      e.payload?.team === team && 
      e.payload?.playerNumber === playerNumber
    )
  }, [data?.events, team])

  // Get official sanctions (by role)
  const getOfficialSanctions = useCallback((role) => {
    if (!data?.events) return []
    return data.events.filter(
      e => e.type === 'sanction' && 
      e.payload?.team === team && 
      e.payload?.role === role &&
      !e.payload?.playerNumber // Only team/official sanctions, not player sanctions
    )
  }, [data?.events, team])

  // Get bench players (players not on court, excluding liberos)
  const benchPlayersWithSanctions = useMemo(() => {
    if (!teamInfo?.players || !data?.events || !data?.set) return []
    
    // Get players currently on court
    const lineupEvents = data.events
      .filter(e => e.type === 'lineup' && e.setIndex === data.set.index && e.payload?.team === team)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    
    const playersOnCourtSet = new Set()
    if (lineupEvents.length > 0) {
      const latestLineup = lineupEvents[0].payload?.lineup
      if (latestLineup && typeof latestLineup === 'object') {
        Object.values(latestLineup).forEach(num => {
          if (num) playersOnCourtSet.add(Number(num))
        })
      }
    }
    
    // Get bench players: all players not on court, excluding liberos
    const benchPlayers = teamInfo.players
      .filter(p => {
        const playerNumber = Number(p.number)
        if (Number.isNaN(playerNumber)) return false
        if (playersOnCourtSet.has(playerNumber)) return false
        if (p.libero && p.libero !== '') return false // Exclude liberos
        
        // Filter out players who were exceptionally substituted
        const wasExceptionallySubstituted = data.events?.some(e =>
          e.type === 'substitution' &&
          e.payload?.team === team &&
          String(e.payload?.playerOut) === String(playerNumber) &&
          e.payload?.isExceptional === true
        )
        if (wasExceptionallySubstituted) return false
        
        return true
      })
      .map(p => {
        const sanctions = getPlayerSanctions(p.number)
        return {
          number: p.number,
          firstName: p.firstName || '',
          lastName: p.lastName || p.name || '',
          dob: p.dob || '',
          sanctions,
          type: 'player'
        }
      })
      .sort((a, b) => (a.number || 0) - (b.number || 0))
    
    return benchPlayers
  }, [teamInfo, data?.events, data?.set, team, getPlayerSanctions])

  // Get liberos (not currently on court)
  const benchLiberos = useMemo(() => {
    if (!teamInfo?.players || !data?.events || !data?.set) return []
    
    // Get players currently on court
    const lineupEvents = data.events
      .filter(e => e.type === 'lineup' && e.setIndex === data.set.index && e.payload?.team === team)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    
    const playersOnCourtSet = new Set()
    if (lineupEvents.length > 0) {
      const latestLineup = lineupEvents[0].payload?.lineup
      if (latestLineup && typeof latestLineup === 'object') {
        Object.values(latestLineup).forEach(num => {
          if (num) playersOnCourtSet.add(Number(num))
        })
      }
    }
    
    // Get liberos not on court
    const liberos = teamInfo.players
      .filter(p => {
        const playerNumber = Number(p.number)
        if (Number.isNaN(playerNumber)) return false
        if (!p.libero || p.libero === '') return false
        if (playersOnCourtSet.has(playerNumber)) return false
        return true
      })
      .map(p => {
        const sanctions = getPlayerSanctions(p.number)
        return {
          number: p.number,
          firstName: p.firstName || '',
          lastName: p.lastName || p.name || '',
          dob: p.dob || '',
          libero: p.libero,
          sanctions,
          type: 'libero'
        }
      })
      .sort((a, b) => {
        // Sort by libero type first (L1 before L2), then by number
        if (a.libero !== b.libero) {
          return (a.libero === 'libero1' ? 0 : 1) - (b.libero === 'libero1' ? 0 : 1)
        }
        return (a.number || 0) - (b.number || 0)
      })
    
    return liberos
  }, [teamInfo, data?.events, data?.set, team, getPlayerSanctions])

  // Get bench officials
  const benchOfficials = useMemo(() => {
    if (!teamInfo?.bench) return []
    return teamInfo.bench
      .filter(b => b.firstName || b.lastName || b.role)
      .map(bench => {
        const sanctions = getOfficialSanctions(bench.role || '')
        return {
          role: bench.role || '',
          firstName: bench.firstName || '',
          lastName: bench.lastName || '',
          dob: bench.dob || '',
          sanctions,
          type: 'official'
        }
      })
  }, [teamInfo, getOfficialSanctions])

  // Get overall team sanctions
  const overallSanctions = useMemo(() => {
    if (!data?.events) return []
    return data.events.filter(
      e => e.type === 'sanction' && 
      e.payload?.team === team && 
      (!e.payload?.playerNumber || e.payload?.role)
    )
  }, [data?.events, team])

  if (!data || !teamInfo) {
    if (embedded) {
      return (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}>
          <div>Loading...</div>
        </div>
      )
    }
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}>
        <div>Loading...</div>
      </div>
    )
  }

  // Reorder players based on team side
  // Left team: Front row (IV, III, II), Back row (V, VI, I)
  // Right team: Front row (II, III, IV), Back row (I, VI, V) - mirrored
  const frontRow = playersOnCourt.filter(p => ['II', 'III', 'IV'].includes(p.position))
    .sort((a, b) => {
      if (teamSide === 'right') {
        // Right team: II, III, IV
        const order = { 'II': 0, 'III': 1, 'IV': 2 }
        return (order[a.position] || 0) - (order[b.position] || 0)
      } else {
        // Left team: IV, III, II
        const order = { 'IV': 0, 'III': 1, 'II': 2 }
        return (order[a.position] || 0) - (order[b.position] || 0)
      }
    })
  const backRow = playersOnCourt.filter(p => ['I', 'VI', 'V'].includes(p.position))
    .sort((a, b) => {
      if (teamSide === 'right') {
        // Right team: I, VI, V
        const order = { 'I': 0, 'VI': 1, 'V': 2 }
        return (order[a.position] || 0) - (order[b.position] || 0)
      } else {
        // Left team: V, VI, I
        const order = { 'V': 0, 'VI': 1, 'I': 2 }
        return (order[a.position] || 0) - (order[b.position] || 0)
      }
    })
  const position1Player = playersOnCourt.find(p => p.position === 'I')
  const showBall = isServing && position1Player

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
        minHeight: embedded ? 'auto' : '100vh',
        height: embedded ? '100%' : 'auto',
        background: embedded ? 'transparent' : 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        padding: embedded ? '12px' : '20px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
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

        {!embedded && (
          <button
            onClick={onBack}
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
            Back
          </button>
        )}
      </div>
    )
  }

  return (
    <div style={{
      minHeight: embedded ? 'auto' : '100vh',
      height: embedded ? '100%' : 'auto',
      background: embedded ? 'transparent' : 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      padding: embedded ? '12px' : '20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      display: 'flex',
      flexDirection: 'column',
      flex: embedded ? 1 : 'none'
    }}>
      <div style={{
        maxWidth: '1200px',
        margin: '0 auto',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: embedded ? '12px' : '20px',
        flex: embedded ? 1 : 'none'
      }}>
        {/* Header with Back button - only show when not embedded */}
        {!embedded && (
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <button
              onClick={onBack}
              style={{
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: 600,
                background: 'rgba(255,255,255,0.1)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '8px',
                cursor: 'pointer'
              }}
            >
              ← Back
            </button>
            <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>
              {teamInfo.name}
            </h1>
            <div style={{ width: '100px' }}></div>
          </div>
        )}

        {/* Score Display */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: embedded ? '4px' : '8px',
          padding: embedded ? '12px' : '20px',
          background: 'rgba(255,255,255,0.05)',
          borderRadius: '12px',
          flexShrink: 0
        }}>
          {/* Current set points - team points bigger */}
          <div style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: embedded ? '8px' : '12px',
            fontWeight: 700
          }}>
            <span style={{
              fontSize: embedded ? '48px' : '64px',
              color: '#fff'
            }}>{points.team}</span>
            <span style={{
              fontSize: embedded ? '20px' : '28px',
              opacity: 0.5,
              alignSelf: 'center'
            }}>:</span>
            <span style={{
              fontSize: embedded ? '28px' : '36px',
              color: 'rgba(255,255,255,0.6)'
            }}>{points.opponent}</span>
          </div>

          {/* Set score with previous set results */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: embedded ? '12px' : '16px'
          }}>
            {/* Previous set results */}
            {data?.allSets?.filter(s => s.finished).length > 0 && (
              <div style={{
                display: 'flex',
                gap: '6px',
                fontSize: embedded ? '11px' : '13px',
                color: 'rgba(255,255,255,0.5)'
              }}>
                {data.allSets.filter(s => s.finished).map((s, idx) => {
                  const teamPts = team === 'home' ? s.homePoints : s.awayPoints
                  const oppPts = team === 'home' ? s.awayPoints : s.homePoints
                  const won = teamPts > oppPts
                  return (
                    <span key={idx} style={{
                      padding: '2px 6px',
                      background: won ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                      border: `1px solid ${won ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
                      borderRadius: '4px',
                      color: won ? '#22c55e' : '#ef4444'
                    }}>
                      {teamPts}-{oppPts}
                    </span>
                  )
                })}
              </div>
            )}

            {/* Current set counter */}
            <div style={{
              fontSize: embedded ? '14px' : '18px',
              fontWeight: 600,
              color: 'var(--muted)'
            }}>
              Sets: {setScore.team} - {setScore.opponent}
            </div>
          </div>
        </div>

        {/* Court and Info Section - Side by side for right team */}
        <div style={{
          display: 'flex',
          flexDirection: teamSide === 'right' ? 'row' : 'column',
          gap: embedded ? '12px' : '20px',
          alignItems: teamSide === 'right' ? 'flex-start' : 'stretch',
          flex: embedded ? 1 : 'none',
          minHeight: 0,
          overflow: embedded ? 'auto' : 'visible'
        }}>
          {/* Court Display - Single Side */}
          <div className="court" style={{
            aspectRatio: '1 / 1',
            maxWidth: embedded ? '350px' : '600px',
            maxHeight: embedded ? 'calc(100vh - 280px)' : 'none',
            width: teamSide === 'right' ? '50%' : (embedded ? '100%' : '100%'),
            margin: teamSide === 'right' ? '0' : '0 auto',
            gridTemplateColumns: '1fr',
            position: 'relative',
            flexShrink: embedded ? 1 : 0
          }}>
          {/* 3m line */}
          <div className="court-attack-line" style={{
            left: teamSide === 'left' ? 'calc(100% - 33.33%)' : '33.33%',
            right: teamSide === 'left' ? '0' : 'auto'
          }} />
          
          {/* Net - positioned on left if right team, on right if left team */}
          <div className="court-net" style={{
            left: teamSide === 'left' ? 'auto' : '0',
            right: teamSide === 'left' ? '0' : 'auto',
            transform: 'none',
            width: '8px'
          }} />
          
          {/* Single side court */}
          <div className={`court-side court-side-${teamSide}`} style={{ width: '100%' }}>
            <div className={`court-team court-team-${teamSide}`} style={{ width: '100%', height: '100%' }}>
              {/* Front Row (closer to net) */}
              <div className={`court-row court-row-front`}>
                {frontRow.map((player, idx) => {
                  const sanctions = player.number ? getPlayerSanctions(player.number) : []
                  const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                  const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                  const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                  const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
                  
                  const shouldShowBall = showBall && player.position === 'I'
                  const teamPlayers = teamInfo?.players || []
                  const liberoCount = teamPlayers.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
                  const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : 'L2')
                  
                  return (
                    <div
                      key={`front-${player.position}-${idx}`}
                      className="court-player"
                      style={{
                        background: player.isLibero ? '#FFF8E7' : undefined,
                        color: player.isLibero ? '#000' : undefined,
                        position: 'relative',
                        width: 'clamp(56px, 12vw, 96px)',
                        height: 'clamp(56px, 12vw, 96px)',
                        fontSize: 'clamp(20px, 5vw, 36px)'
                      }}
                    >
                      {shouldShowBall && (
                        <img
                          src={mikasaVolleyball}
                          alt="Volleyball"
                          style={{
                            position: 'absolute',
                            left: teamSide === 'left' ? '-40px' : 'auto',
                            right: teamSide === 'left' ? 'auto' : '-40px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            width: '30px',
                            height: '30px',
                            zIndex: 5,
                            filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
                          }}
                        />
                      )}
                      {player.substitutedPlayerNumber && (
                        <span style={{
                          position: 'absolute',
                          top: '-8px',
                          right: '-8px',
                          width: '18px',
                          height: '18px',
                          background: '#FFF8E7',
                          border: '2px solid rgba(0, 0, 0, 0.2)',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '10px',
                          fontWeight: 700,
                          color: '#000',
                          zIndex: 6
                        }}>
                          {player.substitutedPlayerNumber}
                        </span>
                      )}
                      <span className="court-player-position">{player.position}</span>
                      {player.isCaptain && (() => {
                        if (player.isLibero) {
                          return (
                            <span className="court-player-captain" style={{ width: '20px' }}>{liberoLabel}</span>
                          )
                        }
                        return <span className="court-player-captain">C</span>
                      })()}
                      {player.isLibero && !player.isCaptain && (
                        <span style={{
                          position: 'absolute',
                          bottom: '-8px',
                          left: '-8px',
                          width: '20px',
                          height: '18px',
                          background: '#3b82f6',
                          border: '2px solid rgba(255, 255, 255, 0.4)',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '9px',
                          fontWeight: 700,
                          color: '#fff',
                          zIndex: 5
                        }}>
                          {liberoLabel}
                        </span>
                      )}
                      {player.number || '—'}
                      {sanctions.length > 0 && (
                        <div style={{
                          position: 'absolute',
                          bottom: '-6px',
                          right: '-6px',
                          zIndex: 10,
                          ...(player.substitutedPlayerNumber && (hasWarning || hasDisqualification) ? {
                            background: '#1a1a1a',
                            borderRadius: '3px',
                            padding: '2px',
                            bottom: '-8px',
                            right: '-8px'
                          } : {})
                        }}>
                          {hasExpulsion ? (
                            <div style={{ position: 'relative', width: '12px', height: '12px' }}>
                              <div className="sanction-card yellow" style={{
                                width: '6px',
                                height: '9px',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                position: 'absolute',
                                left: '0',
                                top: '1px',
                                transform: 'rotate(-8deg)',
                                zIndex: 1,
                                borderRadius: '1px'
                              }}></div>
                              <div className="sanction-card red" style={{
                                width: '6px',
                                height: '9px',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                position: 'absolute',
                                right: '0',
                                top: '1px',
                                transform: 'rotate(8deg)',
                                zIndex: 2,
                                borderRadius: '1px'
                              }}></div>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: '1px' }}>
                              {(hasWarning || hasDisqualification) && (
                                <div className="sanction-card yellow" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                              )}
                              {(hasPenalty || hasDisqualification) && (
                                <div className="sanction-card red" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Back Row (further from net) */}
              <div className={`court-row court-row-back`}>
                {backRow.map((player, idx) => {
                  const sanctions = player.number ? getPlayerSanctions(player.number) : []
                  const hasWarning = sanctions.some(s => s.payload?.type === 'warning')
                  const hasPenalty = sanctions.some(s => s.payload?.type === 'penalty')
                  const hasExpulsion = sanctions.some(s => s.payload?.type === 'expulsion')
                  const hasDisqualification = sanctions.some(s => s.payload?.type === 'disqualification')
                  
                  const shouldShowBall = showBall && player.position === 'I'
                  const teamPlayers = teamInfo?.players || []
                  const liberoCount = teamPlayers.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
                  const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : 'L2')
                  
                  return (
                    <div
                      key={`back-${player.position}-${idx}`}
                      className="court-player"
                      style={{
                        background: player.isLibero ? '#FFF8E7' : undefined,
                        color: player.isLibero ? '#000' : undefined,
                        position: 'relative',
                        width: 'clamp(56px, 12vw, 96px)',
                        height: 'clamp(56px, 12vw, 96px)',
                        fontSize: 'clamp(20px, 5vw, 36px)'
                      }}
                    >
                      {shouldShowBall && (
                        <img
                          src={mikasaVolleyball}
                          alt="Volleyball"
                          style={{
                            position: 'absolute',
                            left: teamSide === 'left' ? '-40px' : 'auto',
                            right: teamSide === 'left' ? 'auto' : '-40px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            width: '30px',
                            height: '30px',
                            zIndex: 5,
                            filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
                          }}
                        />
                      )}
                      {player.substitutedPlayerNumber && (
                        <span style={{
                          position: 'absolute',
                          top: '-8px',
                          right: '-8px',
                          width: '18px',
                          height: '18px',
                          background: '#FFF8E7',
                          border: '2px solid rgba(0, 0, 0, 0.2)',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '10px',
                          fontWeight: 700,
                          color: '#000',
                          zIndex: 6
                        }}>
                          {player.substitutedPlayerNumber}
                        </span>
                      )}
                      <span className="court-player-position">{player.position}</span>
                      {player.isCaptain && (() => {
                        if (player.isLibero) {
                          return (
                            <span className="court-player-captain" style={{ width: '20px' }}>{liberoLabel}</span>
                          )
                        }
                        return <span className="court-player-captain">C</span>
                      })()}
                      {player.isLibero && !player.isCaptain && (
                        <span style={{
                          position: 'absolute',
                          bottom: '-8px',
                          left: '-8px',
                          width: '20px',
                          height: '18px',
                          background: '#3b82f6',
                          border: '2px solid rgba(255, 255, 255, 0.4)',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '9px',
                          fontWeight: 700,
                          color: '#fff',
                          zIndex: 5
                        }}>
                          {liberoLabel}
                        </span>
                      )}
                      {player.number || '—'}
                      {sanctions.length > 0 && (
                        <div style={{
                          position: 'absolute',
                          bottom: '-6px',
                          right: '-6px',
                          zIndex: 10,
                          ...(player.substitutedPlayerNumber && (hasWarning || hasDisqualification) ? {
                            background: '#1a1a1a',
                            borderRadius: '3px',
                            padding: '2px',
                            bottom: '-8px',
                            right: '-8px'
                          } : {})
                        }}>
                          {hasExpulsion ? (
                            <div style={{ position: 'relative', width: '12px', height: '12px' }}>
                              <div className="sanction-card yellow" style={{
                                width: '6px',
                                height: '9px',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                position: 'absolute',
                                left: '0',
                                top: '1px',
                                transform: 'rotate(-8deg)',
                                zIndex: 1,
                                borderRadius: '1px'
                              }}></div>
                              <div className="sanction-card red" style={{
                                width: '6px',
                                height: '9px',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                position: 'absolute',
                                right: '0',
                                top: '1px',
                                transform: 'rotate(8deg)',
                                zIndex: 2,
                                borderRadius: '1px'
                              }}></div>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: '1px' }}>
                              {(hasWarning || hasDisqualification) && (
                                <div className="sanction-card yellow" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                              )}
                              {(hasPenalty || hasDisqualification) && (
                                <div className="sanction-card red" style={{ width: '8px', height: '11px', boxShadow: '0 1px 3px rgba(0,0,0,0.8)', borderRadius: '1px' }}></div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Info Section - Right side for right team, below for left team */}
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            flex: teamSide === 'right' ? '1' : 'none',
            minWidth: teamSide === 'right' ? '300px' : 'auto'
          }}>
            {/* Timeouts and Substitutions */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: teamSide === 'right' ? '1fr 1fr' : 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '12px',
              marginBottom: teamSide === 'right' ? '0' : '20px'
            }}>
              {/* Timeouts */}
              <div style={{
                background: timeoutsUsed >= 2 ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255,255,255,0.05)',
                borderRadius: '8px',
                padding: '12px',
                textAlign: 'center',
                border: timeoutsUsed >= 2 ? '1px solid rgba(239, 68, 68, 0.4)' : '1px solid transparent'
              }}>
                <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>
                  TO
                </div>
                <div style={{ fontSize: '20px', fontWeight: 700, color: timeoutsUsed >= 2 ? '#ef4444' : 'inherit' }}>
                  {timeoutsUsed} / 2
                </div>
              </div>

              {/* Substitutions */}
              <div style={{
                background: substitutionsUsed >= 6 ? 'rgba(239, 68, 68, 0.2)' : substitutionsUsed >= 5 ? 'rgba(234, 179, 8, 0.2)' : 'rgba(255,255,255,0.05)',
                borderRadius: '8px',
                padding: '12px',
                textAlign: 'center',
                border: substitutionsUsed >= 6 ? '1px solid rgba(239, 68, 68, 0.4)' : substitutionsUsed >= 5 ? '1px solid rgba(234, 179, 8, 0.4)' : '1px solid transparent'
              }}>
                <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>
                  Sub
                </div>
                <div style={{ fontSize: '20px', fontWeight: 700, color: substitutionsUsed >= 6 ? '#ef4444' : substitutionsUsed >= 5 ? '#eab308' : 'inherit' }}>
                  {substitutionsUsed} / 6
                </div>
              </div>
            </div>

            {/* Bench Section: Players, Liberos, and Officials */}
            {(benchPlayersWithSanctions.length > 0 || benchLiberos.length > 0 || benchOfficials.length > 0) && (
              <div style={{
                background: 'rgba(255,255,255,0.05)',
                borderRadius: '12px',
                padding: '20px'
              }}>
            <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>
              Bench
            </h3>
            
            {/* Bench Players */}
            {benchPlayersWithSanctions.length > 0 && (
              <div style={{ marginBottom: '20px' }}>
                <h4 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px', color: 'var(--muted)' }}>
                  Players
                </h4>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                  gap: '12px'
                }}>
                  {benchPlayersWithSanctions.map((player, idx) => (
                    <div
                      key={`player-${idx}`}
                      style={{
                        background: 'rgba(255,255,255,0.05)',
                        borderRadius: '8px',
                        padding: '12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px'
                      }}
                    >
                      <div style={{ fontSize: '14px', fontWeight: 600 }}>
                        #{player.number} {player.firstName} {player.lastName}
                      </div>
                      {player.sanctions.length > 0 && (
                        <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                          {player.sanctions.map((s, sIdx) => {
                            const type = s.payload?.type || 'warning'
                            const color = type === 'warning' || type === 'disqualification' ? '#eab308' : '#ef4444'
                            return (
                              <div
                                key={sIdx}
                                style={{
                                  width: '12px',
                                  height: '16px',
                                  background: color,
                                  border: '1px solid rgba(0,0,0,0.3)',
                                  borderRadius: '2px',
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.8)'
                                }}
                                title={type}
                              ></div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Liberos */}
            {benchLiberos.length > 0 && (
              <div style={{ marginBottom: '20px' }}>
                <h4 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px', color: 'var(--muted)' }}>
                  Liberos
                </h4>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                  gap: '12px'
                }}>
                  {benchLiberos.map((libero, idx) => (
                    <div
                      key={`libero-${idx}`}
                      style={{
                        background: 'rgba(59, 130, 246, 0.1)',
                        border: '1px solid rgba(59, 130, 246, 0.3)',
                        borderRadius: '8px',
                        padding: '12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px'
                      }}
                    >
                      <div style={{ fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{
                          background: '#3b82f6',
                          color: '#fff',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '10px',
                          fontWeight: 700
                        }}>
                          {libero.libero === 'libero1' ? 'L1' : 'L2'}
                        </span>
                        #{libero.number} {libero.firstName} {libero.lastName}
                      </div>
                      {libero.sanctions.length > 0 && (
                        <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                          {libero.sanctions.map((s, sIdx) => {
                            const type = s.payload?.type || 'warning'
                            const color = type === 'warning' || type === 'disqualification' ? '#eab308' : '#ef4444'
                            return (
                              <div
                                key={sIdx}
                                style={{
                                  width: '12px',
                                  height: '16px',
                                  background: color,
                                  border: '1px solid rgba(0,0,0,0.3)',
                                  borderRadius: '2px',
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.8)'
                                }}
                                title={type}
                              ></div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Bench Officials */}
            {benchOfficials.length > 0 && (
              <div>
                <h4 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px', color: 'var(--muted)' }}>
                  Officials
                </h4>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                  gap: '12px'
                }}>
                  {benchOfficials.map((official, idx) => (
                    <div
                      key={`official-${idx}`}
                      style={{
                        background: 'rgba(255,255,255,0.05)',
                        borderRadius: '8px',
                        padding: '12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px'
                      }}
                    >
                      <div style={{ fontSize: '14px', fontWeight: 600 }}>
                        {official.firstName} {official.lastName}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                        {official.role}
                      </div>
                      {official.sanctions && official.sanctions.length > 0 && (
                        <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                          {official.sanctions.map((s, sIdx) => {
                            const type = s.payload?.type || 'warning'
                            const color = type === 'warning' || type === 'disqualification' ? '#eab308' : '#ef4444'
                            return (
                              <div
                                key={sIdx}
                                style={{
                                  width: '12px',
                                  height: '16px',
                                  background: color,
                                  border: '1px solid rgba(0,0,0,0.3)',
                                  borderRadius: '2px',
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.8)'
                                }}
                                title={type}
                              ></div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        </div>

        {/* Overall Sanctions */}
        {overallSanctions.length > 0 && (
          <div style={{
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '12px',
            padding: '20px'
          }}>
            <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>
              Team Sanctions
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {overallSanctions.map((sanction, idx) => {
                const type = sanction.payload?.type || 'warning'
                const target = sanction.payload?.role || 'Team'
                const color = type === 'warning' || type === 'disqualification' ? '#eab308' : '#ef4444'
                return (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '12px',
                      background: 'rgba(255,255,255,0.05)',
                      borderRadius: '8px'
                    }}
                  >
                    <div style={{
                      width: '16px',
                      height: '22px',
                      background: color,
                      border: '1px solid rgba(0,0,0,0.3)',
                      borderRadius: '2px',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.8)'
                    }}></div>
                    <div>
                      <div style={{ fontWeight: 600 }}>{target}</div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                        {type.charAt(0).toUpperCase() + type.slice(1)}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        </div>
      </div>

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