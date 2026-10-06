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
const ballImage = `${import.meta.env.BASE_URL}ball.png`
import { parseRosterPdf } from '../utils/parseRosterPdf'
import { getBackendUrl } from '../utils/backendConfig'
import { exportMatchData } from '../utils/backupManager'
import { uploadBackupToCloud, uploadLogsToCloud } from '../utils/logger'
import { apiFrom } from '../lib/apiClient'
import { generateMatchSeedKey, relayMatchKey } from '../utils/serverDataSync'
import { scorerLiveOrder, scorerRelay } from '../utils/relayPublisher'
import { TEST_TEAM_SEED_DATA, TEST_HOME_BENCH, TEST_AWAY_BENCH } from '../constants/testSeeds'
import { splitLocalDateTime, parseLocalDateTimeToISO, roundToMinute } from '../utils/timeUtils'
import { generateSecurePin } from '../utils/stringUtils'
import { setExtId } from '../utils/syncIds'
import { buildConnectionPins } from '../utils/connectionPins'
import { missingConnectionPins, connectionPinsSyncJob, fetchPendingRoster, clearPendingRosterJob, isKnownDob } from '../utils/remoteRoster'
import { FileTextIcon, ClipboardIcon } from './icons'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button, Field, Input, Select, SegmentedControl, SectionHeader, KeyValue, CountBadge, Switch, cn } from '../ui'

// Kit field look inside the setup editors: compact label tone, and the legacy
// `label { margin: 8px 0 }` rule neutralised so the label sits on its field.
const FIELD = '[&>label]:mt-0 [&>label]:mb-1'
// Match-info summary: the kit 'detail' definition list at body size, values left.
const SUMMARY_KV = 'self-start text-sm gap-y-1.5 [&_dt]:whitespace-nowrap [&_dd]:text-left'
const TRUNC = 'block truncate'

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
    'type2', 'type3', 'type3Other', 'bestOf', 'gameN', 'league', 'home', 'away', 'homeColor', 'awayColor', 'homeShortName', 'awayShortName']
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
const ToggleSwitch = memo(function ToggleSwitch({ on, onToggle, label }) {
  return (
    <Switch
      checked={on}
      onCheckedChange={() => onToggle()}
      className="p-0"
      aria-label={label}
      title={label}
    />
  )
})

