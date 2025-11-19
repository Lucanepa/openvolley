import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import SignaturePad from './SignaturePad'
import mikasaVolleyball from '../mikasa_v200w.png'

export default function MatchEnd({ matchId, onShowScoresheet, onGoHome }) {
  const [openSignature, setOpenSignature] = useState(null) // 'home-captain', 'away-captain', 'ref1', 'ref2', 'scorer', 'asst-scorer'

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

    return {
      match,
      homeTeam,
      awayTeam,
      homePlayers,
      awayPlayers,
      sets
    }
  }, [matchId])

  if (!data) return null

  const { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets } = data

  // Calculate set scores
  const finishedSets = sets.filter(s => s.finished)
  const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
  const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length

  // Find captains
  const homeCaptain = homePlayers.find(p => p.captain)
  const awayCaptain = awayPlayers.find(p => p.captain)

  // Determine team labels (A or B)
  const teamAKey = match.coinTossTeamA || 'home'
  const homeLabel = teamAKey === 'home' ? 'A' : 'B'
  const awayLabel = teamAKey === 'away' ? 'A' : 'B'

  const handleSaveSignature = async (role, signatureData) => {
    if (role === 'home-captain') {
      await db.matches.update(matchId, { homeCaptainSignature: signatureData })
    } else if (role === 'away-captain') {
      await db.matches.update(matchId, { awayCaptainSignature: signatureData })
    } else if (role === 'ref1') {
      await db.matches.update(matchId, { ref1Signature: signatureData })
    } else if (role === 'ref2') {
      await db.matches.update(matchId, { ref2Signature: signatureData })
    } else if (role === 'scorer') {
      await db.matches.update(matchId, { scorerSignature: signatureData })
    } else if (role === 'asst-scorer') {
      await db.matches.update(matchId, { asstScorerSignature: signatureData })
    }
    setOpenSignature(null)
  }

  const getSignatureDisplayName = (role) => {
    if (role === 'home-captain') {
      return `${homeTeam?.name || 'Home'} Captain ${homeCaptain ? `(#${homeCaptain.number})` : ''}`
    } else if (role === 'away-captain') {
      return `${awayTeam?.name || 'Away'} Captain ${awayCaptain ? `(#${awayCaptain.number})` : ''}`
    } else if (role === 'ref1') {
      return '1st Referee'
    } else if (role === 'ref2') {
      return '2nd Referee'
    } else if (role === 'scorer') {
      return 'Scorer'
    } else if (role === 'asst-scorer') {
      return 'Assistant Scorer'
    }
    return ''
  }

  const getSignatureData = (role) => {
    if (role === 'home-captain') return match.homeCaptainSignature
    if (role === 'away-captain') return match.awayCaptainSignature
    if (role === 'ref1') return match.ref1Signature
    if (role === 'ref2') return match.ref2Signature
    if (role === 'scorer') return match.scorerSignature
    if (role === 'asst-scorer') return match.asstScorerSignature
    return null
  }

  const SignatureBox = ({ role, label }) => {
    const signatureData = getSignatureData(role)
    
    return (
      <div style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        gap: '8px',
        flex: 1
      }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>
          {label}
        </div>
        <div 
          onClick={() => setOpenSignature(role)}
          style={{
            border: '2px solid rgba(255,255,255,0.2)',
            borderRadius: '8px',
            background: 'var(--bg-secondary)',
            minHeight: '80px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {signatureData ? (
            <img 
              src={signatureData} 
              alt="Signature" 
              style={{ 
                maxWidth: '100%', 
                maxHeight: '100%',
                objectFit: 'contain'
              }} 
            />
          ) : (
            <div style={{ color: 'var(--muted)', fontSize: '14px' }}>
              Tap to sign
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      padding: '20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '24px',
        paddingBottom: '16px',
        borderBottom: '2px solid rgba(255,255,255,0.1)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img src={mikasaVolleyball} alt="Volleyball" style={{ width: '40px', height: '40px' }} />
          <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700 }}>Match Complete</h1>
        </div>
        <button
          onClick={onGoHome}
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
          Home
        </button>
      </div>

      {/* Match Result */}
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: '12px',
        padding: '24px',
        marginBottom: '24px'
      }}>
        <h2 style={{ 
          fontSize: '20px', 
          fontWeight: 700, 
          marginBottom: '20px',
          textAlign: 'center'
        }}>
          Final Result
        </h2>
        
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-around', 
          alignItems: 'center',
          marginBottom: '24px'
        }}>
          {/* Home Team */}
          <div style={{ textAlign: 'center', flex: 1 }}>
            <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
              Team {homeLabel}
            </div>
            <div style={{ fontSize: '14px', color: 'var(--muted)', marginBottom: '12px' }}>
              {homeTeam?.name || 'Home'}
            </div>
            <div style={{ 
              fontSize: '48px', 
              fontWeight: 700,
              color: homeSetsWon > awaySetsWon ? 'var(--accent)' : 'var(--text)'
            }}>
              {homeSetsWon}
            </div>
          </div>

          {/* VS */}
          <div style={{ 
            fontSize: '24px', 
            fontWeight: 700, 
            color: 'var(--muted)',
            padding: '0 20px'
          }}>
            -
          </div>

          {/* Away Team */}
          <div style={{ textAlign: 'center', flex: 1 }}>
            <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
              Team {awayLabel}
            </div>
            <div style={{ fontSize: '14px', color: 'var(--muted)', marginBottom: '12px' }}>
              {awayTeam?.name || 'Away'}
            </div>
            <div style={{ 
              fontSize: '48px', 
              fontWeight: 700,
              color: awaySetsWon > homeSetsWon ? 'var(--accent)' : 'var(--text)'
            }}>
              {awaySetsWon}
            </div>
          </div>
        </div>

        {/* Set-by-Set Breakdown */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          marginTop: '24px',
          paddingTop: '24px',
          borderTop: '1px solid rgba(255,255,255,0.1)'
        }}>
          <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>
            Set Breakdown
          </div>
          {finishedSets.map((set, idx) => (
            <div key={set.id} style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '8px 12px',
              background: 'rgba(255,255,255,0.05)',
              borderRadius: '6px'
            }}>
              <span>Set {idx + 1}</span>
              <span style={{ fontWeight: 600 }}>
                {set.homePoints} - {set.awayPoints}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Signatures Section */}
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: '12px',
        padding: '24px',
        marginBottom: '24px'
      }}>
        <h2 style={{ 
          fontSize: '20px', 
          fontWeight: 700, 
          marginBottom: '20px'
        }}>
          Signatures
        </h2>

        {/* Captain Signatures */}
        <div style={{ marginBottom: '20px' }}>
          <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px', color: 'var(--muted)' }}>
            Captains
          </div>
          <div style={{ display: 'flex', gap: '16px' }}>
            <SignatureBox 
              role="home-captain" 
              label={`Team ${homeLabel} Captain`} 
            />
            <SignatureBox 
              role="away-captain" 
              label={`Team ${awayLabel} Captain`} 
            />
          </div>
        </div>

        {/* Officials Signatures */}
        <div>
          <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px', color: 'var(--muted)' }}>
            Officials
          </div>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '16px',
            marginBottom: '16px'
          }}>
            <SignatureBox role="ref1" label="1st Referee" />
            <SignatureBox role="ref2" label="2nd Referee" />
          </div>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '16px'
          }}>
            <SignatureBox role="scorer" label="Scorer" />
            <SignatureBox role="asst-scorer" label="Assistant Scorer" />
          </div>
        </div>
      </div>

      {/* Action Button */}
      <button
        onClick={async () => {
          try {
            // Gather all match data needed for the scoresheet
            const allSets = await db.sets.where('matchId').equals(matchId).sortBy('index');
            const allEvents = await db.events.where('matchId').equals(matchId).sortBy('seq');
            
            // Create a data package to pass to the scoresheet
            const scoresheetData = {
              match,
              homeTeam,
              awayTeam,
              homePlayers,
              awayPlayers,
              sets: allSets,
              events: allEvents,
              sanctions: [] // TODO: Extract sanctions from events
            };
            
            // Store data in sessionStorage to pass to new window
            sessionStorage.setItem('scoresheetData', JSON.stringify(scoresheetData));
            
            // Open scoresheet in new window
            const scoresheetWindow = window.open('/scoresheet_pdf/index_scoresheet.html', '_blank', 'width=1200,height=900');
            
            if (!scoresheetWindow) {
              alert('Please allow popups to view the scoresheet');
            }
          } catch (error) {
            console.error('Error opening scoresheet:', error);
            alert('Error opening scoresheet: ' + error.message);
          }
        }}
        style={{
          width: '100%',
          padding: '16px',
          fontSize: '16px',
          fontWeight: 600,
          background: 'var(--accent)',
          color: '#000',
          border: 'none',
          borderRadius: '8px',
          cursor: 'pointer',
          marginBottom: '20px'
        }}
      >
        Show Scoresheet
      </button>

      {/* Signature Modal */}
      {openSignature && (
        <SignaturePad
          title={getSignatureDisplayName(openSignature)}
          onSave={(signatureData) => handleSaveSignature(openSignature, signatureData)}
          onClose={() => setOpenSignature(null)}
        />
      )}
    </div>
  )
}

