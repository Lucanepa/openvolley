import { useState, useMemo, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import SignaturePad from './SignaturePad'
import mikasaVolleyball from '../mikasa_v200w.png'
import { Results, Sanctions, Remarks } from '../../scoresheet_pdf/components/FooterSection'
import jsPDF from 'jspdf'
import { generateScoresheetPDF } from '../utils/generateScoresheetPDF'

export default function MatchEnd({ matchId, onShowScoresheet, onGoHome }) {
  const [openSignature, setOpenSignature] = useState(null) // 'home-captain', 'away-captain', 'ref1', 'ref2', 'scorer', 'asst-scorer'
  const [isApproved, setIsApproved] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const scoresheetIframeRef = useRef(null)

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

    const events = await db.events
      .where('matchId')
      .equals(matchId)
      .sortBy('seq')

    return {
      match,
      homeTeam,
      awayTeam,
      homePlayers,
      awayPlayers,
      sets,
      events
    }
  }, [matchId])

  if (!data) return null

  const { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events } = data

  // Calculate set scores
  const finishedSets = sets.filter(s => s.finished)
  const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
  const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length

  // Find captains
  const homeCaptain = homePlayers.find(p => p.captain)
  const awayCaptain = awayPlayers.find(p => p.captain)

  // Determine team labels (A or B)
  const teamAKey = match.coinTossTeamA || 'home'
  const teamBKey = teamAKey === 'home' ? 'away' : 'home'
  const homeLabel = teamAKey === 'home' ? 'A' : 'B'
  const awayLabel = teamAKey === 'away' ? 'A' : 'B'

  // Calculate set results for Results component
  const calculateSetResults = useMemo(() => {
    const results = []
    for (let setNum = 1; setNum <= 5; setNum++) {
      const setInfo = sets.find(s => s.index === setNum)
      const setEvents = events?.filter(e => e.setIndex === setNum) || []
      
      const isSetFinished = setInfo?.finished === true
      
      const teamAPoints = isSetFinished
        ? (teamAKey === 'home' ? (setInfo?.homePoints || 0) : (setInfo?.awayPoints || 0))
        : null
      const teamBPoints = isSetFinished
        ? (teamBKey === 'home' ? (setInfo?.homePoints || 0) : (setInfo?.awayPoints || 0))
        : null
      
      const teamATimeouts = isSetFinished
        ? setEvents.filter(e => e.type === 'timeout' && e.payload?.team === teamAKey).length
        : null
      const teamBTimeouts = isSetFinished
        ? setEvents.filter(e => e.type === 'timeout' && e.payload?.team === teamBKey).length
        : null
      
      const teamASubstitutions = isSetFinished
        ? setEvents.filter(e => e.type === 'substitution' && e.payload?.team === teamAKey).length
        : null
      const teamBSubstitutions = isSetFinished
        ? setEvents.filter(e => e.type === 'substitution' && e.payload?.team === teamBKey).length
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
  }, [sets, events, teamAKey, teamBKey, match])

  // Calculate match-level results
  const isMatchFinished = homeSetsWon === 3 || awaySetsWon === 3
  const matchStart = match?.scheduledAt 
    ? new Date(match.scheduledAt).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    : ''
  const matchEndFinal = isMatchFinished && finishedSets.length > 0
    ? new Date(finishedSets[finishedSets.length - 1].endTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    : ''
  const matchDuration = isMatchFinished
    ? (() => {
        const totalMinutes = calculateSetResults.reduce((sum, r) => {
          if (!r.duration) return sum
          const match = r.duration.match(/(\d+)'/)
          return sum + (match ? parseInt(match[1], 10) : 0)
        }, 0)
        return totalMinutes > 0 ? `${totalMinutes}'` : ''
      })()
    : ''
  const winner = isMatchFinished
    ? (homeSetsWon > awaySetsWon ? (homeTeam?.name || 'Home') : (awayTeam?.name || 'Away'))
    : ''
  const result = isMatchFinished
    ? `3:${Math.min(homeSetsWon, awaySetsWon)}`
    : ''

  // Process sanctions
  const { sanctions: processedSanctions, improperRequests } = useMemo(() => {
    const sanctionRecords = []
    const improperRequests = { teamA: false, teamB: false }
    
    if (!events) return { sanctions: sanctionRecords, improperRequests }
    
    const sanctionEvents = events
      .filter(e => e.type === 'sanction')
      .sort((a, b) => {
        const aSeq = a.seq || 0
        const bSeq = b.seq || 0
        if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq
        return new Date(a.ts).getTime() - new Date(b.ts).getTime()
      })
    
    const getScoreAtEvent = (eventTimestamp, setIndex) => {
      const pointEvents = events
        .filter(e => 
          e.setIndex === setIndex && 
          e.type === 'point' &&
          new Date(e.ts).getTime() <= eventTimestamp.getTime()
        )
        .sort((a, b) => {
          const aSeq = a.seq || 0
          const bSeq = b.seq || 0
          if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq
          return new Date(a.ts).getTime() - new Date(b.ts).getTime()
        })
      
      let homeScore = 0
      let awayScore = 0
      
      for (const e of pointEvents) {
        if (e.payload?.team === 'home') homeScore++
        else if (e.payload?.team === 'away') awayScore++
      }
      
      const teamAScore = teamAKey === 'home' ? homeScore : awayScore
      const teamBScore = teamBKey === 'home' ? homeScore : awayScore
      
      return `${teamAScore}:${teamBScore}`
    }
    
    for (const event of sanctionEvents) {
      const payload = event.payload || {}
      const sanctionType = payload.type
      const eventTeam = payload.team
      const setIndex = event.setIndex
      
      const teamLabel = (eventTeam === teamAKey) ? 'A' : 'B'
      
      const eventTimestamp = new Date(event.ts)
      const rawScore = getScoreAtEvent(eventTimestamp, setIndex)
      
      const [teamAScoreStr, teamBScoreStr] = rawScore.split(':')
      const sanctionedTeamScore = teamLabel === 'A' ? teamAScoreStr : teamBScoreStr
      const otherTeamScore = teamLabel === 'A' ? teamBScoreStr : teamAScoreStr
      const score = `${sanctionedTeamScore}:${otherTeamScore}`
      
      if (sanctionType === 'improper_request') {
        if (teamLabel === 'A') improperRequests.teamA = true
        else improperRequests.teamB = true
        continue
      }
      
      if (sanctionType === 'delay_warning' || sanctionType === 'delay_penalty') {
        sanctionRecords.push({
          team: teamLabel,
          playerNr: 'D',
          type: sanctionType === 'delay_warning' ? 'warning' : 'penalty',
          set: setIndex,
          score: score
        })
        continue
      }
      
      if (['warning', 'penalty', 'expulsion', 'disqualification'].includes(sanctionType)) {
        let playerNr = ''
        
        if (payload.playerNumber) {
          playerNr = String(payload.playerNumber)
        } else if (payload.role) {
          const roleMap = {
            'Coach': 'C',
            'Assistant Coach 1': 'AC1',
            'Assistant Coach 2': 'AC2',
            'Physiotherapist': 'P',
            'Medic': 'M'
          }
          playerNr = roleMap[payload.role] || payload.role.charAt(0).toUpperCase()
        } else if (payload.playerType === 'official') {
          playerNr = 'C'
        }
        
        if (playerNr) {
          sanctionRecords.push({
            team: teamLabel,
            playerNr: playerNr,
            type: sanctionType,
            set: setIndex,
            score: score
          })
        }
      }
    }
    
    return { sanctions: sanctionRecords, improperRequests }
  }, [events, teamAKey, teamBKey])

  // Split sanctions into those that fit in the box (first 10) and overflow
  const sanctionsInBox = processedSanctions.slice(0, 10)
  const overflowSanctions = processedSanctions.slice(10)

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
          <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px' }}>
            Results
          </div>
          <div style={{ 
            background: 'white', 
            borderRadius: '8px', 
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.2)',
            minHeight: '300px'
          }}>
            <Results
              teamAShortName={homeLabel === 'A' ? (homeTeam?.shortName || homeTeam?.name || '') : (awayTeam?.shortName || awayTeam?.name || '')}
              teamBShortName={awayLabel === 'B' ? (awayTeam?.shortName || awayTeam?.name || '') : (homeTeam?.shortName || homeTeam?.name || '')}
              setResults={calculateSetResults}
              matchStart={matchStart}
              matchEnd={matchEndFinal}
              matchDuration={matchDuration}
              winner={winner}
              result={result}
            />
          </div>

          <div style={{ fontSize: '16px', fontWeight: 600, margin: '24px 0 12px 0' }}>
            Sanctions
          </div>
          <div style={{ 
            background: 'white', 
            borderRadius: '8px', 
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.2)',
            minHeight: '200px'
          }}>
            <Sanctions
              items={sanctionsInBox}
              improperRequests={improperRequests}
            />
          </div>

          <div style={{ fontSize: '16px', fontWeight: 600, margin: '24px 0 12px 0' }}>
            Remarks
          </div>
          <div style={{ 
            background: 'white', 
            borderRadius: '8px', 
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.2)',
            minHeight: '150px'
          }}>
            <Remarks overflowSanctions={overflowSanctions} />
          </div>
        </div>
      </div>

      {/* Approval Section */}
      {!isApproved && (
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
            Approval
          </h2>
          
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '16px',
            marginBottom: '24px'
          }}>
            <SignatureBox 
              role="home-captain" 
              label={`${homeTeam?.name || 'Home'} Captain ${homeCaptain ? `(#${homeCaptain.number})` : ''}`}
            />
            <SignatureBox 
              role="away-captain" 
              label={`${awayTeam?.name || 'Away'} Captain ${awayCaptain ? `(#${awayCaptain.number})` : ''}`}
            />
            {match.asstScorerSignature !== undefined && (
              <SignatureBox role="asst-scorer" label="ASS SCORER" />
            )}
            <SignatureBox role="scorer" label="SCORER" />
            {match.ref2Signature !== undefined && (
              <SignatureBox role="ref2" label="2nd REF" />
            )}
            <SignatureBox role="ref1" label="1st REF" />
          </div>

          <button
            onClick={async () => {
              setIsSaving(true)
              try {
                // Check if all required signatures are present
                const requiredSignatures = [
                  match.homeCaptainSignature,
                  match.awayCaptainSignature,
                  match.scorerSignature,
                  match.ref1Signature
                ]
                
                const hasAllRequired = requiredSignatures.every(sig => sig !== null && sig !== undefined)
                
                if (!hasAllRequired) {
                  alert('Please sign all required fields before approving.')
                  setIsSaving(false)
                  return
                }

                // Save to Supabase if official match
                if (!match.test) {
                  await db.sync_queue.add({
                    resource: 'match',
                    action: 'update',
                    payload: {
                      id: String(matchId),
                      status: 'final',
                      approved: true,
                      approvedAt: new Date().toISOString()
                    },
                    ts: new Date().toISOString(),
                    status: 'queued'
                  })
                }

                // Gather all match data
                const allSets = await db.sets.where('matchId').equals(matchId).sortBy('index')
                const allEvents = await db.events.where('matchId').equals(matchId).sortBy('seq')
                const allReferees = await db.referees.toArray()
                const allScorers = await db.scorers.toArray()

                // Prepare scoresheet data
                const scoresheetData = {
                  match,
                  homeTeam,
                  awayTeam,
                  homePlayers,
                  awayPlayers,
                  sets: allSets,
                  events: allEvents
                }
                
                // Store in sessionStorage for scoresheet page
                sessionStorage.setItem('scoresheetData', JSON.stringify(scoresheetData))
                
                // Open scoresheet in new window to use existing save PDF logic
                const scoresheetWindow = window.open('/scoresheet.html', '_blank', 'width=1600,height=1200')
                
                if (!scoresheetWindow) {
                  throw new Error('Could not open scoresheet window. Please allow popups.')
                }

                // Wait for window to load and React to render
                await new Promise((resolve, reject) => {
                  const checkLoaded = setInterval(() => {
                    try {
                      if (scoresheetWindow.closed) {
                        clearInterval(checkLoaded)
                        reject(new Error('Scoresheet window was closed'))
                        return
                      }
                      if (scoresheetWindow.document.readyState === 'complete') {
                        // Check if React has rendered by looking for the container
                        const root = scoresheetWindow.document.querySelector('#root')
                        if (root && root.children.length > 0) {
                          clearInterval(checkLoaded)
                          // Wait a bit more for full rendering
                          setTimeout(resolve, 2000)
                        }
                      }
                    } catch (e) {
                      // Cross-origin - wait a bit and try
                      setTimeout(() => {
                        clearInterval(checkLoaded)
                        resolve()
                      }, 5000)
                    }
                  }, 100)
                  
                  // Timeout after 10 seconds
                  setTimeout(() => {
                    clearInterval(checkLoaded)
                    resolve()
                  }, 10000)
                })

                // Use the existing captureScreenshot function from the scoresheet page
                try {
                  // Find and click the Save button which triggers the existing captureScreenshot function
                  const saveButton = Array.from(scoresheetWindow.document.querySelectorAll('button')).find(
                    btn => btn.textContent?.trim() === 'Save' || btn.textContent?.includes('Save')
                  )
                  
                  if (saveButton) {
                    // Click the Save button to trigger the existing captureScreenshot function
                    // This will use the Screen Capture API and save as PDF
                    saveButton.click()
                    // Wait for the PDF download to be triggered
                    await new Promise(resolve => setTimeout(resolve, 3000))
                  } else {
                    // Fallback: use generateScoresheetPDF if Save button not found
                    await generateScoresheetPDF({
                      match,
                      homeTeam,
                      awayTeam,
                      homePlayers,
                      awayPlayers,
                      sets: allSets,
                      events: allEvents,
                      referees: allReferees,
                      scorers: allScorers
                    })
                  }
                  
                  // Also save as JPG using html2canvas
                  try {
                    const html2canvas = (await import('html2canvas')).default
                    const scoresheetDoc = scoresheetWindow.document
                    const scoresheetElement = scoresheetDoc.querySelector('#root') || scoresheetDoc.body
                    
                    const canvas = await html2canvas(scoresheetElement, {
                      scale: 2,
                      useCORS: true,
                      logging: false,
                      backgroundColor: '#ffffff'
                    })

                    // Save as JPG
                    const jpgDataUrl = canvas.toDataURL('image/jpeg', 0.95)
                    const jpgLink = document.createElement('a')
                    const matchDate = match.scheduledAt 
                      ? new Date(match.scheduledAt).toLocaleDateString('en-GB').replace(/\//g, '-')
                      : new Date().toLocaleDateString('en-GB').replace(/\//g, '-')
                    const matchNum = match?.gameNumber || match?.externalId || match?.game_n?.toString() || 'match'
                    const homeShort = match?.homeShortName || homeTeam?.name || 'Home'
                    const awayShort = match?.awayShortName || awayTeam?.name || 'Away'
                    const sanitize = (str) => str.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20)
                    const date = match.scheduledAt 
                      ? new Date(match.scheduledAt).toISOString().slice(0, 10).replace(/-/g, '')
                      : new Date().toISOString().slice(0, 10).replace(/-/g, '')
                    const filename = `${matchNum}_${sanitize(homeShort)}_${sanitize(awayShort)}_${date}.jpg`
                    jpgLink.download = filename
                    jpgLink.href = jpgDataUrl
                    jpgLink.click()
                  } catch (jpgError) {
                    console.warn('Could not save JPG screenshot:', jpgError)
                    // Continue - PDF was saved using existing function
                  }

                  // Close the scoresheet window after a delay to allow downloads
                  setTimeout(() => {
                    if (!scoresheetWindow.closed) {
                      scoresheetWindow.close()
                    }
                  }, 2000)
                } catch (screenshotError) {
                  console.error('Error using scoresheet save function:', screenshotError)
                  // Fallback to generateScoresheetPDF
                  await generateScoresheetPDF({
                    match,
                    homeTeam,
                    awayTeam,
                    homePlayers,
                    awayPlayers,
                    sets: allSets,
                    events: allEvents,
                    referees: allReferees,
                    scorers: allScorers
                  })
                  if (scoresheetWindow && !scoresheetWindow.closed) {
                    scoresheetWindow.close()
                  }
                }

                // Save database data in readable format
                const exportData = {
                  match: {
                    ...match,
                    homeTeam,
                    awayTeam
                  },
                  homePlayers,
                  awayPlayers,
                  sets: allSets,
                  events: allEvents,
                  exportedAt: new Date().toISOString()
                }

                const dataStr = JSON.stringify(exportData, null, 2)
                const dataBlob = new Blob([dataStr], { type: 'application/json' })
                const dataLink = document.createElement('a')
                const dataFilename = `MatchData_${(homeTeam?.name || 'Home').replace(/[^a-zA-Z0-9]/g, '_')}_vs_${(awayTeam?.name || 'Away').replace(/[^a-zA-Z0-9]/g, '_')}_${matchDate}.json`
                dataLink.download = dataFilename
                dataLink.href = URL.createObjectURL(dataBlob)
                dataLink.click()

                // Mark as approved
                await db.matches.update(matchId, { approved: true, approvedAt: new Date().toISOString() })
                setIsApproved(true)
              } catch (error) {
                console.error('Error approving match:', error)
                alert('Error approving match: ' + error.message)
              } finally {
                setIsSaving(false)
              }
            }}
            disabled={isSaving}
            style={{
              width: '100%',
              padding: '16px',
              fontSize: '16px',
              fontWeight: 600,
              background: isSaving ? 'rgba(255,255,255,0.3)' : 'var(--accent)',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: isSaving ? 'not-allowed' : 'pointer',
              opacity: isSaving ? 0.6 : 1
            }}
          >
            {isSaving ? 'Saving...' : 'Confirm and Approve'}
          </button>
        </div>
      )}

      {/* Done Button - shown after approval */}
      {isApproved && (
        <button
          onClick={onGoHome}
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
          Done
        </button>
      )}

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

