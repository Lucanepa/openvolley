import { useState, useEffect } from 'react'
import { validatePin, listAvailableMatches } from './utils/serverDataSync'
import Referee from './components/Referee'
import Modal from './components/Modal'
import refereeIcon from './ref.png'
export default function RefereeApp() {
  const [pinInput, setPinInput] = useState('')
  const [matchId, setMatchId] = useState(null)
  const [error, setError] = useState('')
  const [match, setMatch] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [availableMatches, setAvailableMatches] = useState([])
  const [selectedGameNumber, setSelectedGameNumber] = useState('')
  const [loadingMatches, setLoadingMatches] = useState(false)
  const [showGameModal, setShowGameModal] = useState(false)

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
    const interval = setInterval(loadMatches, 5000) // Refresh every 5 seconds
    
    return () => clearInterval(interval)
  }, [])

  // Auto-connect on mount if we have stored credentials
  useEffect(() => {
    const storedMatchId = localStorage.getItem('refereeMatchId')
    const storedPin = localStorage.getItem('refereePin')
    
    if (storedMatchId && storedPin) {
      // Validate stored PIN with server
      validatePin(storedPin, 'referee')
        .then(result => {
          if (result.success && result.match && String(result.match.id) === String(storedMatchId)) {
            setMatchId(Number(storedMatchId))
            setMatch(result.match)
            setPinInput(storedPin)
          } else {
            // Clear invalid stored credentials
            localStorage.removeItem('refereeMatchId')
            localStorage.removeItem('refereePin')
          }
        })
        .catch(() => {
          // Clear invalid stored credentials
          localStorage.removeItem('refereeMatchId')
          localStorage.removeItem('refereePin')
        })
    }
  }, [])
  
  const handleSelectGame = (gameNumber) => {
    setSelectedGameNumber(gameNumber)
    // DO NOT auto-fill PIN - it's a security check that must be entered manually
    setShowGameModal(false)
  }

  // Monitor match connection status
  useEffect(() => {
    if (match && match.refereeConnectionEnabled === false) {
      setMatchId(null)
      setMatch(null)
      setPinInput('')
      localStorage.removeItem('refereeMatchId')
      localStorage.removeItem('refereePin')
      setError('Connection has been disabled. Please enable the connection in the scoreboard and reconnect.')
    }
  }, [match])

  const handlePinSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    if (!pinInput || pinInput.length !== 6) {
      setError('Please enter a 6-digit PIN code')
      setIsLoading(false)
      return
    }

    try {
      // Validate PIN with server (no local IndexedDB)
      const result = await validatePin(pinInput.trim(), 'referee')
      
      if (result.success && result.match) {
        setMatchId(result.match.id)
        setMatch(result.match)
        // Store matchId and PIN in localStorage for persistence
        localStorage.setItem('refereeMatchId', String(result.match.id))
        localStorage.setItem('refereePin', pinInput)
      } else {
        setError('Invalid PIN code. Please check and try again.')
        setPinInput('')
        localStorage.removeItem('refereeMatchId')
        localStorage.removeItem('refereePin')
      }
    } catch (err) {
      console.error('Error validating PIN:', err)
      setError(err.message || 'Failed to validate PIN. Make sure the main scoresheet is running and connected.')
      setPinInput('')
      localStorage.removeItem('refereeMatchId')
      localStorage.removeItem('refereePin')
    } finally {
      setIsLoading(false)
    }
  }

  const handleExit = () => {
    setMatchId(null)
    setPinInput('')
    // Optionally clear stored credentials on manual exit
    // localStorage.removeItem('refereeMatchId')
    // localStorage.removeItem('refereePin')
  }

  // Monitor match status - clear credentials if match becomes final
  useEffect(() => {
    if (match && match.status === 'final') {
      localStorage.removeItem('refereeMatchId')
      localStorage.removeItem('refereePin')
      setMatchId(null)
      setMatch(null)
      setPinInput('')
      setError('Match has ended.')
    }
  }, [match])

  if (matchId) {
    return <Referee matchId={matchId} onExit={handleExit} />
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg,rgb(82, 82, 113) 0%,rgb(62, 22, 27) 100%)',
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
          src={refereeIcon} 
          alt="Referee Icon" 
          style={{ width: 'auto', height: 'auto', marginBottom: '20px' }} 
        />
        <h1 style={{ 
          fontSize: '24px', 
          fontWeight: 700, 
          marginBottom: '12px' 
        }}>
          Referee <br />
          Dashboard
        </h1>

        <form onSubmit={handlePinSubmit} style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '16px',
          width: '100%'
        }}>
          {availableMatches.length > 0 && (
            <div style={{ width: '80%', maxWidth: '280px' }}>
              <label style={{
                display: 'block',
                fontSize: '12px',
                color: 'var(--muted)',
                marginBottom: '8px',
                fontWeight: 600
              }}>
                Select game {availableMatches.length > 0 && `(${availableMatches.length} available)`}
              </label>
              <button
                type="button"
                onClick={() => setShowGameModal(true)}
                disabled={isLoading}
                style={{
                  width: '100%',
                  padding: '12px',
                  fontSize: '16px',
                  background: 'var(--bg)',
                  border: '2px solid rgba(255,255,255,0.2)',
                  borderRadius: '8px',
                  color: 'var(--text)',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  opacity: isLoading ? 0.6 : 1,
                  fontWeight: 600
                }}
              >
                Select game
              </button>
              
              {selectedGameNumber && (() => {
                const selected = availableMatches.find(m => String(m.gameNumber) === String(selectedGameNumber))
                if (!selected) return null
                
                return (
                  <div style={{
                    marginTop: '12px',
                    padding: '12px',
                    background: 'rgba(59, 246, 78, 0.1)',
                    border: '1px solid rgba(59, 130, 246, 0.3)',
                    borderRadius: '8px',
                    textAlign: 'left'
                  }}>
                    <div style={{
                      fontSize: '16px',
                      fontWeight: 600,
                      marginBottom: '6px',
                      color: 'var(--text)'
                    }}>
                      Game #{selected.gameNumber}
                    </div>
                    <div style={{
                      fontSize: '14px',
                      color: 'var(--text)',
                      marginBottom: '4px'
                    }}>
                      {selected.homeTeam} <span style={{ color: 'var(--muted)', margin: '0 4px' }}>vs</span> {selected.awayTeam}
                    </div>
                    <div style={{
                      fontSize: '12px',
                      color: 'var(--muted)'
                    }}>
                      {selected.dateTime || 'TBD'}
                    </div>
                  </div>
                )
              })()}
            </div>
          )}
          
          <div style={{ width: '80%', maxWidth: '280px' }}>
            <label style={{
              display: 'block',
              fontSize: '12px',
              color: 'var(--muted)',
              marginBottom: '8px',
              fontWeight: 600
            }}>
              Connection PIN
            </label>
            <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ''))}
            placeholder="000000"
            maxLength={6}
            disabled={isLoading}
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
              opacity: isLoading ? 0.6 : 1,
              cursor: isLoading ? 'not-allowed' : 'text'
            }}
          />
          </div>
          
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
            disabled={isLoading}
            style={{
              width: '50%',
              maxWidth: '200px',
              padding: '16px',
              fontSize: '16px',
              fontWeight: 600,
              background: isLoading ? 'rgba(255,255,255,0.3)' : 'var(--accent)',
              color: isLoading ? '#fff' : '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.7 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px'
            }}
          >
            {isLoading ? (
              <>
                <span style={{
                  display: 'inline-block',
                  width: '16px',
                  height: '16px',
                  border: '2px solid rgba(255,255,255,0.3)',
                  borderTopColor: '#fff',
                  borderRadius: '50%',
                  animation: 'spin 0.6s linear infinite'
                }}></span>
                Connecting...
              </>
            ) : (
              'Enter'
            )}
          </button>
        </form>
      </div>
      
      <Modal
        title="Select Game"
        open={showGameModal}
        onClose={() => setShowGameModal(false)}
        width={600}
      >
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          maxHeight: '70vh',
          overflowY: 'auto'
        }}>
          {loadingMatches ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
              Loading games...
            </div>
          ) : availableMatches.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
              No available games. Make sure the main scoresheet is running and has an active match with referee connection enabled.
            </div>
          ) : (
            availableMatches.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => handleSelectGame(m.gameNumber)}
                style={{
                  width: '100%',
                  padding: '16px',
                  background: selectedGameNumber === String(m.gameNumber) 
                    ? 'rgba(59, 130, 246, 0.2)' 
                    : 'rgba(255, 255, 255, 0.05)',
                  border: selectedGameNumber === String(m.gameNumber)
                    ? '2px solid rgba(59, 130, 246, 0.5)'
                    : '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '8px',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.2s',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px'
                }}
                onMouseEnter={(e) => {
                  if (selectedGameNumber !== String(m.gameNumber)) {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedGameNumber !== String(m.gameNumber)) {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                  }
                }}
              >
                <div style={{
                  fontSize: '18px',
                  fontWeight: 600,
                  marginBottom: '4px'
                }}>
                  Game #{m.gameNumber}
                </div>
                <div style={{
                  fontSize: '16px',
                  color: 'var(--text)',
                  marginBottom: '4px'
                }}>
                  {m.homeTeam} <span style={{ color: 'var(--muted)', margin: '0 8px' }}>vs</span> {m.awayTeam}
                </div>
                <div style={{
                  fontSize: '14px',
                  color: 'var(--muted)'
                }}>
                  {m.dateTime || 'TBD'}
                </div>
              </button>
            ))
          )}
        </div>
      </Modal>
      
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}

