import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { useAlert } from '../contexts/AlertContext'
import { useAuth } from '../contexts/AuthContext'
import { db } from '../db/db'
import SignaturePad from './SignaturePad'
import Modal from './Modal'
import RefereeSelector from './RefereeSelector'
import LoadOfficialMatchModal from './LoadOfficialMatchModal'
import mikasaVolleyball from '../mikasa_v200w.png'
import { useScaledLayout } from '../hooks/useScaledLayout'

// Primary ball image (with mikasa as fallback)
const ballImage = '/ball.png'
import { parseRosterPdf } from '../utils/parseRosterPdf'
import { getWebSocketUrl } from '../utils/backendConfig'
import { exportMatchData } from '../utils/backupManager'
import { uploadBackupToCloud, uploadLogsToCloud } from '../utils/logger'
import { supabase } from '../lib/supabaseClient'
import { generateMatchSeedKey } from '../utils/serverDataSync'
import { TEST_TEAM_SEED_DATA, TEST_HOME_BENCH, TEST_AWAY_BENCH } from '../constants/testSeeds'
import { splitLocalDateTime, parseLocalDateTimeToISO, roundToMinute } from '../utils/timeUtils'

// Date formatting helpers (outside component to avoid recreation)
function formatDateToDDMMYYYY(dateStr) {
  if (!dateStr) return ''
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)) {
    return dateStr.replace(/\./g, '/')
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [year, month, day] = dateStr.split('-')
    return `${day}/${month}/${year}`
  }
  const date = new Date(dateStr)
  if (!isNaN(date.getTime())) {
    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const year = date.getFullYear()
    return `${day}/${month}/${year}`
  }
  return dateStr
}

function formatDateToISO(dateStr) {
  if (!dateStr) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    const [day, month, year] = dateStr.split('/')
    return `${year}-${month}-${day}`
  }
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)) {
    const [day, month, year] = dateStr.split('.')
    return `${year}-${month}-${day}`
  }
  const date = new Date(dateStr)
  if (!isNaN(date.getTime())) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return dateStr
}

// Helper to safely parse a date and extract components for input fields
// Uses UTC methods to avoid timezone conversion - time is stored and displayed as-entered
// Parse UTC ISO string to local date and time for display/editing
function safeParseScheduledAt(scheduledAt) {
  return splitLocalDateTime(scheduledAt)
}

// Helper to build officials array, filtering out entries with no name
function buildOfficialsArray(ref1, ref2, scorer, asst, lineJudges = {}, useSnakeCase = false) {
  const officials = []
  const fnKey = useSnakeCase ? 'first_name' : 'firstName'
  const lnKey = useSnakeCase ? 'last_name' : 'lastName'

  // Add main officials only if they have a name
  if (ref1?.firstName || ref1?.lastName || ref1?.first_name || ref1?.last_name) {
    officials.push({ role: '1st referee', [fnKey]: ref1.firstName || ref1.first_name || '', [lnKey]: ref1.lastName || ref1.last_name || '', country: ref1.country || null, dob: ref1.dob || null })
  }
  if (ref2?.firstName || ref2?.lastName || ref2?.first_name || ref2?.last_name) {
    officials.push({ role: '2nd referee', [fnKey]: ref2.firstName || ref2.first_name || '', [lnKey]: ref2.lastName || ref2.last_name || '', country: ref2.country || null, dob: ref2.dob || null })
  }
  if (scorer?.firstName || scorer?.lastName || scorer?.first_name || scorer?.last_name) {
    officials.push({ role: 'scorer', [fnKey]: scorer.firstName || scorer.first_name || '', [lnKey]: scorer.lastName || scorer.last_name || '', country: scorer.country || null, dob: scorer.dob || null })
  }
  if (asst?.firstName || asst?.lastName || asst?.first_name || asst?.last_name) {
    officials.push({ role: 'assistant scorer', [fnKey]: asst.firstName || asst.first_name || '', [lnKey]: asst.lastName || asst.last_name || '', country: asst.country || null, dob: asst.dob || null })
  }

  // Add line judges if present
  if (lineJudges.lj1) officials.push({ role: 'line judge 1', name: lineJudges.lj1 })
  if (lineJudges.lj2) officials.push({ role: 'line judge 2', name: lineJudges.lj2 })
  if (lineJudges.lj3) officials.push({ role: 'line judge 3', name: lineJudges.lj3 })
  if (lineJudges.lj4) officials.push({ role: 'line judge 4', name: lineJudges.lj4 })

  return officials
}