// Roster and bench grids as a svrz table (SPEC 3.8): one bordered box, hairline
// row dividers, the 11px uppercase head strip. Rows keep the legacy 6px radius
// and 2px side borders so the frozen captain/libero outlines (inline) are unchanged.
// No overflow-hidden on the box: it drops the grid item's automatic minimum
// height and the fixed-height .setup grid then collapses the table. The head
// strip rounds its own top corners to sit inside the box instead.
const ROSTER_TABLE = 'rounded-lg border border-stone-200 bg-white gap-y-0 divide-y divide-stone-100'
const ROSTER_TABLE_HEAD = 'rounded-t-[7px] rounded-b-none bg-stone-50 text-[11px] font-bold uppercase tracking-wide text-stone-500'
// One official (1st/2nd referee, scorer, assistant scorer): the kit Block
// (stone-50/60, hairline, no shadow) with a heading strip, inside the setup
// page card (volleyui: never a card in a card).
const OFFICIAL_BOX = 'rounded-xl border border-stone-200/70 bg-stone-50/60 overflow-hidden transition-colors'
const OFFICIAL_BOX_COLLAPSED = 'rounded-xl border border-dashed border-stone-200 overflow-hidden transition-colors'
// One head height for every box (h-8 Database button + py-2 + hairline), and a
// tighter inline gap so title + Database + switch stay on one line at 1280.
const OFFICIAL_HEAD = 'flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 min-h-12.25 px-4 py-2 border-b border-stone-200/70'
const OFFICIAL_HEAD_COLLAPSED = 'flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 min-h-12 px-4 py-2'
const OFFICIAL_TITLE = 'whitespace-nowrap text-sm font-semibold text-stone-700'
// A section inside the setup page card (match info, team, live server, roster
// panels): the kit Block, sunken stone-50/60 with a hairline and no shadow.
const SETUP_BLOCK = 'rounded-xl border border-stone-200/70 bg-stone-50/60'

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
  collapsible = false,
  defaultCollapsed = false,
  forceExpanded = false,
  t
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const isCollapsed = collapsible && collapsed && !forceExpanded
  return (
    <div className={isCollapsed ? OFFICIAL_BOX_COLLAPSED : OFFICIAL_BOX}>
      <div className={isCollapsed ? OFFICIAL_HEAD_COLLAPSED : OFFICIAL_HEAD}>
        <span className={cn(OFFICIAL_TITLE, isCollapsed && 'text-stone-500')}>{title}</span>
        <div className="flex shrink-0 items-center gap-1">
          {hasDatabase && !isCollapsed && (
            <Button
              variant="ghost"
              size="sm"
              className="bg-white px-2"
              onClick={(e) => {
                e.stopPropagation()
                onOpenDatabase(e, selectorKey)
              }}
            >
              {t('matchSetup.database')}
            </Button>
          )}
          {collapsible && (
            <ToggleSwitch on={!isCollapsed} onToggle={() => setCollapsed(c => !c)} label={title} />
          )}
        </div>
      </div>
      {!isCollapsed && (
        <div className="p-4">
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(120px,1fr))]">
            <Field tone="compact" className={FIELD} label={t('matchSetup.lastName')}><Input aria-label={t('matchSetup.lastName')} className="capitalize" value={lastName} onChange={e => setLastName(e.target.value)} /></Field>
            <Field tone="compact" className={FIELD} label={t('matchSetup.firstName')}><Input aria-label={t('matchSetup.firstName')} className="capitalize" value={firstName} onChange={e => setFirstName(e.target.value)} /></Field>
            <Field tone="compact" className={FIELD} label={t('matchSetup.country')}><Input aria-label={t('matchSetup.country')} value={country} onChange={e => setCountry(e.target.value)} /></Field>
            <Field tone="compact" className={FIELD} label={t('matchSetup.dateOfBirth')}><Input aria-label={t('matchSetup.dateOfBirth')} className="tabular-nums" type="date" value={dob ? formatDateToISO(dob) : ''} onChange={e => setDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></Field>
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
  defaultCollapsed = false,
  forceExpanded = false,
  t
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const isCollapsed = collapsed && !forceExpanded
  return (
    <div className={isCollapsed ? OFFICIAL_BOX_COLLAPSED : OFFICIAL_BOX}>
      <div className={isCollapsed ? OFFICIAL_HEAD_COLLAPSED : OFFICIAL_HEAD}>
        <span className={cn(OFFICIAL_TITLE, isCollapsed && 'text-stone-500')}>{t('matchSetup.lineJudges')}</span>
        <ToggleSwitch on={!isCollapsed} onToggle={() => setCollapsed(c => !c)} label={t('matchSetup.lineJudges')} />
      </div>
      {!isCollapsed && (
        <div className="p-4">
          <div className="grid grid-cols-1 gap-2">
            <Field tone="compact" className={FIELD} label={t('matchSetup.lineJudge1')}><Input aria-label={t('matchSetup.lineJudge1')} className="capitalize" value={lineJudge1} onChange={e => setLineJudge1(e.target.value)} placeholder={t('matchSetup.name')} /></Field>
            <Field tone="compact" className={FIELD} label={t('matchSetup.lineJudge2')}><Input aria-label={t('matchSetup.lineJudge2')} className="capitalize" value={lineJudge2} onChange={e => setLineJudge2(e.target.value)} placeholder={t('matchSetup.name')} /></Field>
            <Field tone="compact" className={FIELD} label={t('matchSetup.lineJudge3')}><Input aria-label={t('matchSetup.lineJudge3')} className="capitalize" value={lineJudge3} onChange={e => setLineJudge3(e.target.value)} placeholder={t('matchSetup.name')} /></Field>
            <Field tone="compact" className={FIELD} label={t('matchSetup.lineJudge4')}><Input aria-label={t('matchSetup.lineJudge4')} className="capitalize" value={lineJudge4} onChange={e => setLineJudge4(e.target.value)} placeholder={t('matchSetup.name')} /></Field>
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

export default function MatchSetup({ onStart, matchId, onReturn, onOpenOptions, onOpenCoinToss, offlineMode = false, lfpTrackingEnabled = false }) {
  const { t } = useTranslation()
  const { showAlert } = useAlert()
  const { user, profile, getCachedProfile } = useAuth()
  const { scaleFactor: baseScaleFactor } = useScaledLayout()
  // MatchSetup uses 25% larger scale by default
  const scaleFactor = baseScaleFactor * 1.25
  // Helper for scaled pixel values
  const s = (px) => Math.round(px * scaleFactor)
  // The kit's Tailwind steps (spacing, text sizes) follow the user's display
  // scale too: Tailwind v4 utilities read --spacing / --text-* at use site.
  const kitScale = useMemo(() => (baseScaleFactor === 1 ? undefined : {
    '--spacing': `${0.25 * baseScaleFactor}rem`,
    '--text-xs': `${0.75 * baseScaleFactor}rem`,
    '--text-sm': `${0.875 * baseScaleFactor}rem`,
    '--text-base': `${1 * baseScaleFactor}rem`,
    '--text-lg': `${1.125 * baseScaleFactor}rem`,
    '--text-xl': `${1.25 * baseScaleFactor}rem`,
    '--text-2xl': `${1.5 * baseScaleFactor}rem`
  }), [baseScaleFactor])
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
  const [bestOf, setBestOf] = useState(5) // 3 or 5
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

  // Returns missing match-info fields as an array (for WarningIndicator)
  const getMissingFieldsList = () => {
    const missing = []
    if (!home?.trim()) missing.push(t('matchSetup.homeTeamName') || 'Home team')
    if (!away?.trim()) missing.push(t('matchSetup.awayTeamName') || 'Away team')
    if (!homeShortName?.trim()) missing.push(`${t('common.home')} ${t('matchSetup.short')}`)
    if (!awayShortName?.trim()) missing.push(`${t('common.away')} ${t('matchSetup.short')}`)
    if (!date?.trim()) missing.push(t('matchSetup.date') || 'Date')
    else if (dateError) missing.push(`${t('matchSetup.date')} (${t('common.invalid') || 'invalid'})`)
    if (!time?.trim()) missing.push(t('matchSetup.time') || 'Time')
    else if (timeError) missing.push(`${t('matchSetup.time')} (${t('common.invalid') || 'invalid'})`)
    if (!gameN?.trim()) missing.push(t('matchSetup.gameNumber') || 'Game #')
    if (!league?.trim()) missing.push(t('matchSetup.league') || 'League')
    if (!city?.trim()) missing.push(t('matchSetup.city') || 'City')
    if (!hall?.trim()) missing.push(t('matchSetup.hall') || 'Hall')
    if (requireEmail && !notificationEmail?.trim()) missing.push(t('matchSetup.notificationEmail') || 'Email')
    return missing
  }

  // Warning indicator that shows a clickable amber "!" icon next to disabled buttons
  // On click, displays a fixed popover listing what's missing, clamped to viewport
  const WarningIndicator = ({ id, missingItems, position = 'above' }) => {
    if (!missingItems || missingItems.length === 0) return null
    const isOpen = activeWarningPopover === id

    return (
      <span
        ref={isOpen ? warningPopoverRef : undefined}
        className="relative ml-1.5 inline-flex pointer-events-auto"
      >
        <span
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            setActiveWarningPopover(isOpen ? null : id)
          }}
          className="relative inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full border before:absolute before:-inset-2.5 before:content-[''] before:rounded-full border-amber-300 bg-amber-100 text-sm font-bold text-amber-800 hover:bg-amber-200 transition-colors"
          title={t('warnings.clickForDetails')}
        >
          !
        </span>

        {isOpen && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="fixed z-[100] w-max max-w-[min(340px,90vw)] whitespace-normal rounded-xl border border-amber-200 bg-white px-3.5 py-2.5 shadow-card-lg"
            ref={(el) => {
              if (!el) return
              const iconRect = el.parentElement?.firstElementChild?.getBoundingClientRect()
              if (!iconRect) return
              if (position === 'above') {
                el.style.bottom = `${window.innerHeight - iconRect.top + 8}px`
              } else {
                el.style.top = `${iconRect.bottom + 8}px`
              }
              let left = iconRect.right - el.offsetWidth
              if (left < 8) left = 8
              if (left + el.offsetWidth > window.innerWidth - 8) left = window.innerWidth - 8 - el.offsetWidth
              el.style.left = `${left}px`
            }}
          >
            <div className="mb-1.5 text-xs font-semibold text-amber-800">
              {t('warnings.missingRequired')}
            </div>
            <ul className="m-0 list-disc pl-4 text-xs leading-normal text-stone-700">
              {missingItems.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </span>
    )
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
  const [homeLfp, setHomeLfp] = useState(false)

  const [awayNum, setAwayNum] = useState('')
  const [awayFirst, setAwayFirst] = useState('')
  const [awayLast, setAwayLast] = useState('')
  const [awayDob, setAwayDob] = useState('')
  const [awayLibero, setAwayLibero] = useState('')
  const [awayCaptain, setAwayCaptain] = useState(false)
  const [awayLfp, setAwayLfp] = useState(false)

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
  const [scorerDob, setScorerDob] = useState('')

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
  const [currentView, setCurrentView] = useState('main') // 'main', 'info', 'home', 'away'
  const [openSignature, setOpenSignature] = useState(null) // 'home-coach', 'home-captain', 'away-coach', 'away-captain'
  const [showRoster, setShowRoster] = useState({ home: false, away: false })
  const [colorPickerModal, setColorPickerModal] = useState(null) // { team: 'home'|'away', position: { x, y } } | null
  const [noticeModal, setNoticeModal] = useState(null) // { message: string, type?: 'success' | 'error' } | null
  const [testRosterConfirm, setTestRosterConfirm] = useState(null) // 'home' | 'away' | null

  // Show both rosters in match setup
  const [showBothRosters, setShowBothRosters] = useState(false)

  // PIN editing modal
  const [editPinModal, setEditPinModal] = useState(false)
  const [editPinType, setEditPinType] = useState(null) // 'referee', 'benchHome', 'benchAway'
  const [newPin, setNewPin] = useState('')
  const [pinError, setPinError] = useState('')

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

  // Warning popover state (only one open at a time)
  const [activeWarningPopover, setActiveWarningPopover] = useState(null)
  const warningPopoverRef = useRef(null)

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

  const homeLiberoCount = homeRoster.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length
  const awayLiberoCount = awayRoster.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length
  const homeCounts = {
    players: homeRoster.length,
    liberos: homeLiberoCount,
    bench: benchHome.filter(m => m.firstName || m.lastName || m.dob).length,
    // For coin toss validation: check all players have numbers, has captain, has coach
    allPlayersHaveNumbers: homeRoster.every(p => p.number !== null && p.number !== undefined && p.number !== ''),
    hasCaptain: homeRoster.some(p => p.isCaptain),
    hasCoach: benchHome.some(m => m.role?.toLowerCase() === 'coach' && (m.firstName || m.lastName)),
    // FIVB 19.1.1 / Swiss Art. 75a: with more than 12 players on the sheet, two
    // liberos are mandatory. Rosters of 12 or fewer are unaffected.
    liberosOk: homeRoster.length <= 12 || homeLiberoCount >= 2
  }
  const awayCounts = {
    players: awayRoster.length,
    liberos: awayLiberoCount,
    bench: benchAway.filter(m => m.firstName || m.lastName || m.dob).length,
    // For coin toss validation: check all players have numbers, has captain, has coach
    allPlayersHaveNumbers: awayRoster.every(p => p.number !== null && p.number !== undefined && p.number !== ''),
    hasCaptain: awayRoster.some(p => p.isCaptain),
    hasCoach: benchAway.some(m => m.role?.toLowerCase() === 'coach' && (m.firstName || m.lastName)),
    liberosOk: awayRoster.length <= 12 || awayLiberoCount >= 2
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

  // Dismiss warning popover on click outside
  useEffect(() => {
    if (!activeWarningPopover) return
    const handler = (e) => {
      if (warningPopoverRef.current && !warningPopoverRef.current.contains(e.target)) {
        setActiveWarningPopover(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [activeWarningPopover])

  // Capture original state when entering a view (for discard on Back)
  useEffect(() => {
    if (currentView === 'info') {
      originalMatchInfoRef.current = {
        date, time, hall, city, type1, type1Other, championshipType, championshipTypeOther,
        type2, type3, type3Other, bestOf, gameN, league, home, away, homeColor, awayColor, homeShortName, awayShortName
      }
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
      try {
        const { error } = await apiFrom('matches').select('id').limit(1)
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
          const { data: supabaseMatch } = await apiFrom('matches')
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
        const { data: supabaseMatch } = await apiFrom('matches')
          .select('id')
          .eq('external_id', match.seed_key)
          .maybeSingle()

        if (!supabaseMatch) {
          // Check if a match with the same game_n already exists (prevent duplicates)
          if (match.gameN) {
            const { data: existingByGameN } = await apiFrom('matches')
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
                match_type_3_other: match.match_type_3_other || '',
                best_of: match.bestOf || 5
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
    setType2(o.type2); setType3(o.type3); setType3Other(o.type3Other); setBestOf(o.bestOf ?? 5); setGameN(o.gameN); setLeague(o.league)
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
        if (match.bestOf) setBestOf(match.bestOf)
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
        const updates = missingConnectionPins(match)
        if (Object.keys(updates).length > 0) {
          await db.matches.update(matchId, updates)
        }

        // A created match: make sure the server has every connection PIN
        // (roster upload validates the upload PIN there). Through the sync
        // queue, so it also works offline and after the match insert; it
        // heals matches created before Create match carried the PINs.
        if (match.seed_key && match.matchInfoConfirmedAt) {
          try {
            await db.sync_queue.add(connectionPinsSyncJob(match.seed_key, { ...match, ...updates }))
          } catch (err) {
            console.warn('[MatchSetup] Failed to queue the connection PINs:', err)
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
            setScorerDob(scorer.dob || '')
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
          if (draft.bestOf !== undefined) setBestOf(draft.bestOf)
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
        bestOf,
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
          gamePin: match && !match.test ? (match.gamePin || generateSecurePin([])) : null,
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
    if (currentView === 'main' || currentView === 'info' || currentView === 'home' || currentView === 'away') {
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
      type2, type3, type3Other, bestOf, gameN, league, home, away, homeColor, awayColor, homeShortName, awayShortName
    }
    const currentOfficials = {
      ref1First, ref1Last, ref1Country, ref1Dob,
      ref2First, ref2Last, ref2Country, ref2Dob,
      scorerFirst, scorerLast, scorerCountry, scorerDob,
      asstFirst, asstLast, asstCountry, asstDob,
      lineJudge1, lineJudge2, lineJudge3, lineJudge4
    }
    const hasChanges = isCreating || hasMatchInfoChanged(originalMatchInfoRef.current, currentMatchInfo) || hasOfficialsChanged(originalOfficialsRef.current, currentOfficials)

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

      // Every connection PIN the scorer will show (referee, benches, upload)
      // exists locally and goes to the server with the match, so the roster
      // upload's PIN check works from Create match on (stored hashed there).
      const localMatch = await db.matches.get(matchId)
      const pinUpdates = missingConnectionPins(localMatch)

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
        bestOf,
        sport_type: 'indoor',
        game_n: gameN ? parseInt(gameN, 10) : null,
        seed_key: matchSeedKey, // Ensure seed_key is set
        ...pinUpdates,
        bench_home: benchHome,
        bench_away: benchAway,
        officials: buildOfficialsArray(
          { firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: ref1Dob },
          { firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: ref2Dob },
          { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob },
          { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
          { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 }
        ),
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
        connection_pins: buildConnectionPins({ ...localMatch, ...pinUpdates }),
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
          match_type_3_other: type3Other || '',
          best_of: bestOf
        },
        home_team: { name: home.trim(), short_name: homeShortName || generateShortName(home.trim()), color: homeColor },
        away_team: { name: away.trim(), short_name: awayShortName || generateShortName(away.trim()), color: awayColor },
        bench_home: benchHome || [],
        bench_away: benchAway || [],
        officials: buildOfficialsArray(
          { firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: formatDobForSync(ref1Dob) },
          { firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: formatDobForSync(ref2Dob) },
          { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: formatDobForSync(scorerDob) },
          { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: formatDobForSync(asstDob) },
          { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 },
          true // useSnakeCase for Supabase
        )
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
        const backendUrl = getBackendUrl()

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

      // Generate match PIN code (for opening/continuing match)
      const matchPin = prompt(t('matchSetup.enterPinPrompt'))
      if (!matchPin || matchPin.trim() === '') {
        setNoticeModal({ message: t('matchSetup.matchPinRequired') })
        return
      }

      // Auto-generate gamePin for official matches
      const generatedGamePin = generateSecurePin([])

      // Generate all PINs upfront so we can display them in the modal
      const generatedRefereePin = generateSecurePin([])
      const generatedHomeTeamPin = generateSecurePin([generatedRefereePin])
      const generatedAwayTeamPin = generateSecurePin([generatedRefereePin, generatedHomeTeamPin])

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
      if (user) {
        try {
          await apiFrom('user_matches').upsert({
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
    const scoresheetWindow = window.open(`/scoresheet/?matchId=${matchId}`, '_blank', 'width=1200,height=900')

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
          external_id: setExtId(matchForSet.seed_key, firstSetId),
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
    if (matchData.bestOf) setBestOf(matchData.bestOf)
    setGameN(matchData.gameN)
    setLeague(matchData.league)
    setHome(matchData.home)
    setAway(matchData.away)

    // Clear short names - user must fill them in manually for official matches
    setHomeShortName('')
    setAwayShortName('')

    // Referees (from Supabase - separate first/last name fields)
    if (matchData.referee1First || matchData.referee1Last) {
      setRef1First(matchData.referee1First || '')
      setRef1Last(matchData.referee1Last || '')
      setRef1Country('CHE')
      if (matchData.referee1Dob) {
        // Convert YYYY-MM-DD to DD.MM.YYYY
        const m = matchData.referee1Dob.match(/^(\d{4})-(\d{2})-(\d{2})/)
        if (m) setRef1Dob(`${m[3]}.${m[2]}.${m[1]}`)
      }
    }
    if (matchData.referee2First || matchData.referee2Last) {
      setRef2First(matchData.referee2First || '')
      setRef2Last(matchData.referee2Last || '')
      setRef2Country('CHE')
      if (matchData.referee2Dob) {
        const m = matchData.referee2Dob.match(/^(\d{4})-(\d{2})-(\d{2})/)
        if (m) setRef2Dob(`${m[3]}.${m[2]}.${m[1]}`)
      }
    }

    // Line judges
    if (matchData.linesman1) setLineJudge1(matchData.linesman1)
    if (matchData.linesman2) setLineJudge2(matchData.linesman2)
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
      setHomePdfError(t('matchSetup.selectPdfFirst'))
    }
  }

  const handleAwayImportClick = async () => {
    if (awayPdfFile) {
      await handleAwayPdfUpload(awayPdfFile)
    } else {
      setAwayPdfError(t('matchSetup.selectPdfFirst'))
    }
  }

  // New upload PIN for a team; a created match sends it to the server at once
  // (the roster upload checks it there), through the sync queue.
  const regenerateUploadPin = async (team) => {
    if (!matchId) return
    const local = await db.matches.get(matchId)
    if (!local) return
    const field = team === 'home' ? 'homeTeamUploadPin' : 'awayTeamUploadPin'
    const existingPins = [local.refereePin, local.homeTeamPin, local.awayTeamPin, local.homeTeamUploadPin, local.awayTeamUploadPin].filter(Boolean)
    const newPin = generateSecurePin(existingPins)
    await db.matches.update(matchId, { [field]: newPin })
    if (local.seed_key && local.matchInfoConfirmedAt) {
      try {
        await db.sync_queue.add(connectionPinsSyncJob(local.seed_key, { ...local, [field]: newPin }))
      } catch (err) {
        console.warn('[MatchSetup] Failed to queue the new upload PIN:', err)
      }
    }
  }

  // Accepted or rejected: clear the coach's upload on the server too, so the
  // next search does not bring it back (a new upload replaces it anyway).
  const clearServerPendingRoster = async (team) => {
    if (!match?.seed_key || !match?.matchInfoConfirmedAt) return
    try {
      await db.sync_queue.add(clearPendingRosterJob(match.seed_key, team))
    } catch (err) {
      console.warn('[MatchSetup] Failed to queue the pending roster clean-up:', err)
    }
  }

  // Search for the roster a coach uploaded (remote roster upload)
  const handleSearchHomeRoster = async () => {
    if (!match) {
      setNoticeModal({ message: t('matchSetup.noSupabaseConnection') })
      return
    }

    setHomeRosterSearching(true)
    try {
      // The coach's upload lands in this match's row (connections.pending_home_roster)
      const { roster, error } = await fetchPendingRoster(apiFrom, match.seed_key, 'home')
      if (error) throw error
      if (!roster) {
        setNoticeModal({ message: t('matchSetup.noRosterFound') })
        return
      }

      // Store in local match data to trigger the pending roster UI
      await db.matches.update(matchId, { pendingHomeRoster: roster })
    } catch (err) {
      console.error('[MatchSetup] Error searching for home roster:', err?.message || err)
      setNoticeModal({ message: t('matchSetup.errorSearchingRoster') })
    } finally {
      setHomeRosterSearching(false)
    }
  }

  const handleSearchAwayRoster = async () => {
    if (!match) {
      setNoticeModal({ message: t('matchSetup.noSupabaseConnection') })
      return
    }

    setAwayRosterSearching(true)
    try {
      // The coach's upload lands in this match's row (connections.pending_away_roster)
      const { roster, error } = await fetchPendingRoster(apiFrom, match.seed_key, 'away')
      if (error) throw error
      if (!roster) {
        setNoticeModal({ message: t('matchSetup.noRosterFound') })
        return
      }

      // Store in local match data to trigger the pending roster UI
      await db.matches.update(matchId, { pendingAwayRoster: roster })
    } catch (err) {
      console.error('[MatchSetup] Error searching for away roster:', err?.message || err)
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
      <MatchSetupInfoView kitScale={kitScale}>
        <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3">
          <div>
            <Button variant="ghost" size="xl" className="bg-white" onClick={() => { restoreMatchInfo(); restoreOfficials(); setCurrentView('main') }}>← {t('common.back')}</Button>
          </div>
          <div className="flex flex-col items-center gap-2">
            <h1 className="m-0 text-xl sm:text-2xl font-bold tracking-tight text-stone-900">{t('matchSetup.matchInfo')}</h1>
            <Button variant="toolbar" size="md" onClick={() => setLoadOfficialMatchModal(true)}>
              {t('loadOfficialMatch.button')}
            </Button>
          </div>
          <div />
        </div>
        <div className="grid grid-cols-5 gap-4">
          <div className={OFFICIAL_BOX}>
            <div className={OFFICIAL_HEAD}>
              <span className={OFFICIAL_TITLE}>{t('matchSetup.dateTime')}</span>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <Field tone="compact" className={FIELD} label={t('matchSetup.date')} error={dateError || undefined}>
                <Input
                  aria-label={t('matchSetup.date')}
                  className="tabular-nums"
                  type="date"
                  value={date}
                  onChange={e => handleDateChange(e.target.value)}
                  invalid={!!dateError}
                />
              </Field>
              <Field tone="compact" className={FIELD} label={t('matchSetup.time')} error={timeError || undefined}>
                <Input
                  aria-label={t('matchSetup.time')}
                  className="tabular-nums"
                  type="text"
                  value={time}
                  onChange={e => handleTimeChange(e.target.value)}
                  placeholder={t('matchSetup.placeholders.hhMm')}
                  invalid={!!timeError}
                />
              </Field>
            </div>
          </div>

          <div className={OFFICIAL_BOX}>
            <div className={OFFICIAL_HEAD}>
              <span className={OFFICIAL_TITLE}>{t('matchSetup.location')}</span>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <Field tone="compact" className={FIELD} label={t('matchSetup.city')}>
                <Input
                  aria-label={t('matchSetup.city')}
                  className="capitalize"
                  value={city}
                  onChange={e => setCity(e.target.value)}
                  list="cities-zurich"
                  placeholder={t('matchSetup.enterCity')}
                />
              </Field>
              <datalist id="cities-zurich">
                {citiesZurich.map(c => <option key={c} value={c} />)}
              </datalist>
              <Field tone="compact" className={FIELD} label={t('matchSetup.hall')}><Input aria-label={t('matchSetup.hall')} className="capitalize" value={hall} onChange={e => setHall(e.target.value)} /></Field>
            </div>
          </div>

          <div className={OFFICIAL_BOX}>
            <div className={OFFICIAL_HEAD}>
              <span className={OFFICIAL_TITLE}>{t('matchSetup.matchType')}</span>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <Field tone="compact" className={FIELD} label={t('matchSetup.matchType')}>
                <Select aria-label={t('matchSetup.matchType')} block className="capitalize" value={type1} onChange={e => setType1(e.target.value)}>
                  <option value="championship">{t('matchSetup.championship')}</option>
                  <option value="cup">{t('matchSetup.cup')}</option>
                  <option value="friendly">{t('matchSetup.friendly')}</option>
                  <option value="tournament">{t('matchSetup.tournament')}</option>
                  <option value="other">{t('matchSetup.other')}</option>
                </Select>
              </Field>
              {type1 === 'other' && (
                <Field tone="compact" className={FIELD} label={t('matchSetup.specify')}>
                  <Input aria-label={t('matchSetup.specify')} value={type1Other} onChange={e => setType1Other(e.target.value)} placeholder={t('matchSetup.otherType')} />
                </Field>
              )}
              <Field tone="compact" className={FIELD} label={t('matchSetup.championshipType')}>
                <Select aria-label={t('matchSetup.championshipType')} block value={championshipType} onChange={e => setChampionshipType(e.target.value)}>
                  <option value="regional">{t('matchSetup.regional')}</option>
                  <option value="national">{t('matchSetup.national')}</option>
                  <option value="international">{t('matchSetup.international')}</option>
                  <option value="other">{t('matchSetup.other')}</option>
                </Select>
              </Field>
              {championshipType === 'other' && (
                <Field tone="compact" className={FIELD} label={t('matchSetup.specify')}>
                  <Input aria-label={t('matchSetup.specify')} value={championshipTypeOther} onChange={e => setChampionshipTypeOther(e.target.value)} placeholder={t('matchSetup.otherType')} />
                </Field>
              )}
            </div>
          </div>

          <div className={OFFICIAL_BOX}>
            <div className={OFFICIAL_HEAD}>
              <span className={OFFICIAL_TITLE}>{t('matchSetup.categoryLevel')}</span>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <Field tone="compact" className={FIELD} label={t('matchSetup.gender')}>
                <Select aria-label={t('matchSetup.gender')} block value={type2} onChange={e => setType2(e.target.value)}>
                  <option value="men">{t('matchSetup.men')}</option>
                  <option value="women">{t('matchSetup.women')}</option>
                </Select>
              </Field>
              <Field tone="compact" className={FIELD} label={t('matchSetup.matchLevel')}>
                <Select aria-label={t('matchSetup.matchLevel')} block value={type3} onChange={e => setType3(e.target.value)}>
                  <option value="senior">{t('matchSetup.senior')}</option>
                  <option value="U23">U23</option>
                  <option value="U21">U21</option>
                  <option value="U19">U19</option>
                  <option value="U17">U17</option>
                  <option value="other">{t('matchSetup.other')}</option>
                </Select>
              </Field>
              {type3 === 'other' && (
                <Field tone="compact" className={FIELD} label={t('matchSetup.specify')}>
                  <Input aria-label={t('matchSetup.specify')} value={type3Other} onChange={e => setType3Other(e.target.value)} placeholder={t('matchSetup.otherLevel')} />
                </Field>
              )}
            </div>
          </div>

          <div className={OFFICIAL_BOX}>
            <div className={OFFICIAL_HEAD}>
              <span className={OFFICIAL_TITLE}>{t('matchSetup.gameDetails')}</span>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                <Field tone="compact" className={FIELD} label={t('matchSetup.gameNumber')}><Input aria-label={t('matchSetup.gameNumber')} className="tabular-nums" type="number" inputMode="numeric" value={gameN} onChange={e => setGameN(e.target.value)} /></Field>
                <Field tone="compact" className={FIELD} label={t('matchSetup.league')}><Input aria-label={t('matchSetup.league')} className="capitalize" value={league} onChange={e => setLeague(e.target.value)} /></Field>
              </div>
              <Field tone="compact" className={FIELD} label={t('matchSetup.matchFormat')}>
                <Select aria-label={t('matchSetup.matchFormat')} block value={bestOf} onChange={e => setBestOf(Number(e.target.value))}>
                  <option value={5}>{t('matchSetup.bestOf5')}</option>
                  <option value={3}>{t('matchSetup.bestOf3')}</option>
                </Select>
              </Field>
            </div>
          </div>

          {/* Match Officials Row */}
          <div className="col-span-5 grid grid-cols-5 items-start gap-4">
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
              collapsible={true}
              defaultCollapsed={true}
              forceExpanded={!!(ref2First || ref2Last)}
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
              collapsible={true}
              defaultCollapsed={true}
              t={t}
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
              defaultCollapsed={true}
              forceExpanded={!!(lineJudge1 || lineJudge2 || lineJudge3 || lineJudge4)}
              t={t}
            />
          </div>

          {/* Teams - full width row at bottom: a section on its head rule, no box */}
          <div className="col-span-5 pt-2">
            <SectionHeader title={t('matchSetup.teams')} as="h2" className="mb-4" />
            <div className="flex items-center gap-6">
              {/* Home Team */}
              <div data-help-id="setup-home-team-card" className="flex-1 rounded-xl border border-stone-200/70 bg-stone-50/60 p-3">
                {/* Header row: Trikot container + Title */}
                <div className="mb-4 flex items-center gap-3">
                  {/* Trikot container */}
                  <div
                    className="m-[16px] flex cursor-pointer items-center justify-center"
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
                  {/* Title: team-colour bar (frozen) */}
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
                <div className="flex items-end gap-4">
                  <Field tone="form" className={cn(FIELD, 'flex-[0_0_60%]')} label={t('matchSetup.teamName')}>
                    <Input
                      size="lg"
                      aria-label={`${t('common.home')} ${t('matchSetup.teamName')}`}
                      type="text"
                      value={home}
                      onChange={e => setHome(e.target.value)}
                      placeholder={t('matchSetup.homeTeamName')}
                      className="text-center font-semibold"
                    />
                  </Field>
                  <Field tone="form" className={cn(FIELD, 'flex-[0_0_calc(40%-16px)]')} label={t('matchSetup.short')}>
                    <Input
                      size="lg"
                      aria-label={`${t('common.home')} ${t('matchSetup.short')}`}
                      type="text"
                      value={homeShortName}
                      onChange={e => setHomeShortName(e.target.value.toUpperCase())}
                      maxLength={8}
                      placeholder={t('common.home').toUpperCase()}
                      className="text-center font-semibold"
                    />
                  </Field>
                </div>
              </div>

              {/* VS Divider */}
              <div className="mt-6 flex flex-col items-center justify-center px-3">
                <span className="text-sm font-semibold text-stone-400">vs</span>
              </div>

              {/* Away Team */}
              <div data-help-id="setup-away-team-card" className="flex-1 rounded-xl border border-stone-200/70 bg-stone-50/60 p-3">
                {/* Header row: Trikot container + Title */}
                <div className="mb-4 flex items-center gap-3">

                  {/* Title: team-colour bar (frozen) */}
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
                    className="m-[16px] flex cursor-pointer items-center justify-center"
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
                <div className="flex items-end gap-4">
                  <Field tone="form" className={cn(FIELD, 'flex-[0_0_60%]')} label={t('matchSetup.teamName')}>
                    <Input
                      size="lg"
                      aria-label={`${t('common.away')} ${t('matchSetup.teamName')}`}
                      type="text"
                      value={away}
                      onChange={e => setAway(e.target.value)}
                      placeholder={t('matchSetup.awayTeamName')}
                      className="text-center font-semibold"
                    />
                  </Field>
                  <Field tone="form" className={cn(FIELD, 'flex-[0_0_calc(40%-16px)]')} label={t('matchSetup.short')}>
                    <Input
                      size="lg"
                      aria-label={`${t('common.away')} ${t('matchSetup.short')}`}
                      type="text"
                      value={awayShortName}
                      onChange={e => setAwayShortName(e.target.value.toUpperCase())}
                      maxLength={8}
                      placeholder={t('common.away').toUpperCase()}
                      className="text-center font-semibold"
                    />
                  </Field>
                </div>

              </div>

            </div>

          </div>
        </div>
        {match && !match.test && match.gamePin && (
          <div className="flex justify-center">
            <div className="min-w-[200px] rounded-xl border border-stone-200 bg-stone-50 px-6 py-3 text-center">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500">{t('matchSetup.gamePin')}</div>
              <div className="cursor-text select-text font-mono text-lg font-bold tracking-[0.3em] text-stone-900">{match.gamePin}</div>
              <div className="mt-1 text-[11px] text-stone-500">
                {t('matchSetup.gamePinDescription')}
              </div>
              {match && !match.test && match.gamePin && (
                <div className="mt-4 flex justify-center">
                  <div className="w-full max-w-[400px] text-left">
                    <label className="mt-0 mb-1.5 block text-sm font-medium text-stone-700">
                      {t('matchSetup.notificationEmail')}
                    </label>
                    <div className="flex gap-2">
                      <Input
                        aria-label={t('matchSetup.notificationEmail')}
                        type="email"
                        placeholder={t('matchSetup.notificationEmailPlaceholder')}
                        value={notificationEmail}
                        onChange={(e) => setNotificationEmail(e.target.value)}
                        className="h-11 flex-1"
                      />
                      <Button
                        variant="dark"
                        size="xl"
                        loading={sendingEmail}
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
                      >
                        {sendingEmail ? (t('matchSetup.sending') || 'Sending...') : (t('matchSetup.send') || 'Send')}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>

          </div>

        )}

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

        <div className="flex items-center justify-end">
          <Button
            variant="positive"
            size="xl"
            className="disabled:cursor-not-allowed"
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
            </Button>
          {!canConfirmMatchInfo && (
            <WarningIndicator id="confirmMatchInfo" missingItems={getMissingFieldsList()} position="below" />
          )}
        </div>

        {/* Color Picker Modal for Match Info view */}
        {colorPickerModal && (
          <>
            {/* No backdrop-blur here: it re-rasterises the frozen swatch shirts
                (sleeve edges differ by up to 33/255 from the before-shot). */}
            <div
              className="fixed inset-0 z-[999] bg-stone-900/50"
              onClick={() => setColorPickerModal(null)}
            />
            <div
              role="dialog"
              className="fixed left-1/2 top-1/2 z-[1000] min-w-[280px] rounded-2xl border border-stone-200/70 bg-white p-4 shadow-2xl"
              style={{ transform: 'translate(-50%, -50%)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 text-sm leading-[1.3] font-semibold text-stone-900">
                {t('matchSetup.chooseTeamColour', { team: colorPickerModal.team === 'home' ? t('common.home') : t('common.away') })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
                {teamColors.map((color) => {
                  const isSelected = (colorPickerModal.team === 'home' ? homeColor : awayColor) === color
                  return (
                    <button
                      key={color}
                      type="button"
                      aria-label={`${t('matchSetup.selectColour', 'Select colour')} ${color}`}
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
                        border: isSelected ? '2px solid #3b82f6' : '1px solid var(--border)',
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

  if (currentView === 'home') {
    return (
      <MatchSetupHomeTeamView kitScale={kitScale}>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div>
            <Button variant="ghost" size="xl" className="bg-white" onClick={() => { restoreHomeTeam(); setCurrentView('main') }}>← {t('common.back')}</Button>
          </div>
          <h2 className="m-0 text-base font-semibold text-stone-700">{home || t('matchSetup.homeTeam')}</h2>
          <div />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="m-0 text-xl sm:text-2xl font-bold tracking-tight text-stone-900">{t('roster.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger-soft"
              size="xl"
              onClick={() => {
                setHomeRoster([])
                setBenchHome([{ role: 'Coach', firstName: '', lastName: '', dob: '' }])
                setHomeCoachSignature(null)
                setHomeCaptainSignature(null)
                  }}
                >
                  {t('roster.deleteRoster')}
                </Button>
                <Button variant="dark" size="xl" onClick={() => setTestRosterConfirm('home')}>
                  {t('roster.loadTestRoster')}
                </Button>
          </div>
        </div>
        {/* Upload Methods for Home Team + Player Stats */}
        <div className="flex gap-3">
          {/* Left: Upload section */}
          <div className="flex-1 rounded-xl border border-stone-200 bg-stone-50/60 p-3">
            <div className="flex flex-col gap-2">
              {/* Upload button row with Local/Remote toggle */}
              <div className="flex items-center gap-2">
                <input
                  ref={homeFileInputRef}
                  type="file"
                  accept=".pdf"
                  onChange={handleHomeFileSelect}
                  style={{ display: 'none' }}
                />
                <Button
                  variant="secondary"
                  size="xl"
                  data-help-id="setup-pdf-import"
                  onClick={() => {
                    if (homeUploadMode === 'local') {
                      homeFileInputRef.current?.click()
                    } else {
                      handleSearchHomeRoster()
                    }
                  }}
                  disabled={homePdfLoading || homeRosterSearching}
                    className="flex-1"
                  >
                  {homeUploadMode === 'local' ? t('matchSetup.uploadPdf') : (homeRosterSearching ? t('common.loading') : t('matchSetup.searchForRoster'))}
                  </Button>
                {/* Local/Remote Toggle */}
                <SegmentedControl
                  ariaLabel={t('matchSetup.uploadPdf')}
                  className="w-44 shrink-0 [&_button]:p-0"
                  value={homeUploadMode}
                  onChange={setHomeUploadMode}
                  options={[
                    { value: 'local', label: t('matchSetup.local') },
                    { value: 'remote', label: t('matchSetup.remote') }
                  ]}
                />
              </div>
              {/* Local upload - file selected */}
              {homeUploadMode === 'local' && homePdfFile && (
                <>
                  <span className="truncate text-xs text-stone-700">
                    {homePdfFile.name}
                  </span>
                  <Button
                    variant="primary"
                    size="xl"
                    block
                    onClick={handleHomeImportClick}
                    loading={homePdfLoading}
                  >
                    {homePdfLoading ? t('matchSetup.importing') : t('matchSetup.importPdf')}
                  </Button>
                </>
              )}
              {homeUploadMode === 'local' && homePdfError && (
                <span className="text-xs font-medium text-red-600">
                  {homePdfError}
                </span>
              )}
              {/* Remote Upload */}
              {homeUploadMode === 'remote' && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-stone-500">{t('matchSetup.gameNumber')}:</span>
                    <span className="font-mono text-sm font-semibold tabular-nums text-stone-900">
                      {match?.game_n || match?.gameNumber || gameN || 'N/A'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-stone-500">{t('matchSetup.uploadPin')}:</span>
                    {match?.homeTeamUploadPin ? (
                      <>
                        <span className="font-mono text-base font-bold tracking-[0.3em] text-stone-900">
                          {match.homeTeamUploadPin}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="bg-white"
                          onClick={() => regenerateUploadPin('home')}
                          >
                            {t('matchSetup.regenerate')}
                          </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="bg-white"
                        onClick={() => regenerateUploadPin('home')}
                        >
                          {t('matchSetup.generatePin')}
                        </Button>
                    )}
                  </div>
                  {match?.pendingHomeRoster && (
                    <div className="mt-3 rounded-xl border border-sky-200 bg-white p-3">
                      <h4 className="mt-0 mb-2 text-sm font-semibold text-stone-800">{t('matchSetup.rosterUploaded')}</h4>
                      <div className="mb-3 flex flex-col gap-1 text-xs text-stone-600">
                        <div>
                          {t('matchSetup.playersCount')}: {match.pendingHomeRoster.players?.length || 0}
                        </div>
                        <div>
                          {t('matchSetup.benchOfficialsCount')}: {match.pendingHomeRoster.bench?.length || 0}
                        </div>
                      </div>
                      <div className="mb-2 flex gap-2">
                        <Button variant="secondary" size="xl" className="flex-1" onClick={() => setRosterPreview('home')}>
                          {t('matchSetup.previewRoster')}
                        </Button>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="positive"
                          size="xl"
                          className="flex-1"
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
                            await clearServerPendingRoster('home')
                          }}
                          >
                            {t('matchSetup.acceptRoster')}
                          </Button>
                          <Button
                            variant="secondary"
                            size="xl"
                            className="flex-1"
                            onClick={async () => {
                              if (!matchId) return
                              await db.matches.update(matchId, { pendingHomeRoster: null })
                              await clearServerPendingRoster('home')
                            }}
                          >
                            {t('matchSetup.rejectRoster')}
                          </Button>
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
              <div className={cn(
                'flex flex-1 items-center justify-center gap-4 rounded-xl border p-3',
                homeHasError ? 'border-red-200 bg-red-50' : 'border-stone-200 bg-stone-50/60'
              )}>
                <div className="flex items-baseline gap-1.5">
                  <span className={cn('text-sm font-medium', homeNonLiberoCount < 6 ? 'text-red-700' : 'text-stone-500')}>{t('matchSetup.players')}:</span>
                  <span className={cn('text-lg font-bold tabular-nums', homeNonLiberoCount < 6 ? 'text-red-700' : 'text-stone-900')}>{homeRoster.length}</span>
                  <span className={cn('text-sm tabular-nums', homeNonLiberoCount < 6 ? 'text-red-700' : 'text-stone-500')}>
                    ({homeNonLiberoCount} + {homeRoster.filter(p => p.libero).length} {homeRoster.filter(p => p.libero).length !== 1 ? 'liberos' : 'libero'})
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={cn('text-sm font-medium', !homeCaptain ? 'text-red-700' : 'text-stone-500')}>{t('matchSetup.captain')}:</span>
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
                    <span className="text-sm text-red-700">—</span>
                  )}
                </div>
              </div>
            )
          })()}
        </div>
        {/* Add new player section */}
        {homeRoster.length < 14 && (
          <div className="mx-auto w-max rounded-xl border border-stone-200 bg-stone-50/60 p-3">
            <div className="mb-2 text-center text-[11px] font-bold uppercase tracking-wide text-stone-500">{t('matchSetup.addNewPlayer')}</div>
            <div data-help-id="setup-add-player" className={`roster-grid${lfpTrackingEnabled ? ' has-lfp' : ''}`} style={{ width: 'max-content', margin: '0 auto' }}>
              <div className="roster-grid-row" style={{ border: 'none' }}>
                <div></div>
                <input aria-label={t('matchSetup.playerNumber', 'Player number')} placeholder={t('matchSetup.numberPlaceholder')} type="number" inputMode="numeric" value={homeNum} onChange={e => setHomeNum(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <input aria-label={t('matchSetup.lastName')} className="capitalize" placeholder={t('matchSetup.lastName')} value={homeLast} onChange={e => setHomeLast(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <input aria-label={t('matchSetup.firstName')} className="capitalize" placeholder={t('matchSetup.firstName')} value={homeFirst} onChange={e => setHomeFirst(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <input aria-label={t('matchSetup.dateOfBirth')} placeholder={t('matchSetup.dateOfBirthPlaceholder')} type="date" value={homeDob ? formatDateToISO(homeDob) : ''} onChange={e => setHomeDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <select aria-label={t('matchSetup.libero', 'Libero')} data-help-id="setup-libero-toggle" value={homeLibero} onChange={e => {
                  let newValue = e.target.value
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
                <div data-help-id="setup-captain-toggle" className="cell-captain">
                  <div
                    onClick={() => setHomeCaptain(!homeCaptain)}
                    style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: '4px',
                      border: homeCaptain ? '2px solid #22c55e' : '2px solid var(--border)',
                      background: homeCaptain ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: 700,
                      color: homeCaptain ? '#22c55e' : 'var(--muted)',
                      userSelect: 'none'
                    }}
                  >C</div>
                </div>
                {lfpTrackingEnabled && (
                  <div className="cell-captain">
                    <div
                      onClick={() => setHomeLfp(!homeLfp)}
                      style={{
                        width: '24px',
                        height: '24px',
                        borderRadius: '4px',
                        border: homeLfp ? '2px solid #f97316' : '2px solid var(--border)',
                        background: homeLfp ? 'rgba(249, 115, 22, 0.15)' : 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: '10px',
                        fontWeight: 700,
                        color: homeLfp ? '#f97316' : 'var(--muted)',
                        userSelect: 'none'
                      }}
                    >{homeLfp ? 'LFP' : '\u2014'}</div>
                  </div>
                )}
                <div className="cell-action">
                  <Button variant="secondary" size="md" onClick={() => {
                    if (!homeLast || !homeFirst) return
                    const newPlayer = { number: homeNum ? Number(homeNum) : null, lastName: homeLast, firstName: homeFirst, dob: homeDob, libero: homeLibero, isCaptain: homeCaptain, isLfp: homeLfp }
                    setHomeRoster(list => {
                      const cleared = homeCaptain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                      const next = [...cleared, newPlayer].sort((a, b) => {
                        const an = a.number ?? 999
                        const bn = b.number ?? 999
                        return an - bn
                      })
                      return next
                    })
                    setHomeNum(''); setHomeFirst(''); setHomeLast(''); setHomeDob(''); setHomeLibero(''); setHomeCaptain(false); setHomeLfp(false)
                  }}>{t('common.add')}</Button>
                </div>
              </div>
            </div>
          </div>
        )}
        <div className={cn('roster-grid', lfpTrackingEnabled && 'has-lfp', ROSTER_TABLE)}>
          {/* Roster Header Row */}
          <div className={cn('roster-grid-row grid-header', ROSTER_TABLE_HEAD)}>
            <div></div>
            <div style={{ textAlign: 'center' }}>#</div>
            <div>{t('matchSetup.lastName')}</div>
            <div>{t('matchSetup.firstName')}</div>
            <div>{t('matchSetup.dateOfBirth')}</div>
            <div style={{ textAlign: 'center' }}>{t('matchSetup.roleLibero')}</div>
            <div className="cell-captain">C</div>
            {lfpTrackingEnabled && <div style={{ textAlign: 'center' }}>LFP</div>}
            <div></div>
          </div>
          {(() => {
            const homeLiberoCount = homeRoster.filter(p => p.libero).length
            return homeRoster.map((p, i) => {
            // Check if this player's number is a duplicate
            const isDuplicate = p.number != null && p.number !== '' &&
              homeRoster.some((other, idx) => idx !== i && other.number === p.number)

            // Determine border style based on captain/libero status
            const isCaptain = p.isCaptain || false
            const isLibero = !!p.libero
            let borderStyle = {}
            if (isCaptain && isLibero) {
              borderStyle = {
                background: 'rgba(34, 197, 94, 0.05)',
                border: '2px solid',
                borderImage: 'repeating-linear-gradient(90deg, #22c55e 0, #22c55e 6px, #ffffff 6px, #ffffff 12px) 1'
              }
            } else if (isCaptain) {
              borderStyle = {
                border: '2px solid #22c55e',
                background: 'rgba(34, 197, 94, 0.1)'
              }
            } else if (isLibero) {
              borderStyle = {
                border: '2px solid var(--border)',
                background: 'var(--panel-2)'
              }
            }

            return (
              <div key={`h-${i}`} className="roster-grid-row" style={borderStyle}>
                <div className={`roster-badge${isCaptain ? ' badge-captain' : isLibero ? ' badge-libero' : ''}`}>
                  {isCaptain ? 'C' : p.libero === 'libero1' ? (homeLiberoCount > 1 ? 'L1' : 'L') : p.libero === 'libero2' ? (homeLiberoCount > 1 ? 'L2' : 'L') : ''}
                </div>
                <input
                  aria-label={t('matchSetup.playerNumber', 'Player number')}
                  placeholder="#"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="99"
                  value={p.number ?? ''}
                  className={isDuplicate ? 'border-red-400 bg-red-50 text-red-700' : undefined}
                  aria-invalid={isDuplicate || undefined}
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
                  aria-label={t('matchSetup.lastName')}
                  className="capitalize"
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
                  aria-label={t('matchSetup.firstName')}
                  className="capitalize"
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
                  aria-label={t('matchSetup.dateOfBirth')}
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
                  aria-label={t('matchSetup.libero', 'Libero')}
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
                <div className="cell-captain">
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
                      border: (p.isCaptain || false) ? '2px solid #22c55e' : '2px solid var(--border)',
                      background: (p.isCaptain || false) ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: 700,
                      color: (p.isCaptain || false) ? '#22c55e' : 'var(--muted)',
                      userSelect: 'none'
                    }}
                  >C</div>
                </div>
                {lfpTrackingEnabled && (
                  <div className="cell-captain">
                    <div
                      onClick={() => {
                        const updated = [...homeRoster]
                        updated[i] = { ...updated[i], isLfp: !p.isLfp }
                        setHomeRoster(updated)
                      }}
                      style={{
                        width: '24px',
                        height: '24px',
                        borderRadius: '4px',
                        border: p.isLfp ? '2px solid #f97316' : '2px solid var(--border)',
                        background: p.isLfp ? 'rgba(249, 115, 22, 0.15)' : 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: '10px',
                        fontWeight: 700,
                        color: p.isLfp ? '#f97316' : 'var(--muted)',
                        userSelect: 'none'
                      }}
                    >{p.isLfp ? 'LFP' : '\u2014'}</div>
                  </div>
                )}
                <div className="cell-action">
                  <Button variant="danger-outline" size="md" onClick={() => setHomeRoster(list => list.filter((_, idx) => idx !== i))}>
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            )
            })
          })()}
        </div>
        <div data-help-id="setup-bench-officials" className="mt-4">
          <SectionHeader as="h4" title={`${t('matchSetup.benchOfficials')} — ${t('common.home')}`} />
        </div>
        <div className={cn('bench-grid', ROSTER_TABLE)}>
          {/* Bench Header Row */}
          <div className={cn('bench-grid-row grid-header', ROSTER_TABLE_HEAD)}>
            <div>{t('matchSetup.role')}</div>
            <div>{t('matchSetup.lastName')}</div>
            <div>{t('matchSetup.firstName')}</div>
            <div>{t('matchSetup.dateOfBirth')}</div>
            <div></div>
          </div>
          {sortBenchByHierarchy(benchHome).map((m, i) => {
            const originalIdx = benchHome.findIndex(b => b === m)
            return (
              <div key={`bh-${originalIdx}`} className="bench-grid-row">
                <select aria-label={t('matchSetup.role')} value={m.role || 'Coach'} onChange={e => {
                  const newRole = e.target.value || 'Coach'
                  const isRoleTaken = benchHome.some((b, idx) => idx !== originalIdx && b.role === newRole)
                  if (isRoleTaken) return
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
                <input aria-label={t('matchSetup.lastName')} className="capitalize" placeholder={t('matchSetup.lastName')} value={m.lastName} onChange={e => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], lastName: e.target.value }; return a })} />
                <input aria-label={t('matchSetup.firstName')} className="capitalize" placeholder={t('matchSetup.firstName')} value={m.firstName} onChange={e => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], firstName: e.target.value }; return a })} />
                <input aria-label={t('matchSetup.dateOfBirth')} placeholder={t('matchSetup.dateOfBirthPlaceholder')} type="date" value={m.dob ? formatDateToISO(m.dob) : ''} onChange={e => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], dob: e.target.value ? formatDateToDDMMYYYY(e.target.value) : '' }; return a })} />
                <div className="cell-action">
                  <Button variant="danger-outline" size="md" onClick={() => {
                    const updated = benchHome.filter((_, idx) => idx !== originalIdx)
                    setBenchHome(updated)
                    setTimeout(() => saveDraft(true), 100)
                    }}>
                      {t('common.delete')}
                    </Button>
                </div>
              </div>
            )
          })}
          <div className="bench-grid-row" style={{ border: 'none', padding: 0, display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Button
              variant="ghost"
              size="md"
              className="bg-white"
              disabled={benchHome.length >= 5}
              onClick={() => {
                const takenRoles = new Set(benchHome.map(b => b.role))
                const availableRole = BENCH_ROLES.find(r => !takenRoles.has(r.value))
                if (availableRole) {
                  setBenchHome([...benchHome, initBench(availableRole.value)])
                }
              }}
              >
                {t('matchSetup.addBenchOfficial')}
              </Button>
            {benchHome.length >= 5 && (
              <WarningIndicator id="addBenchHome" missingItems={[t('warnings.maxBenchOfficials')]} />
            )}
          </div>
        </div>

        {/* Signatures Section */}
        <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50/60 p-4">
          <h4 className="text-sm font-semibold text-stone-800">
            {t('rosterSetup.signatures', 'Signatures')}
          </h4>
          <p className="mt-1 mb-4 text-xs text-stone-500">
            {t('rosterSetup.signaturesDescription', 'Optional: Coach and captain can sign the roster before the coin toss.')}
          </p>
          <div className="flex flex-wrap gap-4">
            {/* Coach Signature */}
            <div className="min-w-[150px] flex-1">
              <div className="mb-1.5 text-xs font-medium text-stone-600">
                {t('rosterSetup.coachSignature', 'Coach signature')}
              </div>
              <div
                onClick={() => setOpenSignature('home-coach')}
                className={cn(
                  'flex h-20 w-full cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 transition-colors',
                  homeCoachSignature ? 'border-emerald-400 bg-white' : 'border-dashed border-stone-300 bg-stone-50 hover:bg-stone-100'
                )}
              >
                {homeCoachSignature ? (
                  <img src={homeCoachSignature} alt={t('matchSetup.coachSignature')} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                ) : (
                  <span className="text-xs text-stone-500">
                    {t('rosterSetup.tapToSign', 'Tap to sign')}
                  </span>
                )}
              </div>
              {homeCoachSignature && (
                <Button
                  variant="danger-outline"
                  size="sm"
                  className="mt-1.5"
                  onClick={(e) => { e.stopPropagation(); setHomeCoachSignature(null); }}
                >
                  {t('common.clear', 'Clear')}
                </Button>
              )}
            </div>

            {/* Captain Signature */}
            <div className="min-w-[150px] flex-1">
              <div className="mb-1.5 text-xs font-medium text-stone-600">
                {t('rosterSetup.captainSignature', 'Captain signature')}
              </div>
              <div
                onClick={() => setOpenSignature('home-captain')}
                className={cn(
                  'flex h-20 w-full cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 transition-colors',
                  homeCaptainSignature ? 'border-emerald-400 bg-white' : 'border-dashed border-stone-300 bg-stone-50 hover:bg-stone-100'
                )}
              >
                {homeCaptainSignature ? (
                  <img src={homeCaptainSignature} alt={t('matchSetup.captainSignature')} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                ) : (
                  <span className="text-xs text-stone-500">
                    {t('rosterSetup.tapToSign', 'Tap to sign')}
                  </span>
                )}
              </div>
              {homeCaptainSignature && (
                <Button
                  variant="danger-outline"
                  size="sm"
                  className="mt-1.5"
                  onClick={(e) => { e.stopPropagation(); setHomeCaptainSignature(null); }}
                >
                  {t('common.clear', 'Clear')}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="positive" size="xl" onClick={async () => {

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
                  const { data: supabaseMatch } = await apiFrom('matches')
                    .select('id')
                    .eq('external_id', match.seed_key)
                    .maybeSingle()

                  if (supabaseMatch?.id) {
                    const coinTossTeamA = match.coinTossTeamA || 'home'
                    const homeIsTeamA = coinTossTeamA === 'home'
                    const colorKey = homeIsTeamA ? 'team_a_color' : 'team_b_color'
                    const shortKey = homeIsTeamA ? 'team_a_short' : 'team_b_short'
                    const nameKey = homeIsTeamA ? 'team_a_name' : 'team_b_name'

                    await apiFrom('match_live_state')
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

              // Poll to check when sync completes
              setNoticeModal({ message: t('matchSetup.homeSaved'), type: 'success', syncing: true })
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
            }}>{t('common.confirm')}</Button>
        </div>
        {/* PDF Import Summary Modal - shown immediately after import */}
        {importSummaryModal && importSummaryModal.team === 'home' && (
          <Modal
            title={t('matchSetup.modals.homeTeamImportComplete')}
            open={true}
            onClose={() => setImportSummaryModal(null)}
            width={400}
          >
            <div className="p-5">
              <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="mb-1 text-2xl font-bold tabular-nums text-emerald-800">
                  {t('matchSetup.modals.playersCount', { count: importSummaryModal.players })}
                </div>
                <div className="text-sm text-stone-600">
                  {t('matchSetup.modals.successfullyImported')}
                </div>
                {importSummaryModal.benchOfficials > 0 && (
                  <div className="mt-2 text-xs text-stone-500">
                    {importSummaryModal.benchOfficials > 1 ? t('matchSetup.modals.benchOfficialsCountPlural', { count: importSummaryModal.benchOfficials }) : t('matchSetup.modals.benchOfficialsCount', { count: importSummaryModal.benchOfficials })}
                  </div>
                )}
              </div>
              <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <div className="text-xs font-semibold text-amber-800">
                  {t('matchSetup.modals.reviewImportedData')}
                </div>
                <ul className="mt-2 mb-0 list-disc pl-5 text-xs leading-relaxed text-stone-600">
                  <li>{t('matchSetup.modals.reviewAddBenchOfficials')}</li>
                  <li>{t('matchSetup.modals.reviewVerifyDob')}</li>
                  <li>{t('matchSetup.modals.reviewSetCaptainLibero')}</li>
                </ul>
              </div>
              <Button variant="dark" size="xl" block onClick={() => setImportSummaryModal(null)}>
                {t('common.ok')}
              </Button>
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
            <div className="p-6 text-center">
              {noticeModal.syncing && (
                <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-stone-400" aria-hidden="true" />
              )}
              {!noticeModal.syncing && noticeModal.type === 'success' && (
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl font-bold text-emerald-700">✓</div>
              )}
              {!noticeModal.syncing && noticeModal.type === 'error' && (
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-2xl font-bold text-red-700">✕</div>
              )}
              <p className="mb-6 whitespace-pre-line text-sm text-stone-700">
                {noticeModal.message}
              </p>
              {!noticeModal.syncing && (
                <div className="flex justify-center gap-3">
                  <Button
                    variant={noticeModal.type === 'success' ? 'positive' : noticeModal.type === 'error' ? 'danger' : 'dark'}
                    size="xl"
                    className="min-w-24"
                    onClick={() => setNoticeModal(null)}
                  >
                    OK
                  </Button>
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
            <div className="max-h-[70vh] overflow-y-auto p-4">
              {(() => {
                const roster = rosterPreview === 'home' ? match?.pendingHomeRoster : match?.pendingAwayRoster
                if (!roster) return <p>{t('matchSetup.noRosterFound')}</p>
                return (
                  <>
                    <SectionHeader title={t('matchSetup.playersCount')} count={roster.players?.length || 0} className="mb-2" />
                    <div style={{ marginBottom: '16px' }}>
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="border-b border-stone-200 text-[11px] font-bold uppercase tracking-wide text-stone-500">
                            <th className="px-2 py-2 text-left">#</th>
                            <th className="px-2 py-2 text-left">{t('rosterSetup.lastName')}</th>
                            <th className="px-2 py-2 text-left">{t('rosterSetup.firstName')}</th>
                            <th className="px-2 py-2 text-center">L</th>
                            <th className="px-2 py-2 text-center">C</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(roster.players || []).map((p, i) => (
                            <tr key={i} className="border-b border-stone-100 last:border-0">
                              <td className="px-2 py-1.5 font-semibold tabular-nums text-stone-900">{p.number}</td>
                              <td className="px-2 py-1.5 text-stone-800">{p.lastName || ''}</td>
                              <td className="px-2 py-1.5 text-stone-800">{p.firstName || ''}</td>
                              <td className="px-2 py-1.5 text-center text-stone-800">{p.libero ? 'L' : ''}</td>
                              <td className="px-2 py-1.5 text-center text-stone-800">{p.isCaptain ? 'C' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {roster.bench && roster.bench.length > 0 && (
                      <>
                        <SectionHeader title={t('matchSetup.benchOfficialsCount')} count={roster.bench.length} className="mt-4 mb-2" />
                        <div>
                          <table className="w-full border-collapse text-sm">
                            <thead>
                              <tr className="border-b border-stone-200 text-[11px] font-bold uppercase tracking-wide text-stone-500">
                                <th className="px-2 py-2 text-left">{t('rosterSetup.role')}</th>
                                <th className="px-2 py-2 text-left">{t('rosterSetup.lastName')}</th>
                                <th className="px-2 py-2 text-left">{t('rosterSetup.firstName')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {roster.bench.map((b, i) => (
                                <tr key={i} className="border-b border-stone-100 last:border-0">
                                  <td className="px-2 py-1.5 text-stone-800">{b.role || ''}</td>
                                  <td className="px-2 py-1.5 text-stone-800">{b.lastName || ''}</td>
                                  <td className="px-2 py-1.5 text-stone-800">{b.firstName || ''}</td>
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
              <div className="mt-4 flex justify-center">
                <Button variant="secondary" size="xl" onClick={() => setRosterPreview(null)}>
                  {t('common.close')}
                </Button>
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
            <div className="p-5 text-center">
              <p className="mb-6 text-sm text-stone-700">
                {t('roster.confirmLoadTestRosterMessage', { team: TEST_HOME_TEAM.name })}
              </p>
              <div className="flex justify-center gap-3">
                <Button variant="secondary" size="xl" onClick={() => setTestRosterConfirm(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="dark"
                  size="xl"
                  onClick={() => {
                    setHomeRoster([...TEST_HOME_TEAM.players].sort((a, b) => a.number - b.number))
                    setBenchHome(TEST_HOME_BENCH)
                    if (!home || home === 'Home') setHome(TEST_HOME_TEAM.name)
                    if (!homeShortName) setHomeShortName(TEST_HOME_TEAM.shortName)
                    setTestRosterConfirm(null)
                  }}
                >
                  {t('roster.loadTestRoster')}
                </Button>
              </div>
            </div>
          </Modal>
        )}

        {/* SignaturePad for home team view */}
        <SignaturePad
          open={openSignature !== null}
          onClose={() => setOpenSignature(null)}
          onSave={handleSignatureSave}
          title={openSignature === 'home-coach' ? 'Home coach signature' :
            openSignature === 'home-captain' ? 'Home captain signature' :
              openSignature === 'away-coach' ? 'Away coach signature' :
                openSignature === 'away-captain' ? 'Away captain signature' : 'Sign'}
        />
      </MatchSetupHomeTeamView>
    )
  }

  if (currentView === 'away') {
    return (
      <MatchSetupAwayTeamView kitScale={kitScale}>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div>
            <Button variant="ghost" size="xl" className="bg-white" onClick={() => { restoreAwayTeam(); setCurrentView('main') }}>← {t('common.back')}</Button>
          </div>
          <h2 className="m-0 text-base font-semibold text-stone-700">{away || t('matchSetup.awayTeam')}</h2>
          <div />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="m-0 text-xl sm:text-2xl font-bold tracking-tight text-stone-900">{t('roster.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger-soft"
              size="xl"
              onClick={() => {
                setAwayRoster([])
                setBenchAway([{ role: 'Coach', firstName: '', lastName: '', dob: '' }])
                setAwayCoachSignature(null)
                setAwayCaptainSignature(null)
                  }}
                >
                  {t('roster.deleteRoster')}
                </Button>
                <Button variant="dark" size="xl" onClick={() => setTestRosterConfirm('away')}>
                  {t('roster.loadTestRoster')}
                </Button>
          </div>
        </div>
        {/* Upload Methods for Away Team + Player Stats */}
        <div className="flex gap-3">
          {/* Left: Upload section */}
          <div className="flex-1 rounded-xl border border-stone-200 bg-stone-50/60 p-3">
            <div className="flex flex-col gap-2">
              {/* Upload button row with Local/Remote toggle */}
              <div className="flex items-center gap-2">
                <input
                  ref={awayFileInputRef}
                  type="file"
                  accept=".pdf"
                  onChange={handleAwayFileSelect}
                  style={{ display: 'none' }}
                />
                <Button
                  variant="secondary"
                  size="xl"
                  onClick={() => {
                    if (awayUploadMode === 'local') {
                      awayFileInputRef.current?.click()
                    } else {
                      handleSearchAwayRoster()
                    }
                  }}
                  disabled={awayPdfLoading || awayRosterSearching}
                    className="flex-1"
                  >
                  {awayUploadMode === 'local' ? t('matchSetup.uploadPdf') : (awayRosterSearching ? t('common.loading') : t('matchSetup.searchForRoster'))}
                  </Button>
                {/* Local/Remote Toggle */}
                <SegmentedControl
                  ariaLabel={t('matchSetup.uploadPdf')}
                  className="w-44 shrink-0 [&_button]:p-0"
                  value={awayUploadMode}
                  onChange={setAwayUploadMode}
                  options={[
                    { value: 'local', label: t('matchSetup.local') },
                    { value: 'remote', label: t('matchSetup.remote') }
                  ]}
                />
              </div>
              {/* Local upload - file selected */}
              {awayUploadMode === 'local' && awayPdfFile && (
                <>
                  <span className="truncate text-xs text-stone-700">
                    {awayPdfFile.name}
                  </span>
                  <Button
                    variant="primary"
                    size="xl"
                    block
                    onClick={handleAwayImportClick}
                    loading={awayPdfLoading}
                  >
                    {awayPdfLoading ? t('matchSetup.importing') : t('matchSetup.importPdf')}
                  </Button>
                </>
              )}
              {awayUploadMode === 'local' && awayPdfError && (
                <span className="text-xs font-medium text-red-600">
                  {awayPdfError}
                </span>
              )}
              {/* Remote Upload */}
              {awayUploadMode === 'remote' && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-stone-500">{t('matchSetup.gameNumber')}:</span>
                    <span className="font-mono text-sm font-semibold tabular-nums text-stone-900">
                      {match?.game_n || match?.gameNumber || gameN || 'N/A'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-stone-500">{t('matchSetup.uploadPin')}:</span>
                    {match?.awayTeamUploadPin ? (
                      <>
                        <span className="font-mono text-base font-bold tracking-[0.3em] text-stone-900">
                          {match.awayTeamUploadPin}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="bg-white"
                          onClick={() => regenerateUploadPin('away')}
                          >
                            {t('matchSetup.regenerate')}
                          </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="bg-white"
                        onClick={() => regenerateUploadPin('away')}
                        >
                          {t('matchSetup.generatePin')}
                        </Button>
                    )}
                  </div>
                  {match?.pendingAwayRoster && (
                    <div className="mt-3 rounded-xl border border-sky-200 bg-white p-3">
                      <h4 className="mt-0 mb-2 text-sm font-semibold text-stone-800">{t('matchSetup.rosterUploaded')}</h4>
                      <div className="mb-3 flex flex-col gap-1 text-xs text-stone-600">
                        <div>
                          {t('matchSetup.playersCount')}: {match.pendingAwayRoster.players?.length || 0}
                        </div>
                        <div>
                          {t('matchSetup.benchOfficialsCount')}: {match.pendingAwayRoster.bench?.length || 0}
                        </div>
                      </div>
                      <div className="mb-2 flex gap-2">
                        <Button variant="secondary" size="xl" className="flex-1" onClick={() => setRosterPreview('away')}>
                          {t('matchSetup.previewRoster')}
                        </Button>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="positive"
                          size="xl"
                          className="flex-1"
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
                            await clearServerPendingRoster('away')
                          }}
                          >
                            {t('matchSetup.acceptRoster')}
                          </Button>
                          <Button
                            variant="secondary"
                            size="xl"
                            className="flex-1"
                            onClick={async () => {
                              if (!matchId) return
                              await db.matches.update(matchId, { pendingAwayRoster: null })
                              await clearServerPendingRoster('away')
                            }}
                          >
                            {t('matchSetup.rejectRoster')}
                          </Button>
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
              <div className={cn(
                'flex flex-1 items-center justify-center gap-4 rounded-xl border p-3',
                awayHasError ? 'border-red-200 bg-red-50' : 'border-stone-200 bg-stone-50/60'
              )}>
                <div className="flex items-baseline gap-1.5">
                  <span className={cn('text-sm font-medium', awayNonLiberoCount < 6 ? 'text-red-700' : 'text-stone-500')}>{t('matchSetup.players')}:</span>
                  <span className={cn('text-lg font-bold tabular-nums', awayNonLiberoCount < 6 ? 'text-red-700' : 'text-stone-900')}>{awayRoster.length}</span>
                  <span className={cn('text-sm tabular-nums', awayNonLiberoCount < 6 ? 'text-red-700' : 'text-stone-500')}>
                    ({awayNonLiberoCount} + {awayRoster.filter(p => p.libero).length} {awayRoster.filter(p => p.libero).length !== 1 ? 'liberos' : 'libero'})
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={cn('text-sm font-medium', !awayCaptain ? 'text-red-700' : 'text-stone-500')}>{t('matchSetup.captain')}:</span>
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
                    <span className="text-sm text-red-700">—</span>
                  )}
                </div>
              </div>
            )
          })()}
        </div>
        {/* Add new player section */}
        {awayRoster.length < 14 && (
          <div className="mx-auto w-max rounded-xl border border-stone-200 bg-stone-50/60 p-3">
            <div className="mb-2 text-center text-[11px] font-bold uppercase tracking-wide text-stone-500">{t('matchSetup.addNewPlayer')}</div>
            <div className={`roster-grid${lfpTrackingEnabled ? ' has-lfp' : ''}`} style={{ width: 'max-content', margin: '0 auto' }}>
              <div className="roster-grid-row" style={{ border: 'none' }}>
                <div></div>
                <input
                  aria-label={t('matchSetup.playerNumber', 'Player number')}
                  placeholder={t('matchSetup.numberPlaceholder')}
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="99"
                  value={awayNum}
                  onChange={e => setAwayNum(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                />
                <input aria-label={t('matchSetup.lastName')} className="capitalize" placeholder={t('matchSetup.lastName')} value={awayLast} onChange={e => setAwayLast(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <input aria-label={t('matchSetup.firstName')} className="capitalize" placeholder={t('matchSetup.firstName')} value={awayFirst} onChange={e => setAwayFirst(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <input aria-label={t('matchSetup.dateOfBirth')} placeholder={t('matchSetup.dateOfBirthPlaceholder')} type="date" value={awayDob ? formatDateToISO(awayDob) : ''} onChange={e => setAwayDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <select aria-label={t('matchSetup.libero', 'Libero')} value={awayLibero} onChange={e => {
                  let newValue = e.target.value
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
                <div className="cell-captain">
                  <div
                    onClick={() => setAwayCaptain(!awayCaptain)}
                    style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: '4px',
                      border: awayCaptain ? '2px solid #22c55e' : '2px solid var(--border)',
                      background: awayCaptain ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: 700,
                      color: awayCaptain ? '#22c55e' : 'var(--muted)',
                      userSelect: 'none'
                    }}
                  >C</div>
                </div>
                {lfpTrackingEnabled && (
                  <div className="cell-captain">
                    <div
                      onClick={() => setAwayLfp(!awayLfp)}
                      style={{
                        width: '24px',
                        height: '24px',
                        borderRadius: '4px',
                        border: awayLfp ? '2px solid #f97316' : '2px solid var(--border)',
                        background: awayLfp ? 'rgba(249, 115, 22, 0.15)' : 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: '10px',
                        fontWeight: 700,
                        color: awayLfp ? '#f97316' : 'var(--muted)',
                        userSelect: 'none'
                      }}
                    >{awayLfp ? 'LFP' : '\u2014'}</div>
                  </div>
                )}
                <div className="cell-action">
                  <Button variant="secondary" size="md" onClick={() => {
                    if (!awayLast || !awayFirst) return
                    const newPlayer = { number: awayNum ? Number(awayNum) : null, lastName: awayLast, firstName: awayFirst, dob: awayDob, libero: awayLibero, isCaptain: awayCaptain, isLfp: awayLfp }
                    setAwayRoster(list => {
                      const cleared = awayCaptain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                      const next = [...cleared, newPlayer].sort((a, b) => {
                        const an = a.number ?? 999
                        const bn = b.number ?? 999
                        return an - bn
                      })
                      return next
                    })
                    setAwayNum(''); setAwayFirst(''); setAwayLast(''); setAwayDob(''); setAwayLibero(''); setAwayCaptain(false); setAwayLfp(false)
                  }}>{t('common.add')}</Button>
                </div>
              </div>
            </div>
          </div>
        )}
        <div className={cn('roster-grid', lfpTrackingEnabled && 'has-lfp', ROSTER_TABLE)}>
          {/* Roster Header Row */}
          <div className={cn('roster-grid-row grid-header', ROSTER_TABLE_HEAD)}>
            <div></div>
            <div style={{ textAlign: 'center' }}>#</div>
            <div>{t('matchSetup.lastName')}</div>
            <div>{t('matchSetup.firstName')}</div>
            <div>{t('matchSetup.dateOfBirth')}</div>
            <div style={{ textAlign: 'center' }}>{t('matchSetup.roleLibero')}</div>
            <div className="cell-captain">C</div>
            {lfpTrackingEnabled && <div style={{ textAlign: 'center' }}>LFP</div>}
            <div></div>
          </div>
          {(() => {
            const awayLiberoCount = awayRoster.filter(pl => pl.libero).length
            return awayRoster.map((p, i) => {
            const isDuplicate = p.number != null && p.number !== '' &&
              awayRoster.some((other, idx) => idx !== i && other.number === p.number)

            const isCaptain = p.isCaptain || false
            const isLibero = !!p.libero
            let borderStyle = {}
            if (isCaptain && isLibero) {
              borderStyle = {
                background: 'rgba(34, 197, 94, 0.05)',
                border: '2px solid',
                borderImage: 'repeating-linear-gradient(90deg, #22c55e 0, #22c55e 6px, #ffffff 6px, #ffffff 12px) 1'
              }
            } else if (isCaptain) {
              borderStyle = {
                border: '2px solid #22c55e',
                background: 'rgba(34, 197, 94, 0.1)'
              }
            } else if (isLibero) {
              borderStyle = {
                border: '2px solid var(--border)',
                background: 'var(--panel-2)'
              }
            }

            return (
              <div key={`a-${i}`} className="roster-grid-row" style={borderStyle}>
                <div className={`roster-badge${isCaptain ? ' badge-captain' : isLibero ? ' badge-libero' : ''}`}>
                  {isCaptain ? 'C' : p.libero === 'libero1' ? (awayLiberoCount > 1 ? 'L1' : 'L') : p.libero === 'libero2' ? (awayLiberoCount > 1 ? 'L2' : 'L') : ''}
                </div>
                <input
                  aria-label={t('matchSetup.playerNumber', 'Player number')}
                  placeholder="#"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="99"
                  value={p.number ?? ''}
                  className={isDuplicate ? 'border-red-400 bg-red-50 text-red-700' : undefined}
                  aria-invalid={isDuplicate || undefined}
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
                    const sorted = [...awayRoster].sort((a, b) => (a.number || 0) - (b.number || 0))
                    setAwayRoster(sorted)
                  }}
                />
                <input
                  aria-label={t('matchSetup.lastName')}
                  className="capitalize"
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
                  aria-label={t('matchSetup.firstName')}
                  className="capitalize"
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
                  aria-label={t('matchSetup.dateOfBirth')}
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
                  aria-label={t('matchSetup.libero', 'Libero')}
                  value={p.libero || ''}
                  onChange={async e => {
                    const updated = [...awayRoster]
                    const oldValue = updated[i].libero
                    updated[i] = { ...updated[i], libero: e.target.value }

                    if (e.target.value === 'libero2') {
                      const hasL1 = updated.some((player, idx) => idx !== i && player.libero === 'libero1')
                      if (!hasL1) {
                        updated[i] = { ...updated[i], libero: 'libero1' }
                      }
                    }

                    if (oldValue === 'libero1' && !e.target.value) {
                      const l2Idx = updated.findIndex((player, idx) => idx !== i && player.libero === 'libero2')
                      if (l2Idx !== -1) {
                        updated[l2Idx] = { ...updated[l2Idx], libero: 'libero1' }
                        if (updated[l2Idx].id) {
                          await db.players.update(updated[l2Idx].id, { libero: 'libero1' })
                        }
                      }
                    }

                    setAwayRoster(updated)

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
                <div className="cell-captain">
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
                      border: (p.isCaptain || false) ? '2px solid #22c55e' : '2px solid var(--border)',
                      background: (p.isCaptain || false) ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: 700,
                      color: (p.isCaptain || false) ? '#22c55e' : 'var(--muted)',
                      userSelect: 'none'
                    }}
                  >C</div>
                </div>
                {lfpTrackingEnabled && (
                  <div className="cell-captain">
                    <div
                      onClick={() => {
                        const updated = [...awayRoster]
                        updated[i] = { ...updated[i], isLfp: !p.isLfp }
                        setAwayRoster(updated)
                      }}
                      style={{
                        width: '24px',
                        height: '24px',
                        borderRadius: '4px',
                        border: p.isLfp ? '2px solid #f97316' : '2px solid var(--border)',
                        background: p.isLfp ? 'rgba(249, 115, 22, 0.15)' : 'transparent',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: '10px',
                        fontWeight: 700,
                        color: p.isLfp ? '#f97316' : 'var(--muted)',
                        userSelect: 'none'
                      }}
                    >{p.isLfp ? 'LFP' : '\u2014'}</div>
                  </div>
                )}
                <div className="cell-action">
                  <Button variant="danger-outline" size="md" onClick={() => setAwayRoster(list => list.filter((_, idx) => idx !== i))}>
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            )
            })
          })()}
        </div>
        <div className="mt-4">
          <SectionHeader as="h4" title={`${t('matchSetup.benchOfficials')} — ${t('common.away')}`} />
        </div>
        <div className={cn('bench-grid', ROSTER_TABLE)}>
          {/* Bench Header Row */}
          <div className={cn('bench-grid-row grid-header', ROSTER_TABLE_HEAD)}>
            <div>{t('matchSetup.role')}</div>
            <div>{t('matchSetup.lastName')}</div>
            <div>{t('matchSetup.firstName')}</div>
            <div>{t('matchSetup.dateOfBirth')}</div>
            <div></div>
          </div>
          {sortBenchByHierarchy(benchAway).map((m, i) => {
            const originalIdx = benchAway.findIndex(b => b === m)
            return (
              <div key={`ba-${originalIdx}`} className="bench-grid-row">
                <select aria-label={t('matchSetup.role')} value={m.role || 'Coach'} onChange={e => {
                  const newRole = e.target.value || 'Coach'
                  const isRoleTaken = benchAway.some((b, idx) => idx !== originalIdx && b.role === newRole)
                  if (isRoleTaken) return
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
                <input aria-label={t('matchSetup.lastName')} className="capitalize" placeholder={t('matchSetup.lastName')} value={m.lastName} onChange={e => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], lastName: e.target.value }; return a })} />
                <input aria-label={t('matchSetup.firstName')} className="capitalize" placeholder={t('matchSetup.firstName')} value={m.firstName} onChange={e => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], firstName: e.target.value }; return a })} />
                <input aria-label={t('matchSetup.dateOfBirth')} placeholder={t('matchSetup.dateOfBirthPlaceholder')} type="date" value={m.dob ? formatDateToISO(m.dob) : ''} onChange={e => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], dob: e.target.value ? formatDateToDDMMYYYY(e.target.value) : '' }; return a })} />
                <div className="cell-action">
                  <Button variant="danger-outline" size="md" onClick={() => {
                    const updated = benchAway.filter((_, idx) => idx !== originalIdx)
                    setBenchAway(updated)
                    setTimeout(() => saveDraft(true), 100)
                    }}>
                      {t('common.delete')}
                    </Button>
                </div>
              </div>
            )
          })}
          <div className="bench-grid-row" style={{ border: 'none', padding: 0, display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Button
              variant="ghost"
              size="md"
              className="bg-white"
              disabled={benchAway.length >= 5}
              onClick={() => {
                const takenRoles = new Set(benchAway.map(b => b.role))
                const availableRole = BENCH_ROLES.find(r => !takenRoles.has(r.value))
                if (availableRole) {
                  setBenchAway([...benchAway, initBench(availableRole.value)])
                }
              }}
              >
                {t('matchSetup.addBenchOfficial')}
              </Button>
            {benchAway.length >= 5 && (
              <WarningIndicator id="addBenchAway" missingItems={[t('warnings.maxBenchOfficials')]} />
            )}
          </div>
        </div>

        {/* Signatures Section */}
        <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50/60 p-4">
          <h4 className="text-sm font-semibold text-stone-800">
            {t('rosterSetup.signatures', 'Signatures')}
          </h4>
          <p className="mt-1 mb-4 text-xs text-stone-500">
            {t('rosterSetup.signaturesDescription', 'Optional: Coach and captain can sign the roster before the coin toss.')}
          </p>
          <div className="flex flex-wrap gap-4">
            {/* Coach Signature */}
            <div className="min-w-[150px] flex-1">
              <div className="mb-1.5 text-xs font-medium text-stone-600">
                {t('rosterSetup.coachSignature', 'Coach signature')}
              </div>
              <div
                onClick={() => setOpenSignature('away-coach')}
                className={cn(
                  'flex h-20 w-full cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 transition-colors',
                  awayCoachSignature ? 'border-emerald-400 bg-white' : 'border-dashed border-stone-300 bg-stone-50 hover:bg-stone-100'
                )}
              >
                {awayCoachSignature ? (
                  <img src={awayCoachSignature} alt={t('matchSetup.coachSignature')} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                ) : (
                  <span className="text-xs text-stone-500">
                    {t('rosterSetup.tapToSign', 'Tap to sign')}
                  </span>
                )}
              </div>
              {awayCoachSignature && (
                <Button
                  variant="danger-outline"
                  size="sm"
                  className="mt-1.5"
                  onClick={(e) => { e.stopPropagation(); setAwayCoachSignature(null); }}
                >
                  {t('common.clear', 'Clear')}
                </Button>
              )}
            </div>

            {/* Captain Signature */}
            <div className="min-w-[150px] flex-1">
              <div className="mb-1.5 text-xs font-medium text-stone-600">
                {t('rosterSetup.captainSignature', 'Captain signature')}
              </div>
              <div
                onClick={() => setOpenSignature('away-captain')}
                className={cn(
                  'flex h-20 w-full cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 transition-colors',
                  awayCaptainSignature ? 'border-emerald-400 bg-white' : 'border-dashed border-stone-300 bg-stone-50 hover:bg-stone-100'
                )}
              >
                {awayCaptainSignature ? (
                  <img src={awayCaptainSignature} alt={t('matchSetup.captainSignature')} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                ) : (
                  <span className="text-xs text-stone-500">
                    {t('rosterSetup.tapToSign', 'Tap to sign')}
                  </span>
                )}
              </div>
              {awayCaptainSignature && (
                <Button
                  variant="danger-outline"
                  size="sm"
                  className="mt-1.5"
                  onClick={(e) => { e.stopPropagation(); setAwayCaptainSignature(null); }}
                >
                  {t('common.clear', 'Clear')}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="positive" size="xl" onClick={async () => {

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
                  const { data: supabaseMatch } = await apiFrom('matches')
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

                    await apiFrom('match_live_state')
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

              // Poll to check when sync completes
              setNoticeModal({ message: t('matchSetup.awaySaved'), type: 'success', syncing: true })
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
            }}>{t('common.confirm')}</Button>
        </div>
        {/* PDF Import Summary Modal - shown immediately after import */}
        {importSummaryModal && importSummaryModal.team === 'away' && (
          <Modal
            title={t('matchSetup.modals.awayTeamImportComplete')}
            open={true}
            onClose={() => setImportSummaryModal(null)}
            width={400}
          >
            <div className="p-5">
              <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="mb-1 text-2xl font-bold tabular-nums text-emerald-800">
                  {t('matchSetup.modals.playersCount', { count: importSummaryModal.players })}
                </div>
                <div className="text-sm text-stone-600">
                  {t('matchSetup.modals.successfullyImported')}
                </div>
                {importSummaryModal.benchOfficials > 0 && (
                  <div className="mt-2 text-xs text-stone-500">
                    {importSummaryModal.benchOfficials > 1 ? t('matchSetup.modals.benchOfficialsCountPlural', { count: importSummaryModal.benchOfficials }) : t('matchSetup.modals.benchOfficialsCount', { count: importSummaryModal.benchOfficials })}
                  </div>
                )}
              </div>
              <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <div className="text-xs font-semibold text-amber-800">
                  {t('matchSetup.modals.reviewImportedData')}
                </div>
                <ul className="mt-2 mb-0 list-disc pl-5 text-xs leading-relaxed text-stone-600">
                  <li>{t('matchSetup.modals.reviewAddBenchOfficials')}</li>
                  <li>{t('matchSetup.modals.reviewVerifyDob')}</li>
                  <li>{t('matchSetup.modals.reviewSetCaptainLibero')}</li>
                </ul>
              </div>
              <Button variant="dark" size="xl" block onClick={() => setImportSummaryModal(null)}>
                {t('common.ok')}
              </Button>
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
            <div className="p-6 text-center">
              {noticeModal.syncing && (
                <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-stone-400" aria-hidden="true" />
              )}
              {!noticeModal.syncing && noticeModal.type === 'success' && (
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl font-bold text-emerald-700">✓</div>
              )}
              {!noticeModal.syncing && noticeModal.type === 'error' && (
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-2xl font-bold text-red-700">✕</div>
              )}
              <p className="mb-6 whitespace-pre-line text-sm text-stone-700">
                {noticeModal.message}
              </p>
              {!noticeModal.syncing && (
                <div className="flex justify-center gap-3">
                  <Button
                    variant={noticeModal.type === 'success' ? 'positive' : noticeModal.type === 'error' ? 'danger' : 'dark'}
                    size="xl"
                    className="min-w-24"
                    onClick={() => setNoticeModal(null)}
                  >
                    OK
                  </Button>
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
            <div className="max-h-[70vh] overflow-y-auto p-4">
              {(() => {
                const roster = rosterPreview === 'home' ? match?.pendingHomeRoster : match?.pendingAwayRoster
                if (!roster) return <p>{t('matchSetup.noRosterFound')}</p>
                return (
                  <>
                    <SectionHeader title={t('matchSetup.playersCount')} count={roster.players?.length || 0} className="mb-2" />
                    <div style={{ marginBottom: '16px' }}>
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="border-b border-stone-200 text-[11px] font-bold uppercase tracking-wide text-stone-500">
                            <th className="px-2 py-2 text-left">#</th>
                            <th className="px-2 py-2 text-left">{t('rosterSetup.lastName')}</th>
                            <th className="px-2 py-2 text-left">{t('rosterSetup.firstName')}</th>
                            <th className="px-2 py-2 text-center">L</th>
                            <th className="px-2 py-2 text-center">C</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(roster.players || []).map((p, i) => (
                            <tr key={i} className="border-b border-stone-100 last:border-0">
                              <td className="px-2 py-1.5 font-semibold tabular-nums text-stone-900">{p.number}</td>
                              <td className="px-2 py-1.5 text-stone-800">{p.lastName || ''}</td>
                              <td className="px-2 py-1.5 text-stone-800">{p.firstName || ''}</td>
                              <td className="px-2 py-1.5 text-center text-stone-800">{p.libero ? 'L' : ''}</td>
                              <td className="px-2 py-1.5 text-center text-stone-800">{p.isCaptain ? 'C' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {roster.bench && roster.bench.length > 0 && (
                      <>
                        <SectionHeader title={t('matchSetup.benchOfficialsCount')} count={roster.bench.length} className="mt-4 mb-2" />
                        <div>
                          <table className="w-full border-collapse text-sm">
                            <thead>
                              <tr className="border-b border-stone-200 text-[11px] font-bold uppercase tracking-wide text-stone-500">
                                <th className="px-2 py-2 text-left">{t('rosterSetup.role')}</th>
                                <th className="px-2 py-2 text-left">{t('rosterSetup.lastName')}</th>
                                <th className="px-2 py-2 text-left">{t('rosterSetup.firstName')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {roster.bench.map((b, i) => (
                                <tr key={i} className="border-b border-stone-100 last:border-0">
                                  <td className="px-2 py-1.5 text-stone-800">{b.role || ''}</td>
                                  <td className="px-2 py-1.5 text-stone-800">{b.lastName || ''}</td>
                                  <td className="px-2 py-1.5 text-stone-800">{b.firstName || ''}</td>
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
              <div className="mt-4 flex justify-center">
                <Button variant="secondary" size="xl" onClick={() => setRosterPreview(null)}>
                  {t('common.close')}
                </Button>
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
            <div className="p-5 text-center">
              <p className="mb-6 text-sm text-stone-700">
                {t('roster.confirmLoadTestRosterMessage', { team: TEST_AWAY_TEAM.name })}
              </p>
              <div className="flex justify-center gap-3">
                <Button variant="secondary" size="xl" onClick={() => setTestRosterConfirm(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="dark"
                  size="xl"
                  onClick={() => {
                    setAwayRoster([...TEST_AWAY_TEAM.players].sort((a, b) => a.number - b.number))
                    setBenchAway(TEST_AWAY_BENCH)
                    if (!away || away === 'Away') setAway(TEST_AWAY_TEAM.name)
                    if (!awayShortName) setAwayShortName(TEST_AWAY_TEAM.shortName)
                    setTestRosterConfirm(null)
                  }}
                >
                  {t('roster.loadTestRoster')}
                </Button>
              </div>
            </div>
          </Modal>
        )}

        {/* SignaturePad for away team view */}
        <SignaturePad
          open={openSignature !== null}
          onClose={() => setOpenSignature(null)}
          onSave={handleSignatureSave}
          title={openSignature === 'home-coach' ? 'Home coach signature' :
            openSignature === 'home-captain' ? 'Home captain signature' :
              openSignature === 'away-coach' ? 'Away coach signature' :
                openSignature === 'away-captain' ? 'Away captain signature' : 'Sign'}
        />
      </MatchSetupAwayTeamView>
    )
  }

  // Setup card state: a round mark with a symbol and a word (aria-label/title).
  // emerald = done, sky = ready to confirm, amber = needs a decision.
  const StatusBadge = ({ ready, pending }) => (
    <span
      className={cn(
        'mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold leading-none',
        ready ? 'bg-emerald-700 text-white' : pending ? 'bg-sky-600 text-white' : 'border border-amber-300 bg-amber-100 text-amber-800'
      )}
      aria-label={ready ? t('scoreboard.complete') : pending ? t('scoreboard.readyToConfirm') : t('scoreboard.incomplete')}
      title={ready ? t('scoreboard.complete') : pending ? t('scoreboard.readyToConfirm') : t('scoreboard.incomplete')}
    >
      {ready ? '✓' : pending ? '●' : '!'}
    </span>
  )

  // Sync status indicator for cards - green=synced, yellow=syncing, red=error, gray=not synced
  // Hidden if offline mode. A kit status pill: tinted round pill, dot + word.
  const SyncStatusIndicator = ({ status, onRetry }) => {
    if (offlineMode) return null

    const tones = {
      synced: { pill: 'border-emerald-200 bg-emerald-50 text-emerald-800', dot: 'bg-emerald-500' },
      syncing: { pill: 'border-amber-200 bg-amber-50 text-amber-800', dot: 'bg-amber-500 animate-pulse' },
      error: { pill: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' },
      idle: { pill: 'border-stone-200 bg-stone-100 text-stone-600', dot: 'bg-stone-400' }
    }
    const labels = {
      synced: t('matchSetup.syncStatus.synced', 'Synced'),
      syncing: t('matchSetup.syncStatus.syncing', 'Syncing...'),
      error: t('matchSetup.syncStatus.error', 'Sync error'),
      idle: isSupabaseAvailable ? t('matchSetup.syncStatus.notSynced') : t('matchSetup.syncStatus.offline', 'Offline')
    }
    const c = tones[status] || tones.synced
    const retry = status !== 'synced' && onRetry

    return (
      <div
        onClick={retry ? onRetry : undefined}
        className={cn(
          'relative inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium whitespace-nowrap transition-colors',
          retry && "before:absolute before:-inset-y-2.5 before:inset-x-0 before:content-['']",
          c.pill,
          retry ? 'cursor-pointer hover:brightness-95' : 'cursor-default'
        )}
        title={status !== 'synced' ? t('matchSetup.syncStatus.clickToRetry', 'Click to retry sync') : ''}
      >
        <span className={cn('inline-block h-1.5 w-1.5 rounded-full', c.dot)} />
        <span>{labels[status]}</span>
      </div>
    )
  }

  // Officials are complete if at least 1st referee and scorer are filled
  // 2nd referee and assistant scorer are optional
  const officialsConfigured =
    !!(ref1Last && ref1First && scorerLast && scorerFirst && scorerDob && scorerDob !== '01.01.1900')
  const matchInfoConfigured = !!(date || time || hall || city || league)
  // Basic roster configured (enough for saving)
  const homeRosterExists = !!(home && homeRoster.length >= 6 && homeCounts.liberos >= 0)
  const awayRosterExists = !!(away && awayRoster.length >= 6 && awayCounts.liberos >= 0)

  // Roster validation for proceeding to coin toss (requires captain and coach)
  // Note: all players having numbers is only required when CONFIRMING coin toss, not proceeding to it
  const homeConfigured = homeRosterExists && homeCounts.hasCaptain && homeCounts.hasCoach && homeCounts.liberosOk
  const awayConfigured = awayRosterExists && awayCounts.hasCaptain && awayCounts.hasCoach && awayCounts.liberosOk

  // All 4 cards must be complete before proceeding to coin toss
  const canProceedToCoinToss = matchInfoConfirmed && officialsConfigured && homeConfigured && awayConfigured

  // Returns missing items for the "Proceed to Coin Toss" button (for WarningIndicator)
  const getCoinTossMissingItems = () => {
    const missing = []
    if (!matchInfoConfirmed) missing.push(t('warnings.matchInfoNotConfirmed'))
    if (!officialsConfigured) {
      if (!ref1Last || !ref1First) missing.push(t('warnings.firstRefereeMissing'))
      if (!scorerLast || !scorerFirst) missing.push(t('warnings.scorerNameMissing'))
      if (!scorerDob || scorerDob === '01.01.1900') missing.push(t('warnings.scorerDobMissing'))
    }
    if (!homeConfigured) {
      if (!home || homeRoster.length < 6) missing.push(t('warnings.homeRosterIncomplete', { count: homeRoster.length }))
      else {
        if (!homeCounts.hasCaptain) missing.push(t('warnings.homeCaptainMissing'))
        if (!homeCounts.hasCoach) missing.push(t('warnings.homeCoachMissing'))
        if (!homeCounts.liberosOk) missing.push(t('warnings.homeTwoLiberosRequired', 'Home: 2 liberos required for more than 12 players'))
      }
    }
    if (!awayConfigured) {
      if (!away || awayRoster.length < 6) missing.push(t('warnings.awayRosterIncomplete', { count: awayRoster.length }))
      else {
        if (!awayCounts.hasCaptain) missing.push(t('warnings.awayCaptainMissing'))
        if (!awayCounts.hasCoach) missing.push(t('warnings.awayCoachMissing'))
        if (!awayCounts.liberosOk) missing.push(t('warnings.awayTwoLiberosRequired', 'Away: 2 liberos required for more than 12 players'))
      }
    }
    return missing
  }

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
    // Get all existing PINs to ensure uniqueness
    const allMatches = await db.matches.toArray()
    const existingPins = allMatches
      .map(m => [m.refereePin, m.homeTeamPin, m.awayTeamPin, m.homeTeamUploadPin, m.awayTeamUploadPin])
      .flat()
      .filter(Boolean)

    return generateSecurePin(existingPins)
  }

  // Sync match data to the relay (for when Scoreboard is not mounted), on the
  // scorer's one relay connection (App.jsx keeps it open) and under the seed
  // key only: a Dexie id is no relay room (relayMatchKey), and a socket of its
  // own would prove the match a second time. PINs as relayMatchPayload sends them.
  // If fullSync is true, fetches all data (teams, players, sets, events) from IndexedDB
  const syncMatchToServer = async (matchData, fullSync = false) => {
    const ws = scorerRelay.socket
    const relayKey = relayMatchKey(matchData)
    if (!ws || !scorerRelay.isOpen() || !relayKey) return

    try {
      const syncMark = scorerLiveOrder.mark()
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

      if (scorerRelay.socket !== ws) return
      const { match, commit } = scorerRelay.pins.payloadFor(ws, matchData, relayKey, syncMark)
      const sent = scorerRelay.send({
        type: 'sync-match-data',
        matchId: relayKey,
        match,
        homeTeam,
        awayTeam,
        homePlayers,
        awayPlayers,
        sets,
        events,
        _timestamp: Date.now()
      })
      if (sent) commit()
    } catch (error) {
      console.error('[MatchSetup] Failed to sync to server:', error)
    }
  }

  // Connection toggle handlers removed — now managed from Scoreboard Options (ConnectionSetupModal)

  // Dashboard Toggle Component - two rows: label+toggle on top, PIN below
  const DashboardToggle = ({ label, enabled, onToggle, pin }) => {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '8px 12px',
        background: enabled ? 'rgba(34, 197, 94, 0.1)' : 'var(--panel-2)',
        borderRadius: '8px',
        border: enabled ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid var(--border)',
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
        background: enabled ? 'rgba(34, 197, 94, 0.1)' : 'var(--panel-2)',
        borderRadius: '8px',
        border: enabled ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid var(--border)',
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
    <MatchSetupMainView kitScale={kitScale}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="m-0 text-xl sm:text-2xl font-bold tracking-tight text-stone-900">{t('matchSetup.title')}</h2>
          <Button variant="secondary" size="xl" onClick={openScoresheet} icon={<FileTextIcon size={16} />}>
            {t('matchSetup.scoresheet')}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {onOpenOptions && (
            <Button variant="secondary" size="xl" onClick={onOpenOptions}>
              {t('matchSetup.options')}
            </Button>
          )}
        </div>
      </div>
      <div className="setup-section">
        {/* Match Setup Summary Card */}
        <div
          data-help-id="setup-match-info-card"
          className={cn(
            'rounded-xl border bg-stone-50/60 p-4 sm:p-5',
            matchInfoConfirmed ? 'border-stone-200/70' : canConfirmMatchInfo ? 'border-2 border-sky-300' : 'border-2 border-amber-300'
          )}
        >
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusBadge ready={matchInfoConfirmed} pending={!matchInfoConfirmed && canConfirmMatchInfo} />
              <h3 className="m-0 text-base font-semibold text-stone-900">{t('matchSetup.matchInfo')}</h3>
              <SyncStatusIndicator status={matchInfoSyncStatus} onRetry={() => retrySyncForCard('matchInfo')} />
            </div>
            <div className="flex items-center gap-2">
              <SyncStatusIndicator status={officialsSyncStatus} onRetry={() => retrySyncForCard('officials')} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-3">
            {/* Column 1: Match Info */}
            <KeyValue variant="detail" className={SUMMARY_KV} items={[
              { label: t('matchSetup.date'), value: <span className={TRUNC}>{formatDisplayDate(date) || t('common.notSet')}</span> },
              { label: t('matchSetup.time'), value: <span className={TRUNC}>{formatDisplayTime(time) || t('common.notSet')}</span> },
              { label: t('matchSetup.city'), value: <span className={TRUNC} title={city}>{city || t('common.notSet')}</span> },
              { label: t('matchSetup.hall'), value: <span className={TRUNC} title={hall}>{hall || t('common.notSet')}</span> }
            ]} />

            {/* Column 2: Officials */}
            <KeyValue variant="detail" className={SUMMARY_KV} items={[
              { label: t('matchSetup.referee1'), value: <span className={TRUNC} title={formatOfficial(ref1Last, ref1First)}>{formatOfficial(ref1Last, ref1First)}</span> },
              { label: t('matchSetup.referee2'), value: <span className={TRUNC} title={formatOfficial(ref2Last, ref2First)}>{formatOfficial(ref2Last, ref2First)}</span> },
              { label: t('matchSetup.scorer'), value: <span className={TRUNC} title={formatOfficial(scorerLast, scorerFirst)}>{formatOfficial(scorerLast, scorerFirst)}</span> },
              { label: t('matchSetup.assistantScorer'), value: <span className={TRUNC} title={formatOfficial(asstLast, asstFirst)}>{formatOfficial(asstLast, asstFirst)}</span> },
              ...((lineJudge1 || lineJudge2 || lineJudge3 || lineJudge4) ? [{
                label: t('matchSetup.lineJudges'),
                value: (
                  <span className={TRUNC} title={[lineJudge1, lineJudge2, lineJudge3, lineJudge4].filter(Boolean).map(formatLineJudge).join(', ')}>
                    {[lineJudge1, lineJudge2, lineJudge3, lineJudge4].filter(Boolean).map(formatLineJudge).join(', ') || t('common.notSet')}
                  </span>
                )
              }] : [])
            ]} />

            {/* Column 3: Teams */}
            <KeyValue variant="detail" className={SUMMARY_KV} items={[
              { label: t('matchSetup.homeTeam'), value: <span className={cn(TRUNC, 'font-semibold text-stone-900')} title={home}>{home || t('common.notSet')}</span> },
              { label: t('matchSetup.awayTeam'), value: <span className={cn(TRUNC, 'font-semibold text-stone-900')} title={away}>{away || t('common.notSet')}</span> },
              { label: t('matchSetup.league'), value: <span className={TRUNC}>{league || t('common.notSet')}</span> },
              { label: t('matchSetup.matchFormat'), value: <span>{bestOf === 5 ? t('matchSetup.bestOf5') : t('matchSetup.bestOf3')}</span> }
            ]} />
          </div>

          <div className="mt-4 flex justify-end gap-2">
            {matchInfoConfirmed ? (
              <Button variant="secondary" size="xl" onClick={() => setCurrentView('info')}>{t('common.edit')}</Button>
            ) : (
              <Button variant="primary" size="xl" onClick={() => setCurrentView('info')}>
                {t('matchSetup.createMatch')}
              </Button>
            )}
          </div>
        </div>
      </div>
      {/* Connection toggles moved to Scoreboard Options menu (ConnectionSetupModal) */}

      <div className={cn('grid-4 setup-section', !matchInfoConfirmed && 'pointer-events-none opacity-50')}>
        <div className={cn('flex flex-col gap-5 p-4 sm:p-5', SETUP_BLOCK)} style={{ order: 1 }}>
          {/* Row 1: Status + Team Name + Sync Indicator */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusBadge ready={homeConfigured} />
              {/* Team-colour bar: frozen (team colour + contrast text, sizes) */}
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
          <div className="flex flex-wrap items-center gap-2">
            <CountBadge className="bg-stone-900 px-2.5 py-1 text-white">
              {t('matchSetup.players')}: {homeCounts.players}
            </CountBadge>
            <CountBadge tone="stone" className="px-2.5 py-1">
              {t('matchSetup.liberos')}: {homeCounts.liberos}
            </CountBadge>
            <CountBadge tone="stone" className="px-2.5 py-1">
              {t('matchSetup.bench')}: {homeCounts.bench}
            </CountBadge>
          </div>

          {/* Row 3: Color selector + Shirt + Roster */}
          <div className="flex items-center gap-5">
            <span className="text-xs text-stone-500">{t('matchSetup.selectColour')}</span>
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
            <div className="flex-1" />
            <Button variant="secondary" size="xl" onClick={() => setCurrentView('home')}>{t('matchSetup.editRoster')}</Button>
          </div>
        </div>

        <div className={cn('flex flex-col gap-5 p-4 sm:p-5', SETUP_BLOCK)} style={{ order: 2 }}>
          {/* Row 1: Status + Team Name + Sync Indicator */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusBadge ready={awayConfigured} />
              {/* Team-colour bar: frozen (team colour + contrast text, sizes) */}
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
          <div className="flex flex-wrap items-center gap-2">
            <CountBadge className="bg-stone-900 px-2.5 py-1 text-white">
              {t('matchSetup.players')}: {awayCounts.players}
            </CountBadge>
            <CountBadge tone="stone" className="px-2.5 py-1">
              {t('matchSetup.liberos')}: {awayCounts.liberos}
            </CountBadge>
            <CountBadge tone="stone" className="px-2.5 py-1">
              {t('matchSetup.bench')}: {awayCounts.bench}
            </CountBadge>
          </div>

          {/* Row 3: Color selector + Shirt + Roster */}
          <div className="flex items-center gap-5">
            <span className="text-xs text-stone-500">{t('matchSetup.selectColour')}</span>
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
            <div className="flex-1" />
            <Button variant="secondary" size="xl" onClick={() => setCurrentView('away')}>{t('matchSetup.editRoster')}</Button>
          </div>
        </div>
        {typeof window !== 'undefined' && window.electronAPI?.server && (
          <div className={cn('flex flex-col gap-4 p-4 sm:p-5', SETUP_BLOCK)} style={{ order: 3 }}>
            <div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <StatusBadge ready={serverRunning} />
                  <h3 className="m-0 text-base font-semibold text-stone-900">Live Server</h3>
                </div>
              </div>
              {serverRunning && serverStatus ? (
                <div className="mt-3">
                  <dl className="mb-0.5 grid grid-cols-[100px_minmax(0,1fr)] gap-y-2 text-sm">
                    <dt className="text-stone-500">Status:</dt>
                    <dd className="m-0 inline-flex items-center gap-1.5 font-semibold text-emerald-700"><span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />Running</dd>
                    <dt className="text-stone-500">Hostname:</dt>
                    <dd className="m-0 font-mono text-[13px] text-stone-800">{serverStatus.hostname || 'escoresheet.local'}</dd>
                    <dt className="text-stone-500">IP Address:</dt>
                    <dd className="m-0 font-mono text-[13px] text-stone-800">{serverStatus.localIP}</dd>
                    <dt className="text-stone-500">Protocol:</dt>
                    <dd className="m-0 uppercase text-stone-800">{serverStatus.protocol || 'https'}</dd>
                  </dl>
                  <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs">
                    <div className="mb-2 font-semibold text-stone-700">Connection URLs:</div>
                    <div className="flex flex-col gap-1 font-mono text-[11px] text-stone-800">
                      <div>
                        <div className="text-stone-500">Main:</div>
                        <div className="break-all">{serverStatus.urls?.mainIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/`}</div>
                      </div>
                      <div>
                        <div className="text-stone-500">Referee:</div>
                        <div className="break-all">{serverStatus.urls?.refereeIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/referee`}</div>
                      </div>
                      <div>
                        <div className="text-stone-500">Bench:</div>
                        <div className="break-all">{serverStatus.urls?.benchIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/bench`}</div>
                      </div>
                      <div>
                        <div className="text-stone-500">WebSocket:</div>
                        <div className="break-all">{serverStatus.urls?.websocketIP || `${serverStatus.wsProtocol}://${serverStatus.localIP}:${serverStatus.wsPort}`}</div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-3">
                  <p className="mb-3 text-sm text-stone-500">
                    Start the live server to allow referee, bench, and livescore apps to connect.
                  </p>
                  {typeof window !== 'undefined' && !window.electronAPI?.server && (
                    <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-500">
                      <div className="mb-2 font-semibold">To start from browser/PWA:</div>
                      <div className="font-mono text-[11px] leading-relaxed">
                        Run: <span className="font-semibold text-stone-800">npm run start:prod</span> in terminal
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              {serverRunning ? (
                typeof window !== 'undefined' && window.electronAPI?.server ? (
                  <Button
                    variant="secondary"
                    size="xl"
                    onClick={handleStopServer}
                    disabled={serverLoading}
                  >
                    {serverLoading ? 'Stopping...' : 'Stop server'}
                  </Button>
                ) : null
              ) : (
                <Button
                  variant="primary"
                  size="xl"
                  onClick={handleStartServer}
                  disabled={serverLoading}
                >
                  {typeof window !== 'undefined' && window.electronAPI?.server
                    ? (serverLoading ? 'Starting...' : 'Start server')
                    : <span className="inline-flex items-center gap-1.5"><ClipboardIcon size={14} />Copy Start Command</span>
                  }
                </Button>
              )}
            </div>
          </div>
        )}


      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={cn('flex items-center', !matchInfoConfirmed && 'opacity-50')}>
          <Button
            variant="secondary"
            size="xl"
            className={cn(!matchInfoConfirmed && 'pointer-events-none')}
            onClick={() => setShowBothRosters(!showBothRosters)}
            disabled={!matchInfoConfirmed}
          >
            {showBothRosters ? t('scoreboard.hideRosters') : t('scoreboard.showRosters')}
          </Button>
          {!matchInfoConfirmed && (
            <WarningIndicator id="showRosters" missingItems={[t('warnings.confirmMatchInfoFirst')]} />
          )}
        </div>

        {isMatchOngoing && onReturn ? (
          <Button variant="dark" size="xl" onClick={onReturn}>{t('scoreboard.returnToMatch')}</Button>
        ) : (
          <div className="flex items-center">
          <Button
            variant="primary"
            size="xl"
            data-help-id="setup-proceed-cointoss"
            disabled={!canProceedToCoinToss}
            className="disabled:cursor-not-allowed"
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
                    setupIssues.push('Match info (date, time, venue, etc.)')
                  }

                  // Check Officials - at least 1R should be set
                  if (!ref1First && !ref1Last) {
                    setupIssues.push('Match officials (1st referee)')
                  }

                  // Check Home Team
                  if (!home || home.trim() === '' || home === 'Home') {
                    setupIssues.push('Home team name')
                  } else if (homeRoster.length < 6) {
                    setupIssues.push('Home team roster (minimum 6 players)')
                  } else {
                    // Additional roster validations for proceeding to coin toss
                    // Note: all players having numbers is only validated when CONFIRMING coin toss
                    if (!homeCounts.hasCaptain) {
                      setupIssues.push('Home team: must have a captain assigned')
                    }
                    if (!homeCounts.hasCoach) {
                      setupIssues.push('Home team: must have a coach')
                    }
                  }

                  // Check Away Team
                  if (!away || away.trim() === '' || away === 'Away') {
                    setupIssues.push('Away team name')
                  } else if (awayRoster.length < 6) {
                    setupIssues.push('Away team roster (minimum 6 players)')
                  } else {
                    // Additional roster validations for proceeding to coin toss
                    // Note: all players having numbers is only validated when CONFIRMING coin toss
                    if (!awayCounts.hasCaptain) {
                      setupIssues.push('Away team: must have a captain assigned')
                    }
                    if (!awayCounts.hasCoach) {
                      setupIssues.push('Away team: must have a coach')
                    }
                  }

                  // Check short names
                  if (!homeShortName || homeShortName.trim() === '') {
                    setupIssues.push('Home team short name')
                  }
                  if (!awayShortName || awayShortName.trim() === '') {
                    setupIssues.push('Away team short name')
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
            }}>{t('matchSetup.coinToss')}</Button>
          {!canProceedToCoinToss && (
            <WarningIndicator id="proceedCoinToss" missingItems={getCoinTossMissingItems()} />
          )}
          </div>
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

        // Kit table look (roster-table already carries the stone head + hairlines)
        const thCls = 'px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-stone-500'
        const tdCls = 'px-3 py-1.5 text-sm text-stone-800'
        const numberCls = 'relative w-[60px] px-3 py-1.5 text-center text-sm font-semibold tabular-nums text-stone-900'
        const nameCls = 'min-w-[180px] px-3 py-1.5 text-sm text-stone-800'
        const dobCls = 'w-[100px] px-3 py-1.5 text-center text-sm tabular-nums text-stone-600'
        const emptyCls = 'h-9'
        const tableBox = 'overflow-hidden rounded-lg border border-stone-200'
        // Frozen roster marks: captain "C" (amber) and libero "L/L1/L2" (green), LFP (orange)
        const badgeAbsStyle = { position: 'absolute', left: s(4), top: '50%', transform: 'translateY(-50%)', padding: `${s(1)}px ${s(3)}px`, borderRadius: s(3), fontSize: s(10), fontWeight: 700 }
        const captainBadgeStyle = { ...badgeAbsStyle, background: '#f59e0b', color: '#000' }
        const liberoBadgeStyle = { ...badgeAbsStyle, left: s(1), background: '#22c55e', color: '#000' }
        const lfpBadgeStyle = { background: 'rgba(249, 115, 22, 0.15)', color: '#f97316', padding: `${s(1)}px ${s(4)}px`, borderRadius: s(3), fontSize: s(10), fontWeight: 700, border: '1px solid #f97316' }
        const homeLiberosCount = homeLiberos.length
        const awayLiberosCount = awayLiberos.length

        const playerHead = (
          <thead>
            <tr>
              <th className={thCls}>#</th>
              <th className={thCls}>{t('roster.name')}</th>
              <th className={thCls}>{t('roster.dob')}</th>
              {lfpTrackingEnabled && <th className={thCls}>LFP</th>}
            </tr>
          </thead>
        )

        const teamPanel = (teamName, players, liberos, liberosCount, bench) => (
          <div className={cn('flex flex-col gap-4 p-4 sm:p-5', SETUP_BLOCK)}>
            <h3 className="m-0 text-base font-semibold text-stone-900">{t('roster.titleWithTeam', { team: teamName })}</h3>
            {/* Players Section */}
            <div>
              <SectionHeader title={t('roster.players')} count={players.filter(Boolean).length} className="mb-2" />
              <div className={tableBox}>
                <table className="roster-table w-full border-collapse">
                  {playerHead}
                  <tbody>
                    {players.map((player, idx) => (
                      <tr key={player ? `p-${idx}` : `empty-${idx}`}>
                        {player ? (
                          <>
                            <td className={numberCls}>
                              {player.isCaptain && <span style={captainBadgeStyle}>C</span>}
                              <span>{player.number ?? '—'}</span>
                            </td>
                            <td className={nameCls}>
                              {player.lastName || ''} {player.firstName || ''}
                            </td>
                            <td className={dobCls}>{player.dob || '—'}</td>
                            {lfpTrackingEnabled && <td className={cn(tdCls, 'text-center')}>{player.isLfp && <span style={lfpBadgeStyle}>LFP</span>}</td>}
                          </>
                        ) : (
                          <td colSpan={lfpTrackingEnabled ? 4 : 3} className={emptyCls}>&nbsp;</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {/* Liberos Section */}
            {(maxLiberos > 0) && (
              <div>
                <SectionHeader title={t('roster.liberos')} count={liberos.filter(Boolean).length} className="mb-2" />
                <div className={tableBox}>
                  <table className="roster-table w-full border-collapse">
                    {playerHead}
                    <tbody>
                      {liberos.map((player, idx) => (
                        <tr key={player ? `l-${idx}` : `empty-libero-${idx}`}>
                          {player ? (
                            <>
                              <td className={numberCls}>
                                <span style={liberoBadgeStyle}>
                                  {liberosCount > 1 ? (player.libero === 'libero1' ? 'L1' : 'L2') : 'L'}
                                </span>
                                <span>{player.number ?? '—'}</span>
                              </td>
                              <td className={nameCls}>
                                {player.lastName || ''} {player.firstName || ''}
                              </td>
                              <td className={dobCls}>{player.dob || '—'}</td>
                              {lfpTrackingEnabled && <td className={cn(tdCls, 'text-center')}>{player.isLfp && <span style={lfpBadgeStyle}>LFP</span>}</td>}
                            </>
                          ) : (
                            <td colSpan={lfpTrackingEnabled ? 4 : 3} className={emptyCls}>&nbsp;</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {/* Bench Officials Section */}
            <div>
              <SectionHeader title={t('roster.bench')} count={bench.filter(Boolean).length} className="mb-2" />
              <div className={tableBox}>
                <table className="roster-table w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={thCls}>{t('roster.role')}</th>
                      <th className={thCls}>{t('roster.name')}</th>
                      <th className={thCls}>{t('roster.dob')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bench.map((official, idx) => (
                      <tr key={official ? `b-${idx}` : `empty-bench-${idx}`}>
                        {official ? (
                          <>
                            <td className={cn(tdCls, 'capitalize font-medium')}>{official.role || '—'}</td>
                            <td className={tdCls}>{official.lastName || ''} {official.firstName || ''}</td>
                            <td className={dobCls}>{official.dob || '—'}</td>
                          </>
                        ) : (
                          <td colSpan="3" className={emptyCls}>&nbsp;</td>
                        )}
                      </tr>
                    ))}
                    {maxBench === 0 && (
                      <tr>
                        <td colSpan="3" className={cn(tdCls, 'text-center text-stone-500')}>{t('roster.noBenchOfficials')}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )

        return (
          <div className="flex justify-center">
            <div className="grid w-full max-w-[1200px] grid-cols-1 gap-4 md:grid-cols-2">
              {teamPanel(home || t('common.home'), paddedHomePlayers, paddedHomeLiberos, homeLiberosCount, paddedHomeBench)}
              {teamPanel(away || t('common.away'), paddedAwayPlayers, paddedAwayLiberos, awayLiberosCount, paddedAwayBench)}
            </div>
          </div>
        )
      })()}

      {/* Color Picker Bubble Modal */}
      {colorPickerModal && (
        <>
          {/* Backdrop to close on click outside */}
          {/* No backdrop-blur: it re-rasterises the frozen swatch shirts. */}
          <div
            className="fixed inset-0 z-[999] flex items-center justify-center bg-stone-900/50"
            onClick={() => setColorPickerModal(null)}
          />
          {/* Bubble modal */}
          <div
            role="dialog"
            className="fixed left-1/2 top-1/2 z-[1000] min-w-[280px] rounded-2xl border border-stone-200/70 bg-white p-4 shadow-2xl"
              style={{ transform: 'translate(-50%, -50%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-sm leading-[1.3] font-semibold text-stone-900">
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
                    aria-label={`${t('matchSetup.selectColour', 'Select colour')} ${color}`}
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
                        if (match?.seed_key) {
                          const teamKey = isHome ? 'home_team' : 'away_team'
                          const teamName = isHome ? home : away
                          const shortName = isHome ? homeShortName : awayShortName

                          // Update matches table. The proxy does not return written
                          // rows, so look the cloud UUID up separately for match_live_state.
                          const { error: colorError } = await apiFrom('matches')
                            .update({
                              [teamKey]: {
                                name: teamName?.trim() || '',
                                short_name: shortName || generateShortName(teamName),
                                color: color
                              }
                            })
                            .eq('external_id', match.seed_key)

                          if (!colorError) {
                            console.log(`[MatchSetup] Synced ${teamKey} color to Supabase:`, color)
                          }

                          const { data: supabaseMatch } = await apiFrom('matches')
                            .select('id')
                            .eq('external_id', match.seed_key)
                            .maybeSingle()

                          // Also update match_live_state if it exists (for Referee app)
                          if (supabaseMatch?.id) {
                            // Team A = coin toss winner, determine if home is Team A
                            const coinTossTeamA = match.coinTossTeamA || 'home'
                            const homeIsTeamA = coinTossTeamA === 'home'
                            // If changing home color and home is Team A -> update team_a_color
                            // If changing home color and home is Team B -> update team_b_color
                            const liveStateColorKey = (isHome === homeIsTeamA) ? 'team_a_color' : 'team_b_color'

                            await apiFrom('match_live_state')
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
                      border: isSelected ? '2px solid #3b82f6' : '1px solid var(--border)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      minWidth: '60px'
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.background = 'var(--panel-2)'
                        e.currentTarget.style.borderColor = 'var(--border)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.background = 'transparent'
                        e.currentTarget.style.borderColor = 'var(--border)'
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
          <div className="p-6 text-center">
            {noticeModal.syncing && (
              <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-stone-400" aria-hidden="true" />
            )}
            {!noticeModal.syncing && noticeModal.type === 'success' && (
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl font-bold text-emerald-700">✓</div>
            )}
            {!noticeModal.syncing && noticeModal.type === 'error' && (
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-2xl font-bold text-red-700">✕</div>
            )}
            <p className="mb-6 text-sm text-stone-700">
              {noticeModal.message}
            </p>
            {!noticeModal.syncing && (
              <div className="flex justify-center gap-3">
                <Button
                  variant={noticeModal.type === 'success' ? 'positive' : noticeModal.type === 'error' ? 'danger' : 'dark'}
                  size="xl"
                  className="min-w-24"
                  onClick={() => setNoticeModal(null)}
                >
                  OK
                </Button>
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
          <div className="p-5">
            {/* Success summary */}
            <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="mb-1 text-2xl font-bold tabular-nums text-emerald-800">
                {t('matchSetup.modals.playersCount', { count: importSummaryModal.players })}
              </div>
              <div className="text-sm text-stone-600">
                {t('matchSetup.modals.successfullyImported')}
              </div>
              {importSummaryModal.benchOfficials > 0 && (
                <div className="mt-2 text-xs text-stone-500">
                  {importSummaryModal.benchOfficials > 1 ? t('matchSetup.modals.benchOfficialsCountPlural', { count: importSummaryModal.benchOfficials }) : t('matchSetup.modals.benchOfficialsCount', { count: importSummaryModal.benchOfficials })}
                </div>
              )}
            </div>

            {/* Errors if any */}
            {importSummaryModal.errors && importSummaryModal.errors.length > 0 && (
              <div className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
                <div className="mb-1 text-xs font-semibold text-red-700">
                  {importSummaryModal.errors.length} {importSummaryModal.errors.length > 1 ? t('common.error') + 's' : t('common.error')}
                </div>
                {importSummaryModal.errors.map((err, i) => (
                  <div key={i} className="text-xs text-stone-600">{err}</div>
                ))}
              </div>
            )}

            {/* Warning */}
            <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="text-xs font-semibold text-amber-800">
                {t('matchSetup.modals.reviewImportedData')}
              </div>
              <ul className="mt-2 mb-0 list-disc pl-5 text-xs leading-relaxed text-stone-600">
                <li>{t('matchSetup.modals.reviewAddBenchOfficials')}</li>
                <li>{t('matchSetup.modals.reviewVerifyDob')}</li>
                <li>{t('matchSetup.modals.reviewSetCaptainLibero')}</li>
              </ul>
            </div>

            <Button variant="dark" size="xl" block onClick={() => setImportSummaryModal(null)}>
              {t('common.ok')}
            </Button>
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
          <div className="p-6 text-center">
            {/* Match ID and Game PIN */}
            <div className="mb-4 rounded-xl border border-stone-200 bg-stone-50 p-5">
              <div className="mb-4">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                  {t('matchSetup.modals.matchId')}
                </span>
                <span className="font-mono text-2xl font-bold tracking-[0.15em] text-stone-900">
                  {matchCreatedModal.matchId}
                </span>
              </div>
              <div>
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                  {t('matchSetup.gamePin')}
                </span>
                <span className="font-mono text-3xl font-bold tracking-[0.3em] text-stone-900">
                  {matchCreatedModal.gamePin}
                </span>
              </div>
            </div>

            {/* Connection PINs */}
            <div className="mb-5 rounded-xl border border-stone-200 p-4">
              <div className="mb-3 text-sm font-semibold text-stone-700">
                {t('matchSetup.modals.connectionPins')}
              </div>
              <div className="flex flex-wrap justify-center gap-4">
                <div className="text-center">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                    {t('matchSetup.refereePinLabel')}
                  </span>
                  <span className="font-mono text-lg font-bold tracking-[0.15em] text-stone-900">
                    {matchCreatedModal.refereePin}
                  </span>
                </div>
                <div className="text-center">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                    {t('matchSetup.homeBenchPinLabel')}
                  </span>
                  <span className="font-mono text-lg font-bold tracking-[0.15em] text-stone-900">
                    {matchCreatedModal.homeTeamPin}
                  </span>
                </div>
                <div className="text-center">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                    {t('matchSetup.awayBenchPinLabel')}
                  </span>
                  <span className="font-mono text-lg font-bold tracking-[0.15em] text-stone-900">
                    {matchCreatedModal.awayTeamPin}
                  </span>
                </div>
              </div>
            </div>

            <p className="mb-5 text-xs leading-normal text-stone-500">
              {t('matchSetup.modals.saveInfoToRecover')}
            </p>
            <Button
              variant="primary"
              size="xl"
              onClick={() => {
                setMatchCreatedModal(null)
                onOpenCoinToss()
              }}
            >
              {t('matchSetup.modals.continueToCoinToss')}
            </Button>
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
          <div className="p-6">
            <div className="mb-4">
              <label htmlFor="ms-edit-pin" className="mt-0 mb-2 block text-sm font-medium text-stone-700">
                {t('matchSetup.modals.enterNew6DigitPin')}
              </label>
              <Input
                id="ms-edit-pin"
                size="lg"
                invalid={!!pinError}
                aria-label={t('matchSetup.modals.enterNew6DigitPin')}
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
                  className="text-center font-mono text-xl font-bold tracking-[0.3em]"
                />
                {pinError && (
                  <p className="mt-1.5 text-xs font-medium text-red-600">
                  {pinError}
                </p>
              )}
            </div>
            <div className="flex justify-between gap-2">
              <Button
                variant="secondary"
                size="xl"
                onClick={() => {
                  setEditPinModal(false)
                  setPinError('')
                  setEditPinType(null)
                }}
              >
                Cancel
              </Button>
              <Button variant="positive" size="xl" onClick={handleSavePin}>
                Save PIN
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <SignaturePad
        open={openSignature !== null}
        onClose={() => setOpenSignature(null)}
        onSave={handleSignatureSave}
        title={openSignature === 'home-coach' ? 'Home coach signature' :
          openSignature === 'home-captain' ? 'Home captain signature' :
            openSignature === 'away-coach' ? 'Away coach signature' :
              openSignature === 'away-captain' ? 'Away captain signature' : 'Sign'}
      />
    </MatchSetupMainView>
  )
}

// Shared styles for full-width layout (vertically centered by App.jsx).
// `content-start` keeps the sections packed at the top when the page card is
// taller than its content (the legacy .setup grid stretched the rows apart).
// `kitScale` re-scales the kit's Tailwind spacing/type steps with the user's
// display-scale option (useScaledLayout), the way s() scales the inline sizes.
const setupViewStyle = {
  // No maxWidth restriction - allow content to fill available space
}
// Legacy leaks fenced off for the kit inside these views (styles.css is not
// this package's file): `.text-sm` / `.text-xs` there add 0.2px tracking to
// every kit text-sm/text-xs, and the UA `font` reset on form controls drops the
// Inter Display cut (opsz 32, cv features).
// The button and heading fences reach KIT elements only, never the legacy
// children rendered inside these views (SignaturePad, Modal, RefereeSelector):
//  - a kit button is recognised by the kit focus ring (FOCUS_RING /
//    FOCUS_RING_INSET, `ring-red-400`), which no legacy button carries, so
//    SignaturePad's plain Save/Close keep the default fill and the frozen
//    swatch buttons (no kit ring) keep their face exactly as before;
//  - a kit heading is recognised by its `text-stone-*` colour and no own margin.
// (Full literal class strings: Tailwind only generates what it finds verbatim.)
const SETUP_VIEW = cn(
  'setup content-start',
  // legacy `button { background: var(--accent) }` (scoring green) shows through
  // kit buttons that carry no fill of their own (ghost, outline, segments)
  "[&_:where(button[class*='ring-red-400']:not([class^='bg-']):not([class*='_bg-']))]:bg-transparent",
  "[&_:where(h2,h3,h4)[class*='text-stone-']:not([class*='mb-']):not([class*='mt-'])]:m-0",
  '[&_:where(.text-xs,.text-sm):not([class*=tracking-])]:tracking-normal',
  "[&_:is(button[class*='ring-red-400'],input,select,textarea)]:[font-variation-settings:inherit]",
  "[&_:is(button[class*='ring-red-400'],input,select,textarea)]:[font-feature-settings:inherit]",
  "[&_:is(button[class*='ring-red-400'],input,select,textarea)]:[font-optical-sizing:inherit]"
)

function MatchSetupMainView({ children, kitScale }) {
  return <div className={SETUP_VIEW} style={{ ...setupViewStyle, ...kitScale }}>{children}</div>
}

function MatchSetupInfoView({ children, kitScale }) {
  return <div className={SETUP_VIEW} style={{ ...setupViewStyle, ...kitScale }}>{children}</div>
}

function MatchSetupHomeTeamView({ children, kitScale }) {
  return <div className={SETUP_VIEW} style={{ ...setupViewStyle, ...kitScale }}>{children}</div>
}

function MatchSetupAwayTeamView({ children, kitScale }) {
  return <div className={SETUP_VIEW} style={{ ...setupViewStyle, ...kitScale }}>{children}</div>
}
