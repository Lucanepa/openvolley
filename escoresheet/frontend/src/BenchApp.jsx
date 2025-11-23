import { useState, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import RosterSetup from './components/RosterSetup'
import MatchEntry from './components/MatchEntry'
import mikasaVolleyball from './mikasa_v200w.png'

export default function BenchApp() {
  const [selectedTeam, setSelectedTeam] = useState(null) // 'home' or 'away'
  const [pinInput, setPinInput] = useState('')
  const [matchId, setMatchId] = useState(null)
  const [error, setError] = useState('')
  const [view, setView] = useState(null) // 'roster' or 'match'

  // Get all non-final matches
  const availableMatches = useLiveQuery(async () => {
    const matches = await db.matches
      .filter(m => m.status !== 'final')
      .toArray()
    return matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }, [])

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

    // Find match with matching team PIN
    const match = availableMatches?.find(m => {
      const pinField = selectedTeam === 'home' ? 'homeTeamPin' : 'awayTeamPin'
      return m[pinField] === pinInput
    })

    if (match) {
      setMatchId(match.id)
    } else {
      setError('Invalid PIN code. Please check and try again.')
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

  // Get team names
  const [homeTeamName, setHomeTeamName] = useState('Home Team')
  const [awayTeamName, setAwayTeamName] = useState('Away Team')

  useEffect(() => {
    if (availableMatches && availableMatches.length > 0) {
      const match = availableMatches[0]
      if (match.homeTeamId) {
        db.teams.get(match.homeTeamId).then(team => {
          if (team) setHomeTeamName(team.name)
        })
      }
      if (match.awayTeamId) {
        db.teams.get(match.awayTeamId).then(team => {
          if (team) setAwayTeamName(team.name)
        })
      }
    }
  }, [availableMatches])

  // If PIN is correct, show view selection
  if (matchId) {

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
    )
  }

  // Initial team selection
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
  )
}

