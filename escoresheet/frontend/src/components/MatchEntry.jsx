import { useState, useEffect, useMemo, useCallback } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import mikasaVolleyball from '../mikasa_v200w.png'

export default function MatchEntry({ matchId, team, onBack }) {
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Send heartbeat to indicate bench connection is active (only if connection is enabled)
  useEffect(() => {
    if (!matchId || !team) return
    
    const checkAndStartHeartbeat = async () => {
      const match = await db.matches.get(matchId)
      if (!match) return null
      const connectionEnabled = team === 'home' 
        ? match.homeTeamConnectionEnabled !== false
        : match.awayTeamConnectionEnabled !== false
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
      // Clear heartbeat on unmount
      const heartbeatField = team === 'home' 
        ? 'lastHomeTeamHeartbeat' 
        : 'lastAwayTeamHeartbeat'
      db.matches.update(matchId, { [heartbeatField]: null })
        .catch(err => console.error('Failed to clear heartbeat:', err))
    }
  }, [matchId, team])

  // Load match data
  const data = useLiveQuery(async () => {
    if (!matchId) return null

    const match = await db.matches.get(matchId)
    if (!match) return null

    const [homeTeam, awayTeam] = await Promise.all([
      match.homeTeamId ? db.teams.get(match.homeTeamId) : null,
      match.awayTeamId ? db.teams.get(match.awayTeamId) : null
    ])

    const currentSet = await db.sets
      .where('matchId')
      .equals(matchId)
      .filter(s => !s.finished)
      .sortBy('index')
      .then(sets => sets[0] || null)

    const allSets = await db.sets
      .where('matchId')
      .equals(matchId)
      .sortBy('index')

    const events = await db.events
      .where('matchId')
      .equals(matchId)
      .sortBy('ts')

    const homePlayers = match.homeTeamId
      ? await db.players.where('teamId').equals(match.homeTeamId).sortBy('number')
      : []
    const awayPlayers = match.awayTeamId
      ? await db.players.where('teamId').equals(match.awayTeamId).sortBy('number')
      : []

    return {
      match,
      homeTeam,
      awayTeam,
      set: currentSet,
      allSets,
      events,
      homePlayers,
      awayPlayers
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

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      padding: '20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      <div style={{
        maxWidth: '1200px',
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px'
      }}>
        {/* Header with Back button */}
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

        {/* Score Display */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '8px',
          padding: '20px',
          background: 'rgba(255,255,255,0.05)',
          borderRadius: '12px'
        }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '16px',
            fontSize: '48px',
            fontWeight: 700
          }}>
            <span>{points.team}</span>
            <span style={{ fontSize: '32px', opacity: 0.5 }}>:</span>
            <span>{points.opponent}</span>
          </div>
          <div style={{
            fontSize: '18px',
            fontWeight: 600,
            color: 'var(--muted)'
          }}>
            Sets: {setScore.team} - {setScore.opponent}
          </div>
        </div>

        {/* Court and Info Section - Side by side for right team */}
        <div style={{
          display: 'flex',
          flexDirection: teamSide === 'right' ? 'row' : 'column',
          gap: '20px',
          alignItems: teamSide === 'right' ? 'flex-start' : 'stretch'
        }}>
          {/* Court Display - Single Side */}
          <div className="court" style={{ 
            aspectRatio: '3 / 3', 
            maxWidth: '600px',
            width: teamSide === 'right' ? '50%' : '100%',
            margin: teamSide === 'right' ? '0' : '0 auto',
            gridTemplateColumns: '1fr',
            position: 'relative',
            flexShrink: 0
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
                          zIndex: 10
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
                          zIndex: 10
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
                background: 'rgba(255,255,255,0.05)',
                borderRadius: '8px',
                padding: '12px',
                textAlign: 'center'
              }}>
                <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>
                  TO
                </div>
                <div style={{ fontSize: '20px', fontWeight: 700 }}>
                  {timeoutsUsed} / 2
                </div>
              </div>

              {/* Substitutions */}
              <div style={{
                background: 'rgba(255,255,255,0.05)',
                borderRadius: '8px',
                padding: '12px',
                textAlign: 'center'
              }}>
                <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>
                  Sub
                </div>
                <div style={{ fontSize: '20px', fontWeight: 700 }}>
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
    </div>
  )
}