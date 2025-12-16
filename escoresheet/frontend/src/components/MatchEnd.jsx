import { useState, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import SignaturePad from './SignaturePad'
import mikasaVolleyball from '../mikasa_v200w.png'

// Standard Results component for MatchEnd page
const ResultsTable = ({ teamAName, teamBName, setResults, matchStart, matchEnd, matchDuration }) => {
  return (
    <div style={{ padding: '12px', fontSize: '12px', background: '#fff', color: '#000' }}>
      {/* Header Row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 1fr', gap: '4px', marginBottom: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px', background: '#f0f0f0', borderRadius: '4px' }}>
          <div style={{ width: '20px', height: '20px', borderRadius: '50%', border: '2px solid #000', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 700, color: '#000' }}>A</div>
          <span style={{ fontWeight: 600, fontSize: '11px', color: '#000' }}>{teamAName}</span>
        </div>
        <div style={{ textAlign: 'center', fontWeight: 600, fontSize: '10px', color: '#333' }}>Set</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px', padding: '4px', background: '#f0f0f0', borderRadius: '4px' }}>
          <span style={{ fontWeight: 600, fontSize: '11px', color: '#000' }}>{teamBName}</span>
          <div style={{ width: '20px', height: '20px', borderRadius: '50%', border: '2px solid #000', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 700, color: '#000' }}>B</div>
        </div>
      </div>

      {/* Column Headers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 1fr', gap: '4px', marginBottom: '2px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '9px', textAlign: 'center', color: '#333', fontWeight: 600 }}>
          <span>T</span><span>S</span><span>W</span><span>P</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', fontSize: '9px', textAlign: 'center', color: '#333', fontWeight: 600 }}>
          <span>#</span><span>Time</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '9px', textAlign: 'center', color: '#333', fontWeight: 600 }}>
          <span>P</span><span>W</span><span>S</span><span>T</span>
        </div>
      </div>

      {/* Set Rows */}
      {[1, 2, 3, 4, 5].map(setNum => {
        const setData = setResults?.find(r => r.setNumber === setNum)
        const isFinished = setData && setData.teamAPoints !== null
        return (
          <div key={setNum} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 1fr', gap: '4px', borderBottom: '1px solid #ccc', padding: '2px 0' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '11px', textAlign: 'center', fontWeight: 500, color: '#000' }}>
              <span>{isFinished ? (setData.teamATimeouts ?? '') : ''}</span>
              <span>{isFinished ? (setData.teamASubstitutions ?? '') : ''}</span>
              <span>{isFinished ? (setData.teamAWon ?? '') : ''}</span>
              <span style={{ fontWeight: 700 }}>{isFinished ? (setData.teamAPoints ?? '') : ''}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', fontSize: '11px', textAlign: 'center', color: '#000' }}>
              <span style={{ fontWeight: 600 }}>{setNum}</span>
              <span>{setData?.duration || ''}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '11px', textAlign: 'center', fontWeight: 500, color: '#000' }}>
              <span style={{ fontWeight: 700 }}>{isFinished ? (setData.teamBPoints ?? '') : ''}</span>
              <span>{isFinished ? (setData.teamBWon ?? '') : ''}</span>
              <span>{isFinished ? (setData.teamBSubstitutions ?? '') : ''}</span>
              <span>{isFinished ? (setData.teamBTimeouts ?? '') : ''}</span>
            </div>
          </div>
        )
      })}

      {/* Totals Row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 1fr', gap: '4px', padding: '4px 0', background: '#e8e8e8', borderRadius: '0 0 4px 4px', marginTop: '2px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '11px', textAlign: 'center', fontWeight: 600, color: '#000' }}>
          <span>{setResults?.reduce((sum, r) => sum + (r.teamATimeouts ?? 0), 0) || 0}</span>
          <span>{setResults?.reduce((sum, r) => sum + (r.teamASubstitutions ?? 0), 0) || 0}</span>
          <span>{setResults?.reduce((sum, r) => sum + (r.teamAWon ?? 0), 0) || 0}</span>
          <span>{setResults?.reduce((sum, r) => sum + (r.teamAPoints ?? 0), 0) || 0}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', fontSize: '11px', textAlign: 'center', fontWeight: 600, color: '#000' }}>
          <span>Tot</span>
          <span>{matchDuration}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '11px', textAlign: 'center', fontWeight: 600, color: '#000' }}>
          <span>{setResults?.reduce((sum, r) => sum + (r.teamBPoints ?? 0), 0) || 0}</span>
          <span>{setResults?.reduce((sum, r) => sum + (r.teamBWon ?? 0), 0) || 0}</span>
          <span>{setResults?.reduce((sum, r) => sum + (r.teamBSubstitutions ?? 0), 0) || 0}</span>
          <span>{setResults?.reduce((sum, r) => sum + (r.teamBTimeouts ?? 0), 0) || 0}</span>
        </div>
      </div>

      {/* Match Time Info */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#000', marginTop: '8px', padding: '6px', background: '#f0f0f0', borderRadius: '4px' }}>
        <span>Start: <strong>{matchStart}</strong></span>
        <span>End: <strong>{matchEnd}</strong></span>
        <span>Duration: <strong>{matchDuration}</strong></span>
      </div>
    </div>
  )
}

