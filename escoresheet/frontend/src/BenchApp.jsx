import { useState, useEffect, useRef, useCallback } from 'react'
import { validatePin } from './utils/serverDataSync'
import RosterSetup from './components/RosterSetup'
import MatchEntry from './components/MatchEntry'
import mikasaVolleyball from './mikasa_v200w.png'

export default function BenchApp() {
  const [selectedTeam, setSelectedTeam] = useState(null) // 'home' or 'away'
  const [pinInput, setPinInput] = useState('')
  const [matchId, setMatchId] = useState(null)
  const [error, setError] = useState('')
  const [view, setView] = useState(null) // 'roster' or 'match'
  const [match, setMatch] = useState(null)
  const wakeLockRef = useRef(null)
  const noSleepVideoRef = useRef(null)
  const [wakeLockActive, setWakeLockActive] = useState(false)

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
          console.log('[WakeLock] Screen wake lock acquired (Bench)')
          setWakeLockActive(true)
          wakeLockRef.current.addEventListener('release', () => {
            console.log('[WakeLock] Screen wake lock released (Bench)')
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
          console.log('[NoSleep] Video wake lock enabled (Bench)')
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

  // Disconnect if connection is disabled
  useEffect(() => {
    if (match && selectedTeam) {
      const connectionEnabled = selectedTeam === 'home' 
        ? match.homeTeamConnectionEnabled !== false
        : match.awayTeamConnectionEnabled !== false
      
      if (connectionEnabled === false) {
        setMatchId(null)
        setMatch(null)
        setView(null)
        setSelectedTeam(null)
        setPinInput('')
        setError('Connection has been disabled. Please enable the connection in the scoreboard and reconnect.')
      }
    }
  }, [match, selectedTeam])

  const handleTeamSelect = (team) => {
    setSelectedTeam(team)
    setPinInput('')
    setError('')
  }

  const handlePinSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!pinInput || pinInput.length !== 6) {
      setError('Please enter a 6-digit PIN code')
      return
    }

    if (!selectedTeam) {
      setError('Please select a team first')
      return
    }

    try {
      // Validate PIN with server (no local IndexedDB)
      const pinType = selectedTeam === 'home' ? 'homeTeam' : 'awayTeam'
      const result = await validatePin(pinInput.trim(), pinType)
      
      if (result.success && result.match) {
        setMatchId(result.match.id)
        setMatch(result.match)
      } else {
        setError('Invalid PIN code. Please check and try again.')
        setPinInput('')
      }
    } catch (err) {
      console.error('Error validating PIN:', err)
      setError(err.message || 'Failed to validate PIN. Make sure the main scoresheet is running and connected.')
      setPinInput('')
    }
  }

  const handleViewSelect = (viewType) => {
    setView(viewType)
  }

  const handleBack = () => {
    if (view) {
      setView(null)
    } else if (matchId) {
      setMatchId(null)
      setPinInput('')
      setError('')
    } else if (selectedTeam) {
      setSelectedTeam(null)
    }
  }

  // Get team names from match data
  const [homeTeamName, setHomeTeamName] = useState('Home Team')
  const [awayTeamName, setAwayTeamName] = useState('Away Team')

  useEffect(() => {
    if (match) {
      // Team names will come from server data when we fetch full match data
      // For now, use placeholders - will be updated when components fetch full data
      setHomeTeamName('Home Team')
      setAwayTeamName('Away Team')
    }
  }, [match])

  // If view is selected, show the appropriate component
  if (matchId && view) {
    if (view === 'roster') {
      return (
        <RosterSetup 
          matchId={matchId} 
          team={selectedTeam}
          onBack={handleBack}
        />
      )
    } else if (view === 'match') {
      return (
        <MatchEntry 
          matchId={matchId} 
          team={selectedTeam}
          onBack={handleBack}
        />
      )
    }
  }

  // If PIN is correct, show view selection
  if (matchId) {

    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 20px',
          background: 'rgba(15, 23, 42, 0.6)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '16px', fontWeight: 600 }}>Team Bench</span>
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
          </div>
        </div>

        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}>
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          padding: '40px',
          maxWidth: '500px',
          width: '100%',
          textAlign: 'center'
        }}>
          <img
            src={mikasaVolleyball}
            alt="Volleyball"
            style={{ width: '80px', height: '80px', marginBottom: '20px' }}
          />
          <h1 style={{
            fontSize: '24px',
            fontWeight: 700,
            marginBottom: '12px'
          }}>
            Select Option
          </h1>
          <p style={{ 
            fontSize: '14px', 
            color: 'var(--muted)', 
            marginBottom: '32px' 
          }}>
            Select an option
          </p>

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            marginBottom: '24px'
          }}>
            <button
              onClick={() => handleViewSelect('roster')}
              style={{
                width: '100%',
                padding: '20px',
                fontSize: '18px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'opacity 0.2s'
              }}
              onMouseOver={(e) => e.target.style.opacity = '0.9'}
              onMouseOut={(e) => e.target.style.opacity = '1'}
            >
              Set up roster
            </button>

            <button
              onClick={() => handleViewSelect('match')}
              style={{
                width: '100%',
                padding: '20px',
                fontSize: '18px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'opacity 0.2s'
              }}
              onMouseOver={(e) => e.target.style.opacity = '0.9'}
              onMouseOut={(e) => e.target.style.opacity = '1'}
            >
              Enter match
            </button>
          </div>

          <button
            onClick={handleBack}
            style={{
              width: '100%',
              padding: '12px',
              fontSize: '14px',
              fontWeight: 500,
              background: 'transparent',
              color: 'var(--muted)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            Back
          </button>
        </div>
        </div>
      </div>
    )
  }

  // If team is selected, show PIN entry
  if (selectedTeam) {
    const teamName = selectedTeam === 'home' ? homeTeamName : awayTeamName

    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 20px',
          background: 'rgba(15, 23, 42, 0.6)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '16px', fontWeight: 600 }}>Team Bench</span>
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
          </div>
        </div>

        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}>
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          padding: '40px',
          maxWidth: '400px',
          width: '100%',
          textAlign: 'center'
        }}>
          <img
            src={mikasaVolleyball}
            alt="Volleyball"
            style={{ width: '80px', height: '80px', marginBottom: '20px' }}
          />
          <h1 style={{
            fontSize: '24px',
            fontWeight: 700,
            marginBottom: '12px'
          }}>
            {teamName}
          </h1>
          <p style={{ 
            fontSize: '14px', 
            color: 'var(--muted)', 
            marginBottom: '32px' 
          }}>
            Enter the 6-digit team PIN to continue
          </p>

          <form onSubmit={handlePinSubmit} style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center'
          }}>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              maxLength={6}
              style={{
                width: '80%',
                maxWidth: '280px',
                padding: '16px',
                fontSize: '24px',
                fontWeight: 700,
                textAlign: 'center',
                letterSpacing: '8px',
                background: 'var(--bg)',
                border: error ? '2px solid #ef4444' : '2px solid rgba(255,255,255,0.2)',
                borderRadius: '8px',
                color: 'var(--text)',
                marginBottom: '16px'
              }}
            />
            
            {error && (
              <div style={{
                width: '100%',
                padding: '12px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid #ef4444',
                borderRadius: '6px',
                color: '#ef4444',
                fontSize: '14px',
                marginBottom: '16px',
                textAlign: 'center'
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              style={{
                width: '50%',
                maxWidth: '200px',
                padding: '16px',
                fontSize: '16px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                marginBottom: '16px'
              }}
            >
              Enter
            </button>
          </form>

          <button
            onClick={handleBack}
            style={{
              width: '50%',
              maxWidth: '200px',
              padding: '12px',
              fontSize: '14px',
              fontWeight: 500,
              background: 'transparent',
              color: 'var(--muted)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            Back
          </button>
        </div>
        </div>
      </div>
    )
  }

  // Initial team selection
  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 20px',
        background: 'rgba(15, 23, 42, 0.6)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '16px', fontWeight: 600 }}>Team Bench</span>
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
        </div>
      </div>

      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}>
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: '12px',
        padding: '40px',
        maxWidth: '500px',
        width: '100%',
        textAlign: 'center'
      }}>
        <img 
          src={mikasaVolleyball} 
          alt="Volleyball" 
          style={{ width: '80px', height: '80px', marginBottom: '20px' }} 
        />
        <h1 style={{ 
          fontSize: '24px', 
          fontWeight: 700, 
          marginBottom: '12px' 
        }}>
          Team Bench
        </h1>
        <p style={{ 
          fontSize: '14px', 
          color: 'var(--muted)', 
          marginBottom: '32px' 
        }}>
          Select your team
        </p>

        {availableMatches && availableMatches.length > 0 && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <button
              onClick={() => handleTeamSelect('home')}
              style={{
                width: '100%',
                padding: '20px',
                fontSize: '18px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'opacity 0.2s'
              }}
              onMouseOver={(e) => e.target.style.opacity = '0.9'}
              onMouseOut={(e) => e.target.style.opacity = '1'}
            >
              {homeTeamName}
            </button>

            <button
              onClick={() => handleTeamSelect('away')}
              style={{
                width: '100%',
                padding: '20px',
                fontSize: '18px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'opacity 0.2s'
              }}
              onMouseOver={(e) => e.target.style.opacity = '0.9'}
              onMouseOut={(e) => e.target.style.opacity = '1'}
            >
              {awayTeamName}
            </button>
          </div>
        )}

        {(!availableMatches || availableMatches.length === 0) && (
          <p style={{
            fontSize: '14px',
            color: 'var(--muted)'
          }}>
            No active matches available
          </p>
        )}
      </div>
      </div>
    </div>
  )
}

