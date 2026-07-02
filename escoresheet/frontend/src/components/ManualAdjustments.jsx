import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useAlert } from '../contexts/AlertContext'
import { apiFrom } from '../lib/apiClient'

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

// Bench official roles - keys for translation
const BENCH_ROLES = [
  { value: 'Coach', key: 'coach' },
  { value: 'Assistant Coach 1', key: 'assistantCoach1' },
  { value: 'Assistant Coach 2', key: 'assistantCoach2' },
  { value: 'Physiotherapist', key: 'physiotherapist' },
  { value: 'Medic', key: 'medic' }
]

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
  const [activeTab, setActiveTab] = useState('scores')

  // Editable state - Sets
  const [editedSets, setEditedSets] = useState([])

  // Editable state - Match
  const [editedMatch, setEditedMatch] = useState(null)

  // Editable state - Teams
  const [editedHomeTeam, setEditedHomeTeam] = useState(null)
  const [editedAwayTeam, setEditedAwayTeam] = useState(null)

  // Editable state - Bench officials (separate from team for proper loading)
  const [editedHomeBench, setEditedHomeBench] = useState([])
  const [editedAwayBench, setEditedAwayBench] = useState([])

  // Add sanction modal state
  const [showAddSanction, setShowAddSanction] = useState(null) // { team: 'home'|'away', playerNumber?: number, playerType: 'player'|'coach'|'bench_official' }
  const [newSanctionData, setNewSanctionData] = useState({ type: 'warning', setIndex: 1, scoreA: 0, scoreB: 0 })

  // Edit sanction modal state
  const [editingSanction, setEditingSanction] = useState(null)

  // Timeout modal state
  const [showAddTimeout, setShowAddTimeout] = useState(false)
  const [newTimeoutData, setNewTimeoutData] = useState({ team: 'home', setIndex: 1, scoreA: 0, scoreB: 0 })

  // Substitution modal state
  const [showAddSub, setShowAddSub] = useState(false)
  const [editingSub, setEditingSub] = useState(null)
  const [newSubData, setNewSubData] = useState({ team: 'home', setIndex: 1, playerOut: '', playerIn: '', scoreA: 0, scoreB: 0 })

  // Editable state - Players
  const [editedHomePlayers, setEditedHomePlayers] = useState([])
  const [editedAwayPlayers, setEditedAwayPlayers] = useState([])

  // Editable state - Events (filtered by type)
  const [allEvents, setAllEvents] = useState([])
  const [deletedEventIds, setDeletedEventIds] = useState([])
  const [newEvents, setNewEvents] = useState([])

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

  // Initialize editable state from data
  useEffect(() => {
    if (data) {
      setEditedSets(data.sets.map(s => ({ ...s })))
      setEditedMatch({ ...data.match })
      setEditedHomeTeam(data.homeTeam ? { ...data.homeTeam } : null)
      setEditedAwayTeam(data.awayTeam ? { ...data.awayTeam } : null)
      setEditedHomePlayers(data.homePlayers.map(p => ({ ...p })))
      setEditedAwayPlayers(data.awayPlayers.map(p => ({ ...p })))
      setAllEvents(data.events.map(e => ({ ...e })))

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

  // ==================== SET FUNCTIONS ====================
  const updateSetScore = useCallback((setId, field, value) => {
    setEditedSets(prev => prev.map(s => {
      if (s.id === setId) {
        const oldValue = s[field]
        const newValue = parseInt(value, 10) || 0
        if (oldValue !== newValue) {
          recordChange('set', field, oldValue, newValue, `Set ${s.index} ${field}: ${oldValue} → ${newValue}`)
        }
        return { ...s, [field]: newValue }
      }
      return s
    }))
  }, [recordChange])

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

  const swapTeamDesignation = useCallback(() => {
    // Swap home and away teams entirely
    recordChange('match', 'teamDesignation', 'original', 'swapped', 'Swapped team A/B designation')

    // Swap teams
    const tempTeam = editedHomeTeam
    setEditedHomeTeam(editedAwayTeam)
    setEditedAwayTeam(tempTeam)

    // Swap players
    const tempPlayers = editedHomePlayers
    setEditedHomePlayers(editedAwayPlayers)
    setEditedAwayPlayers(tempPlayers)

    // Swap bench officials
    const tempBench = editedHomeBench
    setEditedHomeBench(editedAwayBench)
    setEditedAwayBench(tempBench)

    // Swap team IDs in match
    setEditedMatch(prev => {
      if (!prev) return prev
      return {
        ...prev,
        homeTeamId: prev.awayTeamId,
        awayTeamId: prev.homeTeamId,
        coinTossTeamA: prev.coinTossTeamB,
        coinTossTeamB: prev.coinTossTeamA
      }
    })

    // Swap scores in sets
    setEditedSets(prev => prev.map(set => ({
      ...set,
      homePoints: set.awayPoints,
      awayPoints: set.homePoints
    })))
  }, [recordChange, editedHomeTeam, editedAwayTeam, editedHomePlayers, editedAwayPlayers, editedHomeBench, editedAwayBench])

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

  // ==================== EVENT FUNCTIONS ====================
  const deleteEvent = useCallback((eventId) => {
    const event = allEvents.find(e => e.id === eventId)
    if (event) {
      recordChange('event', 'delete', JSON.stringify(event), null, `Deleted event: ${event.type} (seq: ${event.seq})`)
      setDeletedEventIds(prev => [...prev, eventId])
      setAllEvents(prev => prev.filter(e => e.id !== eventId))
    }
  }, [allEvents, recordChange])

  const addTimeout = useCallback((team, setIndex, scoreA, scoreB) => {
    const newEvent = {
      id: `new_${Date.now()}`,
      matchId,
      type: 'timeout',
      setIndex,
      payload: { team },
      stateSnapshot: { scoreA, scoreB },
      ts: new Date().toISOString(),
      seq: Math.max(...allEvents.map(e => e.seq || 0), 0) + 1,
      isNew: true
    }
    recordChange('event', 'add', null, newEvent, `Added ${team} timeout in set ${setIndex}`)
    setNewEvents(prev => [...prev, newEvent])
    setAllEvents(prev => [...prev, newEvent].sort((a, b) => (a.seq || 0) - (b.seq || 0)))
  }, [matchId, allEvents, recordChange])

  const addSubstitution = useCallback((team, setIndex, playerOut, playerIn, scoreA, scoreB) => {
    const newEvent = {
      id: `new_${Date.now()}`,
      matchId,
      type: 'substitution',
      setIndex,
      payload: { team, playerOut, playerIn },
      stateSnapshot: { scoreA, scoreB },
      ts: new Date().toISOString(),
      seq: Math.max(...allEvents.map(e => e.seq || 0), 0) + 1,
      isNew: true
    }
    recordChange('event', 'add', null, newEvent, `Added ${team} substitution: #${playerOut} → #${playerIn}`)
    setNewEvents(prev => [...prev, newEvent])
    setAllEvents(prev => [...prev, newEvent].sort((a, b) => (a.seq || 0) - (b.seq || 0)))
  }, [matchId, allEvents, recordChange])

  const addSanction = useCallback((team, setIndex, sanctionType, playerType, playerNumber, scoreA, scoreB, role = null) => {
    const newEvent = {
      id: `new_${Date.now()}`,
      matchId,
      type: 'sanction',
      setIndex,
      payload: { team, type: sanctionType, sanctionType, playerType, playerNumber, role },
      stateSnapshot: { scoreA, scoreB },
      ts: new Date().toISOString(),
      seq: Math.max(...allEvents.map(e => e.seq || 0), 0) + 1,
      isNew: true
    }
    const targetDesc = playerType === 'player' ? `#${playerNumber}` : (role || playerType)
    recordChange('event', 'add', null, newEvent, `Added ${sanctionType} to ${team} ${playerType} ${targetDesc}`)
    setNewEvents(prev => [...prev, newEvent])
    setAllEvents(prev => [...prev, newEvent].sort((a, b) => (a.seq || 0) - (b.seq || 0)))
  }, [matchId, allEvents, recordChange])

  // Handle adding sanction from modal
  const handleAddSanctionSubmit = useCallback(() => {
    if (!showAddSanction) return
    const { team, playerNumber, playerType, role } = showAddSanction
    const { type, setIndex, scoreA, scoreB } = newSanctionData
    addSanction(team, setIndex, type, playerType, playerNumber, scoreA, scoreB, role)
    setShowAddSanction(null)
    setNewSanctionData({ type: 'warning', setIndex: 1, scoreA: 0, scoreB: 0 })
  }, [showAddSanction, newSanctionData, addSanction])

  // Handle editing sanction
  const handleEditSanctionSubmit = useCallback(() => {
    if (!editingSanction) return
    setAllEvents(prev => prev.map(e => {
      if (e.id === editingSanction.id) {
        const newPayload = { ...e.payload, type: editingSanction.type, sanctionType: editingSanction.type }
        const newSnapshot = { scoreA: editingSanction.scoreA, scoreB: editingSanction.scoreB }
        recordChange('event', 'sanction', JSON.stringify(e), JSON.stringify({ ...e, payload: newPayload, setIndex: editingSanction.setIndex, stateSnapshot: newSnapshot }), `Modified sanction`)
        return { ...e, payload: newPayload, setIndex: editingSanction.setIndex, stateSnapshot: newSnapshot, isModified: true }
      }
      return e
    }))
    setEditingSanction(null)
  }, [editingSanction, recordChange])

  // Handle adding timeout from modal
  const handleAddTimeoutSubmit = useCallback(() => {
    const { team, setIndex, scoreA, scoreB } = newTimeoutData
    addTimeout(team, setIndex, scoreA, scoreB)
    setShowAddTimeout(false)
    setNewTimeoutData({ team: 'home', setIndex: 1, scoreA: 0, scoreB: 0 })
  }, [newTimeoutData, addTimeout])

  // Handle adding substitution from modal
  const handleAddSubSubmit = useCallback(() => {
    const { team, setIndex, playerOut, playerIn, scoreA, scoreB } = newSubData
    if (!playerOut || !playerIn) return
    addSubstitution(team, setIndex, parseInt(playerOut, 10), parseInt(playerIn, 10), scoreA, scoreB)
    setShowAddSub(false)
    setNewSubData({ team: 'home', setIndex: 1, playerOut: '', playerIn: '', scoreA: 0, scoreB: 0 })
  }, [newSubData, addSubstitution])

  // Handle editing substitution
  const handleEditSubSubmit = useCallback(() => {
    if (!editingSub) return
    setAllEvents(prev => prev.map(e => {
      if (e.id === editingSub.id) {
        const newPayload = { ...e.payload, playerOut: parseInt(editingSub.playerOut, 10), playerIn: parseInt(editingSub.playerIn, 10) }
        const newSnapshot = { scoreA: editingSub.scoreA, scoreB: editingSub.scoreB }
        recordChange('event', 'substitution', JSON.stringify(e), JSON.stringify({ ...e, payload: newPayload, setIndex: editingSub.setIndex, stateSnapshot: newSnapshot }), `Modified substitution`)
        return { ...e, payload: newPayload, setIndex: editingSub.setIndex, stateSnapshot: newSnapshot, isModified: true }
      }
      return e
    }))
    setEditingSub(null)
  }, [editingSub, recordChange])

  const updateEventPayload = useCallback((eventId, field, value) => {
    setAllEvents(prev => prev.map(e => {
      if (e.id === eventId) {
        const oldValue = e.payload?.[field]
        if (oldValue !== value) {
          recordChange('event', field, oldValue, value, `Event ${e.type} ${field}: ${oldValue} → ${value}`)
        }
        return { ...e, payload: { ...e.payload, [field]: value }, isModified: true }
      }
      return e
    }))
  }, [recordChange])

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
  const handleSave = async () => {
    if (changes.length === 0) {
      showAlert(t('manualAdjustmentsEditor.noChanges', 'No changes to save'), 'info')
      return
    }

    setSaving(true)
    try {
      // Update sets in IndexedDB
      for (const set of editedSets) {
        await db.sets.update(set.id, {
          homePoints: set.homePoints,
          awayPoints: set.awayPoints,
          finished: set.finished
        })
      }

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
        const existingChanges = editedMatch.manualChanges || []
        await db.matches.update(matchId, {
          hall: editedMatch.hall,
          city: editedMatch.city,
          league: editedMatch.league,
          championshipType: editedMatch.championshipType,
          gameN: editedMatch.gameN,
          status: editedMatch.status,
          scheduledAt: editedMatch.scheduledAt,
          match_type_2: editedMatch.match_type_2,
          coinTossTeamA: editedMatch.coinTossTeamA,
          coinTossTeamB: editedMatch.coinTossTeamB,
          officials: editedOfficials,
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

      // Delete removed events
      for (const eventId of deletedEventIds) {
        if (!String(eventId).startsWith('new_')) {
          await db.events.delete(eventId)
        }
      }

      // Add new events
      for (const event of newEvents) {
        await db.events.add({
          matchId: event.matchId,
          type: event.type,
          setIndex: event.setIndex,
          payload: event.payload,
          stateSnapshot: event.stateSnapshot,
          ts: event.ts,
          seq: event.seq
        })
      }

      // Update modified events
      for (const event of allEvents) {
        if (event.isModified && !String(event.id).startsWith('new_')) {
          await db.events.update(event.id, {
            payload: event.payload
          })
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
  }

  // Sync changes to Supabase
  const syncToSupabase = async () => {
    if (!editedMatch?.seed_key) return

    try {
      // Build set results for Supabase
      const setResults = editedSets.map(s => ({
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

      // Update match in Supabase
      const { error: matchError } = await apiFrom('matches')
        .update({
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
          officials: editedOfficials,
          manual_changes: [...(editedMatch.manualChanges || []), ...changes]
        })
        .eq('external_id', editedMatch.seed_key)

      if (matchError) {
        console.error('Supabase match update error:', matchError)
        throw matchError
      }

      console.log('[ManualAdjustments] Supabase sync completed')
    } catch (error) {
      console.error('Supabase sync error:', error)
    }
  }

  // ==================== RENDER HELPERS ====================
  const getEventsByType = (type) => allEvents.filter(e => e.type === type && !deletedEventIds.includes(e.id))
  const timeoutEvents = getEventsByType('timeout')
  const substitutionEvents = getEventsByType('substitution')
  const sanctionEvents = getEventsByType('sanction')

  // Get sanctions for a specific player
  const getPlayerSanctions = (playerNumber, team) => {
    return sanctionEvents.filter(e =>
      e.payload?.playerNumber === playerNumber &&
      e.payload?.team === team &&
      e.payload?.playerType === 'player'
    )
  }

  if (!data) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text)' }}>
        {t('common.loading', 'Loading...')}
      </div>
    )
  }

  const tabs = [
    { id: 'scores', label: t('manualAdjustmentsEditor.tabScores', 'Scores'), helpId: 'manual-scores-tab' },
    { id: 'teams', label: t('manualAdjustmentsEditor.tabTeams', 'Teams'), helpId: 'manual-teams-tab' },
    { id: 'events', label: t('manualAdjustmentsEditor.tabEvents', 'Timeouts & Subs'), helpId: 'manual-events-tab' },
    { id: 'info', label: t('manualAdjustmentsEditor.tabInfo', 'Match Info') }
  ]

  const inputStyle = {
    padding: '8px 12px',
    fontSize: '14px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    color: 'var(--text)'
  }

  const labelStyle = {
    display: 'block',
    marginBottom: '6px',
    fontSize: '13px',
    color: 'var(--muted)'
  }

  const cardStyle = {
    padding: '16px',
    background: 'var(--panel-2)',
    borderRadius: '8px',
    marginBottom: '16px'
  }

  const buttonStyle = {
    padding: '8px 16px',
    fontSize: '13px',
    background: 'rgba(59, 130, 246, 0.2)',
    color: '#60a5fa',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    borderRadius: '6px',
    cursor: 'pointer'
  }

  const deleteButtonStyle = {
    padding: '6px 12px',
    fontSize: '12px',
    background: 'rgba(239, 68, 68, 0.2)',
    color: '#ef4444',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    borderRadius: '4px',
    cursor: 'pointer'
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'var(--panel)',
      color: 'var(--text)',
      overflow: 'auto',
      zIndex: 1000
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '16px 24px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--panel-2)'
      }}>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>
          {t('manualAdjustmentsEditor.title', 'Manual Adjustments')}
        </h1>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={onClose}
            style={{
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 600,
              background: 'var(--panel)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || changes.length === 0}
            data-help-id="manual-save-button"
            style={{
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 600,
              background: changes.length > 0 ? 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)' : 'var(--panel)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              cursor: changes.length > 0 ? 'pointer' : 'not-allowed',
              opacity: saving ? 0.7 : 1
            }}
          >
            {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')} {changes.length > 0 && `(${changes.length})`}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex',
        gap: '4px',
        padding: '12px 24px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--panel-2)',
        flexWrap: 'wrap'
      }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            {...(tab.helpId ? { 'data-help-id': tab.helpId } : {})}
            style={{
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 600,
              background: activeTab === tab.id ? 'rgba(59, 130, 246, 0.3)' : 'transparent',
              color: activeTab === tab.id ? '#60a5fa' : 'var(--muted)',
              border: activeTab === tab.id ? '1px solid rgba(59, 130, 246, 0.5)' : '1px solid transparent',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto' }}>
        {/* ==================== SCORES TAB ==================== */}
        {activeTab === 'scores' && (
          <div>
            <h2 style={{ fontSize: '18px', marginBottom: '20px', color: 'var(--text)' }}>
              {t('manualAdjustmentsEditor.setScores', 'Set Scores')}
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {editedSets.map(set => (
                <div
                  key={set.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '80px 1fr 60px 1fr 100px',
                    gap: '12px',
                    alignItems: 'center',
                    ...cardStyle
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{t('common.setIndex', { index: set.index })}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ color: 'var(--muted)', minWidth: '80px' }}>
                      {editedHomeTeam?.name || t('common.home')}:
                    </span>
                    <input
                      type="number"
                      value={set.homePoints}
                      onChange={(e) => updateSetScore(set.id, 'homePoints', e.target.value)}
                      style={{ ...inputStyle, width: '80px', textAlign: 'center', fontWeight: 600 }}
                    />
                  </div>
                  <div style={{ textAlign: 'center', color: 'var(--muted)' }}>vs</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ color: 'var(--muted)', minWidth: '80px' }}>
                      {editedAwayTeam?.name || t('common.away')}:
                    </span>
                    <input
                      type="number"
                      value={set.awayPoints}
                      onChange={(e) => updateSetScore(set.id, 'awayPoints', e.target.value)}
                      style={{ ...inputStyle, width: '80px', textAlign: 'center', fontWeight: 600 }}
                    />
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={set.finished}
                      onChange={(e) => {
                        setEditedSets(prev => prev.map(s => {
                          if (s.id === set.id) {
                            const oldValue = s.finished
                            if (oldValue !== e.target.checked) {
                              recordChange('set', 'finished', oldValue, e.target.checked, `Set ${s.index} finished: ${oldValue} → ${e.target.checked}`)
                            }
                            return { ...s, finished: e.target.checked }
                          }
                          return s
                        }))
                      }}
                      style={{ width: '18px', height: '18px' }}
                    />
                    <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('manualAdjustmentsEditor.finished', 'Finished')}</span>
                  </label>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ==================== TEAMS & PLAYERS TAB ==================== */}
        {activeTab === 'teams' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
              {/* Home Team */}
              <div>
                {/* Team Info */}
                <div style={cardStyle}>
                  <h2 style={{ fontSize: '16px', marginBottom: '16px', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ width: '24px', height: '24px', borderRadius: '50%', background: editedHomeTeam?.color || '#888', display: 'inline-block' }} />
                    {t('manualAdjustmentsEditor.teamAHome', 'Team A (Home)')}
                  </h2>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div>
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.name', 'Name')}</label>
                      <input
                        type="text"
                        value={editedHomeTeam?.name || ''}
                        onChange={(e) => updateTeam('name', e.target.value, true)}
                        style={{ ...inputStyle, width: '100%' }}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.shortNameMax8', 'Short Name (max 8)')}</label>
                      <input
                        type="text"
                        maxLength={8}
                        value={editedHomeTeam?.shortName || ''}
                        onChange={(e) => updateTeam('shortName', e.target.value.toUpperCase(), true)}
                        style={{ ...inputStyle, width: '100%' }}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.color', 'Color')}</label>
                      <select
                        value={editedHomeTeam?.color || '#3b82f6'}
                        onChange={(e) => updateTeam('color', e.target.value, true)}
                        style={{ ...inputStyle, width: '100%', background: 'var(--panel)' }}
                      >
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
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.swapTeams', 'Swap Teams')}</label>
                      <button onClick={swapTeamDesignation} style={buttonStyle}>{t('manualAdjustmentsEditor.swapAB', 'Swap A/B')}</button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Away Team */}
              <div>
                {/* Team Info */}
                <div style={cardStyle}>
                  <h2 style={{ fontSize: '16px', marginBottom: '16px', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ width: '24px', height: '24px', borderRadius: '50%', background: editedAwayTeam?.color || '#888', display: 'inline-block' }} />
                    {t('manualAdjustmentsEditor.teamBAway', 'Team B (Away)')}
                  </h2>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div>
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.name', 'Name')}</label>
                      <input
                        type="text"
                        value={editedAwayTeam?.name || ''}
                        onChange={(e) => updateTeam('name', e.target.value, false)}
                        style={{ ...inputStyle, width: '100%' }}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.shortNameMax8', 'Short Name (max 8)')}</label>
                      <input
                        type="text"
                        maxLength={8}
                        value={editedAwayTeam?.shortName || ''}
                        onChange={(e) => updateTeam('shortName', e.target.value.toUpperCase(), false)}
                        style={{ ...inputStyle, width: '100%' }}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>{t('manualAdjustmentsEditor.color', 'Color')}</label>
                      <select
                        value={editedAwayTeam?.color || '#ef4444'}
                        onChange={(e) => updateTeam('color', e.target.value, false)}
                        style={{ ...inputStyle, width: '100%', background: 'var(--panel)' }}
                      >
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

        {/* ==================== TIMEOUTS & SUBS TAB ==================== */}
        {activeTab === 'events' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
            {/* Timeouts Section */}
            <div style={cardStyle}>
              <h2 style={{ fontSize: '16px', marginBottom: '16px', color: 'var(--text)' }}>
                {t('manualAdjustmentsEditor.timeouts', 'Timeouts')} ({timeoutEvents.length})
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '400px', overflowY: 'auto' }}>
                {timeoutEvents.map(event => (
                  <div key={event.id} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 40px', gap: '8px', alignItems: 'center', padding: '8px', background: 'rgba(251, 191, 36, 0.1)', borderRadius: '4px' }}>
                    <span style={{ fontSize: '13px' }}>{t('common.setIndex', { index: event.setIndex })}</span>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>{event.payload?.team === 'home' ? editedHomeTeam?.name || t('common.home') : editedAwayTeam?.name || t('common.away')}</span>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                      {event.stateSnapshot?.pointsA ?? event.stateSnapshot?.scoreA ?? 0}-{event.stateSnapshot?.pointsB ?? event.stateSnapshot?.scoreB ?? 0}
                    </span>
                    <button onClick={() => deleteEvent(event.id)} style={{ ...deleteButtonStyle, padding: '4px 8px' }}>×</button>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
                <button onClick={() => setShowAddTimeout(true)} style={{ ...buttonStyle, background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', color: '#fff', border: 'none' }}>
                  {t('manualAdjustmentsEditor.addTimeout', '+ Add Timeout')}
                </button>
              </div>
            </div>

            {/* Substitutions Section */}
            <div style={cardStyle}>
              <h2 style={{ fontSize: '16px', marginBottom: '16px', color: 'var(--text)' }}>
                {t('manualAdjustmentsEditor.substitutions', 'Substitutions')} ({substitutionEvents.length})
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '400px', overflowY: 'auto' }}>
                {substitutionEvents.map(event => (
                  <div
                    key={event.id}
                    style={{ display: 'grid', gridTemplateColumns: '80px 1fr 120px 80px 40px 40px', gap: '8px', alignItems: 'center', padding: '8px', background: 'rgba(59, 130, 246, 0.1)', borderRadius: '4px', cursor: 'pointer' }}
                    onClick={() => setEditingSub({ ...event, playerOut: event.payload?.playerOut, playerIn: event.payload?.playerIn, scoreA: event.stateSnapshot?.pointsA ?? event.stateSnapshot?.scoreA ?? 0, scoreB: event.stateSnapshot?.pointsB ?? event.stateSnapshot?.scoreB ?? 0 })}
                  >
                    <span style={{ fontSize: '13px' }}>{t('common.setIndex', { index: event.setIndex })}</span>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>{event.payload?.team === 'home' ? editedHomeTeam?.name || t('common.home') : editedAwayTeam?.name || t('common.away')}</span>
                    <span style={{ fontSize: '13px' }}>
                      #{event.payload?.playerOut} → #{event.payload?.playerIn}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                      {event.stateSnapshot?.pointsA ?? event.stateSnapshot?.scoreA ?? 0}-{event.stateSnapshot?.pointsB ?? event.stateSnapshot?.scoreB ?? 0}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); setEditingSub({ ...event, playerOut: event.payload?.playerOut, playerIn: event.payload?.playerIn, scoreA: event.stateSnapshot?.pointsA ?? event.stateSnapshot?.scoreA ?? 0, scoreB: event.stateSnapshot?.pointsB ?? event.stateSnapshot?.scoreB ?? 0 }) }} style={{ ...buttonStyle, padding: '4px 8px', fontSize: '10px' }}>{t('manualAdjustmentsEditor.edit', 'Edit')}</button>
                    <button onClick={(e) => { e.stopPropagation(); deleteEvent(event.id) }} style={{ ...deleteButtonStyle, padding: '4px 8px' }}>×</button>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
                <button onClick={() => setShowAddSub(true)} style={{ ...buttonStyle, background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', color: '#fff', border: 'none' }}>
                  {t('manualAdjustmentsEditor.addSubstitution', '+ Add Substitution')}
                </button>
              </div>
            </div>

            {/* Sanctions Section */}
            <div style={{ ...cardStyle, gridColumn: 'span 2' }}>
              <h2 style={{ fontSize: '16px', marginBottom: '16px', color: 'var(--text)' }}>
                {t('manualAdjustmentsEditor.allSanctions', 'All Sanctions')} ({sanctionEvents.length})
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
                {sanctionEvents.map(event => (
                  <div
                    key={event.id}
                    style={{ display: 'grid', gridTemplateColumns: '80px 80px 120px 100px 100px 1fr 40px 40px', gap: '8px', alignItems: 'center', padding: '8px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '4px', cursor: 'pointer' }}
                    onClick={() => setEditingSanction({ ...event, type: event.payload?.sanctionType || event.payload?.type, scoreA: event.stateSnapshot?.pointsA ?? event.stateSnapshot?.scoreA ?? 0, scoreB: event.stateSnapshot?.pointsB ?? event.stateSnapshot?.scoreB ?? 0 })}
                  >
                    <span style={{ fontSize: '13px' }}>{t('common.setIndex', { index: event.setIndex })}</span>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>{event.payload?.team === 'home' ? editedHomeTeam?.name || t('common.home') : editedAwayTeam?.name || t('common.away')}</span>
                    <span style={{ fontSize: '13px', textTransform: 'capitalize', color: '#ef4444' }}>
                      {event.payload?.sanctionType || event.payload?.type}
                    </span>
                    <span style={{ fontSize: '13px' }}>
                      {event.payload?.playerType}: #{event.payload?.playerNumber}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                      Score: {event.stateSnapshot?.pointsA ?? event.stateSnapshot?.scoreA ?? 0}-{event.stateSnapshot?.pointsB ?? event.stateSnapshot?.scoreB ?? 0}
                    </span>
                    <span />
                    <button onClick={(e) => { e.stopPropagation(); setEditingSanction({ ...event, type: event.payload?.sanctionType || event.payload?.type, scoreA: event.stateSnapshot?.pointsA ?? event.stateSnapshot?.scoreA ?? 0, scoreB: event.stateSnapshot?.pointsB ?? event.stateSnapshot?.scoreB ?? 0 }) }} style={{ ...buttonStyle, padding: '4px 8px', fontSize: '10px' }}>{t('manualAdjustmentsEditor.edit', 'Edit')}</button>
                    <button onClick={(e) => { e.stopPropagation(); deleteEvent(event.id) }} style={{ ...deleteButtonStyle, padding: '4px 8px' }}>×</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ==================== MATCH INFO TAB ==================== */}
        {activeTab === 'info' && editedMatch && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
            {/* Match Details */}
            <div style={cardStyle}>
              <h2 style={{ fontSize: '16px', marginBottom: '16px', color: 'var(--text)' }}>
                {t('manualAdjustmentsEditor.matchDetails', 'Match Details')}
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.hall', 'Hall')}</label>
                  <input
                    type="text"
                    value={editedMatch.hall || ''}
                    onChange={(e) => updateMatchInfo('hall', e.target.value)}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.city', 'City')}</label>
                  <input
                    type="text"
                    value={editedMatch.city || ''}
                    onChange={(e) => updateMatchInfo('city', e.target.value)}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.league', 'League')}</label>
                  <input
                    type="text"
                    value={editedMatch.league || ''}
                    onChange={(e) => updateMatchInfo('league', e.target.value)}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.championshipType', 'Championship Type')}</label>
                  <input
                    type="text"
                    value={editedMatch.championshipType || ''}
                    onChange={(e) => updateMatchInfo('championshipType', e.target.value)}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.gameNumber', 'Game Number')}</label>
                  <input
                    type="text"
                    value={editedMatch.gameN || editedMatch.gameNumber || ''}
                    onChange={(e) => updateMatchInfo('gameN', e.target.value)}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.status', 'Status')}</label>
                  <select
                    value={editedMatch.status || 'ended'}
                    onChange={(e) => updateMatchInfo('status', e.target.value)}
                    style={{ ...inputStyle, width: '100%' }}
                  >
                    <option value="setup">{t('manualAdjustmentsEditor.statusSetup', 'Setup')}</option>
                    <option value="live">{t('manualAdjustmentsEditor.statusLive', 'Live')}</option>
                    <option value="ended">{t('manualAdjustmentsEditor.statusEnded', 'Ended')}</option>
                    <option value="approved">{t('manualAdjustmentsEditor.statusApproved', 'Approved')}</option>
                    <option value="final">{t('manualAdjustmentsEditor.statusFinal', 'Final')}</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.matchTypeGender', 'Match Type (Gender)')}</label>
                  <select
                    value={editedMatch.match_type_2 || 'M'}
                    onChange={(e) => updateMatchInfo('match_type_2', e.target.value)}
                    style={{ ...inputStyle, width: '100%' }}
                  >
                    <option value="M">{t('manualAdjustmentsEditor.genderMen', 'Men')}</option>
                    <option value="W">{t('manualAdjustmentsEditor.genderWomen', 'Women')}</option>
                    <option value="X">{t('manualAdjustmentsEditor.genderMixed', 'Mixed')}</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>{t('manualAdjustmentsEditor.scheduledDateTime', 'Scheduled Date/Time')}</label>
                  <input
                    type="datetime-local"
                    value={editedMatch.scheduledAt ? new Date(editedMatch.scheduledAt).toISOString().slice(0, 16) : ''}
                    onChange={(e) => updateMatchInfo('scheduledAt', e.target.value ? new Date(e.target.value).toISOString() : null)}
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
              </div>
            </div>

            {/* Match Officials */}
            <div style={cardStyle}>
              <h2 style={{ fontSize: '16px', marginBottom: '16px', color: 'var(--text)' }}>
                {t('manualAdjustmentsEditor.matchOfficials', 'Match Officials')}
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* 1st Referee */}
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--muted)' }}>{t('manualAdjustmentsEditor.firstReferee', '1st Referee')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 100px', gap: '8px' }}>
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.firstName', 'First Name')}
                      value={editedOfficials.ref1.firstName}
                      onChange={(e) => updateOfficial('ref1', 'firstName', e.target.value)}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.lastName', 'Last Name')}
                      value={editedOfficials.ref1.lastName}
                      onChange={(e) => updateOfficial('ref1', 'lastName', e.target.value)}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.country', 'Country')}
                      value={editedOfficials.ref1.country}
                      onChange={(e) => updateOfficial('ref1', 'country', e.target.value)}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="date"
                      value={toISODate(editedOfficials.ref1.dob)}
                      onChange={(e) => updateOfficial('ref1', 'dob', e.target.value)}
                      style={{ ...inputStyle, padding: '4px', fontSize: '11px' }}
                    />
                  </div>
                </div>

                {/* 2nd Referee */}
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--muted)' }}>{t('manualAdjustmentsEditor.secondReferee', '2nd Referee')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 100px', gap: '8px' }}>
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.firstName', 'First Name')}
                      value={editedOfficials.ref2.firstName}
                      onChange={(e) => updateOfficial('ref2', 'firstName', e.target.value)}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.lastName', 'Last Name')}
                      value={editedOfficials.ref2.lastName}
                      onChange={(e) => updateOfficial('ref2', 'lastName', e.target.value)}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.country', 'Country')}
                      value={editedOfficials.ref2.country}
                      onChange={(e) => updateOfficial('ref2', 'country', e.target.value)}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="date"
                      value={toISODate(editedOfficials.ref2.dob)}
                      onChange={(e) => updateOfficial('ref2', 'dob', e.target.value)}
                      style={{ ...inputStyle, padding: '4px', fontSize: '11px' }}
                    />
                  </div>
                </div>

                {/* Scorer */}
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--muted)' }}>{t('manualAdjustmentsEditor.scorer', 'Scorer')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px', gap: '8px' }}>
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.firstName', 'First Name')}
                      value={editedOfficials.scorer.firstName}
                      onChange={(e) => updateOfficial('scorer', 'firstName', e.target.value)}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.lastName', 'Last Name')}
                      value={editedOfficials.scorer.lastName}
                      onChange={(e) => updateOfficial('scorer', 'lastName', e.target.value)}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="date"
                      value={toISODate(editedOfficials.scorer.dob)}
                      onChange={(e) => updateOfficial('scorer', 'dob', e.target.value)}
                      style={{ ...inputStyle, padding: '4px', fontSize: '11px' }}
                    />
                  </div>
                </div>

                {/* Assistant Scorer */}
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--muted)' }}>{t('manualAdjustmentsEditor.assistantScorer', 'Assistant Scorer')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px', gap: '8px' }}>
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.firstName', 'First Name')}
                      value={editedOfficials.asstScorer.firstName}
                      onChange={(e) => updateOfficial('asstScorer', 'firstName', e.target.value)}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      placeholder={t('manualAdjustmentsEditor.lastName', 'Last Name')}
                      value={editedOfficials.asstScorer.lastName}
                      onChange={(e) => updateOfficial('asstScorer', 'lastName', e.target.value)}
                      style={{ ...inputStyle, padding: '6px 8px' }}
                    />
                    <input
                      type="date"
                      value={toISODate(editedOfficials.asstScorer.dob)}
                      onChange={(e) => updateOfficial('asstScorer', 'dob', e.target.value)}
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
          <div style={{ marginTop: '32px', padding: '16px', background: 'rgba(251, 191, 36, 0.1)', borderRadius: '8px', border: '1px solid rgba(251, 191, 36, 0.3)' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: '#fbbf24' }}>
              {t('manualAdjustmentsEditor.pendingChanges', 'Pending Changes')} ({changes.length})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '150px', overflowY: 'auto' }}>
              {changes.map((change, i) => (
                <div key={i} style={{ fontSize: '12px', color: 'var(--muted)' }}>
                  • {change.description}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Add Sanction Modal */}
      {showAddSanction && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(15, 23, 42, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000
        }}>
          <div style={{
            background: 'var(--panel)',
            borderRadius: '12px',
            padding: '24px',
            minWidth: '400px',
            border: '1px solid var(--border)'
          }}>
            <h3 style={{ margin: '0 0 20px 0', fontSize: '18px', color: 'var(--text)' }}>
              {t('manualAdjustmentsEditor.addSanction', 'Add Sanction')}
            </h3>
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: '4px' }}>
                {t('manualAdjustmentsEditor.target', 'Target')}: {showAddSanction.team === 'home' ? editedHomeTeam?.name : editedAwayTeam?.name}
                {showAddSanction.playerType === 'player' && ` - ${t('manualAdjustmentsEditor.player', 'Player')} #${showAddSanction.playerNumber}`}
                {showAddSanction.playerType === 'bench_official' && ` - ${showAddSanction.role}`}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.sanctionType', 'Sanction Type')}</label>
                <select
                  value={newSanctionData.type}
                  onChange={(e) => setNewSanctionData(prev => ({ ...prev, type: e.target.value }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  <option value="warning">{t('manualAdjustmentsEditor.warningYellow', 'Warning (Yellow)')}</option>
                  <option value="penalty">{t('manualAdjustmentsEditor.penaltyRed', 'Penalty (Red)')}</option>
                  <option value="expulsion">{t('manualAdjustmentsEditor.expulsionRedYellow', 'Expulsion (Red+Yellow)')}</option>
                  <option value="disqualification">{t('manualAdjustmentsEditor.disqualificationRedYellow', 'Disqualification (Red+Yellow)')}</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.set', 'Set')}</label>
                <select
                  value={newSanctionData.setIndex}
                  onChange={(e) => setNewSanctionData(prev => ({ ...prev, setIndex: parseInt(e.target.value, 10) }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  {editedSets.map(s => (
                    <option key={s.index} value={s.index}>{t('common.setIndex', { index: s.index })}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.scoreA', 'Score A')}</label>
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={newSanctionData.scoreA}
                  onChange={(e) => setNewSanctionData(prev => ({ ...prev, scoreA: parseInt(e.target.value, 10) || 0 }))}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.scoreB', 'Score B')}</label>
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={newSanctionData.scoreB}
                  onChange={(e) => setNewSanctionData(prev => ({ ...prev, scoreB: parseInt(e.target.value, 10) || 0 }))}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowAddSanction(null)
                  setNewSanctionData({ type: 'warning', setIndex: 1, scoreA: 0, scoreB: 0 })
                }}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleAddSanctionSubmit}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                {t('manualAdjustmentsEditor.addSanction', 'Add Sanction')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Sanction Modal */}
      {editingSanction && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(15, 23, 42, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000
        }}>
          <div style={{
            background: 'var(--panel)',
            borderRadius: '12px',
            padding: '24px',
            minWidth: '400px',
            border: '1px solid var(--border)'
          }}>
            <h3 style={{ margin: '0 0 20px 0', fontSize: '18px', color: 'var(--text)' }}>
              {t('manualAdjustmentsEditor.editSanction', 'Edit Sanction')}
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.sanctionType', 'Sanction Type')}</label>
                <select
                  value={editingSanction.type || 'warning'}
                  onChange={(e) => setEditingSanction(prev => ({ ...prev, type: e.target.value }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  <option value="warning">{t('manualAdjustmentsEditor.warningYellow', 'Warning (Yellow)')}</option>
                  <option value="penalty">{t('manualAdjustmentsEditor.penaltyRed', 'Penalty (Red)')}</option>
                  <option value="expulsion">{t('manualAdjustmentsEditor.expulsionRedYellow', 'Expulsion (Red+Yellow)')}</option>
                  <option value="disqualification">{t('manualAdjustmentsEditor.disqualificationRedYellow', 'Disqualification (Red+Yellow)')}</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.set', 'Set')}</label>
                <select
                  value={editingSanction.setIndex}
                  onChange={(e) => setEditingSanction(prev => ({ ...prev, setIndex: parseInt(e.target.value, 10) }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  {editedSets.map(s => (
                    <option key={s.index} value={s.index}>{t('common.setIndex', { index: s.index })}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.scoreA', 'Score A')}</label>
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={editingSanction.scoreA || 0}
                  onChange={(e) => setEditingSanction(prev => ({ ...prev, scoreA: parseInt(e.target.value, 10) || 0 }))}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.scoreB', 'Score B')}</label>
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={editingSanction.scoreB || 0}
                  onChange={(e) => setEditingSanction(prev => ({ ...prev, scoreB: parseInt(e.target.value, 10) || 0 }))}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setEditingSanction(null)}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleEditSanctionSubmit}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                {t('manualAdjustmentsEditor.saveChanges', 'Save Changes')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Timeout Modal */}
      {showAddTimeout && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(15, 23, 42, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000
        }}>
          <div style={{
            background: 'var(--panel)',
            borderRadius: '12px',
            padding: '24px',
            minWidth: '400px',
            border: '1px solid var(--border)'
          }}>
            <h3 style={{ margin: '0 0 20px 0', fontSize: '18px', color: 'var(--text)' }}>
              {t('manualAdjustmentsEditor.addTimeoutTitle', 'Add Timeout')}
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.team', 'Team')}</label>
                <select
                  value={newTimeoutData.team}
                  onChange={(e) => setNewTimeoutData(prev => ({ ...prev, team: e.target.value }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  <option value="home">{editedHomeTeam?.name || t('common.home')}</option>
                  <option value="away">{editedAwayTeam?.name || t('common.away')}</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.set', 'Set')}</label>
                <select
                  value={newTimeoutData.setIndex}
                  onChange={(e) => setNewTimeoutData(prev => ({ ...prev, setIndex: parseInt(e.target.value, 10) }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  {editedSets.map(s => (
                    <option key={s.index} value={s.index}>{t('common.setIndex', { index: s.index })}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.scoreA', 'Score A')}</label>
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={newTimeoutData.scoreA}
                  onChange={(e) => setNewTimeoutData(prev => ({ ...prev, scoreA: parseInt(e.target.value, 10) || 0 }))}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.scoreB', 'Score B')}</label>
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={newTimeoutData.scoreB}
                  onChange={(e) => setNewTimeoutData(prev => ({ ...prev, scoreB: parseInt(e.target.value, 10) || 0 }))}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowAddTimeout(false)
                  setNewTimeoutData({ team: 'home', setIndex: 1, scoreA: 0, scoreB: 0 })
                }}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleAddTimeoutSubmit}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  background: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                {t('manualAdjustmentsEditor.addTimeoutTitle', 'Add Timeout')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Substitution Modal */}
      {showAddSub && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(15, 23, 42, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000
        }}>
          <div style={{
            background: 'var(--panel)',
            borderRadius: '12px',
            padding: '24px',
            minWidth: '450px',
            border: '1px solid var(--border)'
          }}>
            <h3 style={{ margin: '0 0 20px 0', fontSize: '18px', color: 'var(--text)' }}>
              {t('manualAdjustmentsEditor.addSubstitutionTitle', 'Add Substitution')}
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.team', 'Team')}</label>
                <select
                  value={newSubData.team}
                  onChange={(e) => setNewSubData(prev => ({ ...prev, team: e.target.value, playerOut: '', playerIn: '' }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  <option value="home">{editedHomeTeam?.name || t('common.home')}</option>
                  <option value="away">{editedAwayTeam?.name || t('common.away')}</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.set', 'Set')}</label>
                <select
                  value={newSubData.setIndex}
                  onChange={(e) => setNewSubData(prev => ({ ...prev, setIndex: parseInt(e.target.value, 10) }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  {editedSets.map(s => (
                    <option key={s.index} value={s.index}>{t('common.setIndex', { index: s.index })}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.playerOut', 'Player Out')}</label>
                <select
                  value={newSubData.playerOut}
                  onChange={(e) => setNewSubData(prev => ({ ...prev, playerOut: e.target.value }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  <option value="">Select player...</option>
                  {(newSubData.team === 'home' ? editedHomePlayers : editedAwayPlayers).map(p => (
                    <option key={p.id} value={p.number}>#{p.number} - {p.firstName} {p.lastName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.playerIn', 'Player In')}</label>
                <select
                  value={newSubData.playerIn}
                  onChange={(e) => setNewSubData(prev => ({ ...prev, playerIn: e.target.value }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  <option value="">Select player...</option>
                  {(newSubData.team === 'home' ? editedHomePlayers : editedAwayPlayers).map(p => (
                    <option key={p.id} value={p.number}>#{p.number} - {p.firstName} {p.lastName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.scoreA', 'Score A')}</label>
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={newSubData.scoreA}
                  onChange={(e) => setNewSubData(prev => ({ ...prev, scoreA: parseInt(e.target.value, 10) || 0 }))}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.scoreB', 'Score B')}</label>
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={newSubData.scoreB}
                  onChange={(e) => setNewSubData(prev => ({ ...prev, scoreB: parseInt(e.target.value, 10) || 0 }))}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowAddSub(false)
                  setNewSubData({ team: 'home', setIndex: 1, playerOut: '', playerIn: '', scoreA: 0, scoreB: 0 })
                }}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleAddSubSubmit}
                disabled={!newSubData.playerOut || !newSubData.playerIn}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  background: !newSubData.playerOut || !newSubData.playerIn
                    ? 'rgba(34, 197, 94, 0.3)'
                    : 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: !newSubData.playerOut || !newSubData.playerIn ? 'not-allowed' : 'pointer',
                  opacity: !newSubData.playerOut || !newSubData.playerIn ? 0.6 : 1
                }}
              >
                {t('manualAdjustmentsEditor.addSubstitutionTitle', 'Add Substitution')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Substitution Modal */}
      {editingSub && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(15, 23, 42, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000
        }}>
          <div style={{
            background: 'var(--panel)',
            borderRadius: '12px',
            padding: '24px',
            minWidth: '450px',
            border: '1px solid var(--border)'
          }}>
            <h3 style={{ margin: '0 0 20px 0', fontSize: '18px', color: 'var(--text)' }}>
              {t('manualAdjustmentsEditor.editSubstitutionTitle', 'Edit Substitution')}
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.team', 'Team')}</label>
                <div style={{ ...inputStyle, padding: '8px 12px', background: 'var(--panel-2)' }}>
                  {editingSub.payload?.team === 'home' ? editedHomeTeam?.name : editedAwayTeam?.name}
                </div>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.set', 'Set')}</label>
                <select
                  value={editingSub.setIndex}
                  onChange={(e) => setEditingSub(prev => ({ ...prev, setIndex: parseInt(e.target.value, 10) }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  {editedSets.map(s => (
                    <option key={s.index} value={s.index}>{t('common.setIndex', { index: s.index })}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.playerOut', 'Player Out')}</label>
                <select
                  value={editingSub.playerOut || editingSub.payload?.playerOut || ''}
                  onChange={(e) => setEditingSub(prev => ({ ...prev, playerOut: e.target.value }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  <option value="">Select player...</option>
                  {(editingSub.payload?.team === 'home' ? editedHomePlayers : editedAwayPlayers).map(p => (
                    <option key={p.id} value={p.number}>#{p.number} - {p.firstName} {p.lastName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.playerIn', 'Player In')}</label>
                <select
                  value={editingSub.playerIn || editingSub.payload?.playerIn || ''}
                  onChange={(e) => setEditingSub(prev => ({ ...prev, playerIn: e.target.value }))}
                  style={{ ...inputStyle, width: '100%' }}
                >
                  <option value="">Select player...</option>
                  {(editingSub.payload?.team === 'home' ? editedHomePlayers : editedAwayPlayers).map(p => (
                    <option key={p.id} value={p.number}>#{p.number} - {p.firstName} {p.lastName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.scoreA', 'Score A')}</label>
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={editingSub.scoreA ?? editingSub.stateSnapshot?.pointsA ?? editingSub.stateSnapshot?.scoreA ?? 0}
                  onChange={(e) => setEditingSub(prev => ({ ...prev, scoreA: parseInt(e.target.value, 10) || 0 }))}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
              <div>
                <label style={labelStyle}>{t('manualAdjustmentsEditor.scoreB', 'Score B')}</label>
                <input
                  type="number"
                  min="0"
                  max="99"
                  value={editingSub.scoreB ?? editingSub.stateSnapshot?.pointsB ?? editingSub.stateSnapshot?.scoreB ?? 0}
                  onChange={(e) => setEditingSub(prev => ({ ...prev, scoreB: parseInt(e.target.value, 10) || 0 }))}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setEditingSub(null)}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleEditSubSubmit}
                style={{
                  padding: '10px 20px',
                  fontSize: '14px',
                  background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                {t('manualAdjustmentsEditor.saveChanges', 'Save Changes')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