// Standard Sanctions component for MatchEnd page
const SanctionsTable = ({ items = [], improperRequests = { teamA: false, teamB: false } }) => {
  return (
    <div style={{ padding: '12px', fontSize: '12px', background: '#fff', color: '#000' }}>
      {/* Improper Request Row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', background: '#f0f0f0', borderRadius: '4px', marginBottom: '8px' }}>
        <span style={{ fontSize: '11px', fontWeight: 600, color: '#000' }}>Improper Request</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <div style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid #000', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, position: 'relative', color: '#000' }}>
            A
            {improperRequests.teamA && <span style={{ position: 'absolute', fontSize: '28px', color: '#000' }}>×</span>}
          </div>
          <div style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid #000', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, position: 'relative', color: '#000' }}>
            B
            {improperRequests.teamB && <span style={{ position: 'absolute', fontSize: '28px', color: '#000' }}>×</span>}
          </div>
        </div>
      </div>

      {/* Header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', fontSize: '10px', fontWeight: 600, textAlign: 'center', color: '#333', padding: '4px 0', borderBottom: '2px solid #000' }}>
        <span>W</span><span>P</span><span>E</span><span>D</span><span>Team</span><span>Set</span><span>Score</span>
      </div>

      {/* Sanction Rows */}
      {items.length > 0 ? (
        items.map((item, idx) => (
          <div key={idx} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', fontSize: '11px', textAlign: 'center', padding: '4px 0', borderBottom: '1px solid #ccc', color: '#000' }}>
            <span style={{ fontWeight: 600 }}>{item.type === 'warning' ? item.playerNr : ''}</span>
            <span style={{ fontWeight: 600 }}>{item.type === 'penalty' ? item.playerNr : ''}</span>
            <span style={{ fontWeight: 600 }}>{item.type === 'expulsion' ? item.playerNr : ''}</span>
            <span style={{ fontWeight: 600 }}>{item.type === 'disqualification' ? item.playerNr : ''}</span>
            <span style={{ fontWeight: 600 }}>{item.team}</span>
            <span>{item.set}</span>
            <span>{item.score}</span>
          </div>
        ))
      ) : (
        <div style={{ textAlign: 'center', color: '#666', padding: '16px', fontSize: '11px' }}>No sanctions</div>
      )}
    </div>
  )
}

// Standard Remarks component for MatchEnd page
const RemarksBox = ({ overflowSanctions = [], remarks = '' }) => {
  const formatSanction = (sanction) => {
    const isDelay = sanction.playerNr === 'D'
    const typeLabel = sanction.type === 'warning'
      ? (isDelay ? 'Delay Warning' : 'Warning')
      : sanction.type === 'penalty'
        ? (isDelay ? 'Delay Penalty' : 'Penalty')
        : sanction.type === 'expulsion'
          ? 'Expulsion'
          : sanction.type === 'disqualification'
            ? 'Disqualification'
            : ''
    const playerInfo = !isDelay && sanction.playerNr ? `, #${sanction.playerNr}` : ''
    return `Team ${sanction.team}, Set ${sanction.set}, ${sanction.score}, ${typeLabel}${playerInfo}`
  }

  const hasContent = remarks?.trim() || overflowSanctions.length > 0

  return (
    <div style={{ padding: '12px', fontSize: '12px', minHeight: '60px', background: '#fff', color: '#000' }}>
      {hasContent ? (
        <>
          {remarks?.trim() && <div style={{ marginBottom: '8px', whiteSpace: 'pre-wrap', color: '#000' }}>{remarks.trim()}</div>}
          {overflowSanctions.length > 0 && (
            <>
              <div style={{ fontWeight: 600, marginBottom: '4px', fontSize: '11px', color: '#000' }}>Sanctions (overflow):</div>
              {overflowSanctions.map((sanction, idx) => (
                <div key={idx} style={{ fontSize: '11px', color: '#000', marginBottom: '2px' }}>{formatSanction(sanction)}</div>
              ))}
            </>
          )}
        </>
      ) : (
        <div style={{ color: '#666', fontSize: '11px' }}>No remarks</div>
      )}
    </div>
  )
}

