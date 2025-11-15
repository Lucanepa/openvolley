import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import Referee from './components/Referee'
import mikasaVolleyball from './mikasa_v200w.png'

export default function RefereeApp() {
  const [pinInput, setPinInput] = useState('')
  const [matchId, setMatchId] = useState(null)
  const [error, setError] = useState('')

  // Get all non-final matches
  const availableMatches = useLiveQuery(async () => {
    const matches = await db.matches
      .filter(m => m.status !== 'final')
      .toArray()
    return matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }, [])

  const handlePinSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!pinInput || pinInput.length !== 6) {
      setError('Please enter a 6-digit PIN code')
      return
    }

    // Find match with matching PIN
    const match = availableMatches?.find(m => m.refereePin === pinInput)

    if (match) {
      setMatchId(match.id)
    } else {
      setError('Invalid PIN code. Please check and try again.')
      setPinInput('')
    }
  }

  if (matchId) {
    return <Referee matchId={matchId} onExit={() => setMatchId(null)} />
  }

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
          Referee View
        </h1>
        <p style={{ 
          fontSize: '14px', 
          color: 'var(--muted)', 
          marginBottom: '32px' 
        }}>
          Enter the 6-digit match PIN to access the referee view
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
              cursor: 'pointer'
            }}
          >
            Enter
          </button>
        </form>

        {availableMatches && availableMatches.length > 0 && (
          <div style={{ 
            marginTop: '32px', 
            paddingTop: '32px', 
            borderTop: '1px solid rgba(255,255,255,0.1)'
          }}>
            <p style={{ 
              fontSize: '12px', 
              color: 'var(--muted)', 
              marginBottom: '12px' 
            }}>
              Active Matches: {availableMatches.length}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

