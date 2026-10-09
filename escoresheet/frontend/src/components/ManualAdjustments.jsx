import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { withActivityContext } from '../db/eventHistory'
import { randomUuid } from '../utils/deviceId'
import { useAlert } from '../contexts/AlertContext'
import { swapTeamDesignation as swapTeamDesignationPatch } from '../domain/coinToss'
import { mergeOfficialsEdits } from '../domain/officials'
import { approvedSheetChanged } from '../domain/accountApproval'
import { clearedPostMatchSignatures } from '../domain/matchEnd'
import { queueMatchUpdate } from '../db/matchRepository'
import { approvalsApi } from '../lib/accountApi'
import { Button } from '../ui/Button.jsx'
import { confirmDialog } from '../ui/uiStore.js'
import { DateField, DateTimeField } from '../ui/DateField.jsx'
import CorrectionsPanel from './corrections/CorrectionsPanel.jsx'
import { discRing, HEADER_SURFACE } from '../utils/teamColours'

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

// Bench official roles - keys for translation
const BENCH_ROLES = [
  { value: 'Coach', key: 'coach' },
  { value: 'Assistant Coach 1', key: 'assistantCoach1' },
  { value: 'Assistant Coach 2', key: 'assistantCoach2' },
  { value: 'Physiotherapist', key: 'physiotherapist' },
  { value: 'Medic', key: 'medic' }
]

/**
 * A stored instant as the local 'YYYY-MM-DDTHH:MM' the date + time field shows.
 * Local, because the field's value goes back through new Date(value) (local)
 * when saved: a UTC slice here made the time jump by the UTC offset on every edit.
 */
function toLocalDateTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Convert various date formats to ISO yyyy-MM-dd for HTML date inputs
 * Handles: DD.MM.YYYY, DD/MM/YYYY, MM/DD/YYYY, ISO format
 */
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
export default function ManualAdjustments({ matchId, onClose, onSave }) {
  const { t } = useTranslation()
  const { showAlert } = useAlert()

  // Track all changes for audit log
  const [changes, setChanges] = useState([])
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('corrections')

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
  const [editedOfficials, setEditedOfficials] = useState({
    ref1: { firstName: '', lastName: '', country: '', dob: '' },
    ref2: { firstName: '', lastName: '', country: '', dob: '' },
    scorer: { firstName: '', lastName: '', dob: '' },
    asstScorer: { firstName: '', lastName: '', dob: '' }
  })

  // Players to delete (marked for deletion)
  const [deletedPlayerIds, setDeletedPlayerIds] = useState([])

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

  // Initialize the Teams / Match info editors ONCE: corrections are written
  // straight away (the panel) and re-run the live query, which must not wipe
  // the scorer's unsaved team or match-info edits.
  const initializedRef = useRef(false)
  useEffect(() => {
    if (data && !initializedRef.current) {
      initializedRef.current = true
      setEditedMatch({ ...data.match })
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

  // ==================== MATCH INFO FUNCTIONS ====================
  const updateMatchInfo = useCallback((field, value) => {
    setEditedMatch(prev => {
      if (!prev) return prev
      const oldValue = prev[field]
      if (oldValue !== value) {
        recordChange('match', field, oldValue, value, `Match ${field}: ${oldValue || '(empty)'} → ${value || '(empty)'}`)
      }
      return { ...prev, [field]: value }
    })
  }, [recordChange])

  // ==================== TEAM FUNCTIONS ====================
  const updateTeam = useCallback((field, value, isHome) => {
    const setter = isHome ? setEditedHomeTeam : setEditedAwayTeam
    const teamLabel = isHome ? 'Home' : 'Away'
    setter(prev => {
      if (!prev) return prev
      const oldValue = prev[field]
      if (oldValue !== value) {
        recordChange('team', field, oldValue, value, `${teamLabel} team ${field}: ${oldValue || '(empty)'} → ${value || '(empty)'}`)
      }
      return { ...prev, [field]: value }
    })
  }, [recordChange])

  // Swap only the A/B designation (which team is A on the scoresheet). Home/away,
  // team IDs, players, set scores and events are NOT touched: they are keyed by
  // home/away, so they stay correct. The A/B-labelled fields (serve flags, set 5
  // choices) are swapped together so the first server and set 5 sides keep
  // referring to the same teams.
  const swapTeamDesignation = useCallback(() => {
    setEditedMatch(prev => {
      if (!prev) return prev
      const patch = swapTeamDesignationPatch(prev)
      recordChange('match', 'teamDesignation', `A=${prev.coinTossTeamA || 'home'}`, `A=${patch.coinTossTeamA}`, 'Swapped team A/B designation')
      return { ...prev, ...patch, _designationSwapped: !prev._designationSwapped }
    })
  }, [recordChange])

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
        recordChange('official', `${role}.${field}`, oldValue, value, `${role} ${field}: ${oldValue || '(empty)'} → ${value || '(empty)'}`)
      }
      return { ...prev, [role]: { ...prev[role], [field]: value } }
    })
  }, [recordChange])

  // ==================== SAVE FUNCTION ====================
  // Every event deleted or edited by the save is recorded as a manual
  // adjustment in the event history (db/eventHistory)
  const handleSave = async () => withActivityContext({ reason: 'manual_adjustment', actionId: randomUuid() }, async () => {
    if (changes.length === 0) {
      showAlert(t('manualAdjustmentsEditor.noChanges', 'No changes to save'), 'info')
      return
    }

    setSaving(true)
    try {
      // What the officials approved: the team names (set scores are only
      // changed through Corrections, which handles signatures itself).
      // Taken before the writes below re-run the live query.
      const originalSets = data?.sets || []
      const sheetChanged = approvedSheetChanged({
        originalSets,
        editedSets: originalSets,
        originalTeams: [data?.homeTeam, data?.awayTeam],
        editedTeams: [editedHomeTeam, editedAwayTeam]
      })
      const priorApprovals = Object.values(data?.match?.accountApprovals || {}).filter(r => r?.id)

      // Update teams in IndexedDB (including bench officials)
      if (editedHomeTeam?.id) {
        await db.teams.update(editedHomeTeam.id, {
          name: editedHomeTeam.name,
          shortName: editedHomeTeam.shortName,
          color: editedHomeTeam.color,
          benchOfficials: editedHomeBench
        })
      }
      if (editedAwayTeam?.id) {
        await db.teams.update(editedAwayTeam.id, {
          name: editedAwayTeam.name,
          shortName: editedAwayTeam.shortName,
          color: editedAwayTeam.color,
          benchOfficials: editedAwayBench
        })
      }

      // Update match in IndexedDB (including bench officials on match record)
      if (editedMatch) {
        // The log as stored now: corrections may have added entries since
        // this page opened
        const existingChanges = (await db.matches.get(matchId))?.manualChanges || []
        await db.matches.update(matchId, {
          hall: editedMatch.hall,
          city: editedMatch.city,
          league: editedMatch.league,
          championshipType: editedMatch.championshipType,
          gameN: editedMatch.gameN,
          scheduledAt: editedMatch.scheduledAt,
          match_type_2: editedMatch.match_type_2,
          coinTossTeamA: editedMatch.coinTossTeamA,
          coinTossTeamB: editedMatch.coinTossTeamB,
          // A/B-labelled fields move together with the designation (Swap A/B)
          ...(editedMatch._designationSwapped ? {
            firstServe: editedMatch.firstServe,
            coinTossServeA: editedMatch.coinTossServeA,
            coinTossServeB: editedMatch.coinTossServeB,
            set5LeftTeam: editedMatch.set5LeftTeam,
            set5FirstServe: editedMatch.set5FirstServe,
            setLeftTeamOverrides: editedMatch.setLeftTeamOverrides
          } : {}),
          // officials is an array of { role, ... } everywhere else: merge the
          // edits into it (keeps line judges) instead of storing the editor object
          officials: mergeOfficialsEdits(data?.match?.officials, editedOfficials),
          bench_home: editedHomeBench,
          bench_away: editedAwayBench,
          manualChanges: [...existingChanges, ...changes]
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

      // The result or the teams changed: the post-match signatures and the
      // account approvals certified the old sheet. They go, as with "Reopen
      // last set"; online, the server approvals are undone as well (they would
      // read as stale anyway once the corrected sets arrive).
      if (sheetChanged) {
        await db.matches.update(matchId, clearedPostMatchSignatures())
        if (priorApprovals.length && !data?.match?.closed_at && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
          await Promise.allSettled(priorApprovals.map(r => approvalsApi.undo(r.id)))
        }
      }

      // Sync to Supabase if available
      if (editedMatch?.seed_key) {
        await syncToSupabase()
      }

      // Notify scoresheet window (and any other listeners) about the changes
      try {
        const channel = new BroadcastChannel('escoresheet-updates')
        channel.postMessage({ type: 'MANUAL_ADJUSTMENT', matchId, changes })
        channel.close()
      } catch (e) { /* BroadcastChannel not supported */ }

      showAlert(t('manualAdjustmentsEditor.saved', 'Changes saved successfully'), 'success')
      if (onSave) onSave(changes)
      if (onClose) onClose()
    } catch (error) {
      console.error('Error saving changes:', error)
      showAlert(t('manualAdjustmentsEditor.saveError', 'Error saving changes: ') + error.message, 'error')
    } finally {
      setSaving(false)
    }
  })

  // Sync changes to Supabase
  const syncToSupabase = async () => {
    if (!editedMatch?.seed_key) return

    try {
      // Build set results for Supabase
      const setResults = (data?.sets || []).map(s => ({
        index: s.index,
        home_points: s.homePoints,
        away_points: s.awayPoints,
        finished: s.finished
      }))

      // Build players arrays for Supabase
      const playersHome = editedHomePlayers.map(p => ({
        number: p.number,
        first_name: p.firstName || p.name?.split(' ')[0] || '',
        last_name: p.lastName || p.name?.split(' ').slice(1).join(' ') || '',
        libero: p.libero || false,
        is_captain: p.isCaptain || false
      }))

      const playersAway = editedAwayPlayers.map(p => ({
        number: p.number,
        first_name: p.firstName || p.name?.split(' ')[0] || '',
        last_name: p.lastName || p.name?.split(' ').slice(1).join(' ') || '',
        libero: p.libero || false,
        is_captain: p.isCaptain || false
      }))

      // Build teams for Supabase
      const homeTeamData = editedHomeTeam ? {
        name: editedHomeTeam.name,
        short_name: editedHomeTeam.shortName,
        color: editedHomeTeam.color
      } : null

      const awayTeamData = editedAwayTeam ? {
        name: editedAwayTeam.name,
        short_name: editedAwayTeam.shortName,
        color: editedAwayTeam.color
      } : null

      // Update the cloud match through the sync queue: kept while offline and
      // retried (a direct write was lost when the device was offline)
      await queueMatchUpdate(db, editedMatch.seed_key, {
        match_info: {
          hall: editedMatch.hall || '',
          city: editedMatch.city || '',
          league: editedMatch.league || '',
          championship_type: editedMatch.championshipType || ''
        },
        set_results: setResults,
        players_home: playersHome,
        players_away: playersAway,
        home_team: homeTeamData,
        away_team: awayTeamData,
        officials: mergeOfficialsEdits(data?.match?.officials, editedOfficials, { snakeCase: true }),
        ...(editedMatch._designationSwapped ? {
          coin_toss: {
            team_a: editedMatch.coinTossTeamA,
            team_b: editedMatch.coinTossTeamB,
            serve_a: editedMatch.coinTossServeA,
            confirmed: true,
            // the first server the swap kept (swapTeamDesignation writes it)
            first_serve: editedMatch.firstServe
          }
        } : {}),
        // stored first (with this save's entries), then sent as stored
        manual_changes: [...((await db.matches.get(matchId))?.manualChanges || [])]
      }, { test: data?.match?.test === true || editedMatch.test === true })

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
  // An approved / final match is read-only here: reopen it at the match end first
  const closed = ['approved', 'final'].includes(data.match?.status)

  // Teams and Match info are saved together with "Save changes"; leaving
  // with unsaved edits asks first (corrections are saved one by one)
  const handleClose = async () => {
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
    onClose?.()
  }

  // After a correction at the match end: the result changed, so the account
  // approvals (scorer, referees) are undone on the server as well, as Reopen
  // last set does; the local copy was cleared with the signatures.
  const afterCorrection = async (result) => {
    if (!result?.signaturesCleared) return
    const prior = Object.values(data?.match?.accountApprovals || {}).filter(r => r?.id)
    if (prior.length && !data?.match?.closed_at && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      await Promise.allSettled(prior.map(r => approvalsApi.undo(r.id)))
    }
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
      width: '24px', height: '24px', borderRadius: '50%', background: fill, display: 'inline-block',
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
          {t('corrections.pageTitle', 'Corrections')}
        </h1>
        <div className="ov-kit" style={{ display: 'flex', gap: '12px' }}>
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
              disabled={saving || changes.length === 0 || closed}
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

      {/* Content */}
      <div className="p-4 sm:p-6" style={{ maxWidth: activeTab === 'corrections' ? '960px' : '1400px', margin: '0 auto' }}>
        {/* ==================== CORRECTIONS TAB ==================== */}
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
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
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.shortNameMax8', 'Short name (max 8)')}</label>
                      <input
                        type="text"
                        maxLength={8}
                        value={editedHomeTeam?.shortName || ''}
                        onChange={(e) => updateTeam('shortName', e.target.value.toUpperCase(), true)}
                        aria-label={`${t('common.home', 'Home')} ${t('manualAdjustmentsEditor.shortNameMax8', 'Short name (max 8)')}`}
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
                            {t('matchSetup.customColour', 'Custom colour')} {editedHomeTeam.color} ■
                          </option>
                        )}
                        {TEAM_COLORS.map(c => (
                          <option key={c.value} value={c.value} style={{ background: 'var(--panel)', color: c.value === '#f8fafc' ? '#888' : 'var(--text)' }}>
                            {t(`manualAdjustmentsEditor.colors.${c.key}`, c.key)} ■
                          </option>
                        ))}
                      </select>
                      <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '20px', height: '20px', borderRadius: '4px', background: editedHomeTeam?.color || '#3b82f6', border: '1px solid var(--border)' }} />
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
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.shortNameMax8', 'Short name (max 8)')}</label>
                      <input
                        type="text"
                        maxLength={8}
                        value={editedAwayTeam?.shortName || ''}
                        onChange={(e) => updateTeam('shortName', e.target.value.toUpperCase(), false)}
                        aria-label={`${t('common.away', 'Away')} ${t('manualAdjustmentsEditor.shortNameMax8', 'Short name (max 8)')}`}
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
                            {t('matchSetup.customColour', 'Custom colour')} {editedAwayTeam.color} ■
                          </option>
                        )}
                        {TEAM_COLORS.map(c => (
                          <option key={c.value} value={c.value} style={{ background: 'var(--panel)', color: c.value === '#f8fafc' ? '#888' : 'var(--text)' }}>
                            {t(`manualAdjustmentsEditor.colors.${c.key}`, c.key)} ■
                          </option>
                        ))}
                      </select>
                      <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '20px', height: '20px', borderRadius: '4px', background: editedAwayTeam?.color || '#ef4444', border: '1px solid var(--border)' }} />
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
        {activeTab === 'info' && editedMatch && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
            {/* Match Details */}
            <div style={cardStyle}>
              <h2 style={cardTitleStyle}>
                {t('manualAdjustmentsEditor.matchDetails', 'Match details')}
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.hall', 'Hall')}</label>
                  <input
                    type="text"
                    value={editedMatch.hall || ''}
                    onChange={(e) => updateMatchInfo('hall', e.target.value)}
                    aria-label={t('manualAdjustmentsEditor.hall', 'Hall')}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.city', 'City')}</label>
                  <input
                    type="text"
                    value={editedMatch.city || ''}
                    onChange={(e) => updateMatchInfo('city', e.target.value)}
                    aria-label={t('manualAdjustmentsEditor.city', 'City')}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.league', 'League')}</label>
                  <input
                    type="text"
                    value={editedMatch.league || ''}
                    onChange={(e) => updateMatchInfo('league', e.target.value)}
                    aria-label={t('manualAdjustmentsEditor.league', 'League')}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.championshipType', 'Championship type')}</label>
                  <input
                    type="text"
                    value={editedMatch.championshipType || ''}
                    onChange={(e) => updateMatchInfo('championshipType', e.target.value)}
                    aria-label={t('manualAdjustmentsEditor.championshipType', 'Championship type')}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.gameNumber', 'Game number')}</label>
                  <input
                    type="text"
                    value={editedMatch.gameN || editedMatch.gameNumber || ''}
                    onChange={(e) => updateMatchInfo('gameN', e.target.value)}
                    aria-label={t('manualAdjustmentsEditor.gameNumber', 'Game number')}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.matchTypeGender', 'Match type (gender)')}</label>
                  <select
                    value={editedMatch.match_type_2 || 'M'}
                    onChange={(e) => updateMatchInfo('match_type_2', e.target.value)}
                    aria-label={t('manualAdjustmentsEditor.matchTypeGender', 'Match type (gender)')}
                    style={{ ...inputStyle, width: '100%' }}
                  >
                    <option value="M">{t('manualAdjustmentsEditor.genderMen', 'Men')}</option>
                    <option value="W">{t('manualAdjustmentsEditor.genderWomen', 'Women')}</option>
                    <option value="X">{t('manualAdjustmentsEditor.genderMixed', 'Mixed')}</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.scheduledDateTime', 'Scheduled date/time')}</label>
                  <DateTimeField
                    size="bare"
                    value={toLocalDateTime(editedMatch.scheduledAt)}
                    onChange={(v) => updateMatchInfo('scheduledAt', v ? new Date(v).toISOString() : null)}
                    aria-label={t('manualAdjustmentsEditor.scheduledDateTime', 'Scheduled date/time')}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
              </div>
            </div>

            {/* Match Officials */}
            <div style={cardStyle}>
              <h2 style={cardTitleStyle}>
                {t('manualAdjustmentsEditor.matchOfficials', 'Match officials')}
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* 1st Referee */}
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--ov-text-muted)' }}>{t('manualAdjustmentsEditor.firstReferee', '1st referee')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 100px', gap: '8px' }}>
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
                    <DateField
                      size="bare"
                      value={toISODate(editedOfficials.ref1.dob)}
                      onChange={(v) => updateOfficial('ref1', 'dob', v)}
                      aria-label={`${t('manualAdjustmentsEditor.firstReferee', '1st referee')} ${t('manualAdjustmentsEditor.dob', 'Date of birth')}`}
                      style={{ ...inputStyle, padding: '4px', fontSize: '11px' }}
                    />
                  </div>
                </div>

                {/* 2nd Referee */}
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--ov-text-muted)' }}>{t('manualAdjustmentsEditor.secondReferee', '2nd referee')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 100px', gap: '8px' }}>
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
                    <DateField
                      size="bare"
                      value={toISODate(editedOfficials.ref2.dob)}
                      onChange={(v) => updateOfficial('ref2', 'dob', v)}
                      aria-label={`${t('manualAdjustmentsEditor.secondReferee', '2nd referee')} ${t('manualAdjustmentsEditor.dob', 'Date of birth')}`}
                      style={{ ...inputStyle, padding: '4px', fontSize: '11px' }}
                    />
                  </div>
                </div>

                {/* Scorer */}
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--ov-text-muted)' }}>{t('manualAdjustmentsEditor.scorer', 'Scorer')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px', gap: '8px' }}>
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
                    <DateField
                      size="bare"
                      value={toISODate(editedOfficials.scorer.dob)}
                      onChange={(v) => updateOfficial('scorer', 'dob', v)}
                      aria-label={`${t('manualAdjustmentsEditor.scorer', 'Scorer')} ${t('manualAdjustmentsEditor.dob', 'Date of birth')}`}
                      style={{ ...inputStyle, padding: '4px', fontSize: '11px' }}
                    />
                  </div>
                </div>

                {/* Assistant Scorer */}
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--ov-text-muted)' }}>{t('manualAdjustmentsEditor.assistantScorer', 'Assistant scorer')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px', gap: '8px' }}>
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
                    <DateField
                      size="bare"
                      value={toISODate(editedOfficials.asstScorer.dob)}
                      onChange={(v) => updateOfficial('asstScorer', 'dob', v)}
                      aria-label={`${t('manualAdjustmentsEditor.assistantScorer', 'Assistant scorer')} ${t('manualAdjustmentsEditor.dob', 'Date of birth')}`}
                      style={{ ...inputStyle, padding: '4px', fontSize: '11px' }}
                    />
                  </div>
                </div>
              </div>
            </div>
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
      </div>
    </div>
  )
}
