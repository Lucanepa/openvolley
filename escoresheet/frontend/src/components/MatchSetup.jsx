import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, memo } from 'react'
import { LicenceInfo } from './rosters/LicenceInfo.jsx'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { useAlert } from '../contexts/AlertContext'
import { useAuth } from '../contexts/AuthContext'
import { clubVerdict, matchClubBlock } from '../lib/access'
import { db } from '../db/db'
import SignaturePad from './SignaturePad'
import { saveMatchSignature, clearMatchSignatures } from '../utils/saveSignature'
import { rosterSignatureKey, staleSignatureFields, signaturesClearedRemark, signatureReplacedRemark } from '../domain/rosterSignatures'
import { phoneSignContext, signatureUpdate, SLOT_OF_ROLE, PRE_MATCH_SIGNATURE_FIELD } from '../domain/phoneSignature'
import Modal from './Modal'
import RefereeSelector from './RefereeSelector'
import LoadOfficialMatchModal, { knownMatchFormat } from './LoadOfficialMatchModal'
import GlobalImportModal from './GlobalImportModal'
import { setTargetsOf } from '../domain/rules'
import { idModeOf, idPlaceholderOf, licenceOf, SWISS_ID_MODE, ID_LABEL_FALLBACK } from '../domain/idMode'
import IdField from './IdField'
import ballFallback from '../ball_fallback.png'
import { useScaledLayout } from '../hooks/useScaledLayout'
import { isLocalOnly, isGuestMatch, usesKeyStore } from '../domain/matchKind'
import { championshipTypeFields } from '../domain/championshipType'

// Primary ball image (with a bundled copy as fallback)
// The bundled, content-hashed ball (brand/ball.svg): an unhashed /ball.png could
// stay cached (old green ball) after an update
const ballImage = ballFallback
import { parseRosterPdf, rosterPdfErrorText } from '../utils/parseRosterPdf'
import { importedRosterOf, importedToSetup } from '../domain/importedRoster'
import { getCloudApiUrl } from '../utils/backendConfig'
import { sendMatchInfoMail } from '../utils/matchInfoMail'
import MatchPinNotice from './MatchPinNotice'
import { needsPinNotice, scorerEmailOf } from '../utils/pinNotice'
import { exportMatchData, officialsFromCloud } from '../utils/backupManager'
import { clearSetupDraft, dropStaleSetupDrafts, readSetupDraft, writeSetupDraft } from '../db/setupDrafts'
import { takeTestMatchTeam, writeTeamPlayers } from '../db/teamPlayers'
import { isSeedTestPlayer } from '../domain/testRoster'
import { uploadBackupToCloud, uploadLogsToCloud } from '../utils/logger'
import { sendsCloudBackup } from '../utils/globalCloud'
import { toastQueuedSync } from '../utils/syncToast'
import { hasStoredSessionToken, isAuthError } from '../hooks/useSyncQueue'
import { apiFrom, authorizationHeader } from '../lib/apiClient'
import { generateMatchSeedKey, liveStateNow } from '../utils/serverDataSync'
import { TEST_TEAM_SEED_DATA, TEST_HOME_BENCH, TEST_AWAY_BENCH } from '../constants/testSeeds'
import { splitLocalDateTime, parseLocalDateTimeToISO } from '../utils/timeUtils'
import { generateSecurePin } from '../utils/stringUtils'
import { openAppWindow, openFailedMessageKey } from '../utils/openAppWindow'
import { buildConnectionPins } from '../utils/connectionPins'
import { coloursTooClose, DEFAULT_AWAY_COLOUR, DEFAULT_HOME_COLOUR, isCustomColour, isDefaultTeamColour, readableTextOn, teamBoxStyle } from '../utils/teamColours'
import { deriveTeamShortLabel } from '../domain/teamIdentity'
import { missingConnectionPins, connectionPinsSyncJob, fetchPendingRoster, clearPendingRosterJob, isKnownDob, cleanLicence, scorerIdentified } from '../utils/remoteRoster'
import { ClipboardIcon } from './icons'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button, Checkbox, DateField, Field, Input, Select, TimeField, SegmentedControl, SectionHeader, KeyValue, CountBadge, Switch, ScreenLoading, cn, confirmDialog, toast } from '../ui'
import { sponsorsOf, sponsorsToMatchInfo } from '../domain/sponsors'
import { sheetInputsToMatchInfo } from '../domain/sheetInputs'
import LongIntervalSwitch from './LongIntervalSwitch'
import { useSponsorsOption } from '../hooks/useSponsorsOption'
import SavedTeamPickerModal, { confirmReplaceRoster } from './SavedTeamPickerModal'
import { focusLeaves, sortedByNumber, displayOrder, readRosterSort, saveRosterSort } from '../utils/rosterOrder'
import { isShirtNumber, shirtNumberDigits, recordNumbersMissingFrom } from '../domain/roster'
import { liberoChoices, liberoValueOf, newPlayerLibero, withLoneLiberoAsL1 } from '../domain/liberoChoices'
import { playersWithoutNumber } from '../domain/coinTossChecks'
import { checkUploadedRoster, takesUploadedRoster, uploadedSignaturesKept, uploadedSignaturesToTake } from '../domain/uploadedRoster'
import PlayerPoolModal from './PlayerPoolModal'
import RosterPhotoImport from './rosterPhoto/RosterPhotoImport'
import { scheduleOcrWarmUp } from '../utils/rosterPhoto/ocrWarmup'
import { buildPlayerPool, poolToRoster, ROSTER_MAX } from '../domain/playerPool'
import { officialsFromSchedule, teamContactEmail, withTeamContacts } from '../domain/officials'
import { rememberedRosters } from '../db/rememberedPlayers'
import CloudBlockNotice from './CloudBlockNotice'
import { savedTeamToRoster, findSavedTeamSuggestions, savedNumberFinder, clubOfMatchTeam } from '../domain/savedTeams'
import { readRosterImportMode, saveRosterImportMode, rosterImportModeFor } from '../utils/rosterImportMode'
import { getSavedTeams, refreshSavedTeams } from '../db/savedTeams'
import { markGameRosterAccepted, offeredSentRosters, refreshGameRosters, rosterSearchOutcome, rowToPendingRoster, sentRostersSameAsUsed } from '../db/gameRosters'
import { REMOTE_PANEL_CHECK_MS, useSentRosterRefresh } from '../hooks/useSentRosterRefresh'
import { useBrowserOnline } from '../hooks/useBrowserOnline'
import { sameUpload, sentRosterFingerprint, takenAfter, uploadIsNewVersion } from '../domain/rosterVersions'
import RosterCheckStatus from './RosterCheckStatus'
import SentRosterCard from './SentRosterCard'
import BackupTargetsPanel from './BackupTargetsPanel'
import GlobalCloudPanel from './GlobalCloudPanel'
import ClubPlayerPickerModal from './ClubPlayerPickerModal'
import ClubGenderNotice from './ClubGenderNotice'
import JanuaryDobNotice from './JanuaryDobNotice'
import { clubOfTeam } from '../db/clubPlayers'
import { isWalkthroughDemoUser } from '../domain/walkthroughDemo'
import { addClubPlayersToRoster, applyClubFill, benchOfficialOfRole, benchRolesOf, clubFillOfRow, clubGenderWarnings, clubPersonOfRow, linkRowToClub, matchGenderOf, offeredClubPlayers, rosterHasPerson, setBenchOfficial } from '../domain/clubPlayers'
import ClubShield from './manage/ClubShield'
import { officialCheck, OFFICIAL_CHECK_CONFIRM_TIMEOUT_MS } from '../lib/accountApi'
import { openRestore } from '../utils/manageNav'
import { Users, Trash2, ListChecks, UserPlus, RefreshCw, FileText, Camera, CloudDownload } from 'lucide-react'
import CaptainToggle from './CaptainToggle'
import StackLabel from './StackLabel'
import TeamShirt from './TeamShirt'
import TeamColourPicker, { CloseColourNote, customColourKey as teamCustomColourKey, recallCustomColour, rememberCustomColour } from './TeamColourPicker'
import { useFormStack } from '../hooks/useFormStack'
import { usePhoneWidth } from '../hooks/usePhoneWidth'
import { askText } from '../utils/askText.js'
import { backdropDismiss } from '../ui/backdropDismiss.js'
import { preload, usePreloaded } from '../utils/preload'
import { benchPlays } from '../db/matchRepository'
import { playsChoice, withPlays } from '../domain/playerOfficials'
import { playsAsOptions } from './rosters/playsAs'

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

// A referee's optional address for the final scoresheet (step 4): trimmed,
// lower-case, null unless it looks like one. Never public (officials are
// read by the match's scorers only, like the dates of birth).
export function cleanEmail(raw) {
  const s = String(raw || '').trim().toLowerCase()
  return s.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null
}

