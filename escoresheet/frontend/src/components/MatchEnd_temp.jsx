import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useAlert } from '../contexts/AlertContext'
import SignaturePad from './SignaturePad'
import MenuList from './MenuList'
import Modal from './Modal'
import mikasaVolleyball from '../mikasa_v200w.png'
import JSZip from 'jszip'
import { supabase } from '../lib/supabaseClient'

// Primary ball image (with mikasa as fallback)
const ballImage = '/ball.png'
import { sanitizeForFilename } from '../utils/stringUtils'
import { formatTimeLocal } from '../utils/timeUtils'

// Helper to format duration as hh:mm
const formatDurationHHMM = (durationStr) => {
  if (!durationStr) return ''
  // If already in format like "176'" (minutes), convert to hh:mm
  const match = durationStr.match(/^(\d+)'?$/)
  if (match) {
    const totalMinutes = parseInt(match[1], 10)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return `${hours}:${String(minutes).padStart(2, '0')}`
  }
  return durationStr
}

// Standard Results component for MatchEnd page
const ResultsTable = ({ teamAName, teamBName, setResults, matchStart, matchEnd, matchDuration }) => {
  const { t } = useTranslation()

  // Calculate winner
  const teamAWins = setResults?.reduce((sum, r) => sum + (r.teamAWon ?? 0), 0) || 0
  const teamBWins = setResults?.reduce((sum, r) => sum + (r.teamBWon ?? 0), 0) || 0
  const winnerName = teamAWins > teamBWins ? teamAName : teamBWins > teamAWins ? teamBName : null

  return (
    <div style={{ padding: '12px', fontSize: '12px', background: '#fff', color: '#000', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Team Labels Row - flex: 1 to fill available vertical space */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', marginBottom: '4px', flex: 1, minHeight: '40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px', background: '#f0f0f0', borderRadius: '4px' }}>
          <div style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid #000', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: '#000', flexShrink: 0 }}>A</div>
          <span style={{ fontWeight: 600, fontSize: '14px', color: '#000' }}>{teamAName}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', padding: '8px', background: '#f0f0f0', borderRadius: '4px' }}>
          <span style={{ fontWeight: 600, fontSize: '14px', color: '#000', textAlign: 'right' }}>{teamBName}</span>
          <div style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid #000', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: '#000', flexShrink: 0 }}>B</div>
        </div>
      </div>

      {/* Column Headers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 1fr', gap: '4px', marginBottom: '2px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '9px', textAlign: 'center', color: '#333', fontWeight: 600 }}>
          <span>T</span><span>S</span><span>W</span><span>P</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', fontSize: '9px', textAlign: 'center', color: '#333', fontWeight: 600 }}>
          <span>{t('matchEnd.set', 'Set')}</span><span>{t('matchEnd.time', 'Time')}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '9px', textAlign: 'center', color: '#333', fontWeight: 600 }}>
          <span>P</span><span>W</span><span>S</span><span>T</span>
        </div>
      </div>

      {/* Set Rows */}
      <div>
        {[1, 2, 3, 4, 5].map(setNum => {
          const setData = setResults?.find(r => r.setNumber === setNum)
          const isFinished = setData && setData.teamAPoints !== null
          return (
            <div key={setNum} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 1fr', gap: '4px', borderBottom: '1px solid #ccc', padding: '2px 0' }}>
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
      </div>

      {/* Totals Row */}
      {(() => {
        // Sum of set durations (parse "21'" format)
        const totalSetMinutes = setResults?.reduce((sum, r) => {
          if (!r.duration) return sum
          const match = r.duration.match(/^(\d+)'?$/)
          return sum + (match ? parseInt(match[1], 10) : 0)
        }, 0) || 0
        const totalSetDuration = totalSetMinutes > 0 ? `${totalSetMinutes}'` : ''

        return (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 1fr', gap: '4px', padding: '4px 0', background: '#e8e8e8', marginTop: '2px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '11px', textAlign: 'center', fontWeight: 600, color: '#000' }}>
              <span>{setResults?.reduce((sum, r) => sum + (r.teamATimeouts ?? 0), 0) || 0}</span>
              <span>{setResults?.reduce((sum, r) => sum + (r.teamASubstitutions ?? 0), 0) || 0}</span>
              <span>{setResults?.reduce((sum, r) => sum + (r.teamAWon ?? 0), 0) || 0}</span>
              <span style={{ fontWeight: 700 }}>{setResults?.reduce((sum, r) => sum + (r.teamAPoints ?? 0), 0) || 0}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', fontSize: '11px', textAlign: 'center', fontWeight: 600, color: '#000' }}>
              <span>{t('matchEnd.tot', 'Tot')}</span>
              <span>{totalSetDuration}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '11px', textAlign: 'center', fontWeight: 600, color: '#000' }}>
              <span style={{ fontWeight: 700 }}>{setResults?.reduce((sum, r) => sum + (r.teamBPoints ?? 0), 0) || 0}</span>
              <span>{setResults?.reduce((sum, r) => sum + (r.teamBWon ?? 0), 0) || 0}</span>
              <span>{setResults?.reduce((sum, r) => sum + (r.teamBSubstitutions ?? 0), 0) || 0}</span>
              <span>{setResults?.reduce((sum, r) => sum + (r.teamBTimeouts ?? 0), 0) || 0}</span>
            </div>
          </div>
        )
      })()}

      {/* Winner Row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '16px', padding: '6px 8px', background: '#e8e8e8', borderRadius: '0 0 4px 4px', borderTop: '1px solid #ccc' }}>
        <div>
          <span style={{ fontSize: '9px', color: '#666', textTransform: 'uppercase' }}>{t('matchEnd.winner', 'Winner')}</span>
          <div style={{ fontWeight: 700, fontSize: '14px', color: '#000' }}>{winnerName || '-'}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span style={{ fontSize: '9px', color: '#666', textTransform: 'uppercase' }}>{t('matchEnd.result', 'Result')}</span>
          <div style={{ fontWeight: 700, fontSize: '14px', color: '#000' }}>{Math.max(teamAWins, teamBWins)}:{Math.min(teamAWins, teamBWins)}</div>
        </div>
      </div>

      {/* Match Time Info */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#000', marginTop: '8px', padding: '6px', background: '#f0f0f0', borderRadius: '4px' }}>
        <span>{t('matchEnd.start', 'Start')}: <strong>{matchStart}</strong></span>
        <span>{t('matchEnd.end', 'End')}: <strong>{matchEnd}</strong></span>
        <span>{t('matchEnd.duration', 'Duration')}: <strong>{formatDurationHHMM(matchDuration)}</strong></span>
      </div>
    </div>
  )
}

// Standard Sanctions component for MatchEnd page
const SanctionsTable = ({ items = [], improperRequests = { teamA: false, teamB: false } }) => {
  const { t } = useTranslation()
  return (
    <div style={{ padding: '12px', fontSize: '12px', background: '#fff', color: '#000', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Improper Request Row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', background: '#f0f0f0', borderRadius: '4px', marginBottom: '8px' }}>
        <span style={{ fontSize: '11px', fontWeight: 600, color: '#000' }}>{t('matchEnd.improperRequest', 'Improper Request')}</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <div style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid #000', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, position: 'relative', color: '#000' }}>
            A
            {improperRequests.teamA && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" style={{ display: 'block' }}>
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
              </div>
            )}
          </div>
          <div style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid #000', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, position: 'relative', color: '#000' }}>
            B
            {improperRequests.teamB && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" style={{ display: 'block' }}>
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', fontSize: '10px', fontWeight: 600, textAlign: 'center', color: '#333', padding: '4px 0', borderBottom: '2px solid #000' }}>
        <span>W</span><span>P</span><span>E</span><span>D</span><span>Team</span><span>{t('matchEnd.set', 'Set')}</span><span>Score</span>
      </div>

      {/* Sanction Rows */}
      <div style={{ flex: 1 }}>
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
          <div style={{ textAlign: 'center', color: '#666', padding: '16px', fontSize: '11px' }}>{t('matchEnd.noSanctions', 'No sanctions')}</div>
        )}
      </div>
    </div>
  )
}

// Standard Remarks component for MatchEnd page
const RemarksBox = ({ overflowSanctions = [], remarks = '' }) => {
  const { t } = useTranslation()

  const formatSanction = (sanction) => {
    const isDelay = sanction.playerNr === 'D'
    const typeLabel = sanction.type === 'warning'
      ? (isDelay ? t('matchEnd.sanctionTypes.delayWarning', 'Delay Warning') : t('matchEnd.sanctionTypes.warning', 'Warning'))
      : sanction.type === 'penalty'
        ? (isDelay ? t('matchEnd.sanctionTypes.delayPenalty', 'Delay Penalty') : t('matchEnd.sanctionTypes.penalty', 'Penalty'))
        : sanction.type === 'expulsion'
          ? t('matchEnd.sanctionTypes.expulsion', 'Expulsion')
          : sanction.type === 'disqualification'
            ? t('matchEnd.sanctionTypes.disqualification', 'Disqualification')
            : ''
    const playerInfo = !isDelay && sanction.playerNr ? `, #${sanction.playerNr}` : ''
    return `${t('coinToss.teamA', 'Team')} ${sanction.team}, ${t('matchEnd.set', 'Set')} ${sanction.set}, ${sanction.score}, ${typeLabel}${playerInfo}`
  }

  const hasContent = remarks?.trim() || overflowSanctions.length > 0

  return (
    <div style={{ padding: '12px', fontSize: '12px', minHeight: '60px', background: '#fff', color: '#000' }}>
      {hasContent ? (
        <>
          {remarks?.trim() && <div style={{ marginBottom: '8px', whiteSpace: 'pre-wrap', color: '#000' }}>{remarks.trim()}</div>}
          {overflowSanctions.length > 0 && (
            <>
              <div style={{ fontWeight: 600, marginBottom: '4px', fontSize: '11px', color: '#000' }}>{t('matchEnd.sanctionsOverflow', 'Sanctions (overflow):')}</div>
              {overflowSanctions.map((sanction, idx) => (
                <div key={idx} style={{ fontSize: '11px', color: '#000', marginBottom: '2px' }}>{formatSanction(sanction)}</div>
              ))}
            </>
          )}
        </>
      ) : (
        <div style={{ color: '#666', fontSize: '11px' }}>{t('matchEnd.noRemarks', 'No remarks')}</div>
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

export default function MatchEnd({ matchId, onGoHome, onReopenLastSet }) {
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
  const { t } = useTranslation()

  const { showAlert } = useAlert()
  const [openSignature, setOpenSignature] = useState(null)
  const [isApproved, setIsApproved] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [showReopenConfirm, setShowReopenConfirm] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(null) // { json: boolean, pdf: boolean }
  const [zoomedSection, setZoomedSection] = useState(null) // 'results' | 'sanctions' | null
  const [showRemarksModal, setShowRemarksModal] = useState(false)
  const [remarksText, setRemarksText] = useState('')
  const remarksTextareaRef = useRef(null)

  // Prevent accidental navigation away before approval
  // Skip warning during save process (isSaving) to avoid dialog during PDF generation
  useEffect(() => {
    if (isApproved || isSaving) return // Allow navigation after approval or during save

    const handleBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = t('matchEnd.matchDataNotApproved', 'Match data has not been approved. Are you sure you want to leave?')
      return e.returnValue
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isApproved, isSaving])

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

  // Display times in local timezone
  const matchStart = match?.scheduledAt ? formatTimeLocal(match.scheduledAt) : ''
  const matchEndTime = finishedSets.length > 0 && finishedSets[finishedSets.length - 1].endTime
    ? formatTimeLocal(finishedSets[finishedSets.length - 1].endTime)
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

  // Signature status checks - use POST-GAME captain signatures (not pre-match)
  const captainASigned = homeLabel === 'A' ? !!match.homePostGameCaptainSignature : !!match.awayPostGameCaptainSignature
  const captainBSigned = homeLabel === 'B' ? !!match.homePostGameCaptainSignature : !!match.awayPostGameCaptainSignature
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
      'captain-a': homeLabel === 'A' ? 'homePostGameCaptainSignature' : 'awayPostGameCaptainSignature',
      'captain-b': homeLabel === 'B' ? 'homePostGameCaptainSignature' : 'awayPostGameCaptainSignature',
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
    if (role === 'captain-a') return homeLabel === 'A' ? match.homePostGameCaptainSignature : match.awayPostGameCaptainSignature
    if (role === 'captain-b') return homeLabel === 'B' ? match.homePostGameCaptainSignature : match.awayPostGameCaptainSignature
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
      // return `Captain A - ${team?.shortName || team?.name || 'Team A'}${captain ? ` (#${captain.number})` : ''}`
      return t('matchEnd.captainA', { team: team?.shortName || team?.name || 'Team A' }) + (captain ? ` (#${captain.number})` : '')
    }
    if (role === 'captain-b') {
      const team = homeLabel === 'B' ? homeTeam : awayTeam
      const captain = homeLabel === 'B' ? homeCaptain : awayCaptain
      // return `Captain B - ${team?.shortName || team?.name || 'Team B'}${captain ? ` (#${captain.number})` : ''}`
      return t('matchEnd.captainB', { team: team?.shortName || team?.name || 'Team B' }) + (captain ? ` (#${captain.number})` : '')
    }
    if (role === 'asst-scorer') return t('matchEnd.assistantScorer', 'Assistant Scorer')
    if (role === 'scorer') return t('matchEnd.scorer', 'Scorer')
    if (role === 'ref2') return t('matchEnd.referee2', '2nd Referee')
    if (role === 'ref1') return t('matchEnd.referee1', '1st Referee')
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
              {disabled ? t('matchEnd.waiting', 'Waiting...') : t('matchEnd.tapToSign', 'Tap to sign')}
            </div>
          )}
        </div>
      </div>
    )
  }

  const handleShowScoresheet = (action = 'preview') => {
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
    const url = action === 'preview' ? '/scoresheet' : `/scoresheet?action=${action}`
    window.open(url, '_blank', 'width=1600,height=1200')
  }

  const handleApprove = async () => {
    setIsSaving(true)
    try {
      // Only check signatures for official matches
      if (!match.test && !allSignaturesDone) {
        showAlert(t('matchEnd.pleaseCompleteSignatures', 'Please complete all signatures before approving.'), 'warning')
        setIsSaving(false)
        return
      }

      // Show download progress
      setDownloadProgress({ json: false, pdf: false })

      // Prepare export data
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
      const matchDate = match.scheduledAt
        ? new Date(match.scheduledAt).toLocaleDateString('en-GB', { timeZone: 'UTC' }).replace(/\//g, '-')
        : new Date().toLocaleDateString('en-GB').replace(/\//g, '-')
      const jsonFilename = `MatchData_${sanitizeForFilename(homeTeam?.name || 'Home')}_vs_${sanitizeForFilename(awayTeam?.name || 'Away')}_${matchDate}.json`

      // Mark JSON as ready
      setDownloadProgress(prev => ({ ...prev, json: true }))

      // Generate PDF via scoresheet window with postMessage
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

      // Create a promise that resolves when we receive the PDF blob
      const pdfPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          window.removeEventListener('message', handler)
          reject(new Error('PDF generation timed out'))
        }, 30000) // 30 second timeout

        const handler = (event) => {
          if (event.data?.type === 'pdfBlob') {
            clearTimeout(timeout)
            window.removeEventListener('message', handler)
            const blob = new Blob([event.data.arrayBuffer], { type: 'application/pdf' })
            resolve({ blob, filename: event.data.filename })
          }
        }
        window.addEventListener('message', handler)
      })

      // Open scoresheet window with getBlob action
      window.open('/scoresheet?action=getBlob', '_blank', 'width=1600,height=1200')

      // Wait for PDF blob
      const pdfResult = await pdfPromise
      setDownloadProgress(prev => ({ ...prev, pdf: true }))

      // Create ZIP with both files
      const zip = new JSZip()
      zip.file(jsonFilename, dataStr)
      zip.file(pdfResult.filename, pdfResult.blob)

      const zipBlob = await zip.generateAsync({ type: 'blob' })
      const zipFilename = `Match_${sanitizeForFilename(homeTeam?.name || 'Home')}_vs_${sanitizeForFilename(awayTeam?.name || 'Away')}_${matchDate}.zip`

      // Upload PDF to Supabase storage "scoresheets" bucket
      // Path format: {scheduled_date}/game{n}.pdf
      if (supabase && !match?.test) {
        try {
          const scheduledDate = match.scheduledAt
            ? new Date(match.scheduledAt).toISOString().slice(0, 10) // YYYY-MM-DD
            : new Date().toISOString().slice(0, 10)
          const gameNumber = match.gameNumber || match.externalId || match.game_n || 'unknown'
          const storagePath = `${scheduledDate}/game${gameNumber}.pdf`

          const { error: uploadError } = await supabase.storage
            .from('scoresheets')
            .upload(storagePath, pdfResult.blob, {
              contentType: 'application/pdf',
              upsert: true
            })
          if (uploadError) {
            console.warn('Failed to upload scoresheet to cloud:', uploadError)
          } else {
            console.log('Scoresheet uploaded to cloud:', storagePath)
          }
        } catch (uploadErr) {
          console.warn('Error uploading scoresheet:', uploadErr)
        }
      }

      // Download ZIP
      const zipLink = document.createElement('a')
      zipLink.download = zipFilename
      zipLink.href = URL.createObjectURL(zipBlob)
      zipLink.click()

      // Show confirmation dialog after downloads complete
      setDownloadProgress(null)
      setIsSaving(false)
      setShowCloseConfirm(true)
    } catch (error) {
      console.error('Error approving match:', error)
      showAlert(t('matchEnd.errorApproving', { error: error.message }), 'error')
      setDownloadProgress(null)
      setIsSaving(false)
    }
  }

  const handleConfirmClose = async (closeMatch) => {
    setShowCloseConfirm(false)

    if (closeMatch) {
      // Save to sync queue if official match with seed_key
      if (!match.test && match?.seed_key) {
        // Collect all signatures for the approval JSONB field
        const approvalData = {
          approvedAt: new Date().toISOString(),
          signatures: {
            captainA: homeLabel === 'A' ? match.homePostGameCaptainSignature : match.awayPostGameCaptainSignature,
            captainB: homeLabel === 'B' ? match.homePostGameCaptainSignature : match.awayPostGameCaptainSignature,
            scorer: match.scorerSignature || null,
            asstScorer: match.asstScorerSignature || null,
            ref1: match.ref1Signature || null,
            ref2: match.ref2Signature || null
          }
        }

        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: match.seed_key, // Use seed_key (external_id) for Supabase lookup
            status: 'final',
            current_set: null, // Clear current_set when match is final (not_live)
            approval: approvalData // JSONB field with signatures and approval timestamp
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }

      // Mark as approved and set status to 'final'
      await db.matches.update(matchId, {
        approved: true,
        approvedAt: new Date().toISOString(),
        status: 'final',
        current_set: null // Clear current_set when match is final
      })
      setIsApproved(true)

      // Go home
      if (onGoHome) onGoHome()
    } else {
      // Reopen match for manual adjustments
      await db.matches.update(matchId, {
        approved: false,
        approvedAt: null,
        status: 'live'
      })
      // Navigate back to scoreboard
      if (onGoHome) onGoHome()
    }
  }

  // Handle reopening the last set for corrections
  const handleReopenLastSet = async () => {
    setShowReopenConfirm(false)

    try {
      // Find the last (highest index) set
      const allSets = await db.sets.where('matchId').equals(matchId).toArray()
      if (allSets.length === 0) {
        showAlert(t('matchEnd.noSetsReopen', 'No sets found to reopen'), 'error')
        return
      }
      const lastSet = allSets.reduce((a, b) => (a.index > b.index ? a : b))

      console.log('[MatchEnd] Reopening last set:', { id: lastSet.id, index: lastSet.index })

      // Mark the last set as not finished
      await db.sets.update(lastSet.id, { finished: false })

      // Set match status back to 'live' and clear all signature fields
      await db.matches.update(matchId, {
        status: 'live',
        approved: false,
        approvedAt: null,
        // Clear all signature fields - they must be re-collected after changes
        captainSignatureHomePost: null,
        captainSignatureAwayPost: null,
        assistantScorerSignature: null,
        scorerSignature: null,
        referee2Signature: null,
        referee1Signature: null
      })

      // Delete the set_end event for this set to keep event log clean
      // Find set_end event for this set
      const setEndEvent = await db.events
        .where({ matchId: matchId })
        .filter(e => e.type === 'set_end' && e.setIndex === lastSet.index)
        .first()

      if (setEndEvent) {
        console.log('[MatchEnd] Deleting set_end event:', setEndEvent.id)
        await db.events.delete(setEndEvent.id)

        // Also queue deletion for Supabase
        if (match?.seed_key) {
          await db.sync_queue.add({
            resource: 'event',
            action: 'delete',
            payload: {
              id: setEndEvent.id // Send ID to delete
            },
            ts: new Date().toISOString(),
            status: 'queued'
          })
        }
      }

      // Queue sync to Supabase for the set update
      if (match?.seed_key) {
        await db.sync_queue.add({
          resource: 'set',
          action: 'update',
          payload: {
            external_id: String(lastSet.id),
            finished: false
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })

        // Queue sync for match status update
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: match.seed_key,
            status: 'live'
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }

      showAlert(t('matchEnd.setReopened', { index: lastSet.index }), 'success')

      // Navigate back to Scoreboard
      if (onReopenLastSet) {
        onReopenLastSet()
      } else if (onGoHome) {
        onGoHome()
      }
    } catch (error) {
      console.error('[MatchEnd] Error reopening last set:', error)
      showAlert(t('matchEnd.errorReopening', { error: error.message }), 'error')
    }
  }

  return (
    <MatchEndPageView>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', width: '100%', flexWrap: 'wrap' }}>
          <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Volleyball" style={{ width: '4vmin', aspectRatio: '1' }} />
          <h1 style={{ margin: 0 }}>{t('matchEnd.title', 'Match Complete')}</h1>
          <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Volleyball" style={{ width: '4vmin', aspectRatio: '1' }} />
        </div>

      </div>

      {/* Winner Card */}
      <div className="card" style={{ marginBottom: '16px', textAlign: 'center', padding: '20px' }}>
        <div className="text-sm" style={{ marginBottom: '8px' }}>{t('matchEnd.winner', 'Winner')}</div>
        <div style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px' }}>
          {winner} <span className="text-sm" style={{ fontWeight: 400 }}>{t('matchEnd.teamLabel', { label: winnerLabel })}</span>
        </div>
        <div style={{ fontSize: '40px', fontWeight: 800, color: 'var(--accent)' }}>
          {result}
        </div>
      </div>

      {/* Captain Signatures - Right after winner */}
      {!isApproved && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <h3 style={{ margin: '0 0 12px 0' }}>{t('matchEnd.teamCaptains', 'Team Captains')}</h3>