// Page wrapper - matches MatchSetup styling, expand width unless compact
const setupViewStyle = {
  maxWidth: '1400px',
  width: '100%',
  alignSelf: 'flex-start',
  marginTop: '10px'
}

function MatchEndPageView({ children }) {
  return <div className="setup" style={setupViewStyle}>{children}</div>
}

export default function MatchEnd({ matchId, onGoHome }) {
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

  // Match time info - duration is matchEnd - matchStart
  const matchStartDate = match?.scheduledAt ? new Date(match.scheduledAt) : null
  const matchEndDate = finishedSets.length > 0 && finishedSets[finishedSets.length - 1].endTime
    ? new Date(finishedSets[finishedSets.length - 1].endTime)
    : null

  const matchStart = matchStartDate
    ? matchStartDate.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    : ''
  const matchEndTime = matchEndDate
    ? matchEndDate.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    : ''

  // Calculate duration as matchEnd - matchStart
  const matchDuration = (() => {
    if (matchStartDate && matchEndDate) {
      const durationMs = matchEndDate.getTime() - matchStartDate.getTime()
      const totalMinutes = Math.floor(durationMs / 60000)
      return totalMinutes > 0 ? `${totalMinutes}'` : ''
    }
    return ''
  })()

  // Split sanctions
  const sanctionsInBox = processedSanctions.slice(0, 10)
  const overflowSanctions = processedSanctions.slice(10)

  // Check if optional fields exist
  // Check if officials array has these roles
  const hasAsstScorer = match.asstScorerSignature !== undefined || 
    (Array.isArray(match.officials) && match.officials.some(o => 
      o.role?.toLowerCase() === 'assistant scorer' || o.role?.toLowerCase() === 'assistant_scorer'
    ))
  const hasRef2 = match.ref2Signature !== undefined || 
    (Array.isArray(match.officials) && match.officials.some(o => 
      o.role?.toLowerCase() === '2nd referee' || o.role?.toLowerCase() === '2nd_referee'
    ))

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
        <div style={{ fontSize: '12px', fontWeight: 600 }}>
          {getSignatureLabel(role)}
        </div>
        <div
          onClick={() => !disabled && !isSigned && setOpenSignature(role)}
          style={{
            border: isSigned ? '2px solid #22c55e' : '2px solid #333',
            borderRadius: '8px',
            background: isSigned ? 'rgba(34, 197, 94, 0.1)' : 'white',
            height: '60px',
            minHeight: '60px',
            maxHeight: '60px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: (disabled || isSigned) ? 'default' : 'pointer',
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
                maxHeight: '56px',
                objectFit: 'contain'
              }}
            />
          ) : (
            <div style={{ color: '#333', fontSize: '14px' }}>
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
    <MatchEndPageView>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src={mikasaVolleyball} alt="Volleyball" style={{ width: '32px', height: '32px' }} />
          <h2 style={{ margin: 0 }}>Match Complete</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="secondary" onClick={handleShowScoresheet}>
            Scoresheet
          </button>
          {onGoHome && (
            <button className="secondary" onClick={onGoHome}>
              Home
            </button>
          )}
        </div>
      </div>

      {/* Winner Card */}
      <div className="card" style={{ marginBottom: '16px', textAlign: 'center', padding: '20px' }}>
        <div className="text-sm" style={{ marginBottom: '8px' }}>Winner</div>
        <div style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px' }}>
          {winner} <span className="text-sm" style={{ fontWeight: 400 }}>(Team {winnerLabel})</span>
        </div>
        <div style={{ fontSize: '40px', fontWeight: 800, color: 'var(--accent)' }}>
          {result}
        </div>
      </div>

      {/* Captain Signatures - Right after winner */}
      {!isApproved && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <h3 style={{ margin: '0 0 12px 0' }}>Team Captains</h3>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <SignatureBox role="captain-a" />
            <SignatureBox role="captain-b" />
          </div>
        </div>
      )}

      {/* Results and Sanctions - Flex layout, side by side if space, otherwise stacked */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {/* Results Card */}
        <div className="card" style={{ flex: '1 1 400px', minWidth: '300px' }}>
          <h3 style={{ margin: '0 0 12px 0' }}>Results</h3>
          <div style={{ background: '#fff', borderRadius: '6px', overflow: 'hidden', border: '2px solid #333' }}>
            <ResultsTable
              teamAName={homeLabel === 'A' ? (homeTeam?.name || 'Team A') : (awayTeam?.name || 'Team A')}
              teamBName={homeLabel === 'B' ? (homeTeam?.name || 'Team B') : (awayTeam?.name || 'Team B')}
              setResults={calculateSetResults}
              matchStart={matchStart}
              matchEnd={matchEndTime}
              matchDuration={matchDuration}
            />
          </div>
        </div>

        {/* Sanctions Card */}
        <div className="card" style={{ flex: '1 1 400px', minWidth: '300px' }}>
          <h3 style={{ margin: '0 0 12px 0' }}>Sanctions</h3>
          <div style={{ background: '#fff', borderRadius: '6px', overflow: 'hidden', border: '2px solid #333', minHeight: '150px' }}>
            <SanctionsTable
              items={sanctionsInBox}
              improperRequests={improperRequests}
            />
          </div>
        </div>
      </div>

      {/* Remarks Card */}
      <div className="card" style={{ marginBottom: '16px' }}>
        <h3 style={{ margin: '0 0 12px 0' }}>Remarks</h3>
        <div style={{ background: '#fff', borderRadius: '6px', overflow: 'hidden', border: '2px solid #333', minHeight: '60px' }}>
          <RemarksBox overflowSanctions={overflowSanctions} />
        </div>
      </div>

      {/* Other Signatures - At the bottom */}
      {!isApproved && captainsDone && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h3 style={{ margin: 0, display: 'inline' }}>Official Signatures</h3>
              <span className="text-sm" style={{ marginLeft: '12px' }}>
                {currentStep === 'asst-scorer' && 'Assistant Scorer'}
                {currentStep === 'scorer' && 'Scorer'}
                {currentStep === 'ref2' && '2nd Referee'}
                {currentStep === 'ref1' && '1st Referee'}
                {currentStep === 'complete' && 'All signatures collected'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {/* Assistant Scorer (if present) */}
            {hasAsstScorer && (
              <SignatureBox role="asst-scorer" disabled={false} />
            )}

            {/* Scorer */}
            <SignatureBox role="scorer" disabled={hasAsstScorer && !asstScorerSigned} />

            {/* 2nd Referee (if present) - can sign after scorer has signed */}
            {hasRef2 && (
              <SignatureBox role="ref2" disabled={!scorerSigned} />
            )}

            {/* 1st Referee (final) - can sign after ref2 (if present) or after scorer (if no ref2) */}
            <SignatureBox role="ref1" disabled={(hasRef2 && !ref2Signed) || !scorerSigned} />
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        {!isApproved && (
          <>
            <button
              onClick={handleApprove}
              disabled={isSaving || (!match.test && !allSignaturesDone)}
              className="primary"
              style={{
                flex: 1,
                minWidth: '150px',
                padding: '14px',
                fontSize: '15px',
                opacity: (isSaving || (!match.test && !allSignaturesDone)) ? 0.5 : 1,
                cursor: (isSaving || (!match.test && !allSignaturesDone)) ? 'not-allowed' : 'pointer'
              }}
            >
              {isSaving ? 'Saving...' : 'Confirm and Approve'}
            </button>

            <button
              onClick={handleReopen}
              className="danger"
              style={{ flex: 1, minWidth: '150px', padding: '14px', fontSize: '15px' }}
            >
              Reopen Match
            </button>
          </>
        )}

        {isApproved && (
          <button
            onClick={onGoHome}
            className="primary"
            style={{ flex: 1, padding: '14px', fontSize: '15px' }}
          >
            Done
          </button>
        )}

        <button
          onClick={handleShowScoresheet}
          className="secondary"
          style={{ padding: '14px 20px', fontSize: '15px' }}
        >
          View Scoresheet
        </button>
      </div>

      {/* Signature Modal - Added open prop */}
      <SignaturePad
        open={!!openSignature}
        title={openSignature ? getSignatureLabel(openSignature) : ''}
        existingSignature={openSignature ? getSignatureData(openSignature) : null}
        onSave={(signatureData) => handleSaveSignature(openSignature, signatureData)}
        onClose={() => setOpenSignature(null)}
      />
    </MatchEndPageView>
  )
}