// Helper to build officials array, filtering out entries with no name.
// teamContacts: the teams' contact addresses for the final scoresheet
// (domain/officials withTeamContacts: { role: 'team contact', team, email })
function buildOfficialsArray(ref1, ref2, scorer, asst, lineJudges = {}, useSnakeCase = false, teamContacts = {}) {
  const officials = []
  const fnKey = useSnakeCase ? 'first_name' : 'firstName'
  const lnKey = useSnakeCase ? 'last_name' : 'lastName'

  // Add main officials only if they have a name
  if (ref1?.firstName || ref1?.lastName || ref1?.first_name || ref1?.last_name) {
    officials.push({ role: '1st referee', [fnKey]: ref1.firstName || ref1.first_name || '', [lnKey]: ref1.lastName || ref1.last_name || '', country: ref1.country || null, dob: ref1.dob || null, email: cleanEmail(ref1.email) })
  }
  if (ref2?.firstName || ref2?.lastName || ref2?.first_name || ref2?.last_name) {
    officials.push({ role: '2nd referee', [fnKey]: ref2.firstName || ref2.first_name || '', [lnKey]: ref2.lastName || ref2.last_name || '', country: ref2.country || null, dob: ref2.dob || null, email: cleanEmail(ref2.email) })
  }
  if (scorer?.firstName || scorer?.lastName || scorer?.first_name || scorer?.last_name) {
    // licence: the scorer's licence number, accepted for the coin toss instead of a date of birth
    officials.push({ role: 'scorer', [fnKey]: scorer.firstName || scorer.first_name || '', [lnKey]: scorer.lastName || scorer.last_name || '', country: scorer.country || null, dob: scorer.dob || null, licence: cleanLicence(scorer.licence) })
  }
  if (asst?.firstName || asst?.lastName || asst?.first_name || asst?.last_name) {
    officials.push({ role: 'assistant scorer', [fnKey]: asst.firstName || asst.first_name || '', [lnKey]: asst.lastName || asst.last_name || '', country: asst.country || null, dob: asst.dob || null })
  }

  // Add line judges if present
  if (lineJudges.lj1) officials.push({ role: 'line judge 1', name: lineJudges.lj1 })
  if (lineJudges.lj2) officials.push({ role: 'line judge 2', name: lineJudges.lj2 })
  if (lineJudges.lj3) officials.push({ role: 'line judge 3', name: lineJudges.lj3 })
  if (lineJudges.lj4) officials.push({ role: 'line judge 4', name: lineJudges.lj4 })

  return withTeamContacts(officials, teamContacts, cleanEmail)
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

/**
 * Is Match setup read-only for this match? Once the coin toss is confirmed
 * or the match is live, ended or approved: its edits went past the in-match
 * checks (no manual-change log, signatures given for another roster, a
 * format changed at 1:1).
 */
export function isSetupLocked(match) {
  if (!match) return false
  return match.coinTossConfirmed === true || match.approved === true || ['live', 'ended', 'final', 'approved'].includes(match.status)
}

// The info page's fields kept in its draft (db/setupDrafts) until Save
const INFO_DRAFT_KEYS = ['date', 'time', 'hall', 'city', 'type1', 'type1Other', 'championshipType', 'championshipTypeOther',
  'type2', 'type3', 'type3Other', 'bestOf', 'pointsRegular', 'pointsDeciding', 'gameN', 'league', 'home', 'away', 'homeColor', 'awayColor',
  'ref1First', 'ref1Last', 'ref1Country', 'ref1Dob', 'ref1Email', 'ref2First', 'ref2Last', 'ref2Country', 'ref2Dob', 'ref2Email',
  'scorerFirst', 'scorerLast', 'scorerCountry', 'scorerDob', 'scorerLicence', 'asstFirst', 'asstLast', 'asstCountry', 'asstDob',
  'lineJudge1', 'lineJudge2', 'lineJudge3', 'lineJudge4', 'homeContactEmail', 'awayContactEmail',
  'homeSponsors', 'awaySponsors', 'sponsorsMarked', 'longIntervalAfterSet2']

/**
 * The side-bound fields of a stored match with home and away swapped (a
 * schedule load with the teams the other way round): pre-match signatures and
 * their "signed on phone" marks. The team ids swap in the same write.
 */
function swappedSideFields(match) {
  const m = match || {}
  const out = {
    homeCoachSignature: m.awayCoachSignature ?? null,
    homeCaptainSignature: m.awayCaptainSignature ?? null,
    awayCoachSignature: m.homeCoachSignature ?? null,
    awayCaptainSignature: m.homeCaptainSignature ?? null
  }
  if (m.signatureSources && typeof m.signatureSources === 'object') {
    const src = m.signatureSources
    out.signatureSources = {
      ...src,
      homeCoachSignature: src.awayCoachSignature ?? null,
      homeCaptainSignature: src.awayCaptainSignature ?? null,
      awayCoachSignature: src.homeCoachSignature ?? null,
      awayCaptainSignature: src.homeCaptainSignature ?? null
    }
  }
  return out
}

// Team names as the schedule comparison sees them
const sameTeamName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

// Helper to check if match info has changed
function hasMatchInfoChanged(original, current) {
  if (!original) return true // No original, consider it changed
  const keys = ['date', 'time', 'hall', 'city', 'type1', 'type1Other', 'championshipType', 'championshipTypeOther',
    'type2', 'type3', 'type3Other', 'bestOf', 'pointsRegular', 'pointsDeciding', 'gameN', 'league', 'home', 'away', 'homeColor', 'awayColor',
    'homeSponsors', 'awaySponsors', 'sponsorsMarked', 'longIntervalAfterSet2']
  for (const key of keys) {
    if (!isEqual(original[key], current[key])) return true
  }
  return false
}

// Helper to check if officials have changed
function hasOfficialsChanged(original, current) {
  if (!original) return true
  const keys = ['ref1First', 'ref1Last', 'ref1Country', 'ref1Dob', 'ref1Email',
    'ref2First', 'ref2Last', 'ref2Country', 'ref2Dob', 'ref2Email',
    'scorerFirst', 'scorerLast', 'scorerCountry', 'scorerDob', 'scorerLicence',
    'asstFirst', 'asstLast', 'asstCountry', 'asstDob',
    'lineJudge1', 'lineJudge2', 'lineJudge3', 'lineJudge4', 'homeContactEmail', 'awayContactEmail']
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
      className="p-0 stack:after:absolute stack:after:-inset-x-1 stack:after:-inset-y-3 stack:after:content-['']"
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
// A footer row pinned to the bottom edge of the .setup card (its scroller)
// while the content above scrolls: it covers the card's bottom padding
// (16px * --scale-factor, styles.css) and draws a hairline above itself.
const SETUP_STICKY_FOOTER = 'sticky bottom-[calc(-16px*var(--scale-factor))] z-20 -mx-[calc(16px*var(--scale-factor))] -mb-[calc(16px*var(--scale-factor))] flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-stone-200/70 bg-[var(--ov-card)] px-[calc(16px*var(--scale-factor))] pt-3 pb-[calc(16px*var(--scale-factor))]'
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
// Back / Scoresheet / Options under the Match setup title. On a phone they
// share one row (flex-auto) and a long label (fr, it) wraps inside its button
// instead of pushing a button onto a second row.
const SETUP_HEADER_BUTTON = 'max-sm:h-auto max-sm:min-h-11 max-sm:flex-auto max-sm:px-3 max-sm:py-2 max-sm:whitespace-normal max-sm:text-center max-sm:leading-tight'

/**
 * The role cell of a bench row. In a Global match the official may also be
 * called differently ("Teacher", "Manager"): a text box beside the standard
 * role, which stays the slot on the sheet (domain: bench role + roleLabel).
 */
function BenchRoleCell({ global = false, label = '', onLabel, testId, placeholder, children }) {
  if (!global) return children
  return (
    <div className="cell-head flex min-w-0 gap-1">
      {children}
      <input
        aria-label={placeholder}
        data-testid={testId}
        placeholder={placeholder}
        maxLength={30}
        value={label}
        onChange={e => onLabel(e.target.value)}
      />
    </div>
  )
}

/**
 * "Plays as" of a bench official (domain/playerOfficials): the player he also
 * is, found automatically by licence or name, or the scorer's own choice;
 * "Not a player" when he is not the same person. Every player of the team
 * is offered. `onChange` gets 'none', a number as text, or '' (automatic).
 */
function PlaysAsSelect({ official, players, onChange, t, testId }) {
  const { value } = playsChoice(official, players)
  // the label shows in the stacked (portrait) rows only, where no column
  // head names the field (styles.css / tailwind.css .cell-plays)
  return (
    <label className="cell-plays">
      <span className="plays-label">{t('matchSetup.playsAs', 'Plays as')}</span>
      <select aria-label={t('matchSetup.playsAs', 'Plays as')} data-testid={testId} value={value} onChange={e => onChange(e.target.value)}>
        {playsAsOptions(players, t).map(o => <option key={o.value || 'auto'} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

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
  // the card holds a name: it is on until the switch turns it off
  filled = false,
  dobRequired = false,
  idMode = 'dob',
  idLabel = '',
  // a referee's optional address for the final scoresheet (setEmail: shown)
  email = '',
  setEmail = null,
  // an older match's own scorer licence field (before 2026-11-19 the licence
  // had a field of its own beside the date of birth): it still identifies the
  // scorer for the coin toss; the value field holds the licence since
  licence = '',
  t
}) {
  // null: the switch was not touched, the card follows defaultCollapsed and
  // is on while it holds a name (review 7a: before, a name held it on and
  // the switch did nothing)
  const [collapsed, setCollapsed] = useState(null)
  const isCollapsed = collapsible && (collapsed ?? (defaultCollapsed && !filled))
  // The coin toss needs the scorer's licence (or date of birth): flag it while
  // it is missing; the 01.01.1900 placeholder is shown as empty.
  const dobMissing = dobRequired && !scorerIdentified(dob, licence)
  const dobValue = dob && !(dobRequired && !isKnownDob(dob)) ? formatDateToISO(dob) : ''
  const dobNoteId = `${officialKey || 'official'}-dob-required`
  return (
    <div className={isCollapsed ? OFFICIAL_BOX_COLLAPSED : OFFICIAL_BOX}>
      <div className={isCollapsed ? OFFICIAL_HEAD_COLLAPSED : OFFICIAL_HEAD}>
        <span className={cn(OFFICIAL_TITLE, isCollapsed && 'text-stone-500')}>{title}</span>
        <div className="flex shrink-0 items-center gap-1">
          {hasDatabase && !isCollapsed && (
            <Button
              variant="ghost"
              size="sm"
              className="bg-white px-2 stack:h-11 stack:px-3"
              onClick={(e) => {
                e.stopPropagation()
                onOpenDatabase(e, selectorKey)
              }}
            >
              {t('matchSetup.database')}
            </Button>
          )}
          {collapsible && (
            <ToggleSwitch on={!isCollapsed} onToggle={() => setCollapsed(!isCollapsed)} label={title} />
          )}
        </div>
      </div>
      {!isCollapsed && (
        <div className="p-4">
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(120px,1fr))] stack:grid-cols-1">
            <Field tone="compact" className={FIELD} label={t('matchSetup.lastName')}><Input aria-label={t('matchSetup.lastName')} className="capitalize" value={lastName} onChange={e => setLastName(e.target.value)} /></Field>
            <Field tone="compact" className={FIELD} label={t('matchSetup.firstName')}><Input aria-label={t('matchSetup.firstName')} className="capitalize" value={firstName} onChange={e => setFirstName(e.target.value)} /></Field>
            <Field tone="compact" className={FIELD} label={t('matchSetup.country')}><Input aria-label={t('matchSetup.country')} value={country} onChange={e => setCountry(e.target.value)} /></Field>
            <div className="min-w-0">
              <Field tone="compact" className={FIELD} required={dobMissing || undefined} label={dobMissing ? `${idLabel || t('matchSetup.dateOfBirth')} *` : (idLabel || t('matchSetup.dateOfBirth'))} hint={idMode === 'licence' && !dobMissing ? t('idMode.hint.licence', 'or date of birth (dd.mm.yyyy)') : undefined}>
                <IdField
                  idMode={idMode}
                  rawValue={dob}
                  onRawChange={setDob}
                  data-testid={`${officialKey || 'official'}-id`}
                  aria-label={idLabel || t('matchSetup.dateOfBirth')}
                  aria-describedby={dobMissing ? dobNoteId : undefined}
                  className={cn(dobMissing && 'border-amber-400')}
                  value={dobValue}
                  onChange={v => setDob(v ? formatDateToDDMMYYYY(v) : '')}
                />
              </Field>
              {dobMissing && (
                <p id={dobNoteId} className="mt-1 flex items-start gap-1 text-[11px] font-medium leading-snug text-amber-800">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
                  <span>{t('matchSetup.dobRequiredForCoinToss')}</span>
                </p>
              )}
            </div>
          </div>
          {setEmail && (
            <Field tone="compact" className={cn(FIELD, 'mt-2')} label={t('matchSetup.refereeEmail')} hint={t('matchSetup.refereeEmailHint')}>
              <Input aria-label={`${title} ${t('matchSetup.refereeEmail')}`} type="email" inputMode="email" autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} />
            </Field>
          )}
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
  filled = false, // a line judge is named: on until the switch turns it off
  t
}) {
  const [collapsed, setCollapsed] = useState(null) // null: switch not touched
  const isCollapsed = collapsed ?? (defaultCollapsed && !filled)
  return (
    <div className={isCollapsed ? OFFICIAL_BOX_COLLAPSED : OFFICIAL_BOX}>
      <div className={isCollapsed ? OFFICIAL_HEAD_COLLAPSED : OFFICIAL_HEAD}>
        <span className={cn(OFFICIAL_TITLE, isCollapsed && 'text-stone-500')}>{t('matchSetup.lineJudges')}</span>
        <ToggleSwitch on={!isCollapsed} onToggle={() => setCollapsed(!isCollapsed)} label={t('matchSetup.lineJudges')} />
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

// What Match Setup shows of a stored match, read in one go: the match, its
// teams and their players
function readSetup(matchId) {
  return db.transaction('r', db.matches, db.teams, db.players, async () => {
    const match = await db.matches.get(matchId)
    if (!match) return { match: null }
    const [homeTeam, awayTeam, homePlayers, awayPlayers] = await Promise.all([
      match.homeTeamId ? db.teams.get(match.homeTeamId) : null,
      match.awayTeamId ? db.teams.get(match.awayTeamId) : null,
      match.homeTeamId ? db.players.where('teamId').equals(match.homeTeamId).sortBy('number') : [],
      match.awayTeamId ? db.players.where('teamId').equals(match.awayTeamId).sortBy('number') : []
    ])
    return { match, homeTeam, awayTeam, homePlayers, awayPlayers }
  })
}

// Match Setup's first paint waits this long at most for its local reads
export const SETUP_READS_WAIT_MS = 3000

// A schedule pick waits this long at most for its suggestions and checks
// before the form shows (offline first: never longer)
export const SCHEDULE_LOAD_WAIT_MS = 3000

// The card sync pills read the server this often (the queue's own changes
// update them at once)
export const MATCH_SETUP_SYNC_POLL_MS = 20000

const setupKey = (matchId) => `matchSetup:${matchId}`

/**
 * Read by App before it opens Match Setup on a stored match: the setup then
 * shows filled in its first paint, never 'Not set' / 'Players: 0' first
 * (laptop run 2026-10-08, OV-18), and the screen before it stays until then.
 */
export const preloadMatchSetup = (matchId) => preload(setupKey(matchId), () => readSetup(matchId))

function isNavigatorOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

// The value beside a name as the server stores it: a date of birth from
// DD.MM.YYYY to YYYY-MM-DD; a licence number as it is (a Swiss match: licence
// or date, domain/idMode)
export function formatDobForSync(dob) {
  if (!dob) return null
  if (licenceOf(dob)) return licenceOf(dob)
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

export default function MatchSetup({ onStart, matchId, onReturn, onHome, onOpenOptions, onOpenCoinToss, offlineMode = false, lfpTrackingEnabled = false, initialOfficialGame = null, onInitialOfficialGameUsed, onReady, backup = null }) {
  const { t, i18n } = useTranslation()
  const { showAlert } = useAlert()
  const { user, profile, getCachedProfile, access } = useAuth()
  const { scaleFactor: baseScaleFactor } = useScaledLayout()
  // the web: the photo import's recognition files loaded while the page is
  // idle, so a later photo import works offline (ocrWarmup.js; the apps carry them)
  useEffect(() => scheduleOcrWarmUp(), [])
  // The libero select: no libero, Libero 1, Libero 2 (domain/liberoChoices
  // says which a row offers). Landscape: the empty option is blank under the
  // Libero column head. Portrait (the head is hidden there): "No libero",
  // small and grey while nothing is chosen (.libero-unset); it read "Libero",
  // so the list read "Libero / Libero 1 / Libero 2", as if Libero were a
  // third kind (the owner, 27.11.2026). A phone with LFP tracking has a 44 px
  // LFP toggle more on the row's second line, which leaves the select room
  // for "–" / "L1" / "L2" only (as the in-match roster editor).
  // The options are keyed on the labels, so a change replaces the nodes: a
  // select keeps the width of a longer text when only its option's text
  // changes.
  const formStack = useFormStack()
  const phoneWidth = usePhoneWidth()
  const liberoLabels = !formStack
    ? { key: 'blank', none: '', libero1: t('matchSetup.libero1'), libero2: t('matchSetup.libero2') }
    : (phoneWidth && lfpTrackingEnabled
      ? { key: 'tight', none: '–', libero1: 'L1', libero2: 'L2' }
      : { key: 'stack', none: t('matchSetup.noLibero', 'No libero'), libero1: t('matchSetup.libero1'), libero2: t('matchSetup.libero2') })
  // One libero select's options: a row of `roster` (rowIndex), or the add
  // row (rowIndex null) with its pending value `own`
  const liberoOptions = (roster, rowIndex, own) => liberoChoices(roster, rowIndex, own).map(value => (
    <option key={`${value || 'none'}-${liberoLabels.key}`} value={value}>{value ? (liberoLabels[value] || value) : liberoLabels.none}</option>
  ))
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
  // 3 or 5; null until chosen or known from the schedule (a guessed best of
  // 5 played a best-of-3 decider to 25 points): Create match waits for it
  const [bestOf, setBestOf] = useState(null)
  // Points a set is played to (Global may play shorter sets; domain/rules setTargetsOf)
  // what the sheet carries beside a name (domain/idMode): the licence (or a
  // date of birth) in a Swiss match; Global: birthdate, number or text
  const [idMode, setIdModeState] = useState(SWISS_ID_MODE)
  const [pointsRegular, setPointsRegular] = useState(25)
  const [pointsDeciding, setPointsDeciding] = useState(15)
  const [gameN, setGameN] = useState('')
  const [league, setLeague] = useState('')
  const [homeColor, setHomeColor] = useState(DEFAULT_HOME_COLOUR)
  const [awayColor, setAwayColor] = useState(DEFAULT_AWAY_COLOUR)
  // Sponsors on clothing (domain/sponsors.js): one box per team while the
  // option is on (or the match is already marked); the first tick marks the match
  const [homeSponsors, setHomeSponsors] = useState(false)
  const [awaySponsors, setAwaySponsors] = useState(false)
  const [sponsorsMarked, setSponsorsMarked] = useState(false)
  // The 10-minute interval after set 2 (domain/setInterval.js), off by default
  const [longIntervalAfterSet2, setLongIntervalAfterSet2] = useState(false)
  const [sponsorsOption] = useSponsorsOption()
  const showSponsors = sponsorsOption || sponsorsMarked
  const tickSponsors = (team, ticked) => {
    if (team === 'home') setHomeSponsors(ticked)
    else setAwaySponsors(ticked)
    if (ticked) setSponsorsMarked(true)
  }
  const [notificationEmail, setNotificationEmail] = useState('')
  const [sendingEmail, setSendingEmail] = useState(false)

  // Match info confirmation state - other sections are disabled until confirmed
  const [matchInfoConfirmed, setMatchInfoConfirmed] = useState(false)

  // Check if match info can be confirmed (all required fields filled)
  const requireEmail = import.meta.env.VITE_REQUIRE_EMAIL === 'true'
  const canConfirmMatchInfo = Boolean(
    home?.trim() &&
    away?.trim() &&
    date?.trim() &&      // Date must be filled
    !dateError &&        // Date must be valid
    time?.trim() &&      // Time must be filled
    !timeError &&        // Time must be valid
    gameN?.trim() &&     // Game # must be filled
    league?.trim() &&    // League must be filled
    city?.trim() &&      // City must be filled
    hall?.trim() &&      // Hall must be filled
    (bestOf === 3 || bestOf === 5) &&  // Match format must be chosen
    (!requireEmail || notificationEmail?.trim())  // Email required if VITE_REQUIRE_EMAIL=true
  )

  // Generate dynamic tooltip showing which fields are missing
  const getMissingFieldsTooltip = () => {
    const missing = []
    if (!home?.trim()) missing.push(t('matchSetup.homeTeamName') || 'Home team')
    if (!away?.trim()) missing.push(t('matchSetup.awayTeamName') || 'Away team')
    if (!date?.trim()) missing.push(t('matchSetup.date') || 'Date')
    else if (dateError) missing.push(t('matchSetup.date') + ' (invalid)')
    if (!time?.trim()) missing.push(t('matchSetup.time') || 'Time')
    else if (timeError) missing.push(t('matchSetup.time') + ' (invalid)')
    if (!gameN?.trim()) missing.push(t('matchSetup.gameNumber') || 'Game #')
    if (!league?.trim()) missing.push(t('matchSetup.league') || 'League')
    if (!city?.trim()) missing.push(t('matchSetup.city') || 'City')
    if (!hall?.trim()) missing.push(t('matchSetup.hall') || 'Hall')
    if (bestOf !== 3 && bestOf !== 5) missing.push(t('matchSetup.matchFormat'))
    if (requireEmail && !notificationEmail?.trim()) missing.push(t('matchSetup.notificationEmail') || 'Email')
    if (scorerDobMissing) missing.push(t('matchSetup.scorerDobForCoinToss'))

    if (missing.length === 0) return ''
    return `${t('matchSetup.required') || 'Required'}: ${missing.join(', ')}`
  }

  // Returns missing match-info fields as an array (for WarningIndicator)
  const getMissingFieldsList = () => {
    const missing = []
    if (!home?.trim()) missing.push(t('matchSetup.homeTeamName') || 'Home team')
    if (!away?.trim()) missing.push(t('matchSetup.awayTeamName') || 'Away team')
    if (!date?.trim()) missing.push(t('matchSetup.date') || 'Date')
    else if (dateError) missing.push(`${t('matchSetup.date')} (${t('common.invalid') || 'invalid'})`)
    if (!time?.trim()) missing.push(t('matchSetup.time') || 'Time')
    else if (timeError) missing.push(`${t('matchSetup.time')} (${t('common.invalid') || 'invalid'})`)
    if (!gameN?.trim()) missing.push(t('matchSetup.gameNumber') || 'Game #')
    if (!league?.trim()) missing.push(t('matchSetup.league') || 'League')
    if (!city?.trim()) missing.push(t('matchSetup.city') || 'City')
    if (!hall?.trim()) missing.push(t('matchSetup.hall') || 'Hall')
    if (bestOf !== 3 && bestOf !== 5) missing.push(t('matchSetup.matchFormat'))
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
  // # / A–Z: the order the player rows are shown in (utils/rosterOrder
  // displayOrder). The A–Z order is taken when it is chosen, a row is added or
  // removed, or focus leaves the list (the *OrderTick), never while a row is
  // edited, so a row does not jump away from the cursor
  const [rosterSort, setRosterSort] = useState(readRosterSort)
  const [homeOrderTick, setHomeOrderTick] = useState(0)
  const [awayOrderTick, setAwayOrderTick] = useState(0)
  // (the ids: another roster of the same size, e.g. the test roster loaded)
  const homeIdsKey = homeRoster.map(p => p.id ?? '').join(',')
  const awayIdsKey = awayRoster.map(p => p.id ?? '').join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const homeShownOrder = useMemo(() => displayOrder(homeRoster, rosterSort), [rosterSort, homeRoster.length, homeIdsKey, homeOrderTick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const awayShownOrder = useMemo(() => displayOrder(awayRoster, rosterSort), [rosterSort, awayRoster.length, awayIdsKey, awayOrderTick])
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
  // A new match leaves the officials' value empty (the 01.01.1900 placeholder
  // of older matches shows empty too)
  const [ref1Dob, setRef1Dob] = useState('')
  const [ref1Email, setRef1Email] = useState('')
  // each team's contact address for the final scoresheet (domain/officials)
  const [homeContactEmail, setHomeContactEmail] = useState('')
  const [awayContactEmail, setAwayContactEmail] = useState('')
  const [ref2Email, setRef2Email] = useState('')

  const [ref2First, setRef2First] = useState('')
  const [ref2Last, setRef2Last] = useState('')
  const [ref2Country, setRef2Country] = useState('CHE')
  const [ref2Dob, setRef2Dob] = useState('')

  const [scorerFirst, setScorerFirst] = useState('')
  const [scorerLast, setScorerLast] = useState('')
  const [scorerCountry, setScorerCountry] = useState('CHE')
  const [scorerDob, setScorerDob] = useState('')
  // the scorer's licence number: the coin toss takes it instead of a date of birth
  const [scorerLicence, setScorerLicence] = useState('')
  // Not needed to create the match, but the coin toss waits for it: shown
  // next to Create match so it is filled in with the rest of the form.

  const [asstFirst, setAsstFirst] = useState('')
  const [asstLast, setAsstLast] = useState('')
  const [asstCountry, setAsstCountry] = useState('CHE')
  const [asstDob, setAsstDob] = useState('')

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
  // The game PIN notice right after Create match (utils/pinNotice,
  // MatchPinNotice): the match row as stored then (its new game PIN), or null
  const [pinNoticeMatch, setPinNoticeMatch] = useState(null)
  const [testRosterConfirm, setTestRosterConfirm] = useState(null) // 'home' | 'away' | null
  // Saved teams (competition manager): picker / save dialog per side, the
  // suggestions for a schedule game, and the official-game claim of another
  // scorer (spec 6.5)
  const [savedPicker, setSavedPicker] = useState(null) // 'home' | 'away' | null
  const [savedSuggestion, setSavedSuggestion] = useState(null) // { home, away } | null
  // "Choose the players" (domain/playerPool): { side, pool, teamLabel,
  // savedTeam, summary } | null; and, after a schedule load, how many players
  // earlier matches on this device know of each team ({ home, away } | null)
  const [playerPool, setPlayerPool] = useState(null)
  const [rememberedSuggestion, setRememberedSuggestion] = useState(null)
  const [officialClaim, setOfficialClaim] = useState(null) // claim of another account | null
  // db/018: the game is not a home game of the account's clubs (or it has none):
  // { code, home_team, clubs } | null. From the server's official check when
  // online, else from the cached clubs (a schedule game only: a typed name may
  // be spelled otherwise than VolleyManager's).
  const [clubBlock, setClubBlock] = useState(null)
  const serverClubRef = useRef(undefined) // the last official check's club verdict
  const scheduleHomeRef = useRef(null) // the home team of the schedule game loaded
  // another game number: the verdict was for the old one (confirm checks again)
  useEffect(() => {
    setClubBlock(null)
    serverClubRef.current = undefined
  }, [gameN])
  // confirmMatchInfo is running (button disabled, second taps ignored)
  const [confirmingMatchInfo, setConfirmingMatchInfo] = useState(false)
  const confirmingMatchInfoRef = useRef(false)

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
    return saved !== 'false' // on unless switched off in Options
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
  // Global tool: the Excel uploads of games and rosters ('games' | 'rosters' | null)
  const [globalImportKind, setGlobalImportKind] = useState(null)

  // Edit roster › "Roster import" (owner 27.11.2026): Remote · PDF · Photo.
  // The way picked for a team in this setup (null: not picked yet), and the
  // one picked last on this device (utils/rosterImportMode), which a team not
  // picked yet opens with (else Remote for an official game, else PDF)
  const [importModeBySide, setImportModeBySide] = useState({ home: null, away: null })
  const [rememberedImportMode, setRememberedImportMode] = useState(() => readRosterImportMode())

  // Remote roster search state
  const [homeRosterSearching, setHomeRosterSearching] = useState(false)
  const [awayRosterSearching, setAwayRosterSearching] = useState(false)
  // The Remote panel's checks of the server (owner 2026-11-21: a "refresh"
  // for rosters uploaded again): per side, when it last asked (`at`),
  // whether the server could not be reached, an automatic check under way
  const [rosterCheck, setRosterCheck] = useState({ home: { at: null, failed: false, auto: false }, away: { at: null, failed: false, auto: false } })
  const browserOnline = useBrowserOnline()
  const [rosterPreview, setRosterPreview] = useState(null) // 'home' | 'away' | null

  // Referee selector state
  const [showRefereeSelector, setShowRefereeSelector] = useState(null) // 'ref1' | 'ref2' | null
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
  // null = not checked yet: the pills hold their place empty until the first
  // answer instead of saying "Not synced" and flipping to "Synced" a moment
  // later (owner 2026-11-11: "it loads something, stops, loads it again")
  const [matchInfoSyncStatus, setMatchInfoSyncStatus] = useState(null)
  const [officialsSyncStatus, setOfficialsSyncStatus] = useState(null)
  const [homeTeamSyncStatus, setHomeTeamSyncStatus] = useState(null)
  const [awayTeamSyncStatus, setAwayTeamSyncStatus] = useState(null)
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

  // players saved without a shirt number yet (the coin toss waits for them)
  const homeWithoutNumber = playersWithoutNumber(homeRoster)
  const awayWithoutNumber = playersWithoutNumber(awayRoster)
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

  // The stored match, its teams and players, when App read them before
  // opening the setup (preloadMatchSetup)
  const preloaded = usePreloaded(matchId ? setupKey(matchId) : null)

  // Load match data if matchId is provided
  const match = useLiveQuery(async () => {
    if (!matchId) return null
    try {
      // null, not undefined, for a match that is not there: undefined is
      // "not read yet" (the first-paint gate below waits for it)
      return (await db.matches.get(matchId)) ?? null
    } catch (error) {
      console.error('Unable to load match', error)
      return null
    }
  }, [matchId], preloaded?.match)

  const isMatchOngoing = match?.status === 'live'
  // Read-only once the coin toss is confirmed or the match runs: rosters then
  // change through the match menu's Edit roster (logged as manual changes,
  // signatures checked), the format or game number through Corrections
  const setupLocked = isSetupLocked(match)
  // The shirt colours stay open after the coin toss (not on the official
  // scoresheet), until the match is approved or final
  const coloursClosed = match?.approved === true || ['final', 'approved'].includes(match?.status)

  // db/023, offline first: the rosters teams sent ahead for this official
  // game, read from the device's copy (downloaded while online; AuthContext).
  // A version used or put aside ("Not now") is not offered again.
  const sentGameNumber = match && !isLocalOnly(match) ? String(match.game_n || match.gameNumber || gameN || '').trim() : ''
  const sentRows = useLiveQuery(async () => {
    if (!/^[0-9]{1,12}$/.test(sentGameNumber) || !user?.id) return []
    try {
      return (await db.game_rosters.where('gameNumber').equals(sentGameNumber).toArray()).filter((r) => r.userId === user.id)
    } catch {
      return []
    }
  }, [sentGameNumber, user?.id])
  const sentRosters = useMemo(() => offeredSentRosters(sentRows, match, user?.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sentRows, user?.id, match?.test, match?.global, match?.status, match?.sentRosterUsed, match?.sentRosterUsedFp, match?.sentRosterDismissed])
  // With a connection, ask for this game as well (a roster sent minutes ago,
  // another club's game), and again while the screen stays open: a roster
  // sent while the scorer waits shows up without reopening Match Setup
  // (17.11.2026). Nothing waits for it; offline it reads the device's copy.
  const canAskSentRosters = !!sentGameNumber && !!access?.canReadTeams && !!user?.id
  const refreshSentRosters = () => refreshGameRosters({ access, userId: user?.id, games: [sentGameNumber] })

  // db/024, offline first: the licence lists of the account's clubs, read
  // from the device's copy (downloaded while online; AuthContext). "Add from
  // club" for a team of those clubs: players of the players list, filtered by
  // the game's gender (the schedule's; none for a test match), and bench
  // officials from anyone of the lists, of either gender. A roster player the
  // list has with the other gender is a warning, never a block (owner
  // decision D2); officials are never checked.
  const clubRows = useLiveQuery(async () => {
    if (!user?.id) return []
    try {
      return await db.club_players.where('userId').equals(user.id).toArray()
    } catch {
      return []
    }
  }, [user?.id])
  const clubTeams = useMemo(() => ({ home: clubOfTeam(clubRows, home, user?.id), away: clubOfTeam(clubRows, away, user?.id) }), [clubRows, home, away, user?.id])
  const clubGender = matchGenderOf({ test: isLocalOnly(match), type2 })
  // The scorer's date of birth is a Swiss coin-toss rule: not asked in a Global
  // match; a licence number does instead (owner 2026-11-15)
  const scorerDobMissing = match?.global !== true && !scorerIdentified(scorerDob, scorerLicence)
  // Create match / Save waits for it too (owner 23.11.2026: the scorer's
  // licence or date of birth is mandatory and blocks creating the match,
  // not only the coin toss)
  const canCreateMatch = canConfirmMatchInfo && !scorerDobMissing
  // The referee directory ("Database" on the referee cards) is for the
  // official match of an account that may score: the server refuses it to
  // anyone else (backend/server.js REFEREE_DIRECTORY), and a test, easy or
  // Global match has no use for it.
  const refereeDatabase = !!match && !isLocalOnly(match) && access?.canScore === true
  // A guest match (Home's "New match" signed out, domain/matchKind): no private
  // data in this form, whoever signs in later on the device. Saved teams, the
  // club's lists, other matches' rosters on the device and the referee
  // directory stay out; the public schedule and the Einsatzliste import stay.
  const guestMatch = isGuestMatch(match)
  // Roster import: Remote is not offered in a guest match (sent and uploaded
  // rosters live on the server); an official game with a number opens on it
  const remoteImportOffered = !guestMatch
  const officialGameImport = !!match && !isLocalOnly(match) && !!(match.game_n || match.gameNumber || gameN)
  const importModeOf = (side) => {
    const picked = importModeBySide[side]
    if (picked && (picked !== 'remote' || remoteImportOffered)) return picked
    return rosterImportModeFor({ remembered: rememberedImportMode, remoteOffered: remoteImportOffered, officialGame: officialGameImport })
  }
  // the scorer's pick: for this team, and kept on this device for the next roster
  const chooseImportMode = (side, mode) => {
    setImportModeBySide((m) => ({ ...m, [side]: mode }))
    setRememberedImportMode(mode)
    saveRosterImportMode(mode)
  }
  // The side whose roster editor shows its Remote panel: that panel checks
  // the server itself (every REMOTE_PANEL_CHECK_MS, below), so the screen's
  // own refresh of the sent rosters rests meanwhile
  const remotePanelSide = !match || setupLocked || guestMatch ? null
    : currentView === 'home' && importModeOf('home') === 'remote' ? 'home'
      : currentView === 'away' && importModeOf('away') === 'remote' ? 'away'
        : null
  useSentRosterRefresh(canAskSentRosters && !setupLocked && !remotePanelSide, refreshSentRosters)
  // The team sent the roster used here again, unchanged: nothing to offer
  // (db/gameRosters offeredSentRosters); recorded as used, so the server
  // stops sending it and the team sees it accepted (21.11.2026)
  useEffect(() => {
    if (!matchId || setupLocked) return
    const same = sentRostersSameAsUsed(sentRows, match, user?.id)
    if (!same.length) return
    const used = { ...(match?.sentRosterUsed || {}) }
    for (const r of same) {
      used[r.side] = r.updatedAt || 'sent'
      markGameRosterAccepted(r)
    }
    db.matches.update(matchId, { sentRosterUsed: used }).catch((err) => console.warn('[MatchSetup] Recording the sent roster failed:', err?.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentRows, matchId, setupLocked, user?.id, match?.sentRosterUsed, match?.sentRosterUsedFp, match?.status])
  // The saved teams on this device (the account's copy, offline first): the
  // shirt numbers an Einsatzliste import and "Add from club" fill in (owner
  // 2026-11-19; the server keeps the latest official match's numbers in them,
  // backend lib/rosterSaveBack.js). Read again whenever the copy changes.
  const savedTeamRows = useLiveQuery(async () => (guestMatch || !access?.canReadTeams ? [] : getSavedTeams({ userId: user?.id ?? null })),
    [guestMatch, access?.canReadTeams, user?.id])
  // Online, Match Setup asks for a fresh copy (at most every 10 minutes,
  // db/savedTeams.js SAVED_TEAMS_MAX_AGE_MS): the numbers of the team's last
  // match. Nothing waits for it; offline the device's copy answers.
  useEffect(() => {
    if (guestMatch || !access?.canReadTeams || !user?.id) return
    refreshSavedTeams({ access, userId: user.id }).catch(() => { /* offline first: keep the copy */ })
  }, [guestMatch, access, user?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // The saved team of a side: the one of the side's team name (the
  // schedule's league and season first), else the schedule suggestion; the
  // newest copy of it. None for a guest match.
  const savedTeamOf = (side) => {
    if (guestMatch) return null
    const rows = savedTeamRows || []
    const name = side === 'home' ? home : away
    const byName = name ? findSavedTeamSuggestions(rows, { home: name, league, scheduledAt: date ? `${date}T${time || '12:00'}:00` : null }).home : null
    const suggested = savedSuggestion?.[side] || null
    return byName || (suggested ? rows.find((r) => r.id === suggested.id) || suggested : null)
  }
  // "Load saved team" offers the saved teams of the club of the team being
  // edited only (owner 2026-11-27; domain/savedTeams clubOfMatchTeam: the
  // account's club lists by the team's name, else the club of the saved team
  // of that name); all of them when its club is not known
  const savedTeamClubOf = (side) => (guestMatch ? null : clubOfMatchTeam({ teamName: side === 'home' ? home : away, clubTeam: clubTeams[side], savedTeams: savedTeamRows || [] }))
  const clubIdOfTeamName = (name) => clubOfTeam(clubRows, name, user?.id)?.clubId ?? null
  // What the sheet carries beside a name (Swiss: the licence; Global: birthdate, number or text), kept on the match
  useEffect(() => { if (match) setIdModeState(idModeOf(match)) }, [match?.idMode, match?.global]) // eslint-disable-line react-hooks/exhaustive-deps
  const setIdMode = (mode) => {
    setIdModeState(mode)
    if (matchId != null) db.matches.update(matchId, { idMode: mode, updatedAt: new Date().toISOString() }).catch(() => {})
  }
  // (a birthdate keeps its own, long-translated label)
  const idLabel = idMode === 'dob' ? t('matchSetup.dateOfBirth') : t(`idMode.label.${idMode}`, ID_LABEL_FALLBACK[idMode])
  // the roster rows' ID field has no visible label (portrait hides them): "Licence/DoB"
  const idPlaceholder = idPlaceholderOf(t, idMode)
  const [clubPicker, setClubPicker] = useState(null) // 'home' | 'away' | null
  const clubWarnings = useMemo(() => ({
    home: clubTeams.home ? clubGenderWarnings(homeRoster, clubTeams.home.players, clubGender) : [],
    away: clubTeams.away ? clubGenderWarnings(awayRoster, clubTeams.away.players, clubGender) : []
  }), [clubTeams, homeRoster, awayRoster, clubGender])
  // The chosen club players join the side's roster with the number the
  // side's saved team has for them (else none); one already in it stays as
  // it is. In the roster editor only its Save keeps them.
  const addFromClub = (side, chosen) => {
    setClubPicker(null)
    const { roster, added, numbered } = addClubPlayersToRoster(side === 'home' ? homeRoster : awayRoster, chosen, savedTeamOf(side))
    if (side === 'home') setHomeRoster(roster)
    else setAwayRoster(roster)
    toast.success(t('clubPlayers.added', { count: added }))
    if (numbered) toast.info(t('savedTeams.numbersFilled', { count: numbered }))
  }
  // A bench official from the club: the role's row takes the person (names
  // and date of birth), else a row of that role is added; each role once
  const [officialPicker, setOfficialPicker] = useState(null) // 'home' | 'away' | null
  const officialFromClub = (side, [c], role) => {
    setOfficialPicker(null)
    if (!c || !role) return
    const setBench = side === 'home' ? setBenchHome : setBenchAway
    setBench((bench) => setBenchOfficial(bench, role, c).bench)
    const r = BENCH_ROLES.find((x) => x.value === role)
    toast.success(t('clubPlayers.officialSet', { role: r ? t(r.fullLabelKey) : role, name: `${c.first_name || ''} ${c.last_name}`.trim() }))
  }
  // Shields (owner 2026-11-10): green, someone of the club's uploaded lists
  // (by name, and the date of birth when both have one); gray, typed by hand
  // or kept in the club by hand. The gray one links the row to someone of the
  // uploaded lists (names and date of birth from the club), the green one
  // with a dot fills in what the row lacks. From the tablet's copy, offline.
  // In the one-line rows (landscape); the stacked rows leave them out.
  const [linkTarget, setLinkTarget] = useState(null) // { side, kind: 'roster' | 'bench', index, query }
  const setRowOf = (side, kind) => (kind === 'bench'
    ? (side === 'home' ? setBenchHome : setBenchAway)
    : (side === 'home' ? setHomeRoster : setAwayRoster))
  const patchRow = (side, kind, index, fn) => setRowOf(side, kind)((list) => list.map((x, j) => (j === index ? fn(x) : x)))
  const linkRow = ([c]) => {
    const target = linkTarget
    setLinkTarget(null)
    if (!c || !target) return
    patchRow(target.side, target.kind, target.index, (row) => linkRowToClub(row, c))
    toast.success(t('clubPlayers.linked', { name: `${c.first_name || ''} ${c.last_name}`.trim() }))
  }
  const rowShield = (side, kind, row, index) => {
    const club = clubTeams[side]
    if (!club) return null
    const person = clubPersonOfRow(row, club.people)
    const fill = person && !person.manual ? clubFillOfRow(row, person) : {}
    return (
      <ClubShield
        className="club-shield"
        person={person}
        fill={fill}
        onFill={() => patchRow(side, kind, index, (r) => applyClubFill(r, fill))}
        onLink={() => setLinkTarget({ side, kind, index, query: row.lastName || '' })}
      />
    )
  }
  const clubPickerFor = (side) => {
    const club = clubTeams[side]
    const { players } = offeredClubPlayers(club?.players, clubGender)
    const roster = side === 'home' ? homeRoster : awayRoster
    const bench = side === 'home' ? benchHome : benchAway
    const team = (side === 'home' ? home : away) || club?.clubName || ''
    // the club's people come with their licence (sv_number) and never a date
    // of birth (owner 2026-11-19); the saved team's number beside each (looked
    // up while the players' picker of the side is open only)
    const savedTeam = clubPicker === side && club ? savedTeamOf(side) : null
    const numberOf = savedTeam ? savedNumberFinder(savedTeam) : null
    return (
      <>
        <ClubPlayerPickerModal
          open={clubPicker === side && !!club}
          onClose={() => setClubPicker(null)}
          onPick={(chosen) => addFromClub(side, chosen)}
          players={players}
          title={t('clubPlayers.titleTeam', { team })}
          isTaken={(c) => rosterHasPerson(roster, c)}
          numberOf={numberOf ? (c) => numberOf({ licence: c.sv_number, firstName: c.first_name, lastName: c.last_name }) : undefined}
        />
        <ClubPlayerPickerModal
          open={officialPicker === side && !!club}
          mode="officials"
          onClose={() => setOfficialPicker(null)}
          onPick={(chosen, role) => officialFromClub(side, chosen, role)}
          players={club?.people || []}
          title={t('clubPlayers.officialTitleTeam', { team })}
          roles={BENCH_ROLES.map((r) => ({ value: r.value, label: t(r.fullLabelKey) }))}
          initialRole={BENCH_ROLES.find((r) => !benchOfficialOfRole(bench, r.value))?.value || 'Coach'}
          rolesOf={(c) => benchRolesOf(bench, c)}
          holderOf={(role) => {
            const b = benchOfficialOfRole(bench, role)
            return b ? `${b.firstName || ''} ${b.lastName || ''}`.trim() : null
          }}
        />
        <ClubPlayerPickerModal
          open={linkTarget?.side === side && !!club}
          mode="link"
          onClose={() => setLinkTarget(null)}
          onPick={linkRow}
          players={(linkTarget?.kind === 'bench' ? club?.people || [] : players).filter((c) => !c.manual)}
          initialQuery={linkTarget?.query || ''}
        />
      </>
    )
  }

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
        type2, type3, type3Other, bestOf, pointsRegular, pointsDeciding, gameN, league, home, away, homeColor, awayColor,
        homeSponsors, awaySponsors, sponsorsMarked, longIntervalAfterSet2
      }
      originalOfficialsRef.current = {
        ref1First, ref1Last, ref1Country, ref1Dob, ref1Email, homeContactEmail, awayContactEmail,
        ref2First, ref2Last, ref2Country, ref2Dob, ref2Email,
        scorerFirst, scorerLast, scorerCountry, scorerDob, scorerLicence,
        asstFirst, asstLast, asstCountry, asstDob,
        lineJudge1, lineJudge2, lineJudge3, lineJudge4
      }
    } else if (currentView === 'home') {
      originalHomeTeamRef.current = {
        homeRoster: JSON.parse(JSON.stringify(homeRoster)),
        benchHome: JSON.parse(JSON.stringify(benchHome))
      }
      // what this visit signs or brings from a sent roster starts empty
      signedForRef.current = {}
      pendingSentRef.current.home = null
      acceptedInVisitRef.current.home = false
    } else if (currentView === 'away') {
      originalAwayTeamRef.current = {
        awayRoster: JSON.parse(JSON.stringify(awayRoster)),
        benchAway: JSON.parse(JSON.stringify(benchAway))
      }
      // what this visit signs or brings from a sent roster starts empty
      signedForRef.current = {}
      pendingSentRef.current.away = null
      acceptedInVisitRef.current.away = false
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

  // Statuses of this match's match jobs not sent yet ('error,queued', ...): a
  // live query, so the card pills follow the queue at once (the save toast
  // watches the same jobs) instead of up to 5 s later.
  const unsentMatchJobStatuses = useLiveQuery(async () => {
    if (!match?.seed_key) return ''
    const jobs = await db.sync_queue.where('resource').equals('match').toArray()
    const statuses = new Set(jobs
      .filter(j => (j.status === 'queued' || j.status === 'error' || j.status === 'failed') &&
        (j.payload?.id === match.seed_key || j.payload?.external_id === match.seed_key))
      .map(j => j.status))
    return [...statuses].sort().join(',')
  }, [match?.seed_key], '')

  // Check Supabase availability and sync status periodically
  useEffect(() => {
    let cancelled = false // a slower check of an older queue state must not win
    const setAllCardStatuses = (status) => {
      if (cancelled) return
      setMatchInfoSyncStatus(status)
      setOfficialsSyncStatus(status)
      setHomeTeamSyncStatus(status)
      setAwayTeamSyncStatus(status)
    }
    // A check that ends without a queue verdict (no cloud, no match yet)
    // settles a pill still unchecked as 'idle'; a known status stays
    const settleUnchecked = () => {
      if (cancelled) return
      for (const set of [setMatchInfoSyncStatus, setOfficialsSyncStatus, setHomeTeamSyncStatus, setAwayTeamSyncStatus]) {
        set(prev => prev ?? 'idle')
      }
    }
    const unsent = (unsentMatchJobStatuses || '').split(',').filter(Boolean)
    const hasQueued = unsent.includes('queued')
    const hasError = unsent.includes('error') || unsent.includes('failed')

    const checkSupabaseAndSyncStatus = async () => {
      try {
        // Signed out: nothing is sent (the sync queue waits for a session),
        // so the cards say the match is kept on this device, not "Syncing..."
        if (match?.seed_key && unsent.length > 0 && !hasStoredSessionToken()) {
          setAllCardStatuses('savedOnDevice')
          return
        }

        const { error } = await apiFrom('matches').select('id').limit(1)
        if (cancelled) return
        // Offline only when the server cannot be reached (owner 2026-11-11: the
        // cards said "Offline" while the header said Connected): a server that
        // answers "sign in first" is there, the match just stays on this device
        const reachedSignedOut = !!error && !error.network && isAuthError(error)
        const available = !error || reachedSignedOut
        setIsSupabaseAvailable(available)
        if (reachedSignedOut) {
          if (match?.seed_key) setAllCardStatuses('savedOnDevice')
          else settleUnchecked()
          return
        }

        if (!available || !match?.seed_key) {
          settleUnchecked()
          return
        }

        // Update sync statuses based on queue
        if (hasError) {
          setAllCardStatuses('error')
        } else if (hasQueued) {
          setAllCardStatuses('syncing')
        } else {
          // Check if match exists in Supabase
          const { data: supabaseMatch } = await apiFrom('matches')
            .select('id, status')
            .eq('external_id', match.seed_key)
            .maybeSingle()
          setAllCardStatuses(supabaseMatch ? 'synced' : 'idle')
        }
      } catch (err) {
        console.debug('[MatchSetup] Error checking sync status:', err.message)
        if (!cancelled) setIsSupabaseAvailable(false)
        settleUnchecked()
      }
    }

    checkSupabaseAndSyncStatus()
    // The queue's own changes re-run this effect at once (the live query
    // above); the timer only notices the server side, so 20 s is enough
    const interval = setInterval(checkSupabaseAndSyncStatus, MATCH_SETUP_SYNC_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [match?.seed_key, unsentMatchJobStatuses])

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
              test: isLocalOnly(match),
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
                best_of: match.bestOf || 5,
                ...sponsorsToMatchInfo(match),
                // every key: the server replaces match_info whole (domain/sheetInputs)
                ...sheetInputsToMatchInfo(match)
              },
              home_team: {
                name: homeTeam?.name || home || t('common.home'),
                color: homeTeam?.color || homeColor
              },
              away_team: {
                name: awayTeam?.name || away || t('common.away'),
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
    setType2(o.type2); setType3(o.type3); setType3Other(o.type3Other); setBestOf(o.bestOf ?? null); setPointsRegular(o.pointsRegular ?? 25); setPointsDeciding(o.pointsDeciding ?? 15); setGameN(o.gameN); setLeague(o.league)
    setHome(o.home); setAway(o.away); setHomeColor(o.homeColor); setAwayColor(o.awayColor)
    setHomeSponsors(!!o.homeSponsors); setAwaySponsors(!!o.awaySponsors); setSponsorsMarked(!!o.sponsorsMarked)
    setLongIntervalAfterSet2(o.longIntervalAfterSet2 === true)
  }

  const restoreOfficials = () => {
    const o = originalOfficialsRef.current
    if (!o) return
    setRef1First(o.ref1First); setRef1Last(o.ref1Last); setRef1Country(o.ref1Country); setRef1Dob(o.ref1Dob); setRef1Email(o.ref1Email || '')
    setRef2First(o.ref2First); setRef2Last(o.ref2Last); setRef2Country(o.ref2Country); setRef2Dob(o.ref2Dob); setRef2Email(o.ref2Email || '')
    setScorerFirst(o.scorerFirst); setScorerLast(o.scorerLast); setScorerCountry(o.scorerCountry); setScorerDob(o.scorerDob); setScorerLicence(o.scorerLicence || '')
    setAsstFirst(o.asstFirst); setAsstLast(o.asstLast); setAsstCountry(o.asstCountry); setAsstDob(o.asstDob)
    setLineJudge1(o.lineJudge1); setLineJudge2(o.lineJudge2); setLineJudge3(o.lineJudge3); setLineJudge4(o.lineJudge4)
    setHomeContactEmail(o.homeContactEmail || ''); setAwayContactEmail(o.awayContactEmail || '')
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

  // The form's fields from the stored match, once per match: later changes
  // of the stored match never overwrite the scorer's edits. Preloaded, in
  // the commit that first shows the setup (a layout effect: before the
  // paint); else read here once the match is there.
  const appliedMatchRef = useRef(null)
  // The match whose stored fields are in the form (a game picked on the home
  // screen is filled in after them, never overwritten by them)
  const [storedAppliedFor, setStoredAppliedFor] = useState(null)
  useLayoutEffect(() => {
    if (!matchId || appliedMatchRef.current === matchId) return
    if (preloaded?.match) {
      appliedMatchRef.current = matchId
      applyStoredMatch(preloaded)
      return
    }
    if (!match) return // Wait for match to be loaded from useLiveQuery
    appliedMatchRef.current = matchId
    readSetup(matchId).then(applyStoredMatch, (error) => console.error('Error loading initial match data:', error))

    function applyStoredMatch({ match, homeTeam, awayTeam, homePlayers, awayPlayers }) {
      if (!match) return
      try {
        if (homeTeam) {
          setHome(homeTeam.name)
          setHomeColor(homeTeam.color || DEFAULT_HOME_COLOUR)
        }
        if (awayTeam) {
          setAway(awayTeam.name)
          setAwayColor(awayTeam.color || DEFAULT_AWAY_COLOUR)
        }

        const normalizeBenchMember = member => ({
          role: member?.role || '',
          firstName: member?.firstName || member?.first_name || '',
          lastName: member?.lastName || member?.last_name || '',
          dob: member?.dob || member?.date_of_birth || member?.dateOfBirth || '',
          // a playing coach's link to his shirt number (domain/playerOfficials)
          ...benchPlays(member)
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
        // a value typed by hand in the old Edit match info ("Regional") maps to
        // the select's own (domain/championshipType): the sheet ticks only that
        const ct = championshipTypeFields(match)
        if (ct.championshipType) setChampionshipType(ct.championshipType)
        if (ct.championshipTypeOther) setChampionshipTypeOther(ct.championshipTypeOther)
        if (match.match_type_2) setType2(match.match_type_2)
        if (match.match_type_3) setType3(match.match_type_3)
        if (match.match_type_3_other) setType3Other(match.match_type_3_other)
        // A created match without a stored format plays best of 5 (older
        // matches, test matches): shown as such; a new one starts unset
        if (match.bestOf === 3 || match.bestOf === 5) setBestOf(match.bestOf)
        else if (match.matchInfoConfirmedAt) setBestOf(5)
        // A new Global match starts neutral, not as a Swiss league game: a friendly,
        // mixed, and no country prefilled (the Swiss ones are CHE, men, senior, regional)
        if (match.global === true && !match.matchInfoConfirmedAt && !match.match_type_1) {
          setType1('friendly'); setType2('mixed')
          setRef1Country(''); setRef2Country(''); setScorerCountry(''); setAsstCountry('')
        }
        if (match.setTargets) { setPointsRegular(setTargetsOf(match).regular); setPointsDeciding(setTargetsOf(match).deciding) }
        {
          const s = sponsorsOf(match)
          setHomeSponsors(s.home); setAwaySponsors(s.away); setSponsorsMarked(s.marked)
        }
        setLongIntervalAfterSet2(match.longIntervalAfterSet2 === true)
        if (match.game_n) setGameN(String(match.game_n))
        else if (match.gameNumber) setGameN(String(match.gameNumber))

        // Load players only on initial load (when matchId changes, not when match updates)
        if (match.homeTeamId) {
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
        if (match.awayTeamId) {
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

        // Bench officials are already loaded above via resolvedHomeBench/resolvedAwayBench
        // This section is kept for backward compatibility but should not override if already set

        // Load match officials, in the app's shape or the cloud's (first_name,
        // ISO date: Create match sends those, a restored copy keeps them)
        const officials = officialsFromCloud(match.officials)
        setHomeContactEmail(teamContactEmail(officials, 'home'))
        setAwayContactEmail(teamContactEmail(officials, 'away'))
        if (officials.length > 0) {
          const ref1 = officials.find(o => o.role === '1st referee')
          if (ref1) {
            setRef1First(ref1.firstName || '')
            setRef1Last(ref1.lastName || '')
            setRef1Country(ref1.country || (match.global === true ? '' : 'CHE'))
            setRef1Dob(ref1.dob || '')
            setRef1Email(ref1.email || '')
          }
          const ref2 = officials.find(o => o.role === '2nd referee')
          if (ref2) {
            setRef2First(ref2.firstName || '')
            setRef2Last(ref2.lastName || '')
            setRef2Country(ref2.country || (match.global === true ? '' : 'CHE'))
            setRef2Dob(ref2.dob || '')
            setRef2Email(ref2.email || '')
          }
          const scorer = officials.find(o => o.role === 'scorer')
          if (scorer) {
            setScorerFirst(scorer.firstName || '')
            setScorerLast(scorer.lastName || '')
            setScorerCountry(scorer.country || (match.global === true ? '' : 'CHE'))
            // An older Swiss match kept the scorer's licence in a field of its
            // own: it shows in the value field while that holds nothing
            const known = scorer.dob && isKnownDob(scorer.dob)
            setScorerDob(known ? scorer.dob : (match.global !== true && licenceOf(scorer.licence)) || scorer.dob || '')
            setScorerLicence(scorer.licence || '')
          }
          const asst = officials.find(o => o.role === 'assistant scorer')
          if (asst) {
            setAsstFirst(asst.firstName || '')
            setAsstLast(asst.lastName || '')
            setAsstCountry(asst.country || (match.global === true ? '' : 'CHE'))
            setAsstDob(asst.dob || '')
          }
          // Load line judges
          const lj1 = officials.find(o => o.role === 'line judge 1')
          if (lj1) setLineJudge1(lj1.name || '')
          const lj2 = officials.find(o => o.role === 'line judge 2')
          if (lj2) setLineJudge2(lj2.name || '')
          const lj3 = officials.find(o => o.role === 'line judge 3')
          if (lj3) setLineJudge3(lj3.name || '')
          const lj4 = officials.find(o => o.role === 'line judge 4')
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
      setStoredAppliedFor(matchId)
    }
  }, [matchId, preloaded, match])

  // After the first read, once per match: complete the stored match
  // (connection PINs, connection flags) and queue its PINs for the server
  const completedMatchRef = useRef(null)
  useEffect(() => {
    if (!matchId || !match || completedMatchRef.current === matchId) return
    completedMatchRef.current = matchId

    async function completeMatch() {
      try {
        // Generate PINs if they don't exist (for matches created before PIN feature)
        const updates = missingConnectionPins(match)
        if (Object.keys(updates).length > 0) {
          await db.matches.update(matchId, updates)
        }

        // A created match: make sure the server has every connection PIN
        // (roster upload validates the upload PIN there). Through the sync
        // queue, so it also works offline and after the match insert; it
        // heals matches created before Create match carried the PINs. Once
        // per match (connectionPinsQueuedAt), or when PINs were just added:
        // every update is a server write and a realtime publish.
        if (match.seed_key && match.matchInfoConfirmedAt && (Object.keys(updates).length > 0 || !match.connectionPinsQueuedAt)) {
          try {
            await db.sync_queue.add(connectionPinsSyncJob(match.seed_key, { ...match, ...updates }))
            await db.matches.update(matchId, { connectionPinsQueuedAt: new Date().toISOString() })
          } catch (err) {
            console.warn('[MatchSetup] Failed to queue the connection PINs:', err)
          }
        }

        // Migrate old matches: ensure connection fields are explicitly set to false if undefined
        const connectionUpdates = {}
        if (match.refereeConnectionEnabled === undefined) connectionUpdates.refereeConnectionEnabled = false
        if (match.homeTeamConnectionEnabled === undefined) connectionUpdates.homeTeamConnectionEnabled = false
        if (match.awayTeamConnectionEnabled === undefined) connectionUpdates.awayTeamConnectionEnabled = false
        if (Object.keys(connectionUpdates).length > 0) {
          await db.matches.update(matchId, connectionUpdates)
        }
      } catch (error) {
        console.error('Error completing the match:', error)
      }
    }

    completeMatch()
  }, [matchId, match])

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
    // never the account's date of birth (owner 2026-11-19): the licence below
  }, [profile, scorerFirst, scorerLast])

  // A Swiss match: the scorer's value is the account's licence number, once
  // per match, after the stored fields are in the form, while the value is
  // empty and the scorer is the account. A Global match chooses its column.
  const scorerLicencePrefillRef = useRef(null)
  useEffect(() => {
    if (!matchId || storedAppliedFor !== matchId || scorerLicencePrefillRef.current === matchId || !match) return
    scorerLicencePrefillRef.current = matchId
    if (match.global === true || (scorerDob && isKnownDob(scorerDob))) return
    const userProfile = profile || getCachedProfile()
    const licence = licenceOf(userProfile?.license_number)
    if (!licence) return
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
    if (!same(scorerLast, userProfile.last_name) || !same(scorerFirst, userProfile.first_name)) return
    setScorerDob(licence)
  }, [matchId, storedAppliedFor, match, profile, scorerFirst, scorerLast, scorerDob]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Write the form into the stored match and its teams (the setup's main view
  // and roster editors; the info page writes only on its Save). Nothing on a
  // match that is gone or read-only (after the coin toss).
  async function saveDraft(silent = false) {
    try {
      // The stored row as it is now: its team ids may have changed since this
      // render (a schedule load that swapped the teams)
      const current = matchId ? await db.matches.get(matchId) : null
      if (current && !isSetupLocked(current)) {
        let scheduledAt = current.scheduledAt // Default to existing value

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
          homeSponsors, awaySponsors, sponsorsMarked, longIntervalAfterSet2,
          game_n: gameN ? Number(gameN) : null,
          gameNumber: gameN ? gameN : null,
          league,
          gamePin: !current.test ? (current.gamePin || generateSecurePin([])) : null,
          scheduledAt,
          officials: buildOfficialsArray(
            { firstName: ref1First, lastName: ref1Last, country: ref1Country, email: ref1Email, dob: ref1Dob },
            { firstName: ref2First, lastName: ref2Last, country: ref2Country, email: ref2Email, dob: ref2Dob },
            { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob, licence: scorerLicence },
            { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
            { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 },
            false,
            { home: homeContactEmail, away: awayContactEmail }
          ),
          bench_home: benchHome,
          bench_away: benchAway
        }

        // Only save match type fields if explicitly saving OR match was previously confirmed
        // This prevents scoresheet from showing default Xs before user confirms match info
        if (!silent || current.matchInfoConfirmedAt) {
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
        let homeTeamId = current.homeTeamId
        let awayTeamId = current.awayTeamId

        if (home && home.trim()) {
          if (homeTeamId) {
            // Update existing team
            await db.teams.update(homeTeamId, {
              name: home.trim(),
              color: homeColor,
              benchStaff: benchHome
            })
          } else {
            // Create new team if it doesn't exist
            homeTeamId = await db.teams.add({
              name: home.trim(),
              color: homeColor,
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
              benchStaff: benchAway
            })
          } else {
            // Create new team if it doesn't exist
            awayTeamId = await db.teams.add({
              name: away.trim(),
              color: awayColor,
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

  // The match whose setup draft was looked at (restored or dropped): drafts
  // are written, and cleared on the main view, only from then on
  const [draftReadyFor, setDraftReadyFor] = useState(null)
  // A schedule load swapped the rosters with the team names (home and away
  // the other way round): Save stores the swap, Back undoes it
  const rosterSwapRef = useRef(false)

  // The draft of the view being edited
  const draftDataOf = (view) => {
    if (view === 'info') {
      const values = {
        date, time, hall, city, type1, type1Other, championshipType, championshipTypeOther, type2, type3, type3Other, bestOf,
        pointsRegular, pointsDeciding, gameN, league, home, away, homeColor, awayColor,
        ref1First, ref1Last, ref1Country, ref1Dob, ref1Email, homeContactEmail, awayContactEmail, ref2First, ref2Last, ref2Country, ref2Dob, ref2Email,
        scorerFirst, scorerLast, scorerCountry, scorerDob, scorerLicence, asstFirst, asstLast, asstCountry, asstDob,
        lineJudge1, lineJudge2, lineJudge3, lineJudge4, homeSponsors, awaySponsors, sponsorsMarked, longIntervalAfterSet2
      }
      return { ...values, swapRosters: rosterSwapRef.current }
    }
    if (view === 'home') return { roster: homeRoster, bench: benchHome }
    if (view === 'away') return { roster: awayRoster, bench: benchAway }
    return null
  }

  // Auto-save when data changes (debounced): the main view and the roster
  // editors into the match, as before; the info page and the roster editors
  // into the match's draft. Nothing after the coin toss.
  useEffect(() => {
    if (setupLocked) return
    const view = currentView
    const intoMatch = view === 'main' || view === 'home' || view === 'away'
    const intoDraft = draftReadyFor === matchId && matchId != null && (view === 'info' || view === 'home' || view === 'away')
    if (!intoMatch && !intoDraft) return
    const timeoutId = setTimeout(() => {
      if (intoMatch) saveDraft(true) // Silent auto-save
      if (intoDraft) writeSetupDraft(matchId, view, draftDataOf(view)).catch((err) => console.warn('[MatchSetup] Saving the draft failed:', err?.message))
    }, 500) // Debounce 500ms

    return () => clearTimeout(timeoutId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, time, hall, city, type1, type1Other, championshipType, championshipTypeOther, type2, type3, type3Other, bestOf, gameN, league, home, away, homeColor, awayColor, homeRoster, awayRoster, benchHome, benchAway, ref1First, ref1Last, ref1Country, ref1Dob, ref1Email, ref2First, ref2Last, ref2Country, ref2Dob, ref2Email, scorerFirst, scorerLast, scorerCountry, scorerDob, scorerLicence, asstFirst, asstLast, asstCountry, asstDob, lineJudge1, lineJudge2, lineJudge3, lineJudge4, homeContactEmail, awayContactEmail, homeSponsors, awaySponsors, sponsorsMarked, longIntervalAfterSet2, homeCoachSignature, homeCaptainSignature, awayCoachSignature, awayCaptainSignature, currentView, setupLocked, draftReadyFor])

  // Back on the main view (Save, Back, a roster confirmed): no draft left
  useEffect(() => {
    if (currentView !== 'main' || draftReadyFor !== matchId || matchId == null) return
    rosterSwapRef.current = false
    clearSetupDraft(matchId).catch(() => {})
  }, [currentView, draftReadyFor, matchId])

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

  // Near-black or white, whichever reads better on the team colour
  // (utils/teamColours.js, as on the court and in the headers)
  function getContrastColor(color) {
    return readableTextOn(color)
  }

  // Where the picker keeps a team's last custom colour: the team name, or
  // the side while the team has none
  function customColourKey(isHome) {
    return teamCustomColourKey(isHome ? home : away, isHome ? 'home' : 'away')
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
  // One confirm at a time: a second tap while the first still runs (a slow
  // official check, Dexie writes) would create the teams and the match twice.
  async function confirmMatchInfo() {
    if (confirmingMatchInfoRef.current) return
    confirmingMatchInfoRef.current = true
    setConfirmingMatchInfo(true)
    try {
      await confirmMatchInfoOnce()
    } finally {
      confirmingMatchInfoRef.current = false
      setConfirmingMatchInfo(false)
    }
  }

  async function confirmMatchInfoOnce() {
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
    if (bestOf !== 3 && bestOf !== 5) {
      setNoticeModal({ message: t('matchSetup.matchFormatRequired') })
      return
    }
    // After the coin toss: Corrections only
    if (setupLocked) return

    // Check if any changes were made (skip sync if no changes)
    const currentMatchInfo = {
      date, time, hall, city, type1, type1Other, championshipType, championshipTypeOther,
      type2, type3, type3Other, bestOf, pointsRegular, pointsDeciding, gameN, league, home, away, homeColor, awayColor,
      homeSponsors, awaySponsors, sponsorsMarked, longIntervalAfterSet2
    }
    const currentOfficials = {
      ref1First, ref1Last, ref1Country, ref1Dob, ref1Email, homeContactEmail, awayContactEmail,
      ref2First, ref2Last, ref2Country, ref2Dob, ref2Email,
      scorerFirst, scorerLast, scorerCountry, scorerDob, scorerLicence,
      asstFirst, asstLast, asstCountry, asstDob,
      lineJudge1, lineJudge2, lineJudge3, lineJudge4
    }
    const hasChanges = isCreating || hasMatchInfoChanged(originalMatchInfoRef.current, currentMatchInfo) || hasOfficialsChanged(originalOfficialsRef.current, currentOfficials)

    // If no changes, just go back to main view
    if (!hasChanges) {
      setCurrentView('main')
      return
    }

    // One cloud match per official game: say so before creating a second one
    // (the server refuses it with 409 OV_GAME_TAKEN either way)
    const gameChanged = isCreating || String(originalMatchInfoRef.current?.gameN ?? '') !== String(gameN ?? '')
    if (gameChanged && !isLocalOnly(match)) {
      let claim = null
      serverClubRef.current = undefined
      try { claim = await checkOfficialGame({ gameNumber: gameN, dateValue: date, timeValue: time, timeoutMs: OFFICIAL_CHECK_CONFIRM_TIMEOUT_MS }) } catch { claim = null }
      // db/018: the home games of the account's clubs only (the server refuses the rest)
      const blocked = gameN?.trim() ? currentClubBlock(home) : null
      setClubBlock(blocked)
      if (blocked) {
        showAlert(clubBlockText(blocked), 'error')
        return
      }
      if (claim) {
        const status = claim.status ? t(`manage.status.${claim.status}`, claim.status) : '–'
        const ok = await confirmDialog({
          title: t('matchSetup.gameTakenTitle', { game: gameN }),
          message: claim.mine
            ? t('cloudBlock.gameTakenMine', { game: gameN })
            : t('matchSetup.gameTakenBody', { name: claim.scorer_name || t('manage.games.unknownScorer'), status }),
          confirmLabel: t('matchSetup.continueLocalOnly'),
          cancelLabel: t('common.cancel', 'Cancel'),
          tone: 'danger'
        })
        if (!ok) return
        if (!claim.mine) setOfficialClaim(claim)
      } else if (claim === false) {
        setOfficialClaim(null)
      }
    }

    // The schedule load swapped the teams (home and away the other way round):
    // the stored teams swap sides with their players, bench and signatures
    const swapSides = rosterSwapRef.current
    try {
      // Create teams if they don't exist
      let homeTeamId = swapSides ? match?.awayTeamId : match?.homeTeamId
      let awayTeamId = swapSides ? match?.homeTeamId : match?.awayTeamId

      // A test match given other teams (a schedule game, names typed): a
      // replaced team's seeded test players and officials go, the scorer's
      // own stay, under a team of the match's own (db/teamPlayers). They
      // stayed as the new team's roster (the seed team was renamed).
      let homeBench = benchHome
      let awayBench = benchAway
      const testTeams = { home: null, away: null }
      if (match?.test === true) {
        testTeams.home = await takeTestMatchTeam({ teamId: homeTeamId, name: home, color: homeColor, roster: homeRoster, bench: benchHome })
        testTeams.away = await takeTestMatchTeam({ teamId: awayTeamId, name: away, color: awayColor, roster: awayRoster, bench: benchAway })
        if (testTeams.home) { homeTeamId = testTeams.home.teamId; homeBench = testTeams.home.bench }
        if (testTeams.away) { awayTeamId = testTeams.away.teamId; awayBench = testTeams.away.bench }
      }

      if (!homeTeamId) {
        homeTeamId = await db.teams.add({
          name: home.trim(),
          color: homeColor,
          benchStaff: homeBench,
          createdAt: new Date().toISOString()
        })
      } else {
        // Update existing team
        await db.teams.update(homeTeamId, {
          name: home.trim(),
          color: homeColor,
          benchStaff: homeBench
        })
      }

      if (!awayTeamId) {
        awayTeamId = await db.teams.add({
          name: away.trim(),
          color: awayColor,
          benchStaff: awayBench,
          createdAt: new Date().toISOString()
        })
      } else {
        // Update existing team
        await db.teams.update(awayTeamId, {
          name: away.trim(),
          color: awayColor,
          benchStaff: awayBench
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
      // A test match never reaches the cloud: no seed_key, no insert, no backup
      const isTestMatch = isLocalOnly(match)
      let matchSeedKey = match?.seed_key
      if (!matchSeedKey && !isTestMatch) {
        matchSeedKey = generateMatchSeedKey()
      }

      // Every connection PIN the scorer will show (referee, benches, upload)
      // exists locally and goes to the server with the match, so the roster
      // upload's PIN check works from Create match on (stored hashed there).
      const localMatch = await db.matches.get(matchId)
      const pinUpdates = missingConnectionPins(localMatch)
      // The game PIN, made here when the match has none yet: since the info
      // page saves only on Save (c3902a422) the auto-save no longer gave it one
      // before Create match, and the insert below sent game_pin null, so the
      // server never had it (restore by game PIN found nothing; 3.2.x)
      const gamePin = isTestMatch ? null : (localMatch?.gamePin || match?.gamePin || generateSecurePin([]))
      const swapUpdates = swapSides ? swappedSideFields(localMatch) : {}

      // Update match with team IDs and match info
      // matchInfoConfirmedAt flag indicates user explicitly clicked "Create Match"
      await db.matches.update(matchId, {
        homeTeamId,
        awayTeamId,
        homeName: home.trim(),
        awayName: away.trim(),
        homeSponsors, awaySponsors, sponsorsMarked, longIntervalAfterSet2,
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
        // a Global match's own points per set (domain/rules setTargetsOf)
        ...(match?.global === true ? { setTargets: { regular: pointsRegular, deciding: pointsDeciding } } : {}),
        sport_type: 'indoor',
        game_n: gameN ? parseInt(gameN, 10) : null,
        seed_key: matchSeedKey, // Ensure seed_key is set
        ...(gamePin ? { gamePin } : {}),
        ...pinUpdates,
        bench_home: homeBench,
        bench_away: awayBench,
        officials: buildOfficialsArray(
          { firstName: ref1First, lastName: ref1Last, country: ref1Country, email: ref1Email, dob: ref1Dob },
          { firstName: ref2First, lastName: ref2Last, country: ref2Country, email: ref2Email, dob: ref2Dob },
          { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob, licence: scorerLicence },
          { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
          { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 },
            false,
            { home: homeContactEmail, away: awayContactEmail }
        ),
        ...swapUpdates,
        matchInfoConfirmedAt: new Date().toISOString(),
        // The insert below carries connection_pins: no separate PIN sync on the next open
        connectionPinsQueuedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      // Queue match for Supabase sync - all data stored as JSONB
      // Only set status to 'setup' when creating a new match, not when updating existing match
      // to avoid resetting 'live' status back to 'setup'
      const syncPayload = {
        external_id: matchSeedKey,
        scheduled_at: scheduledAt || null,
        game_n: gameN ? parseInt(gameN, 10) : null,
        game_pin: gamePin,
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
          best_of: bestOf,
          ...sponsorsToMatchInfo({ homeSponsors, awaySponsors, sponsorsMarked }),
          // every key: the server replaces match_info whole (domain/sheetInputs);
          // the interval switch as just saved (localMatch is the record before)
          ...sheetInputsToMatchInfo({ ...localMatch, longIntervalAfterSet2 })
        },
        home_team: { name: home.trim(), color: homeColor },
        away_team: { name: away.trim(), color: awayColor },
        bench_home: homeBench || [],
        bench_away: awayBench || [],
        officials: buildOfficialsArray(
          { firstName: ref1First, lastName: ref1Last, country: ref1Country, email: ref1Email, dob: formatDobForSync(ref1Dob) },
          { firstName: ref2First, lastName: ref2Last, country: ref2Country, email: ref2Email, dob: formatDobForSync(ref2Dob) },
          { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: formatDobForSync(scorerDob), licence: scorerLicence },
          { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: formatDobForSync(asstDob) },
          { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 },
          true, // useSnakeCase for Supabase
          { home: homeContactEmail, away: awayContactEmail }
        )
      }

      // Only set status to 'setup' when creating a new match
      // When updating, don't overwrite the status (might be 'live')
      if (isCreating) {
        syncPayload.status = 'setup'
      }

      const syncJobId = isTestMatch ? null : await db.sync_queue.add({
        resource: 'match',
        action: 'insert',
        payload: syncPayload,
        ts: new Date().toISOString(),
        status: 'queued'
      })
      // The swapped rosters and signatures for the cloud, as a roster's Save sends them
      if (swapSides && !isTestMatch && matchSeedKey) {
        const cloudPlayers = (roster) => roster.filter(p => p.firstName || p.lastName).map(p => ({
          number: p.number || null,
          first_name: p.firstName || '',
          last_name: p.lastName || '',
          dob: formatDobForSync(p.dob),
          is_captain: !!p.isCaptain,
          libero: p.libero || null,
          is_lfp: !!p.isLfp
        }))
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: matchSeedKey,
            players_home: cloudPlayers(homeRoster),
            players_away: cloudPlayers(awayRoster),
            signatures: {
              home_coach: swapUpdates.homeCoachSignature || '',
              home_captain: swapUpdates.homeCaptainSignature || '',
              away_coach: swapUpdates.awayCoachSignature || '',
              away_captain: swapUpdates.awayCaptainSignature || ''
            }
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }
      rosterSwapRef.current = false

      // The test match's replaced teams in the form: the summary and the
      // roster editors show what is stored. A coach's or captain's signature
      // given for the roster before goes, as a roster editor's Confirm does.
      for (const side of ['home', 'away']) {
        const taken = testTeams[side]
        if (!taken) continue
        if (side === 'home') { setHomeRoster(taken.roster); setBenchHome(taken.bench) }
        else { setAwayRoster(taken.roster); setBenchAway(taken.bench) }
        if (taken.removed) await clearTestTeamSignatures(side, side === 'home' ? home.trim() : away.trim())
      }

      setMatchInfoConfirmed(true)
      setCurrentView('main')

      // The game PIN notice, right after Create match: a new official match
      // with a game PIN, once per match on this device (utils/pinNotice). The
      // row as stored now carries the PIN made above; a Save of an existing
      // match never shows it
      if (isCreating) {
        const created = await db.matches.get(matchId)
        if (needsPinNotice(created)) setPinNoticeMatch(created)
      }

      // Match info email (non-blocking): the server mails the signed-in
      // scorer's own confirmed address, built from the stored match, no PIN
      // (the cloud backend sends it; a LAN relay has no mailer)
      if (notificationEmail && notificationEmail.trim() && matchSeedKey && !isTestMatch) {
        const sendInfoUrl = getCloudApiUrl('/api/match/send-info')
        const auth = authorizationHeader()
        // (the match is new: sendMatchInfoMail waits for the sync's upload)
        if (sendInfoUrl && auth.Authorization) sendMatchInfoMail({ url: sendInfoUrl, headers: auth, externalId: matchSeedKey })
          .then(data => {
            if (data.success) {
              console.log('[MatchSetup] Match info email sent successfully')
            } else {
              console.warn('[MatchSetup] Failed to send match info email:', data.error)
            }
          })
          .catch(err => console.warn('[MatchSetup] Match info email failed:', err))
      }

      if (!sendsCloudBackup(match)) return

      // Cloud backup at match setup (non-blocking)
      exportMatchData(matchId).then(backupData => {
        uploadBackupToCloud(matchId, backupData)
        uploadLogsToCloud(matchId, gameN || null)
      }).catch(err => console.warn('[MatchSetup] Cloud backup failed:', err))

      // One non-blocking toast with the outcome of this save (utils/syncToast)
      toastQueuedSync([syncJobId], {
        synced: t('matchSetup.modals.matchSynced'),
        failed: t('matchSetup.modals.matchSavedLocalSyncFailed'),
        pending: t('matchSetup.modals.matchSavedLocalSyncPending')
      }, i18n?.language)
    } catch (error) {
      console.error('Error confirming match info:', error)
      setNoticeModal({ message: t('matchSetup.errorGeneric', { error: error.message }), type: 'error' })
    }
  }

  // Sign on phone for a pre-match signature (SignaturePad `phone`)
  function phoneSigning(role) {
    if (!role || !match) return null
    const slot = SLOT_OF_ROLE[role]
    const coachOf = (bench) => (bench || []).find(b => /coach/i.test(b?.role || '') && !/assistant/i.test(b?.role || '')) || null
    return {
      slot,
      matchKey: match.seed_key || match.seedKey || null,
      gamePin: match.gamePin || null,
      context: phoneSignContext({
        match,
        slot,
        homeTeam: home,
        awayTeam: away,
        homeCaptain: homeRoster.find(p => p.isCaptain || p.captain) || null,
        awayCaptain: awayRoster.find(p => p.isCaptain || p.captain) || null,
        homeCoach: coachOf(benchHome),
        awayCoach: coachOf(benchAway),
        lang: i18n.language,
        fallbackHome: t('common.home'),
        fallbackAway: t('common.away')
      })
    }
  }

  // ---- Pre-match signatures in the roster editor (domain/rosterSignatures) ----
  // The roster each signature of this visit was given for (match-row field ->
  // rosterSignatureKey): a pad here, or a sent-ahead roster. A signature from
  // before the editor opened counts as given for the roster it opened with.
  const signedForRef = useRef({})
  // A sent-ahead roster used in the editor: { home|away: { row, signatures } }.
  // Only the editor's Save stores its signatures and marks it used; Back drops it
  const pendingSentRef = useRef({ home: null, away: null })
  // An uploaded roster accepted in this visit of the roster editor: stored
  // already, the editor's Confirm still saves it (and sends it to the cloud)
  const acceptedInVisitRef = useRef({ home: false, away: false })
  const signatureStateOf = {
    'home-coach': [homeCoachSignature, setHomeCoachSignature],
    'home-captain': [homeCaptainSignature, setHomeCaptainSignature],
    'away-coach': [awayCoachSignature, setAwayCoachSignature],
    'away-captain': [awayCaptainSignature, setAwayCaptainSignature]
  }
  const sideRoster = (side) => (side === 'home' ? homeRoster : awayRoster)
  const sideBench = (side) => (side === 'home' ? benchHome : benchAway)
  const sideTeamName = (side) => (side === 'home' ? home : away) || t(side === 'home' ? 'common.home' : 'common.away')
  const forgetSideSignatures = (side) => {
    for (const role of ['coach', 'captain']) delete signedForRef.current[PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`]]
    pendingSentRef.current[side] = null
  }

  // A test match's side given another team (Save of the info page): the
  // stored coach and captain signatures were given for the seeded roster
  const clearTestTeamSignatures = async (side, team) => {
    if (!matchId) return
    const stored = await db.matches.get(matchId)
    const roles = ['captain', 'coach'].filter(role => stored?.[PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`]])
    if (!roles.length) return
    await clearMatchSignatures(db, matchId, roles.map(role => PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`]), signaturesClearedRemark({ team, roles }))
    for (const role of roles) signatureStateOf[`${side}-${role}`][1](null)
    forgetSideSignatures(side)
    toast.info(t('roster.signaturesCleared'))
  }
  // Clear: the stored signature goes at once (saved and synced), as a pad's
  // signature is stored at once
  const clearSignatureSlot = (side, role) => {
    const slot = `${side}-${role}`
    const field = PRE_MATCH_SIGNATURE_FIELD[slot]
    signatureStateOf[slot][1](null)
    delete signedForRef.current[field]
    if (pendingSentRef.current[side]) delete pendingSentRef.current[side].signatures[role]
    if (matchId) saveMatchSignature(db, matchId, field, null, signatureUpdate(field, null, null))
  }

  // Back: the roster goes back to the one the editor opened with, and the
  // side's signatures to what is stored (a sent roster's are not). A pad
  // signature given in this visit for an edited roster no longer fits it:
  // it is cleared, with a remark, as Confirm does
  const restoreSideSignatures = async (side) => {
    const opened = side === 'home' ? originalHomeTeamRef.current : originalAwayTeamRef.current
    const openedKey = opened
      ? rosterSignatureKey(side === 'home' ? opened.homeRoster : opened.awayRoster, side === 'home' ? opened.benchHome : opened.benchAway)
      : rosterSignatureKey(sideRoster(side), sideBench(side))
    const fields = ['coach', 'captain'].map(role => PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`])
    const signedFor = {}
    for (const f of fields) if (f in signedForRef.current) signedFor[f] = signedForRef.current[f]
    // a sent signature still pending was never stored: the stored image is the
    // one from before it
    const pending = pendingSentRef.current[side]
    for (const role of Object.keys(pending?.signatures || {})) {
      const field = PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`]
      const before = pending.storedFor?.[role]
      if (before === undefined) delete signedFor[field]
      else signedFor[field] = before
    }
    forgetSideSignatures(side)
    if (!matchId) return
    let stored = await db.matches.get(matchId).catch(() => null)
    const stale = staleSignatureFields(stored, fields, signedFor, openedKey, openedKey)
    if (stale.length) {
      const roles = ['captain', 'coach'].filter(role => stale.includes(PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`]))
      await clearMatchSignatures(db, matchId, stale, signaturesClearedRemark({ team: sideTeamName(side), roles }))
      toast.info(t('roster.signaturesCleared'))
      stored = await db.matches.get(matchId).catch(() => null)
    }
    for (const role of ['coach', 'captain']) {
      const slot = `${side}-${role}`
      signatureStateOf[slot][1](stored?.[PRE_MATCH_SIGNATURE_FIELD[slot]] || null)
    }
  }

  // The editor's Save, after its players and bench are written: a sent-ahead
  // roster used here is stored as used, with its signatures when the roster
  // is still the one sent; then every signature of the side that no longer
  // fits the roster is cleared, with a remark, and the scorer is told
  const saveSideSignatures = async (side, roster, bench, openedRoster, openedBench) => {
    if (!matchId) return
    const currentKey = rosterSignatureKey(roster, bench)
    const openedKey = rosterSignatureKey(openedRoster, openedBench)
    const pending = pendingSentRef.current[side]
    if (pending) {
      for (const role of ['coach', 'captain']) {
        const field = PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`]
        const image = pending.signatures[role]
        if (image && signedForRef.current[field] === currentKey) await saveMatchSignature(db, matchId, field, image)
      }
      try {
        const fresh = await db.matches.get(matchId)
        await db.matches.update(matchId, {
          sentRosterUsed: { ...(fresh?.sentRosterUsed || {}), [side]: pending.row.updatedAt || 'sent' },
          sentRosterUsedFp: { ...(fresh?.sentRosterUsedFp || {}), [side]: sentRosterFingerprint(pending.row) }
        })
      } catch (err) {
        console.warn('[MatchSetup] Writing the sent roster failed:', err?.message)
      }
      markGameRosterAccepted(pending.row)
    }
    const fields = ['coach', 'captain'].map(role => PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`])
    const stored = await db.matches.get(matchId)
    const stale = staleSignatureFields(stored, fields, signedForRef.current, openedKey, currentKey)
    forgetSideSignatures(side)
    if (stale.length) {
      const roles = ['captain', 'coach'].filter(role => stale.includes(PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`]))
      await clearMatchSignatures(db, matchId, stale, signaturesClearedRemark({ team: sideTeamName(side), roles }))
      toast.info(t('roster.signaturesCleared'))
    }
    // the editor shows what is stored (a sent signature for a roster changed
    // before Save was not stored)
    const after = stale.length ? await db.matches.get(matchId) : stored
    for (const role of ['coach', 'captain']) {
      const slot = `${side}-${role}`
      signatureStateOf[slot][1](after?.[PRE_MATCH_SIGNATURE_FIELD[slot]] || null)
    }
  }

  function handleSignatureSave(signatureImage, meta) {
    const field = PRE_MATCH_SIGNATURE_FIELD[openSignature]
    const [side, role] = String(openSignature || '').split('-')
    // given for the roster on screen; a sent roster's signature it replaces is not stored
    if (field && currentView === side) signedForRef.current[field] = rosterSignatureKey(sideRoster(side), sideBench(side))
    if (pendingSentRef.current[side]) delete pendingSentRef.current[side].signatures[role]
    // an existing match: saved at once (owner 2026-10-07), with its phone-signing
    // record in the same update; a new one keeps it in the draft. A Re-sign
    // of a collected signature is written to the remarks
    if (field && matchId) {
      saveMatchSignature(db, matchId, field, signatureImage, signatureUpdate(field, signatureImage, meta), {
        remark: meta?.resigned ? signatureReplacedRemark({ team: sideTeamName(side), role }) : ''
      })
    }
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

    // Open scoresheet in new window: the page reads the match from this
    // device's database (?matchId=)
    const opened = openAppWindow(`/scoresheet/?matchId=${matchId}`, { features: 'width=1200,height=900', title: t('header.scoresheet') })

    if (!opened.ok) {
      setNoticeModal({ message: t(openFailedMessageKey(opened, 'matchSetup.allowPopups')) })
    }
  }

  // Handler for Load Official Match modal selection
  // ---- Saved teams and the one-cloud-match-per-official-game rule ----

  // Fill a side's roster and team officials from a saved team. Name and
  // colour only where empty (the colour where it is the default).
  // Everything stays editable.
  const applySavedTeam = (side, team, chosen = null) => {
    if (!team) return
    const { roster, bench, meta, warnings } = savedTeamToRoster(team)
    const sorted = [...(chosen || roster)].sort((a, b) => (a.number ?? 999) - (b.number ?? 999))
    if (side === 'home') {
      setHomeRoster(sorted)
      setBenchHome(bench)
      if (!home?.trim() || home === 'Home') setHome(meta.name)
      if (meta.color && isDefaultTeamColour('home', homeColor)) setHomeColor(meta.color)
    } else {
      setAwayRoster(sorted)
      setBenchAway(bench)
      if (!away?.trim() || away === 'Away') setAway(meta.name)
      if (meta.color && isDefaultTeamColour('away', awayColor)) setAwayColor(meta.color)
    }
    toast.success(t('savedTeams.loaded', { name: team.name }))
    for (const w of warnings) toast.info(t(w.key, w.params))
  }

  // ---- The player pool: load all the players of a team and tick who plays ----

  // Every player known for a side: the roster now (unless it is replaced),
  // an Einsatzliste just read, the saved team (the one picked, else the
  // schedule suggestion) and earlier matches of the team on this device.
  // `withClub` ("Choose players" only): the walkthrough's demo account adds
  // its club's list (domain/walkthroughDemo: players the demo saved team does
  // not have come unticked); never for a saved team picked (it would ask to
  // choose instead of loading the team), never for a real account
  const buildPoolFor = async (side, { savedTeam = null, imported = null, includeCurrent = true, withClub = false } = {}) => {
    const name = side === 'home' ? home : away
    // A guest match: only what is in this form or was just imported
    const saved = guestMatch ? null : (savedTeam || savedSuggestion?.[side] || null)
    const names = guestMatch ? [] : [...new Set([name, saved?.name, saved?.svrzTeamName].filter(n => String(n || '').trim()))]
    const earlier = []
    for (const n of names) {
      for (const r of await rememberedRosters(n, { excludeTeamIds: [match?.homeTeamId, match?.awayTeamId] })) {
        if (!earlier.some(e => e.teamId === r.teamId)) earlier.push(r)
      }
    }
    earlier.sort((a, b) => b.at - a.at)
    return buildPlayerPool({
      current: includeCurrent ? (side === 'home' ? homeRoster : awayRoster) : [],
      imported: imported || [],
      saved: saved ? savedTeamToRoster(saved).roster : [],
      earlier: earlier.map(r => r.players),
      club: withClub && isWalkthroughDemoUser(user?.id) && clubTeams[side]
        ? addClubPlayersToRoster([], offeredClubPlayers(clubTeams[side].players, clubGender).players).roster
        : []
    })
  }

  const openPlayerPool = async (side, opts = {}) => {
    const pool = await buildPoolFor(side, opts)
    setPlayerPool({
      side,
      pool,
      savedTeam: opts.savedTeam || null,
      summary: opts.summary || null,
      teamLabel: opts.savedTeam?.name || (side === 'home' ? home : away) || t(side === 'home' ? 'matchSetup.homeTeam' : 'matchSetup.awayTeam')
    })
    return pool
  }

  // The ticked players become the roster, as a saved-team load sets it. From
  // the main view the team's stored players of this match follow; in the
  // roster editor only its Save writes them (its Back discards the choice)
  const applyPlayerPool = async (entries) => {
    const pending = playerPool
    setPlayerPool(null)
    if (!pending) return
    const { side, savedTeam, summary } = pending
    const roster = poolToRoster(entries)
    if (savedTeam) applySavedTeam(side, savedTeam, roster)
    else if (side === 'home') setHomeRoster(roster)
    else setAwayRoster(roster)
    const teamId = side === 'home' ? match?.homeTeamId : match?.awayTeamId
    const inRosterEditor = currentView === 'home' || currentView === 'away'
    if (matchId && teamId && !inRosterEditor) {
      try {
        await db.transaction('rw', db.players, async () => {
          await db.players.where('teamId').equals(teamId).delete()
          await db.players.bulkAdd(roster.map(p => ({
            teamId,
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
          })))
        })
      } catch (err) {
        console.warn('[MatchSetup] Writing the chosen players failed:', err?.message)
      }
    }
    if (summary) setImportSummaryModal({ ...summary, players: roster.length, errors: [] })
    else if (!savedTeam) toast.success(t('playerPool.applied', { count: roster.length }))
  }

  // db/023: a sent roster becomes the side's roster and team officials, as an
  // accepted remote roster does (after the usual question when the side has
  // players already), with the coach's and captain's signatures when they
  // signed ahead. From the main view the stored players follow; in the
  // roster editor only its Save writes them, stores the signatures and marks
  // the roster used (its Back loses nothing). Accepted = used: the server
  // deletes its copy (owner 2026-11-08), now or once the tablet is online.
  const applySentRoster = async (side) => {
    const row = sentRosters[side]
    if (!row) return
    const ok = await confirmReplaceRoster({
      roster: side === 'home' ? homeRoster : awayRoster,
      bench: side === 'home' ? benchHome : benchAway,
      teamLabel: row.teamName || (side === 'home' ? home : away) || '',
      t
    })
    if (!ok) return
    const pending = rowToPendingRoster(row)
    const roster = [...pending.players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999))
    const bench = pending.bench.length ? pending.bench : [{ role: 'Coach', firstName: '', lastName: '', dob: '' }]
    if (side === 'home') {
      setHomeRoster(roster)
      setBenchHome(bench)
      if (pending.coachSignature) setHomeCoachSignature(pending.coachSignature)
      if (pending.captainSignature) setHomeCaptainSignature(pending.captainSignature)
    } else {
      setAwayRoster(roster)
      setBenchAway(bench)
      if (pending.coachSignature) setAwayCoachSignature(pending.coachSignature)
      if (pending.captainSignature) setAwayCaptainSignature(pending.captainSignature)
    }
    const teamId = side === 'home' ? match?.homeTeamId : match?.awayTeamId
    const inRosterEditor = currentView === 'home' || currentView === 'away'
    if (inRosterEditor) {
      // given for the roster as sent: stored by Save only while it still is
      const key = rosterSignatureKey(roster, bench)
      const signatures = {}
      // what the stored image (not this one) was given for, for Back
      const storedFor = { ...(pendingSentRef.current[side]?.storedFor || {}) }
      for (const [role, image] of [['coach', pending.coachSignature], ['captain', pending.captainSignature]]) {
        if (!image) continue
        const field = PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`]
        signatures[role] = image
        if (!(role in storedFor)) storedFor[role] = signedForRef.current[field]
        signedForRef.current[field] = key
      }
      pendingSentRef.current[side] = { row, signatures, storedFor }
      toast.success(t('sentRoster.used', { count: roster.length }))
      return
    }
    // signed ahead: saved at once, as a pad's signature is (and synced)
    if (matchId) {
      for (const [role, image] of [['coach', pending.coachSignature], ['captain', pending.captainSignature]]) {
        const field = PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`]
        if (image && field) await saveMatchSignature(db, matchId, field, image)
      }
    }
    if (matchId) {
      try {
        if (teamId) {
          await db.transaction('rw', db.players, async () => {
            await db.players.where('teamId').equals(teamId).delete()
            await db.players.bulkAdd(roster.map(p => ({
              teamId,
              number: p.number,
              firstName: p.firstName,
              lastName: p.lastName,
              name: `${p.lastName} ${p.firstName}`.trim(),
              dob: p.dob || null,
              libero: p.libero || '',
              isCaptain: !!p.isCaptain,
              isLfp: !!p.isLfp,
              role: null,
              createdAt: new Date().toISOString()
            })))
          })
        }
        await db.matches.update(matchId, {
          [side === 'home' ? 'bench_home' : 'bench_away']: bench,
          sentRosterUsed: { ...(match?.sentRosterUsed || {}), [side]: row.updatedAt || 'sent' },
          // its content: the same sent again later is not offered again
          sentRosterUsedFp: { ...(match?.sentRosterUsedFp || {}), [side]: sentRosterFingerprint(row) }
        })
      } catch (err) {
        console.warn('[MatchSetup] Writing the sent roster failed:', err?.message)
      }
      // a signature of the replaced roster that the sent one did not bring
      // goes (domain/rosterSignatures)
      const currentKey = rosterSignatureKey(roster, bench)
      const signedFor = {}
      if (pending.coachSignature) signedFor[PRE_MATCH_SIGNATURE_FIELD[`${side}-coach`]] = currentKey
      if (pending.captainSignature) signedFor[PRE_MATCH_SIGNATURE_FIELD[`${side}-captain`]] = currentKey
      const stored = await db.matches.get(matchId).catch(() => null)
      const fields = ['coach', 'captain'].map(role => PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`])
      const stale = staleSignatureFields(stored, fields, signedFor, rosterSignatureKey(sideRoster(side), sideBench(side)), currentKey)
      if (stale.length) {
        const roles = ['captain', 'coach'].filter(role => stale.includes(PRE_MATCH_SIGNATURE_FIELD[`${side}-${role}`]))
        await clearMatchSignatures(db, matchId, stale, signaturesClearedRemark({ team: sideTeamName(side), roles }))
        for (const role of roles) signatureStateOf[`${side}-${role}`][1](null)
      }
    }
    markGameRosterAccepted(row)
    toast.success(t('sentRoster.used', { count: roster.length }))
  }
  const dismissSentRoster = async (side) => {
    const row = sentRosters[side]
    if (!row || !matchId) return
    try {
      await db.matches.update(matchId, { sentRosterDismissed: { ...(match?.sentRosterDismissed || {}), [side]: row.updatedAt || 'sent' } })
    } catch (err) {
      console.warn('[MatchSetup] Putting the sent roster aside failed:', err?.message)
    }
  }

  const closePlayerPool = () => {
    const pending = playerPool
    setPlayerPool(null)
    // An Einsatzliste stays imported whole when the choice is cancelled
    if (pending?.summary) setImportSummaryModal({ ...pending.summary, errors: [] })
  }

  // A saved team picked (the picker or the schedule suggestion): straight in
  // when it fits and nothing else is known of the team; else the choice,
  // with all its players and those of earlier matches
  const pickSavedTeam = async (side, team) => {
    if (!team) return
    const pool = await buildPoolFor(side, { savedTeam: team, includeCurrent: false })
    const active = savedTeamToRoster(team).roster.length
    if (active > ROSTER_MAX || pool.length > active) await openPlayerPool(side, { savedTeam: team, includeCurrent: false })
    else applySavedTeam(side, team)
  }

  const loadSuggestedTeam = async (side) => {
    const team = savedSuggestion?.[side]
    if (!team) return
    const ok = await confirmReplaceRoster({
      roster: side === 'home' ? homeRoster : awayRoster,
      bench: side === 'home' ? benchHome : benchAway,
      teamLabel: (side === 'home' ? home : away) || team.name,
      t
    })
    if (ok) await pickSavedTeam(side, team)
  }

  // After a schedule load without a saved team: choose the players of a team
  // that earlier matches on this device know
  const chooseRememberedPlayers = async (side) => {
    const ok = await confirmReplaceRoster({
      roster: side === 'home' ? homeRoster : awayRoster,
      bench: side === 'home' ? benchHome : benchAway,
      teamLabel: (side === 'home' ? home : away) || '',
      t
    })
    if (ok) await openPlayerPool(side, { includeCurrent: false })
  }

  // Is this official game already scored by another cloud match? null when
  // it cannot be asked (no game number, not a scorer, offline, network error).
  const checkOfficialGame = async ({ gameNumber, dateValue, timeValue, timeoutMs }) => {
    const n = parseInt(gameNumber, 10)
    if (!access?.canScore || isLocalOnly(match) || !Number.isInteger(n) || n <= 0) return null
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return null
    let scheduled = null
    try { scheduled = dateValue ? createScheduledAt(dateValue, timeValue, { allowEmpty: true }) : null } catch { scheduled = null }
    const { data, error } = await officialCheck({ game_n: n, scheduled_at: scheduled, sport_type: 'indoor', external_id: match?.seed_key || null }, { timeoutMs })
    if (error || !data) return null
    // db/018: may this account score this game at all? (absent on an older server)
    if (data.club) serverClubRef.current = data.club
    return data.taken ? (data.claim || { mine: false }) : false
  }

  /** The club verdict for the game in the form: the server's, else the cached clubs' (schedule games only). */
  const currentClubBlock = (homeName) => matchClubBlock({
    access,
    server: serverClubRef.current,
    homeTeam: homeName,
    scheduleHome: scheduleHomeRef.current,
    isTest: isLocalOnly(match)
  })
  const clubBlockText = (v) => v.code === 'OV_CLUB_REQUIRED'
    ? t('matchSetup.clubRequired')
    : v.code === 'OV_GAME_NOT_IN_SCHEDULE'
      ? t('matchSetup.gameNotInSchedule', { game: gameN })
      : t('matchSetup.notYourClub', { home: v.home_team || home, clubs: (v.clubs || []).join(', ') })

  // Back on the info view (owner 2026-11-11): the schedule game picked there is
  // undone whole, its suggestions and banners too, and a check still running
  // for it answers nothing (afterOfficialLoad compares its game)
  const scheduleLoadRef = useRef(null)
  // A schedule pick shows the spinner until its suggestions and checks are
  // in, then the filled form with its banners at once (owner 2026-11-11:
  // "after selecting a game -> loads then loads the content"). At most
  // SCHEDULE_LOAD_WAIT_MS: a slow check then answers into the shown form.
  const [scheduleLoading, setScheduleLoading] = useState(false)
  const forgetScheduleLoad = () => {
    scheduleLoadRef.current = null
    setScheduleLoading(false)
    setSavedSuggestion(null)
    setRememberedSuggestion(null)
    setOfficialClaim(null)
    setClubBlock(null)
    serverClubRef.current = undefined
    scheduleHomeRef.current = null
  }

  // After a schedule load: saved-team suggestions and the game-taken check
  const afterOfficialLoad = async (matchData) => {
    const token = {}
    scheduleLoadRef.current = token
    const current = () => scheduleLoadRef.current === token
    // A guest match: the schedule's public data only; no saved teams, no
    // rosters of earlier matches on the device, no club or game-taken check
    // (those need an account, and the match never reaches the database)
    if (guestMatch) return
    try {
      if (access?.canReadTeams) {
        const teams = await getSavedTeams({ userId: user?.id ?? null })
        const found = findSavedTeamSuggestions(teams, {
          home: matchData.home,
          away: matchData.away,
          league: matchData.league,
          gender: matchData.type2,
          scheduledAt: matchData.date ? `${matchData.date}T${matchData.time || '12:00'}:00` : null
        })
        if (current()) setSavedSuggestion(found.home || found.away ? found : null)
      }
    } catch (err) {
      console.warn('[MatchSetup] Saved-team suggestions failed:', err?.message)
    }
    // Players of these teams in earlier matches on this device (any scorer)
    const exclude = { excludeTeamIds: [match?.homeTeamId, match?.awayTeamId] }
    const [homeEarlier, awayEarlier] = await Promise.all([rememberedRosters(matchData.home, exclude), rememberedRosters(matchData.away, exclude)])
    const count = (list) => buildPlayerPool({ earlier: list.map(r => r.players) }).length
    const remembered = { home: count(homeEarlier), away: count(awayEarlier) }
    if (!current()) return
    setRememberedSuggestion(remembered.home || remembered.away ? remembered : null)
    serverClubRef.current = undefined
    scheduleHomeRef.current = matchData.home || null
    try {
      const claim = await checkOfficialGame({ gameNumber: matchData.gameN, dateValue: matchData.date, timeValue: matchData.time })
      if (!current()) return
      setOfficialClaim(claim && !claim.mine ? claim : null)
    } catch { /* the check is a courtesy: the server enforces the rule */ }
    if (current()) setClubBlock(currentClubBlock(matchData.home))
  }

  // Swap the two sides' rosters, benches and pre-match signatures in the
  // form (the colours and names are info fields): each roster stays with its
  // team when the schedule has home and away the other way round
  const swapSidesInForm = () => {
    setHomeRoster(awayRoster); setAwayRoster(homeRoster)
    setBenchHome(benchAway); setBenchAway(benchHome)
    setHomeCoachSignature(awayCoachSignature); setAwayCoachSignature(homeCoachSignature)
    setHomeCaptainSignature(awayCaptainSignature); setAwayCaptainSignature(homeCaptainSignature)
    setSavedSignatures(p => ({ homeCoach: p.awayCoach, homeCaptain: p.awayCaptain, awayCoach: p.homeCoach, awayCaptain: p.homeCaptain }))
  }

  // Global tool: a game of an uploaded sheet fills the match info; the file is
  // read on this device only, so no club check, no schedule checks, no claim
  const applyGlobalGame = (g) => {
    if (setupLocked) return
    setDate(g.date || ''); setTime(g.time || '')
    setCity(g.city || ''); setHall(g.hall || '')
    if (g.bestOf) setBestOf(g.bestOf)
    setGameN(g.gameN || ''); setLeague(g.league || '')
    setHome(g.home || ''); setAway(g.away || '')
    const ref = (n) => ({ first: g[`referee${n}First`] || '', last: g[`referee${n}Last`] || '' })
    setRef1First(ref(1).first); setRef1Last(ref(1).last); setRef1Dob(''); setRef1Email('')
    setRef2First(ref(2).first); setRef2Last(ref(2).last); setRef2Dob(''); setRef2Email('')
  }
  // ...and a team of an uploaded roster sheet fills one side (after the usual
  // question when the side has players already)
  const applyGlobalTeam = async (side, team) => {
    if (setupLocked) return
    const ok = await confirmReplaceRoster({
      roster: side === 'home' ? homeRoster : awayRoster,
      bench: side === 'home' ? benchHome : benchAway,
      teamLabel: team.name || (side === 'home' ? home : away) || '',
      t
    })
    if (!ok) return
    const roster = [...team.players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999))
    const bench = team.bench.length ? team.bench : [{ role: 'Coach', firstName: '', lastName: '', dob: '' }]
    if (side === 'home') { setHomeRoster(roster); setBenchHome(bench); if (team.name && !home) setHome(team.name) }
    else { setAwayRoster(roster); setBenchAway(bench); if (team.name && !away) setAway(team.name) }
    toast.success(t('globalImport.applied', { count: roster.length, defaultValue: '{{count}} players added' }))
  }

  const handleOfficialMatchSelect = async (matchData) => {
    if (setupLocked) return
    // db/018: a game of another club is never applied (the list leaves them out; ICAL fallback, stale list)
    if (!isLocalOnly(match)) {
      const blocked = clubVerdict(access, matchData?.home)
      if (blocked) { showAlert(clubBlockText(blocked), 'error'); return }
    }
    // Rosters entered under other team names: ask before the schedule renames
    // the teams (each roster would end up under the other club's name). Home
    // and away the other way round: the rosters move with their teams.
    let swap = false
    const typed = home?.trim() || away?.trim()
    // A test match's seeded players are not the scorer's: they go with their
    // team on Save (takeTestMatchTeam), nothing to ask about
    const own = (roster) => (match?.test === true ? roster.filter(p => !isSeedTestPlayer(p)) : roster)
    if (typed && (own(homeRoster).length > 0 || own(awayRoster).length > 0) && !(sameTeamName(matchData?.home, home) && sameTeamName(matchData?.away, away))) {
      const names = { home: matchData?.home || '', away: matchData?.away || '', ourHome: home || '', ourAway: away || '' }
      if (sameTeamName(matchData?.home, away) && sameTeamName(matchData?.away, home)) {
        const ok = await confirmDialog({
          title: t('matchSetup.scheduleSwapTitle'),
          message: t('matchSetup.scheduleSwapBody', names),
          confirmLabel: t('matchSetup.scheduleSwapConfirm'),
          cancelLabel: t('common.cancel', 'Cancel')
        })
        if (!ok) return
        swap = true
      } else {
        const ok = await confirmDialog({
          title: t('matchSetup.scheduleTeamsTitle'),
          message: t('matchSetup.scheduleTeamsBody', names),
          confirmLabel: t('matchSetup.scheduleTeamsConfirm'),
          cancelLabel: t('common.cancel', 'Cancel'),
          tone: 'danger'
        })
        if (!ok) return
      }
    }
    if (swap) {
      swapSidesInForm()
      // the sponsors on clothing are the team's, like its roster (info fields:
      // the info draft keeps them swapped, Back restores them)
      setHomeSponsors(awaySponsors); setAwaySponsors(homeSponsors)
      setHomeColor(awayColor)
      setAwayColor(homeColor)
      rosterSwapRef.current = !rosterSwapRef.current
    }
    // Populate all the form fields from the selected official match
    setDate(matchData.date)
    setTime(matchData.time)
    setCity(matchData.city)
    setHall(matchData.hall)
    // a schedule row without a value keeps a usable one (the sheet's category
    // boxes stay empty for a missing one)
    setType1(matchData.type1 || 'championship')
    const ct = championshipTypeFields({ championshipType: matchData.championshipType })
    setChampionshipType(ct.championshipType || 'regional')
    if (ct.championshipType === 'other') setChampionshipTypeOther(ct.championshipTypeOther)
    if (matchData.type2) setType2(matchData.type2)
    setType3(matchData.type3 || 'senior')
    setType3Other(matchData.type3 === 'other' ? (matchData.type3Other || '') : '')
    // the schedule's format when it knows one, else none: the scorer chooses
    setBestOf(knownMatchFormat(matchData.bestOf))
    setGameN(matchData.gameN)
    setLeague(matchData.league)
    setHome(matchData.home)
    setAway(matchData.away)

    // Referees and line judges: this game's, or none (a second game loaded
    // kept the first game's referees, their DOB and line judges)
    // The referees' value: their licence when the schedule has one, never the
    // schedule's date of birth (owner 2026-11-19)
    const { ref1, ref2, lineJudge1: lj1, lineJudge2: lj2 } = officialsFromSchedule(matchData)
    setRef1First(ref1.first); setRef1Last(ref1.last); setRef1Country(ref1.country); setRef1Dob(licenceOf(matchData?.referee1Licence) || ''); setRef1Email('')
    setRef2First(ref2.first); setRef2Last(ref2.last); setRef2Country(ref2.country); setRef2Dob(licenceOf(matchData?.referee2Licence) || ''); setRef2Email('')
    setLineJudge1(lj1)
    setLineJudge2(lj2)

    // Saved rosters for these teams, and whether another scorer has the game
    setSavedSuggestion(null)
    setRememberedSuggestion(null)
    setOfficialClaim(null)
    setScheduleLoading(true)
    const loaded = afterOfficialLoad(matchData).catch((err) => {
      console.warn('[MatchSetup] Schedule load checks failed:', err?.message)
    })
    // the token afterOfficialLoad set: a newer pick or Back owns the spinner then
    const mine = scheduleLoadRef.current
    let timer
    Promise.race([loaded, new Promise((resolve) => { timer = setTimeout(resolve, SCHEDULE_LOAD_WAIT_MS) })]).then(() => {
      clearTimeout(timer)
      if (scheduleLoadRef.current === mine) setScheduleLoading(false)
    })
  }

  // A game picked on the home screen (App: today's home games of the
  // account's clubs): once the new match's stored fields are in, the info page
  // opens (its Back snapshot taken first, as for "Load match from schedule")
  // and the game fills it, with the same checks as a schedule pick. Never on a
  // created or test match.
  const [pickedGamePhase, setPickedGamePhase] = useState(0)
  useEffect(() => {
    if (!initialOfficialGame || pickedGamePhase !== 0 || !matchId || storedAppliedFor !== matchId) return
    if (match?.matchInfoConfirmedAt || isLocalOnly(match)) {
      onInitialOfficialGameUsed?.()
      return
    }
    setPickedGamePhase(1)
    setCurrentView('info')
  }, [initialOfficialGame, pickedGamePhase, matchId, storedAppliedFor, match, onInitialOfficialGameUsed])
  useEffect(() => {
    if (pickedGamePhase !== 1 || currentView !== 'info' || !initialOfficialGame) return
    setPickedGamePhase(2)
    handleOfficialMatchSelect(initialOfficialGame)
    onInitialOfficialGameUsed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedGamePhase, currentView, initialOfficialGame])

  // Back from the info page after a swapping schedule load: the rosters return
  const undoRosterSwap = () => {
    if (!rosterSwapRef.current) return
    swapSidesInForm()
    rosterSwapRef.current = false
  }

  // The match's unsaved draft (db/setupDrafts), once its stored fields are
  // in: its page opens (the Back snapshot taken from the stored values first,
  // as for a picked game), then the draft fills it. Dropped on a match that is
  // read-only now or opened for a picked game; drafts of matches no longer on
  // the device go too.
  const draftCheckedRef = useRef(null)
  const [draftToApply, setDraftToApply] = useState(null)
  useEffect(() => {
    if (!matchId || storedAppliedFor !== matchId || draftCheckedRef.current === matchId) return
    draftCheckedRef.current = matchId
    let alive = true
    ;(async () => {
      let draft = null
      try {
        await dropStaleSetupDrafts()
        draft = await readSetupDraft(matchId)
        if (draft && (setupLocked || initialOfficialGame || !draft.data || !['info', 'home', 'away'].includes(draft.view))) {
          await clearSetupDraft(matchId)
          draft = null
        }
      } catch (err) {
        console.warn('[MatchSetup] Reading the draft failed:', err?.message)
        draft = null
      }
      if (!alive) return
      if (!draft) { setDraftReadyFor(matchId); return }
      setDraftToApply(draft)
      setCurrentView(draft.view)
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, storedAppliedFor])
  useEffect(() => {
    if (!draftToApply || currentView !== draftToApply.view) return
    const { view, data } = draftToApply
    setDraftToApply(null)
    if (view === 'info') {
      const setters = {
        date: setDate, time: setTime, hall: setHall, city: setCity, type1: setType1, type1Other: setType1Other,
        championshipType: setChampionshipType, championshipTypeOther: setChampionshipTypeOther, type2: setType2, type3: setType3,
        type3Other: setType3Other, bestOf: setBestOf, pointsRegular: setPointsRegular, pointsDeciding: setPointsDeciding, gameN: setGameN, league: setLeague, home: setHome, away: setAway,
        homeColor: setHomeColor, awayColor: setAwayColor,
        ref1First: setRef1First, ref1Last: setRef1Last, ref1Country: setRef1Country, ref1Dob: setRef1Dob, ref1Email: setRef1Email,
        homeContactEmail: setHomeContactEmail, awayContactEmail: setAwayContactEmail,
        homeSponsors: setHomeSponsors, awaySponsors: setAwaySponsors, sponsorsMarked: setSponsorsMarked,
        longIntervalAfterSet2: (v) => setLongIntervalAfterSet2(v === true),
        ref2First: setRef2First, ref2Last: setRef2Last, ref2Country: setRef2Country, ref2Dob: setRef2Dob, ref2Email: setRef2Email,
        scorerFirst: setScorerFirst, scorerLast: setScorerLast, scorerCountry: setScorerCountry, scorerDob: setScorerDob, scorerLicence: setScorerLicence,
        asstFirst: setAsstFirst, asstLast: setAsstLast, asstCountry: setAsstCountry, asstDob: setAsstDob,
        lineJudge1: setLineJudge1, lineJudge2: setLineJudge2, lineJudge3: setLineJudge3, lineJudge4: setLineJudge4
      }
      for (const key of INFO_DRAFT_KEYS) if (key in data) setters[key](data[key])
      if (data.date !== undefined) handleDateChange(data.date)
      if (data.time !== undefined) handleTimeChange(data.time)
      if (data.swapRosters) {
        swapSidesInForm()
        rosterSwapRef.current = true
      }
    } else if (Array.isArray(data.roster)) {
      if (view === 'home') { setHomeRoster(data.roster); if (Array.isArray(data.bench)) setBenchHome(data.bench) }
      else { setAwayRoster(data.roster); if (Array.isArray(data.bench)) setBenchAway(data.bench) }
    }
    setDraftReadyFor(matchId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftToApply, currentView])

  // Read-only: only the main view
  useEffect(() => {
    if (setupLocked && currentView !== 'main') setCurrentView('main')
  }, [setupLocked, currentView])

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
  // Only that upload (`roster`): one the team made again before the job is
  // sent stays on the server for the next check (21.11.2026).
  const clearServerPendingRoster = async (team, roster = null) => {
    if (!match?.seed_key || !match?.matchInfoConfirmedAt) return
    try {
      await db.sync_queue.add(clearPendingRosterJob(match.seed_key, team, roster))
    } catch (err) {
      console.warn('[MatchSetup] Failed to queue the pending roster clean-up:', err)
    }
  }

  // A team's uploaded roster (domain/uploadedRoster): checked again here, as
  // it came from the server, a relay or a restore, before the preview shows
  // it or Accept stores it. Accept only before the coin toss (the events of a
  // running match name its players by number), after the usual question when
  // the team has players already; Reject always.
  const pendingRosterOf = (team) => (team === 'home' ? match?.pendingHomeRoster : match?.pendingAwayRoster)
  // The coach's and captain's signatures the match has (an upload fills only empty ones)
  const storedSignaturesOf = (team) => (team === 'home'
    ? { coach: match?.homeCoachSignature, captain: match?.homeCaptainSignature }
    : { coach: match?.awayCoachSignature, captain: match?.awayCaptainSignature })
  const acceptingPendingRef = useRef(false)
  const acceptPendingRoster = async (team) => {
    const raw = pendingRosterOf(team)
    if (!matchId || !raw || acceptingPendingRef.current) return
    acceptingPendingRef.current = true
    try {
      await acceptCheckedPendingRoster(team, raw)
    } finally {
      acceptingPendingRef.current = false
    }
  }
  const acceptCheckedPendingRoster = async (team, raw) => {
    const isHome = team === 'home'
    if (!takesUploadedRoster(match)) {
      setNoticeModal({ message: t('matchSetup.uploadedRosterStarted') })
      return
    }
    const checked = checkUploadedRoster(raw)
    if (!checked.ok) {
      setNoticeModal({ message: t('matchSetup.uploadedRosterInvalid') })
      return
    }
    const ok = await confirmReplaceRoster({
      roster: isHome ? homeRoster : awayRoster,
      bench: isHome ? benchHome : benchAway,
      teamLabel: (isHome ? home : away) || '',
      t
    })
    if (!ok) return
    const { players, bench } = checked.roster
    // Into empty slots only: a signature the match has stays (the card says so)
    const signatures = uploadedSignaturesToTake(checked.roster, storedSignaturesOf(team))
    const teamId = isHome ? match.homeTeamId : match.awayTeamId
    const pendingField = isHome ? 'pendingHomeRoster' : 'pendingAwayRoster'
    // What Accept records: this upload is taken (never offered again, nor its
    // content uploaded again), and the card goes unless a newer upload came
    // in while the scorer answered (it stays, offered as a new version)
    const acceptedUpdate = (fresh) => ({
      [pendingField]: !fresh?.[pendingField] || sameUpload(fresh[pendingField], raw) ? null : fresh[pendingField],
      uploadedRosterTaken: takenAfter(fresh, team, raw, 'accepted')
    })
    // the accepted players with their stored ids (none without a team):
    // the roster editor's Confirm then updates the same rows, players
    // without a shirt number included
    let acceptedPlayers = players
    try {
      if (teamId) {
        // One transaction: a failure leaves the roster as it was
        const matchUpdate = { [isHome ? 'bench_home' : 'bench_away']: bench }
        if (signatures.coach) matchUpdate[isHome ? 'homeCoachSignature' : 'awayCoachSignature'] = signatures.coach
        if (signatures.captain) matchUpdate[isHome ? 'homeCaptainSignature' : 'awayCaptainSignature'] = signatures.captain
        await db.transaction('rw', db.players, db.matches, async () => {
          Object.assign(matchUpdate, acceptedUpdate(await db.matches.get(matchId)))
          await db.players.where('teamId').equals(teamId).delete()
          if (players.length) {
            const storedIds = await db.players.bulkAdd(players.map(p => ({
              teamId,
              number: p.number,
              name: `${p.lastName} ${p.firstName}`.trim(),
              lastName: p.lastName,
              firstName: p.firstName,
              dob: p.dob || null,
              libero: p.libero,
              isCaptain: p.isCaptain,
              isLfp: p.isLfp,
              role: null,
              createdAt: new Date().toISOString()
            })), { allKeys: true })
            if (Array.isArray(storedIds)) acceptedPlayers = players.map((p, i) => ({ ...p, id: storedIds[i] }))
          }
          await db.matches.update(matchId, matchUpdate)
        })
        console.log(`[MatchSetup] Accepted ${team} roster with signatures:`, { hasCoach: !!signatures.coach, hasCaptain: !!signatures.captain })
      } else {
        // No team yet: just clear pending
        await db.transaction('rw', db.matches, async () => {
          await db.matches.update(matchId, acceptedUpdate(await db.matches.get(matchId)))
        })
      }
    } catch (err) {
      console.warn('[MatchSetup] Accepting the uploaded roster failed:', err?.message)
      setNoticeModal({ message: t('matchSetup.uploadedRosterSaveFailed') })
      return
    }
    if (isHome) {
      setHomeRoster(acceptedPlayers)
      setBenchHome(bench)
      if (signatures.coach) setHomeCoachSignature(signatures.coach)
      if (signatures.captain) setHomeCaptainSignature(signatures.captain)
    } else {
      setAwayRoster(acceptedPlayers)
      setBenchAway(bench)
      if (signatures.coach) setAwayCoachSignature(signatures.coach)
      if (signatures.captain) setAwayCaptainSignature(signatures.captain)
    }
    // Accept stores the roster (and marks the upload taken): the roster
    // editor's Back no longer goes back to the roster it opened with. It did,
    // and the uploaded players were gone from the form while stored (the next
    // save wrote the old roster over them; tester 23.11.2026)
    if (teamId && currentView === team) {
      acceptedInVisitRef.current[team] = true
      const opened = { roster: JSON.parse(JSON.stringify(acceptedPlayers)), bench: JSON.parse(JSON.stringify(bench)) }
      if (isHome) originalHomeTeamRef.current = { homeRoster: opened.roster, benchHome: opened.bench }
      else originalAwayTeamRef.current = { awayRoster: opened.roster, benchAway: opened.bench }
    }
    await clearServerPendingRoster(team, raw)
  }
  // Reject: this upload is not offered again (the server's copy is cleared
  // too); a newer one that came in meanwhile stays
  const rejectPendingRoster = async (team) => {
    if (!matchId) return
    const raw = pendingRosterOf(team)
    const pendingField = team === 'home' ? 'pendingHomeRoster' : 'pendingAwayRoster'
    try {
      await db.transaction('rw', db.matches, async () => {
        const fresh = await db.matches.get(matchId)
        const update = { [pendingField]: !raw || !fresh?.[pendingField] || sameUpload(fresh[pendingField], raw) ? null : fresh[pendingField] }
        if (raw) update.uploadedRosterTaken = takenAfter(fresh, team, raw, 'rejected')
        await db.matches.update(matchId, update)
      })
    } catch (err) {
      console.warn('[MatchSetup] Rejecting the uploaded roster failed:', err?.message)
      return
    }
    await clearServerPendingRoster(team, raw)
  }
  // On the main view: a team's roster waits (why the app opened Match Setup),
  // with the way to its card
  const renderPendingRosterNotice = (team) => pendingRosterOf(team) ? (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-200 bg-sky-50/60 px-3 py-2 text-sm text-stone-800" data-testid={`pending-roster-notice-${team}`}>
      <span>{uploadIsNewVersion(match, team) ? t('matchSetup.rosterCheck.newVersion') : t('matchSetup.rosterUploaded')}</span>
      {/* after the coin toss the roster editor is closed: Reject only */}
      {setupLocked ? (
        <Button variant="danger-outline" size="sm" onClick={() => rejectPendingRoster(team)} data-testid={`pending-roster-notice-${team}-reject`}>
          {t('matchSetup.rejectRoster')}
        </Button>
      ) : (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          // the uploaded roster's card is in Roster import › Remote
          setImportModeBySide((m) => ({ ...m, [team]: 'remote' }))
          setCurrentView(team)
        }}
      >
        {t('matchSetup.uploadedRosterOpen')}
      </Button>
      )}
    </div>
  ) : null
  // The card of a team's uploaded roster (Edit roster -> Remote): counts of
  // the checked roster, the uploaded signatures Accept leaves out (the match
  // has them), Accept only for a roster the rules take before the coin toss,
  // Reject always
  const renderPendingRosterCard = (team) => {
    const raw = pendingRosterOf(team)
    if (!raw) return null
    const checked = checkUploadedRoster(raw)
    const started = !takesUploadedRoster(match)
    const kept = checked.ok && !started ? uploadedSignaturesKept(checked.roster, storedSignaturesOf(team)) : {}
    return (
      <div className="mt-3 rounded-xl border border-sky-200 bg-white p-3" data-testid={`pending-roster-${team}`}>
        <h4 className="mt-0 mb-2 text-sm font-semibold text-stone-800" data-testid={`pending-roster-title-${team}`}>{uploadIsNewVersion(match, team) ? t('matchSetup.rosterCheck.newVersion') : t('matchSetup.rosterUploaded')}</h4>
        {checked.ok ? (
          <div className="mb-3 flex flex-col gap-1 text-xs text-stone-600">
            <div>
              {t('matchSetup.playersCount')}: {checked.roster.players.length}
            </div>
            <div>
              {t('matchSetup.benchOfficialsCount')}: {checked.roster.bench.length}
            </div>
          </div>
        ) : (
          <p role="alert" className="mb-3 text-xs text-red-700">{t('matchSetup.uploadedRosterInvalid')}</p>
        )}
        {checked.ok && started && (
          <p className="mb-3 text-xs text-amber-800">{t('matchSetup.uploadedRosterStarted')}</p>
        )}
        {kept.coach && (
          <p className="mb-3 text-xs text-amber-800" data-testid={`pending-roster-${team}-coach-signature-kept`}>{t('matchSetup.uploadedCoachSignatureKept')}</p>
        )}
        {kept.captain && (
          <p className="mb-3 text-xs text-amber-800" data-testid={`pending-roster-${team}-captain-signature-kept`}>{t('matchSetup.uploadedCaptainSignatureKept')}</p>
        )}
        {checked.ok && (
          <div className="mb-2 flex gap-2">
            <Button variant="secondary" size="xl" className="flex-1" onClick={() => setRosterPreview(team)}>
              {t('matchSetup.previewRoster')}
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          {checked.ok && !started && (
            <Button variant="positive" size="xl" className="flex-1" onClick={() => acceptPendingRoster(team)}>
              {t('matchSetup.acceptRoster')}
            </Button>
          )}
          <Button variant="secondary" size="xl" className="flex-1" onClick={() => rejectPendingRoster(team)}>
            {t('matchSetup.rejectRoster')}
          </Button>
        </div>
      </div>
    )
  }

  // Check server for rosters (Edit roster -> Remote): both places a team's
  // roster comes from, the upload made with the upload PIN (the match's row,
  // connections.pending_{team}_roster) and the roster sent from the manager
  // site (db/023; asked again now, then the device's copy, so offline still
  // finds one downloaded before). 17.11.2026: it only asked for the upload
  // and said "No pending roster" while the team had sent theirs.
  // 21.11.2026 (owner: "in case the roster has to be reuploaded ... a
  // 'refresh' button that looks for rosters on the server"): the panel also
  // checks by itself every REMOTE_PANEL_CHECK_MS while it is open (`silent`:
  // no "no roster" message, a toast only for something new), and a version
  // accepted or rejected here is never offered again, a newer one as a card.
  // Nothing waits for these checks; the screen stays usable offline.
  const rosterCheckRunRef = useRef({ home: null, away: null })
  const sentRostersRef = useRef(sentRosters)
  sentRostersRef.current = sentRosters
  const handleSearchRoster = async (team, { silent = false } = {}) => {
    if (!match) {
      if (!silent) setNoticeModal({ message: t('matchSetup.noSupabaseConnection') })
      return
    }
    const running = rosterCheckRunRef.current[team]
    if (silent) {
      // never two at a time, never while an Accept writes, never offline
      if (running || acceptingPendingRef.current || !isNavigatorOnline()) return
    } else if (running) {
      // the panel's own check is under way: this one asks again after it
      await running.catch(() => {})
    }
    const run = checkServerForRoster(team, silent)
    rosterCheckRunRef.current[team] = run
    try {
      await run
    } finally {
      if (rosterCheckRunRef.current[team] === run) rosterCheckRunRef.current[team] = null
    }
  }
  const checkServerForRoster = async (team, silent) => {
    const setSearching = team === 'home' ? setHomeRosterSearching : setAwayRosterSearching
    const setAuto = (auto) => setRosterCheck((prev) => ({ ...prev, [team]: { ...prev[team], auto } }))
    const pendingField = team === 'home' ? 'pendingHomeRoster' : 'pendingAwayRoster'
    const teamName = (team === 'home' ? home : away) || ''
    // the sent roster this side offered before asking: a toast only for another one
    const offeredBefore = sentRostersRef.current?.[team]?.updatedAt ?? null
    if (silent) setAuto(true)
    else setSearching(true)
    try {
      const [remoteRes, sentRes] = await Promise.allSettled([
        fetchPendingRoster(apiFrom, match.seed_key, team),
        canAskSentRosters ? refreshSentRosters() : Promise.resolve('skipped')
      ])
      const remoteFailed = remoteRes.status === 'rejected' || !!remoteRes.value?.error
      if (remoteFailed && !silent) console.error('[MatchSetup] Error searching for the uploaded roster:', remoteRes.reason?.message || remoteRes.value?.error?.message || remoteRes.value?.error)
      const sentFailed = sentRes.status === 'rejected' || sentRes.value === 'offline' || sentRes.value === 'error'
      const remote = remoteFailed ? null : (remoteRes.value?.roster || null)
      let rows = []
      if (canAskSentRosters) {
        try {
          rows = await db.game_rosters.where('gameNumber').equals(sentGameNumber).toArray()
        } catch { /* none on the device */ }
      }
      // the match as stored now (an Accept or Reject may have landed meanwhile)
      const current = (matchId ? await db.matches.get(matchId).catch(() => null) : null) || match
      const outcome = rosterSearchOutcome({ side: team, remote, remoteFailed, sentRows: rows, match: current, userId: user?.id, sentChecked: canAskSentRosters, silent })
      const failed = remoteFailed || sentFailed
      setRosterCheck((prev) => ({ ...prev, [team]: { at: failed ? prev[team].at : new Date().toISOString(), failed, auto: false } }))
      const sentIsNew = (sent) => !!sent && (sent.row.updatedAt ?? null) !== offeredBefore
      const announceSent = (sent) => toast.info(sent.newVersion
        ? t('matchSetup.rosterCheck.newVersionFound', { team: sent.row.teamName || teamName })
        : t('matchSetup.sentRosterFound', { team: sent.row.teamName || teamName }))
      if (outcome.kind === 'remote') {
        // Store in local match data to trigger the pending roster UI (only
        // what is new: the card shows the same one already otherwise)
        if (outcome.changed) {
          await db.matches.update(matchId, { [pendingField]: remote })
          if (silent) toast.info(outcome.newVersion ? t('matchSetup.rosterCheck.newVersionFound', { team: teamName }) : t('matchSetup.rosterCheck.uploadFound', { team: teamName }))
        }
        if (silent && sentIsNew(outcome.sent)) announceSent(outcome.sent)
      } else if (outcome.kind === 'sent') {
        if (outcome.restore) {
          await db.matches.update(matchId, { sentRosterDismissed: { ...(current?.sentRosterDismissed || {}), [team]: null } })
        }
        // its card is on this screen already (or now): nothing stored yet
        if (!silent || sentIsNew(outcome)) announceSent(outcome)
      } else if (silent) {
        // nothing new: the line under the hint says when it asked
      } else if (outcome.kind === 'error') {
        setNoticeModal({ message: t('matchSetup.errorSearchingRoster') })
      } else if (outcome.upToDate) {
        setNoticeModal({ message: t('matchSetup.rosterCheck.upToDate') })
      } else {
        setNoticeModal({ message: outcome.sentChecked ? t('matchSetup.noRosterFoundAnywhere') : t('matchSetup.noRosterFound') })
      }
    } catch (err) {
      console.error(`[MatchSetup] Error searching for ${team} roster:`, err?.message || err)
      setRosterCheck((prev) => ({ ...prev, [team]: { ...prev[team], failed: true, auto: false } }))
      if (!silent) setNoticeModal({ message: t('matchSetup.errorSearchingRoster') })
    } finally {
      if (silent) setAuto(false)
      else setSearching(false)
    }
  }
  // The open Remote panel checks by itself: now, every REMOTE_PANEL_CHECK_MS,
  // and when the screen comes back or the device is online again
  // (hooks/useSentRosterRefresh: never offline, never hidden, never two at a
  // time). Stops when the panel closes, the setup locks or Match Setup goes.
  const remotePanelChecks = !!remotePanelSide && (!!match?.seed_key || canAskSentRosters)
  useSentRosterRefresh(remotePanelChecks ? remotePanelSide : false, () => (remotePanelSide ? handleSearchRoster(remotePanelSide, { silent: true }) : undefined), { intervalMs: REMOTE_PANEL_CHECK_MS })
  const handleSearchHomeRoster = () => handleSearchRoster('home')
  const handleSearchAwayRoster = () => handleSearchRoster('away')

  // An imported roster (domain/importedRoster: a PDF or a photo of the
  // list) in the side's roster and bench, the one way for both: the list's
  // players replace the roster, its numbers kept and the missing ones from
  // the side's saved team (by licence, else name; owner 2026-11-19), its
  // captain and liberos where the team marked them (owner 2026-11-23), its
  // coach and assistants on the bench. An Einsatzliste lists every eligible
  // player: with more than 14 the scorer ticks who plays (the summary follows
  // the choice). Not saved here: the roster editor's Save writes it, its
  // Back discards it.
  const applyImportedRoster = async (side, imported) => {
    const { players, bench, numbersFilled } = importedToSetup(imported, { idMode, savedTeam: savedTeamOf(side) })
    if (numbersFilled) toast.info(t('savedTeams.numbersFilled', { count: numbersFilled }))
    if (side === 'home') { setHomeRoster(players); setBenchHome(bench) } else { setAwayRoster(players); setBenchAway(bench) }
    const summary = { team: side, players: players.length, benchOfficials: bench.length }
    if (players.length > ROSTER_MAX) {
      await openPlayerPool(side, { imported: players, includeCurrent: false, summary })
    } else {
      setImportSummaryModal({ ...summary, errors: [] })
    }
  }

  // ---- Edit roster: the header's ways and "Roster import" (owner 27.11.2026) ----
  // The ways that take players the app already has (saved team, known
  // players, the club's lists, the test roster) sit in the header row, with
  // Delete roster at its side; the three ways a list comes in (Remote, PDF,
  // Photo) are one switch under the bold title "Roster import", with only the
  // chosen way's controls below it.
  const importSideOf = (side) => (side === 'home'
    ? { team: home, fileRef: homeFileInputRef, onFileSelect: handleHomeFileSelect, pdfFile: homePdfFile, pdfLoading: homePdfLoading, pdfError: homePdfError, onImport: handleHomeImportClick, onSearch: handleSearchHomeRoster, searching: homeRosterSearching, pin: match?.homeTeamUploadPin }
    : { team: away, fileRef: awayFileInputRef, onFileSelect: handleAwayFileSelect, pdfFile: awayPdfFile, pdfLoading: awayPdfLoading, pdfError: awayPdfError, onImport: handleAwayImportClick, onSearch: handleSearchAwayRoster, searching: awayRosterSearching, pin: match?.awayTeamUploadPin })

  const renderRosterHeader = (side) => (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h1 className="m-0 text-xl sm:text-2xl font-bold tracking-tight text-stone-900">{t('roster.title')}</h1>
      {/* the other ways: beside the title on a wide screen, their own line below it otherwise */}
      <div role="group" aria-label={t('matchSetup.rosterWays')} className="order-3 flex basis-full flex-wrap gap-2 lg:order-2 lg:basis-auto" data-testid={`roster-ways-${side}`}>
        {access?.canReadTeams && !guestMatch && (
          <Button variant="secondary" size="xl" icon={<Users size={16} aria-hidden />} onClick={() => setSavedPicker(side)} data-testid={`load-saved-team-${side}`}>
            {t('savedTeams.load')}
          </Button>
        )}
        <Button variant="secondary" size="xl" icon={<ListChecks size={16} aria-hidden />} onClick={() => openPlayerPool(side, { withClub: true })} data-testid={`choose-players-${side}`}>
          {t('playerPool.open')}
        </Button>
        {clubTeams[side] && !guestMatch && (
          <Button variant="secondary" size="xl" icon={<UserPlus size={16} aria-hidden />} onClick={() => setClubPicker(side)} data-testid={`add-from-club-${side}`}>
            {t('clubPlayers.add')}
          </Button>
        )}
        {/* practice only: a test or Easy match (an official, guest or Global one never) */}
        {match?.test === true && (
          <Button variant="dark" size="xl" data-testid={`load-test-roster-${side}`} onClick={() => setTestRosterConfirm(side)}>
            {t('roster.loadTestRoster')}
          </Button>
        )}
      </div>
      <Button
        variant="danger-soft"
        size="xl"
        icon={<Trash2 size={16} aria-hidden />}
        className="order-2 ml-auto lg:order-3"
        data-testid={`delete-roster-${side}`}
        onClick={() => {
          const coachOnly = [{ role: 'Coach', firstName: '', lastName: '', dob: '' }]
          if (side === 'home') { setHomeRoster([]); setBenchHome(coachOnly) } else { setAwayRoster([]); setBenchAway(coachOnly) }
        }}
      >
        {t('roster.deleteRoster')}
      </Button>
    </div>
  )

  const renderRosterImport = (side) => {
    const s = importSideOf(side)
    const mode = importModeOf(side)
    // "Show me" (help) and the walkthrough point at a way's controls, or at
    // its segment while another way is chosen
    const options = [
      ...(remoteImportOffered ? [{ value: 'remote', label: t('matchSetup.remote'), icon: CloudDownload, testId: `roster-import-remote-${side}`, helpId: mode === 'remote' ? undefined : 'setup-remote-import' }] : []),
      { value: 'pdf', label: t('matchSetup.rosterImport.pdf'), icon: FileText, testId: `roster-import-pdf-${side}`, helpId: mode === 'pdf' ? undefined : 'setup-pdf-import' },
      { value: 'photo', label: t('matchSetup.rosterImport.photo'), icon: Camera, testId: `roster-import-photo-${side}`, helpId: mode === 'photo' ? undefined : 'setup-photo-import' }
    ]
    return (
      <section className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-stone-50/60 p-3" aria-labelledby={`roster-import-title-${side}`} data-testid={`roster-import-${side}`} data-mode={mode}>
        <div className="flex flex-col gap-3">
          <h3 id={`roster-import-title-${side}`} className="m-0 text-sm font-bold text-stone-900">{t('matchSetup.rosterImport.title')}</h3>
          <SegmentedControl
            ariaLabel={t('matchSetup.rosterImport.title')}
            className="[&_button]:h-11 [&_button]:min-w-0 [&_button]:px-2 [&_button]:text-sm"
            value={mode}
            onChange={(m) => chooseImportMode(side, m)}
            options={options}
          />
          {/* the PDF picker stays mounted: a file chosen is kept while another way is looked at */}
          <input ref={s.fileRef} type="file" accept=".pdf" onChange={s.onFileSelect} style={{ display: 'none' }} />
          {mode === 'remote' && (
            <div className="flex flex-col gap-1.5" data-help-id="setup-remote-import" data-testid={`roster-import-remote-panel-${side}`}>
              {/* a refresh from the server (the panel's own check spins the icon) */}
              <Button
                variant="secondary"
                size="xl"
                block
                onClick={s.onSearch}
                icon={<RefreshCw size={16} aria-hidden className={cn('shrink-0', rosterCheck[side].auto && 'animate-spin')} />}
                loading={s.searching}
                disabled={s.pdfLoading || s.searching}
                data-testid={`check-server-roster-${side}`}
              >
                {s.searching ? t('matchSetup.rosterCheck.checking') : t('matchSetup.rosterCheck.button')}
              </Button>
              {/* what the check looks in (the upload with this PIN and the manager site's sent roster), and when it last asked */}
              <p className="m-0 text-xs text-stone-500" data-testid={`search-roster-hint-${side}`}>{t('matchSetup.rosterCheck.hint')}</p>
              <RosterCheckStatus side={side} state={rosterCheck[side]} online={browserOnline} />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-stone-500">{t('matchSetup.gameNumber')}:</span>
                <span className="font-mono text-sm font-semibold tabular-nums text-stone-900">
                  {match?.game_n || match?.gameNumber || gameN || 'N/A'}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-stone-500">{t('matchSetup.uploadPin')}:</span>
                {s.pin && (
                  <span className="font-mono text-base font-bold tracking-[0.3em] text-stone-900">{s.pin}</span>
                )}
                <Button variant="ghost" size="sm" className="bg-white" onClick={() => regenerateUploadPin(side)}>
                  {s.pin ? t('matchSetup.regenerate') : t('matchSetup.generatePin')}
                </Button>
              </div>
              {renderPendingRosterCard(side)}
            </div>
          )}
          {mode === 'pdf' && (
            <div className="flex flex-col gap-2" data-testid={`roster-import-pdf-panel-${side}`}>
              <Button
                variant="secondary"
                size="xl"
                block
                icon={<FileText size={16} aria-hidden />}
                onClick={() => s.fileRef.current?.click()}
                disabled={s.pdfLoading}
                data-help-id="setup-pdf-import"
                data-testid={`upload-pdf-${side}`}
              >
                {t('matchSetup.uploadPdf')}
              </Button>
              <p className="m-0 text-xs text-stone-500">{t('matchSetup.rosterImport.pdfHint')}</p>
              {s.pdfFile && (
                <>
                  <span className="truncate text-xs text-stone-700">{s.pdfFile.name}</span>
                  <Button variant="primary" size="xl" block onClick={s.onImport} loading={s.pdfLoading}>
                    {s.pdfLoading ? t('matchSetup.importing') : t('matchSetup.importPdf')}
                  </Button>
                </>
              )}
              {s.pdfError && <span className="text-xs font-medium text-red-600">{s.pdfError}</span>}
            </div>
          )}
          {/* An Einsatzliste from a photo, read on this device and checked by
              the scorer before it is taken (docs/roster-photo-spec.md): each
              button opens its source at once, then the photo dialog */}
          {mode === 'photo' && (
            <div className="flex flex-col gap-2" data-testid={`roster-import-photo-panel-${side}`}>
              <RosterPhotoImport entry="sources" side={side} teamLabel={s.team} savedTeam={savedTeamOf(side)} disabled={s.pdfLoading} onApply={(roster) => applyImportedRoster(side, roster)} />
              <ul className="m-0 list-disc space-y-0.5 pl-5 text-xs text-stone-500">
                <li>{t('rosterPhoto.source.tipFlat')}</li>
                <li>{t('rosterPhoto.source.tipLight')}</li>
                <li>{t('rosterPhoto.source.tipWhole')}</li>
              </ul>
            </div>
          )}
        </div>
      </section>
    )
  }

  // PDF upload handlers - must be defined before conditional returns
  const handleHomePdfUpload = async (file) => {
    if (!file) return
    setHomePdfLoading(true)
    setHomePdfError('')

    try {
      const parsedData = await parseRosterPdf(file)
      // Not written to the database here: the roster editor's Save writes
      // the players and the bench, its Back discards the import
      if (homeFileInputRef.current) {
        homeFileInputRef.current.value = ''
      }
      setHomePdfFile(null)
      await applyImportedRoster('home', importedRosterOf(parsedData, 'pdf'))
    } catch (err) {
      console.error('Error parsing PDF:', err)
      setHomePdfError(rosterPdfErrorText(err, t))
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
      // Not written to the database here: the roster editor's Save writes
      // the players and the bench, its Back discards the import
      if (awayFileInputRef.current) {
        awayFileInputRef.current.value = ''
      }
      setAwayPdfFile(null)
      await applyImportedRoster('away', importedRosterOf(parsedData, 'pdf'))
    } catch (err) {
      console.error('Error parsing PDF:', err)
      setAwayPdfError(rosterPdfErrorText(err, t))
      // Clear file state on error too
      setAwayPdfFile(null)
      if (awayFileInputRef.current) {
        awayFileInputRef.current.value = ''
      }
    } finally {
      setAwayPdfLoading(false)
    }
  }

  // First paint (owner 2026-11-11: "every time I click something or start
  // new game etc it seems it loads something, stops, loads it again"): the
  // branded spinner until what the setup shows is read from the device: the
  // match with its teams and players in the form, the rosters teams sent,
  // the club lists, and a game picked on the home screen applied (its own
  // spinner then takes over). All local reads, so a moment; at most
  // SETUP_READS_WAIT_MS, then the setup shows what it has. Once shown it
  // never hides again.
  const setupReadsDone = (!matchId || match === null || storedAppliedFor === matchId) &&
    sentRows !== undefined && clubRows !== undefined &&
    !(initialOfficialGame && pickedGamePhase < 2)
  const [setupShownLatch, setSetupShownLatch] = useState(false)
  const setupShown = setupShownLatch || setupReadsDone
  useEffect(() => {
    if (setupReadsDone) setSetupShownLatch(true)
  }, [setupReadsDone])
  useEffect(() => {
    const timer = setTimeout(() => setSetupShownLatch(true), SETUP_READS_WAIT_MS)
    return () => clearTimeout(timer)
  }, [])
  // App's "opening the match" spinner (over the home screen) hands over here
  useEffect(() => {
    if (setupShown) onReady?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupShown])

  // Callback for opening database selector - MUST be before any early returns to satisfy React hooks rules
  const handleOpenDatabase = useCallback((_e, selectorKey) => {
    setShowRefereeSelector(selectorKey)
  }, [])

  // "Choose the players" (rendered by the roster views and the main view)
  const playerPoolModal = (
    <PlayerPoolModal
      open={!!playerPool}
      onClose={closePlayerPool}
      onApply={applyPlayerPool}
      pool={playerPool?.pool}
      teamLabel={playerPool?.teamLabel}
    />
  )

  if (!setupShown) {
    return <ScreenLoading layer="page" label={t('common.loading')} testId="match-setup-loading" />
  }

  if (currentView === 'info') {
    return (
      <MatchSetupInfoView kitScale={kitScale}>
        {scheduleLoading && <ScreenLoading layer="page" label={t('matchSetup.loadingScheduleGame')} testId="schedule-load-spinner" />}
        {/* "Load match from schedule" sits on the setup card, next to "Create match" */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div>
            <Button variant="ghost" size="xl" className="whitespace-nowrap bg-white" onClick={() => { restoreMatchInfo(); restoreOfficials(); undoRosterSwap(); forgetScheduleLoad(); setCurrentView('main') }}>← {t('common.back')}</Button>
          </div>
          <h1 className="m-0 text-xl sm:text-2xl font-bold tracking-tight text-stone-900">{t('matchSetup.matchInfo')}</h1>
          <div />
        </div>
        <div className="grid grid-cols-5 gap-4 stack:grid-cols-1">
          <div className={OFFICIAL_BOX}>
            <div className={OFFICIAL_HEAD}>
              <span className={OFFICIAL_TITLE}>{t('matchSetup.dateTime')}</span>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <Field tone="compact" className={FIELD} label={t('matchSetup.date')} error={dateError || undefined}>
                <DateField
                  aria-label={t('matchSetup.date')}
                  value={date}
                  onChange={handleDateChange}
                  invalid={!!dateError}
                />
              </Field>
              <Field tone="compact" className={FIELD} label={t('matchSetup.time')} error={timeError || undefined}>
                <TimeField
                  aria-label={t('matchSetup.time')}
                  value={time}
                  onChange={handleTimeChange}
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
                  value={city}
                  onChange={e => setCity(e.target.value)}
                  list="cities-zurich"
                  placeholder={t('matchSetup.enterCity')}
                />
              </Field>
              <datalist id="cities-zurich">
                {citiesZurich.map(c => <option key={c} value={c} />)}
              </datalist>
              <Field tone="compact" className={FIELD} label={t('matchSetup.hall')}><Input aria-label={t('matchSetup.hall')} value={hall} onChange={e => setHall(e.target.value)} /></Field>
            </div>
          </div>

          <div className={OFFICIAL_BOX}>
            <div className={OFFICIAL_HEAD}>
              <span className={OFFICIAL_TITLE}>{t('matchSetup.matchType')}</span>
            </div>
            <div className="flex flex-col gap-3 p-4">
              <Field tone="compact" className={FIELD} label={t('matchSetup.matchType')}>
                <Select aria-label={t('matchSetup.matchType')} block value={type1} onChange={e => setType1(e.target.value)}>
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
                  {match?.global === true && <option value="mixed">{t('matchSetup.mixed', 'Mixed')}</option>}
                </Select>
              </Field>
              <Field tone="compact" className={FIELD} label={t('matchSetup.matchLevel')}>
                <Select aria-label={t('matchSetup.matchLevel')} block value={type3} onChange={e => setType3(e.target.value)}>
                  <option value="senior">{t('matchSetup.senior')}</option>
                  <option value="U23">U23</option>
                  <option value="U21">U21</option>
                  <option value="U19">U19</option>
                  <option value="U17">U17</option>
                  {match?.global === true && (
                    <>
                      <option value="U16">U16</option>
                      <option value="U15">U15</option>
                      <option value="U14">U14</option>
                      <option value="School">{t('matchSetup.school', 'School')}</option>
                    </>
                  )}
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
              <div className="grid grid-cols-1 gap-2 xl:grid-cols-2 stack:grid-cols-1">
                <Field tone="compact" className={FIELD} label={t('matchSetup.gameNumber')}><Input aria-label={t('matchSetup.gameNumber')} className="tabular-nums" type="number" inputMode="numeric" value={gameN} onChange={e => setGameN(e.target.value)} /></Field>
                <Field tone="compact" className={FIELD} label={t('matchSetup.league')}><Input aria-label={t('matchSetup.league')} value={league} onChange={e => setLeague(e.target.value)} /></Field>
              </div>
              <Field tone="compact" className={FIELD} label={t('matchSetup.matchFormat')}>
                <Select aria-label={t('matchSetup.matchFormat')} block value={bestOf ?? ''} onChange={e => setBestOf(knownMatchFormat(e.target.value))}>
                  {bestOf == null && <option value="">{t('matchSetup.chooseMatchFormat')}</option>}
                  <option value={5}>{t('matchSetup.bestOf5')}</option>
                  <option value={3}>{t('matchSetup.bestOf3')}</option>
                </Select>
              </Field>
              <LongIntervalSwitch checked={longIntervalAfterSet2} onChange={setLongIntervalAfterSet2} />
              {match?.global === true && (
                <Field tone="compact" className={FIELD} label={t('idMode.title', 'Next to each name')}>
                  <Select aria-label={t('idMode.title', 'Next to each name')} block value={idMode} data-testid="global-id-mode" onChange={e => setIdMode(e.target.value)}>
                    <option value="dob">{t('idMode.dob', 'Use birthdates')}</option>
                    <option value="number">{t('idMode.number', 'Use an ID number')}</option>
                    <option value="text">{t('idMode.text', 'Use text')}</option>
                  </Select>
                </Field>
              )}
              {match?.global === true && (
                <div className="grid grid-cols-2 gap-2" data-testid="global-set-rules">
                  <Field tone="compact" className={FIELD} label={t('matchSetup.pointsPerSet', 'Points per set')}>
                    <Select aria-label={t('matchSetup.pointsPerSet', 'Points per set')} block value={pointsRegular} onChange={e => setPointsRegular(Number(e.target.value))}>
                      {[25, 21, 15].map(n => <option key={n} value={n}>{n}</option>)}
                    </Select>
                  </Field>
                  <Field tone="compact" className={FIELD} label={t('matchSetup.pointsDeciding', 'Deciding set')}>
                    <Select aria-label={t('matchSetup.pointsDeciding', 'Deciding set')} block value={pointsDeciding} onChange={e => setPointsDeciding(Number(e.target.value))}>
                      {[15, 11, 10].map(n => <option key={n} value={n}>{n}</option>)}
                    </Select>
                  </Field>
                </div>
              )}
            </div>
          </div>

          {/* Match Officials Row */}
          <div className="col-span-5 grid grid-cols-5 items-start gap-4 stack:col-span-1 stack:grid-cols-1">
            <OfficialCard
              title={t('matchSetup.referee1')}
              idMode={idMode}
              idLabel={idLabel}
              officialKey="ref1"
              lastName={ref1Last}
              firstName={ref1First}
              country={ref1Country}
              dob={ref1Dob}
              setLastName={setRef1Last}
              setFirstName={setRef1First}
              setCountry={setRef1Country}
              setDob={setRef1Dob}
              email={ref1Email}
              setEmail={setRef1Email}
              hasDatabase={refereeDatabase}
              selectorKey="ref1"
              onOpenDatabase={handleOpenDatabase}
              t={t}
            />
            <OfficialCard
              title={t('matchSetup.referee2')}
              idMode={idMode}
              idLabel={idLabel}
              officialKey="ref2"
              lastName={ref2Last}
              firstName={ref2First}
              country={ref2Country}
              dob={ref2Dob}
              setLastName={setRef2Last}
              setFirstName={setRef2First}
              setCountry={setRef2Country}
              setDob={setRef2Dob}
              email={ref2Email}
              setEmail={setRef2Email}
              hasDatabase={refereeDatabase}
              selectorKey="ref2"
              onOpenDatabase={handleOpenDatabase}
              collapsible={true}
              defaultCollapsed={true}
              filled={!!(ref2First || ref2Last)}
              t={t}
            />
            <OfficialCard
              title={t('matchSetup.scorer')}
              idMode={idMode}
              idLabel={idLabel}
              officialKey="scorer"
              lastName={scorerLast}
              firstName={scorerFirst}
              country={scorerCountry}
              dob={scorerDob}
              setLastName={setScorerLast}
              setFirstName={setScorerFirst}
              setCountry={setScorerCountry}
              setDob={setScorerDob}
              dobRequired={match?.global !== true}
              licence={match?.global !== true ? scorerLicence : ''}
              hasDatabase={false}
              selectorKey="scorer"
              onOpenDatabase={handleOpenDatabase}
              t={t}
            />
            <OfficialCard
              title={t('matchSetup.assistantScorer')}
              idMode={idMode}
              idLabel={idLabel}
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
              filled={!!(asstFirst || asstLast)}
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
              filled={!!(lineJudge1 || lineJudge2 || lineJudge3 || lineJudge4)}
              t={t}
            />
          </div>

          {/* Teams - full width row at bottom: a section on its head rule, no box */}
          <div className="col-span-5 pt-2 stack:col-span-1">
            <SectionHeader title={t('matchSetup.teams')} as="h2" className="mb-4" />
            <div className="flex items-center gap-6 stack:flex-col stack:items-stretch stack:gap-3">
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
                    <TeamShirt
                      color={homeColor}
                      numberColor={getContrastColor(homeColor)}
                      style={{ transform: 'scale(0.65)', margin: '-10px' }}
                    />
                  </div>
                  {/* Title: team-colour bar (frozen) */}
                  <div
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      fontSize: '20px',
                      fontWeight: 700,
                      padding: '10px',
                      border: '0.5px solid white',
                      borderRadius: '10px',
                      ...teamBoxStyle(homeColor)
                    }}
                  >
                    {t('matchSetup.homeTeam').toUpperCase()}
                  </div>
                </div>
                <div className="flex items-end gap-4 stack:flex-col stack:items-stretch stack:gap-3">
                  <Field tone="form" className={cn(FIELD, 'flex-1 stack:basis-auto')} label={t('matchSetup.teamName')}>
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
                </div>
                {/* the team's contact: gets the final scoresheet by email, as a typed referee address (domain/officials team contact) */}
                <Field tone="compact" className={cn(FIELD, 'mt-3')} label={t('matchSetup.teamContactEmail', 'Team contact email (optional)')} hint={t('matchSetup.teamContactEmailHint', 'Gets the final scoresheet by email. Only this match\'s scorers see it.')}>
                  <Input aria-label={`${t('common.home')} ${t('matchSetup.teamContactEmail', 'Team contact email (optional)')}`} type="email" inputMode="email" autoComplete="off" value={homeContactEmail} onChange={e => setHomeContactEmail(e.target.value)} maxLength={254} />
                </Field>
                {/* Sponsors on clothing (domain/sponsors.js): while the option is on, or the match is marked */}
                {showSponsors && (
                  <Checkbox
                    className="mt-3"
                    data-testid="sponsors-home"
                    aria-label={`${t('common.home')} ${t('options.sponsorsOnClothing')}`}
                    label={t('options.sponsorsOnClothing')}
                    hint={t('options.sponsorsOnClothingInfo')}
                    checked={homeSponsors}
                    onChange={e => tickSponsors('home', e.target.checked)}
                  />
                )}
              </div>

              {/* VS Divider */}
              <div className="mt-6 flex flex-col items-center justify-center px-3 stack:mt-0">
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
                      padding: '10px',
                      border: '0.5px solid white',
                      borderRadius: '10px',
                      ...teamBoxStyle(awayColor)
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
                    <TeamShirt
                      color={awayColor}
                      numberColor={getContrastColor(awayColor)}
                      style={{ transform: 'scale(0.65)', margin: '-10px' }}
                    />
                  </div>
                </div>
                <div className="flex items-end gap-4 stack:flex-col stack:items-stretch stack:gap-3">
                  <Field tone="form" className={cn(FIELD, 'flex-1 stack:basis-auto')} label={t('matchSetup.teamName')}>
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
                </div>
                {/* the team's contact: gets the final scoresheet by email, as a typed referee address (domain/officials team contact) */}
                <Field tone="compact" className={cn(FIELD, 'mt-3')} label={t('matchSetup.teamContactEmail', 'Team contact email (optional)')} hint={t('matchSetup.teamContactEmailHint', 'Gets the final scoresheet by email. Only this match\'s scorers see it.')}>
                  <Input aria-label={`${t('common.away')} ${t('matchSetup.teamContactEmail', 'Team contact email (optional)')}`} type="email" inputMode="email" autoComplete="off" value={awayContactEmail} onChange={e => setAwayContactEmail(e.target.value)} maxLength={254} />
                </Field>
                {/* Sponsors on clothing (domain/sponsors.js): while the option is on, or the match is marked */}
                {showSponsors && (
                  <Checkbox
                    className="mt-3"
                    data-testid="sponsors-away"
                    aria-label={`${t('common.away')} ${t('options.sponsorsOnClothing')}`}
                    label={t('options.sponsorsOnClothing')}
                    hint={t('options.sponsorsOnClothingInfo')}
                    checked={awaySponsors}
                    onChange={e => tickSponsors('away', e.target.checked)}
                  />
                )}

              </div>

            </div>
            {coloursTooClose(homeColor, awayColor) && <CloseColourNote className="mt-3 justify-center" />}

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
                          // The cloud backend sends the email (a LAN relay has no mailer)
                          const sendInfoUrl = getCloudApiUrl('/api/match/send-info')
                          if (!sendInfoUrl) {
                            showAlert(t('matchSetup.emailFailed') || 'Failed to send email. Check server connection.', 'error')
                            return
                          }
                          setSendingEmail(true)
                          try {
                            // the signed-in scorer's own address, from the stored match, no PIN
                            const res = await fetch(sendInfoUrl, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', ...authorizationHeader() },
                              body: JSON.stringify({ externalId: match?.seed_key || null })
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
              // never a date of birth from the directory: its licence when it has one
              setRef1Dob(licenceOf(referee.licence) || '')
              setRef1Email(referee.email || '')
            } else if (showRefereeSelector === 'ref2') {
              setRef2First(referee.firstName || '')
              setRef2Last(referee.lastName || '')
              setRef2Country(referee.country || 'CHE')
              setRef2Dob(licenceOf(referee.licence) || '')
              setRef2Email(referee.email || '')
            } else if (showRefereeSelector === 'scorer') {
              setScorerFirst(referee.firstName || '')
              setScorerLast(referee.lastName || '')
              setScorerCountry(referee.country || 'CHE')
              setScorerDob(licenceOf(referee.licence) || '')
              setScorerLicence('')
            }
          }}
        />

        {/* Save / Create match: pinned to the card's bottom edge while the
            form scrolls, so the action is in view on a laptop too */}
        <div className={SETUP_STICKY_FOOTER}>
          {canConfirmMatchInfo && scorerDobMissing && (
            <p className="flex items-center gap-1.5 text-sm font-medium text-amber-800" role="note">
              <AlertTriangle size={16} className="shrink-0" aria-hidden />
              {t('matchSetup.scorerDobForCoinToss')}
            </p>
          )}
          {access?.known && !access.canScore && !isLocalOnly(match) && (
            <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900" role="note" data-testid="pending-local-only">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
              {t('access.officialMatchLocalOnly')}
            </p>
          )}
          <Button
            variant="positive"
            size="xl"
            className="disabled:cursor-not-allowed"
            onClick={(e) => {
              if (!canCreateMatch) {
                e.preventDefault()
                const tooltip = getMissingFieldsTooltip()
                if (tooltip) {
                  showAlert(tooltip, 'info')
                }
              } else {
                confirmMatchInfo()
              }
            }}
            disabled={!canCreateMatch || confirmingMatchInfo}
            aria-busy={confirmingMatchInfo || undefined}
            title={!canCreateMatch ? getMissingFieldsTooltip() : ''}
          >
            {matchInfoConfirmed ? t('matchSetup.save') : t('matchSetup.createMatch')}
            </Button>
          {!canCreateMatch && (
            <WarningIndicator id="confirmMatchInfo" missingItems={[...getMissingFieldsList(), ...(scorerDobMissing ? [t('matchSetup.scorerDobForCoinToss')] : [])]} position="above" />
          )}
        </div>

        {/* Color Picker Modal for Match Info view */}
        {colorPickerModal && (
          <>
            {/* No backdrop-blur here: it re-rasterises the frozen swatch shirts
                (sleeve edges differ by up to 33/255 from the before-shot). */}
            <div
              className="fixed inset-0 z-[999] bg-stone-900/50"
              {...backdropDismiss(() => setColorPickerModal(null))}
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
              <TeamColourPicker
                value={colorPickerModal.team === 'home' ? homeColor : awayColor}
                otherColour={colorPickerModal.team === 'home' ? awayColor : homeColor}
                lastCustom={recallCustomColour(customColourKey(colorPickerModal.team === 'home'))}
                onPick={(color) => {
                  const isHome = colorPickerModal.team === 'home'
                  if (isCustomColour(color)) rememberCustomColour(customColourKey(isHome), color)
                  if (isHome) {
                    setHomeColor(color)
                  } else {
                    setAwayColor(color)
                  }
                  setColorPickerModal(null)
                }}
              />
            </div>
          </>
        )}

        {/* Load Official Match Modal */}
        <LoadOfficialMatchModal
          open={loadOfficialMatchModal}
          onClose={() => setLoadOfficialMatchModal(false)}
          onSelectMatch={handleOfficialMatchSelect}
          access={isLocalOnly(match) ? null : access}
        />
      </MatchSetupInfoView>
    )
  }

  if (currentView === 'home') {
    return (
      <MatchSetupHomeTeamView kitScale={kitScale}>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div>
            <Button variant="ghost" size="xl" className="bg-white" data-testid="roster-back-home" onClick={() => { restoreHomeTeam(); restoreSideSignatures('home'); setCurrentView('main') }}>← {t('common.back')}</Button>
          </div>
          {/* a long team name wraps, never widens the page */}
          <h2 className="m-0 min-w-0 text-center text-base font-semibold text-stone-700 [overflow-wrap:anywhere]">{home || t('matchSetup.homeTeam')}</h2>
          <div />
        </div>
        {renderRosterHeader('home')}
        {/* db/023: the roster the team sent ahead (the device's copy) */}
        <SentRosterCard row={sentRosters.home} side="home" newVersion={!!match?.sentRosterUsed?.home} onUse={() => applySentRoster('home')} onDismiss={() => dismissSentRoster('home')} />
        {/* db/024: a player the club's list has with the other gender */}
        <ClubGenderNotice warnings={clubWarnings.home} gender={clubGender} />
        {/* born on 1 January: a placeholder or a bad import? A note here, never at the coin toss (owner 2026-11-15) */}
        <JanuaryDobNotice roster={homeRoster} bench={benchHome} idMode={idMode} />
        {/* Roster import for the home team + player stats */}
        <div className="flex gap-3 stack:flex-col">
          {/* Left: Roster import (Remote · PDF · Photo) */}
          {renderRosterImport('home')}
          {/* Right: Player Stats */}
          {(() => {
            const homeCaptain = homeRoster.find(p => p.isCaptain)
            const homeNonLiberoCount = homeRoster.filter(p => !p.libero).length
            const homeHasError = !homeCaptain || homeNonLiberoCount < 6
            return (
              <div className={cn(
                'flex flex-1 flex-wrap items-center justify-center gap-x-4 gap-y-1 rounded-xl border p-3',
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
        {/* Players saved without a shirt number: the # fields ask for them */}
        {homeWithoutNumber > 0 && (
          <p role="note" data-testid="numbers-missing-home" className="m-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
            {t('matchSetup.numbersMissingNote', { count: homeWithoutNumber })}
          </p>
        )}
        {/* Add new player section */}
        {homeRoster.length < 14 && (
          <div className="mx-auto w-max max-w-full rounded-xl border border-stone-200 bg-stone-50/60 p-3 stack:w-full">
            <div className="mb-2 text-center text-[11px] font-bold uppercase tracking-wide text-stone-500">{t('matchSetup.addNewPlayer')}</div>
            <div data-help-id="setup-add-player" className={`roster-grid roster-add${lfpTrackingEnabled ? ' has-lfp' : ''}`}>
              <div className="roster-grid-row" style={{ border: 'none' }}>
                <div></div>
                <StackLabel head>{t('matchSetup.playerNumber', 'Player number')}</StackLabel>
                <input aria-label={t('matchSetup.playerNumber', 'Player number')} className="cell-head" placeholder={t('matchSetup.numberPlaceholder')} type="number" inputMode="numeric" value={homeNum} onChange={e => setHomeNum(shirtNumberDigits(e.target.value))} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <StackLabel>{t('matchSetup.lastName')}</StackLabel>
                <input aria-label={t('matchSetup.lastName')} className="capitalize cell-last" placeholder={t('matchSetup.lastName')} value={homeLast} onChange={e => setHomeLast(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <StackLabel>{t('matchSetup.firstName')}</StackLabel>
                <input aria-label={t('matchSetup.firstName')} className="capitalize cell-first" placeholder={t('matchSetup.firstName')} value={homeFirst} onChange={e => setHomeFirst(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <StackLabel>{idLabel}</StackLabel>
                <IdField idMode={idMode} rawValue={homeDob} onRawChange={v => setHomeDob(v)} size="bare" wrapperClassName={DOB_CELL} aria-label={idLabel} placeholder={idPlaceholder} value={homeDob ? formatDateToISO(homeDob) : ''} onChange={v => setHomeDob(v ? formatDateToDDMMYYYY(v) : '')} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <StackLabel>{t('matchSetup.roleLibero')} · {t('matchSetup.captain')}</StackLabel>
                <select aria-label={t('matchSetup.libero', 'Libero')} className={`cell-libero${homeLibero ? '' : ' libero-unset'}`} data-help-id="setup-libero-toggle" value={homeLibero} onChange={e => setHomeLibero(e.target.value)}>
                  {liberoOptions(homeRoster, null, homeLibero)}
                </select>
                <div data-help-id="setup-captain-toggle" className="cell-captain">
                  <CaptainToggle pressed={homeCaptain} number={homeNum} onToggle={() => setHomeCaptain(!homeCaptain)} />
                </div>
                {lfpTrackingEnabled && (
                  <div className="cell-captain cell-lfp">
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
                    setHomeRoster(list => {
                      const cleared = homeCaptain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                      const newPlayer = { number: homeNum ? Number(homeNum) : null, lastName: homeLast, firstName: homeFirst, dob: homeDob, libero: newPlayerLibero(cleared, homeLibero), isCaptain: homeCaptain, isLfp: homeLfp }
                      const next = [...cleared, newPlayer].sort((a, b) => {
                        const an = a.number ?? 999
                        const bn = b.number ?? 999
                        return an - bn
                      })
                      // a team's only libero is Libero 1
                      return withLoneLiberoAsL1(next)
                    })
                    setHomeNum(''); setHomeFirst(''); setHomeLast(''); setHomeDob(''); setHomeLibero(''); setHomeCaptain(false); setHomeLfp(false)
                  }}>{t('common.add')}</Button>
                </div>
              </div>
            </div>
          </div>
        )}
        {homeRoster.length > 1 && (
          <div className="mb-2 flex items-center justify-center gap-2" data-testid="roster-sort-home">
            <span className="text-xs font-medium text-stone-500">{t('matchSetup.sortPlayers', 'Sort')}</span>
            <SegmentedControl
              ariaLabel={t('matchSetup.sortPlayers', 'Sort')}
              options={[{ value: 'number', label: '#' }, { value: 'name', label: 'A–Z' }]}
              value={rosterSort}
              onChange={(v) => { setRosterSort(v); saveRosterSort(v) }}
            />
          </div>
        )}
        {/* Sorted by number once focus leaves the list, not while a row is
            edited (utils/rosterOrder) */}
        <div className={cn('roster-grid', lfpTrackingEnabled && 'has-lfp', ROSTER_TABLE)} onBlur={e => { if (focusLeaves(e)) { setHomeRoster(sortedByNumber); setHomeOrderTick(n => n + 1) } }}>
          {/* Roster Header Row */}
          <div className={cn('roster-grid-row grid-header', ROSTER_TABLE_HEAD)}>
            <div></div>
            <div style={{ textAlign: 'center' }}>#</div>
            <div>{t('matchSetup.lastName')}</div>
            <div>{t('matchSetup.firstName')}</div>
            <div className="cell-dob">{idLabel}{idMode === 'licence' && <LicenceInfo />}</div>
            <div style={{ textAlign: 'center' }}>{t('matchSetup.roleLibero')}</div>
            <div className="cell-captain">C</div>
            {lfpTrackingEnabled && <div style={{ textAlign: 'center' }}>LFP</div>}
            <div></div>
          </div>
          {(() => {
            const homeLiberoCount = homeRoster.filter(p => p.libero).length
            return homeShownOrder.filter(i => i < homeRoster.length).map((i) => {
            const p = homeRoster[i]
            // Check if this player's number is a duplicate
            const isDuplicate = p.number != null && p.number !== '' &&
              homeRoster.some((other, idx) => idx !== i && other.number === p.number)
            // saved without a number: its # asks for one (no coin toss until then)
            const missingNumber = (p.number == null || p.number === '') && !!(p.firstName || p.lastName)

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
              <div key={`h-${i}`} className={cn('roster-grid-row', isCaptain && 'row-captain', isLibero && 'row-libero')} style={borderStyle}>
                <div className={`roster-badge${isCaptain ? ' badge-captain' : isLibero ? ' badge-libero' : ''}`}>
                  {isCaptain ? 'C' : p.libero === 'libero1' ? (homeLiberoCount > 1 ? 'L1' : 'L') : p.libero === 'libero2' ? (homeLiberoCount > 1 ? 'L2' : 'L') : ''}
                </div>
                <StackLabel head>{t('matchSetup.playerNumber', 'Player number')}</StackLabel>
                <input
                  aria-label={t('matchSetup.playerNumber', 'Player number')}
                  placeholder="#"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="99"
                  value={p.number ?? ''}
                  className={cn('cell-head', isDuplicate && 'border-red-400 bg-red-50 text-red-700', missingNumber && 'border-amber-400 bg-amber-50 placeholder:text-amber-700')}
                  aria-invalid={isDuplicate || missingNumber || undefined}
                  title={isDuplicate ? t('scoreboard.duplicateJersey') : missingNumber ? t('matchSetup.numberNeeded') : undefined}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onKeyPress={e => {
                    if (!/[0-9]/.test(e.key) && e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Tab') {
                      e.preventDefault()
                    }
                  }}
                  onChange={e => {
                    const digits = shirtNumberDigits(e.target.value)
                    const val = digits ? Number(digits) : null
                    if (val !== null && (val < 1 || val > 99)) return
                    const updated = [...homeRoster]
                    updated[i] = { ...updated[i], number: val }
                    setHomeRoster(updated)
                  }}
                />
                <StackLabel>{t('matchSetup.lastName')}</StackLabel>
                <input
                  aria-label={t('matchSetup.lastName')}
                  className="capitalize cell-last"
                  placeholder={t('matchSetup.placeholders.lastName')}
                  value={p.lastName || ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={e => {
                    const updated = [...homeRoster]
                    updated[i] = { ...updated[i], lastName: e.target.value }
                    setHomeRoster(updated)
                  }}
                />
                <StackLabel>{t('matchSetup.firstName')}</StackLabel>
                <input
                  aria-label={t('matchSetup.firstName')}
                  className="capitalize cell-first"
                  placeholder={t('matchSetup.placeholders.firstName')}
                  value={p.firstName || ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={e => {
                    const updated = [...homeRoster]
                    updated[i] = { ...updated[i], firstName: e.target.value }
                    setHomeRoster(updated)
                  }}
                />
                <StackLabel>{idLabel}</StackLabel>
                <IdField
                  idMode={idMode}
                  rawValue={p.dob}
                  onRawChange={v => {
                    const updated = [...homeRoster]
                    updated[i] = { ...updated[i], dob: v }
                    setHomeRoster(updated)
                  }}
                  size="bare"
                  wrapperClassName={DOB_CELL}
                  aria-label={idLabel}
                  placeholder={idPlaceholder}
                  value={p.dob ? formatDateToISO(p.dob) : ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={v => {
                    const updated = [...homeRoster]
                    updated[i] = { ...updated[i], dob: v ? formatDateToDDMMYYYY(v) : '' }
                    setHomeRoster(updated)
                  }}
                />
                <StackLabel>{t('matchSetup.roleLibero')} · {t('matchSetup.captain')}</StackLabel>
                <select
                  aria-label={t('matchSetup.libero', 'Libero')}
                  className={`cell-libero${p.libero ? '' : ' libero-unset'}`}
                  value={liberoValueOf(p)}
                  onChange={e => {
                    const updated = [...homeRoster]
                    updated[i] = { ...updated[i], libero: e.target.value }
                    // the L1 set to none: the L2 left becomes L1 (a team's
                    // only libero is Libero 1). State only: the editor's Save
                    // writes it with the other edits, its Back discards it
                    setHomeRoster(withLoneLiberoAsL1(updated))
                  }}
                >
                  {liberoOptions(homeRoster, i)}
                </select>
                <div className="cell-captain">
                  <CaptainToggle
                    pressed={!!p.isCaptain}
                    number={p.number}
                    onToggle={() => {
                      const updated = homeRoster.map((player, idx) => ({
                        ...player,
                        isCaptain: idx === i ? !player.isCaptain : false
                      }))
                      setHomeRoster(updated)
                    }}
                  />
                </div>
                {lfpTrackingEnabled && (
                  <div className="cell-captain cell-lfp">
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
                <div className="cell-action gap-1">
                  {rowShield('home', 'roster', p, i)}
                  <Button variant="danger-outline" size="md" title={t('common.delete')} onClick={() => setHomeRoster(list => withLoneLiberoAsL1(list.filter((_, idx) => idx !== i)))}>
                    <Trash2 size={16} className="hidden stack:block" aria-hidden="true" /><span className="stack:sr-only">{t('common.delete')}</span>
                  </Button>
                </div>
              </div>
            )
            })
          })()}
        </div>
        <div data-help-id="setup-bench-officials" className="mt-4">
          <SectionHeader as="h4" title={`${t('matchSetup.benchOfficials')} — ${t('common.home')}`} action={clubTeams.home && (
            <Button variant="ghost" size="md" className="bg-white" icon={<UserPlus size={16} aria-hidden />} onClick={() => setOfficialPicker('home')} data-testid="bench-from-club-home">
              {t('clubPlayers.add')}
            </Button>
          )} />
        </div>
        <div className={cn('bench-grid', ROSTER_TABLE)}>
          {/* Bench Header Row */}
          <div className={cn('bench-grid-row grid-header', ROSTER_TABLE_HEAD)}>
            <div>{t('matchSetup.role')}</div>
            <div>{t('matchSetup.lastName')}</div>
            <div>{t('matchSetup.firstName')}</div>
            <div className="cell-dob">{idLabel}{idMode === 'licence' && <LicenceInfo />}</div>
            <div className="cell-plays">{t('matchSetup.playsAs', 'Plays as')}</div>
            <div></div>
          </div>
          {sortBenchByHierarchy(benchHome).map((m, i) => {
            const originalIdx = benchHome.findIndex(b => b === m)
            return (
              <div key={`bh-${originalIdx}`} className="bench-grid-row">
                <StackLabel head>{t('matchSetup.role')}</StackLabel>
                <BenchRoleCell global={match?.global === true} label={m.roleLabel || ''} testId="bench-role-name-home" placeholder={t('matchSetup.roleName', 'Role name')} onLabel={v => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], roleLabel: v }; return a })}>
                <select aria-label={t('matchSetup.role')} className="cell-head" value={m.role || 'Coach'} onChange={e => {
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
                </BenchRoleCell>
                <StackLabel>{t('matchSetup.lastName')}</StackLabel>
                <input aria-label={t('matchSetup.lastName')} className="capitalize cell-last" placeholder={t('matchSetup.lastName')} value={m.lastName} onChange={e => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], lastName: e.target.value }; return a })} />
                <StackLabel>{t('matchSetup.firstName')}</StackLabel>
                <input aria-label={t('matchSetup.firstName')} className="capitalize cell-first" placeholder={t('matchSetup.firstName')} value={m.firstName} onChange={e => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], firstName: e.target.value }; return a })} />
                <StackLabel>{idLabel}</StackLabel>
                <IdField idMode={idMode} rawValue={m.dob} onRawChange={v => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], dob: v }; return a })} size="bare" wrapperClassName={DOB_CELL} aria-label={idLabel} placeholder={idPlaceholder} value={m.dob ? formatDateToISO(m.dob) : ''} onChange={v => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], dob: v ? formatDateToDDMMYYYY(v) : '' }; return a })} />
                {/* A player who is also this official (a playing coach,
                    domain/playerOfficials): found by licence or name, or
                    the scorer's choice */}
                <PlaysAsSelect official={m} players={homeRoster} t={t} testId="bench-plays-home" onChange={v => setBenchHome(arr => { const a = [...arr]; a[originalIdx] = withPlays(a[originalIdx], v); return a })} />
                <div className="cell-action gap-1">
                  {rowShield('home', 'bench', m, originalIdx)}
                  <Button variant="danger-outline" size="md" title={t('common.delete')} onClick={() => {
                    const updated = benchHome.filter((_, idx) => idx !== originalIdx)
                    setBenchHome(updated)
                    setTimeout(() => saveDraft(true), 100)
                    }}>
                      <Trash2 size={16} className="hidden stack:block" aria-hidden="true" /><span className="stack:sr-only">{t('common.delete')}</span>
                    </Button>
                </div>
              </div>
            )
          })}
          <div className="bench-grid-row bench-add-row" style={{ border: 'none', padding: 0, display: 'flex', alignItems: 'center', gap: '4px' }}>
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
          <div className="flex flex-wrap gap-4 stack:flex-col">
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
                  <img src={homeCaptainSignature} alt={t('matchSetup.captainSignature')} className="ov-ink" style={{ maxWidth: '100%', maxHeight: '100%' }} />
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
                  onClick={(e) => { e.stopPropagation(); clearSignatureSlot('home', 'captain') }}
                >
                  {t('common.clear', 'Clear')}
                </Button>
              )}
            </div>

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
                  <img src={homeCoachSignature} alt={t('matchSetup.coachSignature')} className="ov-ink" style={{ maxWidth: '100%', maxHeight: '100%' }} />
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
                  onClick={(e) => { e.stopPropagation(); clearSignatureSlot('home', 'coach') }}
                >
                  {t('common.clear', 'Clear')}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="positive" size="xl" data-testid="roster-confirm-home" onClick={async () => {

            // Check if any changes were made (skip sync if no changes)
            const hasChanges = hasRosterChanged(
              originalHomeTeamRef.current?.homeRoster,
              homeRoster,
              originalHomeTeamRef.current?.benchHome,
              benchHome
            )

            // If no changes, just go back to main view
            if (!hasChanges && !pendingSentRef.current.home && !acceptedInVisitRef.current.home) {
              console.log('[MatchSetup] No home roster changes, skipping sync')
              setCurrentView('main')
              return
            }

            // Roster save validation - only block for critical errors (duplicates,
            // invalid or missing numbers); captain and coach are validated at
            // coin toss confirmation instead
            const validationErrors = []

            // Check for duplicate numbers (critical - must block)
            const numbers = homeRoster.filter(p => p.number != null && p.number !== '').map(p => p.number)
            const duplicateNumbers = numbers.filter((num, idx) => numbers.indexOf(num) !== idx)
            if (duplicateNumbers.length > 0) {
              console.log('[MatchSetup] Home duplicate numbers:', duplicateNumbers)
              validationErrors.push(t('matchSetup.validation.duplicateNumbers', { numbers: [...new Set(duplicateNumbers)].join(', ') }))
            }

            // A player without a shirt number is saved (db/teamPlayers), the
            // coin toss waits for the numbers (owner 23.11.2026: refused here,
            // the scorer went Back and the uploaded players were gone)

            // Check for invalid numbers (whole numbers 1-99) - critical - must block
            const invalidNumbers = homeRoster.filter(p => p.number != null && p.number !== '' && !isShirtNumber(p.number))
            if (invalidNumbers.length > 0) {
              console.log('[MatchSetup] Home invalid numbers:', invalidNumbers.map(p => p.number))
              validationErrors.push(t('matchSetup.validation.invalidNumbers', { numbers: invalidNumbers.map(p => p.number).join(', ') }))
            }

            // This editor matches players by number: a player of the match
            // record renumbered (or removed) here would leave the record's
            // entries without their player. A number is changed for the whole
            // match in Corrections → Player numbers (owner 2026-10-29)
            if (matchId) {
              const recordEvents = await db.events.where('matchId').equals(matchId).toArray()
              const missing = recordNumbersMissingFrom(recordEvents, 'home', homeRoster)
              if (missing.length > 0) {
                validationErrors.push(t('matchSetup.validation.numbersInRecord', { numbers: missing.join(', '), defaultValue: "These numbers appear in the match record and cannot be changed or removed here: {{numbers}}. Change a player's number in Corrections → Player numbers: it then changes for the whole match." }))
              }
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

              // The stored players follow the roster, an emptied one too
              // (db/teamPlayers): the editor showed 0 while Coin toss, the
              // scoresheet and Match setup opened again read the old players.
              // The form keeps the stored ids: the next save updates the same
              // rows, players without a number included
              const storedIds = await writeTeamPlayers(match.homeTeamId, homeRoster)
              setHomeRoster(homeRoster.map((p, idx) => (storedIds[idx] != null && p.id !== storedIds[idx] ? { ...p, id: storedIds[idx] } : p)))

              // Update match with the bench officials. The
              // signatures are stored by their pads and Clear at once (each
              // queues the match's whole signatures object): this save sends
              // none, a partial object would replace the cloud's
              const updateData = {
                bench_home: benchHome  // Save bench officials to match record
              }

              await db.matches.update(matchId, updateData)
              // a signature of the side that no longer fits its roster goes
              await saveSideSignatures('home', homeRoster, benchHome, originalHomeTeamRef.current?.homeRoster, originalHomeTeamRef.current?.benchHome)

              // Sync home team data to Supabase as JSONB
              let homeSyncJobId = null
              if (match?.seed_key) {
                homeSyncJobId = await db.sync_queue.add({
                  resource: 'match',
                  action: 'update',
                  payload: {
                    id: match.seed_key,
                    // JSONB columns
                    home_team: { name: home?.trim() || '', color: homeColor },
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
                        [shortKey]: deriveTeamShortLabel(home),
                        [nameKey]: home?.trim() || '',
                        // on the match's live-state clock (serverDataSync liveStateNow)
                        updated_at: new Date(liveStateNow(match)).toISOString()
                      })
                      .eq('match_id', supabaseMatch.id)
                    console.log('[MatchSetup] Synced home team to match_live_state')
                  }
                } catch (err) {
                  console.debug('[MatchSetup] Could not sync home team to match_live_state:', err.message)
                }
              }

              // One non-blocking toast for this roster's own sync job
              toastQueuedSync([homeSyncJobId], {
                synced: t('matchSetup.homeSynced'),
                failed: t('matchSetup.modals.matchSavedLocalSyncFailed'),
                pending: t('matchSetup.homeSavedLocal')
              }, i18n?.language)
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
                const raw = rosterPreview === 'home' ? match?.pendingHomeRoster : match?.pendingAwayRoster
                if (!raw) return <p>{t('matchSetup.noRosterFound')}</p>
                // Only what the rules take (domain/uploadedRoster): texts and numbers, PNG signatures
                const checked = checkUploadedRoster(raw)
                if (!checked.ok) return <p role="alert">{t('matchSetup.uploadedRosterInvalid')}</p>
                const roster = checked.roster
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
                            <th className="px-2 py-2 text-left">{idLabel}</th>
                            <th className="px-2 py-2 text-center">L</th>
                            <th className="px-2 py-2 text-center">C</th>
                          </tr>
                        </thead>
                        <tbody>
                          {roster.players.map((p, i) => (
                            <tr key={i} className="border-b border-stone-100 last:border-0">
                              <td className="px-2 py-1.5 font-semibold tabular-nums text-stone-900">{p.number ?? ''}</td>
                              <td className="px-2 py-1.5 text-stone-800">{p.lastName}</td>
                              <td className="px-2 py-1.5 text-stone-800">{p.firstName}</td>
                              <td className="px-2 py-1.5 tabular-nums text-stone-800">{p.dob}</td>
                              <td className="px-2 py-1.5 text-center text-stone-800">{p.libero === 'libero1' ? 'L1' : p.libero === 'libero2' ? 'L2' : ''}</td>
                              <td className="px-2 py-1.5 text-center text-stone-800">{p.isCaptain ? 'C' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {roster.bench.length > 0 && (
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
                                  <td className="px-2 py-1.5 text-stone-800">{b.role}</td>
                                  <td className="px-2 py-1.5 text-stone-800">{b.lastName}</td>
                                  <td className="px-2 py-1.5 text-stone-800">{b.firstName}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                    {(roster.coachSignature || roster.captainSignature) && (
                      <>
                        <SectionHeader title={t('rosterSetup.signatures', 'Signatures')} className="mt-4 mb-2" />
                        <div className="flex flex-wrap gap-4">
                          {[['coach', roster.coachSignature, t('rosterSetup.coachSignature', 'Coach signature')], ['captain', roster.captainSignature, t('rosterSetup.captainSignature', 'Captain signature')]]
                            .filter(([, image]) => image)
                            .map(([key, image, label]) => (
                              <figure key={key} className="m-0">
                                <img src={image} alt={label} className="ov-ink h-16 max-w-[220px] rounded border border-stone-200 bg-white" />
                                <figcaption className="mt-1 text-xs text-stone-500">{label}</figcaption>
                              </figure>
                            ))}
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
                    setTestRosterConfirm(null)
                  }}
                >
                  {t('roster.loadTestRoster')}
                </Button>
              </div>
            </div>
          </Modal>
        )}

        {playerPoolModal}
        {clubPickerFor('home')}
        {/* Saved teams: load into this roster, or save it as a saved team */}
        <SavedTeamPickerModal
          open={savedPicker === 'home'}
          club={savedPicker === 'home' ? savedTeamClubOf('home') : null}
          clubIdOf={clubIdOfTeamName}
          onClose={() => setSavedPicker(null)}
          onPick={(team) => { setSavedPicker(null); pickSavedTeam('home', team) }}
          userId={user?.id ?? null}
          access={access}
          defaultCompetitionId={savedSuggestion?.home?.competitionId || ''}
          roster={homeRoster}
          bench={benchHome}
          teamLabel={home || t('matchSetup.homeTeam')}
        />

        {/* SignaturePad for home team view */}
        <SignaturePad
          open={openSignature !== null}
          onClose={() => setOpenSignature(null)}
          onSave={handleSignatureSave}
          phone={phoneSigning(openSignature)}
          title={openSignature === 'home-coach' ? 'Home coach signature' :
            openSignature === 'home-captain' ? 'Home captain signature' :
              openSignature === 'away-coach' ? 'Away coach signature' :
                openSignature === 'away-captain' ? 'Away captain signature' : 'Sign'}
          // a signed slot opens read-only; replacing it is an explicit Re-sign
          existingSignature={signatureStateOf[openSignature]?.[0] || null}
          readOnly={!!signatureStateOf[openSignature]?.[0]}
          allowResign
        />
      </MatchSetupHomeTeamView>
    )
  }

  if (currentView === 'away') {
    return (
      <MatchSetupAwayTeamView kitScale={kitScale}>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div>
            <Button variant="ghost" size="xl" className="bg-white" data-testid="roster-back-away" onClick={() => { restoreAwayTeam(); restoreSideSignatures('away'); setCurrentView('main') }}>← {t('common.back')}</Button>
          </div>
          {/* a long team name wraps, never widens the page */}
          <h2 className="m-0 min-w-0 text-center text-base font-semibold text-stone-700 [overflow-wrap:anywhere]">{away || t('matchSetup.awayTeam')}</h2>
          <div />
        </div>
        {renderRosterHeader('away')}
        {/* db/023: the roster the team sent ahead (the device's copy) */}
        <SentRosterCard row={sentRosters.away} side="away" newVersion={!!match?.sentRosterUsed?.away} onUse={() => applySentRoster('away')} onDismiss={() => dismissSentRoster('away')} />
        {/* db/024: a player the club's list has with the other gender */}
        <ClubGenderNotice warnings={clubWarnings.away} gender={clubGender} />
        {/* born on 1 January: a placeholder or a bad import? A note here, never at the coin toss (owner 2026-11-15) */}
        <JanuaryDobNotice roster={awayRoster} bench={benchAway} idMode={idMode} />
        {/* Roster import for the away team + player stats */}
        <div className="flex gap-3 stack:flex-col">
          {/* Left: Roster import (Remote · PDF · Photo) */}
          {renderRosterImport('away')}
          {/* Right: Player Stats */}
          {(() => {
            const awayCaptain = awayRoster.find(p => p.isCaptain)
            const awayNonLiberoCount = awayRoster.filter(p => !p.libero).length
            const awayHasError = !awayCaptain || awayNonLiberoCount < 6
            return (
              <div className={cn(
                'flex flex-1 flex-wrap items-center justify-center gap-x-4 gap-y-1 rounded-xl border p-3',
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
        {/* Players saved without a shirt number: the # fields ask for them */}
        {awayWithoutNumber > 0 && (
          <p role="note" data-testid="numbers-missing-away" className="m-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
            {t('matchSetup.numbersMissingNote', { count: awayWithoutNumber })}
          </p>
        )}
        {/* Add new player section */}
        {awayRoster.length < 14 && (
          <div className="mx-auto w-max max-w-full rounded-xl border border-stone-200 bg-stone-50/60 p-3 stack:w-full">
            <div className="mb-2 text-center text-[11px] font-bold uppercase tracking-wide text-stone-500">{t('matchSetup.addNewPlayer')}</div>
            <div className={`roster-grid roster-add${lfpTrackingEnabled ? ' has-lfp' : ''}`}>
              <div className="roster-grid-row" style={{ border: 'none' }}>
                <div></div>
                <StackLabel head>{t('matchSetup.playerNumber', 'Player number')}</StackLabel>
                <input
                  aria-label={t('matchSetup.playerNumber', 'Player number')}
                  placeholder={t('matchSetup.numberPlaceholder')}
                  className="cell-head"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="99"
                  value={awayNum}
                  onChange={e => setAwayNum(shirtNumberDigits(e.target.value))}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                />
                <StackLabel>{t('matchSetup.lastName')}</StackLabel>
                <input aria-label={t('matchSetup.lastName')} className="capitalize cell-last" placeholder={t('matchSetup.lastName')} value={awayLast} onChange={e => setAwayLast(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <StackLabel>{t('matchSetup.firstName')}</StackLabel>
                <input aria-label={t('matchSetup.firstName')} className="capitalize cell-first" placeholder={t('matchSetup.firstName')} value={awayFirst} onChange={e => setAwayFirst(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <StackLabel>{idLabel}</StackLabel>
                <IdField idMode={idMode} rawValue={awayDob} onRawChange={v => setAwayDob(v)} size="bare" wrapperClassName={DOB_CELL} aria-label={idLabel} placeholder={idPlaceholder} value={awayDob ? formatDateToISO(awayDob) : ''} onChange={v => setAwayDob(v ? formatDateToDDMMYYYY(v) : '')} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }} />
                <StackLabel>{t('matchSetup.roleLibero')} · {t('matchSetup.captain')}</StackLabel>
                <select aria-label={t('matchSetup.libero', 'Libero')} className={`cell-libero${awayLibero ? '' : ' libero-unset'}`} value={awayLibero} onChange={e => setAwayLibero(e.target.value)}>
                  {liberoOptions(awayRoster, null, awayLibero)}
                </select>
                <div className="cell-captain">
                  <CaptainToggle pressed={awayCaptain} number={awayNum} onToggle={() => setAwayCaptain(!awayCaptain)} />
                </div>
                {lfpTrackingEnabled && (
                  <div className="cell-captain cell-lfp">
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
                    setAwayRoster(list => {
                      const cleared = awayCaptain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                      const newPlayer = { number: awayNum ? Number(awayNum) : null, lastName: awayLast, firstName: awayFirst, dob: awayDob, libero: newPlayerLibero(cleared, awayLibero), isCaptain: awayCaptain, isLfp: awayLfp }
                      const next = [...cleared, newPlayer].sort((a, b) => {
                        const an = a.number ?? 999
                        const bn = b.number ?? 999
                        return an - bn
                      })
                      // a team's only libero is Libero 1
                      return withLoneLiberoAsL1(next)
                    })
                    setAwayNum(''); setAwayFirst(''); setAwayLast(''); setAwayDob(''); setAwayLibero(''); setAwayCaptain(false); setAwayLfp(false)
                  }}>{t('common.add')}</Button>
                </div>
              </div>
            </div>
          </div>
        )}
        {awayRoster.length > 1 && (
          <div className="mb-2 flex items-center justify-center gap-2" data-testid="roster-sort-away">
            <span className="text-xs font-medium text-stone-500">{t('matchSetup.sortPlayers', 'Sort')}</span>
            <SegmentedControl
              ariaLabel={t('matchSetup.sortPlayers', 'Sort')}
              options={[{ value: 'number', label: '#' }, { value: 'name', label: 'A–Z' }]}
              value={rosterSort}
              onChange={(v) => { setRosterSort(v); saveRosterSort(v) }}
            />
          </div>
        )}
        {/* Sorted by number once focus leaves the list (as the home one) */}
        <div className={cn('roster-grid', lfpTrackingEnabled && 'has-lfp', ROSTER_TABLE)} onBlur={e => { if (focusLeaves(e)) { setAwayRoster(sortedByNumber); setAwayOrderTick(n => n + 1) } }}>
          {/* Roster Header Row */}
          <div className={cn('roster-grid-row grid-header', ROSTER_TABLE_HEAD)}>
            <div></div>
            <div style={{ textAlign: 'center' }}>#</div>
            <div>{t('matchSetup.lastName')}</div>
            <div>{t('matchSetup.firstName')}</div>
            <div className="cell-dob">{idLabel}{idMode === 'licence' && <LicenceInfo />}</div>
            <div style={{ textAlign: 'center' }}>{t('matchSetup.roleLibero')}</div>
            <div className="cell-captain">C</div>
            {lfpTrackingEnabled && <div style={{ textAlign: 'center' }}>LFP</div>}
            <div></div>
          </div>
          {(() => {
            const awayLiberoCount = awayRoster.filter(pl => pl.libero).length
            return awayShownOrder.filter(i => i < awayRoster.length).map((i) => {
            const p = awayRoster[i]
            const isDuplicate = p.number != null && p.number !== '' &&
              awayRoster.some((other, idx) => idx !== i && other.number === p.number)
            // saved without a number: its # asks for one (no coin toss until then)
            const missingNumber = (p.number == null || p.number === '') && !!(p.firstName || p.lastName)

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
              <div key={`a-${i}`} className={cn('roster-grid-row', isCaptain && 'row-captain', isLibero && 'row-libero')} style={borderStyle}>
                <div className={`roster-badge${isCaptain ? ' badge-captain' : isLibero ? ' badge-libero' : ''}`}>
                  {isCaptain ? 'C' : p.libero === 'libero1' ? (awayLiberoCount > 1 ? 'L1' : 'L') : p.libero === 'libero2' ? (awayLiberoCount > 1 ? 'L2' : 'L') : ''}
                </div>
                <StackLabel head>{t('matchSetup.playerNumber', 'Player number')}</StackLabel>
                <input
                  aria-label={t('matchSetup.playerNumber', 'Player number')}
                  placeholder="#"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="99"
                  value={p.number ?? ''}
                  className={cn('cell-head', isDuplicate && 'border-red-400 bg-red-50 text-red-700', missingNumber && 'border-amber-400 bg-amber-50 placeholder:text-amber-700')}
                  aria-invalid={isDuplicate || missingNumber || undefined}
                  title={isDuplicate ? t('scoreboard.duplicateJersey') : missingNumber ? t('matchSetup.numberNeeded') : undefined}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onKeyPress={e => {
                    if (!/[0-9]/.test(e.key) && e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Tab') {
                      e.preventDefault()
                    }
                  }}
                  onChange={e => {
                    const digits = shirtNumberDigits(e.target.value)
                    const val = digits ? Number(digits) : null
                    if (val !== null && (val < 1 || val > 99)) return
                    const updated = [...awayRoster]
                    updated[i] = { ...updated[i], number: val }
                    setAwayRoster(updated)
                  }}
                />
                <StackLabel>{t('matchSetup.lastName')}</StackLabel>
                <input
                  aria-label={t('matchSetup.lastName')}
                  className="capitalize cell-last"
                  placeholder={t('matchSetup.placeholders.lastName')}
                  value={p.lastName || ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={e => {
                    const updated = [...awayRoster]
                    updated[i] = { ...updated[i], lastName: e.target.value }
                    setAwayRoster(updated)
                  }}
                />
                <StackLabel>{t('matchSetup.firstName')}</StackLabel>
                <input
                  aria-label={t('matchSetup.firstName')}
                  className="capitalize cell-first"
                  placeholder={t('matchSetup.placeholders.firstName')}
                  value={p.firstName || ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={e => {
                    const updated = [...awayRoster]
                    updated[i] = { ...updated[i], firstName: e.target.value }
                    setAwayRoster(updated)
                  }}
                />
                <StackLabel>{idLabel}</StackLabel>
                <IdField
                  idMode={idMode}
                  rawValue={p.dob}
                  onRawChange={v => {
                    const updated = [...awayRoster]
                    updated[i] = { ...updated[i], dob: v }
                    setAwayRoster(updated)
                  }}
                  size="bare"
                  wrapperClassName={DOB_CELL}
                  aria-label={idLabel}
                  placeholder={idPlaceholder}
                  value={p.dob ? formatDateToISO(p.dob) : ''}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  onChange={v => {
                    const updated = [...awayRoster]
                    updated[i] = { ...updated[i], dob: v ? formatDateToDDMMYYYY(v) : '' }
                    setAwayRoster(updated)
                  }}
                />
                <StackLabel>{t('matchSetup.roleLibero')} · {t('matchSetup.captain')}</StackLabel>
                <select
                  aria-label={t('matchSetup.libero', 'Libero')}
                  className={`cell-libero${p.libero ? '' : ' libero-unset'}`}
                  value={liberoValueOf(p)}
                  onChange={e => {
                    const updated = [...awayRoster]
                    updated[i] = { ...updated[i], libero: e.target.value }
                    // state only, as on the home side
                    setAwayRoster(withLoneLiberoAsL1(updated))
                  }}
                >
                  {liberoOptions(awayRoster, i)}
                </select>
                <div className="cell-captain">
                  <CaptainToggle
                    pressed={!!p.isCaptain}
                    number={p.number}
                    onToggle={() => {
                      const updated = awayRoster.map((player, idx) => ({
                        ...player,
                        isCaptain: idx === i ? !player.isCaptain : false
                      }))
                      setAwayRoster(updated)
                    }}
                  />
                </div>
                {lfpTrackingEnabled && (
                  <div className="cell-captain cell-lfp">
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
                <div className="cell-action gap-1">
                  {rowShield('away', 'roster', p, i)}
                  <Button variant="danger-outline" size="md" title={t('common.delete')} onClick={() => setAwayRoster(list => withLoneLiberoAsL1(list.filter((_, idx) => idx !== i)))}>
                    <Trash2 size={16} className="hidden stack:block" aria-hidden="true" /><span className="stack:sr-only">{t('common.delete')}</span>
                  </Button>
                </div>
              </div>
            )
            })
          })()}
        </div>
        <div className="mt-4">
          <SectionHeader as="h4" title={`${t('matchSetup.benchOfficials')} — ${t('common.away')}`} action={clubTeams.away && (
            <Button variant="ghost" size="md" className="bg-white" icon={<UserPlus size={16} aria-hidden />} onClick={() => setOfficialPicker('away')} data-testid="bench-from-club-away">
              {t('clubPlayers.add')}
            </Button>
          )} />
        </div>
        <div className={cn('bench-grid', ROSTER_TABLE)}>
          {/* Bench Header Row */}
          <div className={cn('bench-grid-row grid-header', ROSTER_TABLE_HEAD)}>
            <div>{t('matchSetup.role')}</div>
            <div>{t('matchSetup.lastName')}</div>
            <div>{t('matchSetup.firstName')}</div>
            <div className="cell-dob">{idLabel}{idMode === 'licence' && <LicenceInfo />}</div>
            <div className="cell-plays">{t('matchSetup.playsAs', 'Plays as')}</div>
            <div></div>
          </div>
          {sortBenchByHierarchy(benchAway).map((m, i) => {
            const originalIdx = benchAway.findIndex(b => b === m)
            return (
              <div key={`ba-${originalIdx}`} className="bench-grid-row">
                <StackLabel head>{t('matchSetup.role')}</StackLabel>
                <BenchRoleCell global={match?.global === true} label={m.roleLabel || ''} testId="bench-role-name-away" placeholder={t('matchSetup.roleName', 'Role name')} onLabel={v => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], roleLabel: v }; return a })}>
                <select aria-label={t('matchSetup.role')} className="cell-head" value={m.role || 'Coach'} onChange={e => {
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
                </BenchRoleCell>
                <StackLabel>{t('matchSetup.lastName')}</StackLabel>
                <input aria-label={t('matchSetup.lastName')} className="capitalize cell-last" placeholder={t('matchSetup.lastName')} value={m.lastName} onChange={e => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], lastName: e.target.value }; return a })} />
                <StackLabel>{t('matchSetup.firstName')}</StackLabel>
                <input aria-label={t('matchSetup.firstName')} className="capitalize cell-first" placeholder={t('matchSetup.firstName')} value={m.firstName} onChange={e => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], firstName: e.target.value }; return a })} />
                <StackLabel>{idLabel}</StackLabel>
                <IdField idMode={idMode} rawValue={m.dob} onRawChange={v => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], dob: v }; return a })} size="bare" wrapperClassName={DOB_CELL} aria-label={idLabel} placeholder={idPlaceholder} value={m.dob ? formatDateToISO(m.dob) : ''} onChange={v => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = { ...a[originalIdx], dob: v ? formatDateToDDMMYYYY(v) : '' }; return a })} />
                {/* A player who is also this official (a playing coach,
                    domain/playerOfficials): found by licence or name, or
                    the scorer's choice */}
                <PlaysAsSelect official={m} players={awayRoster} t={t} testId="bench-plays-away" onChange={v => setBenchAway(arr => { const a = [...arr]; a[originalIdx] = withPlays(a[originalIdx], v); return a })} />
                <div className="cell-action gap-1">
                  {rowShield('away', 'bench', m, originalIdx)}
                  <Button variant="danger-outline" size="md" title={t('common.delete')} onClick={() => {
                    const updated = benchAway.filter((_, idx) => idx !== originalIdx)
                    setBenchAway(updated)
                    setTimeout(() => saveDraft(true), 100)
                    }}>
                      <Trash2 size={16} className="hidden stack:block" aria-hidden="true" /><span className="stack:sr-only">{t('common.delete')}</span>
                    </Button>
                </div>
              </div>
            )
          })}
          <div className="bench-grid-row bench-add-row" style={{ border: 'none', padding: 0, display: 'flex', alignItems: 'center', gap: '4px' }}>
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
          <div className="flex flex-wrap gap-4 stack:flex-col">
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
                  <img src={awayCaptainSignature} alt={t('matchSetup.captainSignature')} className="ov-ink" style={{ maxWidth: '100%', maxHeight: '100%' }} />
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
                  onClick={(e) => { e.stopPropagation(); clearSignatureSlot('away', 'captain') }}
                >
                  {t('common.clear', 'Clear')}
                </Button>
              )}
            </div>

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
                  <img src={awayCoachSignature} alt={t('matchSetup.coachSignature')} className="ov-ink" style={{ maxWidth: '100%', maxHeight: '100%' }} />
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
                  onClick={(e) => { e.stopPropagation(); clearSignatureSlot('away', 'coach') }}
                >
                  {t('common.clear', 'Clear')}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="positive" size="xl" data-testid="roster-confirm-away" onClick={async () => {

            // Check if any changes were made (skip sync if no changes)
            const hasChanges = hasRosterChanged(
              originalAwayTeamRef.current?.awayRoster,
              awayRoster,
              originalAwayTeamRef.current?.benchAway,
              benchAway
            )

            // If no changes, just go back to main view
            if (!hasChanges && !pendingSentRef.current.away && !acceptedInVisitRef.current.away) {
              console.log('[MatchSetup] No away roster changes, skipping sync')
              setCurrentView('main')
              return
            }

            // Roster save validation - only block for critical errors (duplicates,
            // invalid or missing numbers); captain and coach are validated at
            // coin toss confirmation instead
            const validationErrors = []

            // Check for duplicate numbers (critical - must block)
            const numbers = awayRoster.filter(p => p.number != null && p.number !== '').map(p => p.number)
            const duplicateNumbers = numbers.filter((num, idx) => numbers.indexOf(num) !== idx)
            if (duplicateNumbers.length > 0) {
              console.log('[MatchSetup] Away duplicate numbers:', duplicateNumbers)
              validationErrors.push(t('matchSetup.validation.duplicateNumbers', { numbers: [...new Set(duplicateNumbers)].join(', ') }))
            }

            // A player without a shirt number is saved (db/teamPlayers), the
            // coin toss waits for the numbers (owner 23.11.2026: refused here,
            // the scorer went Back and the uploaded players were gone)

            // Check for invalid numbers (whole numbers 1-99) - critical - must block
            const invalidNumbers = awayRoster.filter(p => p.number != null && p.number !== '' && !isShirtNumber(p.number))
            if (invalidNumbers.length > 0) {
              console.log('[MatchSetup] Away invalid numbers:', invalidNumbers.map(p => p.number))
              validationErrors.push(t('matchSetup.validation.invalidNumbers', { numbers: invalidNumbers.map(p => p.number).join(', ') }))
            }

            // This editor matches players by number: a player of the match
            // record renumbered (or removed) here would leave the record's
            // entries without their player. A number is changed for the whole
            // match in Corrections → Player numbers (owner 2026-10-29)
            if (matchId) {
              const recordEvents = await db.events.where('matchId').equals(matchId).toArray()
              const missing = recordNumbersMissingFrom(recordEvents, 'away', awayRoster)
              if (missing.length > 0) {
                validationErrors.push(t('matchSetup.validation.numbersInRecord', { numbers: missing.join(', '), defaultValue: "These numbers appear in the match record and cannot be changed or removed here: {{numbers}}. Change a player's number in Corrections → Player numbers: it then changes for the whole match." }))
              }
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

              // The stored players follow the roster, an emptied one too
              // (db/teamPlayers): the editor showed 0 while Coin toss, the
              // scoresheet and Match setup opened again read the old players.
              // The form keeps the stored ids: the next save updates the same
              // rows, players without a number included
              const storedIds = await writeTeamPlayers(match.awayTeamId, awayRoster)
              setAwayRoster(awayRoster.map((p, idx) => (storedIds[idx] != null && p.id !== storedIds[idx] ? { ...p, id: storedIds[idx] } : p)))

              // Update match with the bench officials. The
              // signatures are stored by their pads and Clear at once (each
              // queues the match's whole signatures object): this save sends
              // none, a partial object would replace the cloud's
              const updateData = {
                bench_away: benchAway  // Save bench officials to match record
              }

              await db.matches.update(matchId, updateData)
              // a signature of the side that no longer fits its roster goes
              await saveSideSignatures('away', awayRoster, benchAway, originalAwayTeamRef.current?.awayRoster, originalAwayTeamRef.current?.benchAway)

              // Sync away team data to Supabase as JSONB
              let awaySyncJobId = null
              if (match?.seed_key) {
                awaySyncJobId = await db.sync_queue.add({
                  resource: 'match',
                  action: 'update',
                  payload: {
                    id: match.seed_key,
                    // JSONB columns
                    away_team: { name: away?.trim() || '', color: awayColor },
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
                        [shortKey]: deriveTeamShortLabel(away),
                        [nameKey]: away?.trim() || '',
                        // on the match's live-state clock (serverDataSync liveStateNow)
                        updated_at: new Date(liveStateNow(match)).toISOString()
                      })
                      .eq('match_id', supabaseMatch.id)
                    console.log('[MatchSetup] Synced away team to match_live_state')
                  }
                } catch (err) {
                  console.debug('[MatchSetup] Could not sync away team to match_live_state:', err.message)
                }
              }

              // One non-blocking toast for this roster's own sync job
              toastQueuedSync([awaySyncJobId], {
                synced: t('matchSetup.awaySynced'),
                failed: t('matchSetup.modals.matchSavedLocalSyncFailed'),
                pending: t('matchSetup.awaySavedLocal')
              }, i18n?.language)
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
                const raw = rosterPreview === 'home' ? match?.pendingHomeRoster : match?.pendingAwayRoster
                if (!raw) return <p>{t('matchSetup.noRosterFound')}</p>
                // Only what the rules take (domain/uploadedRoster): texts and numbers, PNG signatures
                const checked = checkUploadedRoster(raw)
                if (!checked.ok) return <p role="alert">{t('matchSetup.uploadedRosterInvalid')}</p>
                const roster = checked.roster
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
                            <th className="px-2 py-2 text-left">{idLabel}</th>
                            <th className="px-2 py-2 text-center">L</th>
                            <th className="px-2 py-2 text-center">C</th>
                          </tr>
                        </thead>
                        <tbody>
                          {roster.players.map((p, i) => (
                            <tr key={i} className="border-b border-stone-100 last:border-0">
                              <td className="px-2 py-1.5 font-semibold tabular-nums text-stone-900">{p.number ?? ''}</td>
                              <td className="px-2 py-1.5 text-stone-800">{p.lastName}</td>
                              <td className="px-2 py-1.5 text-stone-800">{p.firstName}</td>
                              <td className="px-2 py-1.5 tabular-nums text-stone-800">{p.dob}</td>
                              <td className="px-2 py-1.5 text-center text-stone-800">{p.libero === 'libero1' ? 'L1' : p.libero === 'libero2' ? 'L2' : ''}</td>
                              <td className="px-2 py-1.5 text-center text-stone-800">{p.isCaptain ? 'C' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {roster.bench.length > 0 && (
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
                                  <td className="px-2 py-1.5 text-stone-800">{b.role}</td>
                                  <td className="px-2 py-1.5 text-stone-800">{b.lastName}</td>
                                  <td className="px-2 py-1.5 text-stone-800">{b.firstName}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                    {(roster.coachSignature || roster.captainSignature) && (
                      <>
                        <SectionHeader title={t('rosterSetup.signatures', 'Signatures')} className="mt-4 mb-2" />
                        <div className="flex flex-wrap gap-4">
                          {[['coach', roster.coachSignature, t('rosterSetup.coachSignature', 'Coach signature')], ['captain', roster.captainSignature, t('rosterSetup.captainSignature', 'Captain signature')]]
                            .filter(([, image]) => image)
                            .map(([key, image, label]) => (
                              <figure key={key} className="m-0">
                                <img src={image} alt={label} className="ov-ink h-16 max-w-[220px] rounded border border-stone-200 bg-white" />
                                <figcaption className="mt-1 text-xs text-stone-500">{label}</figcaption>
                              </figure>
                            ))}
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
                    setTestRosterConfirm(null)
                  }}
                >
                  {t('roster.loadTestRoster')}
                </Button>
              </div>
            </div>
          </Modal>
        )}

        {playerPoolModal}
        {clubPickerFor('away')}
        {/* Saved teams: load into this roster, or save it as a saved team */}
        <SavedTeamPickerModal
          open={savedPicker === 'away'}
          club={savedPicker === 'away' ? savedTeamClubOf('away') : null}
          clubIdOf={clubIdOfTeamName}
          onClose={() => setSavedPicker(null)}
          onPick={(team) => { setSavedPicker(null); pickSavedTeam('away', team) }}
          userId={user?.id ?? null}
          access={access}
          defaultCompetitionId={savedSuggestion?.away?.competitionId || ''}
          roster={awayRoster}
          bench={benchAway}
          teamLabel={away || t('matchSetup.awayTeam')}
        />

        {/* SignaturePad for away team view */}
        <SignaturePad
          open={openSignature !== null}
          onClose={() => setOpenSignature(null)}
          onSave={handleSignatureSave}
          phone={phoneSigning(openSignature)}
          title={openSignature === 'home-coach' ? 'Home coach signature' :
            openSignature === 'home-captain' ? 'Home captain signature' :
              openSignature === 'away-coach' ? 'Away coach signature' :
                openSignature === 'away-captain' ? 'Away captain signature' : 'Sign'}
          // a signed slot opens read-only; replacing it is an explicit Re-sign
          existingSignature={signatureStateOf[openSignature]?.[0] || null}
          readOnly={!!signatureStateOf[openSignature]?.[0]}
          allowResign
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
  // Hidden if offline mode, and for a match that never syncs (a test, Easy or
  // Global match: domain/matchKind; a Global match showed "Not synced" once it
  // stopped being test-flagged). A kit status pill: tinted round pill, dot + word.
  const SyncStatusIndicator = ({ status, onRetry }) => {
    if (offlineMode || isLocalOnly(match)) return null
    // not checked yet: the pill's room, empty, so nothing moves when it comes
    if (status == null) return <span aria-hidden="true" className="inline-block h-6 w-0 shrink-0" data-testid="sync-pill-pending" />

    const tones = {
      synced: { pill: 'border-emerald-200 bg-emerald-50 text-emerald-800', dot: 'bg-emerald-500' },
      syncing: { pill: 'border-amber-200 bg-amber-50 text-amber-800', dot: 'bg-amber-500 animate-pulse' },
      error: { pill: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' },
      idle: { pill: 'border-stone-200 bg-stone-100 text-stone-600', dot: 'bg-stone-400' },
      savedOnDevice: { pill: 'border-stone-200 bg-stone-100 text-stone-600', dot: 'bg-stone-400' }
    }
    const labels = {
      synced: t('matchSetup.syncStatus.synced', 'Synced'),
      syncing: t('matchSetup.syncStatus.syncing', 'Syncing...'),
      error: t('matchSetup.syncStatus.error', 'Sync error'),
      idle: isSupabaseAvailable ? t('matchSetup.syncStatus.notSynced') : t('matchSetup.syncStatus.offline', 'Offline'),
      // Signed out: sent after sign-in (the Not signed in banner says so)
      savedOnDevice: t('matchSetup.syncStatus.savedOnDevice', 'Saved on device')
    }
    const c = tones[status] || tones.synced
    const retry = status !== 'synced' && status !== 'savedOnDevice' && onRetry

    return (
      <div
        onClick={retry ? onRetry : undefined}
        className={cn(
          'relative inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium whitespace-nowrap transition-colors',
          retry && "before:absolute before:-inset-y-2.5 before:inset-x-0 before:content-['']",
          c.pill,
          retry ? 'cursor-pointer hover:brightness-95' : 'cursor-default'
        )}
        title={retry ? t('matchSetup.syncStatus.clickToRetry', 'Click to retry sync') : ''}
      >
        <span className={cn('inline-block h-1.5 w-1.5 rounded-full', c.dot)} />
        <span>{labels[status]}</span>
      </div>
    )
  }

  // Officials are complete if at least 1st referee and scorer are filled
  // 2nd referee and assistant scorer are optional
  const officialsConfigured =
    !!(ref1Last && ref1First && scorerLast && scorerFirst && !scorerDobMissing)
  const matchInfoConfigured = !!(date || time || hall || city || league)
  // Basic roster configured (enough for saving)
  const homeRosterExists = !!(home && homeRoster.length >= 6 && homeCounts.liberos >= 0)
  const awayRosterExists = !!(away && awayRoster.length >= 6 && awayCounts.liberos >= 0)

  // Roster validation for proceeding to coin toss (requires captain and coach,
  // at most 14 players: FIVB 4.1.1), and a shirt number for every player,
  // liberos too: a player is saved without one, the coin toss waits for it
  // (owner 23.11.2026: "players saved anyway, but no coin toss until numbers")
  const homeConfigured = homeRosterExists && homeRoster.length <= ROSTER_MAX && homeCounts.hasCaptain && homeCounts.hasCoach && homeCounts.liberosOk && homeWithoutNumber === 0
  const awayConfigured = awayRosterExists && awayRoster.length <= ROSTER_MAX && awayCounts.hasCaptain && awayCounts.hasCoach && awayCounts.liberosOk && awayWithoutNumber === 0

  // All 4 cards must be complete before proceeding to coin toss
  const canProceedToCoinToss = matchInfoConfirmed && officialsConfigured && homeConfigured && awayConfigured

  // The game PIN notice (opened by Create match): OK or × marks it shown on
  // this device, so it never comes again for this match
  const closePinNotice = async () => {
    const id = pinNoticeMatch?.id ?? matchId
    setPinNoticeMatch(null)
    try {
      await db.matches.update(id, { pinNoticeShownAt: new Date().toISOString() })
    } catch (err) {
      console.warn('[MatchSetup] Could not note the PIN notice as shown:', err)
    }
  }
  // The signed-in scorer's own address for "Send to my email": only once it is
  // confirmed (the server mails only a confirmed address)
  const pinNoticeAccountEmail = user?.email && user?.email_confirmed_at ? user.email : null

  // Returns missing items for the "Proceed to Coin Toss" button (for WarningIndicator)
  const getCoinTossMissingItems = () => {
    const missing = []
    if (!matchInfoConfirmed) missing.push(t('warnings.matchInfoNotConfirmed'))
    if (!officialsConfigured) {
      if (!ref1Last || !ref1First) missing.push(t('warnings.firstRefereeMissing'))
      if (!scorerLast || !scorerFirst) missing.push(t('warnings.scorerNameMissing'))
      if (scorerDobMissing) missing.push(t('warnings.scorerDobMissing'))
    }
    if (!homeConfigured) {
      if (!home || homeRoster.length < 6) missing.push(t('warnings.homeRosterIncomplete', { count: homeRoster.length }))
      else {
        if (homeRoster.length > ROSTER_MAX) missing.push(t('warnings.homeRosterTooMany', { max: ROSTER_MAX, count: homeRoster.length }))
        if (!homeCounts.hasCaptain) missing.push(t('warnings.homeCaptainMissing'))
        if (!homeCounts.hasCoach) missing.push(t('warnings.homeCoachMissing'))
        if (!homeCounts.liberosOk) missing.push(t('warnings.homeTwoLiberosRequired', 'Home: 2 liberos required for more than 12 players'))
      }
      if (homeWithoutNumber > 0) missing.push(t('warnings.playersWithoutNumber', { team: home || t('matchSetup.homeTeam'), count: homeWithoutNumber }))
    }
    if (!awayConfigured) {
      if (!away || awayRoster.length < 6) missing.push(t('warnings.awayRosterIncomplete', { count: awayRoster.length }))
      else {
        if (awayRoster.length > ROSTER_MAX) missing.push(t('warnings.awayRosterTooMany', { max: ROSTER_MAX, count: awayRoster.length }))
        if (!awayCounts.hasCaptain) missing.push(t('warnings.awayCaptainMissing'))
        if (!awayCounts.hasCoach) missing.push(t('warnings.awayCoachMissing'))
        if (!awayCounts.liberosOk) missing.push(t('warnings.awayTwoLiberosRequired', 'Away: 2 liberos required for more than 12 players'))
      }
      if (awayWithoutNumber > 0) missing.push(t('warnings.playersWithoutNumber', { team: away || t('matchSetup.awayTeam'), count: awayWithoutNumber }))
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
      {/* The title on its own line, then one row: Back (where the header
          menu's Home goes), Scoresheet, Options. On a phone the three share
          the row and a long label wraps inside its button, the row itself
          never wraps; the Scoresheet icon gives its room to the label there. */}
      <div className="flex flex-col gap-3">
        <h2 className="m-0 text-xl sm:text-2xl font-bold tracking-tight text-stone-900">{t('matchSetup.title')}</h2>
        <div className="flex items-stretch gap-2" data-testid="setup-header-actions">
          {onHome && (
            <Button variant="secondary" size="xl" className={SETUP_HEADER_BUTTON} onClick={onHome} data-testid="setup-back">
              <span aria-hidden="true">←</span> {t('common.back')}
            </Button>
          )}
          <Button variant="secondary" size="xl" className={SETUP_HEADER_BUTTON} onClick={openScoresheet} icon={<FileText size={16} aria-hidden="true" className="shrink-0 max-sm:hidden" />}>
            {t('matchSetup.scoresheet')}
          </Button>
          {onOpenOptions && (
            <Button variant="secondary" size="xl" className={SETUP_HEADER_BUTTON} onClick={onOpenOptions}>
              {t('matchSetup.options')}
            </Button>
          )}
        </div>
      </div>
      <div className="setup-section">
        {/* Cloud / this device / removable drive: where this match is backed up */}
        {guestMatch && (
          <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900" role="note" data-testid="guest-match-note">
            {t('matchSetup.guestNote', 'New match without an account: it stays on this device, with a backup under its backup code. Saved teams, club lists and the referee directory need a sign-in (SV match).')}
          </p>
        )}
        {backup && <div className="ov-kit mb-3"><BackupTargetsPanel backup={backup} test={match?.test === true} globalKey={usesKeyStore(match) ? (match.globalKey || null) : null} globalPin={usesKeyStore(match) ? (match.refereePin || null) : null} /></div>}
        {/* A Global match: the opt-in readable copy in the cloud (share link, organizer list) */}
        {match?.global === true && <GlobalCloudPanel match={match} />}
        {/* Why this match does not sync, if the server refused it for good */}
        {match?.cloudBlock && <CloudBlockNotice match={match} className="mb-3" />}

        {/* db/018: not a home game of the account's clubs */}
        {clubBlock && !isLocalOnly(match) && !match?.cloudBlock && (
          <div className="ov-kit mb-3">
            <div role="alert" data-testid="club-blocked-banner" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-red-900">
              <p className="text-sm font-semibold">{t('matchSetup.clubBlockedTitle')}</p>
              <p className="mt-0.5 text-xs">{clubBlockText(clubBlock)}</p>
            </div>
          </div>
        )}

        {/* Another account already scores this official game */}
        {officialClaim && !match?.cloudBlock && (
          <div className="ov-kit mb-3">
            <div role="status" data-testid="game-taken-banner" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
              <p className="text-sm font-semibold">{t('matchSetup.gameTakenTitle', { game: gameN })}</p>
              <p className="mt-0.5 text-xs">{t('matchSetup.gameTakenBody', {
                name: officialClaim.scorer_name || t('manage.games.unknownScorer'),
                status: officialClaim.status ? t(`manage.status.${officialClaim.status}`, officialClaim.status) : '–'
              })}</p>
              <div className="mt-2">
                <Button variant="secondary" size="md" onClick={() => openRestore({ gameN })}>{t('cloudBlock.joinWithPin')}</Button>
              </div>
            </div>
          </div>
        )}

        {/* Saved rosters for the teams of a schedule game, else the players
            earlier matches on this device know of them */}
        {(savedSuggestion?.home || savedSuggestion?.away || rememberedSuggestion) && (
          <div className="ov-kit mb-3">
            <div role="status" data-testid="saved-team-suggestion" className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sky-900">
              <p className="text-sm font-semibold">{t(savedSuggestion?.home || savedSuggestion?.away ? 'savedTeams.suggestionTitle' : 'playerPool.suggestionTitle')}</p>
              <div className="mt-0.5 flex flex-col gap-0.5 text-xs">
                {savedSuggestion?.home
                  ? <span>{t('savedTeams.suggestionHome', { name: savedSuggestion.home.name })}</span>
                  : rememberedSuggestion?.home ? <span>{t('playerPool.suggestionHome', { name: home, count: rememberedSuggestion.home })}</span> : null}
                {savedSuggestion?.away
                  ? <span>{t('savedTeams.suggestionAway', { name: savedSuggestion.away.name })}</span>
                  : rememberedSuggestion?.away ? <span>{t('playerPool.suggestionAway', { name: away, count: rememberedSuggestion.away })}</span> : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {savedSuggestion?.home
                  ? <Button variant="secondary" size="md" onClick={() => loadSuggestedTeam('home')}>{t('savedTeams.loadHome')}</Button>
                  : rememberedSuggestion?.home ? <Button variant="secondary" size="md" onClick={() => chooseRememberedPlayers('home')} data-testid="choose-remembered-home">{t('playerPool.chooseHome')}</Button> : null}
                {savedSuggestion?.away
                  ? <Button variant="secondary" size="md" onClick={() => loadSuggestedTeam('away')}>{t('savedTeams.loadAway')}</Button>
                  : rememberedSuggestion?.away ? <Button variant="secondary" size="md" onClick={() => chooseRememberedPlayers('away')} data-testid="choose-remembered-away">{t('playerPool.chooseAway')}</Button> : null}
              </div>
            </div>
          </div>
        )}
        {playerPoolModal}

        {/* Match Setup Summary Card */}
        <div
          data-help-id="setup-match-info-card"
          className={cn(
            'rounded-xl border bg-stone-50/60 p-4 sm:p-5',
            matchInfoConfirmed ? 'border-stone-200/70' : canCreateMatch ? 'border-2 border-sky-300' : 'border-2 border-amber-300'
          )}
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusBadge ready={matchInfoConfirmed} pending={!matchInfoConfirmed && canCreateMatch} />
              <h3 className="m-0 text-base font-semibold text-stone-900">{t('matchSetup.matchInfo')}</h3>
            </div>
            {/* one sync chip for the card, on its own row on a phone; the
                officials get a second one only when theirs differs */}
            <div className="flex flex-wrap items-center gap-2 max-sm:basis-full">
              <SyncStatusIndicator status={matchInfoSyncStatus} onRetry={() => retrySyncForCard('matchInfo')} />
              {officialsSyncStatus !== matchInfoSyncStatus && (
                <SyncStatusIndicator status={officialsSyncStatus} onRetry={() => retrySyncForCard('officials')} />
              )}
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
              // optional, as the line judges: listed only when there is one
              ...((asstFirst || asstLast) ? [{ label: t('matchSetup.assistantScorer'), value: <span className={TRUNC} title={formatOfficial(asstLast, asstFirst)}>{formatOfficial(asstLast, asstFirst)}</span> }] : []),
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
              { label: t('matchSetup.matchFormat'), value: <span>{bestOf === 5 ? t('matchSetup.bestOf5') : bestOf === 3 ? t('matchSetup.bestOf3') : t('common.notSet')}{match?.global === true ? ` · ${pointsRegular}/${pointsDeciding}` : ''}</span> }
            ]} />
          </div>

          {/* on a phone the two share a row when they fit, else each takes a row
              of its own, and a label longer than the row wraps (130 % text:
              "Load match from schedule" widened the card past the column) */}
          {setupLocked ? (
            <p className="mt-4 mb-0 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700" role="note" data-testid="setup-locked">
              {t('matchSetup.lockedAfterCoinToss')}
            </p>
          ) : (
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {/* opens the info page with the schedule on top: the snapshot for
                Back is taken before a game is picked, so Back still discards it */}
            {match?.global === true ? (
              <>
                <Button variant="secondary" size="xl" data-testid="global-import-games-button" className="whitespace-nowrap max-sm:flex-auto max-sm:h-auto max-sm:min-h-11 max-sm:py-2 max-sm:whitespace-normal max-sm:text-center" onClick={() => setGlobalImportKind('games')}>
                  {t('globalImport.gamesButton', 'Import games (Excel)')}
                </Button>
                <Button variant="secondary" size="xl" data-testid="global-import-rosters-button" className="whitespace-nowrap max-sm:flex-auto max-sm:h-auto max-sm:min-h-11 max-sm:py-2 max-sm:whitespace-normal max-sm:text-center" onClick={() => setGlobalImportKind('rosters')}>
                  {t('globalImport.rostersButton', 'Import rosters (Excel)')}
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="xl" className="whitespace-nowrap max-sm:flex-auto max-sm:h-auto max-sm:min-h-11 max-sm:py-2 max-sm:whitespace-normal max-sm:text-center" onClick={() => { setCurrentView('info'); setLoadOfficialMatchModal(true) }}>
                {t('loadOfficialMatch.button')}
              </Button>
            )}
            {matchInfoConfirmed ? (
              <Button variant="secondary" size="xl" className="whitespace-nowrap max-sm:flex-auto max-sm:h-auto max-sm:min-h-11 max-sm:py-2 max-sm:whitespace-normal max-sm:text-center" onClick={() => setCurrentView('info')}>{t('common.edit')}</Button>
            ) : (
              <Button variant="primary" size="xl" className="whitespace-nowrap max-sm:flex-auto max-sm:h-auto max-sm:min-h-11 max-sm:py-2 max-sm:whitespace-normal max-sm:text-center" onClick={() => setCurrentView('info')}>
                {t('matchSetup.createMatch')}
              </Button>
            )}
          </div>
          )}
        </div>
      </div>
      {/* Connection toggles moved to Scoreboard Options menu (ConnectionSetupModal) */}

      <div className={cn('grid-4 setup-section', !matchInfoConfirmed && 'pointer-events-none opacity-50')}>
        <div className={cn('flex flex-col gap-5 p-4 sm:p-5', SETUP_BLOCK)} style={{ order: 1 }} data-testid="setup-team-home">
          {/* Row 1: Status + Team Name + Sync Indicator; on a phone the chip
              takes the row under the name, and a long name wraps instead of
              widening the card */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <StatusBadge ready={homeConfigured} />
              {/* Team-colour bar: frozen (team colour + contrast text, sizes) */}
              <h1 className="min-w-0 [overflow-wrap:anywhere]" style={{
                margin: 0,
                ...teamBoxStyle(homeColor),
                padding: `${s(6)}px ${s(16)}px`,
                borderRadius: s(8),
                fontSize: s(22)
              }}>
                {home && home !== 'Home' ? home.toUpperCase() : t('matchSetup.homeTeam').toUpperCase()}
              </h1>
            </div>
            <div className="max-sm:basis-full">
              <SyncStatusIndicator status={homeTeamSyncStatus} onRetry={() => retrySyncForCard('home')} />
            </div>
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

          {/* Row 3: Color selector + Shirt + Roster; the button takes its own row on a phone */}
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <span className="text-xs text-stone-500">{t('matchSetup.selectColour')}</span>
            <TeamShirt
              color={homeColor}
              numberColor={getContrastColor(homeColor)}
              style={{ cursor: coloursClosed ? 'default' : 'pointer', transform: `scale(${scaleFactor})` }}
              // The colour stays open after the coin toss: it is not on the
              // official scoresheet (the shirt is the only unlocked control)
              onClick={(e) => {
                if (coloursClosed) return
                const rect = e.currentTarget.getBoundingClientRect()
                const centerX = rect.left + rect.width / 2
                setColorPickerModal({
                  team: 'home',
                  position: { x: centerX, y: rect.bottom + 8 }
                })
              }}
            />
            {!setupLocked && <Button variant="secondary" size="xl" className="max-sm:w-full sm:ml-auto" data-testid="edit-roster-home" onClick={() => setCurrentView('home')}>{t('matchSetup.editRoster')}</Button>}
          </div>
          {coloursTooClose(homeColor, awayColor) && <CloseColourNote />}
          <SentRosterCard row={setupLocked ? null : sentRosters.home} side="home" newVersion={!!match?.sentRosterUsed?.home} onUse={() => applySentRoster('home')} onDismiss={() => dismissSentRoster('home')} />
          {renderPendingRosterNotice('home')}
          <ClubGenderNotice warnings={clubWarnings.home} gender={clubGender} />
        </div>

        <div className={cn('flex flex-col gap-5 p-4 sm:p-5', SETUP_BLOCK)} style={{ order: 2 }} data-testid="setup-team-away">
          {/* Row 1: Status + Team Name + Sync Indicator; on a phone the chip
              takes the row under the name, and a long name wraps instead of
              widening the card */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <StatusBadge ready={awayConfigured} />
              {/* Team-colour bar: frozen (team colour + contrast text, sizes) */}
              <h1 className="min-w-0 [overflow-wrap:anywhere]" style={{
                margin: 0,
                ...teamBoxStyle(awayColor),
                padding: `${s(6)}px ${s(16)}px`,
                borderRadius: s(8),
                fontSize: s(22)
              }}>
                {away && away !== 'Away' ? away.toUpperCase() : t('matchSetup.awayTeam').toUpperCase()}
              </h1>
            </div>
            <div className="max-sm:basis-full">
              <SyncStatusIndicator status={awayTeamSyncStatus} onRetry={() => retrySyncForCard('away')} />
            </div>
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

          {/* Row 3: Color selector + Shirt + Roster; the button takes its own row on a phone */}
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <span className="text-xs text-stone-500">{t('matchSetup.selectColour')}</span>
            <TeamShirt
              color={awayColor}
              numberColor={getContrastColor(awayColor)}
              style={{ cursor: coloursClosed ? 'default' : 'pointer', transform: `scale(${scaleFactor})` }}
              // The colour stays open after the coin toss: it is not on the
              // official scoresheet (the shirt is the only unlocked control)
              onClick={(e) => {
                if (coloursClosed) return
                const rect = e.currentTarget.getBoundingClientRect()
                const centerX = rect.left + rect.width / 2
                setColorPickerModal({
                  team: 'away',
                  position: { x: centerX, y: rect.bottom + 8 }
                })
              }}
            />
            {!setupLocked && <Button variant="secondary" size="xl" className="max-sm:w-full sm:ml-auto" data-testid="edit-roster-away" onClick={() => setCurrentView('away')}>{t('matchSetup.editRoster')}</Button>}
          </div>
          {coloursTooClose(homeColor, awayColor) && <CloseColourNote />}
          <SentRosterCard row={setupLocked ? null : sentRosters.away} side="away" newVersion={!!match?.sentRosterUsed?.away} onUse={() => applySentRoster('away')} onDismiss={() => dismissSentRoster('away')} />
          {renderPendingRosterNotice('away')}
          <ClubGenderNotice warnings={clubWarnings.away} gender={clubGender} />
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
              // The match as stored now: one deleted while the setup was open
              // (another page of the app) is not made again here
              const stored = matchId ? await db.matches.get(matchId) : null
              if (!stored) {
                setNoticeModal({ message: t('matchSetup.matchNotFound') })
                return
              }
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
                    homeSponsors, awaySponsors, sponsorsMarked, longIntervalAfterSet2,
                    game_n: gameN ? Number(gameN) : null,
                    gameNumber: gameN ? gameN : null,
                    league,
                    scheduledAt,
                    officials: buildOfficialsArray(
                      { firstName: ref1First, lastName: ref1Last, country: ref1Country, email: ref1Email, dob: ref1Dob },
                      { firstName: ref2First, lastName: ref2Last, country: ref2Country, email: ref2Email, dob: ref2Dob },
                      { firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob, licence: scorerLicence },
                      { firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob },
                      { lj1: lineJudge1, lj2: lineJudge2, lj3: lineJudge3, lj4: lineJudge4 },
            false,
            { home: homeContactEmail, away: awayContactEmail }
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
        // No 180px floor on a phone: # 60 + name 180 + DOB 100 was wider than
        // the card, which cut the DOB off and squeezed the # column under its
        // C / L badges (2026-10-13). The name wraps there instead.
        const nameCls = 'min-w-0 px-2 py-1.5 text-sm text-stone-800 sm:min-w-[180px] sm:px-3'
        const dobCls = 'w-[100px] px-3 py-1.5 text-center text-sm tabular-nums text-stone-600'
        const emptyCls = 'h-9'
        const tableBox = 'overflow-x-auto rounded-lg border border-stone-200'
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
              <th className={thCls}>{idLabel}</th>
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
                      <th className={thCls}>{idLabel}</th>
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
            {...backdropDismiss(() => setColorPickerModal(null))}
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
            <TeamColourPicker
              value={colorPickerModal.team === 'home' ? homeColor : awayColor}
              otherColour={colorPickerModal.team === 'home' ? awayColor : homeColor}
              lastCustom={recallCustomColour(customColourKey(colorPickerModal.team === 'home'))}
              onPick={async (color) => {
                const isHome = colorPickerModal.team === 'home'
                if (isCustomColour(color)) rememberCustomColour(customColourKey(isHome), color)
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

                    // Update matches table. The proxy does not return written
                    // rows, so look the cloud UUID up separately for match_live_state.
                    const { error: colorError } = await apiFrom('matches')
                      .update({
                        [teamKey]: {
                          name: teamName?.trim() || '',
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

                      // updated_at on the match's live-state clock, as every
                      // live-state write (serverDataSync liveStateNow)
                      await apiFrom('match_live_state')
                        .update({ [liveStateColorKey]: color, updated_at: new Date(liveStateNow(match)).toISOString() })
                        .eq('match_id', supabaseMatch.id)
                      console.log(`[MatchSetup] Synced ${liveStateColorKey} to match_live_state:`, color)
                    }
                  }
                } catch (err) {
                  console.warn('[MatchSetup] Failed to sync team color:', err)
                }
              }}
            />
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
        phone={phoneSigning(openSignature)}
        title={openSignature === 'home-coach' ? 'Home coach signature' :
          openSignature === 'home-captain' ? 'Home captain signature' :
            openSignature === 'away-coach' ? 'Away coach signature' :
              openSignature === 'away-captain' ? 'Away captain signature' : 'Sign'}
      />
      <GlobalImportModal
        open={globalImportKind !== null}
        kind={globalImportKind}
        onClose={() => setGlobalImportKind(null)}
        onPickGame={applyGlobalGame}
        onApplyTeam={applyGlobalTeam}
        homeName={home}
        awayName={away}
        idMode={idMode}
      />
      <MatchPinNotice
        open={!!pinNoticeMatch}
        match={pinNoticeMatch}
        homeName={home}
        awayName={away}
        accountEmail={pinNoticeAccountEmail}
        prefillEmail={scorerEmailOf(pinNoticeMatch) || user?.email || ''}
        onClose={closePinNotice}
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
// A roster or bench date of birth that shrinks with its table still shows
// all of DD.MM.YYYY and its calendar button (styles.css .setup-roster; the
// input itself has an inline min-width 0)
const DOB_CELL = 'cell-dob min-w-32'

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

// The roster editors: one column as wide as the card, the roster and bench
// tables shrink into it and scroll on their own (styles.css .setup-roster)
function MatchSetupHomeTeamView({ children, kitScale }) {
  return <div className={cn(SETUP_VIEW, 'setup-roster')} style={{ ...setupViewStyle, ...kitScale }}>{children}</div>
}

function MatchSetupAwayTeamView({ children, kitScale }) {
  return <div className={cn(SETUP_VIEW, 'setup-roster')} style={{ ...setupViewStyle, ...kitScale }}>{children}</div>
}