// Helper to validate and create a UTC ISO string from local date and time inputs
// Treats user input as LOCAL time and converts to UTC for storage
// Throws an error if the date/time is invalid (unless allowEmpty is true and both are empty)
function createScheduledAt(date, time, options = {}) {
  const { allowEmpty = false } = options

  // If no date/time and allowEmpty, return null
  if (!date && !time) {
    if (allowEmpty) return null
    throw new Error('Date is required')
  }

  // Date is required if time is set
  if (!date && time) {
    throw new Error('Date is required when time is set')
  }

  // Validate date format (YYYY-MM-DD)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date format: "${date}". Expected YYYY-MM-DD.`)
  }

  // Validate date components are reasonable
  const [year, month, day] = date.split('-').map(Number)
  if (year < 1900 || year > 2100) {
    throw new Error(`Invalid year: ${year}. Must be between 1900 and 2100.`)
  }
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}. Must be between 1 and 12.`)
  }
  if (day < 1 || day > 31) {
    throw new Error(`Invalid day: ${day}. Must be between 1 and 31.`)
  }

  // Validate time format (HH:MM) if provided
  const timeToUse = time || '00:00'
  if (!/^\d{2}:\d{2}$/.test(timeToUse)) {
    throw new Error(`Invalid time format: "${time}". Expected HH:MM.`)
  }

  // Validate time components
  const [hours, minutes] = timeToUse.split(':').map(Number)
  if (hours < 0 || hours > 23) {
    throw new Error(`Invalid hour: ${hours}. Must be between 0 and 23.`)
  }
  if (minutes < 0 || minutes > 59) {
    throw new Error(`Invalid minutes: ${minutes}. Must be between 0 and 59.`)
  }

  // Parse as LOCAL time and convert to UTC ISO string
  // This ensures user enters 14:00 local → stored as 13:00Z (in UTC+1)
  const isoString = parseLocalDateTimeToISO(date, timeToUse)
  if (!isoString) {
    throw new Error(`Invalid date/time combination: ${date} ${timeToUse}`)
  }

  return isoString
}

// Helper to check if two values are equal (handles objects and arrays)
function isEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return a == b
  if (typeof a !== typeof b) return false
  if (typeof a === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

// Helper to check if match info has changed
function hasMatchInfoChanged(original, current) {
  if (!original) return true // No original, consider it changed
  const keys = ['date', 'time', 'hall', 'city', 'type1', 'type1Other', 'championshipType', 'championshipTypeOther',
    'type2', 'type3', 'type3Other', 'gameN', 'league', 'home', 'away', 'homeColor', 'awayColor', 'homeShortName', 'awayShortName']
  for (const key of keys) {
    if (!isEqual(original[key], current[key])) return true
  }
  return false
}

// Helper to check if officials have changed
function hasOfficialsChanged(original, current) {
  if (!original) return true
  const keys = ['ref1First', 'ref1Last', 'ref1Country', 'ref1Dob',
    'ref2First', 'ref2Last', 'ref2Country', 'ref2Dob',
    'scorerFirst', 'scorerLast', 'scorerCountry', 'scorerDob',
    'asstFirst', 'asstLast', 'asstCountry', 'asstDob',
    'lineJudge1', 'lineJudge2', 'lineJudge3', 'lineJudge4']
  for (const key of keys) {
    if (!isEqual(original[key], current[key])) return true
  }
  return false
}

// Helper to check if roster has changed
function hasRosterChanged(originalRoster, currentRoster, originalBench, currentBench) {
  if (!originalRoster || !originalBench) return true
  return !isEqual(originalRoster, currentRoster) || !isEqual(originalBench, currentBench)
}

// Get test team data from testSeeds.js
const TEST_HOME_TEAM = TEST_TEAM_SEED_DATA.find(t => t.seedKey === 'test-team-home')
const TEST_AWAY_TEAM = TEST_TEAM_SEED_DATA.find(t => t.seedKey === 'test-team-away')

// OfficialCard component - defined outside to prevent focus loss on re-render
const OfficialCard = memo(function OfficialCard({
  title,
  officialKey,
  lastName,
  firstName,
  country,
  dob,
  setLastName,
  setFirstName,
  setCountry,
  setDob,
  hasDatabase = false,
  selectorKey = null,
  onOpenDatabase,
  t
}) {
  return (
    <div style={{
      border: '1px solid rgba(255, 255, 255, 0.2)',
      borderRadius: '8px',
      background: 'rgba(15, 23, 42, 0.2)',
      overflow: 'hidden'
    }}>
      <div
        style={{
          padding: '10px 16px',
          background: 'rgba(255, 255, 255, 0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px'
        }}
      >
        <span style={{ fontWeight: 600, fontSize: '14px' }}>{title}</span>
        {hasDatabase && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpenDatabase(e, selectorKey)
            }}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              fontWeight: 500,
              background: 'rgba(59, 130, 246, 0.2)',
              color: '#60a5fa',
              border: '1px solid rgba(59, 130, 246, 0.4)',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            {t('matchSetup.database')}
          </button>
        )}
      </div>
      <div style={{ padding: '12px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <div className="field"><label>{t('matchSetup.lastName')}</label><input className="capitalize" style={{ width: '100%' }} value={lastName} onChange={e => setLastName(e.target.value)} /></div>
          <div className="field"><label>{t('matchSetup.firstName')}</label><input className="capitalize" style={{ width: '100%' }} value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
          <div className="field"><label>{t('matchSetup.country')}</label><input style={{ width: '100%' }} value={country} onChange={e => setCountry(e.target.value)} /></div>
          <div className="field"><label>{t('matchSetup.dateOfBirth')}</label><input style={{ width: '100%' }} type="date" value={dob ? formatDateToISO(dob) : ''} onChange={e => setDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
        </div>
      </div>
    </div>
  )
})

// LineJudgesCard component - defined outside to prevent focus loss on re-render
const LineJudgesCard = memo(function LineJudgesCard({
  lineJudge1,
  lineJudge2,
  lineJudge3,
  lineJudge4,
  setLineJudge1,
  setLineJudge2,
  setLineJudge3,
  setLineJudge4,
  t
}) {
  return (
    <div style={{
      border: '1px solid rgba(255, 255, 255, 0.2)',
      borderRadius: '8px',
      background: 'rgba(15, 23, 42, 0.2)',
      overflow: 'hidden'
    }}>
      <div
        style={{
          padding: '10px 16px',
          background: 'rgba(255, 255, 255, 0.1)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px'
        }}
      >
        <span style={{ fontWeight: 600, fontSize: '14px' }}>{t('matchSetup.lineJudges')}</span>
      </div>
      <div style={{ padding: '12px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <div className="field"><label>{t('matchSetup.lineJudge1')}</label><input className="capitalize" style={{ width: '100%' }} value={lineJudge1} onChange={e => setLineJudge1(e.target.value)} placeholder={t('matchSetup.name')} /></div>
          <div className="field"><label>{t('matchSetup.lineJudge2')}</label><input className="capitalize" style={{ width: '100%' }} value={lineJudge2} onChange={e => setLineJudge2(e.target.value)} placeholder={t('matchSetup.name')} /></div>
          <div className="field"><label>{t('matchSetup.lineJudge3')}</label><input className="capitalize" style={{ width: '100%' }} value={lineJudge3} onChange={e => setLineJudge3(e.target.value)} placeholder={t('matchSetup.name')} /></div>
          <div className="field"><label>{t('matchSetup.lineJudge4')}</label><input className="capitalize" style={{ width: '100%' }} value={lineJudge4} onChange={e => setLineJudge4(e.target.value)} placeholder={t('matchSetup.name')} /></div>
        </div>
      </div>
    </div>
  )
})

// Helper to generate short name from team name (first 3-4 chars uppercase)
function generateShortName(name) {
  if (!name) return ''
  // Remove common prefixes/suffixes and take first word or first 4 chars
  const cleaned = name.trim().toUpperCase()
  const words = cleaned.split(/\s+/)
  if (words.length > 1 && words[0].length <= 4) {
    return words[0]
  }
  return cleaned.substring(0, 4)
}

// Helper to convert DOB from DD.MM.YYYY to YYYY-MM-DD for Supabase date columns
function formatDobForSync(dob) {
  if (!dob) return null
  // Already in ISO format (YYYY-MM-DD)?
  if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) return dob
  // DD.MM.YYYY format?
  const match = dob.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (match) {
    const [, day, month, year] = match
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  // DD/MM/YYYY format?
  const match2 = dob.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (match2) {
    const [, day, month, year] = match2
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  return null // Unknown format, don't sync
}

export default function MatchSetup({ onStart, matchId, onReturn, onOpenOptions, onOpenCoinToss, offlineMode = false }) {
  const { t } = useTranslation()
  const { showAlert } = useAlert()
  const { user, profile, getCachedProfile } = useAuth()
  const { scaleFactor: baseScaleFactor } = useScaledLayout()
  // MatchSetup uses 25% larger scale by default
  const scaleFactor = baseScaleFactor * 1.25
  // Helper for scaled pixel values
  const s = (px) => Math.round(px * scaleFactor)
  const [home, setHome] = useState('')
  // Match created popup state
  const [matchCreatedModal, setMatchCreatedModal] = useState(null) // { matchId, gamePin, refereePin, homeTeamPin, awayTeamPin }
  const [away, setAway] = useState('')

  // Match info fields
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [dateError, setDateError] = useState('')
  const [timeError, setTimeError] = useState('')
  const [hall, setHall] = useState('')
  const [city, setCity] = useState('')
  const [type1, setType1] = useState('championship') // championship | cup | friendly | tournament
  const [type1Other, setType1Other] = useState('') // For "other" championship type
  const [championshipType, setChampionshipType] = useState('regional') // regional | national | international | other
  const [championshipTypeOther, setChampionshipTypeOther] = useState('') // For "other" championship type
  const [type2, setType2] = useState('men') // men | women
  const [type3, setType3] = useState('senior') // senior | U23 | U19 | other
  const [type3Other, setType3Other] = useState('') // For "other" level
  const [gameN, setGameN] = useState('')
  const [league, setLeague] = useState('')
  const [homeColor, setHomeColor] = useState('#ef4444')
  const [awayColor, setAwayColor] = useState('#3b82f6')
  const [homeShortName, setHomeShortName] = useState('')
  const [awayShortName, setAwayShortName] = useState('')
  const [notificationEmail, setNotificationEmail] = useState('')
  const [sendingEmail, setSendingEmail] = useState(false)

  // Match info confirmation state - other sections are disabled until confirmed
  const [matchInfoConfirmed, setMatchInfoConfirmed] = useState(false)

  // Check if match info can be confirmed (all required fields filled)
  const requireEmail = import.meta.env.VITE_REQUIRE_EMAIL === 'true'
  const canConfirmMatchInfo = Boolean(
    home?.trim() &&
    away?.trim() &&
    homeShortName?.trim() &&  // Home short name must be filled
    awayShortName?.trim() &&  // Away short name must be filled
    date?.trim() &&      // Date must be filled
    !dateError &&        // Date must be valid
    time?.trim() &&      // Time must be filled
    !timeError &&        // Time must be valid
    gameN?.trim() &&     // Game # must be filled
    league?.trim() &&    // League must be filled
    city?.trim() &&      // City must be filled
    hall?.trim() &&      // Hall must be filled
    (!requireEmail || notificationEmail?.trim())  // Email required if VITE_REQUIRE_EMAIL=true
  )

  // Generate dynamic tooltip showing which fields are missing
  const getMissingFieldsTooltip = () => {
    const missing = []
    if (!home?.trim()) missing.push(t('matchSetup.homeTeamName') || 'Home team')
    if (!away?.trim()) missing.push(t('matchSetup.awayTeamName') || 'Away team')
    if (!homeShortName?.trim()) missing.push(`${t('common.home')} ${t('matchSetup.short')}`)
    if (!awayShortName?.trim()) missing.push(`${t('common.away')} ${t('matchSetup.short')}`)
    if (!date?.trim()) missing.push(t('matchSetup.date') || 'Date')
    else if (dateError) missing.push(t('matchSetup.date') + ' (invalid)')
    if (!time?.trim()) missing.push(t('matchSetup.time') || 'Time')
    else if (timeError) missing.push(t('matchSetup.time') + ' (invalid)')
    if (!gameN?.trim()) missing.push(t('matchSetup.gameNumber') || 'Game #')
    if (!league?.trim()) missing.push(t('matchSetup.league') || 'League')
    if (!city?.trim()) missing.push(t('matchSetup.city') || 'City')
    if (!hall?.trim()) missing.push(t('matchSetup.hall') || 'Hall')
    if (requireEmail && !notificationEmail?.trim()) missing.push(t('matchSetup.notificationEmail') || 'Email')

    if (missing.length === 0) return ''
    return `${t('matchSetup.required') || 'Required'}: ${missing.join(', ')}`
  }

  // Rosters
  const [homeRoster, setHomeRoster] = useState([])
  const [awayRoster, setAwayRoster] = useState([])
  const rosterLoadedFromDraft = useRef({ home: false, away: false })
  const [homeNum, setHomeNum] = useState('')
  const [homeFirst, setHomeFirst] = useState('')
  const [homeLast, setHomeLast] = useState('')
  const [homeDob, setHomeDob] = useState('')
  const [homeLibero, setHomeLibero] = useState('') // '', 'libero1', 'libero2'
  const [homeCaptain, setHomeCaptain] = useState(false)

  const [awayNum, setAwayNum] = useState('')
  const [awayFirst, setAwayFirst] = useState('')
  const [awayLast, setAwayLast] = useState('')
  const [awayDob, setAwayDob] = useState('')
  const [awayLibero, setAwayLibero] = useState('')
  const [awayCaptain, setAwayCaptain] = useState(false)

  // Officials
  const [ref1First, setRef1First] = useState('')
  const [ref1Last, setRef1Last] = useState('')
  const [ref1Country, setRef1Country] = useState('CHE')
  const [ref1Dob, setRef1Dob] = useState('01.01.1900')

  const [ref2First, setRef2First] = useState('')
  const [ref2Last, setRef2Last] = useState('')
  const [ref2Country, setRef2Country] = useState('CHE')
  const [ref2Dob, setRef2Dob] = useState('01.01.1900')

  const [scorerFirst, setScorerFirst] = useState('')
  const [scorerLast, setScorerLast] = useState('')
  const [scorerCountry, setScorerCountry] = useState('CHE')
  const [scorerDob, setScorerDob] = useState('01.01.1900')

  const [asstFirst, setAsstFirst] = useState('')
  const [asstLast, setAsstLast] = useState('')
  const [asstCountry, setAsstCountry] = useState('CHE')
  const [asstDob, setAsstDob] = useState('01.01.1900')

  // Line Judges (only names needed)
  const [lineJudge1, setLineJudge1] = useState('')
  const [lineJudge2, setLineJudge2] = useState('')
  const [lineJudge3, setLineJudge3] = useState('')
  const [lineJudge4, setLineJudge4] = useState('')

  // Track which official cards are expanded (single accordion)
  const [expandedOfficialId, setExpandedOfficialId] = useState(null)
  const toggleOfficialExpanded = (key) => {
    setExpandedOfficialId(prev => prev === key ? null : key)
  }

  // Bench
  const BENCH_ROLES = [
    { value: 'Coach', label: 'C', labelKey: 'benchRolesShort.coach', fullLabelKey: 'benchRoles.coach' },
    { value: 'Assistant Coach 1', label: 'AC1', labelKey: 'benchRolesShort.assistantCoach1', fullLabelKey: 'benchRoles.assistantCoach1' },
    { value: 'Assistant Coach 2', label: 'AC2', labelKey: 'benchRolesShort.assistantCoach2', fullLabelKey: 'benchRoles.assistantCoach2' },
    { value: 'Physiotherapist', label: 'P', labelKey: 'benchRolesShort.physiotherapist', fullLabelKey: 'benchRoles.physiotherapist' },
    { value: 'Medic', label: 'M', labelKey: 'benchRolesShort.medic', fullLabelKey: 'benchRoles.medic' }
  ]

  const getRoleOrder = (role) => {
    const roleMap = {
      'Coach': 0,
      'Assistant Coach 1': 1,
      'Assistant Coach 2': 2,
      'Physiotherapist': 3,
      'Medic': 4
    }
    return roleMap[role] ?? 999
  }

  const sortBenchByHierarchy = (bench) => {
    return [...bench].sort((a, b) => getRoleOrder(a.role) - getRoleOrder(b.role))
  }

  const initBench = role => ({ role, firstName: '', lastName: '', dob: '' })
  const [benchHome, setBenchHome] = useState([
    initBench('Coach')
  ])
  const [benchAway, setBenchAway] = useState([
    initBench('Coach')
  ])

  // UI state for views
  const [currentView, setCurrentView] = useState('main') // 'main', 'info', 'officials', 'home', 'away'
  const [openSignature, setOpenSignature] = useState(null) // 'home-coach', 'home-captain', 'away-coach', 'away-captain'
  const [showRoster, setShowRoster] = useState({ home: false, away: false })
  const [colorPickerModal, setColorPickerModal] = useState(null) // { team: 'home'|'away', position: { x, y } } | null
  const [noticeModal, setNoticeModal] = useState(null) // { message: string, type?: 'success' | 'error' } | null
  const [testRosterConfirm, setTestRosterConfirm] = useState(null) // 'home' | 'away' | null

  // Show both rosters in match setup
  const [showBothRosters, setShowBothRosters] = useState(false)

  // Referee connection
  const [refereeConnectionEnabled, setRefereeConnectionEnabled] = useState(false)
  const [editPinModal, setEditPinModal] = useState(false)
  const [editPinType, setEditPinType] = useState(null) // 'referee', 'benchHome', 'benchAway'
  const [newPin, setNewPin] = useState('')
  const [pinError, setPinError] = useState('')

  // Bench connection - separate for each team
  const [homeTeamConnectionEnabled, setHomeTeamConnectionEnabled] = useState(false)
  const [awayTeamConnectionEnabled, setAwayTeamConnectionEnabled] = useState(false)
  const [benchConnectionEnabled, setBenchConnectionEnabled] = useState(false)

  // Manage Captain on Court setting
  const [manageCaptainOnCourt, setManageCaptainOnCourt] = useState(() => {
    const saved = localStorage.getItem('manageCaptainOnCourt')
    return saved === 'true'
  })

  // PDF upload state for each team
  const [homePdfFile, setHomePdfFile] = useState(null)
  const [awayPdfFile, setAwayPdfFile] = useState(null)
  const [homePdfLoading, setHomePdfLoading] = useState(false)
  const [awayPdfLoading, setAwayPdfLoading] = useState(false)
  const [homePdfError, setHomePdfError] = useState('')
  const [awayPdfError, setAwayPdfError] = useState('')
  const homeFileInputRef = useRef(null)
  const awayFileInputRef = useRef(null)

  // PDF import summary modal state
  const [importSummaryModal, setImportSummaryModal] = useState(null) // { team: 'home'|'away', players: number, errors: string[], benchOfficials: number }

  // Load Official Match modal state
  const [loadOfficialMatchModal, setLoadOfficialMatchModal] = useState(false)

  // Upload mode toggle state (local or remote)
  const [homeUploadMode, setHomeUploadMode] = useState('local') // 'local' | 'remote'
  const [awayUploadMode, setAwayUploadMode] = useState('local') // 'local' | 'remote'

  // Remote roster search state
  const [homeRosterSearching, setHomeRosterSearching] = useState(false)
  const [awayRosterSearching, setAwayRosterSearching] = useState(false)
  const [rosterPreview, setRosterPreview] = useState(null) // 'home' | 'away' | null

  // Referee selector state
  const [showRefereeSelector, setShowRefereeSelector] = useState(null) // 'ref1' | 'ref2' | null
  const [refereeSelectorPosition, setRefereeSelectorPosition] = useState({})
  const rosterLoadedRef = useRef(false) // Track if roster has been loaded to prevent overwriting user edits
  const homeTeamInputRef = useRef(null)
  const awayTeamInputRef = useRef(null)
  const homeTeamMeasureRef = useRef(null)
  const awayTeamMeasureRef = useRef(null)

  // Refs to store original state for discard on Back button
  const originalMatchInfoRef = useRef(null)
  const originalOfficialsRef = useRef(null)
  const originalHomeTeamRef = useRef(null)
  const originalAwayTeamRef = useRef(null)

  // Server state
  const [serverRunning, setServerRunning] = useState(false)
  const [serverStatus, setServerStatus] = useState(null)
  const [serverLoading, setServerLoading] = useState(false)
  const [instanceId] = useState(() => `instance-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)

  // Sync status tracking for cards
  // 'idle' = no sync needed, 'syncing' = sync in progress, 'synced' = synced successfully, 'error' = sync failed
  const [matchInfoSyncStatus, setMatchInfoSyncStatus] = useState('idle')
  const [officialsSyncStatus, setOfficialsSyncStatus] = useState('idle')
  const [homeTeamSyncStatus, setHomeTeamSyncStatus] = useState('idle')
  const [awayTeamSyncStatus, setAwayTeamSyncStatus] = useState('idle')
  const [isSupabaseAvailable, setIsSupabaseAvailable] = useState(false)

  // All 162 municipalities (Gemeinden) of Kanton Zürich
  const citiesZurich = [
    // Bezirk Affoltern
    'Aeugst am Albis', 'Affoltern am Albis', 'Bonstetten', 'Hausen am Albis', 'Hedingen',
    'Kappel am Albis', 'Knonau', 'Maschwanden', 'Mettmenstetten', 'Obfelden', 'Ottenbach',
    'Rifferswil', 'Stallikon', 'Wettswil am Albis',
    // Bezirk Andelfingen
    'Adlikon', 'Andelfingen', 'Benken', 'Berg am Irchel', 'Buch am Irchel', 'Dachsen',
    'Dorf', 'Feuerthalen', 'Flaach', 'Flurlingen', 'Henggart', 'Humlikon', 'Kleinandelfingen',
    'Laufen-Uhwiesen', 'Marthalen', 'Oberstammheim', 'Ossingen', 'Rheinau',
    'Thalheim an der Thur', 'Trüllikon', 'Truttikon', 'Unterstammheim', 'Volken',
    // Bezirk Bülach
    'Bachenbülach', 'Bassersdorf', 'Bülach', 'Dietlikon', 'Eglisau', 'Embrach',
    'Freienstein-Teufen', 'Glattfelden', 'Hochfelden', 'Höri', 'Hüntwangen', 'Kloten',
    'Lufingen', 'Nürensdorf', 'Oberembrach', 'Opfikon', 'Rafz', 'Rorbas', 'Wallisellen',
    'Wasterkingen', 'Wil', 'Winkel',
    // Bezirk Dielsdorf
    'Bachs', 'Buchs', 'Dällikon', 'Dänikon', 'Dielsdorf', 'Hüttikon', 'Neerach',
    'Niederglatt', 'Niederhasli', 'Niederweningen', 'Oberglatt', 'Oberweningen',
    'Otelfingen', 'Regensdorf', 'Rümlang', 'Schleinikon', 'Schöfflisdorf', 'Stadel',
    'Steinmaur', 'Weiach',
    // Bezirk Dietikon
    'Aesch', 'Birmensdorf', 'Dietikon', 'Geroldswil', 'Oberengstringen',
    'Oetwil an der Limmat', 'Schlieren', 'Uitikon', 'Unterengstringen', 'Urdorf', 'Weiningen',
    // Bezirk Hinwil
    'Bäretswil', 'Bubikon', 'Dürnten', 'Fischenthal', 'Gossau', 'Grüningen', 'Hinwil',
    'Rüti', 'Seegräben', 'Wald', 'Wetzikon',
    // Bezirk Horgen
    'Adliswil', 'Hirzel', 'Horgen', 'Hütten', 'Kilchberg', 'Langnau am Albis',
    'Oberrieden', 'Richterswil', 'Rüschlikon', 'Schönenberg', 'Thalwil', 'Wädenswil',
    // Bezirk Meilen
    'Erlenbach', 'Herrliberg', 'Hombrechtikon', 'Küsnacht', 'Männedorf', 'Meilen',
    'Oetwil am See', 'Stäfa', 'Uetikon am See', 'Zollikon', 'Zumikon',
    // Bezirk Pfäffikon
    'Bauma', 'Fehraltorf', 'Hittnau', 'Illnau-Effretikon', 'Kyburg', 'Lindau',
    'Pfäffikon', 'Russikon', 'Weisslingen', 'Wila', 'Wildberg',
    // Bezirk Uster
    'Dübendorf', 'Egg', 'Fällanden', 'Greifensee', 'Maur', 'Mönchaltorf',
    'Schwerzenbach', 'Uster', 'Volketswil',
    // Bezirk Winterthur
    'Altikon', 'Brütten', 'Dättlikon', 'Dinhard', 'Elgg', 'Ellikon an der Thur',
    'Elsau', 'Hagenbuch', 'Hettlingen', 'Hofstetten', 'Neftenbach', 'Pfungen',
    'Rickenbach', 'Schlatt', 'Seuzach', 'Turbenthal', 'Wiesendangen', 'Winterthur', 'Zell',
    // Bezirk Zürich
    'Zürich'
  ].sort()

  // Grouped by color families: whites/grays, reds, oranges, yellows, greens, blues, purples, pinks, teals
  const teamColors = [
    '#FFFFFF', // White
    '#000000', // Black
    '#808080', // Gray
    '#dc2626', // Red
    '#f97316', // Orange
    '#eab308', // Yellow
    '#22c55e', // Light Green
    '#065f46', // Dark Green
    '#3b82f6', // Light Blue
    '#1e3a8a', // Dark Blue
    '#a855f7', // Purple
    '#ec4899'  // Pink
  ]

  const homeCounts = {
    players: homeRoster.length,
    liberos: homeRoster.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length,
    bench: benchHome.filter(m => m.firstName || m.lastName || m.dob).length,
    // For coin toss validation: check all players have numbers, has captain, has coach
    allPlayersHaveNumbers: homeRoster.every(p => p.number !== null && p.number !== undefined && p.number !== ''),
    hasCaptain: homeRoster.some(p => p.isCaptain),
    hasCoach: benchHome.some(m => m.role?.toLowerCase() === 'coach' && (m.firstName || m.lastName))
  }
  const awayCounts = {
    players: awayRoster.length,
    liberos: awayRoster.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length,
    bench: benchAway.filter(m => m.firstName || m.lastName || m.dob).length,
    // For coin toss validation: check all players have numbers, has captain, has coach
    allPlayersHaveNumbers: awayRoster.every(p => p.number !== null && p.number !== undefined && p.number !== ''),
    hasCaptain: awayRoster.some(p => p.isCaptain),
    hasCoach: benchAway.some(m => m.role?.toLowerCase() === 'coach' && (m.firstName || m.lastName))
  }

  // Signatures
  const [homeCoachSignature, setHomeCoachSignature] = useState(null)
  const [homeCaptainSignature, setHomeCaptainSignature] = useState(null)
  const [awayCoachSignature, setAwayCoachSignature] = useState(null)
  const [awayCaptainSignature, setAwayCaptainSignature] = useState(null)
  const [savedSignatures, setSavedSignatures] = useState({ homeCoach: null, homeCaptain: null, awayCoach: null, awayCaptain: null })

  // Check if coin toss was previously confirmed (all signatures match saved ones)
  const isCoinTossConfirmed = useMemo(() => {
    return homeCoachSignature && homeCaptainSignature && awayCoachSignature && awayCaptainSignature &&
      homeCoachSignature === savedSignatures.homeCoach &&
      homeCaptainSignature === savedSignatures.homeCaptain &&
      awayCoachSignature === savedSignatures.awayCoach &&
      awayCaptainSignature === savedSignatures.awayCaptain
  }, [homeCoachSignature, homeCaptainSignature, awayCoachSignature, awayCaptainSignature, savedSignatures])

  // Load match data if matchId is provided
  const match = useLiveQuery(async () => {
    if (!matchId) return null
    try {
      return await db.matches.get(matchId)
    } catch (error) {
      console.error('Unable to load match', error)
      return null
    }
  }, [matchId])

  const isMatchOngoing = match?.status === 'live'

  // Capture original state when entering a view (for discard on Back)
  useEffect(() => {
    if (currentView === 'info') {
      originalMatchInfoRef.current = {
        date, time, hall, city, type1, type1Other, championshipType, championshipTypeOther,
        type2, type3, type3Other, gameN, league, home, away, homeColor, awayColor, homeShortName, awayShortName
      }
    } else if (currentView === 'officials') {
      originalOfficialsRef.current = {
        ref1First, ref1Last, ref1Country, ref1Dob,
        ref2First, ref2Last, ref2Country, ref2Dob,
        scorerFirst, scorerLast, scorerCountry, scorerDob,
        asstFirst, asstLast, asstCountry, asstDob,
        lineJudge1, lineJudge2, lineJudge3, lineJudge4
      }
    } else if (currentView === 'home') {
      originalHomeTeamRef.current = {
        homeRoster: JSON.parse(JSON.stringify(homeRoster)),
        benchHome: JSON.parse(JSON.stringify(benchHome))
      }
    } else if (currentView === 'away') {
      originalAwayTeamRef.current = {
        awayRoster: JSON.parse(JSON.stringify(awayRoster)),
        benchAway: JSON.parse(JSON.stringify(benchAway))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView])

  // Clean up stale error jobs with legacy columns on mount
  useEffect(() => {
    const cleanupLegacyErrorJobs = async () => {
      try {
        const errorJobs = await db.sync_queue
          .where('status')
          .equals('error')
          .toArray()

        // Legacy columns that no longer exist in Supabase
        const legacyColumns = [
          'away_team_name', 'home_team_name', 'away_team_short_name', 'home_team_short_name',
          'home_short_name', 'away_short_name', 'coin_toss_confirmed', 'coin_toss_team_a',
          'coin_toss_team_b', 'coin_toss_serve_a', 'first_serve', 'referee_pin',
          'referee_connection_enabled', 'home_team_connection_enabled', 'away_team_connection_enabled'
        ]

        for (const job of errorJobs) {
          const payload = job.payload || {}
          const hasLegacyColumn = legacyColumns.some(col => col in payload)

          if (hasLegacyColumn) {
            console.log('[MatchSetup] Removing stale error job with legacy columns:', job.id)
            await db.sync_queue.delete(job.id)
          }
        }
      } catch (err) {
        console.debug('[MatchSetup] Error cleaning up legacy jobs:', err.message)
      }
    }

    cleanupLegacyErrorJobs()
  }, [])

  // Check Supabase availability and sync status periodically
  useEffect(() => {
    const checkSupabaseAndSyncStatus = async () => {
      // Check if Supabase is available
      if (!supabase) {
        setIsSupabaseAvailable(false)
        return
      }

      try {
        const { error } = await supabase.from('matches').select('id').limit(1)
        const available = !error
        setIsSupabaseAvailable(available)

        if (!available || !match?.seed_key) return

        // Check sync queue for pending items related to this match
        const queuedJobs = await db.sync_queue
          .where('status')
          .equals('queued')
          .toArray()

        const errorJobs = await db.sync_queue
          .where('status')
          .equals('error')
          .toArray()

        // Check for match-related sync jobs
        const matchJobs = [...queuedJobs, ...errorJobs].filter(
          j => j.resource === 'match' && (j.payload?.id === match.seed_key || j.payload?.external_id === match.seed_key)
        )

        const hasQueued = matchJobs.some(j => j.status === 'queued')
        const hasError = matchJobs.some(j => j.status === 'error')

        // Update sync statuses based on queue
        if (hasError) {
          setMatchInfoSyncStatus('error')
          setOfficialsSyncStatus('error')
          setHomeTeamSyncStatus('error')
          setAwayTeamSyncStatus('error')
        } else if (hasQueued) {
          setMatchInfoSyncStatus('syncing')
          setOfficialsSyncStatus('syncing')
          setHomeTeamSyncStatus('syncing')
          setAwayTeamSyncStatus('syncing')
        } else {
          // Check if match exists in Supabase
          const { data: supabaseMatch } = await supabase
            .from('matches')
            .select('id, status')
            .eq('external_id', match.seed_key)
            .maybeSingle()

          if (supabaseMatch) {
            setMatchInfoSyncStatus('synced')
            setOfficialsSyncStatus('synced')
            setHomeTeamSyncStatus('synced')
            setAwayTeamSyncStatus('synced')
          } else {
            setMatchInfoSyncStatus('idle')
            setOfficialsSyncStatus('idle')
            setHomeTeamSyncStatus('idle')
            setAwayTeamSyncStatus('idle')
          }
        }
      } catch (err) {
        console.debug('[MatchSetup] Error checking sync status:', err.message)
        setIsSupabaseAvailable(false)
      }
    }

    checkSupabaseAndSyncStatus()
    const interval = setInterval(checkSupabaseAndSyncStatus, 5000)
    return () => clearInterval(interval)
  }, [match?.seed_key])

  // Retry sync for a specific card type
  const retrySyncForCard = async (cardType) => {
    if (!match?.seed_key) return

    try {
      // Find error jobs for this match and reset them to queued
      const errorJobs = await db.sync_queue
        .where('status')
        .equals('error')
        .toArray()

      const matchErrorJobs = errorJobs.filter(
        j => j.resource === 'match' && (j.payload?.id === match.seed_key || j.payload?.external_id === match.seed_key)
      )

      // If there are error jobs, reset them
      if (matchErrorJobs.length > 0) {
        for (const job of matchErrorJobs) {
          await db.sync_queue.update(job.id, { status: 'queued', retry_count: 0 })
        }
      } else if (cardType === 'matchInfo') {
        // No error jobs - check if match exists in Supabase
        // If not, create a new match insert job
        const { data: supabaseMatch } = await supabase
          .from('matches')
          .select('id')
          .eq('external_id', match.seed_key)
          .maybeSingle()

        if (!supabaseMatch) {
          // Check if a match with the same game_n already exists (prevent duplicates)
          if (match.gameN) {
            const { data: existingByGameN } = await supabase
              .from('matches')
              .select('id, external_id')
              .eq('game_n', parseInt(match.gameN, 10))
              .maybeSingle()

            if (existingByGameN) {
              console.warn('[MatchSetup] Match with game_n already exists in Supabase:', match.gameN)
              setMatchInfoSyncStatus('error')
              return
            }
          }

          // Match doesn't exist in Supabase - create insert job
          const homeTeam = await db.teams.get(match.homeTeamId)
          const awayTeam = await db.teams.get(match.awayTeamId)

          await db.sync_queue.add({
            resource: 'match',
            action: 'insert',
            payload: {
              external_id: match.seed_key,
              status: match.status || 'setup',
              scheduled_at: match.scheduledAt || null,
              game_n: match.gameN ? parseInt(match.gameN, 10) : null,
              game_pin: match.gamePin || null,
              test: match.test || false,
              match_info: {
                hall: match.hall || '',
                city: match.city || '',
                league: match.league || '',
                championship_type: match.championshipType || '',
                championship_type_other: match.championshipTypeOther || '',
                match_type_1: match.match_type_1 || '',
                match_type_1_other: match.match_type_1_other || '',
                match_type_2: match.match_type_2 || '',
                match_type_3: match.match_type_3 || '',
                match_type_3_other: match.match_type_3_other || ''
              },
              home_team: {
                name: homeTeam?.name || home || t('common.home'),
                short_name: homeTeam?.shortName || match.homeShortName || generateShortName(homeTeam?.name || home || t('common.home')),
                color: homeTeam?.color || homeColor
              },
              away_team: {
                name: awayTeam?.name || away || t('common.away'),
                short_name: awayTeam?.shortName || match.awayShortName || generateShortName(awayTeam?.name || away || t('common.away')),
                color: awayTeam?.color || awayColor
              },
              bench_home: match.bench_home || benchHome || [],
              bench_away: match.bench_away || benchAway || []
            },
            ts: new Date().toISOString(),
            status: 'queued'
          })
          console.log('[MatchSetup] Created new match insert job for Supabase sync')
        }
      }

      // Set only the specific card status to syncing
      switch (cardType) {
        case 'matchInfo':
          setMatchInfoSyncStatus('syncing')
          break
        case 'officials':
          setOfficialsSyncStatus('syncing')
          break
        case 'home':
          setHomeTeamSyncStatus('syncing')
          break
        case 'away':
          setAwayTeamSyncStatus('syncing')
          break
        default:
          // If no specific card, sync all
          setMatchInfoSyncStatus('syncing')
          setOfficialsSyncStatus('syncing')
          setHomeTeamSyncStatus('syncing')
          setAwayTeamSyncStatus('syncing')
      }
    } catch (err) {
      console.error('[MatchSetup] Error retrying sync:', err)
    }
  }

  // Restore original state functions (for Back button)
  const restoreMatchInfo = () => {
    const o = originalMatchInfoRef.current
    if (!o) return
    setDate(o.date); setTime(o.time); setHall(o.hall); setCity(o.city)
    setType1(o.type1); setType1Other(o.type1Other); setChampionshipType(o.championshipType); setChampionshipTypeOther(o.championshipTypeOther)
    setType2(o.type2); setType3(o.type3); setType3Other(o.type3Other); setGameN(o.gameN); setLeague(o.league)
    setHome(o.home); setAway(o.away); setHomeColor(o.homeColor); setAwayColor(o.awayColor)
    setHomeShortName(o.homeShortName); setAwayShortName(o.awayShortName)
  }

  const restoreOfficials = () => {
    const o = originalOfficialsRef.current
    if (!o) return
    setRef1First(o.ref1First); setRef1Last(o.ref1Last); setRef1Country(o.ref1Country); setRef1Dob(o.ref1Dob)
    setRef2First(o.ref2First); setRef2Last(o.ref2Last); setRef2Country(o.ref2Country); setRef2Dob(o.ref2Dob)
    setScorerFirst(o.scorerFirst); setScorerLast(o.scorerLast); setScorerCountry(o.scorerCountry); setScorerDob(o.scorerDob)
    setAsstFirst(o.asstFirst); setAsstLast(o.asstLast); setAsstCountry(o.asstCountry); setAsstDob(o.asstDob)
    setLineJudge1(o.lineJudge1); setLineJudge2(o.lineJudge2); setLineJudge3(o.lineJudge3); setLineJudge4(o.lineJudge4)
  }

  const restoreHomeTeam = () => {
    const o = originalHomeTeamRef.current
    if (!o) return
    setHomeRoster(o.homeRoster)
    setBenchHome(o.benchHome)
  }

  const restoreAwayTeam = () => {
    const o = originalAwayTeamRef.current
    if (!o) return
    setAwayRoster(o.awayRoster)
    setBenchAway(o.benchAway)
  }

  // Load match data if matchId is provided
  // Split into two effects: one for initial load (matchId only), one for updates (match changes)

  // Initial load effect - only runs when matchId changes or when match becomes available
  useEffect(() => {
    if (!matchId) return
    if (!match) return // Wait for match to be loaded from useLiveQuery
    if (rosterLoadedRef.current) return // Already loaded for this matchId - don't reload to preserve user edits

    async function loadInitialData() {
      try {
        // Load teams
        const [homeTeam, awayTeam] = await Promise.all([
          match.homeTeamId ? db.teams.get(match.homeTeamId) : null,
          match.awayTeamId ? db.teams.get(match.awayTeamId) : null
        ])

        if (homeTeam) {
          setHome(homeTeam.name)
          setHomeColor(homeTeam.color || '#ef4444')
        }
        if (awayTeam) {
          setAway(awayTeam.name)
          setAwayColor(awayTeam.color || '#3b82f6')
        }

        const normalizeBenchMember = member => ({
          role: member?.role || '',
          firstName: member?.firstName || member?.first_name || '',
          lastName: member?.lastName || member?.last_name || '',
          dob: member?.dob || member?.date_of_birth || member?.dateOfBirth || ''
        })

        // For bench officials: only load if match has saved bench data
        // For brand new/empty matches, keep default (Coach only) - don't load from team.benchStaff
        const resolvedHomeBench = (() => {
          // Only load if match explicitly has bench_home data
          if (Array.isArray(match.bench_home) && match.bench_home.length > 0) {
            return match.bench_home.map(normalizeBenchMember)
          }
          // For new/empty matches, only show Coach (don't load from team.benchStaff)
          return [initBench('Coach')]
        })()

        const resolvedAwayBench = (() => {
          // Only load if match explicitly has bench_away data
          if (Array.isArray(match.bench_away) && match.bench_away.length > 0) {
            return match.bench_away.map(normalizeBenchMember)
          }
          // For new/empty matches, only show Coach (don't load from team.benchStaff)
          return [initBench('Coach')]
        })()

        setBenchHome(resolvedHomeBench)
        setBenchAway(resolvedAwayBench)

        // Update input widths when teams are loaded - use the actual loaded team names
        setTimeout(() => {
          if (homeTeamMeasureRef.current && homeTeamInputRef.current) {
            const currentValue = homeTeam?.name || home || 'Home team name'
            homeTeamMeasureRef.current.textContent = currentValue
            const measuredWidth = homeTeamMeasureRef.current.offsetWidth
            homeTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
          }
          if (awayTeamMeasureRef.current && awayTeamInputRef.current) {
            const currentValue = awayTeam?.name || away || 'Away team name'
            awayTeamMeasureRef.current.textContent = currentValue
            const measuredWidth = awayTeamMeasureRef.current.offsetWidth
            awayTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
          }
        }, 100)

        // Load match info - use safe parser to handle invalid dates
        if (match.scheduledAt) {
          const parsed = safeParseScheduledAt(match.scheduledAt)
          if (parsed.date) setDate(parsed.date)
          if (parsed.time) setTime(parsed.time)
        }
        if (match.hall) setHall(match.hall)
        if (match.city) setCity(match.city)
        if (match.league) setLeague(match.league)
        if (match.match_type_1) setType1(match.match_type_1)
        if (match.match_type_1_other) setType1Other(match.match_type_1_other)
        if (match.championshipType) setChampionshipType(match.championshipType)
        if (match.championshipTypeOther) setChampionshipTypeOther(match.championshipTypeOther)
        if (match.match_type_2) setType2(match.match_type_2)
        if (match.match_type_3) setType3(match.match_type_3)
        if (match.match_type_3_other) setType3Other(match.match_type_3_other)
        // The placeholder will show a suggestion, but won't auto-fill a value
        if (match.homeShortName && match.homeShortName.trim()) {
          setHomeShortName(match.homeShortName)
        }
        if (match.awayShortName && match.awayShortName.trim()) {
          setAwayShortName(match.awayShortName)
        }
        if (match.game_n) setGameN(String(match.game_n))
        else if (match.gameNumber) setGameN(String(match.gameNumber))

        // Generate PINs if they don't exist (for matches created before PIN feature)
        const generatePinCode = (existingPins = []) => {
          const chars = '0123456789'
          let pin = ''
          let attempts = 0
          const maxAttempts = 100

          do {
            pin = ''
            for (let i = 0; i < 6; i++) {
              pin += chars.charAt(Math.floor(Math.random() * chars.length))
            }
            attempts++
            if (attempts >= maxAttempts) {
              // If we can't generate a unique PIN after many attempts, just return this one
              break
            }
          } while (existingPins.includes(pin))

          return pin
        }

        const updates = {}
        const existingPins = []
        if (!match.refereePin) {
          const refPin = generatePinCode(existingPins)
          updates.refereePin = String(refPin).trim() // Ensure string
          existingPins.push(String(refPin).trim())
        } else {
          existingPins.push(String(match.refereePin).trim())
        }
        if (!match.homeTeamPin) {
          const homePin = generatePinCode(existingPins)
          updates.homeTeamPin = String(homePin).trim() // Ensure string
          existingPins.push(String(homePin).trim())
        } else {
          existingPins.push(String(match.homeTeamPin).trim())
        }
        if (!match.awayTeamPin) {
          const awayPin = generatePinCode(existingPins)
          updates.awayTeamPin = String(awayPin).trim() // Ensure string
          existingPins.push(String(awayPin).trim())
        } else {
          existingPins.push(String(match.awayTeamPin).trim())
        }
        if (!match.homeTeamUploadPin) {
          const homeUploadPin = generatePinCode(existingPins)
          updates.homeTeamUploadPin = homeUploadPin
          existingPins.push(homeUploadPin)
        } else {
          existingPins.push(match.homeTeamUploadPin)
        }
        if (!match.awayTeamUploadPin) {
          const awayUploadPin = generatePinCode(existingPins)
          updates.awayTeamUploadPin = awayUploadPin
        }
        if (Object.keys(updates).length > 0) {
          await db.matches.update(matchId, updates)
        }

        // Always sync upload PINs to Supabase if connected (whether newly generated or existing)
        // This ensures existing local PINs get pushed to Supabase
        if (supabase && match.seed_key) {
          const homeUploadPin = updates.homeTeamUploadPin || match.homeTeamUploadPin
          const awayUploadPin = updates.awayTeamUploadPin || match.awayTeamUploadPin
          if (homeUploadPin || awayUploadPin) {
            try {
              // Fetch existing connection_pins to merge (use maybeSingle to avoid 406 if match not synced yet)
              const { data: existingMatch } = await supabase
                .from('matches')
                .select('connection_pins')
                .eq('external_id', match.seed_key)
                .maybeSingle()

              // Only update if match exists in Supabase
              if (existingMatch) {
                const connectionPinsUpdate = {
                  ...(existingMatch.connection_pins || {}),
                  ...(homeUploadPin ? { upload_home: homeUploadPin } : {}),
                  ...(awayUploadPin ? { upload_away: awayUploadPin } : {})
                }

                await supabase
                  .from('matches')
                  .update({ connection_pins: connectionPinsUpdate })
                  .eq('external_id', match.seed_key)
                console.log('[MatchSetup] Synced upload PINs to Supabase connection_pins:', connectionPinsUpdate)
              }
            } catch (err) {
              console.warn('[MatchSetup] Failed to sync upload PINs to Supabase:', err)
            }
          }
        }

        // Load players only on initial load (when matchId changes, not when match updates)
        // Skip if roster was already loaded from draft (to preserve user edits like number/captain changes)
        if (match.homeTeamId && !rosterLoadedFromDraft.current.home) {
          const homePlayers = await db.players.where('teamId').equals(match.homeTeamId).sortBy('number')
          setHomeRoster(homePlayers.map(p => ({
            id: p.id, // Store player ID for updates
            number: p.number,
            firstName: p.firstName || '',
            lastName: p.lastName || p.name || '',
            dob: p.dob || '',
            libero: p.libero || '',
            isCaptain: p.isCaptain || false,
            isLfp: p.isLfp || false
          })))
        }
        if (match.awayTeamId && !rosterLoadedFromDraft.current.away) {
          const awayPlayers = await db.players.where('teamId').equals(match.awayTeamId).sortBy('number')
          setAwayRoster(awayPlayers.map(p => ({
            id: p.id, // Store player ID for updates
            number: p.number,
            firstName: p.firstName || '',
            lastName: p.lastName || p.name || '',
            dob: p.dob || '',
            libero: p.libero || '',
            isCaptain: p.isCaptain || false,
            isLfp: p.isLfp || false
          })))
        }

        // Load referee connection setting (default to disabled if not set)
        setRefereeConnectionEnabled(match.refereeConnectionEnabled === true)

        // Load bench connection settings (default to disabled if not set)
        // Support both old (separate home/away) and new (combined) fields
        const isBenchEnabled = match.benchConnectionEnabled === true ||
          (match.homeTeamConnectionEnabled === true && match.awayTeamConnectionEnabled === true)
        setBenchConnectionEnabled(isBenchEnabled)
        setHomeTeamConnectionEnabled(match.homeTeamConnectionEnabled === true)
        setAwayTeamConnectionEnabled(match.awayTeamConnectionEnabled === true)

        // Migrate old matches: ensure connection fields are explicitly set to false if undefined
        const connectionUpdates = {}
        if (match.refereeConnectionEnabled === undefined) connectionUpdates.refereeConnectionEnabled = false
        if (match.benchConnectionEnabled === undefined) connectionUpdates.benchConnectionEnabled = false
        if (Object.keys(connectionUpdates).length > 0) {
          await db.matches.update(matchId, connectionUpdates)
        }

        // Mark roster as loaded
        rosterLoadedRef.current = true

        // Bench officials are already loaded above via resolvedHomeBench/resolvedAwayBench
        // This section is kept for backward compatibility but should not override if already set

        // Load match officials
        if (match.officials && match.officials.length > 0) {
          const ref1 = match.officials.find(o => o.role === '1st referee')
          if (ref1) {
            setRef1First(ref1.firstName || '')
            setRef1Last(ref1.lastName || '')
            setRef1Country(ref1.country || 'CHE')
            setRef1Dob(ref1.dob || '01.01.1900')
          }
          const ref2 = match.officials.find(o => o.role === '2nd referee')
          if (ref2) {
            setRef2First(ref2.firstName || '')
            setRef2Last(ref2.lastName || '')
            setRef2Country(ref2.country || 'CHE')
            setRef2Dob(ref2.dob || '01.01.1900')
          }
          const scorer = match.officials.find(o => o.role === 'scorer')
          if (scorer) {
            setScorerFirst(scorer.firstName || '')
            setScorerLast(scorer.lastName || '')
            setScorerCountry(scorer.country || 'CHE')
            setScorerDob(scorer.dob || '01.01.1900')
          }
          const asst = match.officials.find(o => o.role === 'assistant scorer')
          if (asst) {
            setAsstFirst(asst.firstName || '')
            setAsstLast(asst.lastName || '')
            setAsstCountry(asst.country || 'CHE')
            setAsstDob(asst.dob || '01.01.1900')
          }
          // Load line judges
          const lj1 = match.officials.find(o => o.role === 'line judge 1')
          if (lj1) setLineJudge1(lj1.name || '')
          const lj2 = match.officials.find(o => o.role === 'line judge 2')
          if (lj2) setLineJudge2(lj2.name || '')
          const lj3 = match.officials.find(o => o.role === 'line judge 3')
          if (lj3) setLineJudge3(lj3.name || '')
          const lj4 = match.officials.find(o => o.role === 'line judge 4')
          if (lj4) setLineJudge4(lj4.name || '')
        }

        // Load signatures
        if (match.homeCoachSignature) {
          setHomeCoachSignature(match.homeCoachSignature)
          setSavedSignatures(prev => ({ ...prev, homeCoach: match.homeCoachSignature }))
        }
        if (match.homeCaptainSignature) {
          setHomeCaptainSignature(match.homeCaptainSignature)
          setSavedSignatures(prev => ({ ...prev, homeCaptain: match.homeCaptainSignature }))
        }
        if (match.awayCoachSignature) {
          setAwayCoachSignature(match.awayCoachSignature)
          setSavedSignatures(prev => ({ ...prev, awayCoach: match.awayCoachSignature }))
        }
        if (match.awayCaptainSignature) {
          setAwayCaptainSignature(match.awayCaptainSignature)
          setSavedSignatures(prev => ({ ...prev, awayCaptain: match.awayCaptainSignature }))
        }

        // Note: Coin toss data is loaded and managed by CoinToss.jsx component

        // If match was explicitly confirmed (user clicked "Create Match"), restore that state
        // This flag is set in confirmMatchInfo and persisted in the database
        // We check matchInfoConfirmedAt instead of just team IDs to prevent auto-confirm
        // when auto-save creates teams before user explicitly confirms
        if (match.matchInfoConfirmedAt && homeTeam && awayTeam) {
          setMatchInfoConfirmed(true)
        }
      } catch (error) {
        console.error('Error loading initial match data:', error)
      }
    }

    loadInitialData()
  }, [matchId, match]) // Depend on both matchId and match - but only load once per matchId due to rosterLoadedRef check

  // Reset roster loaded flag when matchId changes
  useEffect(() => {
    rosterLoadedRef.current = false
  }, [matchId])

  // Update effect - runs when match changes (for connection settings, etc.)
  useEffect(() => {
    if (!matchId || !match) return

    // Update connection settings (these can change without affecting roster)
    // Default to disabled if not explicitly enabled
    setRefereeConnectionEnabled(match.refereeConnectionEnabled === true)
    const isBenchEnabled = match.benchConnectionEnabled === true ||
      (match.homeTeamConnectionEnabled === true && match.awayTeamConnectionEnabled === true)
    setBenchConnectionEnabled(isBenchEnabled)
    setHomeTeamConnectionEnabled(match.homeTeamConnectionEnabled === true)
    setAwayTeamConnectionEnabled(match.awayTeamConnectionEnabled === true)
  }, [matchId, match?.refereeConnectionEnabled, match?.benchConnectionEnabled, match?.homeTeamConnectionEnabled, match?.awayTeamConnectionEnabled])

  // Auto-fill scorer fields from logged-in user profile
  // Only applies when scorer fields are empty (new match or scorer not yet set)
  useEffect(() => {
    // Get profile from context or fall back to cached profile for offline use
    const userProfile = profile || getCachedProfile()
    if (!userProfile) return

    // Only auto-fill if scorer fields are currently empty
    // This ensures we don't overwrite data loaded from an existing match
    if (scorerFirst || scorerLast) return

    // Auto-fill scorer info from user profile
    if (userProfile.first_name) setScorerFirst(userProfile.first_name)
    if (userProfile.last_name) setScorerLast(userProfile.last_name)
    if (userProfile.country) setScorerCountry(userProfile.country)
    if (userProfile.dob) {
      // Convert ISO date (YYYY-MM-DD) to DD.MM.YYYY format used by the app
      const dobParts = userProfile.dob.split('-')
      if (dobParts.length === 3) {
        setScorerDob(`${dobParts[2]}.${dobParts[1]}.${dobParts[0]}`)
      }
    }
  }, [profile, scorerFirst, scorerLast])

  // Server management - Only check in Electron
  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && window.electronAPI?.server

    // Only check server status in Electron mode
    if (!isElectron) {
      return
    }

    const checkServerStatus = async () => {
      try {
        const status = await window.electronAPI.server.getStatus()
        setServerStatus(status)
        setServerRunning(status.running)
      } catch (err) {
        setServerRunning(false)
      }
    }

    checkServerStatus()
    const interval = setInterval(checkServerStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleStartServer = async () => {
    const isElectron = typeof window !== 'undefined' && window.electronAPI?.server

    if (!isElectron) {
      // In browser/PWA - show instructions via copy button
      try {
        const command = 'npm run start:prod'
        await navigator.clipboard.writeText(command)
        setNoticeModal({ message: t('matchSetup.commandCopied') })
      } catch (err) {
        // Fallback if clipboard API not available
        const textArea = document.createElement('textarea')
        textArea.value = 'npm run start:prod'
        textArea.style.position = 'fixed'
        textArea.style.opacity = '0'
        document.body.appendChild(textArea)
        textArea.select()
        try {
          document.execCommand('copy')
          setNoticeModal({ message: t('matchSetup.commandCopied') })
        } catch (e) {
          setNoticeModal({ message: t('matchSetup.pleaseRunManually') })
        }
        document.body.removeChild(textArea)
      }
      return
    }

    setServerLoading(true)
    try {
      const result = await window.electronAPI.server.start({ https: true })
      if (result.success) {
        setServerStatus(result.status)
        setServerRunning(true)
        // Register as main instance
        await registerAsMainInstance()
      } else {
        setNoticeModal({ message: t('matchSetup.serverStartFailed', { error: result.error }) })
      }
    } catch (error) {
      setNoticeModal({ message: t('matchSetup.serverStartError', { error: error.message }) })
    } finally {
      setServerLoading(false)
    }
  }

  const handleStopServer = async () => {
    setServerLoading(true)
    try {
      const isElectron = typeof window !== 'undefined' && window.electronAPI?.server

      if (isElectron) {
        const result = await window.electronAPI.server.stop()
        if (result.success) {
          setServerRunning(false)
          setServerStatus(null)
        }
      }
    } catch (error) {
      setNoticeModal({ message: t('matchSetup.serverStopError', { error: error.message }) })
    } finally {
      setServerLoading(false)
    }
  }

  const registerAsMainInstance = async () => {
    if (!serverStatus) return

    try {
      const protocol = serverStatus.protocol || 'https'
      const host = serverStatus.localIP || serverStatus.hostname || 'escoresheet.local'
      const port = serverStatus.port || 5173
      const url = `${protocol}://${host}:${port}/api/server/register-main`

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Instance-ID': instanceId,
          'Content-Type': 'application/json'
        }
      })

      if (response.ok) {
        const result = await response.json()
        if (!result.success) {
          console.warn('Failed to register as main instance:', result.error)
        } else {
          console.log('Registered as main instance:', instanceId)
        }
      } else {
        console.warn('Failed to register as main instance: HTTP', response.status)
      }
    } catch (error) {
      console.error('Error registering as main instance:', error)
    }
  }

  // Register as main instance when match starts
  useEffect(() => {
    if (serverRunning && serverStatus && matchId) {
      registerAsMainInstance()
    }
  }, [serverRunning, serverStatus, matchId, instanceId])

  // Load saved draft data on mount (only if no matchId)
  useEffect(() => {
    if (matchId) return // Skip draft loading if matchId is provided

    async function loadDraft() {
      try {
        const draft = await db.match_setup.orderBy('updatedAt').last()
        if (draft) {
          if (draft.home !== undefined) setHome(draft.home)
          if (draft.away !== undefined) setAway(draft.away)
          if (draft.date !== undefined) setDate(draft.date)
          if (draft.time !== undefined) setTime(draft.time)
          if (draft.hall !== undefined) setHall(draft.hall)
          if (draft.city !== undefined) setCity(draft.city)
          if (draft.type1 !== undefined) setType1(draft.type1)
          if (draft.type1Other !== undefined) setType1Other(draft.type1Other)
          if (draft.championshipType !== undefined) setChampionshipType(draft.championshipType)
          if (draft.championshipTypeOther !== undefined) setChampionshipTypeOther(draft.championshipTypeOther)
          if (draft.type2 !== undefined) setType2(draft.type2)
          if (draft.type3 !== undefined) setType3(draft.type3)
          if (draft.type3Other !== undefined) setType3Other(draft.type3Other)
          if (draft.homeShortName !== undefined) setHomeShortName(draft.homeShortName)
          if (draft.awayShortName !== undefined) setAwayShortName(draft.awayShortName)
          if (draft.gameN !== undefined) setGameN(draft.gameN)
          if (draft.league !== undefined) setLeague(draft.league)
          if (draft.homeColor !== undefined) setHomeColor(draft.homeColor)
          if (draft.awayColor !== undefined) setAwayColor(draft.awayColor)
          if (draft.homeRoster !== undefined && draft.homeRoster.length > 0) {
            setHomeRoster(draft.homeRoster)
            rosterLoadedFromDraft.current.home = true
          }
          if (draft.awayRoster !== undefined && draft.awayRoster.length > 0) {
            setAwayRoster(draft.awayRoster)
            rosterLoadedFromDraft.current.away = true
          }
          if (draft.benchHome !== undefined) setBenchHome(draft.benchHome)
          if (draft.benchAway !== undefined) setBenchAway(draft.benchAway)
          if (draft.ref1First !== undefined) setRef1First(draft.ref1First)
          if (draft.ref1Last !== undefined) setRef1Last(draft.ref1Last)
          if (draft.ref1Country !== undefined) setRef1Country(draft.ref1Country)
          if (draft.ref1Dob !== undefined) setRef1Dob(draft.ref1Dob)
          if (draft.ref2First !== undefined) setRef2First(draft.ref2First)
          if (draft.ref2Last !== undefined) setRef2Last(draft.ref2Last)
          if (draft.ref2Country !== undefined) setRef2Country(draft.ref2Country)
          if (draft.ref2Dob !== undefined) setRef2Dob(draft.ref2Dob)
          if (draft.scorerFirst !== undefined) setScorerFirst(draft.scorerFirst)
          if (draft.scorerLast !== undefined) setScorerLast(draft.scorerLast)
          if (draft.scorerCountry !== undefined) setScorerCountry(draft.scorerCountry)
          if (draft.scorerDob !== undefined) setScorerDob(draft.scorerDob)
          if (draft.asstFirst !== undefined) setAsstFirst(draft.asstFirst)
          if (draft.asstLast !== undefined) setAsstLast(draft.asstLast)
          if (draft.asstCountry !== undefined) setAsstCountry(draft.asstCountry)
          if (draft.asstDob !== undefined) setAsstDob(draft.asstDob)
          if (draft.homeCoachSignature !== undefined) setHomeCoachSignature(draft.homeCoachSignature)
          if (draft.homeCaptainSignature !== undefined) setHomeCaptainSignature(draft.homeCaptainSignature)
          if (draft.awayCoachSignature !== undefined) setAwayCoachSignature(draft.awayCoachSignature)
          if (draft.awayCaptainSignature !== undefined) setAwayCaptainSignature(draft.awayCaptainSignature)
        }
      } catch (error) {
        console.error('Error loading draft:', error)
      }
    }
    loadDraft()
  }, [matchId])

  // Save draft data to database
  async function saveDraft(silent = false) {
    try {
      const draft = {
        home,
        away,
        date,
        time,
        hall,
        city,
        type1,
        type1Other,
        championshipType,
        championshipTypeOther,
        type2,
        type3,
        type3Other,
        gameN,
        league,
        homeColor,
        awayColor,
        homeShortName,
        awayShortName,
        homeRoster,
        awayRoster,
        benchHome,
        benchAway,
        ref1First,
        ref1Last,
        ref1Country,
        ref1Dob,
        ref2First,
        ref2Last,
        ref2Country,
        ref2Dob,
        scorerFirst,
        scorerLast,
        scorerCountry,
        scorerDob,
        asstFirst,
        asstLast,
        asstCountry,
        asstDob,
        homeCoachSignature,
        homeCaptainSignature,
        awayCoachSignature,
        awayCaptainSignature,
        updatedAt: new Date().toISOString()
      }
      // Get existing draft or create new one
      const existing = await db.match_setup.orderBy('updatedAt').last()
      if (existing) {
        await db.match_setup.update(existing.id, draft)
      } else {
        await db.match_setup.add(draft)
      }

      // Also update the actual match record if matchId exists
      if (matchId) {
        let scheduledAt = match?.scheduledAt // Default to existing value

        // Only validate date/time if at least one is set
        if (date || time) {
          try {
            scheduledAt = createScheduledAt(date, time, { allowEmpty: true })
          } catch (err) {
            // For silent saves, just log and use existing value
            // For explicit saves, show error to user
            if (!silent) {
              console.error('[MatchSetup] Date/time validation error:', err.message)
              setNoticeModal({ message: t('matchSetup.invalidDateTime', { error: err.message }) })
              return // Don't save with invalid data
            }
            console.warn('[MatchSetup] Auto-save skipping invalid date/time:', err.message)
          }
        }

        // Build update object - only include match type fields if match info is confirmed
        // This prevents auto-save from writing default values before user has explicitly confirmed
        const matchUpdate = {
          hall,
          city,
          homeShortName: homeShortName || home.substring(0, 8).toUpperCase(),
          awayShortName: awayShortName || away.substring(0, 8).toUpperCase(),
          game_n: gameN ? Number(gameN) : null,
          gameNumber: gameN ? gameN : null,
          league,
          gamePin: match && !match.test ? (match.gamePin || (() => {
            // Auto-generate gamePin if it doesn't exist
            const chars = '0123456789'
            let pin = ''
            for (let i = 0; i < 6; i++) {
              pin += chars.charAt(Math.floor(Math.random() * chars.length))
            }
            return pin
          })()) : null,
          scheduledAt,
          officials: buildOfficialsArray(
            { firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: ref1Dob },
            { firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: ref2Dob },
            { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob },
            { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
            { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 }
          ),
          bench_home: benchHome,
          bench_away: benchAway
        }

        // Only save match type fields if explicitly saving OR match was previously confirmed
        // This prevents scoresheet from showing default Xs before user confirms match info
        if (!silent || match?.matchInfoConfirmedAt) {
          matchUpdate.match_type_1 = type1
          matchUpdate.match_type_1_other = type1 === 'other' ? type1Other : null
          matchUpdate.championshipType = championshipType
          matchUpdate.championshipTypeOther = championshipType === 'other' ? championshipTypeOther : null
          matchUpdate.match_type_2 = type2
          matchUpdate.match_type_3 = type3
          matchUpdate.match_type_3_other = type3 === 'other' ? type3Other : null
        }

        await db.matches.update(matchId, matchUpdate)

        // Update or create teams
        let homeTeamId = match?.homeTeamId
        let awayTeamId = match?.awayTeamId

        if (home && home.trim()) {
          if (homeTeamId) {
            // Update existing team
            await db.teams.update(homeTeamId, {
              name: home.trim(),
              color: homeColor,
              shortName: homeShortName || home.trim().substring(0, 8).toUpperCase(),
              benchStaff: benchHome
            })
          } else {
            // Create new team if it doesn't exist
            homeTeamId = await db.teams.add({
              name: home.trim(),
              color: homeColor,
              shortName: homeShortName || home.trim().substring(0, 8).toUpperCase(),
              benchStaff: benchHome,
              createdAt: new Date().toISOString()
            })
            // Update match with new team ID
            await db.matches.update(matchId, { homeTeamId })
          }
        }

        if (away && away.trim()) {
          if (awayTeamId) {
            // Update existing team
            await db.teams.update(awayTeamId, {
              name: away.trim(),
              color: awayColor,
              shortName: awayShortName || away.trim().substring(0, 8).toUpperCase(),
              benchStaff: benchAway
            })
          } else {
            // Create new team if it doesn't exist
            awayTeamId = await db.teams.add({
              name: away.trim(),
              color: awayColor,
              shortName: awayShortName || away.trim().substring(0, 8).toUpperCase(),
              benchStaff: benchAway,
              createdAt: new Date().toISOString()
            })
            // Update match with new team ID
            await db.matches.update(matchId, { awayTeamId })
          }
        }
      }

      return true
    } catch (error) {
      console.error('Error saving draft:', error)
      if (!silent) {
        setNoticeModal({ message: t('matchSetup.errorSavingData') })
      }
      return false
    }
  }

  // Auto-save when data changes (debounced)
  useEffect(() => {
    if (currentView === 'main' || currentView === 'info' || currentView === 'officials' || currentView === 'home' || currentView === 'away') {
      const timeoutId = setTimeout(() => {
        saveDraft(true) // Silent auto-save
      }, 500) // Debounce 500ms

      return () => clearTimeout(timeoutId)
    }
  }, [date, time, hall, city, type1, type1Other, championshipType, championshipTypeOther, type2, type3, type3Other, gameN, league, home, away, homeColor, awayColor, homeShortName, awayShortName, homeRoster, awayRoster, benchHome, benchAway, ref1First, ref1Last, ref1Country, ref1Dob, ref2First, ref2Last, ref2Country, ref2Dob, scorerFirst, scorerLast, scorerCountry, scorerDob, asstFirst, asstLast, asstCountry, asstDob, homeCoachSignature, homeCaptainSignature, awayCoachSignature, awayCaptainSignature, currentView])

  // Update input widths when home/away values change - set default width based on content
  useEffect(() => {
    if (homeTeamMeasureRef.current && homeTeamInputRef.current) {
      const currentValue = home || 'Home team name'
      homeTeamMeasureRef.current.textContent = currentValue
      const measuredWidth = homeTeamMeasureRef.current.offsetWidth
      // Always set width based on content, not just on focus
      homeTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
    }
  }, [home, currentView]) // Also update when view changes (e.g., going back)

  useEffect(() => {
    if (awayTeamMeasureRef.current && awayTeamInputRef.current) {
      const currentValue = away || 'Away team name'
      awayTeamMeasureRef.current.textContent = currentValue
      const measuredWidth = awayTeamMeasureRef.current.offsetWidth
      // Always set width based on content, not just on focus
      awayTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
    }
  }, [away, currentView]) // Also update when view changes (e.g., going back)

  // Set initial width when returning to main view to ensure width is correct
  useEffect(() => {
    if (currentView === 'main') {
      // Small delay to ensure refs are available after view change
      const timeoutId = setTimeout(() => {
        if (homeTeamMeasureRef.current && homeTeamInputRef.current) {
          const currentValue = home || 'Home team name'
          homeTeamMeasureRef.current.textContent = currentValue
          const measuredWidth = homeTeamMeasureRef.current.offsetWidth
          homeTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
        }
        if (awayTeamMeasureRef.current && awayTeamInputRef.current) {
          const currentValue = away || 'Away team name'
          awayTeamMeasureRef.current.textContent = currentValue
          const measuredWidth = awayTeamMeasureRef.current.offsetWidth
          awayTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
        }
      }, 50)
      return () => clearTimeout(timeoutId)
    }
  }, [currentView, home, away])

  // Update input widths when home/away values change (e.g., when loaded from match)
  useEffect(() => {
    if (currentView === 'main') {
      const timeoutId = setTimeout(() => {
        if (homeTeamMeasureRef.current && homeTeamInputRef.current && home) {
          homeTeamMeasureRef.current.textContent = home
          const measuredWidth = homeTeamMeasureRef.current.offsetWidth
          homeTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
        }
        if (awayTeamMeasureRef.current && awayTeamInputRef.current && away) {
          awayTeamMeasureRef.current.textContent = away
          const measuredWidth = awayTeamMeasureRef.current.offsetWidth
          awayTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
        }
      }, 100)
      return () => clearTimeout(timeoutId)
    }
  }, [home, away, currentView])

  // Helper function to determine if a color is bright/light
  function isBrightColor(color) {
    if (!color || color === 'image.png') return false
    // Convert hex to RGB
    const hex = color.replace('#', '')
    const r = parseInt(hex.substr(0, 2), 16)
    const g = parseInt(hex.substr(2, 2), 16)
    const b = parseInt(hex.substr(4, 2), 16)
    // Calculate luminance
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    return luminance > 0.5
  }

  // Helper function to get contrasting color (white or black)
  function getContrastColor(color) {
    return isBrightColor(color) ? '#000000' : '#ffffff'
  }

  // Validate and set date with immediate feedback
  function handleDateChange(value) {
    setDate(value)
    if (!value) {
      setDateError('')
      return
    }
    // Validate format YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      setDateError(t('matchSetup.validation.invalidFormat'))
      return
    }
    const [year, month, day] = value.split('-').map(Number)
    if (year < 1900 || year > 2100) {
      setDateError(t('matchSetup.validation.invalidYear', { year }))
      return
    }
    if (month < 1 || month > 12) {
      setDateError(t('matchSetup.validation.invalidMonth', { month }))
      return
    }
    if (day < 1 || day > 31) {
      setDateError(t('matchSetup.validation.invalidDay', { day }))
      return
    }
    // Check if date is valid (e.g., Feb 30 is invalid)
    const dateObj = new Date(value)
    if (isNaN(dateObj.getTime()) || dateObj.getMonth() + 1 !== month) {
      setDateError(t('matchSetup.validation.invalidDate'))
      return
    }
    setDateError('')
  }

  // Validate and set time with immediate feedback
  function handleTimeChange(value) {
    setTime(value)
    if (!value) {
      setTimeError('')
      return
    }
    // Validate format HH:MM
    if (!/^\d{2}:\d{2}$/.test(value)) {
      setTimeError(t('matchSetup.validation.invalidFormat'))
      return
    }
    const [hours, minutes] = value.split(':').map(Number)
    if (hours < 0 || hours > 23) {
      setTimeError(t('matchSetup.validation.invalidHour', { hour: hours }))
      return
    }
    if (minutes < 0 || minutes > 59) {
      setTimeError(t('matchSetup.validation.invalidMinutes', { minutes }))
      return
    }
    setTimeError('')
  }

  // Confirm match info - validates all required fields and creates/updates match
  async function confirmMatchInfo() {
    // Track if this is a create or update operation
    const isCreating = !matchInfoConfirmed

    // Validate required fields
    if (!home || !home.trim()) {
      setNoticeModal({ message: t('matchSetup.homeTeamNameRequired') })
      return
    }
    if (!away || !away.trim()) {
      setNoticeModal({ message: t('matchSetup.awayTeamNameRequired') })
      return
    }
    if (dateError) {
      setNoticeModal({ message: t('matchSetup.invalidDate', { error: dateError }) })
      return
    }
    if (timeError) {
      setNoticeModal({ message: t('matchSetup.invalidTime', { error: timeError }) })
      return
    }

    // Check if any changes were made (skip sync if no changes)
    const currentMatchInfo = {
      date, time, hall, city, type1, type1Other, championshipType, championshipTypeOther,
      type2, type3, type3Other, gameN, league, home, away, homeColor, awayColor, homeShortName, awayShortName
    }
    const hasChanges = isCreating || hasMatchInfoChanged(originalMatchInfoRef.current, currentMatchInfo)

    // If no changes, just go back to main view
    if (!hasChanges) {
      setCurrentView('main')
      return
    }

    try {
      // Create teams if they don't exist
      let homeTeamId = match?.homeTeamId
      let awayTeamId = match?.awayTeamId

      if (!homeTeamId) {
        homeTeamId = await db.teams.add({
          name: home.trim(),
          color: homeColor,
          shortName: homeShortName || home.trim().substring(0, 8).toUpperCase(),
          benchStaff: benchHome,
          createdAt: new Date().toISOString()
        })
      } else {
        // Update existing team
        await db.teams.update(homeTeamId, {
          name: home.trim(),
          color: homeColor,
          shortName: homeShortName || home.trim().substring(0, 8).toUpperCase(),
          benchStaff: benchHome
        })
      }

      if (!awayTeamId) {
        awayTeamId = await db.teams.add({
          name: away.trim(),
          color: awayColor,
          shortName: awayShortName || away.trim().substring(0, 8).toUpperCase(),
          benchStaff: benchAway,
          createdAt: new Date().toISOString()
        })
      } else {
        // Update existing team
        await db.teams.update(awayTeamId, {
          name: away.trim(),
          color: awayColor,
          shortName: awayShortName || away.trim().substring(0, 8).toUpperCase(),
          benchStaff: benchAway
        })
      }

      // Build scheduledAt if date is set
      let scheduledAt = null
      if (date) {
        scheduledAt = createScheduledAt(date, time, { allowEmpty: true })
      }

      // Generate seed_key if match doesn't have one (for older matches or matches created via other flows)
      // seed_key is the stable unique identifier used for Supabase sync (stored as external_id)
      // It never includes modifiable fields like gameN or scheduled_at
      let matchSeedKey = match?.seed_key
      if (!matchSeedKey) {
        matchSeedKey = generateMatchSeedKey()
      }

      // Update match with team IDs and match info
      // matchInfoConfirmedAt flag indicates user explicitly clicked "Create Match"
      await db.matches.update(matchId, {
        homeTeamId,
        awayTeamId,
        homeName: home.trim(),
        awayName: away.trim(),
        homeShortName: homeShortName || generateShortName(home.trim()),
        awayShortName: awayShortName || generateShortName(away.trim()),
        homeColor,
        awayColor,
        scheduledAt,
        hall: hall || null,
        city: city || null,
        league: league || null,
        match_type_1: type1 || null,
        match_type_1_other: type1Other || null,
        championshipType: championshipType || null,
        championshipTypeOther: championshipTypeOther || null,
        match_type_2: type2 || null,
        match_type_3: type3 || null,
        match_type_3_other: type3Other || null,
        sport_type: 'indoor',
        game_n: gameN ? parseInt(gameN, 10) : null,
        seed_key: matchSeedKey, // Ensure seed_key is set
        bench_home: benchHome,
        bench_away: benchAway,
        matchInfoConfirmedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      // Queue match for Supabase sync - all data stored as JSONB
      // Only set status to 'setup' when creating a new match, not when updating existing match
      // to avoid resetting 'live' status back to 'setup'
      const syncPayload = {
        external_id: matchSeedKey,
        scheduled_at: scheduledAt || null,
        game_n: gameN ? parseInt(gameN, 10) : null,
        game_pin: match?.gamePin || null,
        sport_type: 'indoor',
        test: false,
        // JSONB columns
        match_info: {
          hall: hall || '',
          city: city || '',
          league: league || '',
          championship_type: championshipType || '',
          championship_type_other: championshipTypeOther || '',
          match_type_1: type1 || '',
          match_type_1_other: type1Other || '',
          match_type_2: type2 || '',
          match_type_3: type3 || '',
          match_type_3_other: type3Other || ''
        },
        home_team: { name: home.trim(), short_name: homeShortName || generateShortName(home.trim()), color: homeColor },
        away_team: { name: away.trim(), short_name: awayShortName || generateShortName(away.trim()), color: awayColor },
        bench_home: benchHome || [],
        bench_away: benchAway || []
      }

      // Only set status to 'setup' when creating a new match
      // When updating, don't overwrite the status (might be 'live')
      if (isCreating) {
        syncPayload.status = 'setup'
      }

      const syncJobId = await db.sync_queue.add({
        resource: 'match',
        action: 'insert',
        payload: syncPayload,
        ts: new Date().toISOString(),
        status: 'queued'
      })

      setMatchInfoConfirmed(true)
      setCurrentView('main')
      setNoticeModal({
        message: isCreating ? t('matchSetup.modals.matchCreatedSyncing') : t('matchSetup.modals.matchUpdatedSyncing'),
        type: 'success',
        syncing: true
      })

      // Send match info email if provided (non-blocking)
      if (notificationEmail && notificationEmail.trim() && match?.gamePin) {
        const emailData = {
          email: notificationEmail.trim(),
          gameN: gameN || 'N/A',
          gamePin: match.gamePin,
          home: home.trim(),
          away: away.trim(),
          homeShortName: homeShortName || '',
          awayShortName: awayShortName || '',
          date: date || '',
          time: time || '',
          hall: hall || '',
          city: city || '',
          league: league || ''
        }

        // Get backend URL from environment or use default
        const backendUrl = import.meta.env.VITE_BACKEND_URL || 'https://openvolley-escoresheet-backend-production.up.railway.app'

        fetch(`${backendUrl}/api/match/send-info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(emailData)
        })
          .then(res => res.json())
          .then(data => {
            if (data.success) {
              console.log('[MatchSetup] Match info email sent successfully')
            } else {
              console.warn('[MatchSetup] Failed to send match info email:', data.error)
            }
          })
          .catch(err => console.warn('[MatchSetup] Match info email failed:', err))
      }

      // Cloud backup at match setup (non-blocking)
      exportMatchData(matchId).then(backupData => {
        uploadBackupToCloud(matchId, backupData)
        uploadLogsToCloud(matchId, gameN || null)
      }).catch(err => console.warn('[MatchSetup] Cloud backup failed:', err))

      // Poll to check when sync completes
      const checkSyncStatus = async () => {
        let attempts = 0
        const maxAttempts = 20 // 10 seconds max
        const interval = setInterval(async () => {
          attempts++
          try {
            const job = await db.sync_queue.get(syncJobId)
            if (!job || job.status === 'sent') {
              clearInterval(interval)
              setNoticeModal({ message: t('matchSetup.modals.matchSynced'), type: 'success' })
            } else if (job.status === 'error') {
              clearInterval(interval)
              setNoticeModal({ message: t('matchSetup.modals.matchSavedLocalSyncFailed'), type: 'error' })
            } else if (attempts >= maxAttempts) {
              clearInterval(interval)
              setNoticeModal({ message: t('matchSetup.modals.matchSavedLocalSyncPending'), type: 'success' })
            }
          } catch (err) {
            clearInterval(interval)
          }
        }, 500)
      }
      checkSyncStatus()
    } catch (error) {
      console.error('Error confirming match info:', error)
      setNoticeModal({ message: t('matchSetup.errorGeneric', { error: error.message }), type: 'error' })
    }
  }

  function handleSignatureSave(signatureImage) {
    if (openSignature === 'home-coach') {
      setHomeCoachSignature(signatureImage)
    } else if (openSignature === 'home-captain') {
      setHomeCaptainSignature(signatureImage)
    } else if (openSignature === 'away-coach') {
      setAwayCoachSignature(signatureImage)
    } else if (openSignature === 'away-captain') {
      setAwayCaptainSignature(signatureImage)
    }
    setOpenSignature(null)
  }


  function formatRoster(roster, bench) {
    // All players sorted by number (ascending)
    const players = [...roster].sort((a, b) => {
      const an = a.number ?? 999
      const bn = b.number ?? 999
      return an - bn
    })
    // Liberos sorted by number (ascending)
    const liberos = roster.filter(p => p.libero).sort((a, b) => {
      const an = a.number ?? 999
      const bn = b.number ?? 999
      return an - bn
    })
    // Bench sorted by hierarchy: C, AC1, AC2, P, M
    const benchSorted = sortBenchByHierarchy(bench.filter(m => m.firstName || m.lastName || m.dob))

    return { players, liberos, bench: benchSorted }
  }

  async function createMatch() {
    // Check for existing validation errors
    if (dateError) {
      setNoticeModal({ message: t('matchSetup.invalidDate', { error: dateError }) })
      return
    }
    if (timeError) {
      setNoticeModal({ message: t('matchSetup.invalidTime', { error: timeError }) })
      return
    }

    // Validate date/time first
    let scheduledAt
    try {
      scheduledAt = createScheduledAt(date, time, { allowEmpty: false })
    } catch (err) {
      setNoticeModal({ message: t('matchSetup.invalidDateTime', { error: err.message }) })
      return
    }

    // Validate at least one captain per team
    const homeHasCaptain = homeRoster.some(p => p.isCaptain)
    const awayHasCaptain = awayRoster.some(p => p.isCaptain)

    if (!homeHasCaptain) {
      setNoticeModal({ message: t('matchSetup.homeCaptainRequired') })
      return
    }

    if (!awayHasCaptain) {
      setNoticeModal({ message: t('matchSetup.awayCaptainRequired') })
      return
    }

    // Validate no duplicate player numbers within each team
    const homeDuplicates = homeRoster.filter((p, i) =>
      p.number && homeRoster.findIndex(other => other.number === p.number) !== i
    )
    if (homeDuplicates.length > 0) {
      const dupNumbers = [...new Set(homeDuplicates.map(p => p.number))].join(', ')
      setNoticeModal({
        message: t('validation.duplicateNumbersDetailed', { team: home || t('common.home'), numbers: dupNumbers })
      })
      return
    }

    const awayDuplicates = awayRoster.filter((p, i) =>
      p.number && awayRoster.findIndex(other => other.number === p.number) !== i
    )
    if (awayDuplicates.length > 0) {
      const dupNumbers = [...new Set(awayDuplicates.map(p => p.number))].join(', ')
      setNoticeModal({
        message: t('validation.duplicateNumbersDetailed', { team: away || t('common.away'), numbers: dupNumbers })
      })
      return
    }

    // Validate birthdates - check for suspicious dates
    const allPlayers = [...homeRoster, ...awayRoster]
    const playersWithBadDate = allPlayers.filter(p =>
      p.dob === '01.01.1900' || p.dob === '01/01/1900' || p.dob === '1900-01-01'
    )
    if (playersWithBadDate.length > 0) {
      const badNames = playersWithBadDate.map(p => `${p.lastName || ''} ${p.firstName || ''} (#${p.number})`).join('\n')
      setNoticeModal({
        message: t('validation.invalidBirthdatesDetailed', { names: badNames })
      })
      return
    }

    // Check for missing birthdates (warning, not blocking)
    const playersWithoutDob = allPlayers.filter(p => !p.dob && (p.firstName || p.lastName))
    if (playersWithoutDob.length > 0) {
      const missingNames = playersWithoutDob.slice(0, 5).map(p => `${p.lastName || ''} ${p.firstName || ''} (#${p.number})`).join('\n')
      const moreCount = playersWithoutDob.length > 5 ? `\n...and ${playersWithoutDob.length - 5} more` : ''
      // This is just a warning - show it but continue
      console.warn(`[MatchSetup] Players missing birthdate:\n${missingNames}${moreCount}`)
    }

    await db.transaction('rw', db.matches, db.teams, db.players, db.sync_queue, async () => {
      const homeId = await db.teams.add({ name: home, color: homeColor, shortName: homeShortName || home.substring(0, 8).toUpperCase(), benchStaff: benchHome, createdAt: new Date().toISOString() })
      const awayId = await db.teams.add({ name: away, color: awayColor, shortName: awayShortName || away.substring(0, 8).toUpperCase(), benchStaff: benchAway, createdAt: new Date().toISOString() })

      // Generate 6-digit PIN code for referee authentication
      const generatePinCode = (existingPins = []) => {
        const chars = '0123456789'
        let pin = ''
        let attempts = 0
        const maxAttempts = 100

        do {
          pin = ''
          for (let i = 0; i < 6; i++) {
            pin += chars.charAt(Math.floor(Math.random() * chars.length))
          }
          attempts++
          if (attempts >= maxAttempts) {
            // If we can't generate a unique PIN after many attempts, just return this one
            break
          }
        } while (existingPins.includes(pin))

        return pin
      }

      // Generate match PIN code (for opening/continuing match)
      const matchPin = prompt(t('matchSetup.enterPinPrompt'))
      if (!matchPin || matchPin.trim() === '') {
        setNoticeModal({ message: t('matchSetup.matchPinRequired') })
        return
      }

      // Auto-generate gamePin for official matches
      const generatedGamePin = (() => {
        const chars = '0123456789'
        let pin = ''
        for (let i = 0; i < 6; i++) {
          pin += chars.charAt(Math.floor(Math.random() * chars.length))
        }
        return pin
      })()

      // Generate all PINs upfront so we can display them in the modal
      const generatedRefereePin = generatePinCode([])
      const generatedHomeTeamPin = generatePinCode([generatedRefereePin])
      const generatedAwayTeamPin = generatePinCode([generatedRefereePin, generatedHomeTeamPin])

      // Generate a unique seed_key for Supabase sync (stored as external_id)
      // This is the stable unique identifier - never includes modifiable fields like gameN
      const seedKey = generateMatchSeedKey()

      const createdMatchId = await db.matches.add({
        homeTeamId: homeId,
        awayTeamId: awayId,
        status: 'live',
        scheduledAt,
        hall,
        city,
        match_type_1: type1,
        match_type_1_other: type1 === 'other' ? type1Other : null,
        championshipType,
        championshipTypeOther: championshipType === 'other' ? championshipTypeOther : null,
        match_type_2: type2,
        match_type_3: type3,
        match_type_3_other: type3 === 'other' ? type3Other : null,
        sport_type: 'indoor',
        // Team names and colors for local access
        homeName: home.trim(),
        awayName: away.trim(),
        homeShortName: homeShortName || home.substring(0, 3).toUpperCase(),
        awayShortName: awayShortName || away.substring(0, 3).toUpperCase(),
        homeColor: homeColor || '#ef4444',
        awayColor: awayColor || '#3b82f6',
        game_n: gameN ? Number(gameN) : null,
        seed_key: seedKey, // Unique key for Supabase sync
        league,
        gamePin: generatedGamePin, // Game PIN for official matches (not test matches)
        refereePin: String(generatedRefereePin).trim(),
        homeTeamPin: String(generatedHomeTeamPin).trim(),
        awayTeamPin: String(generatedAwayTeamPin).trim(),
        matchPin: matchPin.trim(),
        refereeConnectionEnabled: false,
        homeTeamConnectionEnabled: false,
        awayTeamConnectionEnabled: false,
        officials: buildOfficialsArray(
          { firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: ref1Dob },
          { firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: ref2Dob },
          { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob },
          { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
          { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 }
        ),
        bench_home: benchHome,
        bench_away: benchAway,
        homeCoachSignature: null,
        homeCaptainSignature: null,
        awayCoachSignature: null,
        awayCaptainSignature: null,
        coinTossConfirmed: false,  // Set to true when coin toss is confirmed
        createdAt: new Date().toISOString()
      })

      // Add match to sync queue - all data stored as JSONB
      await db.sync_queue.add({
        resource: 'match',
        action: 'insert',
        payload: {
          external_id: seedKey,
          status: 'live',
          scheduled_at: scheduledAt || null,
          test: false,
          sport_type: 'indoor',
          created_at: new Date().toISOString(),
          // JSONB columns
          match_info: {
            hall: hall || '',
            city: city || '',
            league: league || ''
          },
          home_team: { name: home.trim(), short_name: homeShortName || generateShortName(home.trim()), color: homeColor || '#ef4444' },
          away_team: { name: away.trim(), short_name: awayShortName || generateShortName(away.trim()), color: awayColor || '#3b82f6' },
          players_home: homeRoster.map(p => ({
            number: p.number,
            first_name: p.firstName,
            last_name: p.lastName,
            dob: formatDobForSync(p.dob),
            libero: p.libero || null,
            is_captain: !!p.isCaptain,
            is_lfp: !!p.isLfp
          })),
          players_away: awayRoster.map(p => ({
            number: p.number,
            first_name: p.firstName,
            last_name: p.lastName,
            dob: formatDobForSync(p.dob),
            libero: p.libero || null,
            is_captain: !!p.isCaptain,
            is_lfp: !!p.isLfp
          })),
          bench_home: benchHome || [],
          bench_away: benchAway || [],
          officials: buildOfficialsArray(
            { firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: ref1Dob },
            { firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: ref2Dob },
            { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob },
            { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
            { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 },
            true // useSnakeCase for Supabase
          ),
          // PINs for dashboard connections
          game_pin: generatedGamePin,
          game_n: gameN ? Number(gameN) : null,
          connection_pins: {
            referee: String(generatedRefereePin).trim(),
            bench_home: String(generatedHomeTeamPin).trim(),
            bench_away: String(generatedAwayTeamPin).trim()
          }
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })

      // Associate user with this match if logged in
      if (user && supabase) {
        try {
          await supabase.from('user_matches').upsert({
            user_id: user.id,
            match_external_id: seedKey,
            role: 'scorer',
            sport_type: 'indoor'
          }, { onConflict: 'user_id,match_external_id,role' })
          console.log('[MatchSetup] Associated user with match:', seedKey)
        } catch (err) {
          // Don't fail match creation if user_matches insert fails
          console.warn('[MatchSetup] Failed to associate user with match:', err)
        }
      }

      // Add players to local Dexie (still needed for local functionality)
      if (homeRoster.length) {
        await db.players.bulkAdd(
          homeRoster.map(p => ({
            teamId: homeId,
            number: p.number,
            name: `${p.lastName} ${p.firstName}`,
            lastName: p.lastName,
            firstName: p.firstName,
            dob: p.dob || null,
            libero: p.libero || '',
            isCaptain: !!p.isCaptain,
            isLfp: !!p.isLfp,
            role: null,
            createdAt: new Date().toISOString()
          }))
        )
      }
      if (awayRoster.length) {
        await db.players.bulkAdd(
          awayRoster.map(p => ({
            teamId: awayId,
            number: p.number,
            name: `${p.lastName} ${p.firstName}`,
            lastName: p.lastName,
            firstName: p.firstName,
            dob: p.dob || null,
            libero: p.libero || '',
            isCaptain: !!p.isCaptain,
            isLfp: !!p.isLfp,
            role: null,
            createdAt: new Date().toISOString()
          }))
        )
      }

      // Don't start match yet - go to coin toss first
      // Check if team names and short names are set
      if (!home || home.trim() === '' || home === 'Home' || !away || away.trim() === '' || away === 'Away') {
        setNoticeModal({ message: t('matchSetup.teamNamesRequired') })
        return
      }

      if (!homeShortName || homeShortName.trim() === '' || !awayShortName || awayShortName.trim() === '') {
        setNoticeModal({ message: t('matchSetup.teamShortNamesRequired') })
        return
      }

      // Show match created popup if online (has gamePin)
      if (!offlineMode && generatedGamePin) {
        setMatchCreatedModal({
          matchId: createdMatchId,
          gamePin: generatedGamePin,
          refereePin: generatedRefereePin,
          homeTeamPin: generatedHomeTeamPin,
          awayTeamPin: generatedAwayTeamPin
        })
      } else {
        onOpenCoinToss()
      }
    })
  }

  function switchTeams() {
    const temp = teamA
    setTeamA(teamB)
    setTeamB(temp)
  }

  function switchServe() {
    setServeA(!serveA)
    setServeB(!serveB)
  }

  // Open scoresheet in a new window
  async function openScoresheet() {
    if (!matchId) {
      setNoticeModal({ message: t('matchSetup.noMatchData') })
      return
    }

    const matchData = await db.matches.get(matchId)
    if (!matchData) {
      setNoticeModal({ message: t('matchSetup.matchNotFound') })
      return
    }

    // Get teams
    const homeTeamData = matchData.homeTeamId ? await db.teams.get(matchData.homeTeamId) : null
    const awayTeamData = matchData.awayTeamId ? await db.teams.get(matchData.awayTeamId) : null

    // Get players
    const homePlayersData = matchData.homeTeamId
      ? await db.players.where('teamId').equals(matchData.homeTeamId).toArray()
      : []
    const awayPlayersData = matchData.awayTeamId
      ? await db.players.where('teamId').equals(matchData.awayTeamId).toArray()
      : []

    // Get sets and events
    const allSets = await db.sets.where('matchId').equals(matchId).sortBy('index')
    const allEvents = await db.events.where('matchId').equals(matchId).sortBy('seq')

    const scoresheetData = {
      match: matchData,
      homeTeam: homeTeamData,
      awayTeam: awayTeamData,
      homePlayers: homePlayersData,
      awayPlayers: awayPlayersData,
      sets: allSets,
      events: allEvents,
      sanctions: []
    }

    // Store data in sessionStorage to pass to new window
    sessionStorage.setItem('scoresheetData', JSON.stringify(scoresheetData))

    // Open scoresheet in new window with matchId parameter for reliable data loading
    const scoresheetWindow = window.open(`/scoresheet?matchId=${matchId}`, '_blank', 'width=1200,height=900')

    if (!scoresheetWindow) {
      setNoticeModal({ message: t('matchSetup.allowPopups') })
    }
  }

  async function confirmCoinToss() {

    // Only check signatures for official matches, skip for test matches
    if (!match?.test) {
      if (!homeCoachSignature || !homeCaptainSignature || !awayCoachSignature || !awayCaptainSignature) {
        setNoticeModal({ message: t('matchSetup.completeSignatures') })
        return
      }
    }

    if (!matchId) {
      console.error('[COIN TOSS] No match ID available')
      setNoticeModal({ message: t('matchSetup.modals.errorNoMatchId') })
      return
    }

    const matchData = await db.matches.get(matchId)
    if (!matchData) {
      return
    }

    // Determine which team serves first
    const firstServeTeam = serveA ? teamA : teamB

    // Update match with signatures (only for official matches) and coin toss result
    await db.transaction('rw', db.matches, db.players, db.sync_queue, db.events, async () => {
      // Build update object
      const updateData = {
        firstServe: firstServeTeam, // 'home' or 'away'
        coinTossTeamA: teamA, // 'home' or 'away'
        coinTossTeamB: teamB, // 'home' or 'away'
        coinTossServeA: serveA, // true or false
        coinTossServeB: serveB, // true or false
        coinTossConfirmed: true  // Mark coin toss as confirmed
      }

      // Only save signatures for official matches
      if (!match?.test) {
        updateData.homeCoachSignature = homeCoachSignature
        updateData.homeCaptainSignature = homeCaptainSignature
        updateData.awayCoachSignature = awayCoachSignature
        updateData.awayCaptainSignature = awayCaptainSignature
      }

      const updateResult = await db.matches.update(matchId, updateData)

      // Check if coin toss event already exists
      const existingCoinTossEvent = await db.events
        .where('matchId').equals(matchId)
        .and(e => e.type === 'coin_toss')
        .first()

      // Create coin_toss event with seq=1 if it doesn't exist
      if (!existingCoinTossEvent) {
        await db.events.add({
          matchId: matchId,
          setIndex: 1, // Coin toss is before set 1
          type: 'coin_toss',
          payload: {
            teamA: teamA,
            teamB: teamB,
            serveA: serveA,
            serveB: serveB,
            firstServe: firstServeTeam
          },
          ts: new Date().toISOString(),
          seq: 1 // Coin toss always gets seq=1
        })
      }

      // Add match update to sync queue (only sync if match has seed_key)
      const updatedMatch = await db.matches.get(matchId)
      if (updatedMatch?.seed_key) {
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: updatedMatch.seed_key,
            status: 'live', // Status will be 'live' after match setup is confirmed
            scheduled_at: updatedMatch.scheduledAt || null,
            // JSONB columns
            match_info: {
              hall: updatedMatch.hall || '',
              city: updatedMatch.city || '',
              league: updatedMatch.league || ''
            },
            coin_toss: {
              team_a: teamA,
              team_b: teamB,
              confirmed: true,
              first_serve: firstServeTeam
            },
            signatures: !updatedMatch.test ? {
              home_coach: homeCoachSignature || '',
              home_captain: homeCaptainSignature || '',
              away_coach: awayCoachSignature || '',
              away_captain: awayCaptainSignature || ''
            } : {},
            home_team: { name: home?.trim() || '', short_name: homeShortName || '', color: homeColor },
            away_team: { name: away?.trim() || '', short_name: awayShortName || '', color: awayColor },
            players_home: homeRoster.filter(p => p.firstName || p.lastName).map(p => ({
              number: p.number || null,
              first_name: p.firstName || '',
              last_name: p.lastName || '',
              dob: p.dob || null,
              is_captain: !!p.isCaptain,
              libero: p.libero || null,
              is_lfp: !!p.isLfp
            })),
            players_away: awayRoster.filter(p => p.firstName || p.lastName).map(p => ({
              number: p.number || null,
              first_name: p.firstName || '',
              last_name: p.lastName || '',
              dob: p.dob || null,
              is_captain: !!p.isCaptain,
              libero: p.libero || null,
              is_lfp: !!p.isLfp
            })),
            bench_home: benchHome || [],
            bench_away: benchAway || [],
            officials: updatedMatch.officials || []
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }

      // Update saved signatures to match current state
      setSavedSignatures({
        homeCoach: homeCoachSignature,
        homeCaptain: homeCaptainSignature,
        awayCoach: awayCoachSignature,
        awayCaptain: awayCaptainSignature
      })

      // Update players for both teams
      if (matchData.homeTeamId && homeRoster.length) {
        // Get existing players
        const existingPlayers = await db.players.where('teamId').equals(matchData.homeTeamId).toArray()

        // Update or add players
        for (const p of homeRoster) {
          const existingPlayer = existingPlayers.find(ep => ep.number === p.number)
          if (existingPlayer) {
            // Update existing player
            await db.players.update(existingPlayer.id, {
              name: `${p.lastName} ${p.firstName}`,
              lastName: p.lastName,
              firstName: p.firstName,
              dob: p.dob || null,
              libero: p.libero || '',
              isCaptain: !!p.isCaptain,
              isLfp: !!p.isLfp
            })
          } else {
            // Add new player
            await db.players.add({
              teamId: matchData.homeTeamId,
              number: p.number,
              name: `${p.lastName} ${p.firstName}`,
              lastName: p.lastName,
              firstName: p.firstName,
              dob: p.dob || null,
              libero: p.libero || '',
              isCaptain: !!p.isCaptain,
              isLfp: !!p.isLfp,
              role: null,
              createdAt: new Date().toISOString()
            })
          }
        }

        // Delete players that are no longer in the roster
        const rosterNumbers = new Set(homeRoster.map(p => p.number))
        for (const ep of existingPlayers) {
          if (!rosterNumbers.has(ep.number)) {
            await db.players.delete(ep.id)
          }
        }
      }

      if (matchData.awayTeamId && awayRoster.length) {
        // Get existing players
        const existingPlayers = await db.players.where('teamId').equals(matchData.awayTeamId).toArray()

        // Update or add players
        for (const p of awayRoster) {
          const existingPlayer = existingPlayers.find(ep => ep.number === p.number)
          if (existingPlayer) {
            // Update existing player
            await db.players.update(existingPlayer.id, {
              name: `${p.lastName} ${p.firstName}`,
              lastName: p.lastName,
              firstName: p.firstName,
              dob: p.dob || null,
              libero: p.libero || '',
              isCaptain: !!p.isCaptain,
              isLfp: !!p.isLfp
            })
          } else {
            // Add new player
            await db.players.add({
              teamId: matchData.awayTeamId,
              number: p.number,
              name: `${p.lastName} ${p.firstName}`,
              lastName: p.lastName,
              firstName: p.firstName,
              dob: p.dob || null,
              libero: p.libero || '',
              isCaptain: !!p.isCaptain,
              isLfp: !!p.isLfp,
              role: null,
              createdAt: new Date().toISOString()
            })
          }
        }

        // Delete players that are no longer in the roster
        const rosterNumbers = new Set(awayRoster.map(p => p.number))
        for (const ep of existingPlayers) {
          if (!rosterNumbers.has(ep.number)) {
            await db.players.delete(ep.id)
          }
        }
      }
    })

    // Create first set
    const firstSetId = await db.sets.add({ matchId: matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })

    // Get match to check if it's a test match
    const matchForSet = await db.matches.get(matchId)
    const isTest = matchForSet?.test || false

    // Only sync official matches (not test matches) with seed_key
    if (!isTest && matchForSet?.seed_key) {
      await db.sync_queue.add({
        resource: 'set',
        action: 'insert',
        payload: {
          external_id: String(firstSetId),
          match_id: matchForSet.seed_key, // Use seed_key (external_id) for Supabase lookup
          index: 1,
          home_points: 0,
          away_points: 0,
          finished: false,
          start_time: roundToMinute(new Date().toISOString())
        },
        ts: roundToMinute(new Date().toISOString()),
        status: 'queued'
      })
    }

    // Update match status to 'live' to indicate match has started
    await db.matches.update(matchId, { status: 'live' })

    // Ensure all roster updates are committed before navigating
    // Force a small delay to ensure database updates are fully committed
    await new Promise(resolve => setTimeout(resolve, 100))

    // Sync to server immediately so referee/bench dashboards receive data before Scoreboard mounts
    const finalMatchData = await db.matches.get(matchId)
    if (finalMatchData) {
      await syncMatchToServer(finalMatchData, true) // Full sync with teams, players, sets, events
    }

    // Start the match - directly navigate to scoreboard
    // onStart (continueMatch) will now allow test matches when status is 'live' and coin toss is confirmed
    onStart(matchId)
  }

  // Handler for Load Official Match modal selection
  const handleOfficialMatchSelect = (matchData) => {
    // Populate all the form fields from the selected official match
    setDate(matchData.date)
    setTime(matchData.time)
    setCity(matchData.city)
    setHall(matchData.hall)
    setType1(matchData.type1)
    setChampionshipType(matchData.championshipType)
    setType2(matchData.type2)
    setType3(matchData.type3)
    setGameN(matchData.gameN)
    setLeague(matchData.league)
    setHome(matchData.home)
    setAway(matchData.away)

    // Clear short names - user must fill them in manually for official matches
    setHomeShortName('')
    setAwayShortName('')
  }

  // PDF file handlers - must be defined before conditional returns
  const handleHomeFileSelect = (e) => {
    const file = e.target.files[0]
    if (file) {
      setHomePdfFile(file)
      setHomePdfError('')
    }
  }

  const handleAwayFileSelect = (e) => {
    const file = e.target.files[0]
    if (file) {
      setAwayPdfFile(file)
      setAwayPdfError('')
    }
  }

  const handleHomeImportClick = async () => {
    if (homePdfFile) {
      await handleHomePdfUpload(homePdfFile)
    } else {
      setHomePdfError('Please select a PDF file first')
    }
  }

  const handleAwayImportClick = async () => {
    if (awayPdfFile) {
      await handleAwayPdfUpload(awayPdfFile)
    } else {
      setAwayPdfError('Please select a PDF file first')
    }
  }

  // Search for pending roster in Supabase
  const handleSearchHomeRoster = async () => {
    if (!match || !supabase) {
      setNoticeModal({ message: t('matchSetup.noSupabaseConnection') })
      return
    }

    setHomeRosterSearching(true)
    try {
      const gameNumber = match.game_n || match.gameNumber || gameN
      console.log('[MatchSetup] Searching for home roster, game number:', gameNumber)

      // Search for pending roster in Supabase
      const { data, error } = await supabase
        .from('matches')
        .select('pending_home_roster, external_id')
        .eq('game_n', gameNumber)
        .not('pending_home_roster', 'is', null)
        .limit(1)
        .single()

      if (error || !data?.pending_home_roster) {
        console.log('[MatchSetup] No pending home roster found')
        setNoticeModal({ message: t('matchSetup.noRosterFound') })
        return
      }

      console.log('[MatchSetup] Found pending home roster:', data.pending_home_roster)

      // Store in local match data to trigger the pending roster UI
      await db.matches.update(matchId, { pendingHomeRoster: data.pending_home_roster })
    } catch (err) {
      console.error('[MatchSetup] Error searching for home roster:', err)
      setNoticeModal({ message: t('matchSetup.errorSearchingRoster') })
    } finally {
      setHomeRosterSearching(false)
    }
  }

  const handleSearchAwayRoster = async () => {
    if (!match || !supabase) {
      setNoticeModal({ message: t('matchSetup.noSupabaseConnection') })
      return
    }

    setAwayRosterSearching(true)
    try {
      const gameNumber = match.game_n || match.gameNumber || gameN
      console.log('[MatchSetup] Searching for away roster, game number:', gameNumber)

      // Search for pending roster in Supabase
      const { data, error } = await supabase
        .from('matches')
        .select('pending_away_roster, external_id')
        .eq('game_n', gameNumber)
        .not('pending_away_roster', 'is', null)
        .limit(1)
        .single()

      if (error || !data?.pending_away_roster) {
        console.log('[MatchSetup] No pending away roster found')
        setNoticeModal({ message: t('matchSetup.noRosterFound') })
        return
      }

      console.log('[MatchSetup] Found pending away roster:', data.pending_away_roster)

      // Store in local match data to trigger the pending roster UI
      await db.matches.update(matchId, { pendingAwayRoster: data.pending_away_roster })
    } catch (err) {
      console.error('[MatchSetup] Error searching for away roster:', err)
      setNoticeModal({ message: t('matchSetup.errorSearchingRoster') })
    } finally {
      setAwayRosterSearching(false)
    }
  }

  // PDF upload handlers - must be defined before conditional returns
  const handleHomePdfUpload = async (file) => {
    if (!file) return
    setHomePdfLoading(true)
    setHomePdfError('')

    try {
      const parsedData = await parseRosterPdf(file)

      // Replace all players with imported ones (overwrite mode)
      const mergedPlayers = parsedData.players.map(parsedPlayer => ({
        id: null,
        number: parsedPlayer.number || null,
        firstName: parsedPlayer.firstName || '',
        lastName: parsedPlayer.lastName || '',
        dob: parsedPlayer.dob || '',
        libero: '',
        isCaptain: false,
        isLfp: parsedPlayer.isLfp || false
      }))

      setHomeRoster(mergedPlayers)

      // Update bench officials
      const importedBenchOfficials = []
      if (parsedData.coach) {
        importedBenchOfficials.push({
          role: 'Coach',
          firstName: parsedData.coach.firstName || '',
          lastName: parsedData.coach.lastName || '',
          dob: parsedData.coach.dob || ''
        })
      }
      if (parsedData.ac1) {
        importedBenchOfficials.push({
          role: 'Assistant Coach 1',
          firstName: parsedData.ac1.firstName || '',
          lastName: parsedData.ac1.lastName || '',
          dob: parsedData.ac1.dob || ''
        })
      }
      if (parsedData.ac2) {
        importedBenchOfficials.push({
          role: 'Assistant Coach 2',
          firstName: parsedData.ac2.firstName || '',
          lastName: parsedData.ac2.lastName || '',
          dob: parsedData.ac2.dob || ''
        })
      }

      setBenchHome(importedBenchOfficials)

      // Save to database if match exists
      if (matchId && match?.homeTeamId) {
        const existingPlayers = await db.players.where('teamId').equals(match.homeTeamId).toArray()
        for (const ep of existingPlayers) {
          await db.players.delete(ep.id)
        }

        await db.players.bulkAdd(
          mergedPlayers.map(p => ({
            teamId: match.homeTeamId,
            number: p.number,
            firstName: p.firstName,
            lastName: p.lastName,
            name: `${p.lastName} ${p.firstName}`,
            dob: p.dob || null,
            libero: p.libero || '',
            isCaptain: !!p.isCaptain,
            isLfp: !!p.isLfp,
            role: null,
            createdAt: new Date().toISOString()
          }))
        )

        await db.matches.update(matchId, {
          bench_home: importedBenchOfficials
        })
      }

      // Clear file input and state
      if (homeFileInputRef.current) {
        homeFileInputRef.current.value = ''
      }
      setHomePdfFile(null)

      // Show import summary modal
      setImportSummaryModal({
        team: 'home',
        players: mergedPlayers.length,
        benchOfficials: importedBenchOfficials.length,
        errors: []
      })
    } catch (err) {
      console.error('Error parsing PDF:', err)
      setHomePdfError(`Failed to parse PDF: ${err.message}`)
      // Clear file state on error too
      setHomePdfFile(null)
      if (homeFileInputRef.current) {
        homeFileInputRef.current.value = ''
      }
    } finally {
      setHomePdfLoading(false)
    }
  }

  const handleAwayPdfUpload = async (file) => {
    if (!file) return
    setAwayPdfLoading(true)
    setAwayPdfError('')

    try {
      const parsedData = await parseRosterPdf(file)

      // Replace all players with imported ones (overwrite mode)
      const mergedPlayers = parsedData.players.map(parsedPlayer => ({
        id: null,
        number: parsedPlayer.number || null,
        firstName: parsedPlayer.firstName || '',
        lastName: parsedPlayer.lastName || '',
        dob: parsedPlayer.dob || '',
        libero: '',
        isCaptain: false,
        isLfp: parsedPlayer.isLfp || false
      }))

      setAwayRoster(mergedPlayers)

      // Update bench officials
      const importedBenchOfficials = []
      if (parsedData.coach) {
        importedBenchOfficials.push({
          role: 'Coach',
          firstName: parsedData.coach.firstName || '',
          lastName: parsedData.coach.lastName || '',
          dob: parsedData.coach.dob || ''
        })
      }
      if (parsedData.ac1) {
        importedBenchOfficials.push({
          role: 'Assistant Coach 1',
          firstName: parsedData.ac1.firstName || '',
          lastName: parsedData.ac1.lastName || '',
          dob: parsedData.ac1.dob || ''
        })
      }
      if (parsedData.ac2) {
        importedBenchOfficials.push({
          role: 'Assistant Coach 2',
          firstName: parsedData.ac2.firstName || '',
          lastName: parsedData.ac2.lastName || '',
          dob: parsedData.ac2.dob || ''
        })
      }

      setBenchAway(importedBenchOfficials)

      // Save to database if match exists
      if (matchId && match?.awayTeamId) {
        const existingPlayers = await db.players.where('teamId').equals(match.awayTeamId).toArray()
        for (const ep of existingPlayers) {
          await db.players.delete(ep.id)
        }

        await db.players.bulkAdd(
          mergedPlayers.map(p => ({
            teamId: match.awayTeamId,
            number: p.number,
            firstName: p.firstName,
            lastName: p.lastName,
            name: `${p.lastName} ${p.firstName}`,
            dob: p.dob || null,
            libero: p.libero || '',
            isCaptain: !!p.isCaptain,
            isLfp: !!p.isLfp,
            role: null,
            createdAt: new Date().toISOString()
          }))
        )

        await db.matches.update(matchId, {
          bench_away: importedBenchOfficials
        })
      }

      // Clear file input and state
      if (awayFileInputRef.current) {
        awayFileInputRef.current.value = ''
      }
      setAwayPdfFile(null)

      // Show import summary modal
      setImportSummaryModal({
        team: 'away',
        players: mergedPlayers.length,
        benchOfficials: importedBenchOfficials.length,
        errors: []
      })
    } catch (err) {
      console.error('Error parsing PDF:', err)
      setAwayPdfError(`Failed to parse PDF: ${err.message}`)
      // Clear file state on error too
      setAwayPdfFile(null)
      if (awayFileInputRef.current) {
        awayFileInputRef.current.value = ''
      }
    } finally {
      setAwayPdfLoading(false)
    }
  }

  // Callback for opening database selector - MUST be before any early returns to satisfy React hooks rules
  const handleOpenDatabase = useCallback((e, selectorKey) => {
    setRefereeSelectorPosition({ element: e.currentTarget })
    setShowRefereeSelector(selectorKey)
  }, [])

  if (currentView === 'info') {
    return (
      <MatchSetupInfoView>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <button className="secondary" onClick={() => { restoreMatchInfo(); setCurrentView('main') }}>← {t('common.back')}</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <h1 style={{ margin: 8 }}>{t('matchSetup.matchInfo')}</h1>
              <button
                onClick={() => setLoadOfficialMatchModal(true)}
                style={{
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(139, 92, 246, 0.2) 100%)',
                  color: '#60a5fa',
                  border: '1px solid rgba(59, 130, 246, 0.4)',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                {t('loadOfficialMatch.button')}
              </button>
            </div>
          </div>
          <div style={{ width: 80 }}></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px' }}>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>{t('matchSetup.dateTime')}</h3>
            <div className="field">
              <label>{t('matchSetup.date')}</label>
              <input
                className="w-100"
                type="date"
                value={date}
                onChange={e => handleDateChange(e.target.value)}
                style={dateError ? { borderColor: '#ef4444', boxShadow: '0 0 0 1px #ef4444' } : {}}
              />
              {dateError && <span style={{ color: '#ef4444', fontSize: '12px', marginLeft: '8px' }}>{dateError}</span>}
            </div>
            <div className="field">
              <label>{t('matchSetup.time')}</label>
              <input
                className="w-100"
                type="text"
                value={time}
                onChange={e => handleTimeChange(e.target.value)}
                placeholder={t('matchSetup.placeholders.hhMm')}
                style={timeError ? { borderColor: '#ef4444', boxShadow: '0 0 0 1px #ef4444' } : {}}
              />
              {timeError && <span style={{ color: '#ef4444', fontSize: '12px', marginLeft: '8px' }}>{timeError}</span>}
            </div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>{t('matchSetup.location')}</h3>
            <div className="field">
              <label>{t('matchSetup.city')}</label>
              <input
                className="w-160 capitalize"
                value={city}
                onChange={e => setCity(e.target.value)}
                list="cities-zurich"
                placeholder={t('matchSetup.enterCity')}
              />
              <datalist id="cities-zurich">
                {citiesZurich.map(c => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div className="field"><label>{t('matchSetup.hall')}</label><input className="w-200 capitalize" value={hall} onChange={e => setHall(e.target.value)} /></div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>{t('matchSetup.matchType')}</h3>
            <div className="field">
              <label>{t('matchSetup.matchType')}</label>
              <select className="w-160 capitalize" value={type1} onChange={e => setType1(e.target.value)}>
                <option value="championship">{t('matchSetup.championship')}</option>
                <option value="cup">{t('matchSetup.cup')}</option>
                <option value="friendly">{t('matchSetup.friendly')}</option>
                <option value="tournament">{t('matchSetup.tournament')}</option>
                <option value="other">{t('matchSetup.other')}</option>
              </select>
            </div>
            {type1 === 'other' && (
              <div className="field">
                <label>{t('matchSetup.specify')}</label>
                <input className="w-120" value={type1Other} onChange={e => setType1Other(e.target.value)} placeholder={t('matchSetup.otherType')} />
              </div>
            )}
            <div className="field">
              <label>{t('matchSetup.championshipType')}</label>
              <select className="w-140" value={championshipType} onChange={e => setChampionshipType(e.target.value)}>
                <option value="regional">{t('matchSetup.regional')}</option>
                <option value="national">{t('matchSetup.national')}</option>
                <option value="international">{t('matchSetup.international')}</option>
                <option value="other">{t('matchSetup.other')}</option>
              </select>
            </div>
            {championshipType === 'other' && (
              <div className="field">
                <label>{t('matchSetup.specify')}</label>
                <input className="w-120" value={championshipTypeOther} onChange={e => setChampionshipTypeOther(e.target.value)} placeholder={t('matchSetup.otherType')} />
              </div>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>{t('matchSetup.categoryLevel')}</h3>
            <div className="field">
              <label>{t('matchSetup.gender')}</label>
              <select className="w-120" value={type2} onChange={e => setType2(e.target.value)}>
                <option value="men">{t('matchSetup.men')}</option>
                <option value="women">{t('matchSetup.women')}</option>
              </select>
            </div>
            <div className="field">
              <label>{t('matchSetup.matchLevel')}</label>
              <select className="w-90" value={type3} onChange={e => setType3(e.target.value)}>
                <option value="senior">{t('matchSetup.senior')}</option>
                <option value="U23">U23</option>
                <option value="U21">U21</option>
                <option value="U19">U19</option>
                <option value="U17">U17</option>
                <option value="other">{t('matchSetup.other')}</option>
              </select>
            </div>
            {type3 === 'other' && (
              <div className="field">
                <label>{t('matchSetup.specify')}</label>
                <input className="w-120" value={type3Other} onChange={e => setType3Other(e.target.value)} placeholder={t('matchSetup.otherLevel')} />
              </div>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>{t('matchSetup.gameDetails')}</h3>
            <div className="field"><label>{t('matchSetup.gameNumber')}</label><input className="w-80" type="number" inputMode="numeric" value={gameN} onChange={e => setGameN(e.target.value)} /></div>
            <div className="field"><label>{t('matchSetup.league')}</label><input className="w-80 capitalize" value={league} onChange={e => setLeague(e.target.value)} /></div>
          </div>

          {/* Teams Card - Full width row at bottom */}
          <div className="card" style={{ gridColumn: 'span 5' }}>
            <h2 style={{ marginTop: 0, marginBottom: 24, textAlign: 'center', fontSize: '24px', fontWeight: 700 }}>{t('matchSetup.teams').toUpperCase()}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
              {/* Home Team */}
              <div data-help-id="setup-home-team-card" style={{ flex: 1, border: '2px solid white', padding: '10px', borderRadius: '10px' }}>
                {/* Header row: Trikot container + Title */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: 16 }}>
                  {/* Trikot container */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: 16,
                      cursor: 'pointer'
                    }}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      setColorPickerModal({
                        team: 'home',
                        position: { x: rect.left + rect.width / 2, y: rect.bottom + 8 }
                      })
                    }}
                  >
                    <div
                      className="shirt"
                      style={{ background: homeColor, transform: 'scale(0.65)', margin: '-10px' }}
                    >
                      <div className="collar" style={{ background: homeColor }} />
                      <div className="number" style={{ color: getContrastColor(homeColor) }}>1</div>
                    </div>
                  </div>
                  {/* Title */}
                  <div
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      fontSize: '20px',
                      fontWeight: 700,
                      color: getContrastColor(homeColor),
                      padding: '10px',
                      border: '0.5px solid white',
                      borderRadius: '10px',
                      background: homeColor
                    }}
                  >
                    {t('matchSetup.homeTeam').toUpperCase()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
                  <div className="field" style={{ flex: '0 0 60%', marginBottom: 0 }}>
                    <label style={{ fontSize: '18px', fontWeight: 600, alignItems: 'center', justifyContent: 'center', display: 'flex' }}>{t('matchSetup.teamName')}</label>
                    <input
                      type="text"
                      value={home}
                      onChange={e => setHome(e.target.value)}
                      placeholder={t('matchSetup.homeTeamName')}
                      style={{ width: '100%', padding: '10px', fontSize: '18px', fontWeight: 600, textAlign: 'center', alignItems: 'center', justifyContent: 'center', display: 'flex', background: 'rgba(255, 255, 255, 0.1)', borderRadius: '10px' }}
                    />
                  </div>
                  <div className="field" style={{ flex: '0 0 calc(40% - 16px)', marginBottom: 0 }}>
                    <label style={{ fontSize: '18px', fontWeight: 600, alignItems: 'center', justifyContent: 'center', display: 'flex' }}>{t('matchSetup.short')}</label>
                    <input
                      type="text"
                      value={homeShortName}
                      onChange={e => setHomeShortName(e.target.value.toUpperCase())}
                      maxLength={8}
                      placeholder={t('common.home').toUpperCase()}
                      style={{ width: '100%', textAlign: 'center', padding: '10px', fontSize: '18px', fontWeight: 600, alignItems: 'center', justifyContent: 'center', display: 'flex', background: 'rgba(255, 255, 255, 0.1)', borderRadius: '10px' }}
                    />
                  </div>
                </div>
              </div>

              {/* VS Divider */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 12px',
                marginTop: 24
              }}>
                <span style={{
                  fontSize: '22px',
                  fontWeight: 700,
                  fontStyle: 'italic',
                  color: 'rgb(255, 255, 255)'
                }}>VS</span>
              </div>

              {/* Away Team */}
              <div data-help-id="setup-away-team-card" style={{ flex: 1, border: '2px solid white', padding: '10px', borderRadius: '10px' }}>
                {/* Header row: Trikot container + Title */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: 16 }}>

                  {/* Title */}
                  <div
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      fontSize: '20px',
                      fontWeight: 700,
                      color: getContrastColor(awayColor),
                      padding: '10px',
                      border: '0.5px solid white',
                      borderRadius: '10px',
                      background: awayColor
                    }}
                  >
                    {t('matchSetup.awayTeam').toUpperCase()}
                  </div>
                  {/* Trikot container */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: 16,
                      cursor: 'pointer'
                    }}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      setColorPickerModal({
                        team: 'away',
                        position: { x: rect.left + rect.width / 2, y: rect.bottom + 8 }
                      })
                    }}
                  >
                    <div
                      className="shirt"
                      style={{ background: awayColor, transform: 'scale(0.65)', margin: '-10px' }}
                    >
                      <div className="collar" style={{ background: awayColor }} />
                      <div className="number" style={{ color: getContrastColor(awayColor) }}>1</div>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
                  <div className="field" style={{ flex: '0 0 60%', marginBottom: 0 }}>
                    <label style={{ fontSize: '18px', fontWeight: 600, alignItems: 'center', justifyContent: 'center', display: 'flex' }}>{t('matchSetup.teamName')}</label>
                    <input
                      type="text"
                      value={away}
                      onChange={e => setAway(e.target.value)}
                      placeholder={t('matchSetup.awayTeamName')}
                      style={{ width: '100%', padding: '10px', fontSize: '18px', fontWeight: 600, textAlign: 'center', alignItems: 'center', justifyContent: 'center', display: 'flex', background: 'rgba(255, 255, 255, 0.1)', borderRadius: '10px' }}
                    />
                  </div>
                  <div className="field" style={{ flex: '0 0 calc(40% - 16px)', marginBottom: 0 }}>
                    <label style={{ fontSize: '18px', fontWeight: 600, alignItems: 'center', justifyContent: 'center', display: 'flex' }}>{t('matchSetup.short')}</label>
                    <input
                      type="text"
                      value={awayShortName}
                      onChange={e => setAwayShortName(e.target.value.toUpperCase())}
                      maxLength={8}
                      placeholder={t('common.away').toUpperCase()}
                      style={{ width: '100%', textAlign: 'center', padding: '10px', fontSize: '18px', fontWeight: 600, alignItems: 'center', justifyContent: 'center', display: 'flex', background: 'rgba(255, 255, 255, 0.1)', borderRadius: '10px' }}
                    />
                  </div>

                </div>

              </div>

            </div>

          </div>
        </div>
        {match && !match.test && match.gamePin && (
          <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'center' }}>
            <div
              style={{
                padding: '12px 24px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '8px',
                fontFamily: 'monospace',
                fontSize: '18px',
                fontWeight: 700,
                letterSpacing: '2px',
                textAlign: 'center',
                minWidth: '200px',
                transition: 'background 0.2s ease'
              }}
            >
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '4px' }}>{t('matchSetup.gamePin')}</div>
              <div style={{ userSelect: 'text', cursor: 'text' }}>{match.gamePin}</div>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
                {t('matchSetup.gamePinDescription')}
              </div>
              {match && !match.test && match.gamePin && (
                <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'center' }}>
                  <div className="field" style={{ maxWidth: '400px', width: '100%' }}>
                    <label style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px', display: 'block' }}>
                      {t('matchSetup.notificationEmail')}
                    </label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="email"
                        placeholder={t('matchSetup.notificationEmailPlaceholder')}
                        value={notificationEmail}
                        onChange={(e) => setNotificationEmail(e.target.value)}
                        style={{
                          flex: 1,
                          padding: '10px 12px',
                          fontSize: '14px',
                          borderRadius: '6px',
                          border: '1px solid rgba(255, 255, 255, 0.2)',
                          background: 'rgba(255, 255, 255, 0.05)',
                          color: 'inherit'
                        }}
                      />
                      <button
                        type="button"
                        disabled={sendingEmail}
                        onClick={async () => {
                          console.log('[Email] Button clicked, email:', notificationEmail)
                          if (!notificationEmail || !notificationEmail.includes('@')) {
                            showAlert(t('matchSetup.invalidEmail') || 'Please enter a valid email address', 'warning')
                            return
                          }
                          setSendingEmail(true)
                          try {
                            const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
                            const res = await fetch(`${backendUrl}/api/match/send-info`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                email: notificationEmail,
                                gameN: gameN,
                                gamePin: match.gamePin,
                                home: home,
                                homeShortName: homeShortName,
                                away: away,
                                awayShortName: awayShortName,
                                date: date,
                                time: time,
                                hall: hall,
                                city: city,
                                league: league
                              })
                            })
                            const data = await res.json()
                            if (data.success) {
                              showAlert(t('matchSetup.emailSent') || 'Email sent successfully!', 'success')
                            } else {
                              showAlert(data.error || t('matchSetup.emailFailed') || 'Failed to send email', 'error')
                            }
                          } catch (err) {
                            console.error('Failed to send email:', err)
                            showAlert(t('matchSetup.emailFailed') || 'Failed to send email. Check server connection.', 'error')
                          } finally {
                            setSendingEmail(false)
                          }
                        }}
                        style={{
                          padding: '10px 16px',
                          fontSize: '14px',
                          borderRadius: '6px',
                          border: 'none',
                          background: sendingEmail ? 'var(--muted, #666)' : 'var(--primary, #4a90d9)',
                          color: 'white',
                          cursor: sendingEmail ? 'wait' : 'pointer',
                          fontWeight: 600,
                          opacity: sendingEmail ? 0.7 : 1
                        }}
                      >
                        {sendingEmail ? (t('matchSetup.sending') || 'Sending...') : (t('matchSetup.send') || 'Send')}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

          </div>

        )}



        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            onClick={(e) => {
              if (!canConfirmMatchInfo) {
                e.preventDefault()
                const tooltip = getMissingFieldsTooltip()
                if (tooltip) {
                  showAlert(tooltip, 'info')
                }
              } else {
                confirmMatchInfo()
              }
            }}
            disabled={!canConfirmMatchInfo}
            title={!canConfirmMatchInfo ? getMissingFieldsTooltip() : ''}
          >
            {matchInfoConfirmed ? t('matchSetup.save') : t('matchSetup.createMatch')}
          </button>
        </div>

        {/* Color Picker Modal for Match Info view */}
        {colorPickerModal && (
          <>
            <div
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 999,
                background: 'rgba(0, 0, 0, 0.6)'
              }}
              onClick={() => setColorPickerModal(null)}
            />
            <div
              style={{
                position: 'fixed',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 1000,
                background: '#1f2937',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '12px',
                padding: '16px',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
                minWidth: '280px'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ marginBottom: '12px', fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>
                {t('matchSetup.chooseTeamColour', { team: colorPickerModal.team === 'home' ? t('common.home') : t('common.away') })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
                {teamColors.map((color) => {
                  const isSelected = (colorPickerModal.team === 'home' ? homeColor : awayColor) === color
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => {
                        if (colorPickerModal.team === 'home') {
                          setHomeColor(color)
                        } else {
                          setAwayColor(color)
                        }
                        setColorPickerModal(null)
                      }}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '12px 8px',
                        background: isSelected ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                        border: isSelected ? '2px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        minWidth: '60px'
                      }}
                    >
                      <div className="shirt" style={{ background: color, transform: 'scale(0.8)' }}>
                        <div className="collar" style={{ background: color }} />
                        <div className="number" style={{ color: getContrastColor(color) }}>1</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        )}

        {/* Load Official Match Modal */}
        <LoadOfficialMatchModal
          open={loadOfficialMatchModal}
          onClose={() => setLoadOfficialMatchModal(false)}
          onSelectMatch={handleOfficialMatchSelect}
        />
      </MatchSetupInfoView>
    )
  }

  if (currentView === 'officials') {
    return (
      <MatchSetupOfficialsView>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <button className="secondary" onClick={() => { restoreOfficials(); setCurrentView('main') }}>← {t('common.back')}</button>
          <h2 style={{ marginLeft: 20, marginRight: 20 }}>{t('matchSetup.matchOfficials')}</h2>
          <div style={{ width: 80 }}></div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <OfficialCard
            title={t('matchSetup.referee1')}
            officialKey="ref1"
            lastName={ref1Last}
            firstName={ref1First}
            country={ref1Country}
            dob={ref1Dob}
            setLastName={setRef1Last}
            setFirstName={setRef1First}
            setCountry={setRef1Country}
            setDob={setRef1Dob}
            hasDatabase={true}
            selectorKey="ref1"
            onOpenDatabase={handleOpenDatabase}
            t={t}
          />
          <OfficialCard
            title={t('matchSetup.referee2')}
            officialKey="ref2"
            lastName={ref2Last}
            firstName={ref2First}
            country={ref2Country}
            dob={ref2Dob}
            setLastName={setRef2Last}
            setFirstName={setRef2First}
            setCountry={setRef2Country}
            setDob={setRef2Dob}
            hasDatabase={true}
            selectorKey="ref2"
            onOpenDatabase={handleOpenDatabase}
            t={t}
          />
          <OfficialCard
            title={t('matchSetup.scorer')}
            officialKey="scorer"
            lastName={scorerLast}
            firstName={scorerFirst}
            country={scorerCountry}
            dob={scorerDob}
            setLastName={setScorerLast}
            setFirstName={setScorerFirst}
            setCountry={setScorerCountry}
            setDob={setScorerDob}
            hasDatabase={false}
            selectorKey="scorer"
            onOpenDatabase={handleOpenDatabase}
            t={t}
          />
          <OfficialCard
            title={t('matchSetup.assistantScorer')}
            officialKey="asst"
            lastName={asstLast}
            firstName={asstFirst}
            country={asstCountry}
            dob={asstDob}
            setLastName={setAsstLast}
            setFirstName={setAsstFirst}
            setCountry={setAsstCountry}
            setDob={setAsstDob}
            onOpenDatabase={handleOpenDatabase}
            t={t}
          />
          <div style={{ gridColumn: '1 / -1' }}>
            <LineJudgesCard
              lineJudge1={lineJudge1}
              lineJudge2={lineJudge2}
              lineJudge3={lineJudge3}
              lineJudge4={lineJudge4}
              setLineJudge1={setLineJudge1}
              setLineJudge2={setLineJudge2}
              setLineJudge3={setLineJudge3}
              setLineJudge4={setLineJudge4}
              t={t}
            />
          </div>
        </div>
        {/* Referee Selector */}
        <RefereeSelector
          open={showRefereeSelector !== null}
          onClose={() => setShowRefereeSelector(null)}
          onSelect={(referee) => {
            if (showRefereeSelector === 'ref1') {
              setRef1First(referee.firstName || '')
              setRef1Last(referee.lastName || '')
              setRef1Country(referee.country || 'CHE')
              setRef1Dob(referee.dob || '01.01.1900')
            } else if (showRefereeSelector === 'ref2') {
              setRef2First(referee.firstName || '')
              setRef2Last(referee.lastName || '')
              setRef2Country(referee.country || 'CHE')
              setRef2Dob(referee.dob || '01.01.1900')
            } else if (showRefereeSelector === 'scorer') {
              setScorerFirst(referee.firstName || '')
              setScorerLast(referee.lastName || '')
              setScorerCountry(referee.country || 'CHE')
              setScorerDob(referee.dob || '01.01.1900')
            }
          }}
          position={refereeSelectorPosition}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={async () => {
            // Check if any changes were made (skip sync if no changes)
            const currentOfficials = {
              ref1First, ref1Last, ref1Country, ref1Dob,
              ref2First, ref2Last, ref2Country, ref2Dob,
              scorerFirst, scorerLast, scorerCountry, scorerDob,
              asstFirst, asstLast, asstCountry, asstDob,
              lineJudge1, lineJudge2, lineJudge3, lineJudge4
            }
            const hasChanges = hasOfficialsChanged(originalOfficialsRef.current, currentOfficials)

            // If no changes, just go back to main view
            if (!hasChanges) {
              setCurrentView('main')
              return
            }

            // Save officials to database if matchId exists
            if (matchId) {
              await db.matches.update(matchId, {
                officials: buildOfficialsArray(
                  { firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: ref1Dob },
                  { firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: ref2Dob },
                  { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob },
                  { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
                  { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 }
                )
              })

              // Sync officials to Supabase as JSONB
              const matchForOfficials = await db.matches.get(matchId)
              if (matchForOfficials?.seed_key) {
                await db.sync_queue.add({
                  resource: 'match',
                  action: 'update',
                  payload: {
                    id: matchForOfficials.seed_key,
                    officials: buildOfficialsArray(
                      { firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: formatDobForSync(ref1Dob) },
                      { firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: formatDobForSync(ref2Dob) },
                      { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: formatDobForSync(scorerDob) },
                      { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: formatDobForSync(asstDob) },
                      { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 },
                      true // useSnakeCase for Supabase
                    )
                  },
                  ts: new Date().toISOString(),
                  status: 'queued'
                })
              }

              setNoticeModal({ message: t('matchSetup.officialsSaved'), type: 'success', syncing: true })

              // Poll to check when sync completes
              const checkSyncStatus = async () => {
                let attempts = 0
                const maxAttempts = 20
                const interval = setInterval(async () => {
                  attempts++
                  try {
                    const queued = await db.sync_queue.where('status').equals('queued').count()
                    if (queued === 0) {
                      clearInterval(interval)
                      setNoticeModal({ message: t('matchSetup.officialsSynced'), type: 'success' })
                    } else if (attempts >= maxAttempts) {
                      clearInterval(interval)
                      setNoticeModal({ message: t('matchSetup.officialsSavedLocal'), type: 'success' })
                    }
                  } catch (err) {
                    clearInterval(interval)
                  }
                }, 500)
              }
              checkSyncStatus()
            }
            setCurrentView('main')
          }}>{t('common.confirm')}</button>
        </div>
      </MatchSetupOfficialsView>
    )
  }

  if (currentView === 'home') {
    return (
      <MatchSetupHomeTeamView>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <button className="secondary" onClick={() => { restoreHomeTeam(); setCurrentView('main') }}>← {t('common.back')}</button>
          <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text)', padding: '10px', border: '0.5px solid white', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.1)' }}>{home || t('matchSetup.homeTeam')}</h2>
          <div style={{ width: 80 }}></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <h1 style={{ margin: 0 }}>{t('roster.title')}</h1>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => {
                setHomeRoster([])
                setBenchHome([{ role: 'Coach', firstName: '', lastName: '', dob: '' }])
                setHomeCoachSignature(null)
                setHomeCaptainSignature(null)
              }}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                fontWeight: 600,
                background: '#dc2626',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              {t('roster.deleteRoster')}
            </button>
            <button
              onClick={() => setTestRosterConfirm('home')}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                fontWeight: 600,
                background: '#000',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              {t('roster.loadTestRoster')}
            </button>
          </div>
        </div>
        {/* Upload Methods for Home Team + Player Stats */}
        <div style={{ marginBottom: '12px', display: 'flex', gap: '12px' }}>
          {/* Left: Upload section */}
          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.2)',
            flex: 1
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Upload button row with Local/Remote toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  ref={homeFileInputRef}
                  type="file"
                  accept=".pdf"
                  onChange={handleHomeFileSelect}
                  style={{ display: 'none' }}
                />
                <button
                  data-help-id="setup-pdf-import"
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (homeUploadMode === 'local') {
                      homeFileInputRef.current?.click()
                    } else {
                      handleSearchHomeRoster()
                    }
                  }}
                  disabled={homePdfLoading || homeRosterSearching}
                  style={{
                    padding: '8px 16px',
                    fontSize: '14px',
                    flex: 1
                  }}
                >
                  {homeUploadMode === 'local' ? t('matchSetup.uploadPdf') : (homeRosterSearching ? t('common.loading') : t('matchSetup.searchForRoster'))}
                </button>
                {/* Local/Remote Toggle */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  background: 'rgba(255, 255, 255, 0.1)',
                  borderRadius: '6px',
                  padding: '2px',
                  gap: '2px'
                }}>
                  <button
                    type="button"
                    onClick={() => setHomeUploadMode('local')}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: homeUploadMode === 'local' ? 'rgba(59, 130, 246, 0.3)' : 'transparent',
                      color: homeUploadMode === 'local' ? '#60a5fa' : 'rgba(255, 255, 255, 0.6)',
                      border: homeUploadMode === 'local' ? '1px solid rgba(59, 130, 246, 0.5)' : '1px solid transparent',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    {t('matchSetup.local')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setHomeUploadMode('remote')}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: homeUploadMode === 'remote' ? 'rgba(59, 130, 246, 0.3)' : 'transparent',
                      color: homeUploadMode === 'remote' ? '#60a5fa' : 'rgba(255, 255, 255, 0.6)',
                      border: homeUploadMode === 'remote' ? '1px solid rgba(59, 130, 246, 0.5)' : '1px solid transparent',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    {t('matchSetup.remote')}
                  </button>
                </div>
              </div>
              {/* Local upload - file selected */}
              {homeUploadMode === 'local' && homePdfFile && (
                <>
                  <span style={{ fontSize: '12px', color: 'var(--text)' }}>
                    {homePdfFile.name}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={handleHomeImportClick}
                    disabled={homePdfLoading}
                    style={{ padding: '8px 16px', fontSize: '14px', width: '100%' }}
                  >
                    {homePdfLoading ? t('matchSetup.importing') : t('matchSetup.importPdf')}
                  </button>
                </>
              )}
              {homeUploadMode === 'local' && homePdfError && (
                <span style={{ color: '#ef4444', fontSize: '12px' }}>
                  {homePdfError}
                </span>
              )}
              {/* Remote Upload */}
              {homeUploadMode === 'remote' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600 }}>{t('matchSetup.gameNumber')}:</span>
                    <span style={{ fontSize: '14px', fontFamily: 'monospace', fontWeight: 600, color: 'var(--text)' }}>
                      {match?.game_n || match?.gameNumber || gameN || 'N/A'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600 }}>{t('matchSetup.uploadPin')}:</span>
                    {match?.homeTeamUploadPin ? (
                      <>
                        <span style={{ fontSize: '16px', fontFamily: 'monospace', fontWeight: 700, color: 'var(--accent)' }}>
                          {match.homeTeamUploadPin}
                        </span>
                        <button
                          type="button"
                          className="secondary"
                          onClick={async () => {
                            if (!matchId) return
                            const generatePinCode = (existingPins = []) => {
                              const chars = '0123456789'
                              let pin = ''
                              let attempts = 0
                              const maxAttempts = 100
                              do {
                                pin = ''
                                for (let i = 0; i < 6; i++) {
                                  pin += chars.charAt(Math.floor(Math.random() * chars.length))
                                }
                                attempts++
                                if (attempts >= maxAttempts) break
                              } while (existingPins.includes(pin))
                              return pin
                            }
                            const match = await db.matches.get(matchId)
                            const existingPins = [
                              match?.refereePin,
                              match?.homeTeamPin,
                              match?.awayTeamPin,
                              match?.awayTeamUploadPin
                            ].filter(Boolean)
                            const newPin = generatePinCode(existingPins)
                            await db.matches.update(matchId, { homeTeamUploadPin: newPin })
                          }}
                          style={{ padding: '4px 8px', fontSize: '11px' }}
                        >
                          {t('matchSetup.regenerate')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="secondary"
                        onClick={async () => {
                          if (!matchId) return
                          const generatePinCode = (existingPins = []) => {
                            const chars = '0123456789'
                            let pin = ''
                            let attempts = 0
                            const maxAttempts = 100
                            do {
                              pin = ''
                              for (let i = 0; i < 6; i++) {
                                pin += chars.charAt(Math.floor(Math.random() * chars.length))
                              }
                              attempts++
                              if (attempts >= maxAttempts) break
                            } while (existingPins.includes(pin))
                            return pin
                          }
                          const match = await db.matches.get(matchId)
                          const existingPins = [
                            match?.refereePin,
                            match?.homeTeamPin,
                            match?.awayTeamPin,
                            match?.awayTeamUploadPin
                          ].filter(Boolean)
                          const newPin = generatePinCode(existingPins)
                          await db.matches.update(matchId, { homeTeamUploadPin: newPin })
                        }}
                        style={{ padding: '4px 8px', fontSize: '11px' }}
                      >
                        {t('matchSetup.generatePin')}
                      </button>
                    )}
                  </div>
                  {match?.pendingHomeRoster && (
                    <div style={{
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '8px',
                      padding: '12px',
                      background: 'rgba(15, 23, 42, 0.2)',
                      marginTop: '12px'
                    }}>
                      <h4 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px', fontWeight: 600 }}>{t('matchSetup.rosterUploaded')}</h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                        <div style={{ fontSize: '12px' }}>
                          {t('matchSetup.playersCount')}: {match.pendingHomeRoster.players?.length || 0}
                        </div>
                        <div style={{ fontSize: '12px' }}>
                          {t('matchSetup.benchOfficialsCount')}: {match.pendingHomeRoster.bench?.length || 0}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setRosterPreview('home')}
                          style={{ padding: '8px 16px', fontSize: '12px', background: 'rgba(59, 130, 246, 0.3)', color: 'var(--text)', flex: 1 }}
                        >
                          {t('matchSetup.previewRoster')}
                        </button>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          type="button"
                          className="secondary"
                          onClick={async () => {
                            if (!matchId || !match?.pendingHomeRoster) return
                            const pending = match.pendingHomeRoster
                            const importedPlayers = pending.players || []
                            const importedBench = pending.bench || []

                            // Extract signatures from pending roster
                            const importedCoachSig = pending.coachSignature || null
                            const importedCaptainSig = pending.captainSignature || null

                            // Update state
                            setHomeRoster(importedPlayers)
                            setBenchHome(importedBench)

                            // Also update signature states if signatures were provided
                            if (importedCoachSig) setHomeCoachSignature(importedCoachSig)
                            if (importedCaptainSig) setHomeCaptainSignature(importedCaptainSig)

                            // Save to database immediately
                            if (match.homeTeamId) {
                              // Delete existing players
                              const existingPlayers = await db.players.where('teamId').equals(match.homeTeamId).toArray()
                              for (const ep of existingPlayers) {
                                await db.players.delete(ep.id)
                              }

                              // Add imported players
                              if (importedPlayers.length) {
                                await db.players.bulkAdd(
                                  importedPlayers.map(p => ({
                                    teamId: match.homeTeamId,
                                    number: p.number,
                                    name: `${p.lastName || ''} ${p.firstName || ''}`.trim(),
                                    lastName: p.lastName || '',
                                    firstName: p.firstName || '',
                                    dob: p.dob || null,
                                    libero: p.libero || '',
                                    isCaptain: !!p.isCaptain,
                                    isLfp: !!p.isLfp,
                                    role: null,
                                    createdAt: new Date().toISOString()
                                  }))
                                )
                              }

                              // Update match with bench officials and signatures
                              const matchUpdate = {
                                bench_home: importedBench,
                                pendingHomeRoster: null
                              }
                              if (importedCoachSig) matchUpdate.homeCoachSignature = importedCoachSig
                              if (importedCaptainSig) matchUpdate.homeCaptainSignature = importedCaptainSig

                              await db.matches.update(matchId, matchUpdate)
                              console.log('[MatchSetup] Accepted home roster with signatures:', { hasCoach: !!importedCoachSig, hasCaptain: !!importedCaptainSig })
                            } else {
                              // If no teamId yet, just clear pending
                              await db.matches.update(matchId, { pendingHomeRoster: null })
                            }
                          }}
                          style={{ padding: '8px 16px', fontSize: '12px', background: '#22c55e', color: '#000', flex: 1 }}
                        >
                          {t('matchSetup.acceptRoster')}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={async () => {
                            if (!matchId) return
                            await db.matches.update(matchId, { pendingHomeRoster: null })
                          }}
                          style={{ padding: '8px 16px', fontSize: '12px', background: 'rgba(255, 255, 255, 0.1)', color: 'var(--text)', flex: 1 }}
                        >
                          {t('matchSetup.rejectRoster')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Right: Player Stats */}
          {(() => {
            const homeCaptain = homeRoster.find(p => p.isCaptain)
            const homeNonLiberoCount = homeRoster.filter(p => !p.libero).length
            const homeHasError = !homeCaptain || homeNonLiberoCount < 6
            return (
              <div style={{
                border: homeHasError ? '1px solid #ef4444' : '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '8px',
                padding: '12px',
                background: homeHasError ? 'rgba(239, 68, 68, 0.15)' : 'rgba(15, 23, 42, 0.2)',
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '16px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: homeNonLiberoCount < 6 ? '#ef4444' : 'rgba(255, 255, 255, 0.7)' }}>{t('matchSetup.players')}:</span>
                  <span style={{ fontSize: '18px', fontWeight: 700, color: homeNonLiberoCount < 6 ? '#ef4444' : 'var(--text)' }}>{homeRoster.length}</span>
                  <span style={{ fontSize: '16px', color: homeNonLiberoCount < 6 ? '#ef4444' : 'rgba(255, 255, 255, 0.5)' }}>
                    ({homeNonLiberoCount} + {homeRoster.filter(p => p.libero).length} {homeRoster.filter(p => p.libero).length !== 1 ? 'liberos' : 'libero'})
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: !homeCaptain ? '#ef4444' : 'rgba(255, 255, 255, 0.7)' }}>{t('matchSetup.captain')}:</span>
                  {homeCaptain ? (
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '28px',
                      height: '28px',
                      borderRadius: '50%',
                      border: '2px solid #22c55e',
                      fontSize: '14px',
                      fontWeight: 700,
                      color: '#22c55e'
                    }}>{homeCaptain.number || '?'}</span>
                  ) : (
                    <span style={{ fontSize: '14px', fontStyle: 'italic', color: '#ef4444' }}>—</span>
                  )}
                </div>
              </div>
            )
          })()}
        </div>
        {/* Add new player section */}
        {homeRoster.length < 14 && (
          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.2)',
            marginBottom: '8px',
          }}>
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: 8 }}>{t('matchSetup.addNewPlayer')}</div>
            <div data-help-id="setup-add-player" className="row" style={{ width: '100%', maxWidth: '100%', overflow: 'hidden' }}>

              <input className="w-num" placeholder={t('matchSetup.numberPlaceholder')} type="number" inputMode="numeric" value={homeNum} onChange={e => setHomeNum(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
              <input className="w-name capitalize" placeholder={t('matchSetup.lastName')} value={homeLast} onChange={e => setHomeLast(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
              <input className="w-name capitalize" placeholder={t('matchSetup.firstName')} value={homeFirst} onChange={e => setHomeFirst(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
              <input className="w-dob" placeholder={t('matchSetup.dateOfBirthPlaceholder')} type="date" value={homeDob ? formatDateToISO(homeDob) : ''} onChange={e => setHomeDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
              <select data-help-id="setup-libero-toggle" className="w-90" value={homeLibero} onChange={e => {
                let newValue = e.target.value
                // If L2 is selected but no L1 exists, automatically change L2 to L1
                if (newValue === 'libero2' && !homeRoster.some(p => p.libero === 'libero1')) {
                  newValue = 'libero1'
                }
                setHomeLibero(newValue)
              }}>
                <option value=""></option>
                {!homeRoster.some(p => p.libero === 'libero1') && (
                  <option value="libero1">{t('matchSetup.libero1')}</option>
                )}
                {!homeRoster.some(p => p.libero === 'libero2') && (
                  <option value="libero2">{t('matchSetup.libero2')}</option>
                )}
              </select>
              <div data-help-id="setup-captain-toggle" className="w-captain">
                <div
                  onClick={() => setHomeCaptain(!homeCaptain)}
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '4px',
                    border: homeCaptain ? '2px solid #22c55e' : '2px solid rgba(255,255,255,0.3)',
                    background: homeCaptain ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 700,
                    color: homeCaptain ? '#22c55e' : 'rgba(255,255,255,0.3)',
                    userSelect: 'none',
                    flexShrink: 0
                  }}
                >C</div>
              </div>
              <div className="w-action">
                <button type="button" className="secondary" onClick={() => {
                  if (!homeLast || !homeFirst) return
                  const newPlayer = { number: homeNum ? Number(homeNum) : null, lastName: homeLast, firstName: homeFirst, dob: homeDob, libero: homeLibero, isCaptain: homeCaptain, isLfp: false }
                  setHomeRoster(list => {
                    const cleared = homeCaptain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                    const next = [...cleared, newPlayer].sort((a, b) => {
                      const an = a.number ?? 999
                      const bn = b.number ?? 999
                      return an - bn
                    })
                    return next
                  })
                  setHomeNum(''); setHomeFirst(''); setHomeLast(''); setHomeDob(''); setHomeLibero(''); setHomeCaptain(false)
                }}>{t('common.add')}</button>
              </div>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Roster Header Row */}
          <div className="row" style={{ alignItems: 'center', fontWeight: 600, fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)', marginBottom: 4, padding: '6px 8px', border: '2px solid transparent' }}>
            <div className="w-num" style={{ textAlign: 'center' }}>#</div>
            <div className="w-name">{t('matchSetup.lastName')}</div>
            <div className="w-name">{t('matchSetup.firstName')}</div>
            <div className="w-dob">{t('matchSetup.dateOfBirth')}</div>
            <div className="w-90" style={{ textAlign: 'center' }}>{t('matchSetup.role')}</div>
            <div className="w-captain">C</div>
            <div className="w-action"></div>
          </div>
          {homeRoster.map((p, i) => {
            // Check if this player's number is a duplicate
            const isDuplicate = p.number != null && p.number !== '' &&
              homeRoster.some((other, idx) => idx !== i && other.number === p.number)

            // Determine border style based on captain/libero status
            const isCaptain = p.isCaptain || false
            const isLibero = !!p.libero
            // Base style for all rows (transparent border for alignment)
            let borderStyle = {
              borderRadius: '6px',
              padding: '6px 8px',
              border: '2px solid transparent'
            }
            if (isCaptain && isLibero) {
              // Both: alternating green/white striped border
              borderStyle = {
                padding: '6px 8px',
                background: 'rgba(34, 197, 94, 0.05)',
                border: '2px solid',
                borderImage: 'repeating-linear-gradient(90deg, #22c55e 0, #22c55e 6px, #ffffff 6px, #ffffff 12px) 1'
              }
            } else if (isCaptain) {
              // Captain only: green border
              borderStyle = {
                border: '2px solid #22c55e',
                borderRadius: '6px',
                padding: '6px 8px',
                background: 'rgba(34, 197, 94, 0.1)'
              }
            } else if (isLibero) {
              // Libero only: white border
              borderStyle = {
                border: '2px solid rgba(255, 255, 255, 0.8)',
                borderRadius: '6px',
                padding: '6px 8px',
                background: 'rgba(255, 255, 255, 0.05)'
              }
            }

            return (
              <div key={`h-${i}`} className="row" style={{ alignItems: 'center', ...borderStyle }}>
                <input
                  className="w-num"
                  placeholder="#"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="99"
                  value={p.number ?? ''}
                  style={isDuplicate ? {
                    background: 'rgba(239, 68, 68, 0.2)',
                    border: '2px solid #ef4444',
                    color: '#ef4444'
                  } : undefined}
                  title={isDuplicate ? t('scoreboard.duplicateJersey') : undefined}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onKeyPress={e => {
                    if (!/[0-9]/.test(e.key) && e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Tab') {
                      e.preventDefault()
                    }
                  }}
                  onChange={e => {
                    const val = e.target.value ? Number(e.target.value) : null
                    if (val !== null && (val < 1 || val > 99)) return
                    const updated = [...homeRoster]
                    updated[i] = { ...updated[i], number: val }
                    setHomeRoster(updated)
                  }}
                  onBlur={() => {
                    // Sort roster by player number when done editing
                    const sorted = [...homeRoster].sort((a, b) => (a.number || 0) - (b.number || 0))
                    setHomeRoster(sorted)
                  }}
                />
                <input
                  className="w-name capitalize"
                  placeholder={t('matchSetup.placeholders.lastName')}
                  value={p.lastName || ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={e => {
                    const updated = [...homeRoster]
                    updated[i] = { ...updated[i], lastName: e.target.value }
                    setHomeRoster(updated)
                  }}
                />
                <input
                  className="w-name capitalize"
                  placeholder={t('matchSetup.placeholders.firstName')}
                  value={p.firstName || ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={e => {
                    const updated = [...homeRoster]
                    updated[i] = { ...updated[i], firstName: e.target.value }
                    setHomeRoster(updated)
                  }}
                />
                <input
                  className="w-dob"
                  placeholder={t('matchSetup.dateOfBirthPlaceholder')}
                  type="date"
                  value={p.dob ? formatDateToISO(p.dob) : ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={e => {
                    const updated = [...homeRoster]
                    updated[i] = { ...updated[i], dob: e.target.value ? formatDateToDDMMYYYY(e.target.value) : '' }
                    setHomeRoster(updated)
                  }}
                />
                <select
                  className="w-90"
                  value={p.libero || ''}
                  onChange={async e => {
                    const updated = [...homeRoster]
                    const oldValue = updated[i].libero
                    updated[i] = { ...updated[i], libero: e.target.value }

                    // If L2 is selected but no L1 exists, automatically change L2 to L1
                    if (e.target.value === 'libero2') {
                      const hasL1 = updated.some((player, idx) => idx !== i && player.libero === 'libero1')
                      if (!hasL1) {
                        updated[i] = { ...updated[i], libero: 'libero1' }
                      }
                    }

                    // If L1 is being cleared and there's an L2, promote L2 to L1
                    if (oldValue === 'libero1' && !e.target.value) {
                      const l2Idx = updated.findIndex((player, idx) => idx !== i && player.libero === 'libero2')
                      if (l2Idx !== -1) {
                        updated[l2Idx] = { ...updated[l2Idx], libero: 'libero1' }
                        // Update L2->L1 player in database if they have an ID
                        if (updated[l2Idx].id) {
                          await db.players.update(updated[l2Idx].id, { libero: 'libero1' })
                        }
                      }
                    }

                    setHomeRoster(updated)

                    // Update database immediately if player has an ID
                    if (p.id) {
                      await db.players.update(p.id, { libero: updated[i].libero })
                    }
                  }}
                >
                  <option value=""></option>
                  {!homeRoster.some((player, idx) => idx !== i && player.libero === 'libero1') && (
                    <option value="libero1">{t('matchSetup.libero1')}</option>
                  )}
                  {!homeRoster.some((player, idx) => idx !== i && player.libero === 'libero2') && (
                    <option value="libero2">{t('matchSetup.libero2')}</option>
                  )}
                </select>
                <div className="w-captain">
                  <div
                    onClick={() => {
                      const updated = homeRoster.map((player, idx) => ({
                        ...player,
                        isCaptain: idx === i ? !player.isCaptain : false
                      }))
                      setHomeRoster(updated)
                    }}
                    style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: '4px',
                      border: (p.isCaptain || false) ? '2px solid #22c55e' : '2px solid rgba(255,255,255,0.3)',
                      background: (p.isCaptain || false) ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: 700,
                      color: (p.isCaptain || false) ? '#22c55e' : 'rgba(255,255,255,0.3)',
                      userSelect: 'none',
                      flexShrink: 0
                    }}
                  >C</div>
                </div>
                <div className="w-action">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setHomeRoster(list => list.filter((_, idx) => idx !== i))}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        <h4 data-help-id="setup-bench-officials">{t('matchSetup.benchOfficials')} — {t('common.home')}</h4>
        {/* Bench Header Row */}
        <div className="row" style={{ alignItems: 'center', fontWeight: 600, fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)', marginBottom: 4, padding: '6px 8px', border: '2px solid transparent' }}>
          <div className="w-220">{t('matchSetup.role')}</div>
          <div className="w-name">{t('matchSetup.lastName')}</div>
          <div className="w-name">{t('matchSetup.firstName')}</div>
          <div className="w-dob">{t('matchSetup.dateOfBirth')}</div>
          <div className="w-action"></div>
        </div>
        {sortBenchByHierarchy(benchHome).map((m, i) => {
          const originalIdx = benchHome.findIndex(b => b === m)
          return (
            <div key={`bh-${originalIdx}`} className="row bench-row" style={{ alignItems: 'center', padding: '6px 8px', border: '2px solid transparent', borderRadius: '6px' }}>
              <select className="w-220" value={m.role || 'Coach'} onChange={e => {
                const newRole = e.target.value || 'Coach'
                // Check if this role is already taken by another official
                const isRoleTaken = benchHome.some((b, idx) => idx !== originalIdx && b.role === newRole)
                if (isRoleTaken) {
                  // Don't allow duplicate roles
                  return
                }
                setBenchHome(arr => {
                  const a = [...arr];
                  a[originalIdx] = { ...a[originalIdx], role: newRole };
                  return a
                })
              }}>
                {BENCH_ROLES.map(role => {
                  const isRoleTaken = benchHome.some((b, idx) => idx !== originalIdx && b.role === role.value)
                  return (
                    <option key={role.value} value={role.value} disabled={isRoleTaken}>
                      {t(role.labelKey, role.label)} - {t(role.fullLabelKey)}{isRoleTaken ? ` (${t('matchSetup.alreadyAssigned', 'already assigned')})` : ''}
                    </option>
                  )
                })}
              </select>
              <input className="w-name capitalize" placeholder={t('matchSetup.lastName')} value={m.lastName} onChange={e => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], lastName: e.target.value }; return a })} />
              <input className="w-name capitalize" placeholder={t('matchSetup.firstName')} value={m.firstName} onChange={e => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], firstName: e.target.value }; return a })} />
              <input className="w-dob" placeholder={t('matchSetup.dateOfBirthPlaceholder')} type="date" value={m.dob ? formatDateToISO(m.dob) : ''} onChange={e => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], dob: e.target.value ? formatDateToDDMMYYYY(e.target.value) : '' }; return a })} />
              <div className="w-action">
                <button type="button" className="secondary" onClick={() => {
                  const updated = benchHome.filter((_, idx) => idx !== originalIdx)
                  setBenchHome(updated)
                  // Trigger save immediately
                  setTimeout(() => saveDraft(true), 100)
                }} style={{ padding: '4px 8px', fontSize: '12px' }}>
                  {t('common.delete')}
                </button>
              </div>
            </div>
          )
        })}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="secondary"
            disabled={benchHome.length >= 5}
            onClick={() => {
              // Find the first available role
              const takenRoles = new Set(benchHome.map(b => b.role))
              const availableRole = BENCH_ROLES.find(r => !takenRoles.has(r.value))
              if (availableRole) {
                setBenchHome([...benchHome, initBench(availableRole.value)])
              }
            }}
            style={{ padding: '4px 8px', fontSize: '12px' }}
          >
            {t('matchSetup.addBenchOfficial')}
          </button>
        </div>

        {/* Signatures Section */}
        <div style={{
          marginTop: '24px',
          padding: '16px',
          background: 'rgba(255,255,255,0.05)',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.1)'
        }}>
          <h4 style={{ margin: 0, marginBottom: '12px' }}>
            {t('rosterSetup.signatures', 'Signatures')}
          </h4>
          <p style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: '16px' }}>
            {t('rosterSetup.signaturesDescription', 'Optional: Coach and captain can sign the roster before submitting.')}
          </p>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            {/* Coach Signature */}
            <div style={{ flex: 1, minWidth: '150px' }}>
              <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                {t('rosterSetup.coachSignature', 'Coach Signature')}
              </div>
              <div
                onClick={() => setOpenSignature('home-coach')}
                style={{
                  width: '100%',
                  height: '80px',
                  background: homeCoachSignature ? 'white' : 'rgba(255,255,255,0.05)',
                  border: homeCoachSignature ? '2px solid #22c55e' : '2px dashed rgba(255,255,255,0.3)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden'
                }}
              >
                {homeCoachSignature ? (
                  <img src={homeCoachSignature} alt={t('matchSetup.coachSignature')} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                ) : (
                  <span style={{ color: 'var(--muted)', fontSize: '12px' }}>
                    {t('rosterSetup.tapToSign', 'Tap to sign')}
                  </span>
                )}
              </div>
              {homeCoachSignature && (
                <button
                  onClick={(e) => { e.stopPropagation(); setHomeCoachSignature(null); }}
                  style={{
                    marginTop: '6px',
                    padding: '3px 10px',
                    fontSize: '11px',
                    background: 'rgba(239, 68, 68, 0.2)',
                    color: '#ef4444',
                    border: '1px solid #ef4444',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  {t('common.clear', 'Clear')}
                </button>
              )}
            </div>

            {/* Captain Signature */}
            <div style={{ flex: 1, minWidth: '150px' }}>
              <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                {t('rosterSetup.captainSignature', 'Captain Signature')}
              </div>
              <div
                onClick={() => setOpenSignature('home-captain')}
                style={{
                  width: '100%',
                  height: '80px',
                  background: homeCaptainSignature ? 'white' : 'rgba(255,255,255,0.05)',
                  border: homeCaptainSignature ? '2px solid #22c55e' : '2px dashed rgba(255,255,255,0.3)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden'
                }}
              >
                {homeCaptainSignature ? (
                  <img src={homeCaptainSignature} alt={t('matchSetup.captainSignature')} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                ) : (
                  <span style={{ color: 'var(--muted)', fontSize: '12px' }}>
                    {t('rosterSetup.tapToSign', 'Tap to sign')}
                  </span>
                )}
              </div>
              {homeCaptainSignature && (
                <button
                  onClick={(e) => { e.stopPropagation(); setHomeCaptainSignature(null); }}
                  style={{
                    marginTop: '6px',
                    padding: '3px 10px',
                    fontSize: '11px',
                    background: 'rgba(239, 68, 68, 0.2)',
                    color: '#ef4444',
                    border: '1px solid #ef4444',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  {t('common.clear', 'Clear')}
                </button>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={async () => {

            // Check if any changes were made (skip sync if no changes)
            const hasChanges = hasRosterChanged(
              originalHomeTeamRef.current?.homeRoster,
              homeRoster,
              originalHomeTeamRef.current?.benchHome,
              benchHome
            )

            // If no changes, just go back to main view
            if (!hasChanges) {
              console.log('[MatchSetup] No home roster changes, skipping sync')
              setCurrentView('main')
              return
            }

            // Roster save validation - only block for critical errors (duplicates, invalid numbers)
            // Missing numbers, captain, coach are validated at coin toss confirmation instead
            const validationErrors = []

            // Check for duplicate numbers (critical - must block)
            const numbers = homeRoster.filter(p => p.number != null && p.number !== '').map(p => p.number)
            const duplicateNumbers = numbers.filter((num, idx) => numbers.indexOf(num) !== idx)
            if (duplicateNumbers.length > 0) {
              console.log('[MatchSetup] Home duplicate numbers:', duplicateNumbers)
              validationErrors.push(t('matchSetup.validation.duplicateNumbers', { numbers: [...new Set(duplicateNumbers)].join(', ') }))
            }

            // Check for invalid numbers (must be 1-99) - critical - must block
            const invalidNumbers = homeRoster.filter(p => p.number != null && p.number !== '' && (p.number < 1 || p.number > 99))
            if (invalidNumbers.length > 0) {
              console.log('[MatchSetup] Home invalid numbers:', invalidNumbers.map(p => p.number))
              validationErrors.push(t('matchSetup.validation.invalidNumbers', { numbers: invalidNumbers.map(p => p.number).join(', ') }))
            }

            // Show validation errors if any critical errors
            if (validationErrors.length > 0) {
              console.log('[MatchSetup] Home roster validation errors:', validationErrors)
              setNoticeModal({ message: t('matchSetup.validation.fixIssues', { issues: validationErrors.join('\n• ') }) })
              return
            }

            console.log('[MatchSetup] Home roster validation passed, saving...')

            // Save home team data to database if matchId exists
            if (matchId && match?.homeTeamId) {
              await db.teams.update(match.homeTeamId, {
                name: home,
                color: homeColor
              })

              // Update players with captain status
              if (homeRoster.length) {
                const existingPlayers = await db.players.where('teamId').equals(match.homeTeamId).toArray()
                const rosterNumbers = new Set(homeRoster.map(p => p.number).filter(n => n != null))

                for (const rosterPlayer of homeRoster) {
                  if (!rosterPlayer.number) continue // Skip players without numbers

                  const existingPlayer = existingPlayers.find(ep => ep.number === rosterPlayer.number)
                  if (existingPlayer) {
                    // Update existing player
                    await db.players.update(existingPlayer.id, {
                      name: `${rosterPlayer.lastName} ${rosterPlayer.firstName}`,
                      lastName: rosterPlayer.lastName,
                      firstName: rosterPlayer.firstName,
                      dob: rosterPlayer.dob || null,
                      libero: rosterPlayer.libero || '',
                      isCaptain: !!rosterPlayer.isCaptain,
                      isLfp: !!rosterPlayer.isLfp
                    })
                  } else {
                    // Add new player (including newly added players after unlock)
                    await db.players.add({
                      teamId: match.homeTeamId,
                      number: rosterPlayer.number,
                      name: `${rosterPlayer.lastName} ${rosterPlayer.firstName}`,
                      lastName: rosterPlayer.lastName,
                      firstName: rosterPlayer.firstName,
                      dob: rosterPlayer.dob || null,
                      libero: rosterPlayer.libero || '',
                      isCaptain: !!rosterPlayer.isCaptain,
                      isLfp: !!rosterPlayer.isLfp,
                      role: null,
                      createdAt: new Date().toISOString()
                    })
                  }
                }

                // Remove players that are no longer in the roster
                for (const ep of existingPlayers) {
                  if (!rosterNumbers.has(ep.number)) {
                    await db.players.delete(ep.id)
                  }
                }
              }

              // Update match with short name, bench officials, and restore signatures (re-lock)
              const updateData = {
                homeShortName: homeShortName || home.substring(0, 3).toUpperCase(),
                bench_home: benchHome  // Save bench officials to match record
              }

              // Save current signatures (new or existing) to database
              if (homeCoachSignature) {
                updateData.homeCoachSignature = homeCoachSignature
                setSavedSignatures(prev => ({ ...prev, homeCoach: homeCoachSignature }))
              } else if (savedSignatures.homeCoach) {
                // Restore previously saved signature if current is empty (re-lock the team)
                updateData.homeCoachSignature = savedSignatures.homeCoach
                setHomeCoachSignature(savedSignatures.homeCoach)
              }
              if (homeCaptainSignature) {
                updateData.homeCaptainSignature = homeCaptainSignature
                setSavedSignatures(prev => ({ ...prev, homeCaptain: homeCaptainSignature }))
              } else if (savedSignatures.homeCaptain) {
                updateData.homeCaptainSignature = savedSignatures.homeCaptain
                setHomeCaptainSignature(savedSignatures.homeCaptain)
              }

              await db.matches.update(matchId, updateData)

              // Sync home team data to Supabase as JSONB
              if (match?.seed_key) {
                const homeCoachSig = homeCoachSignature || savedSignatures.homeCoach || null
                const homeCaptainSig = homeCaptainSignature || savedSignatures.homeCaptain || null
                await db.sync_queue.add({
                  resource: 'match',
                  action: 'update',
                  payload: {
                    id: match.seed_key,
                    // JSONB columns
                    home_team: { name: home?.trim() || '', short_name: homeShortName || generateShortName(home), color: homeColor },
                    signatures: {
                      home_coach: homeCoachSig || '',
                      home_captain: homeCaptainSig || ''
                    },
                    players_home: homeRoster.filter(p => p.firstName || p.lastName).map(p => ({
                      number: p.number || null,
                      first_name: p.firstName || '',
                      last_name: p.lastName || '',
                      dob: formatDobForSync(p.dob),
                      is_captain: !!p.isCaptain,
                      libero: p.libero || null,
                      is_lfp: !!p.isLfp
                    })),
                    bench_home: benchHome || []
                  },
                  ts: new Date().toISOString(),
                  status: 'queued'
                })

                // Also sync to match_live_state if it exists (for Referee app)
                try {
                  const { data: supabaseMatch } = await supabase
                    .from('matches')
                    .select('id')
                    .eq('external_id', match.seed_key)
                    .maybeSingle()

                  if (supabaseMatch?.id) {
                    const coinTossTeamA = match.coinTossTeamA || 'home'
                    const homeIsTeamA = coinTossTeamA === 'home'
                    const colorKey = homeIsTeamA ? 'team_a_color' : 'team_b_color'
                    const shortKey = homeIsTeamA ? 'team_a_short' : 'team_b_short'
                    const nameKey = homeIsTeamA ? 'team_a_name' : 'team_b_name'

                    await supabase
                      .from('match_live_state')
                      .update({
                        [colorKey]: homeColor,
                        [shortKey]: homeShortName || generateShortName(home),
                        [nameKey]: home?.trim() || '',
                        updated_at: new Date().toISOString()
                      })
                      .eq('match_id', supabaseMatch.id)
                    console.log('[MatchSetup] Synced home team to match_live_state')
                  }
                } catch (err) {
                  console.debug('[MatchSetup] Could not sync home team to match_live_state:', err.message)
                }
              }

              setNoticeModal({ message: t('matchSetup.homeSaved'), type: 'success', syncing: true })

              // Poll to check when sync completes
              const checkSyncStatus = async () => {
                let attempts = 0
                const maxAttempts = 20
                const interval = setInterval(async () => {
                  attempts++
                  try {
                    const queued = await db.sync_queue.where('status').equals('queued').count()
                    if (queued === 0) {
                      clearInterval(interval)
                      setNoticeModal({ message: t('matchSetup.homeSynced'), type: 'success' })
                    } else if (attempts >= maxAttempts) {
                      clearInterval(interval)
                      setNoticeModal({ message: t('matchSetup.homeSavedLocal'), type: 'success' })
                    }
                  } catch (err) {
                    clearInterval(interval)
                  }
                }, 500)
              }
              checkSyncStatus()
            }
            setCurrentView('main')
          }}>{t('common.confirm')}</button>
        </div>
        {/* PDF Import Summary Modal - shown immediately after import */}
        {importSummaryModal && importSummaryModal.team === 'home' && (
          <Modal
            title={t('matchSetup.modals.homeTeamImportComplete')}
            open={true}
            onClose={() => setImportSummaryModal(null)}
            width={400}
          >
            <div style={{ padding: '20px' }}>
              <div style={{
                background: 'rgba(34, 197, 94, 0.1)',
                border: '1px solid rgba(34, 197, 94, 0.3)',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '16px'
              }}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#22c55e', marginBottom: '8px' }}>
                  {t('matchSetup.modals.playersCount', { count: importSummaryModal.players })}
                </div>
                <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)' }}>
                  {t('matchSetup.modals.successfullyImported')}
                </div>
                {importSummaryModal.benchOfficials > 0 && (
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', marginTop: '8px' }}>
                    {importSummaryModal.benchOfficials > 1 ? t('matchSetup.modals.benchOfficialsCountPlural', { count: importSummaryModal.benchOfficials }) : t('matchSetup.modals.benchOfficialsCount', { count: importSummaryModal.benchOfficials })}
                  </div>
                )}
              </div>
              <div style={{
                background: 'rgba(234, 179, 8, 0.1)',
                border: '1px solid rgba(234, 179, 8, 0.3)',
                borderRadius: '8px',
                padding: '12px',
                marginBottom: '20px'
              }}>
                <div style={{ fontSize: '13px', color: '#eab308', fontWeight: 500, marginBottom: '4px' }}>
                  {t('matchSetup.modals.reviewImportedData')}
                </div>
                <ul style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', margin: '8px 0 0 0', paddingLeft: '20px', lineHeight: '1.6' }}>
                  <li>{t('matchSetup.modals.reviewAddBenchOfficials')}</li>
                  <li>{t('matchSetup.modals.reviewVerifyDob')}</li>
                  <li>{t('matchSetup.modals.reviewSetCaptainLibero')}</li>
                </ul>
              </div>
              <button
                onClick={() => setImportSummaryModal(null)}
                style={{ width: '100%', padding: '12px', background: 'var(--accent)', border: 'none', borderRadius: '8px', color: '#000', fontWeight: 600, cursor: 'pointer' }}
              >
                {t('common.ok')}
              </button>
            </div>
          </Modal>
        )}
        {/* Notice Modal - must be rendered in this view since early return prevents main render */}
        {noticeModal && (
          <Modal
            title={noticeModal.syncing ? t('matchSetup.modals.syncing') : noticeModal.type === 'success' ? t('matchSetup.modals.success') : t('matchSetup.modals.notice')}
            open={true}
            onClose={() => !noticeModal.syncing && setNoticeModal(null)}
            width={400}
            hideCloseButton={true}
          >
            <div style={{ padding: '24px', textAlign: 'center' }}>
              {noticeModal.syncing && (
                <div style={{ fontSize: '48px', marginBottom: '16px', animation: 'spin 1s linear infinite' }}>⟳</div>
              )}
              {!noticeModal.syncing && noticeModal.type === 'success' && (
                <div style={{ fontSize: '48px', marginBottom: '16px', color: '#22c55e' }}>✓</div>
              )}
              {!noticeModal.syncing && noticeModal.type === 'error' && (
                <div style={{ fontSize: '48px', marginBottom: '16px', color: '#ef4444' }}>✕</div>
              )}
              <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--text)', whiteSpace: 'pre-line' }}>
                {noticeModal.message}
              </p>
              {!noticeModal.syncing && (
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                  <button
                    onClick={() => setNoticeModal(null)}
                    style={{
                      padding: '12px 24px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: noticeModal.type === 'success' ? '#22c55e' : noticeModal.type === 'error' ? '#ef4444' : 'var(--accent)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: 'pointer'
                    }}
                  >
                    OK
                  </button>
                </div>
              )}
            </div>
          </Modal>
        )}

        {/* Roster Preview Modal */}
        {rosterPreview && (
          <Modal
            title={t('matchSetup.rosterPreviewTitle')}
            open={true}
            onClose={() => setRosterPreview(null)}
            width={600}
          >
            <div style={{ padding: '16px', maxHeight: '70vh', overflowY: 'auto' }}>
              {(() => {
                const roster = rosterPreview === 'home' ? match?.pendingHomeRoster : match?.pendingAwayRoster
                if (!roster) return <p>{t('matchSetup.noRosterFound')}</p>
                return (
                  <>
                    <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>
                      {t('matchSetup.playersCount')}: {roster.players?.length || 0}
                    </h3>
                    <div style={{ marginBottom: '16px' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
                            <th style={{ padding: '8px', textAlign: 'left' }}>#</th>
                            <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.lastName')}</th>
                            <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.firstName')}</th>
                            <th style={{ padding: '8px', textAlign: 'center' }}>L</th>
                            <th style={{ padding: '8px', textAlign: 'center' }}>C</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(roster.players || []).map((p, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                              <td style={{ padding: '6px 8px' }}>{p.number}</td>
                              <td style={{ padding: '6px 8px' }}>{p.lastName || ''}</td>
                              <td style={{ padding: '6px 8px' }}>{p.firstName || ''}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'center' }}>{p.libero ? 'L' : ''}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'center' }}>{p.isCaptain ? 'C' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {roster.bench && roster.bench.length > 0 && (
                      <>
                        <h3 style={{ marginTop: '16px', marginBottom: '12px', fontSize: '16px' }}>
                          {t('matchSetup.benchOfficialsCount')}: {roster.bench.length}
                        </h3>
                        <div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                            <thead>
                              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
                                <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.role')}</th>
                                <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.lastName')}</th>
                                <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.firstName')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {roster.bench.map((b, i) => (
                                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                                  <td style={{ padding: '6px 8px' }}>{b.role || ''}</td>
                                  <td style={{ padding: '6px 8px' }}>{b.lastName || ''}</td>
                                  <td style={{ padding: '6px 8px' }}>{b.firstName || ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </>
                )
              })()}
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '16px' }}>
                <button
                  onClick={() => setRosterPreview(null)}
                  style={{
                    padding: '10px 24px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: 'var(--accent)',
                    color: '#000',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer'
                  }}
                >
                  {t('common.close')}
                </button>
              </div>
            </div>
          </Modal>
        )}

        {/* Test Roster Confirmation Modal */}
        {testRosterConfirm === 'home' && (
          <Modal
            title={t('roster.confirmLoadTestRoster')}
            open={true}
            onClose={() => setTestRosterConfirm(null)}
            width={400}
          >
            <div style={{ padding: '20px', textAlign: 'center' }}>
              <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--text)' }}>
                {t('roster.confirmLoadTestRosterMessage', { team: TEST_HOME_TEAM.name })}
              </p>
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                <button
                  onClick={() => {
                    setHomeRoster([...TEST_HOME_TEAM.players].sort((a, b) => a.number - b.number))
                    setBenchHome(TEST_HOME_BENCH)
                    if (!home || home === 'Home') setHome(TEST_HOME_TEAM.name)
                    if (!homeShortName) setHomeShortName(TEST_HOME_TEAM.shortName)
                    setTestRosterConfirm(null)
                  }}
                  style={{
                    padding: '12px 24px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: '#000',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer'
                  }}
                >
                  {t('roster.loadTestRoster')}
                </button>
                <button
                  onClick={() => setTestRosterConfirm(null)}
                  className="secondary"
                  style={{ padding: '12px 24px', fontSize: '14px', fontWeight: 600 }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          </Modal>
        )}

        {/* SignaturePad for home team view */}
        <SignaturePad
          open={openSignature !== null}
          onClose={() => setOpenSignature(null)}
          onSave={handleSignatureSave}
          title={openSignature === 'home-coach' ? 'Home Coach Signature' :
            openSignature === 'home-captain' ? 'Home Captain Signature' :
              openSignature === 'away-coach' ? 'Away Coach Signature' :
                openSignature === 'away-captain' ? 'Away Captain Signature' : 'Sign'}
        />
      </MatchSetupHomeTeamView>
    )
  }

  if (currentView === 'away') {
    return (
      <MatchSetupAwayTeamView>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <button className="secondary" onClick={() => { restoreAwayTeam(); setCurrentView('main') }}>← {t('common.back')}</button>
          <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text)', padding: '10px', border: '0.5px solid white', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.1)' }}>{away || t('matchSetup.awayTeam')}</h2>
          <div style={{ width: 80 }}></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <h1 style={{ margin: 0 }}>{t('roster.title')}</h1>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => {
                setAwayRoster([])
                setBenchAway([{ role: 'Coach', firstName: '', lastName: '', dob: '' }])
                setAwayCoachSignature(null)
                setAwayCaptainSignature(null)
              }}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                fontWeight: 600,
                background: '#dc2626',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              {t('roster.deleteRoster')}
            </button>
            <button
              onClick={() => setTestRosterConfirm('away')}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                fontWeight: 600,
                background: '#000',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              {t('roster.loadTestRoster')}
            </button>
          </div>
        </div>
        {/* Upload Methods for Away Team + Player Stats */}
        <div style={{ marginBottom: '12px', display: 'flex', gap: '12px' }}>
          {/* Left: Upload section */}
          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.2)',
            flex: 1
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Upload button row with Local/Remote toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  ref={awayFileInputRef}
                  type="file"
                  accept=".pdf"
                  onChange={handleAwayFileSelect}
                  style={{ display: 'none' }}
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (awayUploadMode === 'local') {
                      awayFileInputRef.current?.click()
                    } else {
                      handleSearchAwayRoster()
                    }
                  }}
                  disabled={awayPdfLoading || awayRosterSearching}
                  style={{
                    padding: '8px 16px',
                    fontSize: '14px',
                    flex: 1
                  }}
                >
                  {awayUploadMode === 'local' ? t('matchSetup.uploadPdf') : (awayRosterSearching ? t('common.loading') : t('matchSetup.searchForRoster'))}
                </button>
                {/* Local/Remote Toggle */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  background: 'rgba(255, 255, 255, 0.1)',
                  borderRadius: '6px',
                  padding: '2px',
                  gap: '2px'
                }}>
                  <button
                    type="button"
                    onClick={() => setAwayUploadMode('local')}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: awayUploadMode === 'local' ? 'rgba(59, 130, 246, 0.3)' : 'transparent',
                      color: awayUploadMode === 'local' ? '#60a5fa' : 'rgba(255, 255, 255, 0.6)',
                      border: awayUploadMode === 'local' ? '1px solid rgba(59, 130, 246, 0.5)' : '1px solid transparent',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    {t('matchSetup.local')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAwayUploadMode('remote')}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: awayUploadMode === 'remote' ? 'rgba(59, 130, 246, 0.3)' : 'transparent',
                      color: awayUploadMode === 'remote' ? '#60a5fa' : 'rgba(255, 255, 255, 0.6)',
                      border: awayUploadMode === 'remote' ? '1px solid rgba(59, 130, 246, 0.5)' : '1px solid transparent',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    {t('matchSetup.remote')}
                  </button>
                </div>
              </div>
              {/* Local upload - file selected */}
              {awayUploadMode === 'local' && awayPdfFile && (
                <>
                  <span style={{ fontSize: '12px', color: 'var(--text)' }}>
                    {awayPdfFile.name}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={handleAwayImportClick}
                    disabled={awayPdfLoading}
                    style={{ padding: '8px 16px', fontSize: '14px', width: '100%' }}
                  >
                    {awayPdfLoading ? t('matchSetup.importing') : t('matchSetup.importPdf')}
                  </button>
                </>
              )}
              {awayUploadMode === 'local' && awayPdfError && (
                <span style={{ color: '#ef4444', fontSize: '12px' }}>
                  {awayPdfError}
                </span>
              )}
              {/* Remote Upload */}
              {awayUploadMode === 'remote' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600 }}>{t('matchSetup.gameNumber')}:</span>
                    <span style={{ fontSize: '14px', fontFamily: 'monospace', fontWeight: 600, color: 'var(--text)' }}>
                      {match?.game_n || match?.gameNumber || gameN || 'N/A'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600 }}>{t('matchSetup.uploadPin')}:</span>
                    {match?.awayTeamUploadPin ? (
                      <>
                        <span style={{ fontSize: '16px', fontFamily: 'monospace', fontWeight: 700, color: 'var(--accent)' }}>
                          {match.awayTeamUploadPin}
                        </span>
                        <button
                          type="button"
                          className="secondary"
                          onClick={async () => {
                            if (!matchId) return
                            const generatePinCode = (existingPins = []) => {
                              const chars = '0123456789'
                              let pin = ''
                              let attempts = 0
                              const maxAttempts = 100
                              do {
                                pin = ''
                                for (let i = 0; i < 6; i++) {
                                  pin += chars.charAt(Math.floor(Math.random() * chars.length))
                                }
                                attempts++
                                if (attempts >= maxAttempts) break
                              } while (existingPins.includes(pin))
                              return pin
                            }
                            const match = await db.matches.get(matchId)
                            const existingPins = [
                              match?.refereePin,
                              match?.homeTeamPin,
                              match?.awayTeamPin,
                              match?.homeTeamUploadPin
                            ].filter(Boolean)
                            const newPin = generatePinCode(existingPins)
                            await db.matches.update(matchId, { awayTeamUploadPin: newPin })
                          }}
                          style={{ padding: '4px 8px', fontSize: '11px' }}
                        >
                          {t('matchSetup.regenerate')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="secondary"
                        onClick={async () => {
                          if (!matchId) return
                          const generatePinCode = (existingPins = []) => {
                            const chars = '0123456789'
                            let pin = ''
                            let attempts = 0
                            const maxAttempts = 100
                            do {
                              pin = ''
                              for (let i = 0; i < 6; i++) {
                                pin += chars.charAt(Math.floor(Math.random() * chars.length))
                              }
                              attempts++
                              if (attempts >= maxAttempts) break
                            } while (existingPins.includes(pin))
                            return pin
                          }
                          const match = await db.matches.get(matchId)
                          const existingPins = [
                            match?.refereePin,
                            match?.homeTeamPin,
                            match?.awayTeamPin,
                            match?.homeTeamUploadPin
                          ].filter(Boolean)
                          const newPin = generatePinCode(existingPins)
                          await db.matches.update(matchId, { awayTeamUploadPin: newPin })
                        }}
                        style={{ padding: '4px 8px', fontSize: '11px' }}
                      >
                        {t('matchSetup.generatePin')}
                      </button>
                    )}
                  </div>
                  {match?.pendingAwayRoster && (
                    <div style={{
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '8px',
                      padding: '12px',
                      background: 'rgba(15, 23, 42, 0.2)',
                      marginTop: '12px'
                    }}>
                      <h4 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px', fontWeight: 600 }}>{t('matchSetup.rosterUploaded')}</h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                        <div style={{ fontSize: '12px' }}>
                          {t('matchSetup.playersCount')}: {match.pendingAwayRoster.players?.length || 0}
                        </div>
                        <div style={{ fontSize: '12px' }}>
                          {t('matchSetup.benchOfficialsCount')}: {match.pendingAwayRoster.bench?.length || 0}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setRosterPreview('away')}
                          style={{ padding: '8px 16px', fontSize: '12px', background: 'rgba(59, 130, 246, 0.3)', color: 'var(--text)', flex: 1 }}
                        >
                          {t('matchSetup.previewRoster')}
                        </button>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          type="button"
                          className="secondary"
                          onClick={async () => {
                            if (!matchId || !match?.pendingAwayRoster) return
                            const pending = match.pendingAwayRoster
                            const importedPlayers = pending.players || []
                            const importedBench = pending.bench || []

                            // Extract signatures from pending roster
                            const importedCoachSig = pending.coachSignature || null
                            const importedCaptainSig = pending.captainSignature || null

                            // Update state
                            setAwayRoster(importedPlayers)
                            setBenchAway(importedBench)

                            // Also update signature states if signatures were provided
                            if (importedCoachSig) setAwayCoachSignature(importedCoachSig)
                            if (importedCaptainSig) setAwayCaptainSignature(importedCaptainSig)

                            // Save to database immediately
                            if (match.awayTeamId) {
                              // Delete existing players
                              const existingPlayers = await db.players.where('teamId').equals(match.awayTeamId).toArray()
                              for (const ep of existingPlayers) {
                                await db.players.delete(ep.id)
                              }

                              // Add imported players
                              if (importedPlayers.length) {
                                await db.players.bulkAdd(
                                  importedPlayers.map(p => ({
                                    teamId: match.awayTeamId,
                                    number: p.number,
                                    name: `${p.lastName || ''} ${p.firstName || ''}`.trim(),
                                    lastName: p.lastName || '',
                                    firstName: p.firstName || '',
                                    dob: p.dob || null,
                                    libero: p.libero || '',
                                    isCaptain: !!p.isCaptain,
                                    isLfp: !!p.isLfp,
                                    role: null,
                                    createdAt: new Date().toISOString()
                                  }))
                                )
                              }

                              // Update match with bench officials and signatures
                              const matchUpdate = {
                                bench_away: importedBench,
                                pendingAwayRoster: null
                              }
                              if (importedCoachSig) matchUpdate.awayCoachSignature = importedCoachSig
                              if (importedCaptainSig) matchUpdate.awayCaptainSignature = importedCaptainSig

                              await db.matches.update(matchId, matchUpdate)
                              console.log('[MatchSetup] Accepted away roster with signatures:', { hasCoach: !!importedCoachSig, hasCaptain: !!importedCaptainSig })
                            } else {
                              // If no teamId yet, just clear pending
                              await db.matches.update(matchId, { pendingAwayRoster: null })
                            }
                          }}
                          style={{ padding: '8px 16px', fontSize: '12px', background: '#22c55e', color: '#000', flex: 1 }}
                        >
                          {t('matchSetup.acceptRoster')}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={async () => {
                            if (!matchId) return
                            await db.matches.update(matchId, { pendingAwayRoster: null })
                          }}
                          style={{ padding: '8px 16px', fontSize: '12px', background: 'rgba(255, 255, 255, 0.1)', color: 'var(--text)', flex: 1 }}
                        >
                          {t('matchSetup.rejectRoster')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Right: Player Stats */}
          {(() => {
            const awayCaptain = awayRoster.find(p => p.isCaptain)
            const awayNonLiberoCount = awayRoster.filter(p => !p.libero).length
            const awayHasError = !awayCaptain || awayNonLiberoCount < 6
            return (
              <div style={{
                border: awayHasError ? '1px solid #ef4444' : '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '8px',
                padding: '12px',
                background: awayHasError ? 'rgba(239, 68, 68, 0.15)' : 'rgba(15, 23, 42, 0.2)',
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '16px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: awayNonLiberoCount < 6 ? '#ef4444' : 'rgba(255, 255, 255, 0.7)' }}>{t('matchSetup.players')}:</span>
                  <span style={{ fontSize: '18px', fontWeight: 700, color: awayNonLiberoCount < 6 ? '#ef4444' : 'var(--text)' }}>{awayRoster.length}</span>
                  <span style={{ fontSize: '16px', color: awayNonLiberoCount < 6 ? '#ef4444' : 'rgba(255, 255, 255, 0.5)' }}>
                    ({awayNonLiberoCount} + {awayRoster.filter(p => p.libero).length} {awayRoster.filter(p => p.libero).length !== 1 ? 'liberos' : 'libero'})
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: !awayCaptain ? '#ef4444' : 'rgba(255, 255, 255, 0.7)' }}>{t('matchSetup.captain')}:</span>
                  {awayCaptain ? (
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '28px',
                      height: '28px',
                      borderRadius: '50%',
                      border: '2px solid #22c55e',
                      fontSize: '14px',
                      fontWeight: 700,
                      color: '#22c55e'
                    }}>{awayCaptain.number || '?'}</span>
                  ) : (
                    <span style={{ fontSize: '14px', fontStyle: 'italic', color: '#ef4444' }}>—</span>
                  )}
                </div>
              </div>
            )
          })()}
        </div>
        {/* Add new player section */}
        {awayRoster.length < 14 && (
          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.2)',
            marginBottom: '8px',
          }}>
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: 8 }}>{t('matchSetup.addNewPlayer')}</div>
            <div className="row" style={{ width: '100%', maxWidth: '100%', overflow: 'hidden' }}>
              <input
                className="w-num"
                placeholder={t('matchSetup.numberPlaceholder')}
                type="number"
                inputMode="numeric"
                min="1"
                max="99"
                value={awayNum}
                onChange={e => setAwayNum(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                style={{ textAlign: 'center' }}
              />
              <input className="w-name capitalize" placeholder={t('matchSetup.lastName')} value={awayLast} onChange={e => setAwayLast(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
              <input className="w-name capitalize" placeholder={t('matchSetup.firstName')} value={awayFirst} onChange={e => setAwayFirst(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
              <input className="w-dob" placeholder={t('matchSetup.dateOfBirthPlaceholder')} type="date" value={awayDob ? formatDateToISO(awayDob) : ''} onChange={e => setAwayDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
              <select className="w-90" value={awayLibero} onChange={e => {
                let newValue = e.target.value
                // If L2 is selected but no L1 exists, automatically change L2 to L1
                if (newValue === 'libero2' && !awayRoster.some(p => p.libero === 'libero1')) {
                  newValue = 'libero1'
                }
                setAwayLibero(newValue)
              }}>
                <option value=""></option>
                {!awayRoster.some(p => p.libero === 'libero1') && (
                  <option value="libero1">{t('matchSetup.libero1')}</option>
                )}
                {!awayRoster.some(p => p.libero === 'libero2') && (
                  <option value="libero2">{t('matchSetup.libero2')}</option>
                )}
              </select>
              <div className="w-captain">
                <div
                  onClick={() => setAwayCaptain(!awayCaptain)}
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '4px',
                    border: awayCaptain ? '2px solid #22c55e' : '2px solid rgba(255,255,255,0.3)',
                    background: awayCaptain ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 700,
                    color: awayCaptain ? '#22c55e' : 'rgba(255,255,255,0.3)',
                    userSelect: 'none',
                    flexShrink: 0
                  }}
                >C</div>
              </div>
              <div className="w-action">
                <button type="button" className="secondary" onClick={() => {
                  if (!awayLast || !awayFirst) return
                  const newPlayer = { number: awayNum ? Number(awayNum) : null, lastName: awayLast, firstName: awayFirst, dob: awayDob, libero: awayLibero, isCaptain: awayCaptain, isLfp: false }
                  setAwayRoster(list => {
                    const cleared = awayCaptain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                    const next = [...cleared, newPlayer].sort((a, b) => {
                      const an = a.number ?? 999
                      const bn = b.number ?? 999
                      return an - bn
                    })
                    return next
                  })
                  setAwayNum(''); setAwayFirst(''); setAwayLast(''); setAwayDob(''); setAwayLibero(''); setAwayCaptain(false)
                }}>{t('common.add')}</button>
              </div>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Roster Header Row */}
          <div className="row" style={{ alignItems: 'center', fontWeight: 600, fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)', marginBottom: 4, padding: '6px 8px', border: '2px solid transparent' }}>
            <div className="w-num" style={{ textAlign: 'center' }}>#</div>
            <div className="w-name">{t('matchSetup.lastName')}</div>
            <div className="w-name">{t('matchSetup.firstName')}</div>
            <div className="w-dob">{t('matchSetup.dateOfBirth')}</div>
            <div className="w-90" style={{ textAlign: 'center' }}>{t('matchSetup.role')}</div>
            <div className="w-captain">C</div>
            <div className="w-action"></div>
          </div>
          {awayRoster.map((p, i) => {
            // Check if this player's number is a duplicate
            const isDuplicate = p.number != null && p.number !== '' &&
              awayRoster.some((other, idx) => idx !== i && other.number === p.number)

            // Determine border style based on captain/libero status
            const isCaptain = p.isCaptain || false
            const isLibero = !!p.libero
            // Base style for all rows (transparent border for alignment)
            let borderStyle = {
              borderRadius: '6px',
              padding: '6px 8px',
              border: '2px solid transparent'
            }
            if (isCaptain && isLibero) {
              // Both: alternating green/white striped border
              borderStyle = {
                padding: '6px 8px',
                background: 'rgba(34, 197, 94, 0.05)',
                border: '2px solid',
                borderImage: 'repeating-linear-gradient(90deg, #22c55e 0, #22c55e 6px, #ffffff 6px, #ffffff 12px) 1'
              }
            } else if (isCaptain) {
              // Captain only: green border
              borderStyle = {
                border: '2px solid #22c55e',
                borderRadius: '6px',
                padding: '6px 8px',
                background: 'rgba(34, 197, 94, 0.1)'
              }
            } else if (isLibero) {
              // Libero only: white border
              borderStyle = {
                border: '2px solid rgba(255, 255, 255, 0.8)',
                borderRadius: '6px',
                padding: '6px 8px',
                background: 'rgba(255, 255, 255, 0.05)'
              }
            }

            return (
              <div key={`a-${i}`} className="row" style={{ alignItems: 'center', ...borderStyle }}>
                <input
                  className="w-num"
                  placeholder="#"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="99"
                  value={p.number ?? ''}
                  style={isDuplicate ? {
                    background: 'rgba(239, 68, 68, 0.2)',
                    border: '2px solid #ef4444',
                    color: '#ef4444'
                  } : undefined}
                  title={isDuplicate ? t('scoreboard.duplicateJersey') : undefined}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onKeyPress={e => {
                    if (!/[0-9]/.test(e.key) && e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Tab') {
                      e.preventDefault()
                    }
                  }}
                  onChange={e => {
                    const val = e.target.value ? Number(e.target.value) : null
                    if (val !== null && (val < 1 || val > 99)) return
                    const updated = [...awayRoster]
                    updated[i] = { ...updated[i], number: val }
                    setAwayRoster(updated)
                  }}
                  onBlur={() => {
                    // Sort roster by player number when done editing
                    const sorted = [...awayRoster].sort((a, b) => (a.number || 0) - (b.number || 0))
                    setAwayRoster(sorted)
                  }}
                />
                <input
                  className="w-name capitalize"
                  placeholder={t('matchSetup.placeholders.lastName')}
                  value={p.lastName || ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={e => {
                    const updated = [...awayRoster]
                    updated[i] = { ...updated[i], lastName: e.target.value }
                    setAwayRoster(updated)
                  }}
                />
                <input
                  className="w-name capitalize"
                  placeholder={t('matchSetup.placeholders.firstName')}
                  value={p.firstName || ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={e => {
                    const updated = [...awayRoster]
                    updated[i] = { ...updated[i], firstName: e.target.value }
                    setAwayRoster(updated)
                  }}
                />
                <input
                  className="w-dob"
                  placeholder={t('matchSetup.dateOfBirthPlaceholder')}
                  type="date"
                  value={p.dob ? formatDateToISO(p.dob) : ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={e => {
                    const updated = [...awayRoster]
                    updated[i] = { ...updated[i], dob: e.target.value ? formatDateToDDMMYYYY(e.target.value) : '' }
                    setAwayRoster(updated)
                  }}
                />
                <select
                  className="w-90"
                  value={p.libero || ''}
                  onChange={async e => {
                    const updated = [...awayRoster]
                    const oldValue = updated[i].libero
                    updated[i] = { ...updated[i], libero: e.target.value }

                    // If L2 is selected but no L1 exists, automatically change L2 to L1
                    if (e.target.value === 'libero2') {
                      const hasL1 = updated.some((player, idx) => idx !== i && player.libero === 'libero1')
                      if (!hasL1) {
                        updated[i] = { ...updated[i], libero: 'libero1' }
                      }
                    }

                    // If L1 is being cleared and there's an L2, promote L2 to L1
                    if (oldValue === 'libero1' && !e.target.value) {
                      const l2Idx = updated.findIndex((player, idx) => idx !== i && player.libero === 'libero2')
                      if (l2Idx !== -1) {
                        updated[l2Idx] = { ...updated[l2Idx], libero: 'libero1' }
                        // Update L2->L1 player in database if they have an ID
                        if (updated[l2Idx].id) {
                          await db.players.update(updated[l2Idx].id, { libero: 'libero1' })
                        }
                      }
                    }

                    setAwayRoster(updated)

                    // Update database immediately if player has an ID
                    if (p.id) {
                      await db.players.update(p.id, { libero: updated[i].libero })
                    }
                  }}
                >
                  <option value=""></option>
                  {!awayRoster.some((player, idx) => idx !== i && player.libero === 'libero1') && (
                    <option value="libero1">{t('matchSetup.libero1')}</option>
                  )}
                  {!awayRoster.some((player, idx) => idx !== i && player.libero === 'libero2') && (
                    <option value="libero2">{t('matchSetup.libero2')}</option>
                  )}
                </select>
                <div className="w-captain">
                  <div
                    onClick={() => {
                      const updated = awayRoster.map((player, idx) => ({
                        ...player,
                        isCaptain: idx === i ? !player.isCaptain : false
                      }))
                      setAwayRoster(updated)
                    }}
                    style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: '4px',
                      border: (p.isCaptain || false) ? '2px solid #22c55e' : '2px solid rgba(255,255,255,0.3)',
                      background: (p.isCaptain || false) ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: 700,
                      color: (p.isCaptain || false) ? '#22c55e' : 'rgba(255,255,255,0.3)',
                      userSelect: 'none',
                      flexShrink: 0
                    }}
                  >C</div>
                </div>
                <div className="w-action">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setAwayRoster(list => list.filter((_, idx) => idx !== i))}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        <h4>{t('matchSetup.benchOfficials')} — {t('common.away')}</h4>
        {/* Bench Header Row */}
        <div className="row" style={{ alignItems: 'center', fontWeight: 600, fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)', marginBottom: 4, padding: '6px 8px', border: '2px solid transparent' }}>
          <div className="w-220">{t('matchSetup.role')}</div>
          <div className="w-name">{t('matchSetup.lastName')}</div>
          <div className="w-name">{t('matchSetup.firstName')}</div>
          <div className="w-dob">{t('matchSetup.dateOfBirth')}</div>
          <div className="w-action"></div>
        </div>
        {sortBenchByHierarchy(benchAway).map((m, i) => {
          const originalIdx = benchAway.findIndex(b => b === m)
          return (
            <div key={`ba-${originalIdx}`} className="row bench-row" style={{ alignItems: 'center', padding: '6px 8px', border: '2px solid transparent', borderRadius: '6px' }}>
              <select className="w-220" value={m.role || 'Coach'} onChange={e => {
                const newRole = e.target.value || 'Coach'
                // Check if this role is already taken by another official
                const isRoleTaken = benchAway.some((b, idx) => idx !== originalIdx && b.role === newRole)
                if (isRoleTaken) {
                  // Don't allow duplicate roles
                  return
                }
                setBenchAway(arr => {
                  const a = [...arr];
                  a[originalIdx] = { ...a[originalIdx], role: newRole };
                  return a
                })
              }}>
                {BENCH_ROLES.map(role => {
                  const isRoleTaken = benchAway.some((b, idx) => idx !== originalIdx && b.role === role.value)
                  return (
                    <option key={role.value} value={role.value} disabled={isRoleTaken}>
                      {t(role.labelKey, role.label)} - {t(role.fullLabelKey)}{isRoleTaken ? ` (${t('matchSetup.alreadyAssigned', 'already assigned')})` : ''}
                    </option>
                  )
                })}
              </select>
              <input className="w-name capitalize" placeholder={t('matchSetup.lastName')} value={m.lastName} onChange={e => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], lastName: e.target.value }; return a })} />
              <input className="w-name capitalize" placeholder={t('matchSetup.firstName')} value={m.firstName} onChange={e => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], firstName: e.target.value }; return a })} />
              <input className="w-dob" placeholder={t('matchSetup.dateOfBirthPlaceholder')} type="date" value={m.dob ? formatDateToISO(m.dob) : ''} onChange={e => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], dob: e.target.value ? formatDateToDDMMYYYY(e.target.value) : '' }; return a })} />
              <div className="w-action">
                <button type="button" className="secondary" onClick={() => {
                  const updated = benchAway.filter((_, idx) => idx !== originalIdx)
                  setBenchAway(updated)
                  // Trigger save immediately
                  setTimeout(() => saveDraft(true), 100)
                }} style={{ padding: '4px 8px', fontSize: '12px' }}>
                  {t('common.delete')}
                </button>
              </div>
            </div>
          )
        })}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="secondary"
            disabled={benchAway.length >= 5}
            onClick={() => {
              // Find the first available role
              const takenRoles = new Set(benchAway.map(b => b.role))
              const availableRole = BENCH_ROLES.find(r => !takenRoles.has(r.value))
              if (availableRole) {
                setBenchAway([...benchAway, initBench(availableRole.value)])
              }
            }}
            style={{ padding: '4px 8px', fontSize: '12px' }}
          >
            {t('matchSetup.addBenchOfficial')}
          </button>
        </div>

        {/* Signatures Section */}
        <div style={{
          marginTop: '24px',
          padding: '16px',
          background: 'rgba(255,255,255,0.05)',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.1)'
        }}>
          <h4 style={{ margin: 0, marginBottom: '12px' }}>
            {t('rosterSetup.signatures', 'Signatures')}
          </h4>
          <p style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: '16px' }}>
            {t('rosterSetup.signaturesDescription', 'Optional: Coach and captain can sign the roster before submitting.')}
          </p>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            {/* Coach Signature */}
            <div style={{ flex: 1, minWidth: '150px' }}>
              <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                {t('rosterSetup.coachSignature', 'Coach Signature')}
              </div>
              <div
                onClick={() => setOpenSignature('away-coach')}
                style={{
                  width: '100%',
                  height: '80px',
                  background: awayCoachSignature ? 'white' : 'rgba(255,255,255,0.05)',
                  border: awayCoachSignature ? '2px solid #22c55e' : '2px dashed rgba(255,255,255,0.3)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden'
                }}
              >
                {awayCoachSignature ? (
                  <img src={awayCoachSignature} alt={t('matchSetup.coachSignature')} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                ) : (
                  <span style={{ color: 'var(--muted)', fontSize: '12px' }}>
                    {t('rosterSetup.tapToSign', 'Tap to sign')}
                  </span>
                )}
              </div>
              {awayCoachSignature && (
                <button
                  onClick={(e) => { e.stopPropagation(); setAwayCoachSignature(null); }}
                  style={{
                    marginTop: '6px',
                    padding: '3px 10px',
                    fontSize: '11px',
                    background: 'rgba(239, 68, 68, 0.2)',
                    color: '#ef4444',
                    border: '1px solid #ef4444',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  {t('common.clear', 'Clear')}
                </button>
              )}
            </div>

            {/* Captain Signature */}
            <div style={{ flex: 1, minWidth: '150px' }}>
              <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '6px' }}>
                {t('rosterSetup.captainSignature', 'Captain Signature')}
              </div>
              <div
                onClick={() => setOpenSignature('away-captain')}
                style={{
                  width: '100%',
                  height: '80px',
                  background: awayCaptainSignature ? 'white' : 'rgba(255,255,255,0.05)',
                  border: awayCaptainSignature ? '2px solid #22c55e' : '2px dashed rgba(255,255,255,0.3)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden'
                }}
              >
                {awayCaptainSignature ? (
                  <img src={awayCaptainSignature} alt={t('matchSetup.captainSignature')} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                ) : (
                  <span style={{ color: 'var(--muted)', fontSize: '12px' }}>
                    {t('rosterSetup.tapToSign', 'Tap to sign')}
                  </span>
                )}
              </div>
              {awayCaptainSignature && (
                <button
                  onClick={(e) => { e.stopPropagation(); setAwayCaptainSignature(null); }}
                  style={{
                    marginTop: '6px',
                    padding: '3px 10px',
                    fontSize: '11px',
                    background: 'rgba(239, 68, 68, 0.2)',
                    color: '#ef4444',
                    border: '1px solid #ef4444',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  {t('common.clear', 'Clear')}
                </button>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={async () => {

            // Check if any changes were made (skip sync if no changes)
            const hasChanges = hasRosterChanged(
              originalAwayTeamRef.current?.awayRoster,
              awayRoster,
              originalAwayTeamRef.current?.benchAway,
              benchAway
            )

            // If no changes, just go back to main view
            if (!hasChanges) {
              console.log('[MatchSetup] No away roster changes, skipping sync')
              setCurrentView('main')
              return
            }

            // Roster save validation - only block for critical errors (duplicates, invalid numbers)
            // Missing numbers, captain, coach are validated at coin toss confirmation instead
            const validationErrors = []

            // Check for duplicate numbers (critical - must block)
            const numbers = awayRoster.filter(p => p.number != null && p.number !== '').map(p => p.number)
            const duplicateNumbers = numbers.filter((num, idx) => numbers.indexOf(num) !== idx)
            if (duplicateNumbers.length > 0) {
              console.log('[MatchSetup] Away duplicate numbers:', duplicateNumbers)
              validationErrors.push(t('matchSetup.validation.duplicateNumbers', { numbers: [...new Set(duplicateNumbers)].join(', ') }))
            }

            // Check for invalid numbers (must be 1-99) - critical - must block
            const invalidNumbers = awayRoster.filter(p => p.number != null && p.number !== '' && (p.number < 1 || p.number > 99))
            if (invalidNumbers.length > 0) {
              console.log('[MatchSetup] Away invalid numbers:', invalidNumbers.map(p => p.number))
              validationErrors.push(t('matchSetup.validation.invalidNumbers', { numbers: invalidNumbers.map(p => p.number).join(', ') }))
            }

            // Show validation errors if any critical errors
            if (validationErrors.length > 0) {
              console.log('[MatchSetup] Away roster validation errors:', validationErrors)
              setNoticeModal({ message: t('matchSetup.validation.fixIssues', { issues: validationErrors.join('\n• ') }) })
              return
            }

            console.log('[MatchSetup] Away roster validation passed, saving...')

            // Save away team data to database if matchId exists
            if (matchId && match?.awayTeamId) {
              await db.teams.update(match.awayTeamId, {
                name: away,
                color: awayColor
              })

              // Update players with captain status
              if (awayRoster.length) {
                const existingPlayers = await db.players.where('teamId').equals(match.awayTeamId).toArray()
                const rosterNumbers = new Set(awayRoster.map(p => p.number).filter(n => n != null))

                for (const rosterPlayer of awayRoster) {
                  if (!rosterPlayer.number) continue // Skip players without numbers

                  const existingPlayer = existingPlayers.find(ep => ep.number === rosterPlayer.number)
                  if (existingPlayer) {
                    // Update existing player
                    await db.players.update(existingPlayer.id, {
                      name: `${rosterPlayer.lastName} ${rosterPlayer.firstName}`,
                      lastName: rosterPlayer.lastName,
                      firstName: rosterPlayer.firstName,
                      dob: rosterPlayer.dob || null,
                      libero: rosterPlayer.libero || '',
                      isCaptain: !!rosterPlayer.isCaptain,
                      isLfp: !!rosterPlayer.isLfp
                    })
                  } else {
                    // Add new player (including newly added players after unlock)
                    await db.players.add({
                      teamId: match.awayTeamId,
                      number: rosterPlayer.number,
                      name: `${rosterPlayer.lastName} ${rosterPlayer.firstName}`,
                      lastName: rosterPlayer.lastName,
                      firstName: rosterPlayer.firstName,
                      dob: rosterPlayer.dob || null,
                      libero: rosterPlayer.libero || '',
                      isCaptain: !!rosterPlayer.isCaptain,
                      isLfp: !!rosterPlayer.isLfp,
                      role: null,
                      createdAt: new Date().toISOString()
                    })
                  }
                }

                // Remove players that are no longer in the roster
                for (const ep of existingPlayers) {
                  if (!rosterNumbers.has(ep.number)) {
                    await db.players.delete(ep.id)
                  }
                }
              }

              // Update match with short name, bench officials, and restore signatures (re-lock)
              const updateData = {
                awayShortName: awayShortName || away.substring(0, 3).toUpperCase(),
                bench_away: benchAway  // Save bench officials to match record
              }

              // Save current signatures (new or existing) to database
              if (awayCoachSignature) {
                updateData.awayCoachSignature = awayCoachSignature
                setSavedSignatures(prev => ({ ...prev, awayCoach: awayCoachSignature }))
              } else if (savedSignatures.awayCoach) {
                // Restore previously saved signature if current is empty (re-lock the team)
                updateData.awayCoachSignature = savedSignatures.awayCoach
                setAwayCoachSignature(savedSignatures.awayCoach)
              }
              if (awayCaptainSignature) {
                updateData.awayCaptainSignature = awayCaptainSignature
                setSavedSignatures(prev => ({ ...prev, awayCaptain: awayCaptainSignature }))
              } else if (savedSignatures.awayCaptain) {
                updateData.awayCaptainSignature = savedSignatures.awayCaptain
                setAwayCaptainSignature(savedSignatures.awayCaptain)
              }

              await db.matches.update(matchId, updateData)

              // Sync away team data to Supabase as JSONB
              if (match?.seed_key) {
                const awayCoachSig = awayCoachSignature || savedSignatures.awayCoach || null
                const awayCaptainSig = awayCaptainSignature || savedSignatures.awayCaptain || null
                await db.sync_queue.add({
                  resource: 'match',
                  action: 'update',
                  payload: {
                    id: match.seed_key,
                    // JSONB columns
                    away_team: { name: away?.trim() || '', short_name: awayShortName || generateShortName(away), color: awayColor },
                    signatures: {
                      away_coach: awayCoachSig || '',
                      away_captain: awayCaptainSig || ''
                    },
                    players_away: awayRoster.filter(p => p.firstName || p.lastName).map(p => ({
                      number: p.number || null,
                      first_name: p.firstName || '',
                      last_name: p.lastName || '',
                      dob: formatDobForSync(p.dob),
                      is_captain: !!p.isCaptain,
                      libero: p.libero || null,
                      is_lfp: !!p.isLfp
                    })),
                    bench_away: benchAway || []
                  },
                  ts: new Date().toISOString(),
                  status: 'queued'
                })

                // Also sync to match_live_state if it exists (for Referee app)
                try {
                  const { data: supabaseMatch } = await supabase
                    .from('matches')
                    .select('id')
                    .eq('external_id', match.seed_key)
                    .maybeSingle()

                  if (supabaseMatch?.id) {
                    const coinTossTeamA = match.coinTossTeamA || 'home'
                    const homeIsTeamA = coinTossTeamA === 'home'
                    // Away is Team B if home is Team A, and vice versa
                    const colorKey = homeIsTeamA ? 'team_b_color' : 'team_a_color'
                    const shortKey = homeIsTeamA ? 'team_b_short' : 'team_a_short'
                    const nameKey = homeIsTeamA ? 'team_b_name' : 'team_a_name'

                    await supabase
                      .from('match_live_state')
                      .update({
                        [colorKey]: awayColor,
                        [shortKey]: awayShortName || generateShortName(away),
                        [nameKey]: away?.trim() || '',
                        updated_at: new Date().toISOString()
                      })
                      .eq('match_id', supabaseMatch.id)
                    console.log('[MatchSetup] Synced away team to match_live_state')
                  }
                } catch (err) {
                  console.debug('[MatchSetup] Could not sync away team to match_live_state:', err.message)
                }
              }

              setNoticeModal({ message: t('matchSetup.awaySaved'), type: 'success', syncing: true })

              // Poll to check when sync completes
              const checkSyncStatus = async () => {
                let attempts = 0
                const maxAttempts = 20
                const interval = setInterval(async () => {
                  attempts++
                  try {
                    const queued = await db.sync_queue.where('status').equals('queued').count()
                    if (queued === 0) {
                      clearInterval(interval)
                      setNoticeModal({ message: t('matchSetup.awaySynced'), type: 'success' })
                    } else if (attempts >= maxAttempts) {
                      clearInterval(interval)
                      setNoticeModal({ message: t('matchSetup.awaySavedLocal'), type: 'success' })
                    }
                  } catch (err) {
                    clearInterval(interval)
                  }
                }, 500)
              }
              checkSyncStatus()
            }
            setCurrentView('main')
          }}>{t('common.confirm')}</button>
        </div>
        {/* PDF Import Summary Modal - shown immediately after import */}
        {importSummaryModal && importSummaryModal.team === 'away' && (
          <Modal
            title={t('matchSetup.modals.awayTeamImportComplete')}
            open={true}
            onClose={() => setImportSummaryModal(null)}
            width={400}
          >
            <div style={{ padding: '20px' }}>
              <div style={{
                background: 'rgba(34, 197, 94, 0.1)',
                border: '1px solid rgba(34, 197, 94, 0.3)',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '16px'
              }}>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#22c55e', marginBottom: '8px' }}>
                  {t('matchSetup.modals.playersCount', { count: importSummaryModal.players })}
                </div>
                <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)' }}>
                  {t('matchSetup.modals.successfullyImported')}
                </div>
                {importSummaryModal.benchOfficials > 0 && (
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', marginTop: '8px' }}>
                    {importSummaryModal.benchOfficials > 1 ? t('matchSetup.modals.benchOfficialsCountPlural', { count: importSummaryModal.benchOfficials }) : t('matchSetup.modals.benchOfficialsCount', { count: importSummaryModal.benchOfficials })}
                  </div>
                )}
              </div>
              <div style={{
                background: 'rgba(234, 179, 8, 0.1)',
                border: '1px solid rgba(234, 179, 8, 0.3)',
                borderRadius: '8px',
                padding: '12px',
                marginBottom: '20px'
              }}>
                <div style={{ fontSize: '13px', color: '#eab308', fontWeight: 500, marginBottom: '4px' }}>
                  {t('matchSetup.modals.reviewImportedData')}
                </div>
                <ul style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', margin: '8px 0 0 0', paddingLeft: '20px', lineHeight: '1.6' }}>
                  <li>{t('matchSetup.modals.reviewAddBenchOfficials')}</li>
                  <li>{t('matchSetup.modals.reviewVerifyDob')}</li>
                  <li>{t('matchSetup.modals.reviewSetCaptainLibero')}</li>
                </ul>
              </div>
              <button
                onClick={() => setImportSummaryModal(null)}
                style={{ width: '100%', padding: '12px', background: 'var(--accent)', border: 'none', borderRadius: '8px', color: '#000', fontWeight: 600, cursor: 'pointer' }}
              >
                {t('common.ok')}
              </button>
            </div>
          </Modal>
        )}
        {/* Notice Modal - must be rendered in this view since early return prevents main render */}
        {noticeModal && (
          <Modal
            title={noticeModal.syncing ? t('matchSetup.modals.syncing') : noticeModal.type === 'success' ? t('matchSetup.modals.success') : t('matchSetup.modals.notice')}
            open={true}
            onClose={() => !noticeModal.syncing && setNoticeModal(null)}
            width={400}
            hideCloseButton={true}
          >
            <div style={{ padding: '24px', textAlign: 'center' }}>
              {noticeModal.syncing && (
                <div style={{ fontSize: '48px', marginBottom: '16px', animation: 'spin 1s linear infinite' }}>⟳</div>
              )}
              {!noticeModal.syncing && noticeModal.type === 'success' && (
                <div style={{ fontSize: '48px', marginBottom: '16px', color: '#22c55e' }}>✓</div>
              )}
              {!noticeModal.syncing && noticeModal.type === 'error' && (
                <div style={{ fontSize: '48px', marginBottom: '16px', color: '#ef4444' }}>✕</div>
              )}
              <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--text)', whiteSpace: 'pre-line' }}>
                {noticeModal.message}
              </p>
              {!noticeModal.syncing && (
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                  <button
                    onClick={() => setNoticeModal(null)}
                    style={{
                      padding: '12px 24px',
                      fontSize: '14px',
                      fontWeight: 600,
                      background: noticeModal.type === 'success' ? '#22c55e' : noticeModal.type === 'error' ? '#ef4444' : 'var(--accent)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: 'pointer'
                    }}
                  >
                    OK
                  </button>
                </div>
              )}
            </div>
          </Modal>
        )}

        {/* Roster Preview Modal */}
        {rosterPreview && (
          <Modal
            title={t('matchSetup.rosterPreviewTitle')}
            open={true}
            onClose={() => setRosterPreview(null)}
            width={600}
          >
            <div style={{ padding: '16px', maxHeight: '70vh', overflowY: 'auto' }}>
              {(() => {
                const roster = rosterPreview === 'home' ? match?.pendingHomeRoster : match?.pendingAwayRoster
                if (!roster) return <p>{t('matchSetup.noRosterFound')}</p>
                return (
                  <>
                    <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>
                      {t('matchSetup.playersCount')}: {roster.players?.length || 0}
                    </h3>
                    <div style={{ marginBottom: '16px' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
                            <th style={{ padding: '8px', textAlign: 'left' }}>#</th>
                            <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.lastName')}</th>
                            <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.firstName')}</th>
                            <th style={{ padding: '8px', textAlign: 'center' }}>L</th>
                            <th style={{ padding: '8px', textAlign: 'center' }}>C</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(roster.players || []).map((p, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                              <td style={{ padding: '6px 8px' }}>{p.number}</td>
                              <td style={{ padding: '6px 8px' }}>{p.lastName || ''}</td>
                              <td style={{ padding: '6px 8px' }}>{p.firstName || ''}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'center' }}>{p.libero ? 'L' : ''}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'center' }}>{p.isCaptain ? 'C' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {roster.bench && roster.bench.length > 0 && (
                      <>
                        <h3 style={{ marginTop: '16px', marginBottom: '12px', fontSize: '16px' }}>
                          {t('matchSetup.benchOfficialsCount')}: {roster.bench.length}
                        </h3>
                        <div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                            <thead>
                              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
                                <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.role')}</th>
                                <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.lastName')}</th>
                                <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.firstName')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {roster.bench.map((b, i) => (
                                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                                  <td style={{ padding: '6px 8px' }}>{b.role || ''}</td>
                                  <td style={{ padding: '6px 8px' }}>{b.lastName || ''}</td>
                                  <td style={{ padding: '6px 8px' }}>{b.firstName || ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </>
                )
              })()}
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '16px' }}>
                <button
                  onClick={() => setRosterPreview(null)}
                  style={{
                    padding: '10px 24px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: 'var(--accent)',
                    color: '#000',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer'
                  }}
                >
                  {t('common.close')}
                </button>
              </div>
            </div>
          </Modal>
        )}

        {/* Test Roster Confirmation Modal */}
        {testRosterConfirm === 'away' && (
          <Modal
            title={t('roster.confirmLoadTestRoster')}
            open={true}
            onClose={() => setTestRosterConfirm(null)}
            width={400}
          >
            <div style={{ padding: '20px', textAlign: 'center' }}>
              <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--text)' }}>
                {t('roster.confirmLoadTestRosterMessage', { team: TEST_AWAY_TEAM.name })}
              </p>
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                <button
                  onClick={() => {
                    setAwayRoster([...TEST_AWAY_TEAM.players].sort((a, b) => a.number - b.number))
                    setBenchAway(TEST_AWAY_BENCH)
                    if (!away || away === 'Away') setAway(TEST_AWAY_TEAM.name)
                    if (!awayShortName) setAwayShortName(TEST_AWAY_TEAM.shortName)
                    setTestRosterConfirm(null)
                  }}
                  style={{
                    padding: '12px 24px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: '#000',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer'
                  }}
                >
                  {t('roster.loadTestRoster')}
                </button>
                <button
                  onClick={() => setTestRosterConfirm(null)}
                  className="secondary"
                  style={{ padding: '12px 24px', fontSize: '14px', fontWeight: 600 }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          </Modal>
        )}

        {/* SignaturePad for away team view */}
        <SignaturePad
          open={openSignature !== null}
          onClose={() => setOpenSignature(null)}
          onSave={handleSignatureSave}
          title={openSignature === 'home-coach' ? 'Home Coach Signature' :
            openSignature === 'home-captain' ? 'Home Captain Signature' :
              openSignature === 'away-coach' ? 'Away Coach Signature' :
                openSignature === 'away-captain' ? 'Away Captain Signature' : 'Sign'}
        />
      </MatchSetupAwayTeamView>
    )
  }

  const StatusBadge = ({ ready, pending }) => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: s(20),
        height: s(20),
        borderRadius: '50%',
        backgroundColor: ready ? '#22c55e' : pending ? '#3b82f6' : '#f97316',
        color: ready || pending ? '#fff' : '#0b1120',
        fontWeight: 700,
        fontSize: s(14),
        marginRight: s(8)
      }}
      aria-label={ready ? t('scoreboard.complete') : pending ? t('scoreboard.readyToConfirm') : t('scoreboard.incomplete')}
      title={ready ? t('scoreboard.complete') : pending ? t('scoreboard.readyToConfirm') : t('scoreboard.incomplete')}
    >
      {ready ? '✓' : pending ? '●' : '!'}
    </span>
  )

  // Sync status indicator for cards - green=synced, yellow=syncing, red=error, gray=not synced
  // Hidden if offline mode
  const SyncStatusIndicator = ({ status, onRetry }) => {
    if (offlineMode) return null

    const colors = {
      synced: { bg: 'rgba(34, 197, 94, 0.2)', border: 'rgba(34, 197, 94, 0.5)', dot: '#22c55e' },
      syncing: { bg: 'rgba(234, 179, 8, 0.2)', border: 'rgba(234, 179, 8, 0.5)', dot: '#eab308' },
      error: { bg: 'rgba(239, 68, 68, 0.2)', border: 'rgba(239, 68, 68, 0.5)', dot: '#ef4444' },
      idle: { bg: 'rgba(156, 163, 175, 0.2)', border: 'rgba(156, 163, 175, 0.5)', dot: '#9ca3af' }
    }
    const labels = {
      synced: t('matchSetup.syncStatus.synced', 'Synced'),
      syncing: t('matchSetup.syncStatus.syncing', 'Syncing...'),
      error: t('matchSetup.syncStatus.error', 'Sync Error'),
      idle: isSupabaseAvailable ? t('matchSetup.syncStatus.notSynced') : t('matchSetup.syncStatus.offline', 'Offline')
    }
    const c = colors[status] || colors.synced

    return (
      <div
        onClick={status !== 'synced' && onRetry ? onRetry : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: s(4),
          padding: `${s(3)}px ${s(8)}px`,
          background: c.bg,
          border: `1px solid ${c.border}`,
          borderRadius: s(4),
          fontSize: s(11),
          cursor: status !== 'synced' && onRetry ? 'pointer' : 'default',
          transition: 'all 0.2s'
        }}
        title={status !== 'synced' ? t('matchSetup.syncStatus.clickToRetry', 'Click to retry sync') : ''}
      >
        <span style={{
          display: 'inline-block',
          width: s(6),
          height: s(6),
          borderRadius: '50%',
          background: c.dot,
          boxShadow: status === 'syncing' ? `0 0 4px 2px ${c.dot}` : 'none'
        }} />
        <span>{labels[status]}</span>
      </div>
    )
  }

  // Officials are complete if at least 1st referee and scorer are filled
  // 2nd referee and assistant scorer are optional
  const officialsConfigured =
    !!(ref1Last && ref1First && scorerLast && scorerFirst)
  const matchInfoConfigured = !!(date || time || hall || city || league)
  // Basic roster configured (enough for saving)
  const homeRosterExists = !!(home && homeRoster.length >= 6 && homeCounts.liberos >= 0)
  const awayRosterExists = !!(away && awayRoster.length >= 6 && awayCounts.liberos >= 0)

  // Roster validation for proceeding to coin toss (requires captain and coach)
  // Note: all players having numbers is only required when CONFIRMING coin toss, not proceeding to it
  const homeConfigured = homeRosterExists && homeCounts.hasCaptain && homeCounts.hasCoach
  const awayConfigured = awayRosterExists && awayCounts.hasCaptain && awayCounts.hasCoach

  // All 4 cards must be complete before proceeding to coin toss
  const canProceedToCoinToss = matchInfoConfirmed && officialsConfigured && homeConfigured && awayConfigured

  const formatOfficial = (lastName, firstName) => {
    if (!lastName && !firstName) return t('common.notSet')
    if (!lastName) return firstName
    if (!firstName) return lastName
    return `${lastName}, ${firstName.charAt(0)}.`
  }

  // Format line judge full name (e.g., "John Smith") to "Smith, J."
  const formatLineJudge = (fullName) => {
    if (!fullName) return null
    const parts = fullName.trim().split(/\s+/)
    if (parts.length === 1) return parts[0] // Only one name
    const firstName = parts[0]
    const lastName = parts.slice(1).join(' ')
    return `${lastName}, ${firstName.charAt(0)}.`
  }

  const formatDisplayDate = value => {
    if (!value) return null
    const parts = value.split('-')
    if (parts.length !== 3) return value
    const [year, month, day] = parts
    if (!year || !month || !day) return value
    return `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`
  }

  const formatDisplayTime = value => {
    if (!value) return null
    const parts = value.split(':')
    if (parts.length < 2) return value
    const [hours, minutes] = parts
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }

  // Helper function to generate unique PIN
  const generateUniquePin = async () => {
    const generatePinCode = (existingPins = []) => {
      const chars = '0123456789'
      let pin = ''
      let attempts = 0
      const maxAttempts = 100

      do {
        pin = ''
        for (let i = 0; i < 6; i++) {
          pin += chars.charAt(Math.floor(Math.random() * chars.length))
        }
        attempts++
        if (attempts >= maxAttempts) break
      } while (existingPins.includes(pin))

      return pin
    }

    // Get all existing PINs to ensure uniqueness
    const allMatches = await db.matches.toArray()
    const existingPins = allMatches
      .map(m => [m.refereePin, m.homeTeamPin, m.awayTeamPin, m.homeTeamUploadPin, m.awayTeamUploadPin])
      .flat()
      .filter(Boolean)

    return generatePinCode(existingPins)
  }

  // Sync match data to server (for when Scoreboard is not mounted)
  // If fullSync is true, fetches all data (teams, players, sets, events) from IndexedDB
  const syncMatchToServer = async (matchData, fullSync = false) => {
    const wsUrl = getWebSocketUrl()
    if (!wsUrl) return

    try {
      // For full sync, fetch all data from IndexedDB
      let homeTeam = null, awayTeam = null, homePlayers = [], awayPlayers = [], sets = [], events = []

      if (fullSync && matchData) {
        const [fetchedHomeTeam, fetchedAwayTeam, fetchedSets, fetchedEvents, fetchedHomePlayers, fetchedAwayPlayers] = await Promise.all([
          matchData.homeTeamId ? db.teams.get(matchData.homeTeamId) : null,
          matchData.awayTeamId ? db.teams.get(matchData.awayTeamId) : null,
          db.sets.where('matchId').equals(matchData.id).toArray(),
          db.events.where('matchId').equals(matchData.id).toArray(),
          matchData.homeTeamId ? db.players.where('teamId').equals(matchData.homeTeamId).toArray() : [],
          matchData.awayTeamId ? db.players.where('teamId').equals(matchData.awayTeamId).toArray() : []
        ])
        homeTeam = fetchedHomeTeam
        awayTeam = fetchedAwayTeam
        homePlayers = fetchedHomePlayers
        awayPlayers = fetchedAwayPlayers
        sets = fetchedSets
        events = fetchedEvents
      }

      // Create a temporary WebSocket connection to sync the data
      const ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        const syncPayload = {
          type: 'sync-match-data',
          matchId: matchData.id,
          match: matchData,
          homeTeam: homeTeam,
          awayTeam: awayTeam,
          homePlayers: homePlayers,
          awayPlayers: awayPlayers,
          sets: sets,
          events: events,
          _timestamp: Date.now()
        }
        ws.send(JSON.stringify(syncPayload))
        // Close after a short delay to ensure message is sent
        setTimeout(() => ws.close(), 500)
      }

      ws.onerror = () => { }
    } catch (error) {
      console.error('[MatchSetup] Failed to sync to server:', error)
    }
  }

  const handleRefereeConnectionToggle = async (enabled) => {
    if (!matchId) return
    setRefereeConnectionEnabled(enabled)
    try {
      const match = await db.matches.get(matchId)
      if (!match) return

      const updates = { refereeConnectionEnabled: enabled }

      // If enabling connection and PIN doesn't exist, generate one
      if (enabled && !match.refereePin) {
        const newPin = await generateUniquePin()
        updates.refereePin = String(newPin).trim() // Ensure it's a string
      }

      await db.matches.update(matchId, updates)

      // Sync to server since Scoreboard is not mounted when MatchSetup is shown
      const updatedMatch = await db.matches.get(matchId)
      if (updatedMatch) {
        await syncMatchToServer(updatedMatch)
        // Also sync to Supabase (use seed_key as external_id)
        if (updatedMatch.seed_key) {
          await db.sync_queue.add({
            resource: 'match',
            action: 'update',
            payload: {
              id: updatedMatch.seed_key,
              // JSONB columns
              connections: {
                referee_enabled: enabled
              },
              connection_pins: {
                referee: updatedMatch.refereePin || ''
              }
            },
            ts: new Date().toISOString(),
            status: 'queued'
          })

          // Show syncing modal and poll for completion
          setNoticeModal({ message: t('matchSetup.modals.syncingToDatabase'), type: 'success', syncing: true })
          let attempts = 0
          const maxAttempts = 20
          const interval = setInterval(async () => {
            attempts++
            try {
              const queued = await db.sync_queue.where('status').equals('queued').count()
              if (queued === 0) {
                clearInterval(interval)
                setNoticeModal({ message: t('matchSetup.modals.syncedToDatabase'), type: 'success' })
              } else if (attempts >= maxAttempts) {
                clearInterval(interval)
                setNoticeModal({ message: t('matchSetup.modals.matchSavedLocalSyncPending'), type: 'success' })
              }
            } catch (err) {
              clearInterval(interval)
            }
          }, 500)
        }
      }
    } catch (error) {
      console.error('Failed to update referee connection setting:', error)
    }
  }

  const handleHomeTeamConnectionToggle = async (enabled) => {
    if (!matchId) return
    setHomeTeamConnectionEnabled(enabled)
    try {
      const match = await db.matches.get(matchId)
      if (!match) return

      const updates = { homeTeamConnectionEnabled: enabled }

      // If enabling connection and PIN doesn't exist, generate one
      if (enabled && !match.homeTeamPin) {
        const newPin = await generateUniquePin()
        updates.homeTeamPin = String(newPin).trim() // Ensure it's a string
      }

      await db.matches.update(matchId, updates)

      // Sync to server since Scoreboard is not mounted when MatchSetup is shown
      const updatedMatch = await db.matches.get(matchId)
      if (updatedMatch) {
        await syncMatchToServer(updatedMatch)
        // Also sync to Supabase (use seed_key as external_id)
        if (updatedMatch.seed_key) {
          await db.sync_queue.add({
            resource: 'match',
            action: 'update',
            payload: {
              id: updatedMatch.seed_key,
              connections: {
                home_bench_enabled: enabled
              },
              connection_pins: {
                bench_home: updatedMatch.homeTeamPin || ''
              }
            },
            ts: new Date().toISOString(),
            status: 'queued'
          })

          // Show syncing modal and poll for completion
          setNoticeModal({ message: t('matchSetup.modals.syncingToDatabase'), type: 'success', syncing: true })
          let attempts = 0
          const maxAttempts = 20
          const interval = setInterval(async () => {
            attempts++
            try {
              const queued = await db.sync_queue.where('status').equals('queued').count()
              if (queued === 0) {
                clearInterval(interval)
                setNoticeModal({ message: t('matchSetup.modals.syncedToDatabase'), type: 'success' })
              } else if (attempts >= maxAttempts) {
                clearInterval(interval)
                setNoticeModal({ message: t('matchSetup.modals.matchSavedLocalSyncPending'), type: 'success' })
              }
            } catch (err) {
              clearInterval(interval)
            }
          }, 500)
        }
      }
    } catch (error) {
      console.error('Failed to update home team connection setting:', error)
    }
  }

  const handleAwayTeamConnectionToggle = async (enabled) => {
    if (!matchId) return
    setAwayTeamConnectionEnabled(enabled)
    try {
      const match = await db.matches.get(matchId)
      if (!match) return

      const updates = { awayTeamConnectionEnabled: enabled }

      // If enabling connection and PIN doesn't exist, generate one
      if (enabled && !match.awayTeamPin) {
        const newPin = await generateUniquePin()
        updates.awayTeamPin = String(newPin).trim() // Ensure it's a string
      }

      await db.matches.update(matchId, updates)

      // Sync to server since Scoreboard is not mounted when MatchSetup is shown
      const updatedMatch = await db.matches.get(matchId)
      if (updatedMatch) {
        await syncMatchToServer(updatedMatch)
        // Also sync to Supabase (use seed_key as external_id)
        if (updatedMatch.seed_key) {
          await db.sync_queue.add({
            resource: 'match',
            action: 'update',
            payload: {
              id: updatedMatch.seed_key,
              connections: {
                away_bench_enabled: enabled
              },
              connection_pins: {
                bench_away: updatedMatch.awayTeamPin || ''
              }
            },
            ts: new Date().toISOString(),
            status: 'queued'
          })

          // Show syncing modal and poll for completion
          setNoticeModal({ message: t('matchSetup.modals.syncingToDatabase'), type: 'success', syncing: true })
          let attempts = 0
          const maxAttempts = 20
          const interval = setInterval(async () => {
            attempts++
            try {
              const queued = await db.sync_queue.where('status').equals('queued').count()
              if (queued === 0) {
                clearInterval(interval)
                setNoticeModal({ message: t('matchSetup.modals.syncedToDatabase'), type: 'success' })
              } else if (attempts >= maxAttempts) {
                clearInterval(interval)
                setNoticeModal({ message: t('matchSetup.modals.matchSavedLocalSyncPending'), type: 'success' })
              }
            } catch (err) {
              clearInterval(interval)
            }
          }, 500)
        }
      }
    } catch (error) {
      console.error('Failed to update away team connection setting:', error)
    }
  }

  // Combined Benches toggle handler - enables/disables benches connection for both teams
  const handleBenchConnectionToggle = async (enabled) => {
    if (!matchId) return
    setBenchConnectionEnabled(enabled)
    // Also set the individual states for backwards compatibility
    setHomeTeamConnectionEnabled(enabled)
    setAwayTeamConnectionEnabled(enabled)

    try {
      const match = await db.matches.get(matchId)
      if (!match) return

      const updates = {
        benchConnectionEnabled: enabled,
        homeTeamConnectionEnabled: enabled,
        awayTeamConnectionEnabled: enabled
      }

      // If enabling connection and PINs don't exist, generate them
      if (enabled) {
        if (!match.homeTeamPin) {
          const homePin = await generateUniquePin()
          updates.homeTeamPin = String(homePin).trim()
        }
        if (!match.awayTeamPin) {
          const awayPin = await generateUniquePin()
          updates.awayTeamPin = String(awayPin).trim()
        }
      }

      await db.matches.update(matchId, updates)

      // Sync to server since Scoreboard is not mounted when MatchSetup is shown
      const updatedMatch = await db.matches.get(matchId)
      if (updatedMatch) {
        await syncMatchToServer(updatedMatch)
        // Sync to Supabase (use seed_key as external_id)
        if (updatedMatch.seed_key) {
          await db.sync_queue.add({
            resource: 'match',
            action: 'update',
            payload: {
              id: updatedMatch.seed_key,
              connections: {
                home_bench_enabled: enabled,
                away_bench_enabled: enabled
              },
              connection_pins: {
                bench_home: updatedMatch.homeTeamPin || '',
                bench_away: updatedMatch.awayTeamPin || ''
              }
            },
            ts: new Date().toISOString(),
            status: 'queued'
          })

          // Show syncing modal and poll for completion
          setNoticeModal({ message: t('matchSetup.modals.syncingToDatabase'), type: 'success', syncing: true })
          let attempts = 0
          const maxAttempts = 20
          const interval = setInterval(async () => {
            attempts++
            try {
              const queued = await db.sync_queue.where('status').equals('queued').count()
              if (queued === 0) {
                clearInterval(interval)
                setNoticeModal({ message: t('matchSetup.modals.syncedToDatabase'), type: 'success' })
              } else if (attempts >= maxAttempts) {
                clearInterval(interval)
                setNoticeModal({ message: t('matchSetup.modals.matchSavedLocalSyncPending'), type: 'success' })
              }
            } catch (err) {
              clearInterval(interval)
            }
          }, 500)
        }
      }
    } catch (error) {
      console.error('Failed to update bench connection setting:', error)
    }
  }

  // Dashboard Toggle Component - two rows: label+toggle on top, PIN below
  const DashboardToggle = ({ label, enabled, onToggle, pin }) => {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '8px 12px',
        background: enabled ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255,255,255,0.03)',
        borderRadius: '8px',
        border: enabled ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid rgba(255,255,255,0.1)',
        minWidth: '100px',
        flex: 1
      }}>
        {/* Row 1: Label and Toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: enabled ? '#22c55e' : 'var(--muted)', flex: 1 }}>{label}</span>
          <div style={{
            position: 'relative',
            width: '40px',
            height: '22px',
            background: enabled ? '#22c55e' : '#6b7280',
            borderRadius: '11px',
            transition: 'background 0.2s',
            cursor: 'pointer',
            flexShrink: 0
          }}
            onClick={() => onToggle(!enabled)}
          >
            <div style={{
              position: 'absolute',
              top: '2px',
              left: enabled ? '20px' : '2px',
              width: '18px',
              height: '18px',
              background: '#fff',
              borderRadius: '50%',
              transition: 'left 0.2s',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
            }} />
          </div>
        </div>
        {/* Row 2: PIN (only when enabled) */}
        {enabled && pin && (
          <div style={{ textAlign: 'center' }}>
            <span style={{
              fontWeight: 700,
              fontSize: '16px',
              color: 'var(--accent)',
              letterSpacing: '3px',
              fontFamily: 'monospace'
            }}>
              {pin}
            </span>
          </div>
        )}
      </div>
    )
  }

  // Connection Banner Component (kept for backwards compatibility)
  const ConnectionBanner = ({ team, enabled, onToggle, pin }) => {
    const label = team === 'referee' ? t('matchSetup.referee') : team === 'home' ? t('matchSetup.benchHome') : t('matchSetup.benchAway')
    return (
      <DashboardToggle
        label={label}
        enabled={enabled}
        onToggle={onToggle}
        pin={pin}
      />
    )
  }

  // Combined Benches Toggle Component - shows both PINs when enabled
  const BenchesToggle = ({ enabled, onToggle, homePin, awayPin }) => {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '8px 12px',
        background: enabled ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255,255,255,0.03)',
        borderRadius: '8px',
        border: enabled ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid rgba(255,255,255,0.1)',
        minWidth: '140px',
        flex: 1
      }}>
        {/* Row 1: Label and Toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: enabled ? '#22c55e' : 'var(--muted)', flex: 1 }}>{t('matchSetup.benches')}</span>
          <div style={{
            position: 'relative',
            width: '40px',
            height: '22px',
            background: enabled ? '#22c55e' : '#6b7280',
            borderRadius: '11px',
            transition: 'background 0.2s',
            cursor: 'pointer',
            flexShrink: 0
          }}
            onClick={() => onToggle(!enabled)}
          >
            <div style={{
              position: 'absolute',
              top: '2px',
              left: enabled ? '20px' : '2px',
              width: '18px',
              height: '18px',
              background: '#fff',
              borderRadius: '50%',
              transition: 'left 0.2s',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
            }} />
          </div>
        </div>
        {/* Row 2: Both PINs (only when enabled) */}
        {enabled && (homePin || awayPin) && (
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
            {homePin && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '9px', color: 'var(--muted)', marginBottom: '2px' }}>{t('matchSetup.home')}</div>
                <span style={{
                  fontWeight: 700,
                  fontSize: '14px',
                  color: 'var(--accent)',
                  letterSpacing: '2px',
                  fontFamily: 'monospace'
                }}>
                  {homePin}
                </span>
              </div>
            )}
            {awayPin && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '9px', color: 'var(--muted)', marginBottom: '2px' }}>{t('matchSetup.away')}</div>
                <span style={{
                  fontWeight: 700,
                  fontSize: '14px',
                  color: 'var(--accent)',
                  letterSpacing: '2px',
                  fontFamily: 'monospace'
                }}>
                  {awayPin}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const handleEditPin = (type) => {
    let currentPin = ''
    if (type === 'referee') {
      currentPin = String(match?.refereePin || '').trim()
    } else if (type === 'benchHome') {
      currentPin = String(match?.homeTeamPin || '').trim()
    } else if (type === 'benchAway') {
      currentPin = String(match?.awayTeamPin || '').trim()
    }
    setNewPin(currentPin)
    setPinError('')
    setEditPinType(type)
    setEditPinModal(true)
  }

  const handleSavePin = async () => {
    if (!matchId || !editPinType) return

    // Validate PIN
    if (!newPin || newPin.length !== 6) {
      setPinError('PIN must be exactly 6 digits')
      return
    }
    if (!/^\d{6}$/.test(newPin)) {
      setPinError('PIN must contain only numbers')
      return
    }

    try {
      // Ensure PIN is saved as a string (trimmed)
      const pinValue = String(newPin).trim()
      let updateField = {}
      if (editPinType === 'referee') {
        updateField = { refereePin: pinValue }
      } else if (editPinType === 'benchHome') {
        updateField = { homeTeamPin: pinValue }
      } else if (editPinType === 'benchAway') {
        updateField = { awayTeamPin: pinValue }
      }
      await db.matches.update(matchId, updateField)
      setEditPinModal(false)
      setPinError('')
      setEditPinType(null)
    } catch (error) {
      console.error('Failed to update PIN:', error)
      setPinError('Failed to save PIN')
    }
  }

  return (
    <MatchSetupMainView>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: s(16), gap: s(16) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: s(12) }}>
          <h2 style={{ margin: 0, fontSize: s(24) }}>{t('matchSetup.title')}</h2>
          <button
            className="secondary"
            onClick={openScoresheet}
            style={{ padding: `${s(6)}px ${s(12)}px`, fontSize: s(13), background: '#22c55e', color: '#000' }}
          >
            📄 {t('matchSetup.scoresheet')}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: s(8) }}>
          {onOpenOptions && (
            <button className="secondary" onClick={onOpenOptions} style={{ padding: `${s(8)}px ${s(16)}px`, fontSize: s(14) }}>
              {t('matchSetup.options')}
            </button>
          )}
        </div>
      </div>
      <div className="setup-cards-grid setup-section">
        {/* Match Info Card */}
        <div data-help-id="setup-match-info-card" className="card" style={{ padding: s(20), ...(!matchInfoConfirmed ? { border: `2px solid ${canConfirmMatchInfo ? '#3b82f6' : '#f59e0b'}` } : {}) }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: s(4) }}>
                <StatusBadge ready={matchInfoConfirmed} pending={!matchInfoConfirmed && canConfirmMatchInfo} />
                <h3 style={{ margin: 0, background: 'rgba(255, 255, 255, 0.1)', padding: `${s(4)}px ${s(8)}px`, borderRadius: s(4), fontSize: s(17) }}>{t('matchSetup.matchInfo')}</h3>
              </div>
              <SyncStatusIndicator status={matchInfoSyncStatus} onRetry={() => retrySyncForCard('matchInfo')} />
            </div>
            <div
              style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: s(6), columnGap: s(10), marginTop: s(10), fontSize: s(14) }}
            >
              {/* Home Team row with color indicator */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                <span>{t('matchSetup.homeTeam')}:</span>
              </div>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, padding: `${s(2)}px 0` }} title={home}>{home || t('common.notSet')}</span>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                <span>{t('matchSetup.awayTeam')}:</span>
              </div>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, padding: `${s(2)}px 0` }} title={away}>{away || t('common.notSet')}</span>

              <span>{t('matchSetup.date')}:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatDisplayDate(date) || t('common.notSet')}</span>
              <span>{t('matchSetup.time')}:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatDisplayTime(time) || t('common.notSet')}</span>
              <span>{t('matchSetup.city')}:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={city}>{city || t('common.notSet')}</span>
              <span>{t('matchSetup.hall')}:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={hall}>{hall || t('common.notSet')}</span>
            </div>
          </div>
          <div className="actions">
            {matchInfoConfirmed ? (
              <button className="secondary" onClick={() => setCurrentView('info')} style={{ padding: `${s(8)}px ${s(16)}px`, fontSize: s(14) }}>{t('common.edit')}</button>
            ) : (
              <button
                className="primary"
                onClick={() => setCurrentView('info')}
                style={{ padding: `${s(10)}px ${s(20)}px`, fontSize: s(15) }}
              >
                {t('matchSetup.createMatch')}
              </button>
            )}
          </div>
        </div>

        {/* Match Officials Card */}
        <div className="card" style={{ padding: s(20), ...(!matchInfoConfirmed ? { opacity: 0.5, pointerEvents: 'none' } : {}) }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: s(4) }}>
                <StatusBadge ready={officialsConfigured} />
                <h3 style={{ margin: 0, background: 'rgba(255, 255, 255, 0.1)', padding: `${s(4)}px ${s(8)}px`, borderRadius: s(4), fontSize: s(17) }}>{t('matchSetup.matchOfficials')}</h3>
              </div>
              <SyncStatusIndicator status={officialsSyncStatus} onRetry={() => retrySyncForCard('officials')} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: s(6), columnGap: s(10), marginTop: s(10), fontSize: s(14) }}>
              <span>{t('matchSetup.referee1')}:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={formatOfficial(ref1Last, ref1First)}>{formatOfficial(ref1Last, ref1First)}</span>
              <span>{t('matchSetup.referee2')}:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={formatOfficial(ref2Last, ref2First)}>{formatOfficial(ref2Last, ref2First)}</span>
              <span>{t('matchSetup.scorer')}:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={formatOfficial(scorerLast, scorerFirst)}>{formatOfficial(scorerLast, scorerFirst)}</span>
              <span>{t('matchSetup.assistantScorer')}:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={formatOfficial(asstLast, asstFirst)}>{formatOfficial(asstLast, asstFirst)}</span>
              {(lineJudge1 || lineJudge2 || lineJudge3 || lineJudge4) && (
                <>
                  <span>{t('matchSetup.lineJudges')}:</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[lineJudge1, lineJudge2, lineJudge3, lineJudge4].filter(Boolean).map(formatLineJudge).join(', ')}>
                    {[lineJudge1, lineJudge2, lineJudge3, lineJudge4].filter(Boolean).map(formatLineJudge).join(', ') || t('common.notSet')}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="actions">
            <button className="secondary" onClick={() => setCurrentView('officials')} disabled={!matchInfoConfirmed} style={{ padding: `${s(8)}px ${s(16)}px`, fontSize: s(14) }}>{t('common.edit')}</button>
          </div>
        </div>
      </div>
      {/* Dashboard Connections Row */}
      <div className="setup-section" style={{
        padding: s(16),
        background: 'rgba(255, 255, 255, 0.03)',
        borderRadius: s(8),
        border: '1px solid rgba(255, 255, 255, 0.08)',
        ...(matchInfoConfirmed ? {} : { opacity: 0.5, pointerEvents: 'none' })
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: s(8), marginBottom: s(4) }}>
          <span style={{ fontWeight: 600, fontSize: s(14), textAlign: 'center', alignItems: 'center' }}>{t('matchSetup.dashboards')}</span>
        </div>
        <div style={{ display: 'flex', gap: s(10), flexWrap: 'wrap' }}>
          <ConnectionBanner
            team="referee"
            enabled={refereeConnectionEnabled}
            onToggle={handleRefereeConnectionToggle}
            pin={match?.refereePin}
          />
          <BenchesToggle
            enabled={benchConnectionEnabled}
            onToggle={handleBenchConnectionToggle}
            homePin={match?.homeTeamPin}
            awayPin={match?.awayTeamPin}
          />
        </div>
      </div>

      <div className="grid-4 setup-section" style={!matchInfoConfirmed ? { opacity: 0.5, pointerEvents: 'none' } : {}}>
        <div className="card" style={{ order: 1, padding: s(20) }}>
          {/* Row 1: Status + Team Name + Sync Indicator */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: s(8) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: s(8) }}>
              <StatusBadge ready={homeConfigured} />
              <h1 style={{
                margin: 0,
                background: homeColor,
                color: getContrastColor(homeColor),
                padding: `${s(6)}px ${s(16)}px`,
                borderRadius: s(8),
                fontSize: s(22)
              }}>
                {home && home !== 'Home' ? home.toUpperCase() : t('matchSetup.homeTeam').toUpperCase()}
              </h1>
            </div>
            <SyncStatusIndicator status={homeTeamSyncStatus} onRetry={() => retrySyncForCard('home')} />
          </div>

          {/* Row 2: Stats */}
          <div style={{ display: 'flex', gap: s(10), alignItems: 'center', flexWrap: 'wrap', marginTop: s(30) }}>
            <div style={{
              background: 'rgb(0, 0, 0)',
              borderRadius: s(6),
              padding: `${s(4)}px ${s(10)}px`,
              fontWeight: 500,
              color: '#fff',
              fontSize: s(13),
              height: s(24),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              {t('matchSetup.players')}: {homeCounts.players}
            </div>
            <div style={{
              background: 'rgb(255, 255, 255)',
              borderRadius: s(6),
              padding: `${s(4)}px ${s(10)}px`,
              fontWeight: 500,
              color: '#000',
              fontSize: s(13),
              height: s(24),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              {t('matchSetup.liberos')}: {homeCounts.liberos}
            </div>
            <div style={{
              background: 'rgba(34, 197, 94, 0.10)',
              borderRadius: s(6),
              padding: `${s(4)}px ${s(10)}px`,
              fontWeight: 500,
              color: '#4ade80',
              fontSize: s(13),
              height: s(24),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              {t('matchSetup.bench')}: {homeCounts.bench}
            </div>
          </div>

          {/* Row 3: Color selector + Shirt + Roster */}
          <div style={{ display: 'flex', alignItems: 'center', gap: s(12), marginTop: s(30) }}>
            <span style={{ fontSize: s(13), color: 'rgba(255, 255, 255, 0.7)' }}>{t('matchSetup.selectColour')}</span>
            <div
              className="shirt"
              style={{ background: homeColor, cursor: 'pointer', transform: `scale(${scaleFactor})` }}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                const centerX = rect.left + rect.width / 2
                setColorPickerModal({
                  team: 'home',
                  position: { x: centerX, y: rect.bottom + 8 }
                })
              }}
            >
              <div className="collar" style={{ background: homeColor }} />
              <div className="number" style={{ color: getContrastColor(homeColor) }}>1</div>
            </div>
            <div style={{ flex: 1 }} />
            <button className="secondary" onClick={() => setCurrentView('home')} style={{ padding: `${s(8)}px ${s(16)}px`, fontSize: s(14) }}>{t('matchSetup.editRoster')}</button>
          </div>
        </div>

        <div className="card" style={{ order: 2, padding: s(20) }}>
          {/* Row 1: Status + Team Name + Sync Indicator */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: s(8) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: s(8) }}>
              <StatusBadge ready={awayConfigured} />
              <h1 style={{
                margin: 0,
                background: awayColor,
                color: getContrastColor(awayColor),
                padding: `${s(6)}px ${s(16)}px`,
                borderRadius: s(8),
                fontSize: s(22)
              }}>
                {away && away !== 'Away' ? away.toUpperCase() : t('matchSetup.awayTeam').toUpperCase()}
              </h1>
            </div>
            <SyncStatusIndicator status={awayTeamSyncStatus} onRetry={() => retrySyncForCard('away')} />
          </div>

          {/* Row 2: Stats */}
          <div style={{ display: 'flex', gap: s(10), alignItems: 'center', flexWrap: 'wrap', marginTop: s(30) }}>
            <div style={{
              background: 'rgb(0, 0, 0)',
              borderRadius: s(6),
              padding: `${s(4)}px ${s(10)}px`,
              fontWeight: 500,
              color: '#fff',
              fontSize: s(13),
              height: s(24),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              {t('matchSetup.players')}: {awayCounts.players}
            </div>
            <div style={{
              background: 'rgb(255, 255, 255)',
              borderRadius: s(6),
              padding: `${s(4)}px ${s(10)}px`,
              fontWeight: 500,
              color: '#000',
              fontSize: s(13),
              height: s(24),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              {t('matchSetup.liberos')}: {awayCounts.liberos}
            </div>
            <div style={{
              background: 'rgba(34, 197, 94, 0.10)',
              borderRadius: s(6),
              padding: `${s(4)}px ${s(10)}px`,
              fontWeight: 500,
              color: '#4ade80',
              fontSize: s(13),
              height: s(24),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              {t('matchSetup.bench')}: {awayCounts.bench}
            </div>
          </div>

          {/* Row 3: Color selector + Shirt + Roster */}
          <div style={{ display: 'flex', alignItems: 'center', gap: s(12), marginTop: s(30) }}>
            <span style={{ fontSize: s(13), color: 'rgba(255, 255, 255, 0.7)' }}>{t('matchSetup.selectColour')}</span>
            <div
              className="shirt"
              style={{ background: awayColor, cursor: 'pointer', transform: `scale(${scaleFactor})` }}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                const centerX = rect.left + rect.width / 2
                setColorPickerModal({
                  team: 'away',
                  position: { x: centerX, y: rect.bottom + 8 }
                })
              }}
            >
              <div className="collar" style={{ background: awayColor }} />
              <div className="number" style={{ color: getContrastColor(awayColor) }}>1</div>
            </div>
            <div style={{ flex: 1 }} />
            <button className="secondary" onClick={() => setCurrentView('away')} style={{ padding: `${s(8)}px ${s(16)}px`, fontSize: s(14) }}>{t('matchSetup.editRoster')}</button>
          </div>
        </div>
        {typeof window !== 'undefined' && window.electronAPI?.server && (
          <div className="card" style={{ order: 3 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <StatusBadge ready={serverRunning} />
                  <h3 style={{ margin: 0 }}>Live Server</h3>
                </div>
              </div>
              {serverRunning && serverStatus ? (
                <div style={{ marginTop: 12 }}>
                  <div className="text-sm" style={{ display: 'grid', gridTemplateColumns: '100px 1fr', rowGap: 8, marginBottom: 2 }}>
                    <span>Status:</span>
                    <span style={{ color: '#10b981', fontWeight: 600 }}>● Running</span>
                    <span>Hostname:</span>
                    <span style={{ fontFamily: 'monospace', fontSize: '13px' }}>{serverStatus.hostname || 'escoresheet.local'}</span>
                    <span>IP Address:</span>
                    <span style={{ fontFamily: 'monospace', fontSize: '13px' }}>{serverStatus.localIP}</span>
                    <span>Protocol:</span>
                    <span style={{ textTransform: 'uppercase' }}>{serverStatus.protocol || 'https'}</span>
                  </div>
                  <div style={{
                    background: 'rgba(15, 23, 42, 0.5)',
                    padding: '12px',
                    borderRadius: '8px',
                    marginTop: '12px',
                    fontSize: '12px'
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>Connection URLs:</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'monospace', fontSize: '11px' }}>
                      <div>
                        <div style={{ color: 'rgba(255,255,255,0.6)' }}>Main:</div>
                        <div style={{ wordBreak: 'break-all' }}>{serverStatus.urls?.mainIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/`}</div>
                      </div>
                      <div>
                        <div style={{ color: 'rgba(255,255,255,0.6)' }}>Referee:</div>
                        <div style={{ wordBreak: 'break-all' }}>{serverStatus.urls?.refereeIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/referee`}</div>
                      </div>
                      <div>
                        <div style={{ color: 'rgba(255,255,255,0.6)' }}>Bench:</div>
                        <div style={{ wordBreak: 'break-all' }}>{serverStatus.urls?.benchIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/bench`}</div>
                      </div>
                      <div>
                        <div style={{ color: 'rgba(255,255,255,0.6)' }}>WebSocket:</div>
                        <div style={{ wordBreak: 'break-all' }}>{serverStatus.urls?.websocketIP || `${serverStatus.wsProtocol}://${serverStatus.localIP}:${serverStatus.wsPort}`}</div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 12 }}>
                  <p className="text-sm" style={{ color: 'rgba(255, 255, 255, 0.6)', marginBottom: 12 }}>
                    Start the live server to allow referee, bench, and livescore apps to connect.
                  </p>
                  {typeof window !== 'undefined' && !window.electronAPI?.server && (
                    <div style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      padding: '12px',
                      borderRadius: '8px',
                      fontSize: '12px',
                      color: 'rgba(255,255,255,0.7)',
                      marginTop: '12px'
                    }}>
                      <div style={{ marginBottom: '8px', fontWeight: 600 }}>To start from browser/PWA:</div>
                      <div style={{ fontFamily: 'monospace', fontSize: '11px', lineHeight: '1.6' }}>
                        Run: <span style={{ color: '#22c55e', fontWeight: 600 }}>npm run start:prod</span> in terminal
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="actions">
              {serverRunning ? (
                typeof window !== 'undefined' && window.electronAPI?.server ? (
                  <button
                    className="secondary"
                    onClick={handleStopServer}
                    disabled={serverLoading}
                  >
                    {serverLoading ? 'Stopping...' : 'Stop Server'}
                  </button>
                ) : null
              ) : (
                <button
                  className="primary"
                  onClick={handleStartServer}
                  disabled={serverLoading}
                >
                  {typeof window !== 'undefined' && window.electronAPI?.server
                    ? (serverLoading ? 'Starting...' : 'Start Server')
                    : '📋 Copy Start Command'
                  }
                </button>
              )}
            </div>
          </div>
        )}


      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: s(16), alignItems: 'center', ...(matchInfoConfirmed ? {} : { opacity: 0.5, pointerEvents: 'none' }) }}>
        <button
          className="secondary"
          style={{
            background: '#ffe066',
            color: '#222',
            border: '1px solid #ffd700',
            fontWeight: 700,
            padding: `${s(10)}px ${s(20)}px`,
            fontSize: s(14)
          }}
          onClick={() => setShowBothRosters(!showBothRosters)}
          disabled={!matchInfoConfirmed}
        >
          {showBothRosters ? t('scoreboard.hideRosters') : t('scoreboard.showRosters')}
        </button>
        {isMatchOngoing && onReturn ? (
          <button onClick={onReturn} style={{ padding: `${s(10)}px ${s(20)}px`, fontSize: s(14) }}>{t('scoreboard.returnToMatch')}</button>
        ) : (
          <button
            data-help-id="setup-proceed-cointoss"
            disabled={!canProceedToCoinToss}
            style={{
              opacity: canProceedToCoinToss ? 1 : 0.5,
              cursor: canProceedToCoinToss ? 'pointer' : 'not-allowed',
              padding: `${s(10)}px ${s(20)}px`,
              fontSize: s(14)
            }}
            onClick={async () => {
              // Check if match has no data (no sets, no signatures)
              if (matchId && match) {
                const sets = await db.sets.where('matchId').equals(matchId).toArray()
                const hasNoData = sets.length === 0 && !match.homeCoachSignature && !match.homeCaptainSignature && !match.awayCoachSignature && !match.awayCaptainSignature

                if (hasNoData) {
                  // Check for existing validation errors
                  if (dateError) {
                    setNoticeModal({ message: t('matchSetup.invalidDate', { error: dateError }) })
                    return
                  }
                  if (timeError) {
                    setNoticeModal({ message: t('matchSetup.invalidTime', { error: timeError }) })
                    return
                  }

                  // Validate date/time before going to coin toss
                  let scheduledAt
                  try {
                    scheduledAt = createScheduledAt(date, time, { allowEmpty: false })
                  } catch (err) {
                    setNoticeModal({ message: t('matchSetup.invalidDateTime', { error: err.message }) })
                    return
                  }

                  // Update match with current data before going to coin toss
                  await db.matches.update(matchId, {
                    hall,
                    city,
                    match_type_1: type1,
                    match_type_1_other: type1 === 'other' ? type1Other : null,
                    championshipType,
                    championshipTypeOther: championshipType === 'other' ? championshipTypeOther : null,
                    match_type_2: type2,
                    match_type_3: type3,
                    match_type_3_other: type3 === 'other' ? type3Other : null,
                    homeShortName: homeShortName || home.substring(0, 10).toUpperCase(),
                    awayShortName: awayShortName || away.substring(0, 10).toUpperCase(),
                    game_n: gameN ? Number(gameN) : null,
                    gameNumber: gameN ? gameN : null,
                    league,
                    scheduledAt,
                    officials: buildOfficialsArray(
                      { firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: ref1Dob },
                      { firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: ref2Dob },
                      { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob },
                      { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
                      { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 }
                    ),
                    bench_home: benchHome,
                    bench_away: benchAway
                  })

                  // Update teams if needed
                  if (match.homeTeamId) {
                    await db.teams.update(match.homeTeamId, { name: home, color: homeColor })
                  }
                  if (match.awayTeamId) {
                    await db.teams.update(match.awayTeamId, { name: away, color: awayColor })
                  }

                  // Update players
                  if (match.homeTeamId && homeRoster.length) {
                    // Delete existing players and add new ones
                    await db.players.where('teamId').equals(match.homeTeamId).delete()
                    await db.players.bulkAdd(
                      homeRoster.map(p => ({
                        teamId: match.homeTeamId,
                        number: p.number,
                        name: `${p.lastName} ${p.firstName}`,
                        lastName: p.lastName,
                        firstName: p.firstName,
                        dob: p.dob || null,
                        libero: p.libero || '',
                        isCaptain: !!p.isCaptain,
                        isLfp: !!p.isLfp,
                        role: null,
                        createdAt: new Date().toISOString()
                      }))
                    )
                  }
                  if (match.awayTeamId && awayRoster.length) {
                    // Delete existing players and add new ones
                    await db.players.where('teamId').equals(match.awayTeamId).delete()
                    await db.players.bulkAdd(
                      awayRoster.map(p => ({
                        teamId: match.awayTeamId,
                        number: p.number,
                        name: `${p.lastName} ${p.firstName}`,
                        lastName: p.lastName,
                        firstName: p.firstName,
                        dob: p.dob || null,
                        libero: p.libero || '',
                        isCaptain: !!p.isCaptain,
                        isLfp: !!p.isLfp,
                        role: null,
                        createdAt: new Date().toISOString()
                      }))
                    )
                  }

                  // Check if all 4 setup cards are ready before going to coin toss
                  const setupIssues = []

                  // Check Match Info
                  if (!(date || time || hall || city || league)) {
                    setupIssues.push('Match Info (date, time, venue, etc.)')
                  }

                  // Check Officials - at least 1R should be set
                  if (!ref1First && !ref1Last) {
                    setupIssues.push('Match Officials (1st Referee)')
                  }

                  // Check Home Team
                  if (!home || home.trim() === '' || home === 'Home') {
                    setupIssues.push('Home Team name')
                  } else if (homeRoster.length < 6) {
                    setupIssues.push('Home Team roster (minimum 6 players)')
                  } else {
                    // Additional roster validations for proceeding to coin toss
                    // Note: all players having numbers is only validated when CONFIRMING coin toss
                    if (!homeCounts.hasCaptain) {
                      setupIssues.push('Home Team: must have a captain assigned')
                    }
                    if (!homeCounts.hasCoach) {
                      setupIssues.push('Home Team: must have a coach')
                    }
                  }

                  // Check Away Team
                  if (!away || away.trim() === '' || away === 'Away') {
                    setupIssues.push('Away Team name')
                  } else if (awayRoster.length < 6) {
                    setupIssues.push('Away Team roster (minimum 6 players)')
                  } else {
                    // Additional roster validations for proceeding to coin toss
                    // Note: all players having numbers is only validated when CONFIRMING coin toss
                    if (!awayCounts.hasCaptain) {
                      setupIssues.push('Away Team: must have a captain assigned')
                    }
                    if (!awayCounts.hasCoach) {
                      setupIssues.push('Away Team: must have a coach')
                    }
                  }

                  // Check short names
                  if (!homeShortName || homeShortName.trim() === '') {
                    setupIssues.push('Home Team short name')
                  }
                  if (!awayShortName || awayShortName.trim() === '') {
                    setupIssues.push('Away Team short name')
                  }

                  if (setupIssues.length > 0) {
                    setNoticeModal({
                      message: t('matchSetup.validation.completeBeforeCoinToss', { issues: setupIssues.join('\n• ') })
                    })
                    return
                  }

                  // Go to coin toss
                  onOpenCoinToss()
                } else {
                  // Match has data already - just go to coin toss (don't create new match)
                  // The match already exists with data, so just navigate
                  onOpenCoinToss()
                }
              } else {
                // No match exists - create new match
                await createMatch()
              }
            }}>{t('matchSetup.coinToss')}</button>
        )}
      </div>

      {showBothRosters && (() => {
        // Separate players and liberos
        const homePlayers = (homeRoster || []).filter(p => !p.libero).sort((a, b) => (a.number || 0) - (b.number || 0))
        const homeLiberos = (homeRoster || []).filter(p => p.libero).sort((a, b) => {
          // Sort by number first (primary), then by libero1/libero2 (secondary)
          const numDiff = (a.number || 0) - (b.number || 0)
          if (numDiff !== 0) return numDiff
          if (a.libero === 'libero1') return -1
          if (b.libero === 'libero1') return 1
          return 0
        })
        const awayPlayers = (awayRoster || []).filter(p => !p.libero).sort((a, b) => (a.number || 0) - (b.number || 0))
        const awayLiberos = (awayRoster || []).filter(p => p.libero).sort((a, b) => {
          // Sort by number first (primary), then by libero1/libero2 (secondary)
          const numDiff = (a.number || 0) - (b.number || 0)
          if (numDiff !== 0) return numDiff
          if (a.libero === 'libero1') return -1
          if (b.libero === 'libero1') return 1
          return 0
        })

        // Pad arrays to same length for alignment
        const maxPlayers = Math.max(homePlayers.length, awayPlayers.length)
        const maxLiberos = Math.max(homeLiberos.length, awayLiberos.length)

        const paddedHomePlayers = [...homePlayers, ...Array(maxPlayers - homePlayers.length).fill(null)]
        const paddedAwayPlayers = [...awayPlayers, ...Array(maxPlayers - awayPlayers.length).fill(null)]
        const paddedHomeLiberos = [...homeLiberos, ...Array(maxLiberos - homeLiberos.length).fill(null)]
        const paddedAwayLiberos = [...awayLiberos, ...Array(maxLiberos - awayLiberos.length).fill(null)]

        // Bench officials
        const homeBench = (benchHome || []).filter(b => b.firstName || b.lastName || b.dob)
        const awayBench = (benchAway || []).filter(b => b.firstName || b.lastName || b.dob)
        const maxBench = Math.max(homeBench.length, awayBench.length)
        const paddedHomeBench = [...homeBench, ...Array(maxBench - homeBench.length).fill(null)]
        const paddedAwayBench = [...awayBench, ...Array(maxBench - awayBench.length).fill(null)]

        // Scaled table cell styles
        const thStyle = { padding: `${s(8)}px ${s(12)}px`, fontSize: s(13), fontWeight: 600 }
        const tdStyle = { padding: `${s(6)}px ${s(12)}px`, fontSize: s(14) }
        const numberStyle = { ...tdStyle, width: s(60), textAlign: 'center', fontWeight: 600 }
        const nameStyle = { ...tdStyle, minWidth: s(180) }
        const dobStyle = { ...tdStyle, width: s(100), textAlign: 'center' }
        const emptyRowStyle = { height: s(36) }
        const sectionTitleStyle = { display: 'block', marginBottom: s(8), fontSize: s(14), fontWeight: 600 }
        const panelTitleStyle = { fontSize: s(18), marginBottom: s(12) }

        return (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: s(24) }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: s(24), maxWidth: s(1200), width: '100%' }}>
              <div className="panel" style={{ padding: s(20) }}>
                <h3 style={panelTitleStyle}>{t('roster.titleWithTeam', { team: home || t('common.home') })}</h3>
                {/* Players Section */}
                <div style={{ marginBottom: s(16) }}>
                  <strong style={sectionTitleStyle}>{t('roster.players')}</strong>
                  <table className="roster-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>#</th>
                        <th style={thStyle}>{t('roster.name')}</th>
                        <th style={thStyle}>{t('roster.dob')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paddedHomePlayers.map((player, idx) => (
                        <tr key={player ? `p-${idx}` : `empty-${idx}`}>
                          {player ? (
                            <>
                              <td style={numberStyle}>
                                <span>{player.number ?? '—'}</span>
                                {player.isCaptain && <span style={{ marginLeft: s(4), background: '#f59e0b', color: '#000', padding: `${s(1)}px ${s(4)}px`, borderRadius: s(3), fontSize: s(10), fontWeight: 700 }}>C</span>}
                              </td>
                              <td style={nameStyle}>
                                {player.lastName || ''} {player.firstName || ''}
                              </td>
                              <td style={dobStyle}>{player.dob || '—'}</td>
                            </>
                          ) : (
                            <td colSpan="3" style={emptyRowStyle}>&nbsp;</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Liberos Section */}
                {(maxLiberos > 0) && (
                  <div style={{ marginBottom: s(16) }}>
                    <strong style={sectionTitleStyle}>{t('roster.liberos')}</strong>
                    <table className="roster-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={thStyle}>#</th>
                          <th style={thStyle}>{t('roster.name')}</th>
                          <th style={thStyle}>{t('roster.dob')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paddedHomeLiberos.map((player, idx) => (
                          <tr key={player ? `l-${idx}` : `empty-libero-${idx}`}>
                            {player ? (
                              <>
                                <td style={numberStyle}>
                                  <span>{player.number ?? '—'}</span>
                                  {player.isCaptain && <span style={{ marginLeft: s(4), background: '#f59e0b', color: '#000', padding: `${s(1)}px ${s(4)}px`, borderRadius: s(3), fontSize: s(10), fontWeight: 700 }}>C</span>}
                                  <span style={{ marginLeft: s(4), background: '#22c55e', color: '#000', padding: `${s(1)}px ${s(4)}px`, borderRadius: s(3), fontSize: s(10), fontWeight: 700 }}>
                                    {player.libero === 'libero1' ? 'L1' : 'L2'}
                                  </span>
                                </td>
                                <td style={nameStyle}>
                                  {player.lastName || ''} {player.firstName || ''}
                                </td>
                                <td style={dobStyle}>{player.dob || '—'}</td>
                              </>
                            ) : (
                              <td colSpan="3" style={emptyRowStyle}>&nbsp;</td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {/* Bench Officials Section */}
                <div>
                  <strong style={sectionTitleStyle}>{t('roster.bench')}</strong>
                  <table className="roster-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>{t('roster.role')}</th>
                        <th style={thStyle}>{t('roster.name')}</th>
                        <th style={thStyle}>{t('roster.dob')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paddedHomeBench.map((official, idx) => (
                        <tr key={official ? `b-${idx}` : `empty-bench-${idx}`}>
                          {official ? (
                            <>
                              <td style={{ ...tdStyle, textTransform: 'capitalize', fontWeight: 500 }}>{official.role || '—'}</td>
                              <td style={tdStyle}>{official.lastName || ''} {official.firstName || ''}</td>
                              <td style={dobStyle}>{official.dob || '—'}</td>
                            </>
                          ) : (
                            <td colSpan="3" style={emptyRowStyle}>&nbsp;</td>
                          )}
                        </tr>
                      ))}
                      {maxBench === 0 && (
                        <tr>
                          <td colSpan="3" style={{ ...tdStyle, textAlign: 'center', color: 'var(--muted)', fontStyle: 'italic' }}>{t('roster.noBenchOfficials')}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="panel" style={{ padding: s(20) }}>
                <h3 style={panelTitleStyle}>{t('roster.titleWithTeam', { team: away || t('common.away') })}</h3>
                {/* Players Section */}
                <div style={{ marginBottom: s(16) }}>
                  <strong style={sectionTitleStyle}>{t('roster.players')}</strong>
                  <table className="roster-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>#</th>
                        <th style={thStyle}>{t('roster.name')}</th>
                        <th style={thStyle}>{t('roster.dob')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paddedAwayPlayers.map((player, idx) => (
                        <tr key={player ? `p-${idx}` : `empty-${idx}`}>
                          {player ? (
                            <>
                              <td style={numberStyle}>
                                <span>{player.number ?? '—'}</span>
                                {player.isCaptain && <span style={{ marginLeft: s(4), background: '#f59e0b', color: '#000', padding: `${s(1)}px ${s(4)}px`, borderRadius: s(3), fontSize: s(10), fontWeight: 700 }}>C</span>}
                              </td>
                              <td style={nameStyle}>
                                {player.lastName || ''} {player.firstName || ''}
                              </td>
                              <td style={dobStyle}>{player.dob || '—'}</td>
                            </>
                          ) : (
                            <td colSpan="3" style={emptyRowStyle}>&nbsp;</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Liberos Section */}
                {(maxLiberos > 0) && (
                  <div style={{ marginBottom: s(16) }}>
                    <strong style={sectionTitleStyle}>{t('roster.liberos')}</strong>
                    <table className="roster-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={thStyle}>#</th>
                          <th style={thStyle}>{t('roster.name')}</th>
                          <th style={thStyle}>{t('roster.dob')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paddedAwayLiberos.map((player, idx) => (
                          <tr key={player ? `l-${idx}` : `empty-libero-${idx}`}>
                            {player ? (
                              <>
                                <td style={numberStyle}>
                                  <span>{player.number ?? '—'}</span>
                                  {player.isCaptain && <span style={{ marginLeft: s(4), background: '#f59e0b', color: '#000', padding: `${s(1)}px ${s(4)}px`, borderRadius: s(3), fontSize: s(10), fontWeight: 700 }}>C</span>}
                                  <span style={{ marginLeft: s(4), background: '#22c55e', color: '#000', padding: `${s(1)}px ${s(4)}px`, borderRadius: s(3), fontSize: s(10), fontWeight: 700 }}>
                                    {player.libero === 'libero1' ? 'L1' : 'L2'}
                                  </span>
                                </td>
                                <td style={nameStyle}>
                                  {player.lastName || ''} {player.firstName || ''}
                                </td>
                                <td style={dobStyle}>{player.dob || '—'}</td>
                              </>
                            ) : (
                              <td colSpan="3" style={emptyRowStyle}>&nbsp;</td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {/* Bench Officials Section */}
                <div>
                  <strong style={sectionTitleStyle}>{t('roster.bench')}</strong>
                  <table className="roster-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>{t('roster.role')}</th>
                        <th style={thStyle}>{t('roster.name')}</th>
                        <th style={thStyle}>{t('roster.dob')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paddedAwayBench.map((official, idx) => (
                        <tr key={official ? `b-${idx}` : `empty-bench-${idx}`}>
                          {official ? (
                            <>
                              <td style={{ ...tdStyle, textTransform: 'capitalize', fontWeight: 500 }}>{official.role || '—'}</td>
                              <td style={tdStyle}>{official.lastName || ''} {official.firstName || ''}</td>
                              <td style={dobStyle}>{official.dob || '—'}</td>
                            </>
                          ) : (
                            <td colSpan="3" style={emptyRowStyle}>&nbsp;</td>
                          )}
                        </tr>
                      ))}
                      {maxBench === 0 && (
                        <tr>
                          <td colSpan="3" style={{ ...tdStyle, textAlign: 'center', color: 'var(--muted)', fontStyle: 'italic' }}>{t('roster.noBenchOfficials')}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Color Picker Bubble Modal */}
      {colorPickerModal && (
        <>
          {/* Backdrop to close on click outside */}
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 999,
              background: 'rgba(0, 0, 0, 0.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            onClick={() => setColorPickerModal(null)}
          />
          {/* Bubble modal */}
          <div
            style={{
              position: 'fixed',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 1000,
              background: '#1f2937',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '12px',
              padding: '16px',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
              minWidth: '280px'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ marginBottom: '12px', fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>
              {t('matchSetup.chooseTeamColor', { team: colorPickerModal.team === 'home' ? t('common.home') : t('common.away') })}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '12px'
              }}
            >
              {teamColors.map((color) => {
                const isSelected = (colorPickerModal.team === 'home' ? homeColor : awayColor) === color
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={async () => {
                      const isHome = colorPickerModal.team === 'home'
                      if (isHome) {
                        setHomeColor(color)
                      } else {
                        setAwayColor(color)
                      }
                      setColorPickerModal(null)

                      // Sync color to local DB and Supabase
                      try {
                        // Update local team in IndexedDB
                        const teamId = isHome ? match?.homeTeamId : match?.awayTeamId
                        if (teamId) {
                          await db.teams.update(teamId, { color })
                        }

                        // Update local match record in IndexedDB
                        if (match?.id) {
                          const colorField = isHome ? 'homeColor' : 'awayColor'
                          await db.matches.update(match.id, { [colorField]: color })
                          console.log(`[MatchSetup] Updated local match ${colorField}:`, color)
                        }

                        // Sync to Supabase if match exists
                        if (supabase && match?.seed_key) {
                          const teamKey = isHome ? 'home_team' : 'away_team'
                          const teamName = isHome ? home : away
                          const shortName = isHome ? homeShortName : awayShortName

                          // Update matches table
                          const { data: supabaseMatch } = await supabase
                            .from('matches')
                            .update({
                              [teamKey]: {
                                name: teamName?.trim() || '',
                                short_name: shortName || generateShortName(teamName),
                                color: color
                              }
                            })
                            .eq('external_id', match.seed_key)
                            .select('id')
                            .maybeSingle()

                          if (supabaseMatch) {
                            console.log(`[MatchSetup] Synced ${teamKey} color to Supabase:`, color)
                          }

                          // Also update match_live_state if it exists (for Referee app)
                          if (supabaseMatch?.id) {
                            // Team A = coin toss winner, determine if home is Team A
                            const coinTossTeamA = match.coinTossTeamA || 'home'
                            const homeIsTeamA = coinTossTeamA === 'home'
                            // If changing home color and home is Team A -> update team_a_color
                            // If changing home color and home is Team B -> update team_b_color
                            const liveStateColorKey = (isHome === homeIsTeamA) ? 'team_a_color' : 'team_b_color'

                            await supabase
                              .from('match_live_state')
                              .update({ [liveStateColorKey]: color, updated_at: new Date().toISOString() })
                              .eq('match_id', supabaseMatch.id)
                            console.log(`[MatchSetup] Synced ${liveStateColorKey} to match_live_state:`, color)
                          }
                        }
                      } catch (err) {
                        console.warn('[MatchSetup] Failed to sync team color:', err)
                      }
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '12px 8px',
                      background: isSelected ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                      border: isSelected ? '2px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      minWidth: '60px'
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.background = 'transparent'
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                      }
                    }}
                  >
                    <div className="shirt" style={{ background: color, transform: 'scale(0.8)' }}>
                      <div className="collar" style={{ background: color }} />
                      <div className="number" style={{ color: getContrastColor(color) }}>1</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}

      {noticeModal && (
        <Modal
          title={noticeModal.syncing ? t('matchSetup.modals.syncing') : noticeModal.type === 'success' ? t('matchSetup.modals.success') : t('matchSetup.modals.notice')}
          open={true}
          onClose={() => !noticeModal.syncing && setNoticeModal(null)}
          width={400}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            {noticeModal.syncing && (
              <div style={{ fontSize: '48px', marginBottom: '16px', animation: 'spin 1s linear infinite' }}>⟳</div>
            )}
            {!noticeModal.syncing && noticeModal.type === 'success' && (
              <div style={{ fontSize: '48px', marginBottom: '16px', color: '#22c55e' }}>✓</div>
            )}
            {!noticeModal.syncing && noticeModal.type === 'error' && (
              <div style={{ fontSize: '48px', marginBottom: '16px', color: '#ef4444' }}>✕</div>
            )}
            <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--text)' }}>
              {noticeModal.message}
            </p>
            {!noticeModal.syncing && (
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                <button
                  onClick={() => setNoticeModal(null)}
                  style={{
                    padding: '12px 24px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: noticeModal.type === 'success' ? '#22c55e' : noticeModal.type === 'error' ? '#ef4444' : 'var(--accent)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer'
                  }}
                >
                  OK
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* PDF Import Summary Modal */}
      {importSummaryModal && (
        <Modal
          title={importSummaryModal.team === 'home' ? t('matchSetup.modals.homeTeamImportComplete') : t('matchSetup.modals.awayTeamImportComplete')}
          open={true}
          onClose={() => setImportSummaryModal(null)}
          width={400}
        >
          <div style={{ padding: '20px' }}>
            {/* Success summary */}
            <div style={{
              background: 'rgba(34, 197, 94, 0.1)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
              borderRadius: '8px',
              padding: '16px',
              marginBottom: '16px'
            }}>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#22c55e', marginBottom: '8px' }}>
                {t('matchSetup.modals.playersCount', { count: importSummaryModal.players })}
              </div>
              <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)' }}>
                {t('matchSetup.modals.successfullyImported')}
              </div>
              {importSummaryModal.benchOfficials > 0 && (
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', marginTop: '8px' }}>
                  {importSummaryModal.benchOfficials > 1 ? t('matchSetup.modals.benchOfficialsCountPlural', { count: importSummaryModal.benchOfficials }) : t('matchSetup.modals.benchOfficialsCount', { count: importSummaryModal.benchOfficials })}
                </div>
              )}
            </div>

            {/* Errors if any */}
            {importSummaryModal.errors && importSummaryModal.errors.length > 0 && (
              <div style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '8px',
                padding: '12px',
                marginBottom: '16px'
              }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#ef4444', marginBottom: '8px' }}>
                  {importSummaryModal.errors.length} {importSummaryModal.errors.length > 1 ? t('common.error') + 's' : t('common.error')}
                </div>
                {importSummaryModal.errors.map((err, i) => (
                  <div key={i} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>{err}</div>
                ))}
              </div>
            )}

            {/* Warning */}
            <div style={{
              background: 'rgba(234, 179, 8, 0.1)',
              border: '1px solid rgba(234, 179, 8, 0.3)',
              borderRadius: '8px',
              padding: '12px',
              marginBottom: '20px'
            }}>
              <div style={{ fontSize: '13px', color: '#eab308', fontWeight: 500, marginBottom: '4px' }}>
                {t('matchSetup.modals.reviewImportedData')}
              </div>
              <ul style={{
                fontSize: '12px',
                color: 'rgba(255,255,255,0.7)',
                margin: '8px 0 0 0',
                paddingLeft: '20px',
                lineHeight: '1.6'
              }}>
                <li>{t('matchSetup.modals.reviewAddBenchOfficials')}</li>
                <li>{t('matchSetup.modals.reviewVerifyDob')}</li>
                <li>{t('matchSetup.modals.reviewSetCaptainLibero')}</li>
              </ul>
            </div>

            <button
              onClick={() => setImportSummaryModal(null)}
              style={{
                width: '100%',
                padding: '12px',
                background: 'var(--accent)',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {t('common.ok')}
            </button>
          </div>
        </Modal>
      )}

      {/* Match Created Modal - shows Match ID and all PINs for recovery */}
      {matchCreatedModal && (
        <Modal
          title={t('matchSetup.modals.matchCreated')}
          open={true}
          onClose={() => {
            setMatchCreatedModal(null)
            onOpenCoinToss()
          }}
          width={500}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            {/* Match ID and Game PIN */}
            <div style={{
              background: 'rgba(34, 197, 94, 0.1)',
              border: '2px solid rgba(34, 197, 94, 0.3)',
              borderRadius: '12px',
              padding: '20px',
              marginBottom: '16px'
            }}>
              <div style={{ marginBottom: '16px' }}>
                <span style={{ fontSize: '14px', color: 'rgba(255,255,255,0.6)', display: 'block', marginBottom: '4px' }}>
                  {t('matchSetup.modals.matchId')}
                </span>
                <span style={{
                  fontSize: '24px',
                  fontWeight: 700,
                  fontFamily: 'monospace',
                  color: 'var(--accent)',
                  letterSpacing: '2px'
                }}>
                  {matchCreatedModal.matchId}
                </span>
              </div>
              <div>
                <span style={{ fontSize: '14px', color: 'rgba(255,255,255,0.6)', display: 'block', marginBottom: '4px' }}>
                  {t('matchSetup.gamePin')}
                </span>
                <span style={{
                  fontSize: '28px',
                  fontWeight: 700,
                  fontFamily: 'monospace',
                  color: '#22c55e',
                  letterSpacing: '4px'
                }}>
                  {matchCreatedModal.gamePin}
                </span>
              </div>
            </div>

            {/* Connection PINs */}
            <div style={{
              background: 'rgba(59, 130, 246, 0.1)',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              borderRadius: '12px',
              padding: '16px',
              marginBottom: '20px'
            }}>
              <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'rgba(255,255,255,0.9)' }}>
                {t('matchSetup.modals.connectionPins')}
              </div>
              <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <div style={{ textAlign: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', display: 'block', marginBottom: '4px' }}>
                    {t('matchSetup.refereePinLabel')}
                  </span>
                  <span style={{
                    fontSize: '18px',
                    fontWeight: 700,
                    fontFamily: 'monospace',
                    color: '#f59e0b',
                    letterSpacing: '2px'
                  }}>
                    {matchCreatedModal.refereePin}
                  </span>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', display: 'block', marginBottom: '4px' }}>
                    {t('matchSetup.homeBenchPinLabel')}
                  </span>
                  <span style={{
                    fontSize: '18px',
                    fontWeight: 700,
                    fontFamily: 'monospace',
                    color: '#3b82f6',
                    letterSpacing: '2px'
                  }}>
                    {matchCreatedModal.homeTeamPin}
                  </span>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', display: 'block', marginBottom: '4px' }}>
                    {t('matchSetup.awayBenchPinLabel')}
                  </span>
                  <span style={{
                    fontSize: '18px',
                    fontWeight: 700,
                    fontFamily: 'monospace',
                    color: '#ef4444',
                    letterSpacing: '2px'
                  }}>
                    {matchCreatedModal.awayTeamPin}
                  </span>
                </div>
              </div>
            </div>

            <p style={{
              fontSize: '13px',
              color: 'rgba(255,255,255,0.7)',
              marginBottom: '20px',
              lineHeight: 1.5
            }}>
              {t('matchSetup.modals.saveInfoToRecover')}
            </p>
            <button
              onClick={() => {
                setMatchCreatedModal(null)
                onOpenCoinToss()
              }}
              style={{
                padding: '14px 32px',
                fontSize: '16px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer'
              }}
            >
              {t('matchSetup.modals.continueToCoinToss')}
            </button>
          </div>
        </Modal>
      )}

      {/* Edit PIN Modal */}
      {editPinModal && (
        <Modal
          title={editPinType === 'referee' ? t('matchSetup.modals.editRefereePin') : editPinType === 'benchHome' ? t('matchSetup.modals.editHomeBenchPin') : t('matchSetup.modals.editAwayBenchPin')}
          open={true}
          onClose={() => {
            setEditPinModal(false)
            setPinError('')
            setEditPinType(null)
          }}
          width={400}
        >
          <div style={{ padding: '24px' }}>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 600 }}>
                {t('matchSetup.modals.enterNew6DigitPin')}
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={newPin}
                onChange={(e) => {
                  const value = e.target.value.replace(/\D/g, '')
                  if (value.length <= 6) {
                    setNewPin(value)
                    setPinError('')
                  }
                }}
                placeholder={t('matchSetup.placeholders.pinCode')}
                maxLength={6}
                style={{
                  width: '100%',
                  padding: '12px',
                  fontSize: '20px',
                  fontWeight: 700,
                  textAlign: 'center',
                  letterSpacing: '4px',
                  fontFamily: 'monospace',
                  background: 'var(--bg)',
                  border: pinError ? '2px solid #ef4444' : '2px solid rgba(255,255,255,0.2)',
                  borderRadius: '8px',
                  color: 'var(--text)'
                }}
              />
              {pinError && (
                <p style={{ color: '#ef4444', fontSize: '12px', marginTop: '8px' }}>
                  {pinError}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setEditPinModal(false)
                  setPinError('')
                  setEditPinType(null)
                }}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(255,255,255,0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSavePin}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Save PIN
              </button>
            </div>
          </div>
        </Modal>
      )}

      <SignaturePad
        open={openSignature !== null}
        onClose={() => setOpenSignature(null)}
        onSave={handleSignatureSave}
        title={openSignature === 'home-coach' ? 'Home Coach Signature' :
          openSignature === 'home-captain' ? 'Home Captain Signature' :
            openSignature === 'away-coach' ? 'Away Coach Signature' :
              openSignature === 'away-captain' ? 'Away Captain Signature' : 'Sign'}
      />
    </MatchSetupMainView>
  )
}

// Shared styles for full-width layout (vertically centered by App.jsx)
const setupViewStyle = {
  // No maxWidth restriction - allow content to fill available space
}

function MatchSetupMainView({ children }) {
  return <div className="setup" style={setupViewStyle}>{children}</div>
}

function MatchSetupInfoView({ children }) {
  return <div className="setup" style={setupViewStyle}>{children}</div>
}

function MatchSetupOfficialsView({ children }) {
  return <div className="setup" style={setupViewStyle}>{children}</div>
}

function MatchSetupHomeTeamView({ children }) {
  return <div className="setup" style={setupViewStyle}>{children}</div>
}

function MatchSetupAwayTeamView({ children }) {
  return <div className="setup" style={setupViewStyle}>{children}</div>
}
