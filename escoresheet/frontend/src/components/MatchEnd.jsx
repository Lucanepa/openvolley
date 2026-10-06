import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useAlert } from '../contexts/AlertContext'
import { useScaledLayout } from '../hooks/useScaledLayout'
import SignaturePad from './SignaturePad'
import MenuList from './MenuList'
import Modal from './Modal'
import mikasaVolleyball from '../mikasa_v200w.png'
import JSZip from 'jszip'
import { apiStorage } from '../lib/apiClient'
import { uploadScoresheet, scoresheetUploadPath } from '../utils/scoresheetUploader'
import { redactScoresheetPath } from '../../scoresheet_pdf/utils/scoresheetStorage'
import { useComponentLogging } from '../contexts/LoggingContext'
import { exportLogsAsNDJSON } from '../utils/comprehensiveLogger'

// Primary ball image (with mikasa as fallback)
const ballImage = `${import.meta.env.BASE_URL}ball.png`
import { sanitizeForFilename, hashPassword } from '../utils/stringUtils'
import { getApiUrl } from '../utils/backendConfig'
import { formatTimeLocal } from '../utils/timeUtils'
import { getMatchWinner, clearedPostMatchSignatures, planForfeitReversal } from '../domain/matchEnd'
import { syncJobsForEvents, syncJobsForSets } from '../domain/corrections'
import { FileTextIcon, SearchIcon, PrinterIcon, SaveIcon, ChartIcon } from './icons'
import { X } from 'lucide-react'
import { Button } from '../ui/Button.jsx'
import { NOTICE } from '../ui/tones.js'

// volleyui recipes for this page (RESTYLE-SPEC P3b). The paper-sheet blocks
// (ResultsTable, SanctionsTable, RemarksBox and their black frames), the
// winner bar and the big set score are frozen and keep their inline styles.
// Section head: a name on the dark 1.5px rule (kit SectionHeader).
const SECTION_HEAD = 'flex items-center justify-between gap-2 border-b-[1.5px] border-stone-800 pb-1.5 mb-3'
const SECTION_TITLE = 'm-0 text-[11px] font-bold uppercase tracking-wider text-stone-800'
// The Scoresheet menu trigger: kit toolbar button, courtside height.
const TOOLBAR_TRIGGER = 'inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-stone-200 bg-white text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-50 transition-colors'
// Decision dialogs: stone-900/60 + blur, white rounded-2xl panel, shadow-2xl.
const DIALOG_OVERLAY = 'bg-stone-900/60 backdrop-blur-sm'
const DIALOG_PANEL = 'ov-kit bg-white rounded-2xl shadow-2xl border border-stone-200/70'
const DIALOG_TITLE = 'text-lg font-bold text-stone-900'

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
          if (!isFinished) return null
          return (
            <div key={setNum} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 1fr', gap: '4px', borderBottom: '1px solid #ccc', padding: '2px 0' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '11px', textAlign: 'center', fontWeight: 500, color: '#000' }}>
                <span>{setData.teamATimeouts ?? ''}</span>
                <span>{setData.teamASubstitutions ?? ''}</span>
                <span>{setData.teamAWon ?? ''}</span>
                <span style={{ fontWeight: 700 }}>{setData.teamAPoints ?? ''}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', fontSize: '11px', textAlign: 'center', color: '#000' }}>
                <span style={{ fontWeight: 600 }}>{setNum}</span>
                <span>{setData?.duration || ''}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', fontSize: '11px', textAlign: 'center', fontWeight: 500, color: '#000' }}>
                <span style={{ fontWeight: 700 }}>{setData.teamBPoints ?? ''}</span>
                <span>{setData.teamBWon ?? ''}</span>
                <span>{setData.teamBSubstitutions ?? ''}</span>
                <span>{setData.teamBTimeouts ?? ''}</span>
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
  width: '100%'
}

function MatchEndPageView({ children }) {
  return <div className="setup" style={setupViewStyle}>{children}</div>
}

