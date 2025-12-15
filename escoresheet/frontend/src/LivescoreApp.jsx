import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { findMatchByGameNumber, getMatchData, subscribeToMatchData, listAvailableMatches, getWebSocketStatus } from './utils/serverDataSync'
import { getServerStatus } from './utils/networkInfo'
import SimpleHeader from './components/SimpleHeader'
import UpdateBanner from './components/UpdateBanner'
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
  const [availableMatches, setAvailableMatches] = useState([])
  const [loadingMatches, setLoadingMatches] = useState(false)
  const [connectionStatuses, setConnectionStatuses] = useState({
    server: 'disconnected',
    websocket: 'disconnected'
  })
  const wakeLockRef = useRef(null)
  const noSleepVideoRef = useRef(null)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [testModeClicks, setTestModeClicks] = useState(0)
  const testModeTimeoutRef = useRef(null)

  // Request wake lock to prevent screen from sleeping
  useEffect(() => {
    const createNoSleepVideo = () => {
      if (noSleepVideoRef.current) return
      const mp4 = 'data:video/mp4;base64,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'
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
          console.log('[WakeLock] Screen wake lock acquired (Livescore)')
          setWakeLockActive(true)
          wakeLockRef.current.addEventListener('release', () => {
            console.log('[WakeLock] Screen wake lock released (Livescore)')
            if (!wakeLockRef.current) {
              setWakeLockActive(false)
            }
          })
        }
      } catch (err) {
        console.log('[WakeLock] Native wake lock failed:', err.message)
      }
      
      try {
        const video = createNoSleepVideo()
        if (video) {
          await video.play()
          console.log('[NoSleep] Video wake lock enabled (Livescore)')
        }
      } catch (err) {
        console.log('[NoSleep] Video wake lock failed:', err.message)
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
      console.log('[WakeLock] Manually disabled')
    } else {
      // Enable wake lock
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          setWakeLockActive(true)
          console.log('[WakeLock] Manually enabled')
        }
        if (noSleepVideoRef.current) {
          await noSleepVideoRef.current.play()
        }
      } catch (err) {
        console.log('[WakeLock] Failed to enable:', err.message)
        setWakeLockActive(true) // Visual feedback even if API failed
      }
    }
  }, [wakeLockActive])

  // Load available matches on mount and periodically
  useEffect(() => {
    const loadMatches = async () => {
      setLoadingMatches(true)
      try {
        const result = await listAvailableMatches()
        if (result.success && result.matches) {
          setAvailableMatches(result.matches)
        }
      } catch (err) {
        console.error('Error loading matches:', err)
      } finally {
        setLoadingMatches(false)
      }
    }

    loadMatches()
    const interval = setInterval(loadMatches, 30000)

    return () => clearInterval(interval)
  }, [])

  // Check connection status periodically
  useEffect(() => {
    const checkConnections = async () => {
      try {
        const serverStatus = await getServerStatus()
        const wsStatus = gameId ? getWebSocketStatus(gameId) : 'not_applicable'

        setConnectionStatuses({
          server: serverStatus?.running ? 'connected' : 'disconnected',
          websocket: gameId ? wsStatus : 'not_applicable'
        })
      } catch (err) {
        setConnectionStatuses({
          server: 'disconnected',
          websocket: 'disconnected'
        })
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
      setError('Please enter a game number')
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
          setError('Match not found with this game number')
        }
      }
    } catch (err) {
      console.error('Error finding match:', err)
      setError('Failed to find match. Make sure the main scoresheet is running.')
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
          setDataError('Failed to load match data')
        }
      } catch (err) {
        console.error('Error fetching match data:', err)
        setDataError('Failed to load match data. Make sure the main scoresheet is running.')
      } finally {
        setLoading(false)
      }
    }

    fetchData()

    // Subscribe to match data updates
    const unsubscribe = subscribeToMatchData(gameId, (updatedData) => {
      console.log('[Livescore] WebSocket update received')
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

    // Refetch data when page becomes visible (handles screen wake from sleep)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('[Livescore] Page became visible, refetching data...')
        fetchData()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [gameId])


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
    if (gameId && data?.match) {
      if (data.match.status === 'final') {
        setError('Game not in progress or not existing')
      } else {
        setError('')
      }
    } else if (gameId && dataError) {
      setError(dataError)
    } else if (gameId && !data && !loading) {
      setError('Game not in progress or not existing')
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
        console.log('[Test Mode] Activated with mock data')
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
          title="Live Scoring"
          wakeLockActive={wakeLockActive}
          toggleWakeLock={toggleWakeLock}
          connectionStatuses={connectionStatuses}
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
            Live Scoring
          </h1>

          {loadingMatches ? (
            <div style={{
              padding: '20px',
              color: 'rgba(255, 255, 255, 0.7)',
              fontSize: '16px'
            }}>
              Loading available games...
            </div>
          ) : availableMatches.length > 0 ? (
            <>
            <p style={{
              fontSize: '16px',
              color: 'rgba(255, 255, 255, 0.7)',
              marginBottom: '32px'
            }}>
              Select a game to view live scores
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
                    Game {match.gameNumber || match.id}
                  </div>
                  <div style={{
                    fontSize: '16px',
                    fontWeight: 500
                  }}>
                    {match.homeTeamName || 'Home'} vs {match.awayTeamName || 'Away'}
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
                No active game found
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

  // Show error if game doesn't exist or is not in progress
  if (error || !data?.match || data.match.status === 'final') {
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
          title="Live Scoring"
          wakeLockActive={wakeLockActive}
          toggleWakeLock={toggleWakeLock}
          connectionStatuses={connectionStatuses}
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
          title="Live Scoring"
          wakeLockActive={wakeLockActive}
          toggleWakeLock={toggleWakeLock}
          connectionStatuses={connectionStatuses}
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
            Loading...
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
        title="Live Scoring"
        subtitle={`Game: ${gameId}`}
        wakeLockActive={wakeLockActive}
        toggleWakeLock={toggleWakeLock}
        connectionStatuses={connectionStatuses}
        onBack={() => {
          setGameId(null)
          setGameIdInput('')
          setError('')
        }}
        backLabel="Change Game"
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
            Switch Sides
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
              alt="Serving team"
              style={{
                width: 'clamp(40px, 10vw, 80px)',
                height: 'clamp(40px, 10vw, 80px)',
                position: 'absolute',
                left: 'clamp(-30px, -7vw, -50px)',
                top: '50%',
                transform: 'translateY(-50%)',
                filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
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
              alt="Serving team"
              style={{
                width: 'clamp(40px, 10vw, 80px)',
                height: 'clamp(40px, 10vw, 80px)',
                position: 'absolute',
                right: 'clamp(-30px, -7vw, -50px)',
                top: '50%',
                transform: 'translateY(-50%)',
                filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
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
            SET
          </span>
          <span style={{
              fontSize: 'clamp(40px, 12vw, 100px)',
              fontWeight: 800,
              color: 'var(--text)',
              lineHeight: '1'
            }}>
              {data?.set?.index || 1}
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
    </div>
  )
}
