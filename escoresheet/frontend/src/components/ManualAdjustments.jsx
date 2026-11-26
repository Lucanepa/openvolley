import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { withActivityContext } from '../db/eventHistory'
import { randomUuid } from '../utils/deviceId'
import { useAlert } from '../contexts/AlertContext'
import { swapTeamDesignation as swapTeamDesignationPatch } from '../domain/coinToss'
import { mergeOfficialsEdits, teamContactEmail, withTeamContacts, cleanContactEmail } from '../domain/officials'
import { approvalUndoJobs } from '../domain/accountApproval'
import { clearedPostMatchSignatures, isMatchOverStatus } from '../domain/matchEnd'
import { signaturesPayload } from '../domain/signatureEdits'
import { matchInfoFromLocal, queueMatchUpdate, toCloudPlayers } from '../db/matchRepository'
import { buildSetEndMatchPayload } from '../utils/eventSync'
import { signedAfterMatch } from '../services/corrections/applyCorrectionPlan'
import { Button } from '../ui/Button.jsx'
import { Card } from '../ui/Card.jsx'
import { Field } from '../ui/Field.jsx'
import { Input } from '../ui/Input.jsx'
import { Select } from '../ui/Select.jsx'
import { cn } from '../ui/cn.js'
import { confirmDialog } from '../ui/uiStore.js'
import { DateTimeField } from '../ui/DateField.jsx'
import IdField from './IdField'
import { idLabelOf, idModeOf, isDateValue } from '../domain/idMode'
import { formatDateTimeLocal, parseLocalToISO } from '../utils/timeUtils'
import CorrectionsPanel from './corrections/CorrectionsPanel.jsx'
import CorrectionBoard, { boardFits } from './corrections/CorrectionBoard.jsx'
import { LayoutDashboard } from 'lucide-react'
import { DialogHelpButton } from './help/HelpButton.jsx'
import { usePhoneWidth } from '../hooks/usePhoneWidth'
import { TEAM_COLOUR_MARK, coloursTooClose, discRing, effectiveTeamColour, HEADER_SURFACE, isCustomColour } from '../utils/teamColours'
import { Checkbox } from '../ui/Checkbox.jsx'
import { showsSponsorBoxes, sponsorsOf, sponsorsPatch, SPONSOR_MARK_NO, SPONSOR_MARK_YES } from '../domain/sponsors'
import { useSponsorsOption } from '../hooks/useSponsorsOption'
import { teamMirrorPatch } from '../domain/teamIdentity'
import { setLiveStateDirty } from '../utils/eventSync'
import TeamColourPicker, { CloseColourNote, customColourKey, recallCustomColour, rememberCustomColour } from './TeamColourPicker'
import TeamShirt from './TeamShirt'
import { backdropDismiss } from '../ui/backdropDismiss.js'
import LongIntervalSwitch from './LongIntervalSwitch'
import { longIntervalChanged } from '../domain/setInterval'
import { isLocalOnly } from '../domain/matchKind'
import { championshipTypeFields, championshipTypeToSave } from '../domain/championshipType'

// Standard volleyball team colors - keys for translation
const TEAM_COLORS = [
  { key: 'blue', value: '#3b82f6' },
  { key: 'red', value: '#ef4444' },
  { key: 'green', value: '#22c55e' },
  { key: 'yellow', value: '#eab308' },
  { key: 'purple', value: '#a855f7' },
  { key: 'orange', value: '#f97316' },
  { key: 'black', value: '#1f2937' },
  { key: 'white', value: '#f8fafc' },
  { key: 'navy', value: '#1e3a5f' },
  { key: 'maroon', value: '#7f1d1d' },
  { key: 'teal', value: '#0d9488' },
  { key: 'pink', value: '#ec4899' }
]

// A team colour that is none of the list above (picked as a custom colour in
// Match setup, or from a saved team): the select keeps it as its own option
// instead of showing the first colour of the list
const isOtherColour = (colour) =>
  typeof colour === 'string' && colour.trim() !== '' && !TEAM_COLORS.some(c => c.value.toLowerCase() === colour.trim().toLowerCase())

// That option's text: "Custom colour #…" for a colour picked as a custom one,
// the bare code for one of Match setup's twelve shirts this list lacks
// (white #FFFFFF, black #000000, red #dc2626...), which is no custom colour
const otherColourLabel = (t, colour) =>
  isCustomColour(colour) ? `${t('matchSetup.customColour', 'Custom colour')} ${colour}` : colour

// Bench official roles - keys for translation
const BENCH_ROLES = [
  { value: 'Coach', key: 'coach' },
  { value: 'Assistant Coach 1', key: 'assistantCoach1' },
  { value: 'Assistant Coach 2', key: 'assistantCoach2' },
  { value: 'Physiotherapist', key: 'physiotherapist' },
  { value: 'Medic', key: 'medic' }
]

/** The index of the last set row (the set being played, or the last one played). */
function lastSetIndex(sets) {
  return (sets || []).reduce((max, s) => Math.max(max, Number(s?.index) || 0), 0) || null
}

/**
 * Convert various date formats to ISO yyyy-MM-dd for HTML date inputs
 * Handles: DD.MM.YYYY, DD/MM/YYYY, MM/DD/YYYY, ISO format
 */
// An official's value in the change log: a licence as it is, a date of birth never
const shownId = (v) => (isDateValue(v) ? '(date of birth)' : v)

function toISODate(dateStr) {
  if (!dateStr) return ''

  // Already in ISO format (yyyy-MM-dd)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr
  }

  // European format: DD.MM.YYYY or DD/MM/YYYY
  const euroMatch = dateStr.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/)
  if (euroMatch) {
    const [, day, month, year] = euroMatch
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  // Try parsing as Date object
  const date = new Date(dateStr)
  if (!isNaN(date.getTime())) {
    return date.toISOString().split('T')[0]
  }

  return ''
}

/**
 * ManualAdjustments - Full match editing component
 * Allows editing of all match data: scores, teams, players, bench officials,
 * sanctions, timeouts, substitutions, and match officials.
 */
// The change log's label of a match field: its own key, or the label the
// field has on screen (the three match-type selects, the game number and the
// date had no key of their own and logged "Match match_type_1").
const MATCH_FIELD_LABEL_KEYS = {
  gameN: 'manualAdjustmentsEditor.gameNumber',
  match_type_1: 'matchSetup.matchType',
  match_type_2: 'manualAdjustmentsEditor.matchTypeGender',
  match_type_3: 'matchSetup.matchLevel',
  scheduledAt: 'manualAdjustmentsEditor.scheduledDateTime'
}

export function matchFieldLabel(t, field) {
  const key = MATCH_FIELD_LABEL_KEYS[field]
  if (key) return t(key)
  return t(`manualAdjustmentsEditor.${field}`, `Match ${field}`)
}