export default function MatchEnd({ matchId, onGoHome, onReopenLastSet, onManualAdjustments }) {
  const cLogger = useComponentLogging('MatchEnd')
  const { vmin } = useScaledLayout()
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
  // showCloseConfirm modal removed - now using direct post-approval buttons
  const [showReopenConfirm, setShowReopenConfirm] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(null) // { json: boolean, pdf: boolean }
  const [zoomedSection, setZoomedSection] = useState(null) // 'results' | 'sanctions' | null
  const [showRemarksModal, setShowRemarksModal] = useState(false)
  const [remarksText, setRemarksText] = useState('')
  const remarksTextareaRef = useRef(null)

  // Reopen password protection
  const reopenPasswordHash = import.meta.env.VITE_REOPEN_PASSWORD_HASH || null
  const [reopenUnlocked, setReopenUnlocked] = useState(false)
  const [showUnlockModal, setShowUnlockModal] = useState(false)
  const [unlockPasswordInput, setUnlockPasswordInput] = useState('')
  const [unlockPasswordError, setUnlockPasswordError] = useState('')

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
        // Use the confirmed set start (as the PDF does); the scheduled time is
        // only a fallback for set 1, since matches often start late.
        if (setInfo?.startTime) {
          start = new Date(setInfo.startTime)
        } else if (setNum === 1 && match?.scheduledAt) {
          start = new Date(match.scheduledAt)
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

  // Find captains (rosters store isCaptain; older data used captain)
  const homeCaptain = homePlayers.find(p => p.isCaptain || p.captain)
  const awayCaptain = awayPlayers.find(p => p.isCaptain || p.captain)

  // Determine team labels (A or B)
  const teamAKey = match.coinTossTeamA || 'home'
  const homeLabel = teamAKey === 'home' ? 'A' : 'B'

  // Winner info: forfeit gives the match to the opponent; a stopped match with
  // level sets has no winner
  const winnerKey = getMatchWinner(sets, match?.bestOf, { forfeitTeam: match?.forfeitTeam })
  const winner = winnerKey === 'home'
    ? (homeTeam?.name || t('common.home'))
    : winnerKey === 'away'
      ? (awayTeam?.name || t('common.away'))
      : t('matchEnd.noWinner', 'No winner (match stopped)')

  // Match time info - duration is matchEnd - matchStart. Start is the confirmed
  // set 1 start (as on the PDF), falling back to the scheduled time.
  const set1StartTime = sets.find(s => s.index === 1)?.startTime || null
  const matchStartIso = set1StartTime || match?.scheduledAt || null
  const matchStartDate = matchStartIso ? new Date(matchStartIso) : null
  const matchEndDate = finishedSets.length > 0 && finishedSets[finishedSets.length - 1].endTime
    ? new Date(finishedSets[finishedSets.length - 1].endTime)
    : null

  // Display times in local timezone
  const matchStart = matchStartIso ? formatTimeLocal(matchStartIso) : ''
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
    cLogger.logHandler('handleSaveSignature', { role })
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
        <div className="text-xs font-medium text-stone-500">
          {getSignatureLabel(role)}
        </div>
        {/* Unsigned: the kit's dashed "tap to sign" well. Signed: emerald done
            state with the signature image. Size and tap behaviour unchanged. */}
        <div
          onClick={() => !disabled && !isSigned && setOpenSignature(role)}
          className={isSigned
            ? 'rounded-xl border-2 border-solid border-emerald-300 bg-emerald-50'
            : `rounded-xl border-2 border-dashed border-stone-300 bg-stone-50 text-stone-500${disabled ? '' : ' hover:bg-stone-100 hover:border-stone-400'} transition-colors`}
          style={{
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
              alt={t('common.signature')}
              style={{
                maxWidth: '100%',
                maxHeight: '56px',
                objectFit: 'contain'
              }}
            />
          ) : (
            <div className="text-sm font-medium text-stone-500">
              {disabled ? t('matchEnd.waiting', 'Waiting...') : t('matchEnd.tapToSign', 'Tap to sign')}
            </div>
          )}
        </div>
      </div>
    )
  }

  const handleShowScoresheet = (action = 'preview') => {
    cLogger.logHandler('handleShowScoresheet', { action })
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
    const url = action === 'preview' ? `/scoresheet/?matchId=${matchId}` : `/scoresheet/?matchId=${matchId}&action=${action}`
    window.open(url, '_blank', 'width=1600,height=1200')
  }

  // Handle downloading comprehensive interaction logs
  const handleDownloadLogs = async () => {
    cLogger.logHandler('handleDownloadLogs', { matchId })
    try {
      const gameN = match?.gameNumber || match?.game_n || null
      const { downloadLogs } = await import('../utils/comprehensiveLogger')
      await downloadLogs(gameN, 'ndjson')
      showAlert(t('matchEnd.logsDownloaded', 'Interaction logs downloaded successfully'), 'success')
    } catch (err) {
      console.error('[MatchEnd] Failed to download logs:', err)
      showAlert(t('matchEnd.logsDownloadFailed', 'Failed to download logs'), 'error')
    }
  }

  const handleApprove = async () => {
    cLogger.logHandler('handleApprove', { matchId, allSignaturesDone })
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
      const jsonFilename = `MatchData_${sanitizeForFilename(homeTeam?.name || t('common.home'))}_vs_${sanitizeForFilename(awayTeam?.name || t('common.away'))}_${matchDate}.json`

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
      window.open(`/scoresheet/?matchId=${matchId}&action=getBlob`, '_blank', 'width=1600,height=1200')

      // Wait for PDF blob - but don't let failures block approval
      let pdfResult = null
      try {
        pdfResult = await pdfPromise
        setDownloadProgress(prev => ({ ...prev, pdf: true }))
      } catch (pdfError) {
        console.warn('[MatchEnd] PDF generation failed, continuing with approval:', pdfError)
        // Don't block approval if PDF fails - just skip PDF in ZIP
      }

      // Create ZIP with both files (PDF is optional)
      const zip = new JSZip()
      zip.file(jsonFilename, dataStr)
      if (pdfResult) {
        zip.file(pdfResult.filename, pdfResult.blob)
      }

      // Add comprehensive interaction logs to the ZIP
      try {
        const gameN = match.gameNumber || match.game_n || null
        const logsContent = await exportLogsAsNDJSON(gameN)
        if (logsContent && logsContent.length > 0) {
          const logsFilename = `interaction_logs_${matchDate}.ndjson`
          zip.file(logsFilename, logsContent)
        }
      } catch (logsError) {
        console.warn('[MatchEnd] Failed to add interaction logs to ZIP:', logsError)
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' })
      const zipFilename = `Match_${sanitizeForFilename(homeTeam?.name || t('common.home'))}_vs_${sanitizeForFilename(awayTeam?.name || t('common.away'))}_${matchDate}.zip`

      // Upload PDF and final JSON to Supabase storage "scoresheets" bucket
      if (!match?.test) {
        try {
          // Same name scheme as the JSON (random part: only this scorer
          // account can read it, nobody can claim the name first)
          const pdfStoragePath = scoresheetUploadPath(match, { ext: 'pdf' })

          // Upload PDF (only if generation succeeded)
          if (pdfResult && pdfStoragePath) {
            const { error: uploadError } = await apiStorage
              .from('scoresheets')
              .upload(pdfStoragePath, pdfResult.blob, {
                contentType: 'application/pdf',
                upsert: true
              })
            if (uploadError) {
              console.warn('Failed to upload PDF to cloud:', uploadError)
            } else {
              console.log('PDF uploaded to cloud:', redactScoresheetPath(pdfStoragePath))
            }
          }

          // Upload final JSON (with _final suffix for approved matches)
          const jsonResult = await uploadScoresheet({
            match,
            homeTeam,
            awayTeam,
            homePlayers,
            awayPlayers,
            sets: allSets,
            events: allEvents,
            final: true
          })
          if (jsonResult.success) {
            console.log('Final JSON uploaded to cloud:', redactScoresheetPath(jsonResult.path))
          } else {
            console.warn('Failed to upload final JSON:', jsonResult.error)
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
            id: match.seed_key,
            status: 'approved',
            current_set: null,
            approval: approvalData
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }

      // Mark as approved in local database (status stays 'ended' until Close Match)
      await db.matches.update(matchId, {
        approved: true,
        approvedAt: new Date().toISOString(),
        current_set: null
      })

      // Update UI state to show post-approval buttons
      setDownloadProgress(null)
      setIsSaving(false)
      setIsApproved(true)

      // Warn if PDF was not generated (approval still succeeded)
      if (!pdfResult) {
        showAlert(t('matchEnd.pdfGenerationFailed', 'Match approved, but PDF generation failed. You can generate the PDF manually from the Scoresheet button.'), 'warning')
      }
    } catch (error) {
      console.error('Error approving match:', error)
      showAlert(t('matchEnd.errorApproving', { error: error.message }), 'error')
      setDownloadProgress(null)
      setIsSaving(false)
    }
  }

  // Handle closing match after approval - deletes local data and navigates home
  const handleCloseMatch = async () => {
    cLogger.logHandler('handleCloseMatch', { matchId })

    try {
      // Update match to final status in Supabase first (before deleting local data)
      if (!match.test && match?.seed_key) {
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: match.seed_key,
            status: 'final'
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }

      // Delete all local data for this match from IndexedDB
      await db.transaction('rw', db.events, db.sets, db.players, db.teams, db.matches, async () => {
        // Delete events for this match
        await db.events.where('matchId').equals(matchId).delete()

        // Delete sets for this match
        await db.sets.where('matchId').equals(matchId).delete()

        // Get team IDs before deleting match
        const matchData = await db.matches.get(matchId)
        if (matchData) {
          // Delete players for both teams
          if (matchData.homeTeamId) {
            await db.players.where('teamId').equals(matchData.homeTeamId).delete()
            await db.teams.delete(matchData.homeTeamId)
          }
          if (matchData.awayTeamId) {
            await db.players.where('teamId').equals(matchData.awayTeamId).delete()
            await db.teams.delete(matchData.awayTeamId)
          }
        }

        // Delete the match itself
        await db.matches.delete(matchId)
      })

      // Navigate home
      if (onGoHome) onGoHome()
    } catch (error) {
      console.error('[MatchEnd] Error closing match:', error)
      showAlert(t('matchEnd.errorClosing', 'Error closing match: ') + error.message, 'error')
    }
  }

  // Gatekeeper: check if reopen requires a password
  const handleReopenMatchClick = () => {
    if (reopenPasswordHash && !reopenUnlocked) {
      setUnlockPasswordInput('')
      setUnlockPasswordError('')
      setShowUnlockModal(true)
    } else {
      handleReopenMatch()
    }
  }

  const handleUnlockSubmit = async () => {
    if (!unlockPasswordInput.trim()) {
      setUnlockPasswordError(t('matchEnd.unlockPasswordRequired', 'Please enter the password'))
      return
    }
    try {
      // Try server-side verification first (more secure)
      const apiUrl = getApiUrl('/api/verify-reopen-password')
      if (apiUrl) {
        let response = null
        try {
          response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: unlockPasswordInput.trim() })
          })
        } catch (networkError) {
          // Backend configured but unreachable (offline venue): fall through to
          // the local check below instead of blocking the reopen.
          console.warn('[MatchEnd] Reopen password server unreachable, using local check:', networkError)
        }
        if (response) {
          if (response.status === 429) {
            setUnlockPasswordError(t('matchEnd.unlockTooManyAttempts', 'Too many attempts. Please wait and try again.'))
            return
          }
          const result = await response.json().catch(() => ({}))
          if (result.success) {
            setShowUnlockModal(false)
            setReopenUnlocked(true)
            setUnlockPasswordInput('')
            setUnlockPasswordError('')
          } else {
            setUnlockPasswordError(t('matchEnd.unlockPasswordWrong', 'Incorrect password'))
            setUnlockPasswordInput('')
          }
          return
        }
      }

      // Fallback to client-side verification (no backend, or backend unreachable)
      const inputHash = await hashPassword(unlockPasswordInput.trim())
      if (inputHash === reopenPasswordHash) {
        setShowUnlockModal(false)
        setReopenUnlocked(true)
        setUnlockPasswordInput('')
        setUnlockPasswordError('')
      } else {
        setUnlockPasswordError(t('matchEnd.unlockPasswordWrong', 'Incorrect password'))
        setUnlockPasswordInput('')
      }
    } catch (error) {
      console.error('[MatchEnd] Error verifying reopen password:', error)
      setUnlockPasswordError(t('matchEnd.unlockPasswordError', 'Error verifying password'))
    }
  }

  // Handle reopening match after approval - allows re-approval or adjustments
  const handleReopenMatch = async () => {
    cLogger.logHandler('handleReopenMatch', { matchId })

    try {
      // Clear approval state in database
      await db.matches.update(matchId, {
        approved: false,
        approvedAt: null,
        status: 'ended' // Match is finished but not final
      })

      // Mirror the un-approval to the cloud (approve queued status 'approved')
      if (!match?.test && match?.seed_key) {
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: match.seed_key,
            status: 'ended',
            approval: null
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }

      // Update local state
      setIsApproved(false)
    } catch (error) {
      console.error('[MatchEnd] Error reopening match:', error)
      showAlert(t('matchEnd.errorReopening', 'Error reopening match: ') + error.message, 'error')
    }
  }

  // Handle reopening the last set for corrections
  const handleReopenLastSet = async () => {
    cLogger.logHandler('handleReopenLastSet', { matchId })
    setShowReopenConfirm(false)

    try {
      // Find the last (highest index) set
      const allSets = await db.sets.where('matchId').equals(matchId).toArray()
      if (allSets.length === 0) {
        showAlert(t('matchEnd.noSetsReopen', 'No sets found to reopen'), 'error')
        return
      }
      let lastSet = allSets.reduce((a, b) => (a.index > b.index ? a : b))

      // A forfeit is REVERSED, not reopened as it stands: the last set is often
      // one the forfeit created (0-25) and the forfeit set holds awarded points.
      // Remove the created sets, the awarded points, the forfeit set_end and
      // forfait events, and reopen the forfeit set at its pre-forfeit score
      // (planForfeitReversal, tested).
      const allEvents = await db.events.where('matchId').equals(matchId).toArray()
      const forfaitIndexes = allEvents
        .filter(e => e.type === 'forfait' && (match?.forfeitTeam ? e.payload?.scope !== 'set' : true))
        .map(e => e.setIndex)
      const fromSetIndex = forfaitIndexes.length && match?.forfeitTeam
        ? Math.min(lastSet.index, ...forfaitIndexes)
        : lastSet.index
      const forfeitPlan = planForfeitReversal({ events: allEvents, sets: allSets, fromSetIndex })
      if (forfeitPlan.hasForfeit) {
        console.log('[MatchEnd] Reversing forfeit:', forfeitPlan)
        const deleteIds = new Set(forfeitPlan.deleteEventIds)
        await db.events.bulkDelete(forfeitPlan.deleteEventIds)
        if (forfeitPlan.deleteSetIds.length > 0) await db.sets.bulkDelete(forfeitPlan.deleteSetIds)
        for (const r of forfeitPlan.restoreSets) {
          await db.sets.update(r.id, { homePoints: r.homePoints, awayPoints: r.awayPoints, finished: false, endTime: null })
        }
        // Never send the removed rows to the cloud
        const deletedSetIds = new Set(forfeitPlan.deleteSetIds.map(String))
        const queued = await db.sync_queue.where('status').equals('queued').toArray()
        const staleJobs = [
          ...syncJobsForEvents(queued, deleteIds),
          ...syncJobsForSets(queued, forfeitPlan.deleteSetIds)
        ]
        if (staleJobs.length > 0) await db.sync_queue.bulkDelete(staleJobs.map(j => j.id))
        if (!match?.test && match?.seed_key) {
          for (const r of forfeitPlan.restoreSets) {
            await db.sync_queue.add({
              resource: 'set',
              action: 'update',
              payload: { external_id: String(r.id), home_points: r.homePoints, away_points: r.awayPoints, finished: false, end_time: null },
              ts: new Date().toISOString(),
              status: 'queued'
            })
          }
        }
        // The set to reopen is the forfeit set, or else the last remaining set
        const remainingSets = allSets.filter(x => !deletedSetIds.has(String(x.id)))
        const target = forfeitPlan.reopenSetIndex != null
          ? remainingSets.find(x => x.index === forfeitPlan.reopenSetIndex)
          : (remainingSets.length ? remainingSets.reduce((a, b) => (a.index > b.index ? a : b)) : null)
        if (target) lastSet = target
      }

      console.log('[MatchEnd] Reopening last set:', { id: lastSet.id, index: lastSet.index })

      // Mark the last set as not finished
      await db.sets.update(lastSet.id, { finished: false, endTime: null })

      // Set match status back to 'live' and clear all signature fields
      await db.matches.update(matchId, {
        status: 'live',
        approved: false,
        approvedAt: null,
        // The match is being played on: it is no longer forfeited or stopped
        forfeitTeam: null,
        forfeitReason: null,
        stoppedReason: null,
        // Clear all post-match signatures - they must be re-collected after changes
        ...clearedPostMatchSignatures()
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
            finished: false,
            end_time: null
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
          <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Volleyball" style={{ width: vmin(4), aspectRatio: '1' }} />
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-stone-900" style={{ margin: 0 }}>{t('matchEnd.title', 'Match Complete')}</h1>
          <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Volleyball" style={{ width: vmin(4), aspectRatio: '1' }} />
        </div>

      </div>

      {/* Winner, Results and Sanctions - All side by side on larger screens */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'stretch' }}>
        {/* Winner Card */}
        <div className="card" style={{ flex: '1 1 280px', minWidth: '260px', paddingLeft: '20px', paddingRight: '20px', paddingBottom: '20px', display: 'flex', flexDirection: 'column' }}>
          <div className={SECTION_HEAD}><h3 className={SECTION_TITLE}>{t('matchEnd.winner', 'Winner')}</h3></div>
          {/* Team Name with background */}
          <div style={{ background: 'var(--accent)', color: '#000', padding: '12px 20px', borderRadius: '8px', textAlign: 'center', fontSize: '22px', fontWeight: 700, marginBottom: '16px' }}>
            {winner}
          </div>
          {/* Score and Set Results (.match-end-score: frozen readout type, RESTYLE-SPEC R1) */}
          <div className="match-end-score" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '24px', flex: 1 }}>
            {/* Main Score */}
            <div style={{ fontSize: vmin(8), fontWeight: 800, color: 'var(--accent)' }}>
              {homeSetsWon}<span style={{ color: 'var(--muted)' }}>:</span>{awaySetsWon}
            </div>
            {/* Set Scores - Vertical List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: vmin(1.5) }}>
              {finishedSets.map((set, idx) => {
                const romanNumerals = ['I', 'II', 'III', 'IV', 'V']
                return (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--muted)'}}>
                    <span style={{ width: '20px', fontSize: vmin(1.3), color: 'var(--muted)', textAlign: 'center' }}>{romanNumerals[idx]}</span>
                    <span style={{ fontWeight: set.homePoints > set.awayPoints ? 700 : 400, color: set.homePoints > set.awayPoints ? 'var(--foreground)' : 'var(--muted)',  }}>
                      {set.homePoints}
                    </span>
                    <span>:</span>
                    <span style={{ fontWeight: set.awayPoints > set.homePoints ? 700 : 400, color: set.awayPoints > set.homePoints ? 'var(--foreground)' : 'var(--muted)' }}>
                      {set.awayPoints}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Results Card */}
        <div
          className="card"
          data-help-id="matchend-results-table"
          style={{ flex: '1 1 280px', minWidth: '260px', cursor: 'pointer', display: 'flex', flexDirection: 'column' }}
          onClick={() => setZoomedSection('results')}
        >
          <div className={SECTION_HEAD}><h3 className={SECTION_TITLE}>{t('matchEnd.results', 'Results')}</h3></div>
          <div className="ov-legacy-results" style={{ background: '#fff', borderRadius: '6px', overflow: 'hidden', border: '2px solid #333', flex: 1 }}>
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
        <div
          className="card"
          style={{ flex: '1 1 280px', minWidth: '260px', cursor: 'pointer', display: 'flex', flexDirection: 'column' }}
          onClick={() => setZoomedSection('sanctions')}
        >
          <div className={SECTION_HEAD}><h3 className={SECTION_TITLE}>{t('matchEnd.sanctions', 'Sanctions')}</h3></div>
          <div className="ov-legacy-results" style={{ background: '#fff', borderRadius: '6px', overflow: 'hidden', border: '2px solid #333', flex: 1 }}>
            <SanctionsTable
              items={sanctionsInBox}
              improperRequests={improperRequests}
            />
          </div>
        </div>
      </div>

      {/* Captain Signatures */}
      {!isApproved && (
        <div className="card" data-help-id="matchend-signatures" style={{ marginBottom: '16px' }}>
          <div className={SECTION_HEAD}><h3 className={SECTION_TITLE}>{t('matchEnd.teamCaptains', 'Team Captains')}</h3></div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <SignatureBox role="captain-a" />
            <SignatureBox role="captain-b" />
          </div>
        </div>
      )}

      {/* Remarks Card */}
      <div className="card" style={{ marginBottom: '16px' }}>
        <div className={`ov-kit ${SECTION_HEAD}`}>
          <h3 className={SECTION_TITLE}>{t('matchEnd.remarks', 'Remarks')}</h3>
          {!isApproved && (
            <Button
              variant="secondary"
              size="md"
              className="relative font-medium after:absolute after:-inset-1 after:content-['']"
              onClick={() => {
                setRemarksText(match?.remarks || '')
                setShowRemarksModal(true)
              }}
            >
              {t('matchEnd.editRemarks', 'Edit Remarks')}
            </Button>
          )}
        </div>
        <div style={{ background: '#fff', borderRadius: '6px', overflow: 'hidden', border: '2px solid #333', minHeight: '60px' }}>
          <RemarksBox overflowSanctions={overflowSanctions} remarks={match?.remarks || ''} />
        </div>
      </div>

      {/* Other Signatures - At the bottom */}
      {!isApproved && captainsDone && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <div className={SECTION_HEAD}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h3 className={SECTION_TITLE}>{t('matchEnd.officialSignatures', 'Official Signatures')}</h3>
              {/* Whose turn it is: a state, so a round pill (sky = pending,
                  emerald once every signature is in). */}
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${currentStep === 'complete' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800'}`}>
                {currentStep === 'asst-scorer' && t('matchEnd.assistantScorer', 'Assistant Scorer')}
                {currentStep === 'scorer' && t('matchEnd.scorer', 'Scorer')}
                {currentStep === 'ref2' && t('matchEnd.referee2', '2nd Referee')}
                {currentStep === 'ref1' && t('matchEnd.referee1', '1st Referee')}
                {currentStep === 'complete' && t('matchEnd.allSignaturesCollected', 'All signatures collected')}
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
      {/* Page actions: the emerald commit fills the line; the destructive
          reopen is the soft red; the rest are outline / toolbar. All h-11
          (courtside, >= 44px). */}
      <div className="ov-kit" style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        {isApproved ? (
          // Post-approval buttons: Close Match and Reopen Match
          <>
            <Button
              variant="positive"
              size="xl"
              onClick={handleCloseMatch}
              style={{ flex: 1, minWidth: '150px' }}
            >
              {t('matchEnd.closeMatch', 'Close Match')}
            </Button>
            <Button
              variant="danger-soft"
              size="xl"
              onClick={handleReopenMatchClick}
              className="px-5"
            >
              {reopenPasswordHash && (
                reopenUnlocked ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                )
              )}
              {t('matchEnd.reopenMatch', 'Reopen Match')}
            </Button>
          </>
        ) : !showReopenConfirm && (
          // Pre-approval buttons: Confirm and Approve, Reopen Last Set, Manual Adjustments, Scoresheet
          <>
            <Button
              variant="positive"
              size="xl"
              onClick={handleApprove}
              disabled={isSaving || (!match.test && !allSignaturesDone)}
              loading={isSaving}
              data-help-id="matchend-export-json"
              className="disabled:cursor-not-allowed"
              style={{ flex: 1, minWidth: '150px' }}
            >
              {isSaving ? t('matchEnd.downloading', 'Downloading...') : t('matchEnd.approveParams', 'Confirm and Approve')}
            </Button>
            <Button
              variant="danger-soft"
              size="xl"
              onClick={() => setShowReopenConfirm(true)}
              data-help-id="matchend-reopen-set"
              className="px-5"
            >
              {t('matchEnd.reopenLastSet', 'Reopen Last Set')}
            </Button>
            <Button
              variant="secondary"
              size="xl"
              onClick={onManualAdjustments}
              className="px-5 font-medium"
            >
              {t('matchEnd.manualAdjustments', 'Manual Adjustments')}
            </Button>
            <div data-help-id="matchend-export-pdf">
              <MenuList
                buttonLabel={<span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><FileTextIcon size={15} />{t('matchEnd.scoresheet')}</span>}
                buttonClassName={`${TOOLBAR_TRIGGER} px-5`}
                showArrow={true}
                position="right"
                vertical="top"
                items={[
                  { key: 'preview', icon: <SearchIcon />, label: t('matchEnd.preview', 'Preview'), onClick: () => handleShowScoresheet('preview') },
                  { key: 'print', icon: <PrinterIcon />, label: t('matchEnd.print', 'Print'), onClick: () => handleShowScoresheet('print') },
                  { key: 'save', icon: <SaveIcon />, label: t('matchEnd.savePdf', 'Save PDF'), onClick: () => handleShowScoresheet('save') },
                  { key: 'logs', icon: <ChartIcon />, label: t('matchEnd.downloadLogs', 'Download Logs'), onClick: handleDownloadLogs }
                ]}
              />
            </div>
          </>
        )}
      </div>

      {/* Download Progress Modal */}
      {downloadProgress && (
        <div className={DIALOG_OVERLAY} style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div className={DIALOG_PANEL} style={{
            padding: '24px',
            maxWidth: '400px',
            width: '90%',
            textAlign: 'center'
          }}>
            <h3 className={DIALOG_TITLE} style={{ margin: '0 0 16px 0' }}>{t('matchEnd.preparingExport', 'Preparing Match Export...')}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
              <div className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'center' }}>
                <span className={downloadProgress.json ? 'text-emerald-600' : 'text-stone-400'} style={{ fontSize: '20px' }}>{downloadProgress.json ? '✓' : '⏳'}</span>
                <span className={downloadProgress.json ? 'font-medium text-emerald-700' : 'text-stone-500'}>Match Data (JSON)</span>
              </div>
              <div className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'center' }}>
                <span className={downloadProgress.pdf ? 'text-emerald-600' : 'text-stone-400'} style={{ fontSize: '20px' }}>{downloadProgress.pdf ? '✓' : '⏳'}</span>
                <span className={downloadProgress.pdf ? 'font-medium text-emerald-700' : 'text-stone-500'}>{t('matchEnd.generatingPdf', 'Generating Scoresheet (PDF)')}</span>
              </div>
            </div>
            <p className="text-xs text-stone-500" style={{ margin: 0 }}>
              {downloadProgress.json && downloadProgress.pdf
                ? t('matchEnd.creatingZip', 'Creating ZIP and uploading to cloud...')
                : t('matchEnd.waitCheck', 'Please wait while files are being prepared...')}
            </p>
          </div>
        </div>
      )}

      {/* Reopen Last Set Confirmation Modal */}
      {showReopenConfirm && (
        <div className={DIALOG_OVERLAY} style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div role="dialog" aria-modal="true" className={DIALOG_PANEL} style={{
            padding: '24px',
            maxWidth: '450px',
            width: '90%'
          }}>
            <h3 className={DIALOG_TITLE} style={{ margin: '0 0 8px 0' }}>{t('matchEnd.reopenSetConfirmTitle', 'Reopen Last Set?')}</h3>
            <p className="text-sm text-stone-600" style={{ margin: '0 0 12px 0' }}>
              {t('matchEnd.reopenSetConfirmBody', 'This will reopen the last set for corrections and allow you to continue scoring.')}
            </p>
            <p className={NOTICE.warning} style={{ margin: '0 0 24px 0' }}>
              {t('matchEnd.reopenSetWarning', 'Warning: All collected signatures will be cleared and must be collected again after approval.')}
            </p>
            {/* Footer: Cancel left, the destructive commit right (red). */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button
                variant="secondary"
                size="xl"
                onClick={() => setShowReopenConfirm(false)}
                className="font-medium"
                style={{ flex: 1 }}
              >
                {t('matchEnd.cancel', 'Cancel')}
              </Button>
              <Button
                variant="danger"
                size="xl"
                onClick={handleReopenLastSet}
                style={{ flex: 1 }}
              >
                {t('matchEnd.yesReopen', 'Yes, Reopen Set')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Zoom Modal for Results/Sanctions */}
      {zoomedSection && (
        <div
          className="bg-stone-900/50 backdrop-blur-sm"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '20px'
          }}
          onClick={() => setZoomedSection(null)}
        >
          <div
            className="ov-legacy-results"
            style={{
              background: '#fff',
              borderRadius: '12px',
              maxWidth: '95vw',
              maxHeight: '90vh',
              overflow: 'auto',
              transform: 'scale(1.2)',
              transformOrigin: 'center center'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {zoomedSection === 'results' && (
              <ResultsTable
                teamAName={homeLabel === 'A' ? (homeTeam?.name || 'Team A') : (awayTeam?.name || 'Team A')}
                teamBName={homeLabel === 'B' ? (homeTeam?.name || 'Team B') : (awayTeam?.name || 'Team B')}
                setResults={calculateSetResults}
                matchStart={matchStart}
                matchEnd={matchEndTime}
                matchDuration={matchDuration}
              />
            )}
            {zoomedSection === 'sanctions' && (
              <SanctionsTable
                items={sanctionsInBox}
                improperRequests={improperRequests}
              />
            )}
          </div>
          {/* Round icon close: white on the dimmed page, 44px. */}
          <button
            onClick={() => setZoomedSection(null)}
            aria-label={t('common.close', 'Close')}
            title={t('common.close', 'Close')}
            className="h-11 w-11 inline-flex items-center justify-center rounded-full bg-white text-stone-700 shadow-lg hover:bg-stone-100 transition-colors"
            style={{
              position: 'absolute',
              top: '20px',
              right: '20px',
              padding: 0,
              border: 'none'
            }}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Signature Modal - Added open prop */}
      <SignaturePad
        open={!!openSignature}
        title={openSignature ? getSignatureLabel(openSignature) : ''}
        existingSignature={openSignature ? getSignatureData(openSignature) : null}
        onSave={(signatureData) => handleSaveSignature(openSignature, signatureData)}
        onClose={() => setOpenSignature(null)}
      />

      {/* Remarks Modal */}
      {showRemarksModal && (
        <Modal
          title={t('matchEnd.editRemarks', 'Edit Remarks')}
          open={true}
          onClose={() => {
            setShowRemarksModal(false)
            setRemarksText('')
          }}
          width={600}
        >
          <div className="ov-kit" style={{ padding: '8px 0 0' }}>
            <textarea
              ref={remarksTextareaRef}
              placeholder={t('matchEnd.remarksPlaceholder', 'Record match remarks...')}
              aria-label={t('matchEnd.remarks', 'Remarks')}
              value={remarksText}
              onChange={e => setRemarksText(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-stone-300 bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-500 resize-y"
              style={{
                minHeight: '200px',
                fontSize: '14px'
              }}
              autoFocus
            />
            <div style={{ marginTop: '16px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <Button
                variant="secondary"
                size="xl"
                className="font-medium"
                onClick={() => {
                  setShowRemarksModal(false)
                  setRemarksText('')
                }}
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="positive"
                size="xl"
                onClick={async () => {
                  await db.matches.update(matchId, { remarks: remarksText.trim() })
                  setShowRemarksModal(false)
                  setRemarksText('')
                }}
              >
                {t('common.save', 'Save')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Unlock Reopen Match Password Modal */}
      {showUnlockModal && (
        <div className={DIALOG_OVERLAY} style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div role="dialog" aria-modal="true" className={DIALOG_PANEL} style={{
            padding: '24px',
            maxWidth: '400px',
            width: '90%',
            textAlign: 'center'
          }}>
            <div className="text-stone-900" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '8px' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block' }}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <h3 className={DIALOG_TITLE} style={{ margin: 0 }}>
                {t('matchEnd.unlockReopen', 'Unlock Reopen')}
              </h3>
            </div>
            <p className="text-sm text-stone-600" style={{ margin: '0 0 16px 0' }}>
              {t('matchEnd.unlockReopenDescription', 'Enter the reopen password to unlock this action.')}
            </p>
            <input
              type="password"
              value={unlockPasswordInput}
              aria-label={t('matchEnd.unlockPasswordPlaceholder', 'Password')}
              onChange={e => {
                setUnlockPasswordInput(e.target.value)
                setUnlockPasswordError('')
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') handleUnlockSubmit()
              }}
              placeholder={t('matchEnd.unlockPasswordPlaceholder', 'Password')}
              autoComplete="off"
              autoFocus
              aria-invalid={unlockPasswordError ? true : undefined}
              className={`w-full h-11 px-3 rounded-xl border text-base tracking-wide text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-700/20 focus:border-red-700/40 ${unlockPasswordError ? 'border-red-400 bg-red-50' : 'border-stone-200 bg-white'}`}
              style={{ marginBottom: '8px' }}
            />
            {unlockPasswordError && (
              <p className="text-xs font-medium text-red-600" style={{ margin: '0 0 12px 0', textAlign: 'left' }}>
                {unlockPasswordError}
              </p>
            )}
            {/* Footer: Cancel left, the neutral commit (unlock) right. */}
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
              <Button
                variant="secondary"
                size="xl"
                className="font-medium"
                onClick={() => {
                  setShowUnlockModal(false)
                  setUnlockPasswordInput('')
                  setUnlockPasswordError('')
                }}
                style={{ flex: 1 }}
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="dark"
                size="xl"
                onClick={handleUnlockSubmit}
                style={{ flex: 1 }}
              >
                {t('common.confirm', 'Confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </MatchEndPageView>
  )
}
