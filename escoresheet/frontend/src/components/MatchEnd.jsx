import { useState, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import SignaturePad from './SignaturePad'
import mikasaVolleyball from '../mikasa_v200w.png'
import { Results, Sanctions, Remarks } from '../../scoresheet_pdf/components/FooterSection'

export default function MatchEnd({ matchId, onShowScoresheet, onGoHome }) {
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

  const [openSignature, setOpenSignature] = useState(null)
  const [isApproved, setIsApproved] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  // Calculate set results for Results component - must be before early return to maintain hook order
  const calculateSetResults = useMemo(() => {
    if (!data) return []

    const { match, sets, events } = data
    const teamAKey = match?.coinTossTeamA || 'home'
    const teamBKey = teamAKey === 'home' ? 'away' : 'home'

    const results = []
    for (let setNum = 1; setNum <= 5; setNum++) {
      const setInfo = sets?.find(s => s.index === setNum)
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
  }, [data])

  // Process sanctions - must be before early return
  const { sanctions: processedSanctions, improperRequests } = useMemo(() => {
    if (!data) return { sanctions: [], improperRequests: { teamA: false, teamB: false } }

    const { match, events } = data
    const teamAKey = match?.coinTossTeamA || 'home'
    const teamBKey = teamAKey === 'home' ? 'away' : 'home'

    const sanctionRecords = []
    const improperReqs = { teamA: false, teamB: false }

    if (!events) return { sanctions: sanctionRecords, improperRequests: improperReqs }

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
        if (teamLabel === 'A') improperReqs.teamA = true
        else improperReqs.teamB = true
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

    return { sanctions: sanctionRecords, improperRequests: improperReqs }
  }, [data])

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
  const homeLabel = teamAKey === 'home' ? 'A' : 'B'
  const awayLabel = teamAKey === 'away' ? 'A' : 'B'

  // Winner info
  const winner = homeSetsWon > awaySetsWon ? (homeTeam?.name || 'Home') : (awayTeam?.name || 'Away')
  const winnerLabel = homeSetsWon > awaySetsWon ? homeLabel : awayLabel
  const result = `3:${Math.min(homeSetsWon, awaySetsWon)}`

  // Match time info
  const matchStart = match?.scheduledAt
    ? new Date(match.scheduledAt).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    : ''
  const matchEndTime = finishedSets.length > 0 && finishedSets[finishedSets.length - 1].endTime
    ? new Date(finishedSets[finishedSets.length - 1].endTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    : ''
  const matchDuration = (() => {
    const totalMinutes = calculateSetResults.reduce((sum, r) => {
      if (!r.duration) return sum
      const m = r.duration.match(/(\d+)'/)
      return sum + (m ? parseInt(m[1], 10) : 0)
    }, 0)
    return totalMinutes > 0 ? `${totalMinutes}'` : ''
  })()

  // Split sanctions
  const sanctionsInBox = processedSanctions.slice(0, 10)
  const overflowSanctions = processedSanctions.slice(10)

  // Check if optional fields exist
  const hasAsstScorer = match.asstScorerSignature !== undefined || match.officials?.asstScorer
  const hasRef2 = match.ref2Signature !== undefined || match.officials?.ref2

  // Signature status checks
  const captainASigned = homeLabel === 'A' ? !!match.homeCaptainSignature : !!match.awayCaptainSignature
  const captainBSigned = homeLabel === 'B' ? !!match.homeCaptainSignature : !!match.awayCaptainSignature
  const captainsDone = captainASigned && captainBSigned

  const asstScorerSigned = !hasAsstScorer || !!match.asstScorerSignature
  const scorerSigned = !!match.scorerSignature
  const ref2Signed = !hasRef2 || !!match.ref2Signature
  const ref1Signed = !!match.ref1Signature

  // Determine current signature step
  const getCurrentStep = () => {
    if (!captainsDone) return 'captains'
    if (hasAsstScorer && !asstScorerSigned) return 'asst-scorer'
    if (!scorerSigned) return 'scorer'
    if (hasRef2 && !ref2Signed) return 'ref2'
    if (!ref1Signed) return 'ref1'
    return 'complete'
  }
  const currentStep = getCurrentStep()
  const allSignaturesDone = currentStep === 'complete'

  const handleSaveSignature = async (role, signatureData) => {
    const fieldMap = {
      'captain-a': homeLabel === 'A' ? 'homeCaptainSignature' : 'awayCaptainSignature',
      'captain-b': homeLabel === 'B' ? 'homeCaptainSignature' : 'awayCaptainSignature',
      'asst-scorer': 'asstScorerSignature',
      'scorer': 'scorerSignature',
      'ref2': 'ref2Signature',
      'ref1': 'ref1Signature'
    }
    const field = fieldMap[role]
    if (field) {
      await db.matches.update(matchId, { [field]: signatureData })
    }
    setOpenSignature(null)
  }

  const getSignatureData = (role) => {
    if (role === 'captain-a') return homeLabel === 'A' ? match.homeCaptainSignature : match.awayCaptainSignature
    if (role === 'captain-b') return homeLabel === 'B' ? match.homeCaptainSignature : match.awayCaptainSignature
    if (role === 'asst-scorer') return match.asstScorerSignature
    if (role === 'scorer') return match.scorerSignature
    if (role === 'ref2') return match.ref2Signature
    if (role === 'ref1') return match.ref1Signature
    return null
  }

  const getSignatureLabel = (role) => {
    if (role === 'captain-a') {
      const team = homeLabel === 'A' ? homeTeam : awayTeam
      const captain = homeLabel === 'A' ? homeCaptain : awayCaptain
      return `Captain A - ${team?.shortName || team?.name || 'Team A'}${captain ? ` (#${captain.number})` : ''}`
    }
    if (role === 'captain-b') {
      const team = homeLabel === 'B' ? homeTeam : awayTeam
      const captain = homeLabel === 'B' ? homeCaptain : awayCaptain
      return `Captain B - ${team?.shortName || team?.name || 'Team B'}${captain ? ` (#${captain.number})` : ''}`
    }
    if (role === 'asst-scorer') return 'Assistant Scorer'
    if (role === 'scorer') return 'Scorer'
    if (role === 'ref2') return '2nd Referee'
    if (role === 'ref1') return '1st Referee'
    return ''
  }

  const SignatureBox = ({ role, disabled = false }) => {
    const signatureData = getSignatureData(role)
    const isSigned = !!signatureData

    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        flex: 1,
        minWidth: '140px',
        opacity: disabled ? 0.5 : 1
      }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text)' }}>
          {getSignatureLabel(role)}
        </div>
        <div
          onClick={() => !disabled && setOpenSignature(role)}
          style={{
            border: isSigned ? '2px solid #22c55e' : '2px solid rgba(255,255,255,0.2)',
            borderRadius: '8px',
            background: isSigned ? 'rgba(34, 197, 94, 0.1)' : 'var(--bg-secondary)',
            minHeight: '60px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: disabled ? 'not-allowed' : 'pointer',
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
            <div style={{ color: 'var(--muted)', fontSize: '12px' }}>
              {disabled ? 'Waiting...' : 'Tap to sign'}
            </div>
          )}
        </div>
      </div>
    )
  }

  const handleShowScoresheet = () => {
    // Prepare scoresheet data
    const scoresheetData = {
      match,
      homeTeam,
      awayTeam,
      homePlayers,
      awayPlayers,
      sets,
      events
    }
    sessionStorage.setItem('scoresheetData', JSON.stringify(scoresheetData))
    window.open('/scoresheet', '_blank', 'width=1600,height=1200')
  }

  const handleApprove = async () => {
    setIsSaving(true)
    try {
      // Only check signatures for official matches
      if (!match.test && !allSignaturesDone) {
        alert('Please complete all signatures before approving.')
        setIsSaving(false)
        return
      }

      // Save to sync queue if official match
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

      // Export data
      const allSets = await db.sets.where('matchId').equals(matchId).sortBy('index')
      const allEvents = await db.events.where('matchId').equals(matchId).sortBy('seq')

      const exportData = {
        match: { ...match, homeTeam, awayTeam },
        homePlayers,
        awayPlayers,
        sets: allSets,
        events: allEvents,
        exportedAt: new Date().toISOString()
      }

      const dataStr = JSON.stringify(exportData, null, 2)
      const dataBlob = new Blob([dataStr], { type: 'application/json' })
      const dataLink = document.createElement('a')
      const matchDate = match.scheduledAt
        ? new Date(match.scheduledAt).toLocaleDateString('en-GB').replace(/\//g, '-')
        : new Date().toLocaleDateString('en-GB').replace(/\//g, '-')
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
  }

  const handleReopen = async () => {
    // Reopen match for manual adjustments
    await db.matches.update(matchId, {
      approved: false,
      approvedAt: null,
      status: 'live'
    })
    // Navigate back to scoreboard
    if (onGoHome) onGoHome()
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      padding: '16px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '16px',
        paddingBottom: '12px',
        borderBottom: '2px solid rgba(255,255,255,0.1)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <img src={mikasaVolleyball} alt="Volleyball" style={{ width: '32px', height: '32px' }} />
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>Match Complete</h1>
        </div>
        <button
          onClick={onGoHome}
          style={{
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: 600,
            background: 'rgba(255,255,255,0.1)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '6px',
            cursor: 'pointer'
          }}
        >
          Home
        </button>
      </div>

      {/* ROW 1: Winner and Result */}
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: '10px',
        padding: '16px',
        marginBottom: '12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '20px'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '14px', color: 'var(--muted)', marginBottom: '4px' }}>
            Winner
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700 }}>
            {winner} <span style={{ color: 'var(--muted)', fontSize: '14px' }}>(Team {winnerLabel})</span>
          </div>
        </div>
        <div style={{
          fontSize: '36px',
          fontWeight: 800,
          color: 'var(--accent)'
        }}>
          {result}
        </div>
      </div>

      {/* ROW 2: Results and Sanctions (two columns) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: '12px',
        marginBottom: '12px'
      }}>
        {/* Results Box */}
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '10px',
          padding: '12px',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>
            Results
          </div>
          <div style={{
            background: 'white',
            borderRadius: '6px',
            overflow: 'hidden',
            flex: 1
          }}>
            <Results
              teamAShortName={homeLabel === 'A' ? (match?.homeShortName || homeTeam?.shortName || '') : (match?.awayShortName || awayTeam?.shortName || '')}
              teamBShortName={homeLabel === 'B' ? (match?.homeShortName || homeTeam?.shortName || '') : (match?.awayShortName || awayTeam?.shortName || '')}
              setResults={calculateSetResults}
              matchStart={matchStart}
              matchEnd={matchEndTime}
              matchDuration={matchDuration}
              winner={winner}
              result={result}
            />
          </div>
        </div>

        {/* Sanctions Box */}
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '10px',
          padding: '12px',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>
            Sanctions
          </div>
          <div style={{
            background: 'white',
            borderRadius: '6px',
            overflow: 'hidden',
            flex: 1,
            minHeight: '150px'
          }}>
            <Sanctions
              items={sanctionsInBox}
              improperRequests={improperRequests}
            />
          </div>
        </div>
      </div>

      {/* ROW 3: Remarks */}
      <div style={{
        background: 'var(--bg-secondary)',
        borderRadius: '10px',
        padding: '12px',
        marginBottom: '12px'
      }}>
        <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>
          Remarks
        </div>
        <div style={{
          background: 'white',
          borderRadius: '6px',
          overflow: 'hidden',
          minHeight: '80px'
        }}>
          <Remarks overflowSanctions={overflowSanctions} />
        </div>
      </div>

      {/* ROW 4: Signatures */}
      {!isApproved && (
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '10px',
          padding: '12px',
          marginBottom: '12px'
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '12px'
          }}>
            <div style={{ fontSize: '14px', fontWeight: 600 }}>
              Signatures
              <span style={{
                fontSize: '11px',
                color: 'var(--muted)',
                fontWeight: 400,
                marginLeft: '8px'
              }}>
                {currentStep === 'captains' && 'Step 1: Team Captains'}
                {currentStep === 'asst-scorer' && 'Step 2: Assistant Scorer'}
                {currentStep === 'scorer' && (hasAsstScorer ? 'Step 3: Scorer' : 'Step 2: Scorer')}
                {currentStep === 'ref2' && 'Step: 2nd Referee'}
                {currentStep === 'ref1' && 'Final Step: 1st Referee'}
                {currentStep === 'complete' && 'All signatures collected'}
              </span>
            </div>
            <button
              onClick={handleShowScoresheet}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                fontWeight: 600,
                background: 'rgba(59, 130, 246, 0.2)',
                color: '#3b82f6',
                border: '1px solid rgba(59, 130, 246, 0.4)',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              Show Scoresheet
            </button>
          </div>

          {/* Step 1: Captains A & B */}
          <div style={{
            display: 'flex',
            gap: '12px',
            marginBottom: captainsDone ? '12px' : 0,
            flexWrap: 'wrap'
          }}>
            <SignatureBox role="captain-a" />
            <SignatureBox role="captain-b" />
          </div>

          {/* Step 2: Assistant Scorer (if present, shown after captains done) */}
          {captainsDone && hasAsstScorer && (
            <div style={{ marginBottom: asstScorerSigned ? '12px' : 0 }}>
              <SignatureBox role="asst-scorer" disabled={!captainsDone} />
            </div>
          )}

          {/* Step 3: Scorer (shown after asst scorer or captains) */}
          {captainsDone && (hasAsstScorer ? asstScorerSigned : true) && (
            <div style={{ marginBottom: scorerSigned ? '12px' : 0 }}>
              <SignatureBox role="scorer" disabled={hasAsstScorer && !asstScorerSigned} />
            </div>
          )}

          {/* Step 4: 2nd Referee (if present, shown after scorer) */}
          {captainsDone && scorerSigned && hasRef2 && (
            <div style={{ marginBottom: ref2Signed ? '12px' : 0 }}>
              <SignatureBox role="ref2" disabled={!scorerSigned} />
            </div>
          )}

          {/* Step 5: 1st Referee (final, shown after 2nd ref or scorer) */}
          {captainsDone && scorerSigned && (hasRef2 ? ref2Signed : true) && (
            <div>
              <SignatureBox role="ref1" disabled={hasRef2 && !ref2Signed} />
            </div>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        {!isApproved && (
          <>
            <button
              onClick={handleApprove}
              disabled={isSaving || (!match.test && !allSignaturesDone)}
              style={{
                flex: 1,
                minWidth: '150px',
                padding: '14px',
                fontSize: '15px',
                fontWeight: 600,
                background: (isSaving || (!match.test && !allSignaturesDone))
                  ? 'rgba(255,255,255,0.2)'
                  : '#22c55e',
                color: (isSaving || (!match.test && !allSignaturesDone)) ? 'var(--muted)' : '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: (isSaving || (!match.test && !allSignaturesDone)) ? 'not-allowed' : 'pointer',
                opacity: (isSaving || (!match.test && !allSignaturesDone)) ? 0.6 : 1
              }}
            >
              {isSaving ? 'Saving...' : 'Confirm and Approve'}
            </button>

            <button
              onClick={handleReopen}
              style={{
                flex: 1,
                minWidth: '150px',
                padding: '14px',
                fontSize: '15px',
                fontWeight: 600,
                background: 'rgba(239, 68, 68, 0.2)',
                color: '#ef4444',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: '8px',
                cursor: 'pointer'
              }}
            >
              Reopen Match
            </button>
          </>
        )}

        {isApproved && (
          <button
            onClick={onGoHome}
            style={{
              flex: 1,
              padding: '14px',
              fontSize: '15px',
              fontWeight: 600,
              background: 'var(--accent)',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            Done
          </button>
        )}

        <button
          onClick={handleShowScoresheet}
          style={{
            padding: '14px 20px',
            fontSize: '15px',
            fontWeight: 600,
            background: 'rgba(59, 130, 246, 0.2)',
            color: '#3b82f6',
            border: '1px solid rgba(59, 130, 246, 0.4)',
            borderRadius: '8px',
            cursor: 'pointer'
          }}
        >
          View Scoresheet
        </button>
      </div>

      {/* Signature Modal */}
      {openSignature && (
        <SignaturePad
          title={getSignatureLabel(openSignature)}
          onSave={(signatureData) => handleSaveSignature(openSignature, signatureData)}
          onClose={() => setOpenSignature(null)}
        />
      )}
    </div>
  )
}
