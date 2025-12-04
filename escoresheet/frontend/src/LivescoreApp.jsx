import { useState, useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import mikasaVolleyball from './mikasa_v200w.png'

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
  const [gameId, setGameId] = useState(null)
  const [gameIdInput, setGameIdInput] = useState('')
  const [error, setError] = useState('')
  const [sidesSwitched, setSidesSwitched] = useState(false)

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
  const handleGameIdSubmit = (e) => {
    e.preventDefault()
    setError('')
    
    const id = parseInt(gameIdInput.trim())
    if (isNaN(id) || id <= 0) {
      setError('Please enter a valid game number')
      return
    }
    
    setGameId(id)
  }

  // Load match data
  const match = useLiveQuery(async () => {
    if (!gameId) return null
    return await db.matches.get(gameId)
  }, [gameId])

  // Load all related data
  const data = useLiveQuery(async () => {
    if (!gameId || !match) return null

    const homeTeam = await db.teams.get(match.homeTeamId)
    const awayTeam = await db.teams.get(match.awayTeamId)
    const homePlayers = await db.players.where('teamId').equals(match.homeTeamId).toArray()
    const awayPlayers = await db.players.where('teamId').equals(match.awayTeamId).toArray()
    const sets = await db.sets.where('matchId').equals(gameId).toArray()
    const events = await db.events.where('matchId').equals(gameId).toArray()
    const currentSet = sets.find(s => !s.finished) || sets.sort((a, b) => b.index - a.index)[0]

    return {
      match,
      homeTeam,
      awayTeam,
      homePlayers,
      awayPlayers,
      sets,
      events,
      set: currentSet
    }
  }, [gameId, match])

  // Determine which team is A and which is B based on coin toss
  const teamAKey = useMemo(() => {
    if (!data?.match) return 'home'
    return data.match.coinTossTeamA || 'home'
  }, [data?.match])
  
  const teamBKey = useMemo(() => {
    if (!data?.match) return 'away'
    return data.match.coinTossTeamB || 'away'
  }, [data?.match])

  // Determine left/right teams
  const leftIsHome = useMemo(() => {
    // If sides are manually switched, override the computed value
    if (sidesSwitched) {
      // Get the base leftIsHome value
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

  // Calculate set score (number of sets won by each team)
  const setScore = useMemo(() => {
    if (!data) return { home: 0, away: 0, left: 0, right: 0 }
    
    const allSets = data.sets || []
    const finishedSets = allSets.filter(s => s.finished)
    
    const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
    const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length
    
    const leftSetsWon = leftIsHome ? homeSetsWon : awaySetsWon
    const rightSetsWon = leftIsHome ? awaySetsWon : homeSetsWon
    
    return { home: homeSetsWon, away: awaySetsWon, left: leftSetsWon, right: rightSetsWon }
  }, [data, leftIsHome])

  // Get current score
  const currentScore = useMemo(() => {
    if (!data?.set) return { left: 0, right: 0 }
    return {
      left: leftIsHome ? data.set.homePoints : data.set.awayPoints,
      right: leftIsHome ? data.set.awayPoints : data.set.homePoints
    }
  }, [data?.set, leftIsHome])

  // Determine who has serve
  const currentServe = useMemo(() => {
    if (!data?.set || !data?.match) {
      return data?.match?.firstServe || 'home'
    }
    
    if (data.set.index === 5 && data.match?.set5FirstServe) {
      const firstServeTeamKey = data.match.set5FirstServe === 'A' ? teamAKey : teamBKey
      if (!data?.events || data.events.length === 0) {
        return firstServeTeamKey
      }
      const pointEvents = data.events
        .filter(e => e.type === 'point' && e.setIndex === data.set.index)
        .sort((a, b) => {
          const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
          const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
          return bTime - aTime
        })
      if (pointEvents.length === 0) {
        return firstServeTeamKey
      }
      return pointEvents[0].payload?.team || firstServeTeamKey
    }
    
    if (!data?.events || data.events.length === 0) {
      return data.match.firstServe || 'home'
    }
    
    const pointEvents = data.events
      .filter(e => e.type === 'point' && e.setIndex === data.set.index)
      .sort((a, b) => {
        const aTime = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime()
        const bTime = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime()
        return bTime - aTime
      })
    
    if (pointEvents.length === 0) {
      return data.match.firstServe || 'home'
    }
    
    return pointEvents[0].payload?.team || (data.match.firstServe || 'home')
  }, [data?.set, data?.match, data?.events, teamAKey, teamBKey])

  // Get team labels
  const teamALabel = data?.match?.coinTossTeamA === 'home' ? 'A' : 'B'
  const teamBLabel = data?.match?.coinTossTeamB === 'home' ? 'A' : 'B'

  // Get left and right teams
  const leftTeam = useMemo(() => {
    const team = leftIsHome ? data?.homeTeam : data?.awayTeam
    const teamKey = leftIsHome ? teamAKey : teamBKey
    return {
      name: team?.name || (leftIsHome ? 'Home' : 'Away'),
      color: team?.color || (leftIsHome ? '#ef4444' : '#3b82f6'),
      isTeamA: teamKey === teamAKey
    }
  }, [data, leftIsHome, teamAKey])

  const rightTeam = useMemo(() => {
    const team = leftIsHome ? data?.awayTeam : data?.homeTeam
    const teamKey = leftIsHome ? teamBKey : teamAKey
    return {
      name: team?.name || (leftIsHome ? 'Away' : 'Home'),
      color: team?.color || (leftIsHome ? '#3b82f6' : '#ef4444'),
      isTeamA: teamKey === teamAKey
    }
  }, [data, leftIsHome, teamAKey, teamBKey])

  const leftIsServing = currentServe === (leftIsHome ? 'home' : 'away')
  const rightIsServing = currentServe === (leftIsHome ? 'away' : 'home')

  // Check if game exists and is in progress
  useEffect(() => {
    if (gameId && match) {
      if (match.status === 'final') {
        setError('Game not in progress or not existing')
      } else {
        setError('')
      }
    } else if (gameId && !match) {
      setError('Game not in progress or not existing')
    }
  }, [gameId, match])

  // Show input form if no gameId is set
  if (!gameId) {
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
          textAlign: 'center',
          maxWidth: '400px',
          width: '100%'
        }}>
          <h1 style={{
            fontSize: '32px',
            fontWeight: 700,
            marginBottom: '8px'
          }}>
            Live Scoring
          </h1>
          <p style={{
            fontSize: '16px',
            color: 'rgba(255, 255, 255, 0.7)',
            marginBottom: '32px'
          }}>
            Enter the game number to view live scores
          </p>
          <form onSubmit={handleGameIdSubmit} style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '16px'
          }}>
            <input
              type="number"
              inputMode="numeric"
              value={gameIdInput}
              onChange={(e) => {
                setGameIdInput(e.target.value)
                setError('')
              }}
              placeholder="Game number"
              style={{
                padding: '16px',
                fontSize: '18px',
                background: 'rgba(255, 255, 255, 0.1)',
                border: '2px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '8px',
                color: '#fff',
                textAlign: 'center',
                outline: 'none',
                transition: 'border-color 0.2s',
                width: '100%',
                maxWidth: '300px'
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.4)'
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
              }}
              autoFocus
            />
            {error && (
              <div style={{
                padding: '12px',
                background: 'rgba(239, 68, 68, 0.2)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: '6px',
                color: '#ff6b6b',
                fontSize: '14px',
                width: '100%',
                maxWidth: '300px',
                textAlign: 'center'
              }}>
                {error}
              </div>
            )}
            <button
              type="submit"
              style={{
                padding: '16px',
                fontSize: '18px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'opacity 0.2s',
                width: '100%',
                maxWidth: '300px'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '0.9'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '1'
              }}
            >
              View Game
            </button>
          </form>
        </div>
      </div>
    )
  }

  // Show error if game doesn't exist or is not in progress
  if (error || !match || match.status === 'final') {
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
          textAlign: 'center',
          maxWidth: '400px',
          width: '100%'
        }}>
          <div style={{
            fontSize: '24px',
            fontWeight: 600,
            marginBottom: '16px'
          }}>
            {error || 'Game not in progress or not existing'}
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
            Enter Different Game Number
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
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <div style={{
          textAlign: 'center',
          fontSize: '18px'
        }}>
          Loading...
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
      {/* Header */}
      <div style={{
        padding: '16px 20px',
        background: 'rgba(15, 23, 42, 0.6)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div style={{ fontSize: '18px', fontWeight: 600 }}>Live Scoring</div>
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '16px',
          fontSize: '14px'
        }}>
          <button
            onClick={() => setSidesSwitched(!sidesSwitched)}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
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
            Switch Sides
          </button>
          <span style={{ color: 'var(--muted)' }}>Game ID: {gameId}</span>
          <button
            onClick={() => {
              setGameId(null)
              setGameIdInput('')
              setError('')
            }}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
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
            Change Game
          </button>
        </div>
      </div>


      {/* Score Counter */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '100px 20px',
        width: '100%',
        position: 'relative',
        gap: '20px'
      }}>
        {/* Left Team Score */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
          position: 'relative',
          padding: '0 20px 0 44px',
          flex: '0 1 auto',
          minWidth: 0
        }}>
          {leftIsServing && (
            <img
              src={mikasaVolleyball}
              alt="Serving team"
              style={{
                width: '80px',
                height: '80px',
                position: 'absolute',
                left: -50,
                top: '50%',
                transform: 'translateY(-50%)',
                filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
              }}
            />
          )}
          <div style={{
            fontSize: '200px',
            fontWeight: 700,
            color: '#fff',
            lineHeight: '1',
            textAlign: 'center'
          }}>
            {currentScore.left}
          </div>
          <div style={{
            fontSize: '20px',
            fontWeight: 600,
            color: 'rgba(255, 255, 255, 0.7)',
            textTransform: 'uppercase'
          }}>
            {leftTeam.name}
          </div>
        </div>

        {/* Separator - Always Centered */}
        <div style={{
          fontSize: '200px',
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
          padding: '0 44px 0 20px',
          flex: '0 1 auto',
          minWidth: 0
        }}>
          {rightIsServing && (
            <img
              src={mikasaVolleyball}
              alt="Serving team"
              style={{
                width: '80px',
                height: '80px',
                position: 'absolute',
                right: -50,
                top: '50%',
                transform: 'translateY(-50%)',
                filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
              }}
            />
          )}
          <div style={{
            fontSize: '200px',
            fontWeight: 700,
            color: '#fff',
            lineHeight: '1',
            textAlign: 'center'
          }}>
            {currentScore.right}
          </div>
          <div style={{
            fontSize: '20px',
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
        padding: '20px',
        gap: '24px'
      }}>
        <div style={{
          padding: '6px 12px',
          borderRadius: '6px',
          fontSize: '100px',
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
            fontSize: '100px',
            fontWeight: 800,
            color: 'var(--text)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            gap: '10px',
            lineHeight: '1'
          }}>
            SET 
            
          </span>
          <span style={{
              fontSize: '100px',
              fontWeight: 800,
              color: 'var(--text)',
              lineHeight: '1'
            }}>
              {data?.set?.index || 1}
            </span>
        </div>
        
        <div style={{
          padding: '6px 12px',
          borderRadius: '6px',
          fontSize: '100px',
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
    </div>
  )
}
