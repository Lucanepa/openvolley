import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import SignaturePad from './SignaturePad'
import Modal from './Modal'
import RefereeSelector from './RefereeSelector'
import TeamAutocomplete from './TeamAutocomplete'
import { useTeamHistory } from '../hooks/useTeamHistory'
import mikasaVolleyball from '../mikasa_v200w.png'
import { parseRosterPdf } from '../utils/parseRosterPdf'
import { getWebSocketUrl } from '../utils/backendConfig'

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
function safeParseScheduledAt(scheduledAt) {
  if (!scheduledAt) return { date: '', time: '' }
  try {
    const dateObj = new Date(scheduledAt)
    if (isNaN(dateObj.getTime())) return { date: '', time: '' }
    const date = dateObj.toISOString().split('T')[0]
    const hours = String(dateObj.getHours()).padStart(2, '0')
    const minutes = String(dateObj.getMinutes()).padStart(2, '0')
    return { date, time: `${hours}:${minutes}` }
  } catch {
    return { date: '', time: '' }
  }
}

// Helper to validate and create an ISO string from date and time inputs
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

  const dateObj = new Date(`${date}T${timeToUse}:00`)
  if (isNaN(dateObj.getTime())) {
    throw new Error(`Invalid date/time combination: ${date} ${timeToUse}`)
  }

  return dateObj.toISOString()
}

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
  isExpanded,
  onToggleExpanded,
  onOpenDatabase
}) {
  const displayName = lastName || firstName
    ? `${lastName || ''}${firstName ? ', ' + firstName.charAt(0) + '.' : ''}`
    : 'Not set'

  return (
    <div style={{
      border: '1px solid rgba(255, 255, 255, 0.2)',
      borderRadius: '8px',
      background: 'rgba(15, 23, 42, 0.2)',
      overflow: 'hidden'
    }}>
      <div
        onClick={onToggleExpanded}
        style={{
          padding: '12px 16px',
          background: 'rgba(255, 255, 255, 0.1)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
          <span style={{ fontWeight: 600, fontSize: '14px' }}>{title}</span>
          {!isExpanded && (
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '13px' }}>{displayName}</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {hasDatabase && isExpanded && (
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
              Database
            </button>
          )}
          <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>{isExpanded ? '▲' : '▼'}</span>
        </div>
      </div>
      {isExpanded && (
        <div style={{ padding: '16px' }}>
          <div className="row">
            <div className="field"><label>Last Name</label><input className="w-name capitalize" value={lastName} onChange={e=>setLastName(e.target.value)} /></div>
            <div className="field"><label>First Name</label><input className="w-name capitalize" value={firstName} onChange={e=>setFirstName(e.target.value)} /></div>
            <div className="field"><label>Country</label><input className="w-90" value={country} onChange={e=>setCountry(e.target.value)} /></div>
            <div className="field"><label>Date of birth</label><input className="w-dob" type="date" value={dob ? formatDateToISO(dob) : ''} onChange={e=>setDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
          </div>
        </div>
      )}
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
  isExpanded,
  onToggleExpanded
}) {
  const filledCount = [lineJudge1, lineJudge2, lineJudge3, lineJudge4].filter(Boolean).length
  const displayText = filledCount > 0 ? `${filledCount} set` : 'Not set'

  return (
    <div style={{
      border: '1px solid rgba(255, 255, 255, 0.2)',
      borderRadius: '8px',
      background: 'rgba(15, 23, 42, 0.2)',
      overflow: 'hidden'
    }}>
      <div
        onClick={onToggleExpanded}
        style={{
          padding: '12px 16px',
          background: 'rgba(255, 255, 255, 0.1)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
          <span style={{ fontWeight: 600, fontSize: '14px' }}>Line Judges</span>
          {!isExpanded && (
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '13px' }}>{displayText}</span>
          )}
        </div>
        <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>{isExpanded ? '▲' : '▼'}</span>
      </div>
      {isExpanded && (
        <div style={{ padding: '16px' }}>
          <div className="row">
            <div className="field"><label>Line Judge 1</label><input className="w-name capitalize" value={lineJudge1} onChange={e=>setLineJudge1(e.target.value)} placeholder="Name" /></div>
            <div className="field"><label>Line Judge 2</label><input className="w-name capitalize" value={lineJudge2} onChange={e=>setLineJudge2(e.target.value)} placeholder="Name" /></div>
          </div>
          <div className="row">
            <div className="field"><label>Line Judge 3</label><input className="w-name capitalize" value={lineJudge3} onChange={e=>setLineJudge3(e.target.value)} placeholder="Name" /></div>
            <div className="field"><label>Line Judge 4</label><input className="w-name capitalize" value={lineJudge4} onChange={e=>setLineJudge4(e.target.value)} placeholder="Name" /></div>
          </div>
        </div>
      )}
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

export default function MatchSetup({ onStart, matchId, onReturn, onGoHome, onOpenOptions, onOpenCoinToss, offlineMode = false }) {
  const [home, setHome] = useState('Home')
  // Match created popup state
  const [matchCreatedModal, setMatchCreatedModal] = useState(null) // { matchId, gamePin }
  const [away, setAway] = useState('Away')

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

  // Match info confirmation state - other sections are disabled until confirmed
  const [matchInfoConfirmed, setMatchInfoConfirmed] = useState(false)

  // Check if match info can be confirmed (all required fields filled)
  const canConfirmMatchInfo = Boolean(
    home?.trim() &&
    away?.trim() &&
    !dateError &&
    !timeError
  )

  // Rosters
  const [homeRoster, setHomeRoster] = useState([])
  const [awayRoster, setAwayRoster] = useState([])
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

  // Track which official cards are expanded (all collapsed by default)
  const [expandedOfficials, setExpandedOfficials] = useState({})
  const toggleOfficialExpanded = (key) => {
    setExpandedOfficials(prev => ({ ...prev, [key]: !prev[key] }))
  }

  // Bench
  const BENCH_ROLES = [
    { value: 'Coach', label: 'C', fullLabel: 'Coach' },
    { value: 'Assistant Coach 1', label: 'AC1', fullLabel: 'Assistant Coach 1' },
    { value: 'Assistant Coach 2', label: 'AC2', fullLabel: 'Assistant Coach 2' },
    { value: 'Physiotherapist', label: 'P', fullLabel: 'Physiotherapist' },
    { value: 'Medic', label: 'M', fullLabel: 'Medic' }
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

  // Upload mode toggle state (local or remote)
  const [homeUploadMode, setHomeUploadMode] = useState('local') // 'local' | 'remote'
  const [awayUploadMode, setAwayUploadMode] = useState('local') // 'local' | 'remote'

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

  // Team history for autocomplete (online only)
  const { isOnline: teamHistoryOnline, teamNames, fetchTeamHistory, saveTeamHistory, loading: teamHistoryLoading } = useTeamHistory()
  const [loadingTeamHistory, setLoadingTeamHistory] = useState(false)

  // Handler for when a team is selected from history dropdown
  const handleSelectTeamFromHistory = useCallback(async (team, isHome) => {
    if (!team?.name) return

    setLoadingTeamHistory(true)
    try {
      const history = await fetchTeamHistory(team.name)

      if (isHome) {
        // Set team info
        setHome(team.name)
        if (history.shortName) setHomeShortName(history.shortName)
        if (history.color) setHomeColor(history.color)

        // Set players (UNION of all historical players)
        if (history.players.length > 0) {
          setHomeRoster(history.players.map(p => ({
            number: p.number,
            firstName: p.firstName,
            lastName: p.lastName,
            dob: p.dob || '',
            libero: '',
            isCaptain: false
          })))
        }

        // Set bench officials (latest)
        if (history.officials.length > 0) {
          setBenchHome(history.officials.map(o => ({
            role: o.role,
            firstName: o.firstName,
            lastName: o.lastName,
            dob: o.dob || ''
          })))
        }
      } else {
        // Away team
        setAway(team.name)
        if (history.shortName) setAwayShortName(history.shortName)
        if (history.color) setAwayColor(history.color)

        // Set players
        if (history.players.length > 0) {
          setAwayRoster(history.players.map(p => ({
            number: p.number,
            firstName: p.firstName,
            lastName: p.lastName,
            dob: p.dob || '',
            libero: '',
            isCaptain: false
          })))
        }

        // Set bench officials
        if (history.officials.length > 0) {
          setBenchAway(history.officials.map(o => ({
            role: o.role,
            firstName: o.firstName,
            lastName: o.lastName,
            dob: o.dob || ''
          })))
        }
      }
    } catch (error) {
      console.error('Error loading team history:', error)
    } finally {
      setLoadingTeamHistory(false)
    }
  }, [fetchTeamHistory])

  // Server state
  const [serverRunning, setServerRunning] = useState(false)
  const [serverStatus, setServerStatus] = useState(null)
  const [serverLoading, setServerLoading] = useState(false)
  const [instanceId] = useState(() => `instance-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)

  // Cities in Kanton Zürich
  const citiesZurich = [
    'Zürich', 'Winterthur', 'Uster', 'Dübendorf', 'Dietikon', 'Wetzikon', 'Horgen', 
    'Bülach', 'Kloten', 'Meilen', 'Adliswil', 'Thalwil', 'Küsnacht', 'Opfikon', 
    'Volketswil', 'Schlieren', 'Wallisellen', 'Regensdorf', 'Pfäffikon', 'Illnau-Effretikon',
    'Stäfa', 'Wädenswil', 'Männedorf', 'Rüti', 'Gossau', 'Bassersdorf', 'Richterswil',
    'Wald', 'Affoltern am Albis', 'Dielsdorf', 'Embrach', 'Hinwil', 'Küssnacht', 
    'Oberrieden', 'Uitikon', 'Egg', 'Fällanden', 'Maur', 'Rümlang', 'Zollikon'
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
    bench: benchHome.filter(m => m.firstName || m.lastName || m.dob).length
  }
  const awayCounts = {
    players: awayRoster.length,
    liberos: awayRoster.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length,
    bench: benchAway.filter(m => m.firstName || m.lastName || m.dob).length
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
        
        // Load players only on initial load (when matchId changes, not when match updates)
        // This prevents overwriting user edits when the match object updates from the database
        if (match.homeTeamId) {
          const homePlayers = await db.players.where('teamId').equals(match.homeTeamId).sortBy('number')
          setHomeRoster(homePlayers.map(p => ({
            id: p.id, // Store player ID for updates
            number: p.number,
            firstName: p.firstName || '',
            lastName: p.lastName || p.name || '',
            dob: p.dob || '',
            libero: p.libero || '',
            isCaptain: p.isCaptain || false
          })))
        }
        if (match.awayTeamId) {
          const awayPlayers = await db.players.where('teamId').equals(match.awayTeamId).sortBy('number')
          setAwayRoster(awayPlayers.map(p => ({
            id: p.id, // Store player ID for updates
            number: p.number,
            firstName: p.firstName || '',
            lastName: p.lastName || p.name || '',
            dob: p.dob || '',
            libero: p.libero || '',
            isCaptain: p.isCaptain || false
          })))
        }
        
        // Load referee connection setting (default to disabled if not set)
        setRefereeConnectionEnabled(match.refereeConnectionEnabled === true)

        // Load bench connection settings (default to disabled if not set)
        setHomeTeamConnectionEnabled(match.homeTeamConnectionEnabled === true)
        setAwayTeamConnectionEnabled(match.awayTeamConnectionEnabled === true)

        // Migrate old matches: ensure connection fields are explicitly set to false if undefined
        const connectionUpdates = {}
        if (match.refereeConnectionEnabled === undefined) connectionUpdates.refereeConnectionEnabled = false
        if (match.homeTeamConnectionEnabled === undefined) connectionUpdates.homeTeamConnectionEnabled = false
        if (match.awayTeamConnectionEnabled === undefined) connectionUpdates.awayTeamConnectionEnabled = false
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

        // If match has home and away teams, mark match info as confirmed
        // This handles existing matches that already have teams set
        if (match.homeTeamId && match.awayTeamId && homeTeam && awayTeam) {
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
    setHomeTeamConnectionEnabled(match.homeTeamConnectionEnabled === true)
    setAwayTeamConnectionEnabled(match.awayTeamConnectionEnabled === true)
  }, [matchId, match?.refereeConnectionEnabled, match?.homeTeamConnectionEnabled, match?.awayTeamConnectionEnabled])
  

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
        setNoticeModal({ message: 'Command copied to clipboard! Run "npm run start:prod" in the frontend directory terminal.' })
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
          setNoticeModal({ message: 'Command copied to clipboard! Run "npm run start:prod" in the frontend directory terminal.' })
        } catch (e) {
          setNoticeModal({ message: 'Please run manually in terminal: npm run start:prod' })
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
        setNoticeModal({ message: `Failed to start server: ${result.error}` })
      }
    } catch (error) {
      setNoticeModal({ message: `Error starting server: ${error.message}` })
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
      setNoticeModal({ message: `Error stopping server: ${error.message}` })
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
          if (draft.homeRoster !== undefined) setHomeRoster(draft.homeRoster)
          if (draft.awayRoster !== undefined) setAwayRoster(draft.awayRoster)
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
              setNoticeModal({ message: `Invalid date/time: ${err.message}` })
              return // Don't save with invalid data
            }
            console.warn('[MatchSetup] Auto-save skipping invalid date/time:', err.message)
          }
        }
        
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
          officials: [
            { role: '1st referee', firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: ref1Dob },
            { role: '2nd referee', firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: ref2Dob },
            { role: 'scorer', firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob },
            { role: 'assistant scorer', firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
            ...(lineJudge1 ? [{ role: 'line judge 1', name: lineJudge1 }] : []),
            ...(lineJudge2 ? [{ role: 'line judge 2', name: lineJudge2 }] : []),
            ...(lineJudge3 ? [{ role: 'line judge 3', name: lineJudge3 }] : []),
            ...(lineJudge4 ? [{ role: 'line judge 4', name: lineJudge4 }] : [])
          ],
          bench_home: benchHome,
          bench_away: benchAway
        })

        // Update or create teams
        let homeTeamId = match?.homeTeamId
        let awayTeamId = match?.awayTeamId
        
        if (home && home.trim()) {
          if (homeTeamId) {
            // Update existing team
            await db.teams.update(homeTeamId, { 
              name: home.trim(),
              color: homeColor 
            })
          } else {
            // Create new team if it doesn't exist
            homeTeamId = await db.teams.add({
              name: home.trim(),
              color: homeColor,
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
              color: awayColor 
            })
          } else {
            // Create new team if it doesn't exist
            awayTeamId = await db.teams.add({
              name: away.trim(),
              color: awayColor,
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
        setNoticeModal({ message: 'Error saving data. Please try again.' })
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
      setDateError('Invalid format')
      return
    }
    const [year, month, day] = value.split('-').map(Number)
    if (year < 1900 || year > 2100) {
      setDateError(`Invalid year: ${year}`)
      return
    }
    if (month < 1 || month > 12) {
      setDateError(`Invalid month: ${month}`)
      return
    }
    if (day < 1 || day > 31) {
      setDateError(`Invalid day: ${day}`)
      return
    }
    // Check if date is valid (e.g., Feb 30 is invalid)
    const dateObj = new Date(value)
    if (isNaN(dateObj.getTime()) || dateObj.getMonth() + 1 !== month) {
      setDateError('Invalid date')
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
      setTimeError('Invalid format')
      return
    }
    const [hours, minutes] = value.split(':').map(Number)
    if (hours < 0 || hours > 23) {
      setTimeError(`Invalid hour: ${hours}`)
      return
    }
    if (minutes < 0 || minutes > 59) {
      setTimeError(`Invalid minutes: ${minutes}`)
      return
    }
    setTimeError('')
  }

  // Confirm match info - validates all required fields and creates/updates match
  async function confirmMatchInfo() {
    // Validate required fields
    if (!home || !home.trim()) {
      setNoticeModal({ message: 'Home team name is required' })
      return
    }
    if (!away || !away.trim()) {
      setNoticeModal({ message: 'Away team name is required' })
      return
    }
    if (dateError) {
      setNoticeModal({ message: `Invalid date: ${dateError}` })
      return
    }
    if (timeError) {
      setNoticeModal({ message: `Invalid time: ${timeError}` })
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
          benchStaff: benchHome,
          createdAt: new Date().toISOString()
        })
      } else {
        // Update existing team
        await db.teams.update(homeTeamId, {
          name: home.trim(),
          color: homeColor,
          benchStaff: benchHome
        })
      }
      // Always queue home team for sync (upsert)
      await db.sync_queue.add({
        resource: 'team',
        action: 'insert',
        payload: {
          external_id: String(homeTeamId),
          name: home.trim(),
          short_name: homeShortName || generateShortName(home.trim())
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })

      if (!awayTeamId) {
        awayTeamId = await db.teams.add({
          name: away.trim(),
          color: awayColor,
          benchStaff: benchAway,
          createdAt: new Date().toISOString()
        })
      } else {
        // Update existing team
        await db.teams.update(awayTeamId, {
          name: away.trim(),
          color: awayColor,
          benchStaff: benchAway
        })
      }
      // Always queue away team for sync (upsert)
      await db.sync_queue.add({
        resource: 'team',
        action: 'insert',
        payload: {
          external_id: String(awayTeamId),
          name: away.trim(),
          short_name: awayShortName || generateShortName(away.trim())
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })

      // Build scheduledAt if date is set
      let scheduledAt = null
      if (date) {
        scheduledAt = createScheduledAt(date, time, { allowEmpty: true })
      }

      // Update match with team IDs and match info
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
        game_n: gameN ? parseInt(gameN, 10) : null,
        bench_home: benchHome,
        bench_away: benchAway,
        updatedAt: new Date().toISOString()
      })

      // Queue match for Supabase sync (uses upsert internally)
      const syncJobId = await db.sync_queue.add({
        resource: 'match',
        action: 'insert',
        payload: {
          external_id: String(matchId),
          home_team_id: String(homeTeamId),
          away_team_id: String(awayTeamId),
          status: 'setup',
          hall: hall || null,
          city: city || null,
          league: league || null,
          scheduled_at: scheduledAt || null,
          match_type_1: type1 || null,
          match_type_1_other: type1Other || null,
          championship_type: championshipType || null,
          championship_type_other: championshipTypeOther || null,
          match_type_2: type2 || null,
          match_type_3: type3 || null,
          match_type_3_other: type3Other || null,
          game_n: gameN ? parseInt(gameN, 10) : null,
          test: false
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })

      setMatchInfoConfirmed(true)
      setCurrentView('main')
      setNoticeModal({ message: 'Match info saved! Syncing to database...', type: 'success', syncing: true })

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
              setNoticeModal({ message: 'Match synced to database!', type: 'success' })
            } else if (job.status === 'error') {
              clearInterval(interval)
              setNoticeModal({ message: 'Match saved locally (sync failed - will retry)', type: 'error' })
            } else if (attempts >= maxAttempts) {
              clearInterval(interval)
              setNoticeModal({ message: 'Match saved locally (sync pending)', type: 'success' })
            }
          } catch (err) {
            clearInterval(interval)
          }
        }, 500)
      }
      checkSyncStatus()
    } catch (error) {
      console.error('Error confirming match info:', error)
      setNoticeModal({ message: `Error: ${error.message}`, type: 'error' })
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
      setNoticeModal({ message: `Invalid date: ${dateError}` })
      return
    }
    if (timeError) {
      setNoticeModal({ message: `Invalid time: ${timeError}` })
      return
    }

    // Validate date/time first
    let scheduledAt
    try {
      scheduledAt = createScheduledAt(date, time, { allowEmpty: false })
    } catch (err) {
      setNoticeModal({ message: `Invalid date/time: ${err.message}` })
      return
    }

    // Validate at least one captain per team
    const homeHasCaptain = homeRoster.some(p => p.isCaptain)
    const awayHasCaptain = awayRoster.some(p => p.isCaptain)

    if (!homeHasCaptain) {
      setNoticeModal({ message: 'Home team must have at least one captain.' })
      return
    }

    if (!awayHasCaptain) {
      setNoticeModal({ message: 'Away team must have at least one captain.' })
      return
    }

    // Validate no duplicate player numbers within each team
    const homeDuplicates = homeRoster.filter((p, i) =>
      p.number && homeRoster.findIndex(other => other.number === p.number) !== i
    )
    if (homeDuplicates.length > 0) {
      const dupNumbers = [...new Set(homeDuplicates.map(p => p.number))].join(', ')
      setNoticeModal({
        message: `${home || 'Home'} team has duplicate player numbers: #${dupNumbers}\n\nPlease fix duplicate numbers before proceeding.`
      })
      return
    }

    const awayDuplicates = awayRoster.filter((p, i) =>
      p.number && awayRoster.findIndex(other => other.number === p.number) !== i
    )
    if (awayDuplicates.length > 0) {
      const dupNumbers = [...new Set(awayDuplicates.map(p => p.number))].join(', ')
      setNoticeModal({
        message: `${away || 'Away'} team has duplicate player numbers: #${dupNumbers}\n\nPlease fix duplicate numbers before proceeding.`
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
        message: `Some players have invalid birthdate (01.01.1900):\n\n${badNames}\n\nPlease correct these dates before proceeding.`
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
    const homeId = await db.teams.add({ name: home, color: homeColor, createdAt: new Date().toISOString() })
    const awayId = await db.teams.add({ name: away, color: awayColor, createdAt: new Date().toISOString() })

      // Add teams to sync queue (official match, so test: false)
      await db.sync_queue.add({
        resource: 'team',
        action: 'insert',
        payload: {
          external_id: String(homeId),
          name: home,
          color: homeColor,
          test: false,
          created_at: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })
      await db.sync_queue.add({
        resource: 'team',
        action: 'insert',
        payload: {
          external_id: String(awayId),
          name: away,
          color: awayColor,
          test: false,
          created_at: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })

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
    const matchPin = prompt('Enter a PIN code to protect this match (required):')
    if (!matchPin || matchPin.trim() === '') {
      setNoticeModal({ message: 'Match PIN code is required. Please enter a PIN code to create the match.' })
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
      homeShortName: homeShortName || home.substring(0, 3).toUpperCase(),
      awayShortName: awayShortName || away.substring(0, 3).toUpperCase(),
      game_n: gameN ? Number(gameN) : null,
      league,
      gamePin: generatedGamePin, // Game PIN for official matches (not test matches)
      ...(() => {
        // Generate all three PINs together to ensure uniqueness
        const refPin = generatePinCode([])
        const homePin = generatePinCode([refPin])
        const awayPin = generatePinCode([refPin, homePin])
        return {
          refereePin: String(refPin).trim(), // Ensure string
          homeTeamPin: String(homePin).trim(), // Ensure string
          awayTeamPin: String(awayPin).trim() // Ensure string
        }
      })(),
      matchPin: matchPin.trim(),
      refereeConnectionEnabled: false,
      homeTeamConnectionEnabled: false,
      awayTeamConnectionEnabled: false,
      officials: [
        { role: '1st referee', firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: ref1Dob },
        { role: '2nd referee', firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: ref2Dob },
        { role: 'scorer', firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob },
        { role: 'assistant scorer', firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
        ...(lineJudge1 ? [{ role: 'line judge 1', name: lineJudge1 }] : []),
        ...(lineJudge2 ? [{ role: 'line judge 2', name: lineJudge2 }] : []),
        ...(lineJudge3 ? [{ role: 'line judge 3', name: lineJudge3 }] : []),
        ...(lineJudge4 ? [{ role: 'line judge 4', name: lineJudge4 }] : [])
      ],
      bench_home: benchHome,
      bench_away: benchAway,
      homeCoachSignature: null,
      homeCaptainSignature: null,
      awayCoachSignature: null,
      awayCaptainSignature: null,
      createdAt: new Date().toISOString()
    })

      // Add match to sync queue (official match, so test: false)
      await db.sync_queue.add({
        resource: 'match',
        action: 'insert',
        payload: {
          external_id: String(createdMatchId),
          home_team_id: String(homeId),
          away_team_id: String(awayId),
          status: 'live',
          hall: hall || null,
          city: city || null,
          league: league || null,
          scheduled_at: scheduledAt || null,
          test: false,
          created_at: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })

    if (homeRoster.length) {
        const homePlayerIds = await db.players.bulkAdd(
        homeRoster.map(p => ({
          teamId: homeId,
          number: p.number,
          name: `${p.lastName} ${p.firstName}`,
          lastName: p.lastName,
          firstName: p.firstName,
          dob: p.dob || null,
          libero: p.libero || '',
          isCaptain: !!p.isCaptain,
          role: null,
          createdAt: new Date().toISOString()
        }))
      )
        
        // Add home players to sync queue
        for (let i = 0; i < homeRoster.length; i++) {
          const p = homeRoster[i]
          await db.sync_queue.add({
            resource: 'player',
            action: 'insert',
            payload: {
              external_id: String(homePlayerIds[i]),
              team_id: String(homeId),
              number: p.number,
              name: `${p.lastName} ${p.firstName}`,
              first_name: p.firstName,
              last_name: p.lastName,
              dob: p.dob || null,
              libero: p.libero || null,
              is_captain: !!p.isCaptain,
              role: null,
              created_at: new Date().toISOString()
            },
            ts: new Date().toISOString(),
            status: 'queued'
          })
        }
    }
    if (awayRoster.length) {
        const awayPlayerIds = await db.players.bulkAdd(
        awayRoster.map(p => ({
          teamId: awayId,
          number: p.number,
          name: `${p.lastName} ${p.firstName}`,
          lastName: p.lastName,
          firstName: p.firstName,
          dob: p.dob || null,
          libero: p.libero || '',
          isCaptain: !!p.isCaptain,
          role: null,
          createdAt: new Date().toISOString()
        }))
      )
        
        // Add away players to sync queue (official match, so test: false)
        for (let i = 0; i < awayRoster.length; i++) {
          const p = awayRoster[i]
          await db.sync_queue.add({
            resource: 'player',
            action: 'insert',
            payload: {
              external_id: String(awayPlayerIds[i]),
              team_id: String(awayId),
              number: p.number,
              name: `${p.lastName} ${p.firstName}`,
              first_name: p.firstName,
              last_name: p.lastName,
              dob: p.dob || null,
              libero: p.libero || null,
              is_captain: !!p.isCaptain,
              role: null,
              test: false,
              created_at: new Date().toISOString()
            },
            ts: new Date().toISOString(),
            status: 'queued'
          })
        }
      }
      
    // Don't start match yet - go to coin toss first
    // Check if team names and short names are set
    if (!home || home.trim() === '' || home === 'Home' || !away || away.trim() === '' || away === 'Away') {
      setNoticeModal({ message: 'Please set both team names before proceeding to coin toss.' })
      return
    }

    if (!homeShortName || homeShortName.trim() === '' || !awayShortName || awayShortName.trim() === '') {
      setNoticeModal({ message: 'Please set both team short names before proceeding to coin toss.' })
      return
    }

    // Show match created popup if online (has gamePin)
    if (!offlineMode && generatedGamePin) {
      setMatchCreatedModal({ matchId: createdMatchId, gamePin: generatedGamePin })
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
      setNoticeModal({ message: 'No match data available.' })
      return
    }

    const matchData = await db.matches.get(matchId)
    if (!matchData) {
      setNoticeModal({ message: 'Match not found.' })
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

    // Open scoresheet in new window
    const scoresheetWindow = window.open('/scoresheet', '_blank', 'width=1200,height=900')

    if (!scoresheetWindow) {
      setNoticeModal({ message: 'Please allow popups to view the scoresheet.' })
    }
  }

  async function confirmCoinToss() {

    // Only check signatures for official matches, skip for test matches
    if (!match?.test) {
      if (!homeCoachSignature || !homeCaptainSignature || !awayCoachSignature || !awayCaptainSignature) {
        setNoticeModal({ message: 'Please complete all signatures before confirming the coin toss.' })
        return
      }
    }

    if (!matchId) {
      console.error('[COIN TOSS] No match ID available')
      setNoticeModal({ message: 'Error: No match ID found. Please try again.' })
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
      coinTossServeB: serveB // true or false
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
    
    // Add match update to sync queue (only sync fields that exist in Supabase)
    const updatedMatch = await db.matches.get(matchId)
    if (updatedMatch) {
      await db.sync_queue.add({
        resource: 'match',
        action: 'update',
        payload: {
          id: String(matchId),
          status: updatedMatch.status || null,
          hall: updatedMatch.hall || null,
          city: updatedMatch.city || null,
          league: updatedMatch.league || null,
          scheduled_at: updatedMatch.scheduledAt || null
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
              isCaptain: !!p.isCaptain
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
              isCaptain: !!p.isCaptain
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

    // Only sync official matches (not test matches)
    if (!isTest) {
      await db.sync_queue.add({
        resource: 'set',
        action: 'insert',
        payload: {
          external_id: String(firstSetId),
          match_id: String(matchId),
          index: 1,
          home_points: 0,
          away_points: 0,
          finished: false,
          start_time: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })
    }
    
    // Update match status to 'live' to indicate match has started
    await db.matches.update(matchId, { status: 'live' })
    
    // Ensure all roster updates are committed before navigating
    // Force a small delay to ensure database updates are fully committed
    await new Promise(resolve => setTimeout(resolve, 100))

    // Save team history to Supabase for future autocomplete (official matches only)
    if (!match?.test && teamHistoryOnline) {
      try {
        // Save home team history
        if (home && home.trim() && homeRoster.length > 0) {
          await saveTeamHistory(
            home.trim(),
            homeShortName || null,
            homeColor || null,
            homeRoster,
            benchHome,
            matchId
          )
        }

        // Save away team history
        if (away && away.trim() && awayRoster.length > 0) {
          await saveTeamHistory(
            away.trim(),
            awayShortName || null,
            awayColor || null,
            awayRoster,
            benchAway,
            matchId
          )
        }
      } catch (historyError) {
        // Don't block match start if history save fails
        console.error('Error saving team history:', historyError)
      }
    }

    // Sync to server immediately so referee/bench dashboards receive data before Scoreboard mounts
    const finalMatchData = await db.matches.get(matchId)
    if (finalMatchData) {
      await syncMatchToServer(finalMatchData, true) // Full sync with teams, players, sets, events
    }

    // Start the match - directly navigate to scoreboard
    // onStart (continueMatch) will now allow test matches when status is 'live' and coin toss is confirmed
    onStart(matchId)
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
        isCaptain: false
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
        isCaptain: false
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
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={() => { restoreMatchInfo(); setCurrentView('main') }}>← Back</button>
          <h2>Match info</h2>
          <div style={{ width: 80 }}></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px' }}>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Date & Time</h3>
            <div className="field">
              <label>Date</label>
              <input
                className="w-dob"
                type="date"
                value={date}
                onChange={e => handleDateChange(e.target.value)}
                style={dateError ? { borderColor: '#ef4444', boxShadow: '0 0 0 1px #ef4444' } : {}}
              />
              {dateError && <span style={{ color: '#ef4444', fontSize: '12px', marginLeft: '8px' }}>{dateError}</span>}
            </div>
            <div className="field">
              <label>Time</label>
              <input
                className="w-90"
                type="time"
                value={time}
                onChange={e => handleTimeChange(e.target.value)}
                style={timeError ? { borderColor: '#ef4444', boxShadow: '0 0 0 1px #ef4444' } : {}}
              />
              {timeError && <span style={{ color: '#ef4444', fontSize: '12px', marginLeft: '8px' }}>{timeError}</span>}
            </div>
          </div>
          
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Location</h3>
            <div className="field">
              <label>City</label>
              <input 
                className="w-120 capitalize" 
                value={city} 
                onChange={e=>setCity(e.target.value)}
                list="cities-zurich"
                placeholder="Enter city"
              />
              <datalist id="cities-zurich">
                {citiesZurich.map(c => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div className="field"><label>Hall</label><input className="w-200 capitalize" value={hall} onChange={e=>setHall(e.target.value)} /></div>
          </div>
          
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Match Type</h3>
            <div className="field">
              <label>Match Type</label>
              <select className="w-120" value={type1} onChange={e=>setType1(e.target.value)}>
                <option value="championship">Championship</option>
                <option value="cup">Cup</option>
                <option value="friendly">Friendly</option>
                <option value="tournament">Tournament</option>
                <option value="other">Other</option>
              </select>
            </div>
            {type1 === 'other' && (
              <div className="field">
                <label>Specify</label>
                <input className="w-120" value={type1Other} onChange={e=>setType1Other(e.target.value)} placeholder="Other type" />
              </div>
            )}
            <div className="field">
              <label>Championship Type</label>
              <select className="w-140" value={championshipType} onChange={e=>setChampionshipType(e.target.value)}>
                <option value="regional">Regional</option>
                <option value="national">National</option>
                <option value="international">International</option>
                <option value="other">Other</option>
              </select>
            </div>
            {championshipType === 'other' && (
              <div className="field">
                <label>Specify</label>
                <input className="w-120" value={championshipTypeOther} onChange={e=>setChampionshipTypeOther(e.target.value)} placeholder="Other type" />
              </div>
            )}
          </div>
          
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Category & Level</h3>
            <div className="field">
              <label>Match Category</label>
              <select className="w-120" value={type2} onChange={e=>setType2(e.target.value)}>
                <option value="men">Men</option>
                <option value="women">Women</option>
              </select>
            </div>
            <div className="field">
              <label>Match Level</label>
              <select className="w-90" value={type3} onChange={e=>setType3(e.target.value)}>
                <option value="senior">Senior</option>
                <option value="U23">U23</option>
                <option value="U21">U21</option>
                <option value="U19">U19</option>
                <option value="U17">U17</option>
                <option value="other">Other</option>
              </select>
            </div>
            {type3 === 'other' && (
              <div className="field">
                <label>Specify</label>
                <input className="w-120" value={type3Other} onChange={e=>setType3Other(e.target.value)} placeholder="Other level" />
              </div>
            )}
          </div>
          
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Game Details</h3>
            <div className="field"><label>Game #</label><input className="w-80" type="number" inputMode="numeric" value={gameN} onChange={e=>setGameN(e.target.value)} /></div>
            <div className="field"><label>League</label><input className="w-80 capitalize" value={league} onChange={e=>setLeague(e.target.value)} /></div>
          </div>

          {/* Teams Card - Full width row at bottom */}
          <div className="card" style={{ gridColumn: 'span 5' }}>
            <h2 style={{ marginTop: 0, marginBottom: 24, textAlign: 'center', fontSize: '24px', fontWeight: 700 }}>TEAMS</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
              {/* Home Team */}
              <div style={{ flex: 1 }}>
                <div style={{ textAlign: 'center', marginBottom: 16, fontSize: '20px', fontWeight: 700, color: 'var(--text)' }}>Home Team</div>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
                  <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                    <label>Team name</label>
                    <input
                      type="text"
                      value={home}
                      onChange={e => setHome(e.target.value)}
                      placeholder="Home team name"
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Short</label>
                    <input
                      type="text"
                      value={homeShortName}
                      onChange={e => setHomeShortName(e.target.value.toUpperCase())}
                      maxLength={8}
                      placeholder={home ? generateShortName(home) : 'HOME'}
                      style={{ width: '80px', textAlign: 'center' }}
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
                  color: 'rgba(255, 255, 255, 0.5)'
                }}>VS</span>
              </div>

              {/* Away Team */}
              <div style={{ flex: 1 }}>
                <div style={{ textAlign: 'center', marginBottom: 16, fontSize: '20px', fontWeight: 700, color: 'var(--text)' }}>Away Team</div>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
                  <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                    <label>Team name</label>
                    <input
                      type="text"
                      value={away}
                      onChange={e => setAway(e.target.value)}
                      placeholder="Away team name"
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Short</label>
                    <input
                      type="text"
                      value={awayShortName}
                      onChange={e => setAwayShortName(e.target.value.toUpperCase())}
                      maxLength={8}
                      placeholder={away ? generateShortName(away) : 'AWAY'}
                      style={{ width: '80px', textAlign: 'center' }}
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
              onClick={() => {
                const blob = new Blob([match.gamePin], { type: 'text/plain' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `game-pin-${match.gamePin}.txt`
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                URL.revokeObjectURL(url)
              }}
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
                cursor: 'pointer',
                transition: 'background 0.2s ease'
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'}
            >
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '4px' }}>Game PIN</div>
              <div>{match.gamePin}</div>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
                Auto-generated PIN to open this match in a new session
              </div>
              <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: '6px', fontStyle: 'italic' }}>
                Click to save as .txt
              </div>
            </div>
          </div>
        )}
        <div style={{ display:'flex', justifyContent:'flex-end', marginTop:16 }}>
          <button
            onClick={confirmMatchInfo}
            disabled={!canConfirmMatchInfo}
            title={!canConfirmMatchInfo ? 'Fill in Home and Away team names to confirm' : ''}
          >
            Confirm
          </button>
        </div>
      </MatchSetupInfoView>
    )
  }

  if (currentView === 'officials') {
    return (
      <MatchSetupOfficialsView>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16}}>
          <button className="secondary" onClick={() => { restoreOfficials(); setCurrentView('main') }}>← Back</button>
          <h2 style={{ marginLeft: 20, marginRight: 20 }}>Match officials</h2>
          <div style={{ width: 80 }}></div>
        </div>

        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          <OfficialCard
            title="1st Referee"
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
            isExpanded={expandedOfficials['ref1']}
            onToggleExpanded={() => toggleOfficialExpanded('ref1')}
            onOpenDatabase={handleOpenDatabase}
          />
          <OfficialCard
            title="2nd Referee"
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
            isExpanded={expandedOfficials['ref2']}
            onToggleExpanded={() => toggleOfficialExpanded('ref2')}
            onOpenDatabase={handleOpenDatabase}
          />
          <OfficialCard
            title="Scorer"
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
            isExpanded={expandedOfficials['scorer']}
            onToggleExpanded={() => toggleOfficialExpanded('scorer')}
            onOpenDatabase={handleOpenDatabase}
          />
          <OfficialCard
            title="Assistant Scorer"
            officialKey="asst"
            lastName={asstLast}
            firstName={asstFirst}
            country={asstCountry}
            dob={asstDob}
            setLastName={setAsstLast}
            setFirstName={setAsstFirst}
            setCountry={setAsstCountry}
            setDob={setAsstDob}
            isExpanded={expandedOfficials['asst']}
            onToggleExpanded={() => toggleOfficialExpanded('asst')}
            onOpenDatabase={handleOpenDatabase}
          />
          <LineJudgesCard
            lineJudge1={lineJudge1}
            lineJudge2={lineJudge2}
            lineJudge3={lineJudge3}
            lineJudge4={lineJudge4}
            setLineJudge1={setLineJudge1}
            setLineJudge2={setLineJudge2}
            setLineJudge3={setLineJudge3}
            setLineJudge4={setLineJudge4}
            isExpanded={expandedOfficials['lineJudges']}
            onToggleExpanded={() => toggleOfficialExpanded('lineJudges')}
          />
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

        <div style={{ display:'flex', justifyContent:'flex-end', marginTop:16 }}>
          <button onClick={async () => {
            // Save officials to database if matchId exists
            if (matchId) {
              await db.matches.update(matchId, {
                officials: [
                  { role: '1st referee', firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: ref1Dob },
                  { role: '2nd referee', firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: ref2Dob },
                  { role: 'scorer', firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob },
                  { role: 'assistant scorer', firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
                  ...(lineJudge1 ? [{ role: 'line judge 1', name: lineJudge1 }] : []),
                  ...(lineJudge2 ? [{ role: 'line judge 2', name: lineJudge2 }] : []),
                  ...(lineJudge3 ? [{ role: 'line judge 3', name: lineJudge3 }] : []),
                  ...(lineJudge4 ? [{ role: 'line judge 4', name: lineJudge4 }] : [])
                ]
              })

              // Sync referees to Supabase
              if (ref1First && ref1Last) {
                await db.sync_queue.add({
                  resource: 'referee',
                  action: 'insert',
                  payload: {
                    seed_key: `${ref1First.toLowerCase()}_${ref1Last.toLowerCase()}`,
                    first_name: ref1First,
                    last_name: ref1Last,
                    country: ref1Country || null,
                    dob: formatDobForSync(ref1Dob)
                  },
                  ts: new Date().toISOString(),
                  status: 'queued'
                })
              }
              if (ref2First && ref2Last) {
                await db.sync_queue.add({
                  resource: 'referee',
                  action: 'insert',
                  payload: {
                    seed_key: `${ref2First.toLowerCase()}_${ref2Last.toLowerCase()}`,
                    first_name: ref2First,
                    last_name: ref2Last,
                    country: ref2Country || null,
                    dob: formatDobForSync(ref2Dob)
                  },
                  ts: new Date().toISOString(),
                  status: 'queued'
                })
              }

              // Sync scorers to Supabase
              if (scorerFirst && scorerLast) {
                await db.sync_queue.add({
                  resource: 'scorer',
                  action: 'insert',
                  payload: {
                    seed_key: `${scorerFirst.toLowerCase()}_${scorerLast.toLowerCase()}`,
                    first_name: scorerFirst,
                    last_name: scorerLast,
                    country: scorerCountry || null,
                    dob: formatDobForSync(scorerDob)
                  },
                  ts: new Date().toISOString(),
                  status: 'queued'
                })
              }
              if (asstFirst && asstLast) {
                await db.sync_queue.add({
                  resource: 'scorer',
                  action: 'insert',
                  payload: {
                    seed_key: `${asstFirst.toLowerCase()}_${asstLast.toLowerCase()}`,
                    first_name: asstFirst,
                    last_name: asstLast,
                    country: asstCountry || null,
                    dob: formatDobForSync(asstDob)
                  },
                  ts: new Date().toISOString(),
                  status: 'queued'
                })
              }

              setNoticeModal({ message: 'Officials saved! Syncing to database...', type: 'success', syncing: true })

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
                      setNoticeModal({ message: 'Officials synced to database!', type: 'success' })
                    } else if (attempts >= maxAttempts) {
                      clearInterval(interval)
                      setNoticeModal({ message: 'Officials saved locally (sync pending)', type: 'success' })
                    }
                  } catch (err) {
                    clearInterval(interval)
                  }
                }, 500)
              }
              checkSyncStatus()
            }
            setCurrentView('main')
          }}>Confirm</button>
        </div>
      </MatchSetupOfficialsView>
    )
  }

  if (currentView === 'home') {
    return (
      <MatchSetupHomeTeamView>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={() => { restoreHomeTeam(); setCurrentView('main') }}>← Back</button>
          <h2>Home team</h2>
          <div style={{ width: 80 }}></div>
        </div>
        <h1 style={{ margin: 0, marginBottom: '12px' }}>Roster</h1>
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
                  type="button"
                  className="secondary"
                  onClick={() => homeFileInputRef.current?.click()}
                  disabled={homePdfLoading || homeUploadMode !== 'local'}
                  style={{
                    padding: '8px 16px',
                    fontSize: '14px',
                    flex: 1,
                    opacity: homeUploadMode !== 'local' ? 0.5 : 1
                  }}
                >
                  Upload PDF
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
                    Local
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
                    Remote
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
                    {homePdfLoading ? 'Importing...' : 'Import PDF'}
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
                  <span style={{ fontSize: '12px', fontWeight: 600 }}>Game #:</span>
                  <span style={{ fontSize: '14px', fontFamily: 'monospace', fontWeight: 600, color: 'var(--text)' }}>
                    {match?.game_n || match?.gameNumber || gameN || 'N/A'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600 }}>Upload PIN:</span>
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
                        Regenerate
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
                      Generate PIN
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
                  <h4 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px', fontWeight: 600 }}>Roster uploaded</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                    <div style={{ fontSize: '12px' }}>
                      Players: {match.pendingHomeRoster.players?.length || 0}
                    </div>
                    <div style={{ fontSize: '12px' }}>
                      Bench Officials: {match.pendingHomeRoster.bench?.length || 0}
                    </div>
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
                        
                        // Update state
                        setHomeRoster(importedPlayers)
                        setBenchHome(importedBench)
                        
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
                                role: null,
                                createdAt: new Date().toISOString()
                              }))
                            )
                          }
                          
                          // Update match with bench officials
                          await db.matches.update(matchId, {
                            bench_home: importedBench,
                            pendingHomeRoster: null
                          })
                        } else {
                          // If no teamId yet, just clear pending
                          await db.matches.update(matchId, { pendingHomeRoster: null })
                        }
                      }}
                      style={{ padding: '8px 16px', fontSize: '12px', background: '#22c55e', color: '#000', flex: 1 }}
                    >
                      Accept
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
                      Reject
                    </button>
                  </div>
                </div>
              )}
              </div>
              )}
            </div>
          </div>
          {/* Right: Player Stats */}
          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.2)',
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'rgba(255, 255, 255, 0.7)' }}>Players:</span>
              <span style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)' }}>{homeRoster.length}</span>
              <span style={{ fontSize: '16px', color: 'rgba(255, 255, 255, 0.5)' }}>
                ({homeRoster.filter(p => !p.libero).length} + {homeRoster.filter(p => p.libero).length} libero{homeRoster.filter(p => p.libero).length !== 1 ? 's' : ''})
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'rgba(255, 255, 255, 0.7)' }}>Captain:</span>
              {(() => {
                const captain = homeRoster.find(p => p.isCaptain)
                return captain ? (
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
                  }}>{captain.number || '?'}</span>
                ) : (
                  <span style={{ fontSize: '14px', fontStyle: 'italic', color: 'rgba(255, 255, 255, 0.5)' }}>—</span>
                )
              })()}
            </div>
          </div>
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
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: 8 }}>Add new player:</div>
            <div className="row" style={{ width: '100%', maxWidth: '100%', overflow: 'hidden' }}>

              <input className="w-num" placeholder="#" type="number" inputMode="numeric" value={homeNum} onChange={e=>setHomeNum(e.target.value)} />
              <input className="w-name capitalize" placeholder="Last Name" value={homeLast} onChange={e=>setHomeLast(e.target.value)} />
              <input className="w-name capitalize" placeholder="First Name" value={homeFirst} onChange={e=>setHomeFirst(e.target.value)} />
              <input className="w-dob" placeholder="Date of birth (dd/mm/yyyy)" type="date" value={homeDob ? formatDateToISO(homeDob) : ''} onChange={e=>setHomeDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} />
              <select className="w-90" value={homeLibero} onChange={e => {
                let newValue = e.target.value
                // If L2 is selected but no L1 exists, automatically change L2 to L1
                if (newValue === 'libero2' && !homeRoster.some(p => p.libero === 'libero1')) {
                  newValue = 'libero1'
                }
                setHomeLibero(newValue)
              }}>
                <option value=""></option>
                {!homeRoster.some(p => p.libero === 'libero1') && (
                <option value="libero1">Libero 1</option>
                )}
                {!homeRoster.some(p => p.libero === 'libero2') && (
                <option value="libero2">Libero 2</option>
                )}
              </select>
              <label className="inline"><input type="radio" name="homeCaptain" checked={homeCaptain} onChange={()=>setHomeCaptain(true)} /> Captain</label>
              <button type="button" className="secondary" onClick={() => {
                if (!homeLast || !homeFirst) return
                const newPlayer = { number: homeNum ? Number(homeNum) : null, lastName: homeLast, firstName: homeFirst, dob: homeDob, libero: homeLibero, isCaptain: homeCaptain }
                setHomeRoster(list => {
                  const cleared = homeCaptain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                  const next = [...cleared, newPlayer].sort((a,b) => {
                    const an = a.number ?? 999
                    const bn = b.number ?? 999
                    return an - bn
                  })
                  return next
                })
                setHomeNum(''); setHomeFirst(''); setHomeLast(''); setHomeDob(''); setHomeLibero(''); setHomeCaptain(false)
              }}>Add</button>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Roster Header Row */}
          <div className="row" style={{ alignItems: 'center', fontWeight: 600, fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)', marginBottom: 4, padding: '6px 8px', border: '2px solid transparent' }}>
            <div className="w-num" style={{ textAlign: 'center' }}>#</div>
            <div className="w-name">Last Name</div>
            <div className="w-name">First Name</div>
            <div className="w-dob">Date of Birth</div>
            <div className="w-90" style={{ textAlign: 'center' }}>Role</div>
            <div style={{ width: '70px', textAlign: 'center' }}>Captain</div>
            <div style={{ width: '80px' }}></div>
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
                title={isDuplicate ? 'Duplicate jersey number!' : undefined}
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
                placeholder="Last Name"
                value={p.lastName || ''}
                onChange={e => {
                  const updated = [...homeRoster]
                  updated[i] = { ...updated[i], lastName: e.target.value }
                  setHomeRoster(updated)
                }}
              />
              <input 
                className="w-name capitalize" 
                placeholder="First Name" 
                value={p.firstName || ''} 
                onChange={e => {
                  const updated = [...homeRoster]
                  updated[i] = { ...updated[i], firstName: e.target.value }
                  setHomeRoster(updated)
                }} 
              />
              <input 
                className="w-dob" 
                placeholder="Date of birth (dd/mm/yyyy)" 
                type="date" 
                value={p.dob ? formatDateToISO(p.dob) : ''} 
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
                  <option value="libero1">Libero 1</option>
                )}
                {!homeRoster.some((player, idx) => idx !== i && player.libero === 'libero2') && (
                  <option value="libero2">Libero 2</option>
                )}
              </select>
              <label className="inline">
                <input 
                  type="radio" 
                  name="homeCaptain" 
                  checked={p.isCaptain || false} 
                  onChange={() => {
                    const updated = homeRoster.map((player, idx) => ({
                      ...player,
                      isCaptain: idx === i
                    }))
                    setHomeRoster(updated)
                  }} 
                /> 
                Captain
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() => setHomeRoster(list => list.filter((_, idx) => idx !== i))}
              >
                Remove
              </button>
            </div>
          )})}
          </div>
        <h4>Bench — Home</h4>
        {/* Bench Header Row */}
        <div className="row" style={{ alignItems: 'center', fontWeight: 600, fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)', marginBottom: 4, padding: '6px 8px', border: '2px solid transparent' }}>
          <div className="w-220">Role</div>
          <div className="w-name">Last Name</div>
          <div className="w-name">First Name</div>
          <div className="w-dob">Date of Birth</div>
          <div style={{ width: '70px' }}></div>
        </div>
        {sortBenchByHierarchy(benchHome).map((m, i) => {
          const originalIdx = benchHome.findIndex(b => b === m)
          return (
            <div key={`bh-${originalIdx}`} className="row bench-row" style={{ alignItems:'center', padding: '6px 8px', border: '2px solid transparent', borderRadius: '6px' }}>
              <select className="w-220" value={m.role || 'Coach'} onChange={e=>{
                const newRole = e.target.value || 'Coach'
                // Check if this role is already taken by another official
                const isRoleTaken = benchHome.some((b, idx) => idx !== originalIdx && b.role === newRole)
                if (isRoleTaken) {
                  // Don't allow duplicate roles
                  return
                }
                setBenchHome(arr => { 
                  const a=[...arr]; 
                  a[originalIdx]={...a[originalIdx], role:newRole}; 
                  return a 
                })
              }}>
                                {BENCH_ROLES.map(role => {
                                  const isRoleTaken = benchHome.some((b, idx) => idx !== originalIdx && b.role === role.value)
                                  return (
                                    <option key={role.value} value={role.value} disabled={isRoleTaken}>
                                      {role.label} - {role.fullLabel}{isRoleTaken ? ' (already assigned)' : ''}
                                    </option>
                                  )
                                })}
              </select>
              <input className="w-name capitalize" placeholder="Last Name" value={m.lastName} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[originalIdx]={...a[originalIdx], lastName:e.target.value}; return a })} />
              <input className="w-name capitalize" placeholder="First Name" value={m.firstName} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[originalIdx]={...a[originalIdx], firstName:e.target.value}; return a })} />
              <input className="w-dob" placeholder="Date of birth (dd/mm/yyyy)" type="date" value={m.dob ? formatDateToISO(m.dob) : ''} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[originalIdx]={...a[originalIdx], dob:e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''}; return a })} />
              <button type="button" className="secondary" onClick={() => {
                const updated = benchHome.filter((_, idx) => idx !== originalIdx)
                setBenchHome(updated)
                // Trigger save immediately
                setTimeout(() => saveDraft(true), 100)
              }} style={{ padding: '4px 8px', fontSize: '12px' }}>
                Remove
              </button>
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
              Add Bench Official
            </button>
        </div>
        <div style={{ display:'flex', justifyContent:'flex-end', marginTop:16 }}>
          <button onClick={async () => {
            console.log('[MatchSetup] Home roster Confirm clicked, validating...')

            // Validate roster before saving
            const validationErrors = []

            // 1. Check at least 6 non-libero players with numbers
            const nonLiberoWithNumbers = homeRoster.filter(p => !p.libero && p.number != null && p.number !== '')
            console.log('[MatchSetup] Home non-libero players with numbers:', nonLiberoWithNumbers.length)
            if (nonLiberoWithNumbers.length < 6) {
              validationErrors.push(`Need at least 6 players with numbers (not liberos). Currently: ${nonLiberoWithNumbers.length}`)
            }

            // 2. Check captain is set
            const hasCaptain = homeRoster.some(p => p.isCaptain)
            console.log('[MatchSetup] Home has captain:', hasCaptain)
            if (!hasCaptain) {
              validationErrors.push('No captain selected')
            }

            // 3. Check coach is set
            const hasCoach = benchHome.some(b => b.role === 'Coach' && (b.lastName || b.firstName))
            console.log('[MatchSetup] Home has coach:', hasCoach)
            if (!hasCoach) {
              validationErrors.push('No coach set')
            }

            // 4. Check for duplicate numbers
            const numbers = homeRoster.filter(p => p.number != null && p.number !== '').map(p => p.number)
            const duplicateNumbers = numbers.filter((num, idx) => numbers.indexOf(num) !== idx)
            if (duplicateNumbers.length > 0) {
              console.log('[MatchSetup] Home duplicate numbers:', duplicateNumbers)
              validationErrors.push(`Duplicate jersey numbers: ${[...new Set(duplicateNumbers)].join(', ')}`)
            }

            // 5. Check for invalid numbers (must be 1-99)
            const invalidNumbers = homeRoster.filter(p => p.number != null && (p.number < 1 || p.number > 99))
            if (invalidNumbers.length > 0) {
              console.log('[MatchSetup] Home invalid numbers:', invalidNumbers.map(p => p.number))
              validationErrors.push(`Invalid jersey numbers (must be 1-99): ${invalidNumbers.map(p => p.number).join(', ')}`)
            }

            // 6. Check for players without numbers
            const noNumbers = homeRoster.filter(p => p.number == null || p.number === '')
            if (noNumbers.length > 0) {
              console.log('[MatchSetup] Home players without numbers:', noNumbers.length)
              validationErrors.push(`${noNumbers.length} player(s) without jersey numbers`)
            }

            // Show validation errors if any
            if (validationErrors.length > 0) {
              console.log('[MatchSetup] Home roster validation errors:', validationErrors)
              setNoticeModal({ message: `Please fix the following issues:\n\n• ${validationErrors.join('\n• ')}` })
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
                      isCaptain: !!rosterPlayer.isCaptain
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
              
              // Update match with short name and restore signatures (re-lock)
              const updateData = {
                homeShortName: homeShortName || home.substring(0, 3).toUpperCase()
              }
              
              // Restore signatures if they were previously saved (re-lock the team)
              if (!homeCoachSignature && savedSignatures.homeCoach) {
                updateData.homeCoachSignature = savedSignatures.homeCoach
                setHomeCoachSignature(savedSignatures.homeCoach)
              }
              if (!homeCaptainSignature && savedSignatures.homeCaptain) {
                updateData.homeCaptainSignature = savedSignatures.homeCaptain
                setHomeCaptainSignature(savedSignatures.homeCaptain)
              }
              
              await db.matches.update(matchId, updateData)

              // Sync team to Supabase
              await db.sync_queue.add({
                resource: 'team',
                action: 'insert',
                payload: {
                  external_id: String(match.homeTeamId),
                  name: home?.trim() || '',
                  short_name: homeShortName || generateShortName(home)
                },
                ts: new Date().toISOString(),
                status: 'queued'
              })

              // Sync players to Supabase
              for (const player of homeRoster) {
                if (player.firstName || player.lastName) {
                  await db.sync_queue.add({
                    resource: 'player',
                    action: 'insert',
                    payload: {
                      external_id: `${match.homeTeamId}_${player.number || 'bench'}_${player.firstName}_${player.lastName}`,
                      team_id: String(match.homeTeamId),
                      number: player.number || null,
                      first_name: player.firstName || '',
                      last_name: player.lastName || '',
                      dob: formatDobForSync(player.dob),
                      is_captain: !!player.isCaptain,
                      libero: player.libero || null
                    },
                    ts: new Date().toISOString(),
                    status: 'queued'
                  })
                }
              }

              // Sync team officials (bench staff) to Supabase
              for (const official of benchHome) {
                if (official.firstName || official.lastName) {
                  await db.sync_queue.add({
                    resource: 'team_official',
                    action: 'insert',
                    payload: {
                      external_id: `${match.homeTeamId}_${official.role}_${official.firstName}_${official.lastName}`,
                      team_id: String(match.homeTeamId),
                      role: official.role || '',
                      first_name: official.firstName || '',
                      last_name: official.lastName || '',
                      country: official.country || null,
                      dob: formatDobForSync(official.dob)
                    },
                    ts: new Date().toISOString(),
                    status: 'queued'
                  })
                }
              }

              setNoticeModal({ message: 'Home team saved! Syncing to database...', type: 'success', syncing: true })

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
                      setNoticeModal({ message: 'Home team synced to database!', type: 'success' })
                    } else if (attempts >= maxAttempts) {
                      clearInterval(interval)
                      setNoticeModal({ message: 'Home team saved locally (sync pending)', type: 'success' })
                    }
                  } catch (err) {
                    clearInterval(interval)
                  }
                }, 500)
              }
              checkSyncStatus()
            }
            setCurrentView('main')
          }}>Confirm</button>
        </div>
        {/* PDF Import Summary Modal - shown immediately after import */}
        {importSummaryModal && importSummaryModal.team === 'home' && (
          <Modal
            title="Home Team Import Complete"
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
                  {importSummaryModal.players} Players
                </div>
                <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)' }}>
                  Successfully imported
                </div>
                {importSummaryModal.benchOfficials > 0 && (
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', marginTop: '8px' }}>
                    + {importSummaryModal.benchOfficials} bench official{importSummaryModal.benchOfficials > 1 ? 's' : ''}
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
                  Please review the imported data:
                </div>
                <ul style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', margin: '8px 0 0 0', paddingLeft: '20px', lineHeight: '1.6' }}>
                  <li>Add any missing bench officials (Doctor, Physio, etc.)</li>
                  <li>Verify dates of birth are correct</li>
                  <li>Set captain and libero designations</li>
                </ul>
              </div>
              <button
                onClick={() => setImportSummaryModal(null)}
                style={{ width: '100%', padding: '12px', background: 'var(--accent)', border: 'none', borderRadius: '8px', color: '#000', fontWeight: 600, cursor: 'pointer' }}
              >
                OK
              </button>
            </div>
          </Modal>
        )}
        {/* Notice Modal - must be rendered in this view since early return prevents main render */}
        {noticeModal && (
          <Modal
            title={noticeModal.syncing ? 'Syncing' : noticeModal.type === 'success' ? 'Success' : 'Notice'}
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
      </MatchSetupHomeTeamView>
    )
  }

  if (currentView === 'away') {
    return (
      <MatchSetupAwayTeamView>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={() => { restoreAwayTeam(); setCurrentView('main') }}>← Back</button>
          <h2>Away team</h2>
          <div style={{ width: 80 }}></div>
        </div>
        <h1 style={{ margin: 0, marginBottom: '12px' }}>Roster</h1>
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
                  onClick={() => awayFileInputRef.current?.click()}
                  disabled={awayPdfLoading || awayUploadMode !== 'local'}
                  style={{
                    padding: '8px 16px',
                    fontSize: '14px',
                    flex: 1,
                    opacity: awayUploadMode !== 'local' ? 0.5 : 1
                  }}
                >
                  Upload PDF
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
                    Local
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
                    Remote
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
                    {awayPdfLoading ? 'Importing...' : 'Import PDF'}
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
                  <span style={{ fontSize: '12px', fontWeight: 600 }}>Game #:</span>
                  <span style={{ fontSize: '14px', fontFamily: 'monospace', fontWeight: 600, color: 'var(--text)' }}>
                    {match?.game_n || match?.gameNumber || gameN || 'N/A'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600 }}>Upload PIN:</span>
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
                        Regenerate
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
                      Generate PIN
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
                  <h4 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px', fontWeight: 600 }}>Roster uploaded</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                    <div style={{ fontSize: '12px' }}>
                      Players: {match.pendingAwayRoster.players?.length || 0}
                    </div>
                    <div style={{ fontSize: '12px' }}>
                      Bench Officials: {match.pendingAwayRoster.bench?.length || 0}
                    </div>
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
                        
                        // Update state
                        setAwayRoster(importedPlayers)
                        setBenchAway(importedBench)
                        
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
                                role: null,
                                createdAt: new Date().toISOString()
                              }))
                            )
                          }
                          
                          // Update match with bench officials
                          await db.matches.update(matchId, {
                            bench_away: importedBench,
                            pendingAwayRoster: null
                          })
                        } else {
                          // If no teamId yet, just clear pending
                          await db.matches.update(matchId, { pendingAwayRoster: null })
                        }
                      }}
                      style={{ padding: '8px 16px', fontSize: '12px', background: '#22c55e', color: '#000', flex: 1 }}
                    >
                      Accept
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
                      Reject
                    </button>
                  </div>
                </div>
              )}
              </div>
              )}
            </div>
          </div>
          {/* Right: Player Stats */}
          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.2)',
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'rgba(255, 255, 255, 0.7)' }}>Players:</span>
              <span style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)' }}>{awayRoster.length}</span>
              <span style={{ fontSize: '16px', color: 'rgba(255, 255, 255, 0.5)' }}>
                ({awayRoster.filter(p => !p.libero).length} + {awayRoster.filter(p => p.libero).length} libero{awayRoster.filter(p => p.libero).length !== 1 ? 's' : ''})
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'rgba(255, 255, 255, 0.7)' }}>Captain:</span>
              {(() => {
                const captain = awayRoster.find(p => p.isCaptain)
                return captain ? (
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
                  }}>{captain.number || '?'}</span>
                ) : (
                  <span style={{ fontSize: '14px', fontStyle: 'italic', color: 'rgba(255, 255, 255, 0.5)' }}>—</span>
                )
              })()}
            </div>
          </div>
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
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: 8 }}>Add new player:</div>
            <div className="row" style={{ width: '100%', maxWidth: '100%', overflow: 'hidden' }}>
              <input className="w-num" placeholder="#" type="number" inputMode="numeric" value={awayNum} onChange={e=>setAwayNum(e.target.value)} />
              <input className="w-name capitalize" placeholder="Last Name" value={awayLast} onChange={e=>setAwayLast(e.target.value)} />
              <input className="w-name capitalize" placeholder="First Name" value={awayFirst} onChange={e=>setAwayFirst(e.target.value)} />
              <input className="w-dob" placeholder="Date of birth (dd/mm/yyyy)" type="date" value={awayDob ? formatDateToISO(awayDob) : ''} onChange={e=>setAwayDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} />
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
                <option value="libero1">Libero 1</option>
                )}
                {!awayRoster.some(p => p.libero === 'libero2') && (
                <option value="libero2">Libero 2</option>
                )}
              </select>
              <label className="inline"><input type="radio" name="awayCaptain" checked={awayCaptain} onChange={()=>setAwayCaptain(true)} /> Captain</label>
              <button type="button" className="secondary" onClick={() => {
                if (!awayLast || !awayFirst) return
                const newPlayer = { number: awayNum ? Number(awayNum) : null, lastName: awayLast, firstName: awayFirst, dob: awayDob, libero: awayLibero, isCaptain: awayCaptain }
                setAwayRoster(list => {
                  const cleared = awayCaptain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                  const next = [...cleared, newPlayer].sort((a,b) => {
                    const an = a.number ?? 999
                    const bn = b.number ?? 999
                    return an - bn
                  })
                  return next
                })
                setAwayNum(''); setAwayFirst(''); setAwayLast(''); setAwayDob(''); setAwayLibero(''); setAwayCaptain(false)
              }}>Add</button>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Roster Header Row */}
          <div className="row" style={{ alignItems: 'center', fontWeight: 600, fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)', marginBottom: 4, padding: '6px 8px', border: '2px solid transparent' }}>
            <div className="w-num" style={{ textAlign: 'center' }}>#</div>
            <div className="w-name">Last Name</div>
            <div className="w-name">First Name</div>
            <div className="w-dob">Date of Birth</div>
            <div className="w-90" style={{ textAlign: 'center' }}>Role</div>
            <div style={{ width: '70px', textAlign: 'center' }}>Captain</div>
            <div style={{ width: '80px' }}></div>
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
                title={isDuplicate ? 'Duplicate jersey number!' : undefined}
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
                placeholder="Last Name"
                value={p.lastName || ''}
                onChange={e => {
                  const updated = [...awayRoster]
                  updated[i] = { ...updated[i], lastName: e.target.value }
                  setAwayRoster(updated)
                }}
              />
              <input 
                className="w-name capitalize" 
                placeholder="First Name" 
                value={p.firstName || ''} 
                onChange={e => {
                  const updated = [...awayRoster]
                  updated[i] = { ...updated[i], firstName: e.target.value }
                  setAwayRoster(updated)
                }} 
              />
              <input 
                className="w-dob" 
                placeholder="Date of birth (dd/mm/yyyy)" 
                type="date" 
                value={p.dob ? formatDateToISO(p.dob) : ''} 
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
                  <option value="libero1">Libero 1</option>
                )}
                {!awayRoster.some((player, idx) => idx !== i && player.libero === 'libero2') && (
                  <option value="libero2">Libero 2</option>
                )}
              </select>
              <label className="inline">
                <input 
                  type="radio" 
                  name="awayCaptain" 
                  checked={p.isCaptain || false} 
                  onChange={() => {
                    const updated = awayRoster.map((player, idx) => ({
                      ...player,
                      isCaptain: idx === i
                    }))
                    setAwayRoster(updated)
                  }} 
                /> 
                Captain
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() => setAwayRoster(list => list.filter((_, idx) => idx !== i))}
              >
                Remove
              </button>
            </div>
          )})}
          </div>
        <h4>Bench — Away</h4>
        {/* Bench Header Row */}
        <div className="row" style={{ alignItems: 'center', fontWeight: 600, fontSize: '12px', color: 'rgba(255, 255, 255, 0.6)', marginBottom: 4, padding: '6px 8px', border: '2px solid transparent' }}>
          <div className="w-220">Role</div>
          <div className="w-name">Last Name</div>
          <div className="w-name">First Name</div>
          <div className="w-dob">Date of Birth</div>
          <div style={{ width: '70px' }}></div>
        </div>
        {sortBenchByHierarchy(benchAway).map((m, i) => {
          const originalIdx = benchAway.findIndex(b => b === m)
          return (
            <div key={`ba-${originalIdx}`} className="row bench-row" style={{ alignItems:'center', padding: '6px 8px', border: '2px solid transparent', borderRadius: '6px' }}>
              <select className="w-220" value={m.role || 'Coach'} onChange={e=>{
                const newRole = e.target.value || 'Coach'
                // Check if this role is already taken by another official
                const isRoleTaken = benchAway.some((b, idx) => idx !== originalIdx && b.role === newRole)
                if (isRoleTaken) {
                  // Don't allow duplicate roles
                  return
                }
                setBenchAway(arr => { 
                  const a=[...arr]; 
                  a[originalIdx]={...a[originalIdx], role:newRole}; 
                  return a 
                })
              }}>
                                {BENCH_ROLES.map(role => {
                                  const isRoleTaken = benchAway.some((b, idx) => idx !== originalIdx && b.role === role.value)
                                  return (
                                    <option key={role.value} value={role.value} disabled={isRoleTaken}>
                                      {role.label} - {role.fullLabel}{isRoleTaken ? ' (already assigned)' : ''}
                                    </option>
                                  )
                                })}
              </select>
              <input className="w-name capitalize" placeholder="Last Name" value={m.lastName} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[originalIdx]={...a[originalIdx], lastName:e.target.value}; return a })} />
              <input className="w-name capitalize" placeholder="First Name" value={m.firstName} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[originalIdx]={...a[originalIdx], firstName:e.target.value}; return a })} />
              <input className="w-dob" placeholder="Date of birth (dd/mm/yyyy)" type="date" value={m.dob ? formatDateToISO(m.dob) : ''} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[originalIdx]={...a[originalIdx], dob:e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''}; return a })} />
              <button type="button" className="secondary" onClick={() => {
                const updated = benchAway.filter((_, idx) => idx !== originalIdx)
                setBenchAway(updated)
                // Trigger save immediately
                setTimeout(() => saveDraft(true), 100)
              }} style={{ padding: '4px 8px', fontSize: '12px' }}>
                Remove
              </button>
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
              Add Bench Official
            </button>
        </div>
        <div style={{ display:'flex', justifyContent:'flex-end', marginTop:16 }}>
          <button onClick={async () => {
            console.log('[MatchSetup] Away roster Confirm clicked, validating...')

            // Validate roster before saving
            const validationErrors = []

            // 1. Check at least 6 non-libero players with numbers
            const nonLiberoWithNumbers = awayRoster.filter(p => !p.libero && p.number != null && p.number !== '')
            console.log('[MatchSetup] Away non-libero players with numbers:', nonLiberoWithNumbers.length)
            if (nonLiberoWithNumbers.length < 6) {
              validationErrors.push(`Need at least 6 players with numbers (not liberos). Currently: ${nonLiberoWithNumbers.length}`)
            }

            // 2. Check captain is set
            const hasCaptain = awayRoster.some(p => p.isCaptain)
            console.log('[MatchSetup] Away has captain:', hasCaptain)
            if (!hasCaptain) {
              validationErrors.push('No captain selected')
            }

            // 3. Check coach is set
            const hasCoach = benchAway.some(b => b.role === 'Coach' && (b.lastName || b.firstName))
            console.log('[MatchSetup] Away has coach:', hasCoach)
            if (!hasCoach) {
              validationErrors.push('No coach set')
            }

            // 4. Check for duplicate numbers
            const numbers = awayRoster.filter(p => p.number != null && p.number !== '').map(p => p.number)
            const duplicateNumbers = numbers.filter((num, idx) => numbers.indexOf(num) !== idx)
            if (duplicateNumbers.length > 0) {
              console.log('[MatchSetup] Away duplicate numbers:', duplicateNumbers)
              validationErrors.push(`Duplicate jersey numbers: ${[...new Set(duplicateNumbers)].join(', ')}`)
            }

            // 5. Check for invalid numbers (must be 1-99)
            const invalidNumbers = awayRoster.filter(p => p.number != null && (p.number < 1 || p.number > 99))
            if (invalidNumbers.length > 0) {
              console.log('[MatchSetup] Away invalid numbers:', invalidNumbers.map(p => p.number))
              validationErrors.push(`Invalid jersey numbers (must be 1-99): ${invalidNumbers.map(p => p.number).join(', ')}`)
            }

            // 6. Check for players without numbers
            const noNumbers = awayRoster.filter(p => p.number == null || p.number === '')
            if (noNumbers.length > 0) {
              console.log('[MatchSetup] Away players without numbers:', noNumbers.length)
              validationErrors.push(`${noNumbers.length} player(s) without jersey numbers`)
            }

            // Show validation errors if any
            if (validationErrors.length > 0) {
              console.log('[MatchSetup] Away roster validation errors:', validationErrors)
              setNoticeModal({ message: `Please fix the following issues:\n\n• ${validationErrors.join('\n• ')}` })
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
                      isCaptain: !!rosterPlayer.isCaptain
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
              
              // Update match with short name and restore signatures (re-lock)
              const updateData = {
                awayShortName: awayShortName || away.substring(0, 3).toUpperCase()
              }
              
              // Restore signatures if they were previously saved (re-lock the team)
              if (!awayCoachSignature && savedSignatures.awayCoach) {
                updateData.awayCoachSignature = savedSignatures.awayCoach
                setAwayCoachSignature(savedSignatures.awayCoach)
              }
              if (!awayCaptainSignature && savedSignatures.awayCaptain) {
                updateData.awayCaptainSignature = savedSignatures.awayCaptain
                setAwayCaptainSignature(savedSignatures.awayCaptain)
              }
              
              await db.matches.update(matchId, updateData)

              // Sync team to Supabase
              await db.sync_queue.add({
                resource: 'team',
                action: 'insert',
                payload: {
                  external_id: String(match.awayTeamId),
                  name: away?.trim() || '',
                  short_name: awayShortName || generateShortName(away)
                },
                ts: new Date().toISOString(),
                status: 'queued'
              })

              // Sync players to Supabase
              for (const player of awayRoster) {
                if (player.firstName || player.lastName) {
                  await db.sync_queue.add({
                    resource: 'player',
                    action: 'insert',
                    payload: {
                      external_id: `${match.awayTeamId}_${player.number || 'bench'}_${player.firstName}_${player.lastName}`,
                      team_id: String(match.awayTeamId),
                      number: player.number || null,
                      first_name: player.firstName || '',
                      last_name: player.lastName || '',
                      dob: formatDobForSync(player.dob),
                      is_captain: !!player.isCaptain,
                      libero: player.libero || null
                    },
                    ts: new Date().toISOString(),
                    status: 'queued'
                  })
                }
              }

              // Sync team officials (bench staff) to Supabase
              for (const official of benchAway) {
                if (official.firstName || official.lastName) {
                  await db.sync_queue.add({
                    resource: 'team_official',
                    action: 'insert',
                    payload: {
                      external_id: `${match.awayTeamId}_${official.role}_${official.firstName}_${official.lastName}`,
                      team_id: String(match.awayTeamId),
                      role: official.role || '',
                      first_name: official.firstName || '',
                      last_name: official.lastName || '',
                      country: official.country || null,
                      dob: formatDobForSync(official.dob)
                    },
                    ts: new Date().toISOString(),
                    status: 'queued'
                  })
                }
              }

              setNoticeModal({ message: 'Away team saved! Syncing to database...', type: 'success', syncing: true })

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
                      setNoticeModal({ message: 'Away team synced to database!', type: 'success' })
                    } else if (attempts >= maxAttempts) {
                      clearInterval(interval)
                      setNoticeModal({ message: 'Away team saved locally (sync pending)', type: 'success' })
                    }
                  } catch (err) {
                    clearInterval(interval)
                  }
                }, 500)
              }
              checkSyncStatus()
            }
            setCurrentView('main')
          }}>Confirm</button>
        </div>
        {/* PDF Import Summary Modal - shown immediately after import */}
        {importSummaryModal && importSummaryModal.team === 'away' && (
          <Modal
            title="Away Team Import Complete"
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
                  {importSummaryModal.players} Players
                </div>
                <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)' }}>
                  Successfully imported
                </div>
                {importSummaryModal.benchOfficials > 0 && (
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', marginTop: '8px' }}>
                    + {importSummaryModal.benchOfficials} bench official{importSummaryModal.benchOfficials > 1 ? 's' : ''}
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
                  Please review the imported data:
                </div>
                <ul style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', margin: '8px 0 0 0', paddingLeft: '20px', lineHeight: '1.6' }}>
                  <li>Add any missing bench officials (Doctor, Physio, etc.)</li>
                  <li>Verify dates of birth are correct</li>
                  <li>Set captain and libero designations</li>
                </ul>
              </div>
              <button
                onClick={() => setImportSummaryModal(null)}
                style={{ width: '100%', padding: '12px', background: 'var(--accent)', border: 'none', borderRadius: '8px', color: '#000', fontWeight: 600, cursor: 'pointer' }}
              >
                OK
              </button>
            </div>
          </Modal>
        )}
        {/* Notice Modal - must be rendered in this view since early return prevents main render */}
        {noticeModal && (
          <Modal
            title={noticeModal.syncing ? 'Syncing' : noticeModal.type === 'success' ? 'Success' : 'Notice'}
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
      </MatchSetupAwayTeamView>
    )
  }

  const StatusBadge = ({ ready, pending }) => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: '50%',
        backgroundColor: ready ? '#22c55e' : pending ? '#3b82f6' : '#f97316',
        color: ready || pending ? '#fff' : '#0b1120',
        fontWeight: 700,
        fontSize: 12,
        marginRight: 8
      }}
      aria-label={ready ? 'Complete' : pending ? 'Ready to confirm' : 'Incomplete'}
      title={ready ? 'Complete' : pending ? 'Ready to confirm' : 'Incomplete'}
    >
      {ready ? '✓' : pending ? '●' : '!'}
    </span>
  )

  // Officials are complete if at least 1st referee and scorer are filled
  // 2nd referee and assistant scorer are optional
  const officialsConfigured =
    !!(ref1Last && ref1First && scorerLast && scorerFirst)
  const matchInfoConfigured = !!(date || time || hall || city || league)
  const homeConfigured = !!(home && homeRoster.length >= 6 && homeCounts.liberos >= 0)
  const awayConfigured = !!(away && awayRoster.length >= 6 && awayCounts.liberos >= 0)

  const formatOfficial = (lastName, firstName) => {
    if (!lastName && !firstName) return 'Not set'
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

      ws.onerror = () => {}
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
      }
    } catch (error) {
      console.error('Failed to update away team connection setting:', error)
    }
  }

  // Dashboard Toggle Component - horizontal layout with PIN on right
  const DashboardToggle = ({ label, enabled, onToggle, pin }) => {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 12px',
        background: enabled ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255,255,255,0.03)',
        borderRadius: '8px',
        border: enabled ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid rgba(255,255,255,0.1)',
        minWidth: '140px',
        flex: 1
      }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: enabled ? '#22c55e' : 'var(--muted)', minWidth: '70px' }}>{label}</span>
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
        {enabled && pin && (
          <span style={{
            fontWeight: 700,
            fontSize: '14px',
            color: 'var(--accent)',
            letterSpacing: '2px',
            fontFamily: 'monospace',
            marginLeft: '4px'
          }}>
            {pin}
          </span>
        )}
      </div>
    )
  }

  // Connection Banner Component (kept for backwards compatibility)
  const ConnectionBanner = ({ team, enabled, onToggle, pin }) => {
    const label = team === 'referee' ? 'Referee' : team === 'home' ? 'Bench Home' : 'Bench Away'
    return (
      <DashboardToggle
        label={label}
        enabled={enabled}
        onToggle={onToggle}
        pin={pin}
      />
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>Match Setup</h2>
          <button
            className="secondary"
            onClick={openScoresheet}
            style={{ padding: '6px 12px', fontSize: '13px', background: '#22c55e', color: '#000' }}
          >
          📄 Scoresheet
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {onOpenOptions && (
            <button className="secondary" onClick={onOpenOptions}>
              Options
            </button>
          )}
          {onGoHome && (
            <button className="secondary" onClick={onGoHome}>
              Home
            </button>
          )}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, maxWidth: '900px' }}>
        {/* Match Info Card */}
        <div className="card" style={!matchInfoConfirmed ? { border: `2px solid ${canConfirmMatchInfo ? '#3b82f6' : '#f59e0b'}` } : {}}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <StatusBadge ready={matchInfoConfirmed} pending={!matchInfoConfirmed && canConfirmMatchInfo} />
                <h3 style={{ margin: 0 }}>Match info</h3>
                {!matchInfoConfirmed && (
                  <span style={{ color: canConfirmMatchInfo ? '#3b82f6' : '#f59e0b', fontSize: '11px', fontWeight: 500 }}>
                    {canConfirmMatchInfo ? '(Ready to confirm)' : '(Fill required fields)'}
                  </span>
                )}
              </div>
            </div>
            <div
              className="text-sm"
              style={{ display: 'grid', gridTemplateColumns: '70px minmax(0, 1fr)', rowGap: 4, columnGap: 8, marginTop: 8 }}
            >
              <span>Home:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }} title={home}>{home || 'Not set'}</span>
              <span>Away:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }} title={away}>{away || 'Not set'}</span>
              <span>Date:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatDisplayDate(date) || 'Not set'}</span>
              <span>Time:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatDisplayTime(time) || 'Not set'}</span>
              <span>City:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={city}>{city || 'Not set'}</span>
              <span>Hall:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={hall}>{hall || 'Not set'}</span>
            </div>
          </div>
          <div className="actions">
            <button className="secondary" onClick={()=>setCurrentView('info')}>Edit</button>
            {!matchInfoConfirmed && (
              <button
                className="primary"
                onClick={confirmMatchInfo}
                disabled={!canConfirmMatchInfo}
                title={!canConfirmMatchInfo ? 'Fill in Home and Away team names to confirm' : ''}
              >
                Create Match
              </button>
            )}
          </div>
        </div>

        {/* Match Officials Card */}
        <div className="card" style={!matchInfoConfirmed ? { opacity: 0.5, pointerEvents: 'none' } : {}}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <StatusBadge ready={officialsConfigured} />
                <h3 style={{ margin: 0 }}>Match officials</h3>
              </div>
            </div>
            <div className="text-sm" style={{ display: 'grid', gridTemplateColumns: '85px minmax(0, 1fr)', rowGap: 4, columnGap: 8, marginTop: 8 }}>
              <span>1st Referee:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={formatOfficial(ref1Last, ref1First)}>{formatOfficial(ref1Last, ref1First)}</span>
              <span>2nd Referee:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={formatOfficial(ref2Last, ref2First)}>{formatOfficial(ref2Last, ref2First)}</span>
              <span>Scorer:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={formatOfficial(scorerLast, scorerFirst)}>{formatOfficial(scorerLast, scorerFirst)}</span>
              <span>Ass. Scorer:</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={formatOfficial(asstLast, asstFirst)}>{formatOfficial(asstLast, asstFirst)}</span>
              {(lineJudge1 || lineJudge2 || lineJudge3 || lineJudge4) && (
                <>
                  <span>LJs:</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[lineJudge1, lineJudge2, lineJudge3, lineJudge4].filter(Boolean).map(formatLineJudge).join(', ')}>
                    {[lineJudge1, lineJudge2, lineJudge3, lineJudge4].filter(Boolean).map(formatLineJudge).join(', ') || 'Not set'}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="actions">
            <button className="secondary" onClick={()=>setCurrentView('officials')} disabled={!matchInfoConfirmed}>Edit</button>
          </div>
        </div>
      </div>
      {/* Dashboard Connections Row */}
      <div style={{
        margin: '12px 0',
        padding: '12px',
        background: 'rgba(255, 255, 255, 0.03)',
        borderRadius: '8px',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        ...(matchInfoConfirmed ? {} : { opacity: 0.5, pointerEvents: 'none' })
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <span style={{ fontWeight: 600, fontSize: '14px', textAlign: 'center', alignItems: 'center' }}>Dashboards</span>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <ConnectionBanner
            team="referee"
            enabled={refereeConnectionEnabled}
            onToggle={handleRefereeConnectionToggle}
            pin={match?.refereePin}
          />
          <ConnectionBanner
            team="home"
            enabled={homeTeamConnectionEnabled}
            onToggle={handleHomeTeamConnectionToggle}
            pin={match?.homeTeamPin}
          />
          <ConnectionBanner
            team="away"
            enabled={awayTeamConnectionEnabled}
            onToggle={handleAwayTeamConnectionToggle}
            pin={match?.awayTeamPin}
          />
        </div>
      </div>
      
      <div className="grid-4" style={!matchInfoConfirmed ? { opacity: 0.5, pointerEvents: 'none' } : {}}>
        <div className="card" style={{ order: 1 }}>
          {/* Row 1: Status + Team Name */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusBadge ready={homeConfigured} />
            <h1 style={{ margin: 0 }}>{home && home !== 'Home' ? home.toUpperCase() : 'HOME TEAM'}</h1>
          </div>

          {/* Row 2: Stats */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <div style={{
              background: 'rgb(0, 0, 0)',
              borderRadius: 6,
              padding: '4px 10px',
              fontWeight: 500,
              color: '#fff',
              fontSize: 13,
              height: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              Players: {homeCounts.players}
            </div>
            <div style={{
              background: 'rgb(255, 255, 255)',
              borderRadius: 6,
              padding: '4px 10px',
              fontWeight: 500,
              color: '#000',
              fontSize: 13,
              height: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              o/w Libero(s): {homeCounts.liberos}
            </div>
            <div style={{
              background: 'rgba(34, 197, 94, 0.10)',
              borderRadius: 6,
              padding: '4px 10px',
              fontWeight: 500,
              color: '#4ade80',
              fontSize: 13,
              height: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              Bench: {homeCounts.bench}
            </div>
          </div>

          {/* Row 3: Color selector + Shirt + Roster */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
            <span style={{ fontSize: '13px', color: 'rgba(255, 255, 255, 0.7)' }}>Select colour</span>
            <div
              className="shirt"
              style={{ background: homeColor, cursor: 'pointer', transform: 'scale(0.85)' }}
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
            <button className="secondary" onClick={() => setCurrentView('home')}>Edit Roster</button>
          </div>
        </div>

        <div className="card" style={{ order: 2 }}>
          {/* Row 1: Status + Team Name */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusBadge ready={awayConfigured} />
            <h1 style={{ margin: 0 }}>{away && away !== 'Away' ? away.toUpperCase() : 'AWAY TEAM'}</h1>
          </div>

          {/* Row 2: Stats */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <div style={{
              background: 'rgb(0, 0, 0)',
              borderRadius: 6,
              padding: '4px 10px',
              fontWeight: 500,
              color: '#fff',
              fontSize: 13,
              height: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              Players: {awayCounts.players}
            </div>
            <div style={{
              background: 'rgb(255, 255, 255)',
              borderRadius: 6,
              padding: '4px 10px',
              fontWeight: 500,
              color: '#000',
              fontSize: 13,
              height: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              o/w Libero(s): {awayCounts.liberos}
            </div>
            <div style={{
              background: 'rgba(34, 197, 94, 0.10)',
              borderRadius: 6,
              padding: '4px 10px',
              fontWeight: 500,
              color: '#4ade80',
              fontSize: 13,
              height: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              Bench: {awayCounts.bench}
            </div>
          </div>

          {/* Row 3: Color selector + Shirt + Roster */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
            <span style={{ fontSize: '13px', color: 'rgba(255, 255, 255, 0.7)' }}>Select colour</span>
            <div
              className="shirt"
              style={{ background: awayColor, cursor: 'pointer', transform: 'scale(0.85)' }}
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
            <button className="secondary" onClick={() => setCurrentView('away')}>Edit Roster</button>
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
                <div className="text-sm" style={{ display: 'grid', gridTemplateColumns: '100px 1fr', rowGap: 8, marginBottom: 12 }}>
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

      <div style={{ display:'flex', justifyContent:'space-between', marginTop:12, alignItems:'center', ...(matchInfoConfirmed ? {} : { opacity: 0.5, pointerEvents: 'none' }) }}>
        <button
          className="secondary"
          style={{
            background: '#ffe066',
            color: '#222',
            border: '1px solid #ffd700',
            fontWeight: 700
          }}
          onClick={() => setShowBothRosters(!showBothRosters)}
          disabled={!matchInfoConfirmed}
        >
          {showBothRosters ? 'Hide' : 'Show'} Rosters
        </button>
        {isMatchOngoing && onReturn ? (
          <button onClick={onReturn}>Return to match</button>
        ) : (
          <button onClick={async () => {
            // Check if match has no data (no sets, no signatures)
            if (matchId && match) {
              const sets = await db.sets.where('matchId').equals(matchId).toArray()
              const hasNoData = sets.length === 0 && !match.homeCoachSignature && !match.homeCaptainSignature && !match.awayCoachSignature && !match.awayCaptainSignature
              
              if (hasNoData) {
                // Check for existing validation errors
                if (dateError) {
                  setNoticeModal({ message: `Invalid date: ${dateError}` })
                  return
                }
                if (timeError) {
                  setNoticeModal({ message: `Invalid time: ${timeError}` })
                  return
                }

                // Validate date/time before going to coin toss
                let scheduledAt
                try {
                  scheduledAt = createScheduledAt(date, time, { allowEmpty: false })
                } catch (err) {
                  setNoticeModal({ message: `Invalid date/time: ${err.message}` })
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
                  officials: [
                    { role: '1st referee', firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: ref1Dob },
                    { role: '2nd referee', firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: ref2Dob },
                    { role: 'scorer', firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob },
                    { role: 'assistant scorer', firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
                    ...(lineJudge1 ? [{ role: 'line judge 1', name: lineJudge1 }] : []),
                    ...(lineJudge2 ? [{ role: 'line judge 2', name: lineJudge2 }] : []),
                    ...(lineJudge3 ? [{ role: 'line judge 3', name: lineJudge3 }] : []),
                    ...(lineJudge4 ? [{ role: 'line judge 4', name: lineJudge4 }] : [])
                  ],
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
                }

                // Check Away Team
                if (!away || away.trim() === '' || away === 'Away') {
                  setupIssues.push('Away Team name')
                } else if (awayRoster.length < 6) {
                  setupIssues.push('Away Team roster (minimum 6 players)')
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
                    message: `Please complete the following before proceeding to coin toss:\n\n• ${setupIssues.join('\n• ')}`
                  })
                  return
                }

                // Go to coin toss
                onOpenCoinToss()
              } else {
                // Create new match or update existing
                await createMatch()
              }
            } else {
              // Create new match
              await createMatch()
            }
          }}>Coin toss</button>
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
        
        return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 24 }}>
          <div className="panel">
              <h3>{home || 'Home'} Team Roster</h3>
              {/* Players Section */}
              <div style={{ marginBottom: 16 }}>
                <strong style={{ display: 'block', marginBottom: 8 }}>Players</strong>
                <table className="roster-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Name</th>
                      <th>DOB</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paddedHomePlayers.map((player, idx) => (
                      <tr key={player ? `p-${idx}` : `empty-${idx}`}>
                        {player ? (
                          <>
                            <td className="roster-number">
                              <span>{player.number ?? '—'}</span>
                              <span className="roster-role">
                                {player.isCaptain && <span className="roster-badge captain">C</span>}
                              </span>
                            </td>
                            <td className="roster-name">
                              {player.lastName || ''} {player.firstName || ''}
                            </td>
                            <td className="roster-dob">{player.dob || '—'}</td>
                          </>
                        ) : (
                          <td colSpan="3" style={{ height: '36px' }}>&nbsp;</td>
                            )}
                      </tr>
                        ))}
                  </tbody>
                </table>
                    </div>
              {/* Liberos Section */}
              {(maxLiberos > 0) && (
                <div style={{ marginBottom: 16 }}>
                  <strong style={{ display: 'block', marginBottom: 8 }}>Liberos</strong>
                  <table className="roster-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Name</th>
                        <th>DOB</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paddedHomeLiberos.map((player, idx) => (
                        <tr key={player ? `l-${idx}` : `empty-libero-${idx}`}>
                          {player ? (
                            <>
                              <td className="roster-number">
                                <span>{player.number ?? '—'}</span>
                                <span className="roster-role">
                                  {player.isCaptain && <span className="roster-badge captain">C</span>}
                                  <span className="roster-badge libero">
                                    {player.libero === 'libero1' ? 'L1' : 'L2'}
                            </span>
                                </span>
                              </td>
                              <td className="roster-name">
                                {player.lastName || ''} {player.firstName || ''}
                              </td>
                              <td className="roster-dob">{player.dob || '—'}</td>
                            </>
                          ) : (
                            <td colSpan="3" style={{ height: '36px' }}>&nbsp;</td>
                          )}
                        </tr>
                        ))}
                    </tbody>
                  </table>
                    </div>
                  )}
              {/* Bench Officials Section */}
                    <div>
                <strong style={{ display: 'block', marginBottom: 8 }}>Bench</strong>
                <table className="roster-table">
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Name</th>
                      <th>DOB</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paddedHomeBench.map((official, idx) => (
                      <tr key={official ? `b-${idx}` : `empty-bench-${idx}`}>
                        {official ? (
                          <>
                            <td style={{ textTransform: 'capitalize', fontWeight: 500 }}>{official.role || '—'}</td>
                            <td>{official.lastName || ''} {official.firstName || ''}</td>
                            <td>{official.dob || '—'}</td>
                          </>
                        ) : (
                          <td colSpan="3" style={{ height: '36px' }}>&nbsp;</td>
                  )}
                      </tr>
                    ))}
                    {maxBench === 0 && (
                      <tr>
                        <td colSpan="3" style={{ textAlign: 'center', color: 'var(--muted)', fontStyle: 'italic' }}>No bench officials</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
          </div>
          <div className="panel">
              <h3>{away || 'Away'} Team Roster</h3>
              {/* Players Section */}
              <div style={{ marginBottom: 16 }}>
                <strong style={{ display: 'block', marginBottom: 8 }}>Players</strong>
                <table className="roster-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Name</th>
                      <th>DOB</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paddedAwayPlayers.map((player, idx) => (
                      <tr key={player ? `p-${idx}` : `empty-${idx}`}>
                        {player ? (
                          <>
                            <td className="roster-number">
                              <span>{player.number ?? '—'}</span>
                              <span className="roster-role">
                                {player.isCaptain && <span className="roster-badge captain">C</span>}
                              </span>
                            </td>
                            <td className="roster-name">
                              {player.lastName || ''} {player.firstName || ''}
                            </td>
                            <td className="roster-dob">{player.dob || '—'}</td>
                          </>
                        ) : (
                          <td colSpan="3" style={{ height: '36px' }}>&nbsp;</td>
                            )}
                      </tr>
                        ))}
                  </tbody>
                </table>
                    </div>
              {/* Liberos Section */}
              {(maxLiberos > 0) && (
                <div style={{ marginBottom: 16 }}>
                  <strong style={{ display: 'block', marginBottom: 8 }}>Liberos</strong>
                  <table className="roster-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Name</th>
                        <th>DOB</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paddedAwayLiberos.map((player, idx) => (
                        <tr key={player ? `l-${idx}` : `empty-libero-${idx}`}>
                          {player ? (
                            <>
                              <td className="roster-number">
                                <span>{player.number ?? '—'}</span>
                                <span className="roster-role">
                                  {player.isCaptain && <span className="roster-badge captain">C</span>}
                                  <span className="roster-badge libero">
                                    {player.libero === 'libero1' ? 'L1' : 'L2'}
                            </span>
                                </span>
                              </td>
                              <td className="roster-name">
                                {player.lastName || ''} {player.firstName || ''}
                              </td>
                              <td className="roster-dob">{player.dob || '—'}</td>
                            </>
                          ) : (
                            <td colSpan="3" style={{ height: '36px' }}>&nbsp;</td>
                          )}
                        </tr>
                        ))}
                    </tbody>
                  </table>
                    </div>
                  )}
              {/* Bench Officials Section */}
                    <div>
                <strong style={{ display: 'block', marginBottom: 8 }}>Bench</strong>
                <table className="roster-table">
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Name</th>
                      <th>DOB</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paddedAwayBench.map((official, idx) => (
                      <tr key={official ? `b-${idx}` : `empty-bench-${idx}`}>
                        {official ? (
                          <>
                            <td style={{ textTransform: 'capitalize', fontWeight: 500 }}>{official.role || '—'}</td>
                            <td>{official.lastName || ''} {official.firstName || ''}</td>
                            <td>{official.dob || '—'}</td>
                          </>
                        ) : (
                          <td colSpan="3" style={{ height: '36px' }}>&nbsp;</td>
                  )}
                      </tr>
                    ))}
                    {maxBench === 0 && (
                      <tr>
                        <td colSpan="3" style={{ textAlign: 'center', color: 'var(--muted)', fontStyle: 'italic' }}>No bench officials</td>
                      </tr>
                    )}
                  </tbody>
                </table>
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
              Choose {colorPickerModal.team === 'home' ? 'Home' : 'Away'} Team Color
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
          title={noticeModal.syncing ? 'Syncing' : noticeModal.type === 'success' ? 'Success' : 'Notice'}
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
          title={`${importSummaryModal.team === 'home' ? 'Home' : 'Away'} Team Import Complete`}
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
                {importSummaryModal.players} Players
              </div>
              <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)' }}>
                Successfully imported
              </div>
              {importSummaryModal.benchOfficials > 0 && (
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', marginTop: '8px' }}>
                  + {importSummaryModal.benchOfficials} bench official{importSummaryModal.benchOfficials > 1 ? 's' : ''}
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
                  {importSummaryModal.errors.length} Error{importSummaryModal.errors.length > 1 ? 's' : ''}
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
                Please review the imported data:
              </div>
              <ul style={{
                fontSize: '12px',
                color: 'rgba(255,255,255,0.7)',
                margin: '8px 0 0 0',
                paddingLeft: '20px',
                lineHeight: '1.6'
              }}>
                <li>Add any missing bench officials (Doctor, Physio, etc.)</li>
                <li>Verify dates of birth are correct</li>
                <li>Set captain and libero designations</li>
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
              Got it
            </button>
          </div>
        </Modal>
      )}

      {/* Match Created Modal - shows Match ID and PIN for recovery */}
      {matchCreatedModal && (
        <Modal
          title="Match Created"
          open={true}
          onClose={() => {
            setMatchCreatedModal(null)
            onOpenCoinToss()
          }}
          width={450}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <div style={{
              background: 'rgba(34, 197, 94, 0.1)',
              border: '2px solid rgba(34, 197, 94, 0.3)',
              borderRadius: '12px',
              padding: '20px',
              marginBottom: '20px'
            }}>
              <div style={{ marginBottom: '16px' }}>
                <span style={{ fontSize: '14px', color: 'rgba(255,255,255,0.6)', display: 'block', marginBottom: '4px' }}>
                  Match ID
                </span>
                <span style={{
                  fontSize: '28px',
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
                  Game PIN
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
            <p style={{
              fontSize: '14px',
              color: 'rgba(255,255,255,0.8)',
              marginBottom: '24px',
              lineHeight: 1.5
            }}>
              Please save this information to recover the match if needed.
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
              Continue to Coin Toss
            </button>
          </div>
        </Modal>
      )}

      {/* Edit PIN Modal */}
      {editPinModal && (
        <Modal
          title={editPinType === 'referee' ? 'Edit Referee PIN' : editPinType === 'benchHome' ? 'Edit Home Bench PIN' : 'Edit Away Bench PIN'}
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
                Enter new 6-digit PIN:
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
                placeholder="000000"
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

// Shared styles for wider layout and sticking to top
const setupViewStyle = {
  maxWidth: '1200px',
  alignSelf: 'flex-start',
  marginTop: '10px'
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
