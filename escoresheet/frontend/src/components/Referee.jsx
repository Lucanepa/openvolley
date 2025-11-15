import { useState, useMemo, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import mikasaVolleyball from '../mikasa_v200w.png'

export default function Referee({ matchId, onExit }) {
  const [refereeView, setRefereeView] = useState('2nd') // '1st' or '2nd'
  const [activeTimeout, setActiveTimeout] = useState(null) // { team: 'home'|'away', countdown: number, eventId: number }
  const [processedTimeouts, setProcessedTimeouts] = useState(new Set()) // Track which timeout events we've already shown
  const [activeSubstitution, setActiveSubstitution] = useState(null) // { team: 'home'|'away', playerOut, playerIn, eventId: number, countdown: 5 }
  const [processedSubstitutions, setProcessedSubstitutions] = useState(new Set()) // Track which substitution events we've already shown
  
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
    if (data.currentSet.index === 1) {
      // Set 1: Team A on left
      return teamAKey === 'home'
    } else {
      // Set 2+: Teams switch sides (Team A goes right, Team B goes left)
      return teamAKey !== 'home'
    }
  }, [data?.currentSet, teamAKey])

  // For 1st referee, reverse the sides (they see from opposite end)
  const leftIsHome = refereeView === '1st' ? !leftIsHomeFor2ndRef : leftIsHomeFor2ndRef
  
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
    
    // Get substituted player number (from liberoSubInfo)
    const substitutedPlayerNumber = liberoSubInfo?.playerNumber
    
    return (
      <div 
        className="court-player"
        style={{
          position: 'relative',
          background: isLibero ? '#FFF8E7' : undefined,
          color: isLibero ? '#000' : undefined,
          width: 'clamp(50px, 7.8vw, 62px)', // 30% bigger than original clamp(28px, 6vw, 48px)
          height: 'clamp(50px, 7.8vw, 62px)',
          fontSize: 'clamp(25px, 3.25vw, 23px)' // 30% bigger than original clamp(12px, 2.5vw, 18px)
        }}
      >
        {shouldShowBall && (
          <img 
            src={mikasaVolleyball} 
            alt="Volleyball" 
            style={{
              position: 'absolute',
              left: team === leftTeam ? '-30px' : 'auto',
              right: team === rightTeam ? '-30px' : 'auto',
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
            width: '14.4px', // 20% smaller than 18px
            height: '14.4px',
            fontSize: '9px', // 20% smaller than 11px
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
                  width: '16px', // 20% smaller (adjusted for content)
                  height: '14.4px',
                  fontSize: '7px', // 20% smaller
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
                width: '14.4px', // 20% smaller than 18px
                height: '14.4px',
                fontSize: '9px', // 20% smaller than 11px
                bottom: '-6.4px', // 20% smaller offset
                left: '-6.4px'
              }}
            >
              C
            </span>
          )
        })()}
        {/* Substituted player number (top-right, referee only) */}
        {substitutedPlayerNumber && (
          <span style={{
            position: 'absolute',
            top: '-6.4px',
            right: '-6.4px',
            width: '14.4px', // 20% smaller than 18px
            height: '14.4px',
            background: '#FFF8E7',
            border: '1.6px solid rgba(0, 0, 0, 0.2)',
            borderRadius: '3.2px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '8px', // 20% smaller than 10px
            fontWeight: 700,
            color: '#000',
            zIndex: 6
          }}>
            {substitutedPlayerNumber}
          </span>
        )}
        {/* Libero indicator (bottom-left) */}
        {liberoLabel && (
          <span 
            className={isCaptain ? "court-player-captain" : ""}
            style={{
              position: 'absolute',
              bottom: '-6.4px',
              left: '-6.4px',
              width: '16px', // 20% smaller
              height: '14.4px', // 20% smaller
              background: isCaptain ? 'rgba(15, 23, 42, 0.95)' : '#3b82f6',
              border: isCaptain ? '1.6px solid var(--accent)' : '1.6px solid rgba(255, 255, 255, 0.4)',
              borderRadius: '3.2px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '7px', // 20% smaller
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
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      padding: '12px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '12px',
        gap: '12px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={onExit}
            style={{
              padding: '8px 16px',
              fontSize: '12px',
              fontWeight: 600,
              background: 'rgba(255,255,255,0.1)',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            Exit
          </button>
          
          {/* Scoresheet Connection Status */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 12px',
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '6px',
            fontSize: '11px'
          }}>
            <div style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: isScoresheetConnected ? '#22c55e' : '#ef4444',
              boxShadow: isScoresheetConnected 
                ? '0 0 8px rgba(34, 197, 94, 0.6)' 
                : 'none'
            }} />
            <span style={{ color: 'var(--muted)' }}>
              Scoresheet {isScoresheetConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
        
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setRefereeView('1st')}
            style={{
              padding: '8px 16px',
              fontSize: '12px',
              fontWeight: 600,
              background: refereeView === '1st' ? 'var(--accent)' : 'rgba(255,255,255,0.1)',
              color: refereeView === '1st' ? '#000' : '#fff',
              border: refereeView === '1st' ? 'none' : '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            1st Referee
          </button>
          <button
            onClick={() => setRefereeView('2nd')}
            style={{
              padding: '8px 16px',
              fontSize: '12px',
              fontWeight: 600,
              background: refereeView === '2nd' ? 'var(--accent)' : 'rgba(255,255,255,0.1)',
              color: refereeView === '2nd' ? '#000' : '#fff',
              border: refereeView === '2nd' ? 'none' : '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            2nd Referee
          </button>
        </div>
      </div>

      {/* Score Display */}
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: '8px',
        padding: '20px',
        marginBottom: '12px',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'column',
        gap: '20px'
      }}>
        {/* Team Names */}
        <div style={{
          display: 'flex',
          width: '100%',
          justifyContent: 'space-around',
          alignItems: 'center'
        }}>
          <div style={{ textAlign: 'center', flex: 1 }}>
            <span
              className="team-badge"
              style={{
                background: leftColor,
                color: isBrightColor(leftColor) ? '#000' : '#fff',
                padding: '8px 16px',
                borderRadius: '8px',
                fontSize: '24px',
                fontWeight: 700,
                display: 'inline-block',
                marginBottom: '8px',
                minWidth: '50px',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)'
              }}
            >
              {leftLabel}
            </span>
            <div style={{ fontSize: '16px', color: 'var(--muted)' }}>
              {leftTeamData?.name || (leftTeam === 'home' ? 'Home' : 'Away')}
            </div>
          </div>
          
          <div style={{ fontSize: '32px', color: 'var(--muted)', padding: '0 20px' }}>-</div>
          
          <div style={{ textAlign: 'center', flex: 1 }}>
            <span
              className="team-badge"
              style={{
                background: rightColor,
                color: isBrightColor(rightColor) ? '#000' : '#fff',
                padding: '8px 16px',
                borderRadius: '8px',
                fontSize: '24px',
                fontWeight: 700,
                display: 'inline-block',
                marginBottom: '8px',
                minWidth: '50px',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)'
              }}
            >
              {rightLabel}
            </span>
            <div style={{ fontSize: '16px', color: 'var(--muted)' }}>
              {rightTeamData?.name || (rightTeam === 'home' ? 'Home' : 'Away')}
            </div>
          </div>
        </div>

        {/* Score with Ball */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <div
            className="set-score-display"
            style={{
              position: 'relative',
              display: 'inline-block',
              padding: '0 50px'
            }}
          >
            {leftServing && (
              <img
                src={mikasaVolleyball}
                alt="Serving team"
                style={{
                  position: 'absolute',
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: '32px',
                  height: '32px',
                  filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
                }}
              />
            )}
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '12px'
            }}>
              <span style={{ minWidth: 40, textAlign: 'right' }}>{leftScore}</span>
              <span>:</span>
              <span style={{ minWidth: 40, textAlign: 'left' }}>{rightScore}</span>
            </div>
            {rightServing && (
              <img
                src={mikasaVolleyball}
                alt="Serving team"
                style={{
                  position: 'absolute',
                  right: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: '32px',
                  height: '32px',
                  filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
                }}
              />
            )}
          </div>
          {/* Set Score */}
          <div style={{
            fontSize: '16px',
            fontWeight: 600,
            color: 'var(--muted)',
            textAlign: 'center'
          }}>
            {leftSetScore}-{rightSetScore}
          </div>
        </div>
      </div>

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
        <div style={{ marginBottom: '12px' }}>
          {/* Set Title */}
          {data?.currentSet && (
            <div style={{
              textAlign: 'center',
              fontSize: '18px',
              fontWeight: 700,
              marginBottom: '12px',
              color: 'var(--text)'
            }}>
              Set {data.currentSet.index}
            </div>
          )}
          <div className="court">
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
      )}

      {/* Team Statistics */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '12px'
      }}>
        {/* Left Team Stats */}
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
          padding: '16px'
        }}>
          {/* TO and SUB Cards */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <div 
              onClick={() => activeTimeout && activeTimeout.team === leftTeam && setActiveTimeout(null)}
              style={{ 
                flex: 1, 
                background: activeTimeout && activeTimeout.team === leftTeam 
                  ? 'rgba(251, 191, 36, 0.15)' 
                  : 'rgba(255, 255, 255, 0.05)', 
                borderRadius: '8px', 
                padding: '12px',
                textAlign: 'center',
                border: activeTimeout && activeTimeout.team === leftTeam
                  ? '2px solid var(--accent)'
                  : '1px solid rgba(255, 255, 255, 0.1)',
                cursor: activeTimeout && activeTimeout.team === leftTeam ? 'pointer' : 'default'
              }}
            >
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>TO</div>
              {activeTimeout && activeTimeout.team === leftTeam ? (
                <div style={{ 
                  fontSize: '32px', 
                  fontWeight: 800,
                  color: 'var(--accent)',
                  lineHeight: 1
                }}>
                  {activeTimeout.countdown}"
                </div>
              ) : (
                <div style={{ 
                  fontSize: '24px', 
                  fontWeight: 700,
                  color: leftStats.timeouts >= 2 ? '#ef4444' : 'inherit'
                }}>
                  {leftStats.timeouts}
                </div>
              )}
            </div>
            <div style={{ 
              flex: 1, 
              background: 'rgba(255, 255, 255, 0.05)', 
              borderRadius: '8px', 
              padding: '12px',
              textAlign: 'center',
              border: '1px solid rgba(255, 255, 255, 0.1)'
            }}>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>SUB</div>
              <div style={{ 
                fontSize: '24px', 
                fontWeight: 700,
                color: leftStats.substitutions >= 6 ? '#ef4444' : leftStats.substitutions >= 5 ? '#eab308' : 'inherit'
              }}>{leftStats.substitutions}</div>
            </div>
          </div>
          
          {leftStats.sanctions.length > 0 && (
            <div>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '8px', fontWeight: 600 }}>
                Sanctions:
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' }}>
                {leftStats.sanctions.map((s, i) => (
                  <div key={i} style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '2px',
                    padding: '4px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    borderRadius: '4px',
                    border: '1px solid rgba(255, 255, 255, 0.08)'
                  }}>
                    {s.type === 'improper_request' ? (
                      <div style={{
                        fontSize: '18px',
                        fontWeight: 700,
                        color: '#9ca3af',
                        width: '14px',
                        height: '20px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>✕</div>
                    ) : s.type === 'delay_warning' ? (
                      <div style={{
                        width: '14px',
                        height: '20px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        position: 'relative'
                      }}>
                        <svg width="14" height="14" viewBox="0 0 14 14" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }}>
                          <circle cx="7" cy="7" r="6" fill="#fbbf24" stroke="#d97706" strokeWidth="1"/>
                          <line x1="7" y1="7" x2="7" y2="4" stroke="#000" strokeWidth="1.5" strokeLinecap="round"/>
                          <line x1="7" y1="7" x2="9.5" y2="7" stroke="#000" strokeWidth="1.5" strokeLinecap="round"/>
                          <circle cx="7" cy="7" r="0.8" fill="#000"/>
                        </svg>
                      </div>
                    ) : s.type === 'delay_penalty' ? (
                      <div style={{
                        width: '14px',
                        height: '20px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        position: 'relative'
                      }}>
                        <svg width="14" height="14" viewBox="0 0 14 14" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }}>
                          <circle cx="7" cy="7" r="6" fill="#ef4444" stroke="#b91c1c" strokeWidth="1"/>
                          <line x1="7" y1="7" x2="7" y2="4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                          <line x1="7" y1="7" x2="9.5" y2="7" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                          <circle cx="7" cy="7" r="0.8" fill="#fff"/>
                        </svg>
                      </div>
                    ) : s.type === 'disqualification' ? (
                      <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                        <div className="sanction-card yellow" style={{ 
                          width: '10px', 
                          height: '16px',
                          flexShrink: 0,
                          borderRadius: '2px'
                        }}></div>
                        <div className="sanction-card red" style={{ 
                          width: '10px', 
                          height: '16px',
                          flexShrink: 0,
                          borderRadius: '2px'
                        }}></div>
                      </div>
                    ) : s.type === 'expulsion' ? (
                      <div style={{ position: 'relative', width: '16px', height: '20px' }}>
                        <div className="sanction-card yellow" style={{ 
                          width: '10px', 
                          height: '16px',
                          position: 'absolute',
                          left: '0',
                          top: '2px',
                          transform: 'rotate(-8deg)',
                          zIndex: 1,
                          borderRadius: '2px'
                        }}></div>
                        <div className="sanction-card red" style={{ 
                          width: '10px', 
                          height: '16px',
                          position: 'absolute',
                          right: '0',
                          top: '2px',
                          transform: 'rotate(8deg)',
                          zIndex: 2,
                          borderRadius: '2px'
                        }}></div>
                      </div>
                    ) : (
                      <div className={`sanction-card ${
                        s.type === 'warning' ? 'yellow' :
                        s.type === 'penalty' ? 'red' : 'yellow'
                      }`} style={{ 
                        width: '14px', 
                        height: '20px',
                        flexShrink: 0,
                        borderRadius: '2px'
                      }}></div>
                    )}
                    <div style={{ fontSize: '8px', fontWeight: 600, textAlign: 'center', marginTop: '2px' }}>
                      {s.type === 'improper_request' ? 'IR' :
                       s.type === 'delay_warning' ? 'DW' :
                       s.type === 'delay_penalty' ? 'DP' :
                       s.type === 'warning' ? 'W' :
                       s.type === 'penalty' ? 'P' :
                       s.type === 'expulsion' ? 'E' :
                       s.type === 'disqualification' ? 'D' : s.type}
                    </div>
                    <div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--text)' }}>
                      {s.target || 'Team'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Team Stats */}
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '8px',
          padding: '16px'
        }}>
          {/* TO and SUB Cards */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <div 
              onClick={() => activeTimeout && activeTimeout.team === rightTeam && setActiveTimeout(null)}
              style={{ 
                flex: 1, 
                background: activeTimeout && activeTimeout.team === rightTeam 
                  ? 'rgba(251, 191, 36, 0.15)' 
                  : 'rgba(255, 255, 255, 0.05)', 
                borderRadius: '8px', 
                padding: '12px',
                textAlign: 'center',
                border: activeTimeout && activeTimeout.team === rightTeam
                  ? '2px solid var(--accent)'
                  : '1px solid rgba(255, 255, 255, 0.1)',
                cursor: activeTimeout && activeTimeout.team === rightTeam ? 'pointer' : 'default'
              }}
            >
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>TO</div>
              {activeTimeout && activeTimeout.team === rightTeam ? (
                <div style={{ 
                  fontSize: '32px', 
                  fontWeight: 800,
                  color: 'var(--accent)',
                  lineHeight: 1
                }}>
                  {activeTimeout.countdown}"
                </div>
              ) : (
                <div style={{ 
                  fontSize: '24px', 
                  fontWeight: 700,
                  color: rightStats.timeouts >= 2 ? '#ef4444' : 'inherit'
                }}>
                  {rightStats.timeouts}
                </div>
              )}
            </div>
            <div style={{ 
              flex: 1, 
              background: 'rgba(255, 255, 255, 0.05)', 
              borderRadius: '8px', 
              padding: '12px',
              textAlign: 'center',
              border: '1px solid rgba(255, 255, 255, 0.1)'
            }}>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>SUB</div>
              <div style={{ 
                fontSize: '24px', 
                fontWeight: 700,
                color: rightStats.substitutions >= 6 ? '#ef4444' : rightStats.substitutions >= 5 ? '#eab308' : 'inherit'
              }}>{rightStats.substitutions}</div>
            </div>
          </div>
          
          {rightStats.sanctions.length > 0 && (
            <div>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '8px', fontWeight: 600 }}>
                Sanctions:
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' }}>
                {rightStats.sanctions.map((s, i) => (
                  <div key={i} style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '2px',
                    padding: '4px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    borderRadius: '4px',
                    border: '1px solid rgba(255, 255, 255, 0.08)'
                  }}>
                    {s.type === 'improper_request' ? (
                      <div style={{
                        fontSize: '18px',
                        fontWeight: 700,
                        color: '#9ca3af',
                        width: '14px',
                        height: '20px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>✕</div>
                    ) : s.type === 'delay_warning' ? (
                      <div style={{
                        width: '14px',
                        height: '20px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        position: 'relative'
                      }}>
                        <svg width="14" height="14" viewBox="0 0 14 14" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }}>
                          <circle cx="7" cy="7" r="6" fill="#fbbf24" stroke="#d97706" strokeWidth="1"/>
                          <line x1="7" y1="7" x2="7" y2="4" stroke="#000" strokeWidth="1.5" strokeLinecap="round"/>
                          <line x1="7" y1="7" x2="9.5" y2="7" stroke="#000" strokeWidth="1.5" strokeLinecap="round"/>
                          <circle cx="7" cy="7" r="0.8" fill="#000"/>
                        </svg>
                      </div>
                    ) : s.type === 'delay_penalty' ? (
                      <div style={{
                        width: '14px',
                        height: '20px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        position: 'relative'
                      }}>
                        <svg width="14" height="14" viewBox="0 0 14 14" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }}>
                          <circle cx="7" cy="7" r="6" fill="#ef4444" stroke="#b91c1c" strokeWidth="1"/>
                          <line x1="7" y1="7" x2="7" y2="4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                          <line x1="7" y1="7" x2="9.5" y2="7" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
                          <circle cx="7" cy="7" r="0.8" fill="#fff"/>
                        </svg>
                      </div>
                    ) : s.type === 'disqualification' ? (
                      <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                        <div className="sanction-card yellow" style={{ 
                          width: '10px', 
                          height: '16px',
                          flexShrink: 0,
                          borderRadius: '2px'
                        }}></div>
                        <div className="sanction-card red" style={{ 
                          width: '10px', 
                          height: '16px',
                          flexShrink: 0,
                          borderRadius: '2px'
                        }}></div>
                      </div>
                    ) : s.type === 'expulsion' ? (
                      <div style={{ position: 'relative', width: '16px', height: '20px' }}>
                        <div className="sanction-card yellow" style={{ 
                          width: '10px', 
                          height: '16px',
                          position: 'absolute',
                          left: '0',
                          top: '2px',
                          transform: 'rotate(-8deg)',
                          zIndex: 1,
                          borderRadius: '2px'
                        }}></div>
                        <div className="sanction-card red" style={{ 
                          width: '10px', 
                          height: '16px',
                          position: 'absolute',
                          right: '0',
                          top: '2px',
                          transform: 'rotate(8deg)',
                          zIndex: 2,
                          borderRadius: '2px'
                        }}></div>
                      </div>
                    ) : (
                      <div className={`sanction-card ${
                        s.type === 'warning' ? 'yellow' :
                        s.type === 'penalty' ? 'red' : 'yellow'
                      }`} style={{ 
                        width: '14px', 
                        height: '20px',
                        flexShrink: 0,
                        borderRadius: '2px'
                      }}></div>
                    )}
                    <div style={{ fontSize: '8px', fontWeight: 600, textAlign: 'center', marginTop: '2px' }}>
                      {s.type === 'improper_request' ? 'IR' :
                       s.type === 'delay_warning' ? 'DW' :
                       s.type === 'delay_penalty' ? 'DP' :
                       s.type === 'warning' ? 'W' :
                       s.type === 'penalty' ? 'P' :
                       s.type === 'expulsion' ? 'E' :
                       s.type === 'disqualification' ? 'D' : s.type}
                    </div>
                    <div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--text)' }}>
                      {s.target || 'Team'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

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
          animation: 'blink 1s infinite'
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

    </div>
  )
}