export default function ManualAdjustments({ matchId, onClose, onSave, initialTab = 'corrections', tabIds = null }) {
  const { t } = useTranslation()
  // A phone: the two teams one above the other, an official's name on one
  // line and country / date of birth on the next (the match info cards
  // switch with Tailwind's sm, the same 640 px)
  const phone = usePhoneWidth()
  const pairCols = phone ? '1fr' : '1fr 1fr'
  const officialCols = phone ? '1fr 1fr' : '1fr 1fr 80px 100px'
  const scorerCols = phone ? '1fr 1fr' : '1fr 1fr 100px'
  const { showAlert } = useAlert()
  // Sponsors on clothing (domain/sponsors.js): this device's option shows the boxes
  const [sponsorsOption] = useSponsorsOption()

  // Track all changes for audit log
  const [changes, setChanges] = useState([])
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  // Close / Save hand the page back to App, which from the scoring screen
  // first reads the match (App leaveManualAdjustments): until it switches,
  // this page stays up with the changes, so no second save and no Close
  // (a ref for the taps, the state for the button). The form is locked
  // from the Save tap and during that wait (`formLocked`): an edit typed
  // then went with the page, unsaved and without the "Discard unsaved
  // changes?" question. A Close tap while the changes are being saved does
  // nothing either (no discard question for changes being saved).
  const leavingRef = useRef(false)
  const [leaving, setLeaving] = useState(false)
  const leave = async (...calls) => {
    leavingRef.current = true
    setLeaving(true)
    try {
      await Promise.all(calls.map(call => call()))
    } finally {
      leavingRef.current = false
      setLeaving(false)
    }
  }
  const formLocked = saving || leaving
  const [activeTab, setActiveTab] = useState(initialTab)
  // the correction board over the corrections tab (match end: opt-in, the list stays the default here)
  const [showBoard, setShowBoard] = useState(false)

  // Editable state - Match
  const [editedMatch, setEditedMatch] = useState(null)

  // Editable state - Teams
  const [editedHomeTeam, setEditedHomeTeam] = useState(null)
  const [editedAwayTeam, setEditedAwayTeam] = useState(null)

  // Editable state - Bench officials (separate from team for proper loading)
  const [editedHomeBench, setEditedHomeBench] = useState([])
  const [editedAwayBench, setEditedAwayBench] = useState([])

  // Editable state - Players
  const [editedHomePlayers, setEditedHomePlayers] = useState([])
  const [editedAwayPlayers, setEditedAwayPlayers] = useState([])

  // Editable state - Officials (with DOB)
  // each team's contact address for the final scoresheet (domain/officials team contact)
  const [editedTeamContacts, setEditedTeamContacts] = useState({ home: '', away: '' })
  const [editedOfficials, setEditedOfficials] = useState({
    ref1: { firstName: '', lastName: '', country: '', dob: '' },
    ref2: { firstName: '', lastName: '', country: '', dob: '' },
    scorer: { firstName: '', lastName: '', dob: '' },
    asstScorer: { firstName: '', lastName: '', dob: '' }
  })

  // Players to delete (marked for deletion)
  const [deletedPlayerIds, setDeletedPlayerIds] = useState([])
  // The shirt colour picker of the match info tab: 'home' | 'away' | null
  const [colourPickerFor, setColourPickerFor] = useState(null)

  // Load match data
  const data = useLiveQuery(async () => {
    const match = await db.matches.get(matchId)
    if (!match) return null

    const [homeTeam, awayTeam] = await Promise.all([
      match?.homeTeamId ? db.teams.get(match.homeTeamId) : null,
      match?.awayTeamId ? db.teams.get(match.awayTeamId) : null
    ])

    const sets = await db.sets.where('matchId').equals(matchId).sortBy('index')

    const [homePlayers, awayPlayers] = await Promise.all([
      match?.homeTeamId ? db.players.where('teamId').equals(match.homeTeamId).sortBy('number') : [],
      match?.awayTeamId ? db.players.where('teamId').equals(match.awayTeamId).sortBy('number') : []
    ])

    const events = await db.events.where('matchId').equals(matchId).toArray()
    const sortedEvents = events.sort((a, b) => (a.seq || 0) - (b.seq || 0))

    return { match, homeTeam, awayTeam, sets, homePlayers, awayPlayers, events: sortedEvents }
  }, [matchId])
  // What the officials' value holds (domain/idMode): the licence (or a date of
  // birth) in a Swiss match; a Global match's own choice
  const idMode = idModeOf(data?.match)
  const idLabel = idLabelOf(t, idMode, t('manualAdjustmentsEditor.dob', 'Date of birth'))

  // Initialize the Teams / Match info editors ONCE: corrections are written
  // straight away (the panel) and re-run the live query, which must not wipe
  // the scorer's unsaved team or match-info edits.
  const initializedRef = useRef(false)
  useEffect(() => {
    if (data && !initializedRef.current) {
      initializedRef.current = true
      // the championship type as the select shows it: a value typed by hand
      // ("Regional") maps to its lowercase option, which the sheet ticks
      setEditedMatch({ ...data.match, ...championshipTypeFields(data.match) })
      setEditedHomeTeam(data.homeTeam ? { ...data.homeTeam } : null)
      setEditedAwayTeam(data.awayTeam ? { ...data.awayTeam } : null)
      setEditedHomePlayers(data.homePlayers.map(p => ({ ...p })))
      setEditedAwayPlayers(data.awayPlayers.map(p => ({ ...p })))

      // Initialize bench officials - check match.bench_home/bench_away first, then team.benchOfficials
      const homeBenchData = data.match?.bench_home?.length ? data.match.bench_home : data.homeTeam?.benchOfficials || []
      const awayBenchData = data.match?.bench_away?.length ? data.match.bench_away : data.awayTeam?.benchOfficials || []
      setEditedHomeBench(homeBenchData.map(b => ({ ...b })))
      setEditedAwayBench(awayBenchData.map(b => ({ ...b })))

      // Initialize officials from match data - handle both array and object formats
      const officialsData = data.match?.officials
      let ref1 = {}, ref2 = {}, scorer = {}, asstScorer = {}

      if (Array.isArray(officialsData)) {
        // Array format: [{ role: '1st referee', firstName, lastName, country, dob }, ...]
        ref1 = officialsData.find(o => o.role === '1st referee' || o.role === 'ref1') || {}
        ref2 = officialsData.find(o => o.role === '2nd referee' || o.role === 'ref2') || {}
        scorer = officialsData.find(o => o.role === 'scorer') || {}
        asstScorer = officialsData.find(o => o.role === 'assistant scorer' || o.role === 'asstScorer') || {}
      } else if (officialsData) {
        // Object format: { ref1: {...}, ref2: {...}, scorer: {...}, asstScorer: {...} }
        ref1 = officialsData.ref1 || {}
        ref2 = officialsData.ref2 || {}
        scorer = officialsData.scorer || {}
        asstScorer = officialsData.asstScorer || {}
      }

      setEditedOfficials({
        ref1: { firstName: ref1.firstName || ref1.first_name || '', lastName: ref1.lastName || ref1.last_name || '', country: ref1.country || '', dob: ref1.dob || '' },
        ref2: { firstName: ref2.firstName || ref2.first_name || '', lastName: ref2.lastName || ref2.last_name || '', country: ref2.country || '', dob: ref2.dob || '' },
        scorer: { firstName: scorer.firstName || scorer.first_name || '', lastName: scorer.lastName || scorer.last_name || '', dob: scorer.dob || '' },
        asstScorer: { firstName: asstScorer.firstName || asstScorer.first_name || '', lastName: asstScorer.lastName || asstScorer.last_name || '', dob: asstScorer.dob || '' }
      })
      setEditedTeamContacts({
        home: teamContactEmail(data.match.officials, 'home'),
        away: teamContactEmail(data.match.officials, 'away')
      })
    }
  }, [data])

  // Record a change for audit
  const recordChange = useCallback((category, field, before, after, description) => {
    const change = {
      ts: new Date().toISOString(),
      category,
      field,
      before,
      after,
      description
    }
    setChanges(prev => [...prev, change])
    return change
  }, [])

  // A field edited in place (match info, a team, an official): one entry per
  // field, from the value before the first edit to the last one; typed back
  // to where it was, the entry goes (one entry per keystroke filled the log)
  const recordFieldChange = useCallback((category, field, before, after, label) => {
    setChanges(prev => {
      const i = prev.findIndex(c => c.category === category && c.field === field && c.inPlace)
      const from = i >= 0 ? prev[i].before : before
      const rest = i >= 0 ? prev.filter((_, j) => j !== i) : prev
      if ((from ?? '') === (after ?? '')) return rest
      return [...rest, {
        ts: new Date().toISOString(),
        category,
        field,
        before: from,
        after,
        // a date of birth is never written into the change log (owner 2026-11-19)
        description: field.endsWith('.dob') ? `${label}: ${shownId(from) || '(empty)'} → ${shownId(after) || '(empty)'}` : `${label}: ${from || '(empty)'} → ${after || '(empty)'}`,
        inPlace: true
      }]
    })
  }, [])

  // ==================== MATCH INFO FUNCTIONS ====================
  const updateMatchInfo = useCallback((field, value) => {
    setEditedMatch(prev => {
      if (!prev) return prev
      const oldValue = prev[field]
      if (oldValue !== value) {
        recordFieldChange('match', field, oldValue, value, matchFieldLabel(t, field))
      }
      return { ...prev, [field]: value }
    })
  }, [recordFieldChange, t])

  // ==================== TEAM FUNCTIONS ====================
  const updateTeam = useCallback((field, value, isHome) => {
    const setter = isHome ? setEditedHomeTeam : setEditedAwayTeam
    const teamLabel = isHome ? 'Home' : 'Away'
    setter(prev => {
      if (!prev) return prev
      const oldValue = prev[field]
      if (oldValue !== value) {
        recordFieldChange('team', `${teamLabel.toLowerCase()}.${field}`, oldValue, value, `${teamLabel} team ${field}`)
      }
      return { ...prev, [field]: value }
    })
  }, [recordFieldChange])

  // Swap only the A/B designation (which team is A on the scoresheet): a
  // coin toss correction, nothing moves (owner's decision, 2026-10-09).
  // Home/away, team IDs, players, set scores and events are NOT touched: they
  // are keyed by home/away, so they stay correct. The A/B-labelled fields
  // (serve flags, set 5 choices, every set's side) are swapped together so
  // the first server and each team's side stay the same (domain/coinToss).
  // The log entry is written outside the state updater: React runs an
  // updater twice in StrictMode, one tap logged two swaps.
  const swapTeamDesignation = useCallback(() => {
    if (!editedMatch) return
    const patch = swapTeamDesignationPatch(editedMatch, { currentSetIndex: lastSetIndex(data?.sets) })
    recordChange('match', 'teamDesignation', `A=${editedMatch.coinTossTeamA || 'home'}`, `A=${patch.coinTossTeamA}`, 'Swapped team A/B designation')
    setEditedMatch(prev => (prev ? { ...prev, ...patch, _designationSwapped: !prev._designationSwapped } : prev))
  }, [editedMatch, data?.sets, recordChange])

  // ==================== PLAYER FUNCTIONS ====================
  const updatePlayer = useCallback((playerId, field, value, isHome) => {
    const setter = isHome ? setEditedHomePlayers : setEditedAwayPlayers
    setter(prev => prev.map(p => {
      if (p.id === playerId) {
        const oldValue = p[field]
        if (oldValue !== value) {
          recordChange('player', field, oldValue, value, `Player #${p.number} ${field}: ${oldValue || '(empty)'} → ${value || '(empty)'}`)
        }
        return { ...p, [field]: value }
      }
      return p
    }))
  }, [recordChange])

  const addPlayer = useCallback((isHome) => {
    const setter = isHome ? setEditedHomePlayers : setEditedAwayPlayers
    const team = isHome ? editedHomeTeam : editedAwayTeam
    const teamLabel = isHome ? 'Home' : 'Away'
    const newPlayer = {
      id: `new_${Date.now()}`,
      teamId: team?.id,
      number: 0,
      name: '',
      libero: false,
      isCaptain: false,
      isNew: true
    }
    recordChange('player', 'add', null, newPlayer, `Added new player to ${teamLabel} team`)
    setter(prev => [...prev, newPlayer])
  }, [editedHomeTeam, editedAwayTeam, recordChange])

  const removePlayer = useCallback((playerId, isHome) => {
    const setter = isHome ? setEditedHomePlayers : setEditedAwayPlayers
    const players = isHome ? editedHomePlayers : editedAwayPlayers
    const player = players.find(p => p.id === playerId)
    if (player) {
      recordChange('player', 'remove', player, null, `Removed player #${player.number} ${player.name}`)
      if (!String(playerId).startsWith('new_')) {
        setDeletedPlayerIds(prev => [...prev, playerId])
      }
      setter(prev => prev.filter(p => p.id !== playerId))
    }
  }, [editedHomePlayers, editedAwayPlayers, recordChange])

  // ==================== BENCH OFFICIAL FUNCTIONS ====================
  const updateBenchOfficial = useCallback((index, field, value, isHome) => {
    const setter = isHome ? setEditedHomeBench : setEditedAwayBench
    const teamLabel = isHome ? 'Home' : 'Away'
    setter(prev => {
      const staff = [...prev]
      if (staff[index]) {
        const oldValue = staff[index][field]
        if (oldValue !== value) {
          recordChange('benchOfficial', field, oldValue, value, `${teamLabel} bench official ${field}: ${oldValue || '(empty)'} → ${value || '(empty)'}`)
        }
        staff[index] = { ...staff[index], [field]: value }
      }
      return staff
    })
  }, [recordChange])

  const addBenchOfficial = useCallback((isHome) => {
    const setter = isHome ? setEditedHomeBench : setEditedAwayBench
    const teamLabel = isHome ? 'Home' : 'Away'
    const newOfficial = { firstName: '', lastName: '', role: 'coach', dob: '' }
    recordChange('benchOfficial', 'add', null, newOfficial, `Added bench official to ${teamLabel} team`)
    setter(prev => [...prev, newOfficial])
  }, [recordChange])

  const removeBenchOfficial = useCallback((index, isHome) => {
    const setter = isHome ? setEditedHomeBench : setEditedAwayBench
    const bench = isHome ? editedHomeBench : editedAwayBench
    const teamLabel = isHome ? 'Home' : 'Away'
    const official = bench[index]
    if (official) {
      const name = `${official.firstName || ''} ${official.lastName || ''}`.trim() || official.role
      recordChange('benchOfficial', 'remove', official, null, `Removed ${teamLabel} bench official: ${name}`)
      setter(prev => {
        const staff = [...prev]
        staff.splice(index, 1)
        return staff
      })
    }
  }, [editedHomeBench, editedAwayBench, recordChange])

  // ==================== OFFICIALS FUNCTIONS ====================
  const updateOfficial = useCallback((role, field, value) => {
    setEditedOfficials(prev => {
      const oldValue = prev[role]?.[field]
      if (oldValue !== value) {
        recordFieldChange('official', `${role}.${field}`, oldValue, value, `${role} ${field}`)
      }
      return { ...prev, [role]: { ...prev[role], [field]: value } }
    })
  }, [recordFieldChange])

  const updateTeamContact = useCallback((team, value) => {
    setEditedTeamContacts(prev => {
      if (prev[team] !== value) recordFieldChange('official', `teamContact.${team}`, prev[team], value, `${team} team contact email`)
      return { ...prev, [team]: value }
    })
  }, [recordFieldChange])

  // A team's Sponsors on clothing box: the first tick marks the match; logged
  // as (-) / (+), the way the sheet prints it
  const updateSponsors = useCallback((team, ticked) => {
    const teamName = (team === 'home' ? editedHomeTeam?.name : editedAwayTeam?.name) || t(team === 'home' ? 'common.home' : 'common.away')
    setEditedMatch(prev => {
      if (!prev) return prev
      const before = sponsorsOf(prev)[team] ? SPONSOR_MARK_YES : SPONSOR_MARK_NO
      const after = ticked ? SPONSOR_MARK_YES : SPONSOR_MARK_NO
      recordFieldChange('match', `${team}Sponsors`, before, after, `${t('options.sponsorsOnClothing')}, ${teamName}`)
      return { ...prev, ...sponsorsPatch(prev, team, ticked) }
    })
  }, [recordFieldChange, t, editedHomeTeam?.name, editedAwayTeam?.name])

  // The 10-minute interval after set 2 (domain/setInterval.js): editable
  // after the coin toss too; logged as Yes / No
  const updateLongInterval = useCallback((on) => {
    setEditedMatch(prev => {
      if (!prev) return prev
      const before = prev.longIntervalAfterSet2 === true
      if (before !== on) {
        recordFieldChange('match', 'longIntervalAfterSet2', t(before ? 'common.yes' : 'common.no'), t(on ? 'common.yes' : 'common.no'), t('matchSetup.longIntervalAfterSet2'))
      }
      return { ...prev, longIntervalAfterSet2: on }
    })
  }, [recordFieldChange, t])

  // ==================== SAVE FUNCTION ====================
  // Every event deleted or edited by the save is recorded as a manual
  // adjustment in the event history (db/eventHistory)
  const handleSave = async () => withActivityContext({ reason: 'manual_adjustment', actionId: randomUuid() }, async () => {
    if (leavingRef.current) return
    if (changes.length === 0) {
      showAlert(t('manualAdjustmentsEditor.noChanges', 'No changes to save'), 'info')
      return
    }

    // After the first post-match signature or account approval every change
    // of the sheet asks first, then clears them all (they certified the old
    // sheet), as a correction does (services/corrections/applyCorrectionPlan)
    const signedMatch = await db.matches.get(matchId)
    const sheetChanged = signedAfterMatch(signedMatch)
    if (sheetChanged) {
      const ok = await confirmDialog({
        title: t('matchEnd.signedSheetChange.title'),
        message: t('matchEnd.signedSheetChange.editor'),
        confirmLabel: t('matchEnd.signedSheetChange.confirm'),
        cancelLabel: t('corrections.action.cancel', 'Cancel'),
        tone: 'danger'
      })
      if (!ok) return
    }

    savingRef.current = true
    setSaving(true)
    // the Swap A/B fields written (for the cloud coin toss)
    let designationSaved = null
    try {
      // made at the match end: printed in REMARKS as "Corrected after the
      // match" (scoresheet_pdf/utils/sheetRemarks correctionRemarks)
      const afterMatch = isMatchOverStatus(signedMatch?.status)
      const logged = changes.map(({ inPlace, ...c }) => (afterMatch ? { ...c, afterMatch: true } : c))
      // the team edits on the match row too (homeName, homeColor, ...):
      // the scoring screen's live state, the scoresheet and the relay copy
      // read the match's first (domain/teamIdentity)
      const teamPatch = teamMirrorPatch({ home: data?.homeTeam, away: data?.awayTeam }, { home: editedHomeTeam, away: editedAwayTeam })

      // Update teams in IndexedDB (including bench officials)
      if (editedHomeTeam?.id) {
        await db.teams.update(editedHomeTeam.id, {
          name: editedHomeTeam.name,
          color: editedHomeTeam.color,
          benchOfficials: editedHomeBench
        })
      }
      if (editedAwayTeam?.id) {
        await db.teams.update(editedAwayTeam.id, {
          name: editedAwayTeam.name,
          color: editedAwayTeam.color,
          benchOfficials: editedAwayBench
        })
      }

      // Update match in IndexedDB (including bench officials on match record)
      if (editedMatch) {
        // The log as stored now: corrections may have added entries since
        // this page opened
        const storedMatch = await db.matches.get(matchId)
        const existingChanges = storedMatch?.manualChanges || []
        const designationPatch = editedMatch._designationSwapped && storedMatch
          ? swapTeamDesignationPatch(storedMatch, { currentSetIndex: lastSetIndex(await db.sets.where('matchId').equals(matchId).toArray()) })
          : {}
        if (designationPatch.coinTossTeamA) designationSaved = designationPatch
        await db.matches.update(matchId, {
          ...teamPatch,
          hall: editedMatch.hall,
          city: editedMatch.city,
          league: editedMatch.league,
          // lowercase, the "Other" text only with 'other' (domain/championshipType)
          ...championshipTypeToSave(editedMatch),
          // the game number and the date are fixed after the match: the
          // official PDF is filed under the date the server has
          ...(afterMatch ? {} : { gameN: editedMatch.gameN, scheduledAt: editedMatch.scheduledAt }),
          match_type_1: editedMatch.match_type_1,
          match_type_2: editedMatch.match_type_2,
          match_type_3: editedMatch.match_type_3,
          // Sponsors on clothing (domain/sponsors.js)
          homeSponsors: sponsorsOf(editedMatch).home,
          awaySponsors: sponsorsOf(editedMatch).away,
          sponsorsMarked: sponsorsOf(editedMatch).marked,
          // The 10-minute interval after set 2 (domain/setInterval.js)
          longIntervalAfterSet2: editedMatch.longIntervalAfterSet2 === true,
          // Swap A/B: the designation and every A/B-labelled field with it,
          // from the match as stored now (a correction made on this page
          // since it opened, e.g. a set reopened, is kept)
          ...designationPatch,
          // officials is an array of { role, ... } everywhere else: merge the
          // edits into it (keeps line judges) instead of storing the editor object
          officials: withTeamContacts(mergeOfficialsEdits(data?.match?.officials, editedOfficials), editedTeamContacts, cleanContactEmail),
          bench_home: editedHomeBench,
          bench_away: editedAwayBench,
          manualChanges: [...existingChanges, ...logged]
        })
      }

      // Update existing players in IndexedDB
      for (const player of [...editedHomePlayers, ...editedAwayPlayers]) {
        if (!String(player.id).startsWith('new_')) {
          await db.players.update(player.id, {
            name: player.name,
            number: player.number,
            libero: player.libero,
            isCaptain: player.isCaptain
          })
        }
      }

      // Add new players
      for (const player of [...editedHomePlayers, ...editedAwayPlayers]) {
        if (player.isNew) {
          await db.players.add({
            teamId: player.teamId,
            name: player.name,
            number: player.number,
            libero: player.libero,
            isCaptain: player.isCaptain,
            createdAt: new Date().toISOString()
          })
        }
      }

      // Delete removed players
      for (const playerId of deletedPlayerIds) {
        await db.players.delete(playerId)
      }

      // Signed or approved: the post-match signatures and the account
      // approvals go, here and (queued, also offline) on the server
      if (sheetChanged) {
        await db.matches.update(matchId, clearedPostMatchSignatures())
        for (const job of approvalUndoJobs(signedMatch)) await db.sync_queue.add(job)
      }

      // Sync to Supabase if available
      if (editedMatch?.seed_key) {
        await syncToSupabase(designationSaved, { signaturesCleared: sheetChanged })
      }

      // A name or a colour changed: the scoring screen sends its live
      // state again when it opens (the referee and bench tablets, the
      // livescore and Point Hub read team_a_name / team_a_color from it)
      // The interval switch too: the tablets time the break after set 2 by it
      if (Object.keys(teamPatch).length > 0 || longIntervalChanged(data?.match, editedMatch)) setLiveStateDirty(matchId, true)

      // Notify scoresheet window (and any other listeners) about the changes
      try {
        const channel = new BroadcastChannel('escoresheet-updates')
        channel.postMessage({ type: 'MANUAL_ADJUSTMENT', matchId, changes })
        channel.close()
      } catch (e) { /* BroadcastChannel not supported */ }

      showAlert(t('manualAdjustmentsEditor.saved', 'Changes saved successfully'), 'success')
      // "Saving..." until App has switched screens (onSave, then onClose)
      await leave(() => onSave?.(changes), () => onClose?.())
    } catch (error) {
      console.error('Error saving changes:', error)
      showAlert(t('manualAdjustmentsEditor.saveError', 'Error saving changes: ') + error.message, 'error')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  })

  // Sync changes to Supabase
  const syncToSupabase = async (designation = null, { signaturesCleared = false } = {}) => {
    if (!editedMatch?.seed_key) return

    try {
      // The finished sets, as every other writer sends them ([{ set, home,
      // away }], eventSync): the livescore and the official match read them
      const { set_results: setResults } = buildSetEndMatchPayload({
        seedKey: editedMatch.seed_key,
        finishedSets: (await db.sets.where('matchId').equals(matchId).toArray()).filter(s => s.finished)
      })

      // The roster as stored now, in the shape every writer uses (with the
      // dates of birth and the LFP marks: the server replaces the arrays)
      const rosterOf = async (teamId) => {
        if (!teamId) return []
        const players = (await db.players.where('teamId').equals(teamId).toArray())
          .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0))
          .map(p => (p.firstName || p.lastName || !p.name ? p
            : { ...p, firstName: p.name.split(' ')[0], lastName: p.name.split(' ').slice(1).join(' ') }))
        return toCloudPlayers(players)
      }
      const playersHome = await rosterOf(editedHomeTeam?.id ?? data?.homeTeam?.id)
      const playersAway = await rosterOf(editedAwayTeam?.id ?? data?.awayTeam?.id)

      // Build teams for Supabase
      const homeTeamData = editedHomeTeam ? {
        name: editedHomeTeam.name,
        color: editedHomeTeam.color
      } : null

      const awayTeamData = editedAwayTeam ? {
        name: editedAwayTeam.name,
        color: editedAwayTeam.color
      } : null

      // Update the cloud match through the sync queue: kept while offline and
      // retried (a direct write was lost when the device was offline)
      await queueMatchUpdate(db, editedMatch.seed_key, {
        // every key: the server replaces match_info whole (four keys wiped
        // the match type, gender and level)
        match_info: matchInfoFromLocal({ ...editedMatch, ...championshipTypeToSave(editedMatch) }),
        set_results: setResults,
        players_home: playersHome,
        players_away: playersAway,
        home_team: homeTeamData,
        away_team: awayTeamData,
        officials: withTeamContacts(mergeOfficialsEdits(data?.match?.officials, editedOfficials, { snakeCase: true }), editedTeamContacts, cleanContactEmail),
        ...(designation ? {
          coin_toss: {
            team_a: designation.coinTossTeamA,
            team_b: designation.coinTossTeamB,
            serve_a: designation.coinTossServeA,
            confirmed: true,
            // the first server the swap kept (swapTeamDesignation writes it)
            first_serve: designation.firstServe
          }
        } : {}),
        // stored first (with this save's entries), then sent as stored
        manual_changes: [...((await db.matches.get(matchId))?.manualChanges || [])],
        // the post-match signatures cleared above, cleared on the server too
        // (it kept them, attached to the changed sheet): the whole object, the
        // server replaces the column, so the pre-match ones travel along
        ...(signaturesCleared ? { signatures: signaturesPayload(await db.matches.get(matchId)) } : {})
      }, { test: isLocalOnly(data?.match) || isLocalOnly(editedMatch) })

      console.log('[ManualAdjustments] Cloud update queued')
    } catch (error) {
      console.error('Supabase sync error:', error)
    }
  }

  // ==================== RENDER HELPERS ====================
  if (!data) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text)' }}>
        {t('common.loading', 'Loading...')}
      </div>
    )
  }

  const tabs = [
    { id: 'corrections', label: t('corrections.title', 'Corrections'), helpId: 'manual-corrections-tab' },
    { id: 'teams', label: t('manualAdjustmentsEditor.tabTeams', 'Teams'), helpId: 'manual-teams-tab' },
    { id: 'info', label: t('manualAdjustmentsEditor.tabInfo', 'Match info') }
  ]
    .filter(tab => !tabIds || tabIds.includes(tab.id))
  // An approved / final match is read-only here: reopen it at the match end first
  const closed = ['approved', 'final'].includes(data.match?.status)
  // Without the Teams tab (Match › Edit match info during the match), the
  // match info tab holds each team's short name and shirt colour; the team
  // names stay as on the scoresheet (they are its official data)
  const teamLabelsOnInfo = !tabs.some(tab => tab.id === 'teams')
  const teamOf = (side) => (side === 'home' ? editedHomeTeam : editedAwayTeam)
  const colourOf = (side) => teamOf(side)?.color || effectiveTeamColour(side, side === 'home' ? data.homeTeam : data.awayTeam, data.match)
  const teamNameOf = (side) => teamOf(side)?.name || (side === 'home' ? data.match?.homeName : data.match?.awayName) || t(side === 'home' ? 'common.home' : 'common.away')
  // The game number and the date are fixed after the match: the official
  // PDF is filed under the date the server has, which this editor does not send
  const matchOver = isMatchOverStatus(data.match?.status)
  // Match info: "Other" championship type adds its text field to the League /
  // Championship type / Game number row: four to a row from lg, two by two
  // below (a quarter of a tablet's width cut the text)
  const championshipOther = editedMatch?.championshipType === 'other'
  const rowCell = championshipOther ? 'sm:col-span-6 lg:col-span-3' : 'sm:col-span-4'
  const sponsorsShown = !!editedMatch && showsSponsorBoxes(sponsorsOption, editedMatch)

  // Teams and Match info are saved together with "Save changes"; leaving
  // with unsaved edits asks first (corrections are saved one by one)
  const handleClose = async () => {
    if (leavingRef.current || savingRef.current) return
    if (changes.length > 0) {
      const ok = await confirmDialog({
        title: t('corrections.confirm.discardTitle', 'Discard unsaved changes?'),
        message: t('corrections.confirm.discard', 'The changes in Teams and Match info are not saved yet.'),
        confirmLabel: t('corrections.action.discard', 'Discard'),
        cancelLabel: t('corrections.action.cancel', 'Cancel'),
        tone: 'danger'
      })
      if (!ok) return
    }
    await leave(() => onClose?.())
  }

  // After a correction at the match end: the result changed, so the account
  // approvals (scorer, referees) are undone on the server as well, as Reopen
  // last set does; the local copy was cleared with the signatures.
  const afterCorrection = async (result, plan) => {
    // A correction that changed the roster (a renumbered player, a libero
    // mark): this page's copy of the players follows, or its Save would
    // write the old numbers back over the corrected roster
    if (plan?.playerUpdates?.length) {
      const byId = new Map(plan.playerUpdates.map(u => [u.id, u.changes]))
      const follow = (list) => list.map(p => (byId.has(p.id) ? { ...p, ...byId.get(p.id) } : p))
      setEditedHomePlayers(follow)
      setEditedAwayPlayers(follow)
    }
    // the account approvals' undo is queued by the correction itself
    // (applyCorrectionPlan approvalUndoJobs), offline too
  }
  const notifyScoresheet = () => {
    try {
      const channel = new BroadcastChannel('escoresheet-updates')
      channel.postMessage({ type: 'MANUAL_ADJUSTMENT', matchId, reason: 'correction' })
      channel.close()
    } catch { /* BroadcastChannel not supported */ }
  }

  // volleyui (RESTYLE-SPEC P3b). This editor is almost all shared inline
  // style objects, so the kit recipes are applied here, through the --ov-*
  // tokens, and every field/button picks them up.
  // Fields: box metrics only; the shared `input`/`select` rule in styles.css
  // draws the kit field (white, stone-300 hairline, rounded-lg, focus ring).
  const inputStyle = {
    padding: '8px 12px',
    fontSize: '14px',
    minHeight: '40px'
  }

  // Form label: text-xs font-medium text-stone-500.
  const labelStyle = {
    display: 'block',
    margin: '0 0 4px',
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--ov-text-muted)'
  }

  // Page card: white, rounded-2xl, stone-200/70 hairline, shadow-card.
  // The team's colour dot beside the card title, ringed when it would vanish
  // on the white card (a white or very light team)
  const teamDotStyle = (colour) => {
    const fill = colour || '#888'
    const ring = discRing(fill, HEADER_SURFACE)
    return {
      width: '24px', height: '24px', borderRadius: '50%', background: fill, display: 'inline-block', ...TEAM_COLOUR_MARK,
      ...(ring ? { boxShadow: `inset 0 0 0 1.5px ${ring}` } : {})
    }
  }

  const cardStyle = {
    padding: '16px',
    background: 'var(--ov-card)',
    border: '1px solid var(--ov-hairline-soft)',
    borderRadius: 'var(--ov-radius-xl)',
    boxShadow: 'var(--ov-shadow-card)',
    marginBottom: '16px'
  }

  // Kit buttons. Each group sits in an `.ov-kit` scope (`contents` where it
  // must stay layout-neutral) so the legacy `button` rule stays out.
  // Row tools are h-8 with a 44px hit area.
  const KIT_SCOPE = 'ov-kit contents'
  const ROW_TOOL = 'relative after:absolute after:-inset-1.5'
  // Section titles inside the cards: kit card heading (text-sm semibold).
  const cardTitleStyle = { fontSize: '15px', fontWeight: 600, margin: '0 0 16px', color: 'var(--ov-text)' }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'var(--ov-page)',
      color: 'var(--ov-text-body)',
      overflow: 'auto',
      zIndex: 1000
    }}>
      {/* Header */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-3"
        style={{ borderBottom: '1px solid var(--ov-hairline-soft)', background: 'var(--ov-card)' }}
      >
        <h1 className="text-xl font-bold tracking-tight text-stone-900" style={{ margin: 0 }}>
          {tabs.length === 1 ? tabs[0].label : t('corrections.pageTitle', 'Corrections')}
        </h1>
        <div className="ov-kit" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {/* this page covers the header and its ?: the help panel from here */}
          <DialogHelpButton screen="manualAdjustments" />
          <Button variant="secondary" size="xl" className="px-5 font-medium" onClick={handleClose}>
            {t('corrections.action.close', 'Close')}
          </Button>
          {/* Teams and Match info only: corrections are saved one by one.
              Nothing to save yet: the kit disabled fill (stone-300). */}
          {activeTab !== 'corrections' && (
            <Button
              variant="positive"
              size="xl"
              className="px-5 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:opacity-100"
              onClick={handleSave}
              disabled={saving || leaving || changes.length === 0 || closed}
              data-help-id="manual-save-button"
            >
              {saving ? t('common.saving', 'Saving...') : t('corrections.action.saveChanges', 'Save changes')} {changes.length > 0 && `(${changes.length})`}
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      {/* Section switch: the kit track segmented control (white raised
          segment on a stone track; selection is never red or blue). */}
      {tabs.length > 1 && (
      <div
        className="px-4 sm:px-6 py-3"
        style={{ borderBottom: '1px solid var(--ov-hairline-soft)', background: 'var(--ov-card)' }}
      >
      <div role="group" aria-label={t('corrections.pageTitle', 'Corrections')} className="inline-flex flex-wrap gap-1 rounded-xl bg-stone-100 p-1">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            {...(tab.helpId ? { 'data-help-id': tab.helpId } : {})}
            aria-pressed={activeTab === tab.id}
            className={`h-11 px-4 rounded-lg text-sm font-medium transition-colors ${activeTab === tab.id ? 'bg-white text-stone-900 shadow-sm' : 'bg-transparent text-stone-600 hover:bg-stone-200/60'}`}
            style={{ border: 'none' }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      </div>
      )}

      {/* Content: locked while the changes are saved and App switches back
          (formLocked; a disabled fieldset disables every input, select and
          button in it, the focused one too) */}
      <div className="p-4 sm:p-6" style={{ maxWidth: activeTab === 'corrections' ? '960px' : '1400px', margin: '0 auto' }} aria-busy={formLocked || undefined}>
        <fieldset disabled={formLocked} data-testid="manual-adjustments-form" style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
        {/* ==================== CORRECTIONS TAB ==================== */}
        {activeTab === 'corrections' && !closed && boardFits() && (
          <div className="ov-kit mb-3 flex justify-end">
            <Button variant="toolbar" size="md" icon={LayoutDashboard} onClick={() => setShowBoard(true)} data-testid="corrections-open-board">
              {t('correctionBoard.boardView', 'Board')}
            </Button>
          </div>
        )}
        {activeTab === 'corrections' && showBoard && !closed && (
          <CorrectionBoard
            mode="review"
            matchId={matchId}
            events={data.events}
            match={data.match}
            sets={data.sets}
            homeTeam={data.homeTeam}
            awayTeam={data.awayTeam}
            homePlayers={data.homePlayers}
            awayPlayers={data.awayPlayers}
            hooks={{ notifyScoresheetUpdate: notifyScoresheet, afterApply: afterCorrection }}
            onClose={() => setShowBoard(false)}
            onShowList={() => setShowBoard(false)}
          />
        )}
        {activeTab === 'corrections' && (
          <CorrectionsPanel
            mode="review"
            matchId={matchId}
            events={data.events}
            match={data.match}
            sets={data.sets}
            homeTeam={data.homeTeam}
            awayTeam={data.awayTeam}
            homePlayers={data.homePlayers}
            awayPlayers={data.awayPlayers}
            readOnly={closed}
            onReopenForCorrections={closed ? handleClose : undefined}
            hooks={{ notifyScoresheetUpdate: notifyScoresheet, afterApply: afterCorrection }}
          />
        )}

        {/* ==================== TEAMS & PLAYERS TAB ==================== */}
        {activeTab === 'teams' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: pairCols, gap: '24px' }}>
              {/* Home Team */}
              <div>
                {/* Team Info */}
                <div style={cardStyle}>
                  <h2 style={{ ...cardTitleStyle, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={teamDotStyle(editedHomeTeam?.color)} />
                    {editedMatch?.coinTossTeamA === 'away'
                      ? t('manualAdjustmentsEditor.teamBHome', 'Team B (home)')
                      : t('manualAdjustmentsEditor.teamAHome', 'Team A (home)')}
                  </h2>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div>
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.name', 'Name')}</label>
                      <input
                        type="text"
                        value={editedHomeTeam?.name || ''}
                        onChange={(e) => updateTeam('name', e.target.value, true)}
                        aria-label={`${t('common.home', 'Home')} ${t('manualAdjustmentsEditor.name', 'Name')}`}
                        style={{ ...inputStyle, width: '100%' }}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.color', 'Color')}</label>
                      <select
                        value={editedHomeTeam?.color || '#3b82f6'}
                        onChange={(e) => updateTeam('color', e.target.value, true)}
                        aria-label={`${t('common.home', 'Home')} ${t('manualAdjustmentsEditor.color', 'Color')}`}
                        style={{ ...inputStyle, width: '100%', background: 'var(--panel)' }}
                      >
                        {isOtherColour(editedHomeTeam?.color) && (
                          <option value={editedHomeTeam.color} style={{ background: 'var(--panel)', color: 'var(--text)' }}>
                            {otherColourLabel(t, editedHomeTeam.color)} ■
                          </option>
                        )}
                        {TEAM_COLORS.map(c => (
                          <option key={c.value} value={c.value} style={{ background: 'var(--panel)', color: c.value === '#f8fafc' ? '#888' : 'var(--text)' }}>
                            {t(`manualAdjustmentsEditor.colors.${c.key}`, c.key)} ■
                          </option>
                        ))}
                      </select>
                      <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '20px', height: '20px', borderRadius: '4px', background: editedHomeTeam?.color || '#3b82f6', ...TEAM_COLOUR_MARK, border: '1px solid var(--border)' }} />
                        <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{t('manualAdjustmentsEditor.selected', 'Selected')}</span>
                      </div>
                    </div>
                    <div>
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.swapTeams', 'Swap teams')}</label>
                      <span className={KIT_SCOPE}><Button variant="secondary" size="lg" className={ROW_TOOL} onClick={swapTeamDesignation}>{t('manualAdjustmentsEditor.swapAB', 'Swap A/B')}</Button></span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Away Team */}
              <div>
                {/* Team Info */}
                <div style={cardStyle}>
                  <h2 style={{ ...cardTitleStyle, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={teamDotStyle(editedAwayTeam?.color)} />
                    {editedMatch?.coinTossTeamA === 'away'
                      ? t('manualAdjustmentsEditor.teamAAway', 'Team A (away)')
                      : t('manualAdjustmentsEditor.teamBAway', 'Team B (away)')}
                  </h2>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div>
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.name', 'Name')}</label>
                      <input
                        type="text"
                        value={editedAwayTeam?.name || ''}
                        onChange={(e) => updateTeam('name', e.target.value, false)}
                        aria-label={`${t('common.away', 'Away')} ${t('manualAdjustmentsEditor.name', 'Name')}`}
                        style={{ ...inputStyle, width: '100%' }}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.color', 'Color')}</label>
                      <select
                        value={editedAwayTeam?.color || '#ef4444'}
                        onChange={(e) => updateTeam('color', e.target.value, false)}
                        aria-label={`${t('common.away', 'Away')} ${t('manualAdjustmentsEditor.color', 'Color')}`}
                        style={{ ...inputStyle, width: '100%', background: 'var(--panel)' }}
                      >
                        {isOtherColour(editedAwayTeam?.color) && (
                          <option value={editedAwayTeam.color} style={{ background: 'var(--panel)', color: 'var(--text)' }}>
                            {otherColourLabel(t, editedAwayTeam.color)} ■
                          </option>
                        )}
                        {TEAM_COLORS.map(c => (
                          <option key={c.value} value={c.value} style={{ background: 'var(--panel)', color: c.value === '#f8fafc' ? '#888' : 'var(--text)' }}>
                            {t(`manualAdjustmentsEditor.colors.${c.key}`, c.key)} ■
                          </option>
                        ))}
                      </select>
                      <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '20px', height: '20px', borderRadius: '4px', background: editedAwayTeam?.color || '#ef4444', ...TEAM_COLOUR_MARK, border: '1px solid var(--border)' }} />
                        <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{t('manualAdjustmentsEditor.selected', 'Selected')}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================== MATCH INFO TAB ==================== */}
        {/* One column of whole-width cards: Teams, Match details, Team
            contacts beside Sponsors on clothing, Match officials */}
        {activeTab === 'info' && editedMatch && (
          <div className="flex flex-col gap-4">
            {/* Teams: short name and shirt colour (Edit match info during
                the match; the names are fixed after the coin toss) */}
            {teamLabelsOnInfo && (editedHomeTeam || editedAwayTeam) && (
              <Card stack={false} data-testid="edit-team-labels">
                <h2 style={cardTitleStyle}>
                  {t('manualAdjustmentsEditor.tabTeams', 'Teams')}
                </h2>
                <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--ov-text-muted)' }}>
                  {t('manualAdjustmentsEditor.teamLabelsHint')}
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: pairCols, gap: '16px' }}>
                  {['home', 'away'].filter(side => teamOf(side)).map(side => (
                    <div key={side} data-testid={`edit-team-labels-${side}`}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', minWidth: 0 }}>
                        <span style={teamDotStyle(colourOf(side))} />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ov-text)', overflowWrap: 'anywhere', minWidth: 0 }}>{teamNameOf(side)}</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'auto', justifyContent: 'start', gap: '12px', alignItems: 'end' }}>
                        <div>
                          <span style={labelStyle}>{t('manualAdjustmentsEditor.shirtColour')}</span>
                          <button
                            type="button"
                            onClick={() => setColourPickerFor(side)}
                            disabled={closed}
                            aria-label={t('matchSetup.chooseTeamColor', { team: teamNameOf(side) })}
                            data-testid={`edit-team-colour-${side}`}
                            className="flex h-11 min-w-[64px] items-center justify-center rounded-lg border border-stone-300 bg-white px-2 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <TeamShirt color={colourOf(side)} style={{ transform: 'scale(0.7)' }} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {coloursTooClose(colourOf('home'), colourOf('away')) && <CloseColourNote className="mt-3" />}
              </Card>
            )}

            {/* Match details: the whole width (owner 20.11: beside Team
                contacts it cut long halls and left the other card empty).
                From sm a 12-column grid: Hall wide beside City; League,
                Championship type and Game number in a row; the three
                category boxes in a row; the date beside the interval
                switch. A phone: one column. Kit fields (volleyui). */}
            <Card stack={false} className="ov-kit" data-testid="edit-match-details">
              <h2 style={cardTitleStyle}>
                {t('manualAdjustmentsEditor.matchDetails', 'Match details')}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                <Field tone="compact" className="sm:col-span-8" label={t('manualAdjustmentsEditor.hall', 'Hall')}>
                  <Input
                    value={editedMatch.hall || ''}
                    onChange={(e) => updateMatchInfo('hall', e.target.value)}
                    aria-label={t('manualAdjustmentsEditor.hall', 'Hall')}
                  />
                </Field>
                <Field tone="compact" className="sm:col-span-4" label={t('manualAdjustmentsEditor.city', 'City')}>
                  <Input
                    value={editedMatch.city || ''}
                    onChange={(e) => updateMatchInfo('city', e.target.value)}
                    aria-label={t('manualAdjustmentsEditor.city', 'City')}
                  />
                </Field>
                <Field tone="compact" className={rowCell} label={t('manualAdjustmentsEditor.league', 'League')}>
                  <Input
                    value={editedMatch.league || ''}
                    onChange={(e) => updateMatchInfo('league', e.target.value)}
                    aria-label={t('manualAdjustmentsEditor.league', 'League')}
                  />
                </Field>
                {/* The sheet's Regional / National / International / Other
                    boxes (Header.tsx) tick only the stored lowercase value:
                    a select, as in Match setup (it was free text, and
                    "Regional" typed by hand ticked nothing) */}
                <Field tone="compact" className={rowCell} label={t('manualAdjustmentsEditor.championshipType', 'Championship type')}>
                  <Select
                    block
                    value={editedMatch.championshipType || ''}
                    onChange={(e) => updateMatchInfo('championshipType', e.target.value)}
                    aria-label={t('manualAdjustmentsEditor.championshipType', 'Championship type')}
                    data-testid="edit-championship-type"
                  >
                    <option value="">–</option>
                    <option value="regional">{t('matchSetup.regional', 'Regional')}</option>
                    <option value="national">{t('matchSetup.national', 'National')}</option>
                    <option value="international">{t('matchSetup.international', 'International')}</option>
                    <option value="other">{t('matchSetup.other', 'Other')}</option>
                  </Select>
                </Field>
                {championshipOther && (
                  <Field tone="compact" className={rowCell} label={t('matchSetup.specify', 'Specify')}>
                    <Input
                      value={editedMatch.championshipTypeOther || ''}
                      onChange={(e) => updateMatchInfo('championshipTypeOther', e.target.value)}
                      placeholder={t('matchSetup.otherType', 'Other type')}
                      aria-label={t('manualAdjustmentsEditor.championshipTypeOther', 'Championship type (other)')}
                      data-testid="edit-championship-type-other"
                    />
                  </Field>
                )}
                <Field tone="compact" className={rowCell} label={t('manualAdjustmentsEditor.gameNumber', 'Game number')}>
                  <Input
                    className="tabular-nums"
                    value={editedMatch.gameN || editedMatch.gameNumber || editedMatch.game_n || ''}
                    onChange={(e) => updateMatchInfo('gameN', e.target.value)}
                    disabled={matchOver}
                    aria-label={t('manualAdjustmentsEditor.gameNumber', 'Game number')}
                  />
                </Field>
                {/* the sheet's category boxes (Header.tsx): the values Match setup
                    stores. The gender used M/W/X, which no box matches, and showed
                    "Men" for a women's match. */}
                <Field tone="compact" className="sm:col-span-4" label={t('matchSetup.matchType')}>
                  <Select
                    block
                    value={editedMatch.match_type_1 || ''}
                    onChange={(e) => updateMatchInfo('match_type_1', e.target.value)}
                    aria-label={t('matchSetup.matchType')}
                  >
                    <option value="">–</option>
                    <option value="championship">{t('matchSetup.championship')}</option>
                    <option value="cup">{t('matchSetup.cup')}</option>
                    <option value="friendly">{t('matchSetup.friendly')}</option>
                    <option value="tournament">{t('matchSetup.tournament')}</option>
                    {editedMatch.match_type_1 === 'other' && <option value="other">{t('matchSetup.other')}</option>}
                  </Select>
                </Field>
                <Field tone="compact" className="sm:col-span-4" label={t('manualAdjustmentsEditor.matchTypeGender', 'Match type (gender)')}>
                  <Select
                    block
                    value={editedMatch.match_type_2 || ''}
                    onChange={(e) => updateMatchInfo('match_type_2', e.target.value)}
                    aria-label={t('manualAdjustmentsEditor.matchTypeGender', 'Match type (gender)')}
                  >
                    <option value="">–</option>
                    <option value="men">{t('manualAdjustmentsEditor.genderMen', 'Men')}</option>
                    <option value="women">{t('manualAdjustmentsEditor.genderWomen', 'Women')}</option>
                  </Select>
                </Field>
                <Field tone="compact" className="sm:col-span-4" label={t('matchSetup.matchLevel')}>
                  <Select
                    block
                    value={editedMatch.match_type_3 || ''}
                    onChange={(e) => updateMatchInfo('match_type_3', e.target.value)}
                    aria-label={t('matchSetup.matchLevel')}
                  >
                    <option value="">–</option>
                    <option value="senior">{t('matchSetup.senior')}</option>
                    {['U23', 'U21', 'U19', 'U17'].map(v => <option key={v} value={v}>{v}</option>)}
                    {editedMatch.match_type_3 === 'other' && <option value="other">{editedMatch.match_type_3_other || t('matchSetup.other')}</option>}
                  </Select>
                </Field>
                {/* The Zürich 'YYYY-MM-DDTHH:MM' both ways (timeUtils): one zone
                    in and out (a UTC slice made the time jump by the offset on
                    every edit), the gym's on a device in any zone */}
                <Field tone="compact" className="sm:col-span-6 lg:col-span-4" label={t('manualAdjustmentsEditor.scheduledDateTime', 'Scheduled date/time')}>
                  <DateTimeField
                    value={formatDateTimeLocal(editedMatch.scheduledAt)}
                    onChange={(v) => updateMatchInfo('scheduledAt', v ? parseLocalToISO(v) : null)}
                    disabled={matchOver}
                    aria-label={t('manualAdjustmentsEditor.scheduledDateTime', 'Scheduled date/time')}
                  />
                </Field>
                <LongIntervalSwitch
                  className="sm:col-span-6 lg:col-span-8"
                  checked={editedMatch.longIntervalAfterSet2 === true}
                  onChange={updateLongInterval}
                  disabled={closed}
                />
              </div>
            </Card>

            {/* Team contacts (they get the final scoresheet by email, owner
                15.11) and Sponsors on clothing, side by side under Match
                details from lg; Team contacts alone takes the whole width */}
            <div className={cn('grid grid-cols-1 gap-4', sponsorsShown && 'lg:grid-cols-2')} data-testid="edit-contacts-row">
              <Card stack={false} className="ov-kit" data-testid="edit-team-contacts">
                <h2 style={cardTitleStyle}>
                  {t('manualAdjustmentsEditor.teamContacts', 'Team contacts')}
                </h2>
                <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--ov-text-muted)' }}>
                  {t('matchSetup.teamContactEmailHint', "Gets the final scoresheet by email. Only this match's scorers see it.")}
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {['home', 'away'].map(team => {
                    const name = (team === 'home' ? data?.homeTeam?.name : data?.awayTeam?.name) || t(team === 'home' ? 'common.home' : 'common.away')
                    return (
                      <Field key={team} tone="compact" label={name}>
                        <Input
                          type="email"
                          inputMode="email"
                          autoComplete="off"
                          maxLength={254}
                          aria-label={`${name} ${t('matchSetup.teamContactEmail', 'Team contact email (optional)')}`}
                          value={editedTeamContacts[team]}
                          onChange={(e) => updateTeamContact(team, e.target.value)}
                          disabled={closed}
                        />
                      </Field>
                    )
                  })}
                </div>
              </Card>

              {/* Sponsors on clothing (domain/sponsors.js): while the option is on
                  or the match is marked; the match prints (+) / (-) after the names */}
              {sponsorsShown && (
                <Card stack={false} className="ov-kit" data-testid="edit-sponsors">
                  <h2 style={cardTitleStyle}>
                    {t('options.sponsorsOnClothing')}
                  </h2>
                  <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--ov-text-muted)' }}>
                    {t('options.sponsorsOnClothingInfo')}
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {['home', 'away'].map(team => {
                      const name = (team === 'home' ? data?.homeTeam?.name : data?.awayTeam?.name) || t(team === 'home' ? 'common.home' : 'common.away')
                      return (
                        <Checkbox
                          key={team}
                          variant="card"
                          data-testid={`edit-sponsors-${team}`}
                          aria-label={`${name} ${t('options.sponsorsOnClothing')}`}
                          label={name}
                          checked={sponsorsOf(editedMatch)[team]}
                          disabled={closed}
                          onChange={(e) => updateSponsors(team, e.target.checked)}
                        />
                      )
                    })}
                  </div>
                </Card>
              )}
            </div>

            {/* Match Officials: the whole width, the four officials two by
                two on a wide screen */}
            <Card stack={false} data-testid="edit-match-officials">
              <h2 style={cardTitleStyle}>
                {t('manualAdjustmentsEditor.matchOfficials', 'Match officials')}
              </h2>
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 xl:grid-cols-2">
                {/* 1st Referee */}
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--ov-text-muted)' }}>{t('manualAdjustmentsEditor.firstReferee', '1st referee')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: officialCols, gap: '8px' }}>
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.firstName', 'First name')}
                      value={editedOfficials.ref1.firstName}
                      onChange={(e) => updateOfficial('ref1', 'firstName', e.target.value)}
                      aria-label={`${t('manualAdjustmentsEditor.firstReferee', '1st referee')} ${t('manualAdjustmentsEditor.firstName', 'First name')}`}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.lastName', 'Last name')}
                      value={editedOfficials.ref1.lastName}
                      onChange={(e) => updateOfficial('ref1', 'lastName', e.target.value)}
                      aria-label={`${t('manualAdjustmentsEditor.firstReferee', '1st referee')} ${t('manualAdjustmentsEditor.lastName', 'Last name')}`}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.country', 'Country')}
                      value={editedOfficials.ref1.country}
                      onChange={(e) => updateOfficial('ref1', 'country', e.target.value)}
                      aria-label={`${t('manualAdjustmentsEditor.firstReferee', '1st referee')} ${t('manualAdjustmentsEditor.country', 'Country')}`}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <IdField
                      idMode={idMode}
                      rawValue={editedOfficials.ref1.dob}
                      onRawChange={(v) => updateOfficial('ref1', 'dob', v)}
                      size="bare"
                      value={toISODate(editedOfficials.ref1.dob)}
                      onChange={(v) => updateOfficial('ref1', 'dob', v)}
                      aria-label={`${t('manualAdjustmentsEditor.firstReferee', '1st referee')} ${idLabel}`}
                      style={{ ...inputStyle, padding: '4px', fontSize: '11px' }}
                    />
                  </div>
                </div>

                {/* 2nd Referee */}
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--ov-text-muted)' }}>{t('manualAdjustmentsEditor.secondReferee', '2nd referee')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: officialCols, gap: '8px' }}>
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.firstName', 'First name')}
                      value={editedOfficials.ref2.firstName}
                      onChange={(e) => updateOfficial('ref2', 'firstName', e.target.value)}
                      aria-label={`${t('manualAdjustmentsEditor.secondReferee', '2nd referee')} ${t('manualAdjustmentsEditor.firstName', 'First name')}`}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.lastName', 'Last name')}
                      value={editedOfficials.ref2.lastName}
                      onChange={(e) => updateOfficial('ref2', 'lastName', e.target.value)}
                      aria-label={`${t('manualAdjustmentsEditor.secondReferee', '2nd referee')} ${t('manualAdjustmentsEditor.lastName', 'Last name')}`}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.country', 'Country')}
                      value={editedOfficials.ref2.country}
                      onChange={(e) => updateOfficial('ref2', 'country', e.target.value)}
                      aria-label={`${t('manualAdjustmentsEditor.secondReferee', '2nd referee')} ${t('manualAdjustmentsEditor.country', 'Country')}`}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <IdField
                      idMode={idMode}
                      rawValue={editedOfficials.ref2.dob}
                      onRawChange={(v) => updateOfficial('ref2', 'dob', v)}
                      size="bare"
                      value={toISODate(editedOfficials.ref2.dob)}
                      onChange={(v) => updateOfficial('ref2', 'dob', v)}
                      aria-label={`${t('manualAdjustmentsEditor.secondReferee', '2nd referee')} ${idLabel}`}
                      style={{ ...inputStyle, padding: '4px', fontSize: '11px' }}
                    />
                  </div>
                </div>

                {/* Scorer */}
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--ov-text-muted)' }}>{t('manualAdjustmentsEditor.scorer', 'Scorer')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: scorerCols, gap: '8px' }}>
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.firstName', 'First name')}
                      value={editedOfficials.scorer.firstName}
                      onChange={(e) => updateOfficial('scorer', 'firstName', e.target.value)}
                      aria-label={`${t('manualAdjustmentsEditor.scorer', 'Scorer')} ${t('manualAdjustmentsEditor.firstName', 'First name')}`}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.lastName', 'Last name')}
                      value={editedOfficials.scorer.lastName}
                      onChange={(e) => updateOfficial('scorer', 'lastName', e.target.value)}
                      aria-label={`${t('manualAdjustmentsEditor.scorer', 'Scorer')} ${t('manualAdjustmentsEditor.lastName', 'Last name')}`}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <IdField
                      idMode={idMode}
                      rawValue={editedOfficials.scorer.dob}
                      onRawChange={(v) => updateOfficial('scorer', 'dob', v)}
                      size="bare"
                      value={toISODate(editedOfficials.scorer.dob)}
                      onChange={(v) => updateOfficial('scorer', 'dob', v)}
                      aria-label={`${t('manualAdjustmentsEditor.scorer', 'Scorer')} ${idLabel}`}
                      style={{ ...inputStyle, padding: '4px', fontSize: '11px' }}
                    />
                  </div>
                </div>

                {/* Assistant Scorer */}
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--ov-text-muted)' }}>{t('manualAdjustmentsEditor.assistantScorer', 'Assistant scorer')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: scorerCols, gap: '8px' }}>
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.firstName', 'First name')}
                      value={editedOfficials.asstScorer.firstName}
                      onChange={(e) => updateOfficial('asstScorer', 'firstName', e.target.value)}
                      aria-label={`${t('manualAdjustmentsEditor.assistantScorer', 'Assistant scorer')} ${t('manualAdjustmentsEditor.firstName', 'First name')}`}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.lastName', 'Last name')}
                      value={editedOfficials.asstScorer.lastName}
                      onChange={(e) => updateOfficial('asstScorer', 'lastName', e.target.value)}
                      aria-label={`${t('manualAdjustmentsEditor.assistantScorer', 'Assistant scorer')} ${t('manualAdjustmentsEditor.lastName', 'Last name')}`}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <IdField
                      idMode={idMode}
                      rawValue={editedOfficials.asstScorer.dob}
                      onRawChange={(v) => updateOfficial('asstScorer', 'dob', v)}
                      size="bare"
                      value={toISODate(editedOfficials.asstScorer.dob)}
                      onChange={(v) => updateOfficial('asstScorer', 'dob', v)}
                      aria-label={`${t('manualAdjustmentsEditor.assistantScorer', 'Assistant scorer')} ${idLabel}`}
                      style={{ ...inputStyle, padding: '4px', fontSize: '11px' }}
                    />
                  </div>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Changes Log */}
        {changes.length > 0 && (
          <div style={{ marginTop: '32px', padding: '12px 16px', background: 'var(--ov-warning-soft)', borderRadius: 'var(--ov-radius)', border: '1px solid var(--ov-warning-border)' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 8px', color: 'var(--ov-warning-text)' }}>
              {t('manualAdjustmentsEditor.pendingChanges', 'Pending changes')} ({changes.length})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '150px', overflowY: 'auto' }}>
              {changes.map((change, i) => (
                <div key={i} style={{ fontSize: '12px', color: 'var(--ov-warning-text)' }}>
                  • {change.description}
                </div>
              ))}
            </div>
          </div>
        )}
        </fieldset>
      </div>
      {/* The shirt colour picker of the match info tab: the same picker,
          palette and custom-colour memory as Match setup; the colour is
          saved with "Save changes" */}
      {colourPickerFor && (
        <>
          <div
            className="fixed inset-0 z-[1100] bg-stone-900/50"
            {...backdropDismiss(() => setColourPickerFor(null))}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('matchSetup.chooseTeamColor', { team: teamNameOf(colourPickerFor) })}
            className="fixed left-1/2 top-1/2 z-[1101] max-h-[90vh] w-[min(420px,calc(100vw-32px))] overflow-y-auto rounded-2xl border border-stone-200/70 bg-white p-4 shadow-2xl"
            style={{ transform: 'translate(-50%, -50%)' }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') setColourPickerFor(null) }}
            data-testid="edit-team-colour-dialog"
          >
            <div className="mb-3 text-sm leading-[1.3] font-semibold text-stone-900">
              {t('matchSetup.chooseTeamColor', { team: teamNameOf(colourPickerFor) })}
            </div>
            <TeamColourPicker
              value={colourOf(colourPickerFor)}
              otherColour={colourOf(colourPickerFor === 'home' ? 'away' : 'home')}
              lastCustom={recallCustomColour(customColourKey(teamOf(colourPickerFor)?.name, colourPickerFor))}
              onPick={(color) => {
                const side = colourPickerFor
                if (isCustomColour(color)) rememberCustomColour(customColourKey(teamOf(side)?.name, side), color)
                updateTeam('color', color, side === 'home')
                setColourPickerFor(null)
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}
