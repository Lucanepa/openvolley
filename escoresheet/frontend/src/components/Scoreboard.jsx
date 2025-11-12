import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import Modal from './Modal'
import { useSyncQueue } from '../hooks/useSyncQueue'
import mikasaVolleyball from '../mikasa_v200w.png'

export default function Scoreboard({ matchId, onFinishSet, onOpenSetup, onOpenMatchSetup, onOpenCoinToss }) {
  const { syncStatus } = useSyncQueue()
  const [now, setNow] = useState(() => new Date())
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )
  const [showLogs, setShowLogs] = useState(false)
  const [showManualPanel, setShowManualPanel] = useState(false)
  const [showRemarks, setShowRemarks] = useState(false)
  const [showRosters, setShowRosters] = useState(false)
  const [showSanctions, setShowSanctions] = useState(false)
  const [timeoutModal, setTimeoutModal] = useState(null) // { team: 'home'|'away', countdown: number, started: boolean }
  const [lineupModal, setLineupModal] = useState(null) // { team: 'home'|'away', mode?: 'initial'|'manual' } | null
  const [setEndModal, setSetEndModal] = useState(null) // { set, homePoints, awayPoints } | null
  const [substitutionDropdown, setSubstitutionDropdown] = useState(null) // { team: 'home'|'away', position: 'I'|'II'|'III'|'IV'|'V'|'VI', playerNumber: number, element: HTMLElement } | null
  const [substitutionConfirm, setSubstitutionConfirm] = useState(null) // { team: 'home'|'away', position: 'I'|'II'|'III'|'IV'|'V'|'VI', playerOut: number, playerIn: number } | null
  const [liberoDropdown, setLiberoDropdown] = useState(null) // { team: 'home'|'away', position: 'I'|'V'|'VI', playerNumber: number, element: HTMLElement } | null
  const [liberoConfirm, setLiberoConfirm] = useState(null) // { team: 'home'|'away', position: 'I'|'V'|'VI', playerOut: number, liberoIn: string } | null
  const [undoConfirm, setUndoConfirm] = useState(null) // { event: Event, description: string } | null
  const [liberoReminder, setLiberoReminder] = useState(null) // { teams: ['home'|'away'] } | null - Show reminder at start of set
  const [liberoRotationModal, setLiberoRotationModal] = useState(null) // { team: 'home'|'away', position: 'IV', liberoNumber: number, playerNumber: number } | null
  const [exchangeLiberoDropdown, setExchangeLiberoDropdown] = useState(null) // { team: 'home'|'away', position: 'I'|'V'|'VI', liberoNumber: number, element: HTMLElement } | null
  const [liberoReentryModal, setLiberoReentryModal] = useState(null) // { team: 'home'|'away', position: 'I', playerNumber: number, liberoNumber: number, liberoType: string } | null
  const [setStartTimeModal, setSetStartTimeModal] = useState(null) // { setIndex: number, defaultTime: string } | null
  const [setEndTimeModal, setSetEndTimeModal] = useState(null) // { setIndex: number, winner: string, homePoints: number, awayPoints: number, defaultTime: string } | null
  const [sanctionConfirm, setSanctionConfirm] = useState(null) // { side: 'left'|'right', type: 'improper_request'|'delay_warning'|'delay_penalty' } | null

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])


  const data = useLiveQuery(async () => {
    const match = await db.matches.get(matchId)
    if (!match) return null

    const [homeTeam, awayTeam] = await Promise.all([
      match?.homeTeamId ? db.teams.get(match.homeTeamId) : null,
      match?.awayTeamId ? db.teams.get(match.awayTeamId) : null
    ])

    const sets = await db.sets
      .where('matchId')
      .equals(matchId)
      .sortBy('index')

    const currentSet =
      sets.find(s => !s.finished) ??
      null

    const [homePlayers, awayPlayers] = await Promise.all([
      match?.homeTeamId
        ? db.players.where('teamId').equals(match.homeTeamId).sortBy('number')
        : [],
      match?.awayTeamId
        ? db.players.where('teamId').equals(match.awayTeamId).sortBy('number')
        : []
    ])

    // Get all events for the match (keep logs across sets)
    const events = await db.events
      .where('matchId')
      .equals(matchId)
      .sortBy('ts')

    const result = {
      set: currentSet,
      match,
      homeTeam,
      awayTeam,
      homePlayers,
      awayPlayers,
      events,
      sets
    }
    
    return result
  }, [matchId])

  const ensuringSetRef = useRef(false)

  const ensureActiveSet = useCallback(async () => {
    if (!matchId) return
    const existing = await db.sets
      .where('matchId')
      .equals(matchId)
      .and(s => !s.finished)
      .first()

    if (existing) return

    const allSets = await db.sets
      .where('matchId')
      .equals(matchId)
      .sortBy('index')

    const nextIndex =
      allSets.length > 0
        ? Math.max(...allSets.map(s => s.index || 0)) + 1
        : 1

    const setId = await db.sets.add({
      matchId,
      index: nextIndex,
      homePoints: 0,
      awayPoints: 0,
      finished: false
    })
    
    // Get match to check if it's a test match
    const match = await db.matches.get(matchId)
    const isTest = match?.test || false
    
    await db.sync_queue.add({
      resource: 'set',
      action: 'insert',
      payload: {
        external_id: String(setId),
        match_id: match?.externalId || String(matchId),
        index: nextIndex,
        home_points: 0,
        away_points: 0,
        finished: false,
        test: isTest,
        created_at: new Date().toISOString()
      },
      ts: new Date().toISOString(),
      status: 'queued'
    })
  }, [matchId])

  useEffect(() => {
    if (!matchId || !data || data.set || ensuringSetRef.current) return
    ensuringSetRef.current = true
    ensureActiveSet()
      .catch(err => {
        console.error('Failed to ensure an active set exists', err)
      })
      .finally(() => {
        ensuringSetRef.current = false
      })
  }, [data, ensureActiveSet, matchId])

  // Determine which team is A and which is B based on coin toss
  const teamAKey = useMemo(() => {
    if (!data?.match) return 'home'
    return data.match.coinTossTeamA || 'home'
  }, [data?.match])
  
  const teamBKey = useMemo(() => {
    if (!data?.match) return 'away'
    return data.match.coinTossTeamB || 'away'
  }, [data?.match])

  const leftIsHome = useMemo(() => {
    if (!data?.set) return true
    // In set 1, Team A is always on the left
    // In subsequent sets, teams switch sides
    if (data.set.index === 1) {
      // Set 1: Team A on left
      return teamAKey === 'home'
    } else {
      // Set 2+: Teams switch sides (Team A goes right, Team B goes left)
      return teamAKey !== 'home'
    }
  }, [data?.set, teamAKey])

  // Calculate set score (number of sets won by each team)
  const setScore = useMemo(() => {
    if (!data) return { home: 0, away: 0, left: 0, right: 0 }
    
    const allSets = data.allSets || []
    const finishedSets = allSets.filter(s => s.finished)
    
    const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
    const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length
    
    const leftSetsWon = leftIsHome ? homeSetsWon : awaySetsWon
    const rightSetsWon = leftIsHome ? awaySetsWon : homeSetsWon
    
    return { home: homeSetsWon, away: awaySetsWon, left: leftSetsWon, right: rightSetsWon }
  }, [data, leftIsHome])

  const mapSideToTeamKey = useCallback(
    side => {
      if (!data?.set) return 'home'
      if (side === 'left') {
        return leftIsHome ? 'home' : 'away'
      }
      return leftIsHome ? 'away' : 'home'
    },
    [data?.set, leftIsHome]
  )

  const pointsBySide = useMemo(() => {
    if (!data?.set) return { left: 0, right: 0 }
    return leftIsHome
      ? { left: data.set.homePoints, right: data.set.awayPoints }
      : { left: data.set.awayPoints, right: data.set.homePoints }
  }, [data?.set, leftIsHome])

  const timeoutsUsed = useMemo(() => {
    if (!data?.events || !data?.set) return { home: 0, away: 0 }
    // Only count timeouts for the current set
    return data.events
      .filter(event => event.type === 'timeout' && event.setIndex === data.set.index)
      .reduce(
        (acc, event) => {
          const team = event.payload?.team
          if (team === 'home' || team === 'away') {
            acc[team] = (acc[team] || 0) + 1
          }
          return acc
        },
        { home: 0, away: 0 }
      )
  }, [data?.events, data?.set])

  const substitutionsUsed = useMemo(() => {
    if (!data?.events || !data?.set) return { home: 0, away: 0 }
    // Only count substitutions for the current set
    return data.events
      .filter(event => event.type === 'substitution' && event.setIndex === data.set.index)
      .reduce(
        (acc, event) => {
          const team = event.payload?.team
          if (team === 'home' || team === 'away') {
            acc[team] = (acc[team] || 0) + 1
          }
          return acc
        },
        { home: 0, away: 0 }
      )
  }, [data?.events, data?.set])

  const rallyStatus = useMemo(() => {
    if (!data?.events || !data?.set || data.events.length === 0) return 'idle'
    // Get events for current set only
    const currentSetEvents = data.events.filter(e => e.setIndex === data.set.index)
    if (currentSetEvents.length === 0) return 'idle'
    const lastEvent = currentSetEvents[currentSetEvents.length - 1]
    console.log('[DEBUG] rallyStatus - last event:', lastEvent.type, 'timestamp:', lastEvent.ts)
    if (lastEvent.type === 'rally_start') {
      console.log('[DEBUG] rallyStatus -> in_play')
      return 'in_play'
    }
    if (lastEvent.type === 'point' || lastEvent.type === 'replay') {
      console.log('[DEBUG] rallyStatus -> idle (after point/replay)')
      return 'idle'
    }
    console.log('[DEBUG] rallyStatus -> idle (default)')
    return 'idle'
  }, [data?.events, data?.set])

  const isFirstRally = useMemo(() => {
    if (!data?.events || !data?.set) return true
    // Check if there are any points in the current set
    // This determines if we show "Start set" vs "Start rally"
    const hasPoints = data.events.some(e => e.type === 'point' && e.setIndex === data.set.index)
    return !hasPoints
  }, [data?.events, data?.set])

  const getTeamLineupState = useCallback((teamKey) => {
    if (!data?.events || !data?.set) {
      return {
        lineupEvents: [],
        currentLineup: null,
        playersOnCourt: [],
        positionLiberoMap: {},
        playerLiberoMap: {}
      }
    }

    const teamPlayers = teamKey === 'home' ? data?.homePlayers || [] : data?.awayPlayers || []

    const lineupEvents = data.events
      .filter(e =>
        e.type === 'lineup' &&
        e.payload?.team === teamKey &&
        e.setIndex === data.set.index
      )
      .sort((a, b) => new Date(a.ts) - new Date(b.ts))

    if (lineupEvents.length === 0) {
      return {
        lineupEvents,
        currentLineup: null,
        playersOnCourt: [],
        positionLiberoMap: {},
        playerLiberoMap: {}
      }
    }

    const currentLineup = lineupEvents[lineupEvents.length - 1]?.payload?.lineup || {}
    const playersOnCourt = Object.values(currentLineup)
      .map(num => Number(num))
      .filter(num => !Number.isNaN(num))

    const positionLiberoMap = {}
    const playerLiberoMap = {}

    const findLatestLiberoSubstitution = (position, liberoNumber) => {
      for (let i = lineupEvents.length - 1; i >= 0; i--) {
        const maybeSub = lineupEvents[i]?.payload?.liberoSubstitution
        if (
          maybeSub &&
          String(maybeSub.position) === String(position) &&
          String(maybeSub.liberoNumber) === String(liberoNumber)
        ) {
          return maybeSub
        }
      }
      return null
    }

    for (const [position, playerNumber] of Object.entries(currentLineup)) {
      const player = teamPlayers.find(p => String(p.number) === String(playerNumber))
      if (player?.libero && player.libero !== '') {
        const subInfo = findLatestLiberoSubstitution(position, playerNumber)
        const originalPlayerNumber = subInfo?.playerNumber ?? null

        positionLiberoMap[position] = {
          liberoNumber: Number(playerNumber),
          liberoType: player.libero,
          playerNumber: originalPlayerNumber
        }

        if (originalPlayerNumber !== null && originalPlayerNumber !== undefined) {
          playerLiberoMap[String(originalPlayerNumber)] = {
            liberoNumber: Number(playerNumber),
            liberoType: player.libero
          }
        }
      }
    }

    return {
      lineupEvents,
      currentLineup,
      playersOnCourt,
      positionLiberoMap,
      playerLiberoMap
    }
  }, [data?.events, data?.set, data?.homePlayers, data?.awayPlayers])

  const buildOnCourt = useCallback((players, isLeft, teamKey) => {
    const { currentLineup, positionLiberoMap } = getTeamLineupState(teamKey)

    // Check if there's a saved lineup for this team in the current set
    const savedLineup = currentLineup

    // Fixed positions:
    // Left team: Front row (0,1,2): IV, III, II | Back row (3,4,5): V, VI, I
    // Right team: Front row (0,1,2): II, III, IV | Back row (3,4,5): I, VI, V (I is top right)
    const leftPositions = ['IV', 'III', 'II', 'V', 'VI', 'I']
    const rightPositions = ['II', 'III', 'IV', 'I', 'VI', 'V']
    const fixedPositions = isLeft ? leftPositions : rightPositions

    // If it's the first rally and lineup hasn't been set, show empty players
    if (rallyStatus === 'idle' && isFirstRally && !savedLineup) {
      return Array(6).fill(null).map((_, idx) => {
        return {
          id: `placeholder-${idx}`,
          number: '',
          isPlaceholder: true,
          position: fixedPositions[idx],
          isCaptain: false
        }
      })
    }

    // If lineup is saved, use it to map players to fixed positions
    if (savedLineup) {
      // Ensure we only return exactly 6 players, using only the fixed positions
      const result = fixedPositions.slice(0, 6).map((pos, idx) => {
        const playerNumber = savedLineup[pos]
        // Convert both to strings for comparison to handle number/string mismatches
        const player = players?.find(p => String(p.number) === String(playerNumber))
        const isLibero = player?.libero && player.libero !== ''
        const liberoSub = positionLiberoMap[pos]

        return {
          id: player?.id ?? `placeholder-${idx}`,
          number: playerNumber || '',
          isPlaceholder: !playerNumber,
          position: pos, // Fixed position on court
          isCaptain: player?.isCaptain || false,
          isLibero: isLibero || !!liberoSub,
          substitutedPlayerNumber: liberoSub?.playerNumber || null,
          liberoType: liberoSub?.liberoType || (isLibero ? player.libero : null)
        }
      })

      // Safety check: ensure we return exactly 6 players
      if (result.length !== 6) {
        console.warn(`buildOnCourt returned ${result.length} players instead of 6 for team ${teamKey}`)
        // Pad or trim to exactly 6
        while (result.length < 6) {
          const idx = result.length
          result.push({
            id: `placeholder-${idx}`,
            number: '',
            isPlaceholder: true,
            position: fixedPositions[idx] || '',
            isCaptain: false
          })
        }
        return result.slice(0, 6)
      }

      return result
    }

    // Fallback: use default player list
    const trimmed = (players || []).slice(0, 6)
    const placeholders = Array.from({ length: 6 - trimmed.length }, (_, idx) => ({
      placeholder: true,
      number: `–`
    }))
    const allPlayers = [...trimmed, ...placeholders]

    return allPlayers.map((player, idx) => {
      const assignedPos = fixedPositions[idx]
      return {
        id: player.id ?? `placeholder-${idx}`,
        number:
          player.number !== undefined && player.number !== null
            ? player.number
            : player.placeholder
              ? '–'
              : '',
        isPlaceholder: !!player.placeholder,
        position: assignedPos,
        isCaptain: player.isCaptain || false
      }
    })
  }, [rallyStatus, isFirstRally, getTeamLineupState])

  const getCurrentLineup = useCallback(
    teamKey => {
      if (!data?.events || !data?.set) return null
      const lineupEvents = data.events
        .filter(
          e =>
            e.type === 'lineup' &&
            e.payload?.team === teamKey &&
            e.setIndex === data.set.index
        )
        .sort((a, b) => new Date(a.ts) - new Date(b.ts))

      if (lineupEvents.length === 0) return null
      return lineupEvents[lineupEvents.length - 1].payload?.lineup || null
    },
    [data?.events, data?.set]
  )

  const leftTeam = useMemo(() => {
    if (!data) return { name: 'Team A', color: '#ef4444', players: [] }
    const players = leftIsHome ? data.homePlayers : data.awayPlayers
    const team = leftIsHome ? data.homeTeam : data.awayTeam
    const teamKey = leftIsHome ? 'home' : 'away'
    const isTeamA = teamKey === teamAKey
    return {
      name: team?.name || (leftIsHome ? 'Home' : 'Away'),
      color: team?.color || (leftIsHome ? '#ef4444' : '#3b82f6'),
      playersOnCourt: buildOnCourt(players, true, teamKey),
      isTeamA
    }
  }, [buildOnCourt, data, leftIsHome, teamAKey])

  const rightTeam = useMemo(() => {
    if (!data) return { name: 'Team B', color: '#3b82f6', players: [] }
    const players = leftIsHome ? data.awayPlayers : data.homePlayers
    const team = leftIsHome ? data.awayTeam : data.homeTeam
    const teamKey = leftIsHome ? 'away' : 'home'
    const isTeamA = teamKey === teamAKey
    return {
      name: team?.name || (leftIsHome ? 'Away' : 'Home'),
      color: team?.color || (leftIsHome ? '#3b82f6' : '#ef4444'),
      playersOnCourt: buildOnCourt(players, false, teamKey),
      isTeamA
    }
  }, [buildOnCourt, data, leftIsHome, teamAKey])

  // Check if lineups are set for each team in the current set
  const leftTeamLineupSet = useMemo(() => {
    if (!data?.events || !data?.set) return false
    const teamKey = leftIsHome ? 'home' : 'away'
    return data.events.some(e => 
      e.type === 'lineup' && 
      e.payload?.team === teamKey && 
      e.setIndex === data.set.index &&
      e.payload?.isInitial
    )
  }, [data?.events, data?.set, leftIsHome])

  const rightTeamLineupSet = useMemo(() => {
    if (!data?.events || !data?.set) return false
    const teamKey = leftIsHome ? 'away' : 'home'
    return data.events.some(e => 
      e.type === 'lineup' && 
      e.payload?.team === teamKey && 
      e.setIndex === data.set.index &&
      e.payload?.isInitial
    )
  }, [data?.events, data?.set, leftIsHome])

  // Get bench players, liberos, and bench officials for each team
  const leftTeamBench = useMemo(() => {
    if (!data) return { benchPlayers: [], liberos: [], benchOfficials: [] }
    const teamKey = leftIsHome ? 'home' : 'away'
    const players = leftIsHome ? data.homePlayers : data.awayPlayers
    const benchOfficials = leftIsHome ? (data.match?.bench_home || []) : (data.match?.bench_away || [])

    const { playersOnCourt, playerLiberoMap } = getTeamLineupState(teamKey)
    const playersOnCourtSet = new Set(playersOnCourt.map(num => Number(num)))

    const benchPlayers = players
      .filter(p => {
        const playerNumber = Number(p.number)
        return !Number.isNaN(playerNumber) && !playersOnCourtSet.has(playerNumber) && (!p.libero || p.libero === '')
      })
      .map(p => {
        const playerNumber = Number(p.number)
        const substitutedInfo = playerLiberoMap[String(playerNumber)] || null
        return {
          ...p,
          substitutedByLibero: substitutedInfo
        }
      })

    const liberos = players
      .filter(p => {
        const playerNumber = Number(p.number)
        return p.libero && p.libero !== '' && !playersOnCourtSet.has(playerNumber)
      })
      .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0))

    return {
      benchPlayers,
      liberos,
      benchOfficials
    }
  }, [data, leftIsHome, getTeamLineupState])

  const rightTeamBench = useMemo(() => {
    if (!data) return { benchPlayers: [], liberos: [], benchOfficials: [] }
    const teamKey = leftIsHome ? 'away' : 'home'
    const players = leftIsHome ? data.awayPlayers : data.homePlayers
    const benchOfficials = leftIsHome ? (data.match?.bench_away || []) : (data.match?.bench_home || [])

    const { playersOnCourt, playerLiberoMap } = getTeamLineupState(teamKey)
    const playersOnCourtSet = new Set(playersOnCourt.map(num => Number(num)))

    const benchPlayers = players
      .filter(p => {
        const playerNumber = Number(p.number)
        return !Number.isNaN(playerNumber) && !playersOnCourtSet.has(playerNumber) && (!p.libero || p.libero === '')
      })
      .map(p => {
        const playerNumber = Number(p.number)
        const substitutedInfo = playerLiberoMap[String(playerNumber)] || null
        return {
          ...p,
          substitutedByLibero: substitutedInfo
        }
      })

    const liberos = players
      .filter(p => {
        const playerNumber = Number(p.number)
        return p.libero && p.libero !== '' && !playersOnCourtSet.has(playerNumber)
      })
      .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0))

    return {
      benchPlayers,
      liberos,
      benchOfficials
    }
  }, [data, leftIsHome, getTeamLineupState])

  const formatTimestamp = useCallback(date => {
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
  }, [])

  const isBrightColor = useCallback(color => {
    if (!color || color === 'image.png') return false
    const hex = color.replace('#', '')
    const r = parseInt(hex.substr(0, 2), 16)
    const g = parseInt(hex.substr(2, 2), 16)
    const b = parseInt(hex.substr(4, 2), 16)
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    return luminance > 0.5
  }, [])

  const logEvent = useCallback(
    async (type, payload = {}, options = {}) => {
      console.log('[DEBUG] logEvent called:', { type, payload, options })
      if (!data?.set) {
        console.log('[DEBUG] logEvent aborted - no set')
        return
      }
      const timestamp = options.timestamp ?? new Date().toISOString()
      console.log('[DEBUG] logEvent - adding to db.events')
    await db.events.add({
        matchId,
        setIndex: data.set.index,
        type,
        payload,
        ts: timestamp
      })
      console.log('[DEBUG] logEvent - event added to db.events')
      
    // Get match to check if it's a test match
    const match = await db.matches.get(matchId)
    const isTest = match?.test || false
    
    console.log('[DEBUG] logEvent - adding to sync_queue')
    await db.sync_queue.add({
      resource: 'event',
      action: 'insert',
      payload: {
        match_id: match?.externalId || null,
        set_index: data.set.index,
        type,
        payload,
        test: isTest
      },
      ts: Date.now(),
      status: 'queued'
    })
    console.log('[DEBUG] logEvent completed:', type)
    },
    [data?.set, matchId]
  )

  const checkSetEnd = useCallback((set, homePoints, awayPoints) => {
    // Check if this point would end the set
    if (homePoints >= 25 && homePoints - awayPoints >= 2) {
      // Show set end time confirmation modal
      const defaultTime = new Date().toISOString()
      setSetEndTimeModal({ setIndex: set.index, winner: 'home', homePoints, awayPoints, defaultTime })
      return true
    }
    if (awayPoints >= 25 && awayPoints - homePoints >= 2) {
      // Show set end time confirmation modal
      const defaultTime = new Date().toISOString()
      setSetEndTimeModal({ setIndex: set.index, winner: 'away', homePoints, awayPoints, defaultTime })
      return true
    }
    return false
  }, [])

  const confirmSetEnd = useCallback(async () => {
    if (!setEndModal || !data?.match) return
    
    const { set, homePoints, awayPoints, winner } = setEndModal
    
    // Determine team labels (A or B) based on coin toss
    const teamAKey = data.match.coinTossTeamA || 'home'
    const teamBKey = data.match.coinTossTeamB || 'away'
    const winnerLabel = winner === 'home' 
      ? (teamAKey === 'home' ? 'A' : 'B')
      : (teamAKey === 'away' ? 'A' : 'B')
    
    // Log set win
    await logEvent('set_end', { 
      team: winner, 
      teamLabel: winnerLabel,
      setIndex: set.index,
      homePoints,
      awayPoints
    })
    
    await db.sets.update(set.id, { finished: true, homePoints, awayPoints })
    const sets = await db.sets.where({ matchId: set.matchId }).toArray()
    const finished = sets.filter(s => s.finished).length
    if (finished >= 5) {
      await db.matches.update(set.matchId, { status: 'final' })
      
      await db.sync_queue.add({
        resource: 'match',
        action: 'update',
        payload: {
          id: String(set.matchId),
          status: 'final'
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })
      
      if (onFinishSet) onFinishSet(set)
    } else {
      const newSetId = await db.sets.add({ matchId: set.matchId, index: set.index + 1, homePoints: 0, awayPoints: 0, finished: false })
      
      // Get match to check if it's a test match
      const match = await db.matches.get(set.matchId)
      const isTest = match?.test || false
      
      await db.sync_queue.add({
        resource: 'set',
        action: 'insert',
        payload: {
          external_id: String(newSetId),
          match_id: match?.externalId || String(set.matchId),
          index: set.index + 1,
          home_points: 0,
          away_points: 0,
          finished: false,
          test: isTest,
          created_at: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })
    }
    
    setSetEndModal(null)
  }, [setEndModal, data?.match, logEvent, onFinishSet])

  const cancelSetEnd = useCallback(async () => {
    if (!setEndModal || !data?.events || data.events.length === 0) {
      setSetEndModal(null)
      return
    }
    
    // Undo the last action (the point that would have ended the set)
    const lastEvent = data.events[data.events.length - 1]
    
    // If it's a point, decrease the score
    if (lastEvent.type === 'point' && lastEvent.payload?.team) {
      const teamKey = lastEvent.payload.team
      const field = teamKey === 'home' ? 'homePoints' : 'awayPoints'
      const currentPoints = data.set[field]
      
      if (currentPoints > 0) {
        await db.sets.update(data.set.id, {
          [field]: currentPoints - 1
        })
      }
    }
    
    // Delete the event
    await db.events.delete(lastEvent.id)
    
    // Also remove from sync_queue if it exists
    const allSyncItems = await db.sync_queue
      .where('status')
      .equals('queued')
      .toArray()
    
    const syncItems = allSyncItems.filter(item => 
      item.payload?.type === lastEvent.type && 
      item.payload?.set_index === lastEvent.setIndex
    )
    
    if (syncItems.length > 0) {
      const lastSyncItem = syncItems[syncItems.length - 1]
      await db.sync_queue.delete(lastSyncItem.id)
    }
    
    setSetEndModal(null)
  }, [setEndModal, data?.events, data?.set])

  // Determine who has serve based on events
  const getCurrentServe = useCallback(() => {
    if (!data?.events || data.events.length === 0) {
      // First rally: use firstServe from match
      return data?.match?.firstServe || 'home'
    }
    
    // Find the last point event to determine serve
    const pointEvents = data.events.filter(e => e.type === 'point')
    if (pointEvents.length === 0) {
      // No points yet, use firstServe
      return data?.match?.firstServe || 'home'
    }
    
    // The team that scored the last point now has serve
    const lastPoint = pointEvents[pointEvents.length - 1]
    return lastPoint.payload?.team || 'home'
  }, [data?.events, data?.match])

  const leftServeTeamKey = leftIsHome ? 'home' : 'away'
  const rightServeTeamKey = leftIsHome ? 'away' : 'home'
  const currentServeTeam = data?.set ? getCurrentServe() : null
  const leftServing = data?.set ? currentServeTeam === leftServeTeamKey : false
  const rightServing = data?.set ? currentServeTeam === rightServeTeamKey : false

  const serveBallBaseStyle = useMemo(
    () => ({
      width: '28px',
      height: '28px',
      filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35))'
    }),
    []
  )

  const renderScoreDisplay = useCallback(
    (style = {}) => (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', ...style }}>
        <div
          className="set-score-display"
          style={{
            position: 'relative',
            display: 'inline-block',
            padding: '0 44px',
            borderRadius: '14px'
          }}
        >
          {leftServing && (
            <img
              src={mikasaVolleyball}
              alt="Serving team"
              style={{
                ...serveBallBaseStyle,
                position: 'absolute',
                left: 10,
                top: '50%',
                transform: 'translateY(-50%)'
              }}
            />
          )}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            <span style={{ minWidth: 28, textAlign: 'right' }}>{pointsBySide.left}</span>
            <span>:</span>
            <span style={{ minWidth: 28, textAlign: 'left' }}>{pointsBySide.right}</span>
          </div>
          {rightServing && (
            <img
              src={mikasaVolleyball}
              alt="Serving team"
              style={{
                ...serveBallBaseStyle,
                position: 'absolute',
                right: 4,
                top: '50%',
                transform: 'translateY(-50%)'
              }}
            />
          )}
        </div>
        {/* Set score display */}
        <div style={{
          fontSize: '14px',
          fontWeight: 600,
          color: 'var(--muted)',
          textAlign: 'center'
        }}>
          {setScore.left}-{setScore.right}
        </div>
      </div>
    ),
    [leftServing, rightServing, pointsBySide.left, pointsBySide.right, serveBallBaseStyle, setScore.left, setScore.right]
  )

  const openManualLineup = useCallback(
    teamKey => {
      if (!data?.set) return
      const existingLineup = getCurrentLineup(teamKey)
      setLineupModal({ team: teamKey, mode: 'manual', lineup: existingLineup })
    },
    [data?.set, getCurrentLineup]
  )

  // Rotate lineup: II→I, III→II, IV→III, V→IV, VI→V, I→VI
  const rotateLineup = useCallback((lineup) => {
    if (!lineup) return null
    
    const newLineup = {
      I: lineup.II || '',
      II: lineup.III || '',
      III: lineup.IV || '',
      IV: lineup.V || '',
      V: lineup.VI || '',
      VI: lineup.I || ''
    }
    
    return newLineup
  }, [])

  const handlePoint = useCallback(
    async side => {
      if (!data?.set) return
      const teamKey = mapSideToTeamKey(side)
      const field = teamKey === 'home' ? 'homePoints' : 'awayPoints'
      const newPoints = data.set[field] + 1
      const homePoints = teamKey === 'home' ? newPoints : data.set.homePoints
      const awayPoints = teamKey === 'away' ? newPoints : data.set.awayPoints

      // Check who has serve
      const currentServe = getCurrentServe()
      const scoringTeamHasServe = currentServe === teamKey

      // If scoring team doesn't have serve, rotate their lineup
      if (!scoringTeamHasServe) {
        // Find the most recent lineup for this team
        const lineupEvents = data.events.filter(e => e.type === 'lineup' && e.payload?.team === teamKey)
        let currentLineup = null
        
        if (lineupEvents.length > 0) {
          // Use the most recent lineup
          const lastLineupEvent = lineupEvents[lineupEvents.length - 1]
          currentLineup = lastLineupEvent.payload?.lineup
        } else {
          // No lineup found, can't rotate
          console.warn(`No lineup found for team ${teamKey}, cannot rotate`)
        }
        
        if (currentLineup) {
          // Get the most recent lineup event to check for libero substitution
          const lastLineupEvent = lineupEvents[lineupEvents.length - 1]
          const liberoSubstitution = lastLineupEvent?.payload?.liberoSubstitution
          
          // Rotate the lineup
          const rotatedLineup = rotateLineup(currentLineup)
          if (rotatedLineup) {
            // Rotate the libero substitution position if it exists
            let rotatedLiberoSubstitution = null
            if (liberoSubstitution) {
              // Map old position to new position after rotation
              const positionMap = {
                'I': 'VI',
                'II': 'I',
                'III': 'II',
                'IV': 'III',
                'V': 'IV',
                'VI': 'V'
              }
              const newPosition = positionMap[liberoSubstitution.position]
              if (newPosition) {
                rotatedLiberoSubstitution = {
                  ...liberoSubstitution,
                  position: newPosition
                }
              }
            }
            
            // Check if any libero is in front-row positions (II, III, IV) - remove them immediately
            const teamPlayers = teamKey === 'home' ? data.homePlayers : data.awayPlayers
            const frontRowPositions = ['II', 'III', 'IV']
            let liberoInFrontRow = null
            
            for (const [pos, num] of Object.entries(rotatedLineup)) {
              if (frontRowPositions.includes(pos)) {
                const player = teamPlayers?.find(p => String(p.number) === String(num))
                if (player?.libero && player.libero !== '') {
                  liberoInFrontRow = [pos, num]
                  break
                }
              }
            }
            
            // If libero is in front row, automatically remove them
            let liberoExitedInfo = null
            if (liberoInFrontRow) {
              const [position, liberoNumber] = liberoInFrontRow
              
              // Find the original player that should be in this position
              // Look through lineup events to find who was in this position before the libero
              const allLineupEvents = data.events.filter(e => 
                e.type === 'lineup' && 
                e.payload?.team === teamKey && 
                e.setIndex === data.set.index
              ).sort((a, b) => new Date(b.ts) - new Date(a.ts)) // Most recent first
              
              let originalPlayerNumber = null
              
              // First, try to use the rotated libero substitution if it matches
              if (rotatedLiberoSubstitution && 
                  rotatedLiberoSubstitution.position === position &&
                  String(rotatedLiberoSubstitution.liberoNumber) === String(liberoNumber)) {
                originalPlayerNumber = rotatedLiberoSubstitution.playerNumber
              } else {
                // Find the most recent lineup event where this position had a non-libero player
                for (const event of allLineupEvents) {
                  const lineup = event.payload?.lineup
                  if (lineup && lineup[position]) {
                    const playerNum = lineup[position]
                    const player = teamPlayers?.find(p => String(p.number) === String(playerNum))
                    // If this position has a non-libero player, use it
                    if (player && (!player.libero || player.libero === '')) {
                      originalPlayerNumber = Number(playerNum)
                      break
                    }
                    // If this is the libero substitution event for this libero, get the original player
                    if (event.payload?.liberoSubstitution && 
                        String(event.payload.liberoSubstitution.liberoNumber) === String(liberoNumber) &&
                        event.payload.liberoSubstitution.position === position) {
                      originalPlayerNumber = event.payload.liberoSubstitution.playerNumber
                      break
                    }
                  }
                }
              }
              
              // If we found the original player, restore them
              if (originalPlayerNumber) {
                rotatedLineup[position] = String(originalPlayerNumber)
                rotatedLiberoSubstitution = null // Clear libero substitution since libero is out
                
                // Store info about the libero that was removed
                const liberoPlayer = teamPlayers?.find(p => String(p.number) === String(liberoNumber))
                liberoExitedInfo = {
                  liberoNumber: Number(liberoNumber),
                  liberoType: liberoPlayer?.libero,
                  originalPlayerNumber: originalPlayerNumber
                }
                
                // Show modal that libero must go out
                setLiberoRotationModal({
                  team: teamKey,
                  position: position,
                  liberoNumber: Number(liberoNumber),
                  playerNumber: originalPlayerNumber,
                  liberoType: liberoPlayer?.libero
                })
                
                // Log libero exit
                await logEvent('libero_exit', {
                  team: teamKey,
                  position: position,
                  liberoOut: liberoNumber,
                  playerIn: originalPlayerNumber,
                  liberoType: liberoPlayer?.libero,
                  reason: 'rotation_to_front_row'
                })
              } else {
                // Fallback: if we can't find the original player, log a warning but still remove the libero
                console.warn(`Could not find original player for libero ${liberoNumber} in position ${position}`)
                // Remove the libero anyway - they can't be in front row
                rotatedLineup[position] = ''
                rotatedLiberoSubstitution = null
              }
            }
            
            // Save the rotated lineup as a new lineup event (but don't log it - it's automatic rotation)
            const timestamp = new Date().toISOString()
            await db.events.add({
              matchId,
              setIndex: data.set.index,
              type: 'lineup',
              payload: { 
                team: teamKey, 
                lineup: rotatedLineup,
                liberoSubstitution: rotatedLiberoSubstitution // Include rotated libero substitution if it exists
              },
              ts: timestamp
            })
            // Don't add to sync_queue for rotation lineups
          }
        }
      }

      await db.sets.update(data.set.id, {
        [field]: newPoints
      })
      await logEvent('point', { team: teamKey })
      
      // After point is logged, the scoring team (teamKey) now has serve
      // So the OTHER team is receiving - check if they had a libero exit
      // Note: We use teamKey directly instead of getCurrentServe() because the event
      // might not be in data.events yet (async update), but we know teamKey has serve
      const otherTeamKey = teamKey === 'home' ? 'away' : 'home'
      
      // Check if the other team had a libero exit recently
      const otherTeamLiberoExits = data.events.filter(e => 
        e.type === 'libero_exit' && 
        e.payload?.team === otherTeamKey && 
        e.setIndex === data.set.index &&
        e.payload?.reason === 'rotation_to_front_row'
      ).sort((a, b) => new Date(b.ts) - new Date(a.ts))
      
      if (otherTeamLiberoExits.length > 0) {
        const lastLiberoExit = otherTeamLiberoExits[0]
        const liberoNumber = lastLiberoExit.payload?.liberoOut
        const liberoType = lastLiberoExit.payload?.liberoType
        
        // Check if libero is not currently on court
        const liberoOnCourt = getLiberoOnCourt(otherTeamKey)
        if (!liberoOnCourt && liberoNumber && liberoType) {
          // Get the other team's current lineup
          const otherTeamLineupEvents = data.events.filter(e => 
            e.type === 'lineup' && 
            e.payload?.team === otherTeamKey && 
            e.setIndex === data.set.index
          ).sort((a, b) => new Date(b.ts) - new Date(a.ts))
          
          if (otherTeamLineupEvents.length > 0) {
            const otherTeamLineup = otherTeamLineupEvents[0].payload?.lineup
            const playerInI = otherTeamLineup?.['I']
            
            if (playerInI && playerInI !== '') {
              // Ask if they want to put the libero back in at position I
              setLiberoReentryModal({
                team: otherTeamKey,
                position: 'I',
                playerNumber: Number(playerInI),
                liberoNumber: Number(liberoNumber),
                liberoType: liberoType
              })
            }
          }
        }
      }
      
      const setEnded = checkSetEnd(data.set, homePoints, awayPoints)
      // If set didn't end, we're done. If it did, checkSetEnd will show the confirmation modal
    },
    [data?.set, data?.events, logEvent, mapSideToTeamKey, checkSetEnd, getCurrentServe, rotateLineup]
  )

  const handleStartRally = useCallback(async () => {
    // If this is the first rally, show set start time confirmation
    if (isFirstRally) {
      // Check if liberos exist and haven't been entered
      const homeLiberos = data?.homePlayers?.filter(p => p.libero && p.libero !== '') || []
      const awayLiberos = data?.awayPlayers?.filter(p => p.libero && p.libero !== '') || []
      
      // Check if any libero has been entered in the current set for each team
      const homeLiberoEvents = data?.events?.filter(e => 
        (e.type === 'libero_entry' || e.type === 'libero_exit') && 
        e.payload?.team === 'home' &&
        e.setIndex === data?.set?.index
      ) || []
      
      const awayLiberoEvents = data?.events?.filter(e => 
        (e.type === 'libero_entry' || e.type === 'libero_exit') && 
        e.payload?.team === 'away' &&
        e.setIndex === data?.set?.index
      ) || []
      
      const teamsNeedingReminder = []
      if (homeLiberos.length > 0 && homeLiberoEvents.length === 0) {
        teamsNeedingReminder.push('home')
      }
      if (awayLiberos.length > 0 && awayLiberoEvents.length === 0) {
        teamsNeedingReminder.push('away')
      }
      
      if (teamsNeedingReminder.length > 0) {
        setLiberoReminder({ teams: teamsNeedingReminder })
        return
      }
      
      // Show set start time confirmation
      // For set 1, use scheduled time, for set 2+, use 3 minutes after previous set end
      let defaultTime = new Date().toISOString()
      
      if (data?.set?.index === 1) {
        // Use scheduled time from match
        if (data?.match?.scheduledAt) {
          defaultTime = data.match.scheduledAt
        }
      } else {
        // Get previous set's end time
        const allSets = await db.sets.where('matchId').equals(matchId).toArray()
        const previousSet = allSets.find(s => s.index === (data.set.index - 1))
        if (previousSet?.endTime) {
          // Add 3 minutes to previous set end time
          const prevEndTime = new Date(previousSet.endTime)
          prevEndTime.setMinutes(prevEndTime.getMinutes() + 3)
          defaultTime = prevEndTime.toISOString()
        }
      }
      
      setSetStartTimeModal({ setIndex: data?.set?.index, defaultTime })
      return
    }
    
    setLiberoReminder(null)
    await logEvent('rally_start')
  }, [logEvent, isFirstRally, data?.homePlayers, data?.awayPlayers, data?.events, data?.set, data?.match, matchId])

  const handleReplay = useCallback(async () => {
    await logEvent('replay')
  }, [logEvent])

  // Handle Improper Request sanction
  const handleImproperRequest = useCallback((side) => {
    if (!data?.match || rallyStatus !== 'idle') return
    setSanctionConfirm({ side, type: 'improper_request' })
  }, [data?.match, rallyStatus])

  // Handle Delay Warning sanction
  const handleDelayWarning = useCallback((side) => {
    if (!data?.match || rallyStatus !== 'idle') return
    setSanctionConfirm({ side, type: 'delay_warning' })
  }, [data?.match, rallyStatus])

  // Handle Delay Penalty sanction
  const handleDelayPenalty = useCallback((side) => {
    if (!data?.match || !data?.set || rallyStatus !== 'idle') return
    setSanctionConfirm({ side, type: 'delay_penalty' })
  }, [data?.match, data?.set, rallyStatus])

  // Confirm sanction
  const confirmSanction = useCallback(async () => {
    if (!sanctionConfirm || !data?.match) return
    
    const { side, type } = sanctionConfirm
    const teamKey = mapSideToTeamKey(side)
    const sideKey = side === 'left' ? 'Left' : 'Right'
    
    // Update match sanctions for improper request and delay warning
    if (type === 'improper_request' || type === 'delay_warning') {
      const currentSanctions = data.match.sanctions || {}
      await db.matches.update(matchId, {
        sanctions: {
          ...currentSanctions,
          [`${type === 'improper_request' ? 'improperRequest' : 'delayWarning'}${sideKey}`]: true
        }
      })
    }
    
    // Log the sanction event
    await logEvent('sanction', {
      team: teamKey,
      type: type
    })
    
    // If delay penalty, award point to the other team
    if (type === 'delay_penalty') {
      const otherSide = side === 'left' ? 'right' : 'left'
      setSanctionConfirm(null)
      await handlePoint(otherSide)
    } else {
      setSanctionConfirm(null)
    }
  }, [sanctionConfirm, data?.match, mapSideToTeamKey, matchId, logEvent, handlePoint])

  // Confirm set start time
  const confirmSetStartTime = useCallback(async (time) => {
    console.log('[DEBUG] confirmSetStartTime called with time:', time)
    if (!setStartTimeModal || !data?.set) {
      console.log('[DEBUG] confirmSetStartTime aborted - modal or set missing')
      return
    }
    
    console.log('[DEBUG] Updating set with start time')
    // Update set with start time
    await db.sets.update(data.set.id, { startTime: time })
    
    // Use the provided time as the event timestamp so ordering stays consistent
    const setStartTimestamp = time
    const rallyStartTimestamp = new Date(new Date(setStartTimestamp).getTime() + 1).toISOString()
    
    console.log('[DEBUG] Logging set_start event')
    // Log set start event
    await logEvent('set_start', {
      setIndex: setStartTimeModal.setIndex,
      startTime: time
    }, { timestamp: setStartTimestamp })
    
    console.log('[DEBUG] Clearing modal')
    setSetStartTimeModal(null)
    
    console.log('[DEBUG] Logging rally_start event')
    // Now actually start the rally (ensure timestamp is after set start)
    await logEvent('rally_start', {}, { timestamp: rallyStartTimestamp })
    console.log('[DEBUG] confirmSetStartTime completed')
  }, [setStartTimeModal, data?.set, logEvent])

  // Confirm set end time
  const confirmSetEndTime = useCallback(async (time) => {
    if (!setEndTimeModal || !data?.match || !data?.set) return
    
    const { setIndex, winner, homePoints, awayPoints } = setEndTimeModal
    
    // Determine team labels (A or B) based on coin toss
    const teamAKey = data.match.coinTossTeamA || 'home'
    const winnerLabel = winner === 'home' 
      ? (teamAKey === 'home' ? 'A' : 'B')
      : (teamAKey === 'away' ? 'A' : 'B')
    
    // Log set win
    await logEvent('set_end', { 
      team: winner, 
      teamLabel: winnerLabel,
      setIndex: setIndex,
      homePoints,
      awayPoints,
      endTime: time
    })
    
    // Update set with end time and finished status
    await db.sets.update(data.set.id, { finished: true, homePoints, awayPoints, endTime: time })
    
    const sets = await db.sets.where({ matchId }).toArray()
    const finished = sets.filter(s => s.finished).length
    
    if (finished >= 5) {
      await db.matches.update(matchId, { status: 'final' })
      
      // Add match update to sync queue
      const matchRecord = await db.matches.get(matchId)
      if (matchRecord?.test !== true) {
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: String(matchId),
            status: 'final'
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }
      
      if (onFinishSet) onFinishSet(data.set)
    } else {
      const newSetId = await db.sets.add({ 
        matchId, 
        index: setIndex + 1, 
        homePoints: 0, 
        awayPoints: 0, 
        finished: false 
      })
      
      // Get match to check if it's a test match
      const match = await db.matches.get(matchId)
      const isTest = match?.test || false
      
      await db.sync_queue.add({
        resource: 'set',
        action: 'insert',
        payload: {
          external_id: String(newSetId),
          match_id: match?.externalId || String(matchId),
          index: setIndex + 1,
          home_points: 0,
          away_points: 0,
          finished: false,
          test: isTest,
          created_at: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })
    }
    
    setSetEndTimeModal(null)
  }, [setEndTimeModal, data?.match, data?.set, matchId, logEvent, onFinishSet])

  // Get action description for an event
  const getActionDescription = useCallback((event) => {
    if (!event || !data) return 'Unknown action'
    
    const teamName = event.payload?.team === 'home' 
      ? (data.homeTeam?.name || 'Home')
      : event.payload?.team === 'away'
      ? (data.awayTeam?.name || 'Away')
      : null
    
    // Determine team labels (A or B)
    const teamALabel = data?.match?.coinTossTeamA === 'home' ? 'A' : 'B'
    const teamBLabel = data?.match?.coinTossTeamB === 'home' ? 'A' : 'B'
    const homeLabel = data?.match?.coinTossTeamA === 'home' ? 'A' : (data?.match?.coinTossTeamB === 'home' ? 'B' : 'A')
    const awayLabel = data?.match?.coinTossTeamA === 'away' ? 'A' : (data?.match?.coinTossTeamB === 'away' ? 'B' : 'B')
    
    // Calculate score at time of event
    const setIdx = event.setIndex || 1
    const setEvents = data.events?.filter(e => (e.setIndex || 1) === setIdx) || []
    const eventIndex = setEvents.findIndex(e => e.id === event.id)
    
    let homeScore = 0
    let awayScore = 0
    for (let i = 0; i <= eventIndex; i++) {
      const e = setEvents[i]
      if (e.type === 'point') {
        if (e.payload?.team === 'home') {
          homeScore++
        } else if (e.payload?.team === 'away') {
          awayScore++
        }
      }
    }
    
    let eventDescription = ''
    if (event.type === 'point') {
      eventDescription = `Point — ${teamName} (${homeLabel} ${homeScore}:${awayScore} ${awayLabel})`
    } else if (event.type === 'timeout') {
      eventDescription = `Timeout — ${teamName}`
    } else if (event.type === 'substitution') {
      const playerOut = event.payload?.playerOut || '?'
      const playerIn = event.payload?.playerIn || '?'
      eventDescription = `Substitution — ${teamName} (OUT: ${playerOut} IN: ${playerIn}) (${homeLabel} ${homeScore}:${awayScore} ${awayLabel})`
    } else if (event.type === 'rally_start') {
      eventDescription = 'Rally started'
    } else if (event.type === 'replay') {
      eventDescription = 'Replay'
    } else if (event.type === 'lineup') {
      // Only show initial lineups or substitution-related lineups, not rotation lineups
      const isInitial = event.payload?.isInitial === true
      const hasSubstitution = event.payload?.fromSubstitution === true
      const hasLiberoSub = event.payload?.liberoSubstitution !== null && event.payload?.liberoSubstitution !== undefined
      if (!isInitial && !hasSubstitution && !hasLiberoSub) {
        // This is a rotation lineup, don't show it
        return null
      }
      eventDescription = `Lineup — ${teamName}`
    } else if (event.type === 'libero_entry') {
      const liberoNumber = event.payload?.liberoIn || '?'
      const liberoType = event.payload?.liberoType === 'libero1' ? 'L1' : 'L2'
      eventDescription = `Libero entry — ${teamName} (${liberoType} #${liberoNumber} in for #${event.payload?.playerOut || '?'})`
    } else if (event.type === 'libero_exit') {
      const liberoNumber = event.payload?.liberoOut || '?'
      const liberoType = event.payload?.liberoType === 'libero1' ? 'L1' : 'L2'
      eventDescription = `Libero exit — ${teamName} (${liberoType} #${liberoNumber} out)`
    } else if (event.type === 'set_end') {
      const winnerLabel = event.payload?.teamLabel || '?'
      const setIndex = event.payload?.setIndex || event.setIndex || '?'
      eventDescription = `Team ${winnerLabel} won Set ${setIndex}`
    } else if (event.type === 'sanction') {
      const sanctionType = event.payload?.type || 'unknown'
      const sanctionLabel = sanctionType === 'improper_request' ? 'Improper Request' :
                            sanctionType === 'delay_warning' ? 'Delay Warning' :
                            sanctionType === 'delay_penalty' ? 'Delay Penalty' :
                            sanctionType
      eventDescription = `Sanction — ${teamName} (${sanctionLabel})`
    } else {
      eventDescription = event.type
      if (teamName) {
        eventDescription += ` — ${teamName}`
      }
    }
    
    return eventDescription
  }, [data])

  // Show undo confirmation
  const showUndoConfirm = useCallback(() => {
    if (!data?.events || data.events.length === 0) return
    
    // Find the last event that should be undoable (skip rotation lineups and libero substitution lineups)
    const allEvents = data.events.sort((a, b) => new Date(b.ts) - new Date(a.ts))
    const lastUndoableEvent = allEvents.find(e => {
      // Skip rotation lineups (they don't have isInitial, fromSubstitution, or liberoSubstitution)
      // Rotation lineups are created automatically when a team wins serve, so they shouldn't be undoable
      // Also skip libero substitution lineups - they should be undone via libero_entry/libero_exit events
      if (e.type === 'lineup') {
        const hasInitial = e.payload?.isInitial === true
        const hasSubstitution = e.payload?.fromSubstitution === true
        const hasLiberoSub = e.payload?.liberoSubstitution !== null && e.payload?.liberoSubstitution !== undefined
        // Skip pure rotation lineups (no initial, no substitution, no libero substitution)
        // Also skip libero substitution lineups (they should be undone via libero_entry/libero_exit events)
        if (!hasInitial && !hasSubstitution) {
          return false
        }
      }
      // Skip rally_start and replay events as they're not meaningful to undo
      if (e.type === 'rally_start' || e.type === 'replay') {
        return false
      }
      return true
    })
    
    if (!lastUndoableEvent) return
    
    const description = getActionDescription(lastUndoableEvent)
    // getActionDescription returns null for rotation lineups, but we've already filtered those out
    // So if it returns null here, try to find the next undoable event
    if (!description || description === 'Unknown action') {
      // Find the next undoable event after this one
      const currentIndex = allEvents.findIndex(e => e.id === lastUndoableEvent.id)
      const nextUndoableEvent = allEvents.slice(currentIndex + 1).find(e => {
          if (e.type === 'lineup') {
            const hasInitial = e.payload?.isInitial === true
            const hasSubstitution = e.payload?.fromSubstitution === true
            // Skip libero substitution lineups and rotation lineups
            if (!hasInitial && !hasSubstitution) {
              return false
            }
          }
        if (e.type === 'rally_start' || e.type === 'replay') {
          return false
        }
        const desc = getActionDescription(e)
        return desc && desc !== 'Unknown action'
      })
      
      if (nextUndoableEvent) {
        const nextDesc = getActionDescription(nextUndoableEvent)
        if (nextDesc && nextDesc !== 'Unknown action') {
          setUndoConfirm({ event: nextUndoableEvent, description: nextDesc })
          return
        }
      }
      // No undoable events found
      return
    }
    
    setUndoConfirm({ event: lastUndoableEvent, description })
  }, [data?.events, getActionDescription])

  const handleUndo = useCallback(async () => {
    if (!undoConfirm || !data?.set) return
    
    const lastEvent = undoConfirm.event
    
    // Skip rotation lineups (they don't have isInitial, fromSubstitution, or liberoSubstitution)
    if (lastEvent.type === 'lineup') {
      const hasInitial = lastEvent.payload?.isInitial === true
      const hasSubstitution = lastEvent.payload?.fromSubstitution === true
      const hasLiberoSub = lastEvent.payload?.liberoSubstitution !== null && lastEvent.payload?.liberoSubstitution !== undefined
      // Only skip if it's a pure rotation lineup
      if (!hasInitial && !hasSubstitution && !hasLiberoSub) {
        // Find the next non-rotation event to undo
        const allEvents = data.events.sort((a, b) => new Date(b.ts) - new Date(a.ts))
        const nextEvent = allEvents.find(e => {
          if (e.id === lastEvent.id) return false
          if (e.type === 'lineup') {
            const eHasInitial = e.payload?.isInitial === true
            const eHasSubstitution = e.payload?.fromSubstitution === true
            // Skip libero substitution lineups and rotation lineups
            if (!eHasInitial && !eHasSubstitution) return false
          }
          return true
        })
        
        if (nextEvent) {
          const description = getActionDescription(nextEvent)
          if (description && description !== 'Unknown action' && description.trim() !== '') {
            setUndoConfirm({ event: nextEvent, description })
            return
          }
        }
        // No other events to undo
        setUndoConfirm(null)
        return
      }
    }
    
    // If it's a point, decrease the score and handle rotation if needed
    if (lastEvent.type === 'point' && lastEvent.payload?.team) {
      const teamKey = lastEvent.payload.team
      const field = teamKey === 'home' ? 'homePoints' : 'awayPoints'
      const currentPoints = data.set[field]
      if (currentPoints > 0) {
        await db.sets.update(data.set.id, {
          [field]: currentPoints - 1
        })
      }
      
      // Check if the scoring team rotated (they didn't have serve before scoring)
      // We need to find the point event BEFORE this one to determine who had serve
      const allPointEvents = data.events
        .filter(e => e.type === 'point' && e.setIndex === data.set.index)
        .sort((a, b) => new Date(b.ts) - new Date(a.ts)) // Most recent first
      
      const currentPointIndex = allPointEvents.findIndex(e => e.id === lastEvent.id)
      const previousPointEvent = currentPointIndex >= 0 && currentPointIndex < allPointEvents.length - 1
        ? allPointEvents[currentPointIndex + 1]
        : null
      
      // Determine who had serve before this point
      // If there's a previous point, the team that scored it has serve
      // Otherwise, use firstServe from match
      const serveBeforePoint = previousPointEvent 
        ? previousPointEvent.payload?.team 
        : (data?.match?.firstServe || 'home')
      
      const scoringTeamHadServe = serveBeforePoint === teamKey
      
      // If the scoring team didn't have serve, they rotated, so we need to undo the rotation
      if (!scoringTeamHadServe) {
        // Find the rotation lineup event that was created after this point
        // Rotation lineups are created right after the point is logged
        const pointTimestamp = new Date(lastEvent.ts)
        const rotationLineupEvents = data.events
          .filter(e => 
            e.type === 'lineup' && 
            e.payload?.team === teamKey && 
            e.setIndex === data.set.index &&
            new Date(e.ts) > pointTimestamp // Created after the point
          )
          .sort((a, b) => new Date(a.ts) - new Date(b.ts)) // Oldest first (first rotation lineup after point)
        
        // Find the first rotation lineup (should be the one created by the rotation)
        // Rotation lineups don't have isInitial, fromSubstitution, or liberoSubstitution
        const rotationLineup = rotationLineupEvents.find(e => {
          const hasInitial = e.payload?.isInitial === true
          const hasSubstitution = e.payload?.fromSubstitution === true
          const hasLiberoSub = e.payload?.liberoSubstitution !== null && e.payload?.liberoSubstitution !== undefined
          return !hasInitial && !hasSubstitution && !hasLiberoSub
        })
        
        if (rotationLineup) {
          // Delete the rotation lineup to undo the rotation
          await db.events.delete(rotationLineup.id)
        }
      }
    }
    
    // If it's an initial lineup, delete it (players go back to bench)
    if (lastEvent.type === 'lineup' && lastEvent.payload?.isInitial === true) {
      // Simply delete the initial lineup event
      // This will cause players to go back to the bench
      await db.events.delete(lastEvent.id)
    }
    
    // If it's a substitution, revert the lineup change
    if (lastEvent.type === 'substitution' && lastEvent.payload?.team && lastEvent.payload?.position) {
      const team = lastEvent.payload.team
      const position = lastEvent.payload.position
      const playerOut = lastEvent.payload.playerOut
      
      // Find the lineup event that was created with this substitution
      const lineupEvents = data.events
        .filter(e => e.type === 'lineup' && e.payload?.team === team && e.setIndex === data.set.index)
        .sort((a, b) => new Date(b.ts) - new Date(a.ts)) // Most recent first
      
      if (lineupEvents.length > 1) {
        // Remove the most recent lineup (the one with the substitution)
        const mostRecentLineup = lineupEvents[0]
        await db.events.delete(mostRecentLineup.id)
        
        // Get the previous lineup and restore it
        const previousLineup = lineupEvents[1]?.payload?.lineup || {}
        const restoredLineup = { ...previousLineup }
        restoredLineup[position] = String(playerOut)
        
        // Save the restored lineup
        const timestamp = new Date().toISOString()
        await db.events.add({
          matchId,
          setIndex: data.set.index,
          type: 'lineup',
          payload: { team, lineup: restoredLineup, fromSubstitution: true },
          ts: timestamp
        })
      }
    }
    
    // If it's a libero entry, revert the lineup change
    if (lastEvent.type === 'libero_entry' && lastEvent.payload?.team && lastEvent.payload?.position) {
      const team = lastEvent.payload.team
      const position = lastEvent.payload.position
      const playerOut = lastEvent.payload.playerOut
      const liberoEntryTimestamp = new Date(lastEvent.ts)
      
      // Find the lineup event that was created with this libero entry
      // Look for lineup events with liberoSubstitution that matches this libero entry
      const liberoNumber = lastEvent.payload?.liberoIn
      const liberoLineupEvents = data.events
        .filter(e => 
          e.type === 'lineup' && 
          e.payload?.team === team && 
          e.setIndex === data.set.index &&
          e.payload?.liberoSubstitution &&
          String(e.payload.liberoSubstitution.liberoNumber) === String(liberoNumber) &&
          e.payload.liberoSubstitution.position === position
        )
        .sort((a, b) => new Date(b.ts) - new Date(a.ts)) // Most recent first
      
      if (liberoLineupEvents.length > 0) {
        // Remove the lineup with the libero entry
        const liberoLineupEvent = liberoLineupEvents[0]
        await db.events.delete(liberoLineupEvent.id)
        
        // Find the most recent complete lineup event BEFORE the libero entry
        // Get all lineup events for this team in this set, sorted by time (oldest first)
        const allLineupEvents = data.events
          .filter(e => 
            e.type === 'lineup' && 
            e.payload?.team === team && 
            e.setIndex === data.set.index &&
            e.id !== liberoLineupEvent.id // Exclude the one we just deleted
          )
          .sort((a, b) => new Date(a.ts) - new Date(b.ts)) // Oldest first
        
        // Find the lineup event that was created before the libero entry event timestamp
        // Get the most recent one before libero entry
        const previousLineupEvents = allLineupEvents.filter(e => new Date(e.ts) < liberoEntryTimestamp)
        const previousLineupEvent = previousLineupEvents.length > 0 
          ? previousLineupEvents[previousLineupEvents.length - 1] // Most recent before libero entry
          : null
        
        if (previousLineupEvent && previousLineupEvent.payload?.lineup) {
          // Restore the complete previous lineup
          const previousLineup = previousLineupEvent.payload.lineup
          // Ensure we have all 6 positions
          const restoredLineup = {
            I: previousLineup.I || '',
            II: previousLineup.II || '',
            III: previousLineup.III || '',
            IV: previousLineup.IV || '',
            V: previousLineup.V || '',
            VI: previousLineup.VI || ''
          }
          // Restore the player at the position where libero was
          restoredLineup[position] = String(playerOut)
          
          // Save the restored complete lineup
          const timestamp = new Date().toISOString()
          await db.events.add({
            matchId,
            setIndex: data.set.index,
            type: 'lineup',
            payload: { 
              team, 
              lineup: restoredLineup,
              liberoSubstitution: null // Explicitly clear libero substitution
            },
            ts: timestamp
          })
        } else {
          // No previous lineup found, get the current most recent lineup (after deletion) and restore
          const currentLineupEvents = data.events
            .filter(e => 
              e.type === 'lineup' && 
              e.payload?.team === team && 
              e.setIndex === data.set.index &&
              e.id !== liberoLineupEvent.id // Exclude the one we just deleted
            )
            .sort((a, b) => new Date(b.ts) - new Date(a.ts))
          
          if (currentLineupEvents.length > 0 && currentLineupEvents[0].payload?.lineup) {
            const currentLineup = currentLineupEvents[0].payload.lineup
            // Ensure we have all 6 positions
            const restoredLineup = {
              I: currentLineup.I || '',
              II: currentLineup.II || '',
              III: currentLineup.III || '',
              IV: currentLineup.IV || '',
              V: currentLineup.V || '',
              VI: currentLineup.VI || ''
            }
            // Restore the player at the position where libero was
            restoredLineup[position] = String(playerOut)
            
            // Save the restored complete lineup
            const timestamp = new Date().toISOString()
            await db.events.add({
              matchId,
              setIndex: data.set.index,
              type: 'lineup',
              payload: { 
                team, 
                lineup: restoredLineup,
                liberoSubstitution: null // Explicitly clear libero substitution
              },
              ts: timestamp
            })
          }
        }
      }
    }
    
    // If it's a libero exit, revert the lineup change
    if (lastEvent.type === 'libero_exit' && lastEvent.payload?.team && lastEvent.payload?.position) {
      const team = lastEvent.payload.team
      const position = lastEvent.payload.position
      const liberoOut = lastEvent.payload.liberoOut
      const playerIn = lastEvent.payload.playerIn
      const liberoExitTimestamp = new Date(lastEvent.ts)
      
      // Find the lineup event that was created with this libero exit (the one without libero substitution)
      const exitLineupEvents = data.events
        .filter(e => 
          e.type === 'lineup' && 
          e.payload?.team === team && 
          e.setIndex === data.set.index &&
          (!e.payload?.liberoSubstitution || e.payload.liberoSubstitution === null) &&
          new Date(e.ts) <= liberoExitTimestamp &&
          new Date(e.ts) > new Date(liberoExitTimestamp.getTime() - 5000) // Within 5 seconds of exit
        )
        .sort((a, b) => new Date(b.ts) - new Date(a.ts)) // Most recent first
      
      if (exitLineupEvents.length > 0) {
        // Remove the lineup with the libero exit
        const exitLineupEvent = exitLineupEvents[0]
        await db.events.delete(exitLineupEvent.id)
        
        // Find the most recent lineup event BEFORE the libero exit that had the libero
        const allLineupEvents = data.events
          .filter(e => 
            e.type === 'lineup' && 
            e.payload?.team === team && 
            e.setIndex === data.set.index &&
            e.id !== exitLineupEvent.id
          )
          .sort((a, b) => new Date(a.ts) - new Date(b.ts))
        
        const previousLineupEvents = allLineupEvents.filter(e => new Date(e.ts) < liberoExitTimestamp)
        const previousLineupEvent = previousLineupEvents.length > 0 
          ? previousLineupEvents[previousLineupEvents.length - 1]
          : null
        
        if (previousLineupEvent && previousLineupEvent.payload?.lineup) {
          // Restore the complete previous lineup (which had the libero)
          const previousLineup = previousLineupEvent.payload.lineup
          const restoredLineup = {
            I: previousLineup.I || '',
            II: previousLineup.II || '',
            III: previousLineup.III || '',
            IV: previousLineup.IV || '',
            V: previousLineup.V || '',
            VI: previousLineup.VI || ''
          }
          // Restore the libero at the position
          restoredLineup[position] = String(liberoOut)
          
          // Restore the libero substitution info from the previous lineup
          const previousLiberoSub = previousLineupEvent.payload?.liberoSubstitution
          
          // Save the restored complete lineup
          const timestamp = new Date().toISOString()
          await db.events.add({
            matchId,
            setIndex: data.set.index,
            type: 'lineup',
            payload: { 
              team, 
              lineup: restoredLineup,
              liberoSubstitution: previousLiberoSub || null
            },
            ts: timestamp
          })
        }
      }
    }
    
    // If it's a libero exchange, revert the lineup change
    if (lastEvent.type === 'libero_exchange' && lastEvent.payload?.team && lastEvent.payload?.position) {
      const team = lastEvent.payload.team
      const position = lastEvent.payload.position
      const liberoOut = lastEvent.payload.liberoOut
      const liberoIn = lastEvent.payload.liberoIn
      const liberoExchangeTimestamp = new Date(lastEvent.ts)
      
      // Find the lineup event that was created with this libero exchange
      const exchangeLineupEvents = data.events
        .filter(e => 
          e.type === 'lineup' && 
          e.payload?.team === team && 
          e.setIndex === data.set.index &&
          e.payload?.liberoSubstitution &&
          String(e.payload.liberoSubstitution.liberoNumber) === String(liberoIn) &&
          e.payload.liberoSubstitution.position === position &&
          new Date(e.ts) <= liberoExchangeTimestamp &&
          new Date(e.ts) > new Date(liberoExchangeTimestamp.getTime() - 5000) // Within 5 seconds
        )
        .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      
      if (exchangeLineupEvents.length > 0) {
        // Remove the lineup with the libero exchange
        const exchangeLineupEvent = exchangeLineupEvents[0]
        await db.events.delete(exchangeLineupEvent.id)
        
        // Find the most recent lineup event BEFORE the libero exchange
        const allLineupEvents = data.events
          .filter(e => 
            e.type === 'lineup' && 
            e.payload?.team === team && 
            e.setIndex === data.set.index &&
            e.id !== exchangeLineupEvent.id
          )
          .sort((a, b) => new Date(a.ts) - new Date(b.ts))
        
        const previousLineupEvents = allLineupEvents.filter(e => new Date(e.ts) < liberoExchangeTimestamp)
        const previousLineupEvent = previousLineupEvents.length > 0 
          ? previousLineupEvents[previousLineupEvents.length - 1]
          : null
        
        if (previousLineupEvent && previousLineupEvent.payload?.lineup) {
          // Restore the complete previous lineup (which had the previous libero)
          const previousLineup = previousLineupEvent.payload.lineup
          const restoredLineup = {
            I: previousLineup.I || '',
            II: previousLineup.II || '',
            III: previousLineup.III || '',
            IV: previousLineup.IV || '',
            V: previousLineup.V || '',
            VI: previousLineup.VI || ''
          }
          // Restore the previous libero at the position
          restoredLineup[position] = String(liberoOut)
          
          // Restore the libero substitution info from the previous lineup
          const previousLiberoSub = previousLineupEvent.payload?.liberoSubstitution
          if (previousLiberoSub) {
            // Update to use the previous libero
            const restoredLiberoSub = {
              ...previousLiberoSub,
              liberoNumber: liberoOut,
              liberoType: lastEvent.payload?.liberoOutType
            }
            
            // Save the restored complete lineup
            const timestamp = new Date().toISOString()
            await db.events.add({
              matchId,
              setIndex: data.set.index,
              type: 'lineup',
              payload: { 
                team, 
                lineup: restoredLineup,
                liberoSubstitution: restoredLiberoSub
              },
              ts: timestamp
            })
          } else {
            // No previous libero sub, just restore the lineup
            const timestamp = new Date().toISOString()
            await db.events.add({
              matchId,
              setIndex: data.set.index,
              type: 'lineup',
              payload: { 
                team, 
                lineup: restoredLineup,
                liberoSubstitution: null
              },
              ts: timestamp
            })
          }
        }
      }
    }
    
    // If it's a sanction, clear the sanction flag from the match
    if (lastEvent.type === 'sanction' && lastEvent.payload?.team && lastEvent.payload?.type) {
      const teamKey = lastEvent.payload.team
      const sanctionType = lastEvent.payload.type
      const side = (teamKey === 'home' && leftIsHome) || (teamKey === 'away' && !leftIsHome) ? 'left' : 'right'
      const sideKey = side === 'left' ? 'Left' : 'Right'
      
      // Clear the sanction flag for improper_request and delay_warning
      if (sanctionType === 'improper_request' || sanctionType === 'delay_warning') {
        const currentSanctions = data.match?.sanctions || {}
        const updatedSanctions = { ...currentSanctions }
        const flagKey = `${sanctionType === 'improper_request' ? 'improperRequest' : 'delayWarning'}${sideKey}`
        delete updatedSanctions[flagKey]
        
        await db.matches.update(matchId, {
          sanctions: updatedSanctions
        })
      }
    }
    
    // Delete the event
    await db.events.delete(lastEvent.id)
    
    // Also remove from sync_queue if it exists
    // Note: payload.type is not indexed, so we filter in memory
    const allSyncItems = await db.sync_queue
      .where('status')
      .equals('queued')
      .toArray()
    
    const syncItems = allSyncItems.filter(item => 
      item.payload?.type === lastEvent.type && 
      item.payload?.set_index === lastEvent.setIndex
    )
    
    if (syncItems.length > 0) {
      const lastSyncItem = syncItems[syncItems.length - 1]
      await db.sync_queue.delete(lastSyncItem.id)
    }
    
    setUndoConfirm(null)
  }, [undoConfirm, data?.events, data?.set, data?.match, matchId, leftIsHome, getActionDescription])

  const cancelUndo = useCallback(() => {
    setUndoConfirm(null)
  }, [])

  const handleTimeout = useCallback(
    side => {
      const teamKey = mapSideToTeamKey(side)
      const used = (timeoutsUsed && timeoutsUsed[teamKey]) || 0
      if (used >= 2) return
      setTimeoutModal({ team: teamKey, countdown: 30, started: false })
    },
    [mapSideToTeamKey, timeoutsUsed]
  )

  const confirmTimeout = useCallback(async () => {
    if (!timeoutModal) return
    // Log the timeout event
    await logEvent('timeout', { team: timeoutModal.team })
    // Start the timeout countdown
    setTimeoutModal({ ...timeoutModal, started: true })
  }, [timeoutModal, logEvent])

  const cancelTimeout = useCallback(() => {
    // Only cancel if timeout hasn't started yet
    if (!timeoutModal || timeoutModal.started) return
    setTimeoutModal(null)
  }, [timeoutModal])

  const stopTimeout = useCallback(() => {
    // Stop the countdown (close modal) but keep the timeout logged
    setTimeoutModal(null)
  }, [])

  useEffect(() => {
    if (!timeoutModal || !timeoutModal.started) return

    if (timeoutModal.countdown <= 0) {
      // When countdown reaches 0, close the modal
      setTimeoutModal(null)
      return
    }

    const timer = setInterval(() => {
      setTimeoutModal(prev => {
        if (!prev || !prev.started) return null
        const newCountdown = prev.countdown - 1
        if (newCountdown <= 0) {
          // When countdown reaches 0, close the modal
          return null
        }
        return { ...prev, countdown: newCountdown }
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [timeoutModal])

  const getTimeoutsUsed = useCallback(
    side => {
      const teamKey = mapSideToTeamKey(side)
      return (timeoutsUsed && timeoutsUsed[teamKey]) || 0
    },
    [mapSideToTeamKey, timeoutsUsed]
  )

  const getSubstitutionsUsed = useCallback(
    side => {
      const teamKey = mapSideToTeamKey(side)
      return (substitutionsUsed && substitutionsUsed[teamKey]) || 0
    },
    [mapSideToTeamKey, substitutionsUsed]
  )

  const handlePlaceholder = message => () => {
    alert(`${message} — coming soon.`)
  }

  // Check if there was a point change between two events
  const hasPointChangeBetween = useCallback((event1Index, event2Index, setIndex) => {
    if (!data?.events) return false
    const setEvents = data.events.filter(e => (e.setIndex || 1) === setIndex).sort((a, b) => new Date(a.ts) - new Date(b.ts))
    
    let pointsBefore = { home: 0, away: 0 }
    let pointsAfter = { home: 0, away: 0 }
    
    for (let i = 0; i < setEvents.length; i++) {
      const e = setEvents[i]
      if (e.type === 'point') {
        if (e.payload?.team === 'home') pointsAfter.home++
        else if (e.payload?.team === 'away') pointsAfter.away++
      }
      
      if (i === event1Index) {
        pointsBefore = { ...pointsAfter }
      }
      if (i === event2Index) {
        break
      }
    }
    
    return pointsBefore.home !== pointsAfter.home || pointsBefore.away !== pointsAfter.away
  }, [data?.events])

  // Get substitution history for a team in the current set
  const getSubstitutionHistory = useCallback((teamKey) => {
    if (!data?.events || !data?.set) return []
    
    const substitutions = data.events
      .filter(e => e.type === 'substitution' && e.payload?.team === teamKey && e.setIndex === data.set.index)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts))
      .map((e, idx) => ({
        ...e,
        index: idx,
        eventIndex: data.events.findIndex(ev => ev.id === e.id)
      }))
    
    return substitutions
  }, [data?.events, data?.set])

  // Check if a player on court can be substituted
  const canPlayerBeSubstituted = useCallback((teamKey, playerNumber) => {
    if (!data?.events || !data?.set) return true
    
    // Get all substitutions for this team in current set
    const substitutions = getSubstitutionHistory(teamKey)
    
    // Check if this player was substituted in (meaning someone was substituted out for them)
    const substitutionsWherePlayerIn = substitutions.filter(s => 
      String(s.payload?.playerIn) === String(playerNumber)
    )
    
    if (substitutionsWherePlayerIn.length === 0) return true // Never substituted in, can be substituted
    
    // This player was substituted in, check if the original player can come back
    const lastSubstitution = substitutionsWherePlayerIn[substitutionsWherePlayerIn.length - 1]
    const originalPlayerOut = lastSubstitution.payload?.playerOut
    const lastSubstitutionIndex = lastSubstitution.eventIndex
    
    // Check if there was a point change since this substitution
    const eventsAfterSub = data.events
      .filter((e, idx) => idx > lastSubstitutionIndex && (e.setIndex || 1) === data.set.index)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    
    const pointAfterSub = eventsAfterSub.find(e => e.type === 'point')
    
    if (!pointAfterSub) return false // No point change since substitution, original player can't come back yet
    
    // Check if the original player has already come back in this set
    const hasComeBack = substitutions.some(s => 
      String(s.payload?.playerOut) === String(playerNumber) &&
      String(s.payload?.playerIn) === String(originalPlayerOut) &&
      new Date(s.ts) > new Date(lastSubstitution.ts)
    )
    
    if (hasComeBack) return false // Already came back once, can't come back again
    
    return true // Can be substituted (original player can come back)
  }, [data?.events, data?.set, getSubstitutionHistory])

  // Get available substitutes for a player being substituted out
  const getAvailableSubstitutes = useCallback((teamKey, playerOutNumber) => {
    if (!data) return []
    
    const benchPlayers = teamKey === 'home' 
      ? (leftIsHome ? leftTeamBench.benchPlayers : rightTeamBench.benchPlayers)
      : (leftIsHome ? rightTeamBench.benchPlayers : leftTeamBench.benchPlayers)
    
    // Filter out liberos
    let available = benchPlayers.filter(p => !p.libero || p.libero === '')
    
    // Get substitution history
    const substitutions = getSubstitutionHistory(teamKey)
    
    // Check if playerOut was previously substituted in (meaning someone was substituted out for them)
    const substitutionsWherePlayerIn = substitutions.filter(s => 
      String(s.payload?.playerIn) === String(playerOutNumber)
    )
    
    if (substitutionsWherePlayerIn.length > 0) {
      // This player was substituted in, so ONLY the player who was substituted out can come back for them
      const lastSubstitution = substitutionsWherePlayerIn[substitutionsWherePlayerIn.length - 1]
      const originalPlayerOut = lastSubstitution.payload?.playerOut
      
      // Check if there was a point change since this substitution
      const lastSubstitutionIndex = lastSubstitution.eventIndex
      const eventsAfterSub = data.events
        .filter((e, idx) => idx > lastSubstitutionIndex && (e.setIndex || 1) === data.set.index)
        .sort((a, b) => new Date(a.ts) - new Date(b.ts))
      
      const pointAfterSub = eventsAfterSub.find(e => e.type === 'point')
      
      if (pointAfterSub) {
        // There was a point change, so the original player can come back
        // But only if they haven't already come back in this set
        const hasComeBack = substitutions.some(s => 
          String(s.payload?.playerOut) === String(playerOutNumber) &&
          String(s.payload?.playerIn) === String(originalPlayerOut) &&
          new Date(s.ts) > new Date(lastSubstitution.ts)
        )
        
        if (!hasComeBack) {
          // Only the original player can substitute back
          const originalPlayer = benchPlayers.find(p => String(p.number) === String(originalPlayerOut))
          if (originalPlayer && !originalPlayer.libero) {
            return [originalPlayer] // Only this player is available
          }
        }
        // If already came back, no substitutes available
        return []
      } else {
        // No point change yet, no substitutes available
        return []
      }
    }
    
    // Player was not substituted in, so any bench player can substitute
    // But filter out players who were substituted out but can't come back yet (no point change)
    // And filter out players who already came back (got in and out again)
    available = available.filter(player => {
      const playerSubstitutions = substitutions.filter(s => 
        String(s.payload?.playerOut) === String(player.number)
      )
      
      if (playerSubstitutions.length === 0) return true // Never substituted, available
      
      const lastSubstitution = playerSubstitutions[playerSubstitutions.length - 1]
      const lastSubstitutionIndex = lastSubstitution.eventIndex
      
      // Check if player has already come back (got in and out again)
      const substitutionsAfterOut = substitutions.filter(s => 
        new Date(s.ts) > new Date(lastSubstitution.ts)
      )
      
      const hasComeBackIn = substitutionsAfterOut.some(s => 
        String(s.payload?.playerIn) === String(player.number)
      )
      
      if (hasComeBackIn) {
        // Player came back in - check if they went out again
        const lastComeBack = substitutionsAfterOut
          .filter(s => String(s.payload?.playerIn) === String(player.number))
          .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0]
        
        const wentOutAgain = substitutionsAfterOut.some(s => 
          String(s.payload?.playerOut) === String(player.number) &&
          new Date(s.ts) > new Date(lastComeBack.ts)
        )
        
        if (wentOutAgain) return false // Player came in and out again, cannot come back a second time
      }
      
      // If never came back, check if they have a point change to allow coming back
      if (hasComeBackIn) return false // Already came back (and still on court), not available
      
      const eventsAfterSub = data.events
        .filter((e, idx) => idx > lastSubstitutionIndex && (e.setIndex || 1) === data.set.index)
        .sort((a, b) => new Date(a.ts) - new Date(b.ts))
      
      const pointAfterSub = eventsAfterSub.find(e => e.type === 'point')
      
      return !!pointAfterSub // Only available if there was a point change
    })
    
    return available.sort((a, b) => (a.number || 0) - (b.number || 0))
  }, [data, leftIsHome, leftTeamBench, rightTeamBench, getSubstitutionHistory])

  // Check if a bench player can come back (was substituted out, has point change, hasn't come back yet)
  const canPlayerComeBack = useCallback((teamKey, playerNumber) => {
    if (!data?.events || !data?.set) return false
    
    const substitutions = getSubstitutionHistory(teamKey)
    
    // Check if this player was substituted out
    const playerSubstitutions = substitutions.filter(s => 
      String(s.payload?.playerOut) === String(playerNumber)
    )
    
    if (playerSubstitutions.length === 0) return false // Never substituted out
    
    const lastSubstitution = playerSubstitutions[playerSubstitutions.length - 1]
    const lastSubstitutionIndex = lastSubstitution.eventIndex
    
    // Check if there was a point change since substitution
    const eventsAfterSub = data.events
      .filter((e, idx) => idx > lastSubstitutionIndex && (e.setIndex || 1) === data.set.index)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    
    const pointAfterSub = eventsAfterSub.find(e => e.type === 'point')
    
    if (!pointAfterSub) return false // No point change yet
    
    // Check if player has already come back
    const hasComeBack = substitutions.some(s => 
      String(s.payload?.playerIn) === String(playerNumber) &&
      new Date(s.ts) > new Date(lastSubstitution.ts)
    )
    
    if (hasComeBack) return false // Already came back
    
    return true // Can come back
  }, [data?.events, data?.set, getSubstitutionHistory])

  // Check if a bench player already came back (got in and out again)
  const hasPlayerComeBack = useCallback((teamKey, playerNumber) => {
    if (!data?.events || !data?.set) return false
    
    const substitutions = getSubstitutionHistory(teamKey)
    
    // Check if this player was substituted in (meaning they came in)
    const playerSubstitutionsIn = substitutions.filter(s => 
      String(s.payload?.playerIn) === String(playerNumber)
    )
    
    if (playerSubstitutionsIn.length === 0) return false // Never substituted in
    
    // Check if after being substituted in, they were substituted out
    const lastSubstitutionIn = playerSubstitutionsIn[playerSubstitutionsIn.length - 1]
    const lastSubstitutionInIndex = lastSubstitutionIn.eventIndex
    
    // Check if player was substituted out after being substituted in
    const hasBeenSubstitutedOut = substitutions.some(s => 
      String(s.payload?.playerOut) === String(playerNumber) &&
      data.events.findIndex(e => e.id === s.id) > lastSubstitutionInIndex
    )
    
    return hasBeenSubstitutedOut
  }, [data?.events, data?.set, getSubstitutionHistory])

  // Get libero currently on court for a team
  const getLiberoOnCourt = useCallback((teamKey) => {
    const { currentLineup, positionLiberoMap } = getTeamLineupState(teamKey)
    if (!currentLineup || !positionLiberoMap) return null

    for (const [position, info] of Object.entries(positionLiberoMap)) {
      if (!info) continue
      const numberOnCourt = currentLineup[position]
      if (String(numberOnCourt) === String(info.liberoNumber)) {
        return {
          position,
          liberoNumber: info.liberoNumber,
          liberoType: info.liberoType,
          playerNumber: info.playerNumber
        }
      }
    }

    return null
  }, [getTeamLineupState])

  // Check if there has been a point since last libero exchange
  const hasPointSinceLastLiberoExchange = useCallback((teamKey) => {
    if (!data?.events || !data?.set) return false
    
    // Find last libero entry, exit, or exchange event
    const liberoEvents = data.events.filter(e => 
      (e.type === 'libero_entry' || e.type === 'libero_exit' || e.type === 'libero_exchange') && 
      e.payload?.team === teamKey && 
      e.setIndex === data.set.index
    ).sort((a, b) => new Date(b.ts) - new Date(a.ts))
    
    if (liberoEvents.length === 0) return true // No libero exchange yet, allow
    
    const lastLiberoEvent = liberoEvents[0]
    const lastLiberoEventIndex = data.events.findIndex(e => e.id === lastLiberoEvent.id)
    
    // Check if there's been a point since then
    const eventsAfter = data.events.slice(lastLiberoEventIndex + 1).filter(e => 
      e.setIndex === data.set.index && e.type === 'point'
    )
    
    return eventsAfter.length > 0
  }, [data?.events, data?.set])

  // Handle player click for substitution/libero (only when rally is not in play and lineup is set)
  const handlePlayerClick = useCallback((teamKey, position, playerNumber, event) => {
    // Only allow substitution/libero when rally is not in play and lineup is set
    if (rallyStatus !== 'idle') return
    if (!leftTeamLineupSet && teamKey === (leftIsHome ? 'home' : 'away')) return
    if (!rightTeamLineupSet && teamKey === (leftIsHome ? 'away' : 'home')) return
    if (!playerNumber || playerNumber === '') return // Can't substitute placeholder
    
    // Check if this player is a libero - liberos cannot be substituted
    const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
    const clickedPlayer = teamPlayers?.find(p => String(p.number) === String(playerNumber))
    if (clickedPlayer?.libero && clickedPlayer.libero !== '') {
      // Clicking on a libero - no substitution allowed
      return
    }
    
    // Check if position is back row (I, V, VI) for libero
    const isBackRow = position === 'I' || position === 'V' || position === 'VI'
    
    // Check if this position is serving
    const currentServe = getCurrentServe()
    const teamServes = currentServe === teamKey
    const isServing = teamServes && position === 'I'
    
    // Get team players to check for liberos
    const liberos = teamPlayers?.filter(p => p.libero && p.libero !== '') || []
    
    // Check if a libero is already on court
    const liberoOnCourt = getLiberoOnCourt(teamKey)
    const canEnterLibero = liberos.length > 0 && (liberoOnCourt === null || liberoOnCourt === undefined)
    
    // Check if there has been a point since last libero exchange
    const hasPointSinceLibero = hasPointSinceLastLiberoExchange(teamKey)
    
    // If back row and not serving, show both substitution and libero options
    // But only allow libero if there's been a point since last libero action
    if (isBackRow && !isServing && canEnterLibero && hasPointSinceLibero) {
      // Close any existing dropdowns
      if (substitutionDropdown || liberoDropdown) {
        setSubstitutionDropdown(null)
        setLiberoDropdown(null)
        return
      }
      
      // Check substitution limit (6 per set)
      const teamSubstitutions = substitutionsUsed?.[teamKey] || 0
      const canSubstitute = teamSubstitutions < 6 && canPlayerBeSubstituted(teamKey, playerNumber)
      
      // Get the clicked element position
      const element = event.currentTarget
      const rect = element.getBoundingClientRect()
      
      // Show both dropdowns at the same time with a small delay to ensure they render together
      setTimeout(() => {
        if (canSubstitute) {
          setSubstitutionDropdown({ 
            team: teamKey, 
            position, 
            playerNumber, 
            element,
            x: rect.left + rect.width / 2,
            y: rect.bottom + 8
          })
        }
        setLiberoDropdown({ 
          team: teamKey, 
          position, 
          playerNumber, 
          element,
          x: rect.left + rect.width / 2,
          y: rect.bottom + 8
        })
      }, 0)
      return
    }
    
    // For front row or serving position, only show substitution
    // Check substitution limit (6 per set)
    const teamSubstitutions = substitutionsUsed?.[teamKey] || 0
    if (teamSubstitutions >= 6) return
    
    // Check if player can be substituted (rule: if substituted out, need point change)
    if (!canPlayerBeSubstituted(teamKey, playerNumber)) return
    
    // Close any existing dropdown
    if (substitutionDropdown) {
      setSubstitutionDropdown(null)
      return
    }
    
    // Get the clicked element position
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    setSubstitutionDropdown({ 
      team: teamKey, 
      position, 
      playerNumber, 
      element,
      x: rect.left + rect.width / 2,
      y: rect.bottom + 8
    })
  }, [rallyStatus, leftTeamLineupSet, rightTeamLineupSet, leftIsHome, substitutionDropdown, liberoDropdown, substitutionsUsed, canPlayerBeSubstituted, getCurrentServe, getLiberoOnCourt, hasPointSinceLastLiberoExchange, data?.homePlayers, data?.awayPlayers])

  // Show substitution confirmation
  const showSubstitutionConfirm = useCallback((substituteNumber) => {
    if (!substitutionDropdown || !substituteNumber) return
    setSubstitutionConfirm({
      team: substitutionDropdown.team,
      position: substitutionDropdown.position,
      playerOut: substitutionDropdown.playerNumber,
      playerIn: substituteNumber
    })
    setSubstitutionDropdown(null)
    setLiberoDropdown(null) // Close libero dropdown when selecting substitution
  }, [substitutionDropdown])

  // Confirm substitution
  const confirmSubstitution = useCallback(async () => {
    if (!substitutionConfirm || !data?.set) return
    
    const { team, position, playerOut, playerIn } = substitutionConfirm
    
    // Get current lineup for this team in the current set
    const lineupEvents = data.events?.filter(e => 
      e.type === 'lineup' && 
      e.payload?.team === team && 
      e.setIndex === data.set.index
    ) || []
    const lineupEvent = lineupEvents.length > 0 ? lineupEvents[lineupEvents.length - 1] : null
    const currentLineup = lineupEvent?.payload?.lineup || {}
    
    // Create new lineup with substitution
    const newLineup = { ...currentLineup }
    newLineup[position] = String(playerIn)
    
    // Save the updated lineup (mark as from substitution)
    const timestamp = new Date().toISOString()
    await db.events.add({
      matchId,
      setIndex: data.set.index,
      type: 'lineup',
      payload: { team, lineup: newLineup, fromSubstitution: true },
      ts: timestamp
    })
    
    // Log the substitution event
    await logEvent('substitution', { 
      team, 
      position, 
      playerOut, 
      playerIn 
    })
    
    setSubstitutionConfirm(null)
    setLiberoDropdown(null) // Close libero dropdown when confirming substitution
  }, [substitutionConfirm, data?.set, data?.events, matchId, logEvent])

  const cancelSubstitution = useCallback(() => {
    setSubstitutionDropdown(null)
    setLiberoDropdown(null) // Close both together
  }, [])

  const cancelSubstitutionConfirm = useCallback(() => {
    setSubstitutionConfirm(null)
    setLiberoDropdown(null) // Close libero dropdown when canceling substitution
  }, [])

  // Show libero confirmation
  const showLiberoConfirm = useCallback((liberoType) => {
    if (!liberoDropdown || !liberoType) return
    setLiberoConfirm({
      team: liberoDropdown.team,
      position: liberoDropdown.position,
      playerOut: liberoDropdown.playerNumber,
      liberoIn: liberoType
    })
    setLiberoDropdown(null)
    setSubstitutionDropdown(null) // Close substitution dropdown when selecting libero
  }, [liberoDropdown])

  // Confirm libero entry
  const confirmLibero = useCallback(async () => {
    if (!liberoConfirm || !data?.set) return
    
    const { team, position, playerOut, liberoIn } = liberoConfirm
    
    // Validate that liberos can only enter back-row positions (I, V, VI)
    const isBackRow = position === 'I' || position === 'V' || position === 'VI'
    if (!isBackRow) {
      alert('Liberos can only enter back-row positions (I, V, VI)')
      setLiberoConfirm(null)
      setLiberoDropdown(null)
      return
    }
    
    // Get current lineup for this team in the current set
    const lineupEvents = data.events?.filter(e => 
      e.type === 'lineup' && 
      e.payload?.team === team && 
      e.setIndex === data.set.index
    ) || []
    const lineupEvent = lineupEvents.length > 0 ? lineupEvents[lineupEvents.length - 1] : null
    const currentLineup = lineupEvent?.payload?.lineup || {}
    
    // Get libero player number
    const teamPlayers = team === 'home' ? data?.homePlayers : data?.awayPlayers
    const liberoPlayer = teamPlayers?.find(p => p.libero === liberoIn)
    if (!liberoPlayer) {
      console.error('Libero not found')
      return
    }
    
    // Create new lineup with libero entry
    const newLineup = { ...currentLineup }
    newLineup[position] = String(liberoPlayer.number)
    
    // Save the updated lineup with libero substitution info
    const timestamp = new Date().toISOString()
    await db.events.add({
      matchId,
      setIndex: data.set.index,
      type: 'lineup',
      payload: { 
        team, 
        lineup: newLineup,
        liberoSubstitution: {
          position,
          liberoNumber: liberoPlayer.number,
          playerNumber: playerOut,
          liberoType: liberoIn
        }
      },
      ts: timestamp
    })
    
    // Log the libero entry event
    await logEvent('libero_entry', { 
      team, 
      position, 
      playerOut, 
      liberoIn: liberoPlayer.number,
      liberoType: liberoIn
    })
    
    setLiberoConfirm(null)
    setSubstitutionDropdown(null) // Close substitution dropdown if open
    setLiberoDropdown(null) // Close libero dropdown if open
  }, [liberoConfirm, data?.set, data?.events, data?.homePlayers, data?.awayPlayers, matchId, logEvent])

  const cancelLibero = useCallback(() => {
    setLiberoDropdown(null)
    setSubstitutionDropdown(null) // Close both together
  }, [])

  const cancelLiberoConfirm = useCallback(() => {
    setLiberoConfirm(null)
    setSubstitutionDropdown(null) // Close substitution dropdown if open
    setLiberoDropdown(null) // Close libero dropdown if open
  }, [])

  // Handle libero reentry (when opposite player is in position I and not serving)
  const confirmLiberoReentry = useCallback(async () => {
    if (!liberoReentryModal || !data?.set) return
    
    const { team, position, playerNumber, liberoNumber, liberoType } = liberoReentryModal
    const playerOut = playerNumber // For consistency with other libero entry logic
    
    // Get current lineup for this team in the current set
    const lineupEvents = data.events?.filter(e => 
      e.type === 'lineup' && 
      e.payload?.team === team && 
      e.setIndex === data.set.index
    ) || []
    const lineupEvent = lineupEvents.length > 0 ? lineupEvents[lineupEvents.length - 1] : null
    const currentLineup = lineupEvent?.payload?.lineup || {}
    
    // Create new lineup with libero entry
    const newLineup = { ...currentLineup }
    newLineup[position] = String(liberoNumber)
    
    // Save the updated lineup with libero substitution info
    const timestamp = new Date().toISOString()
    await db.events.add({
      matchId,
      setIndex: data.set.index,
      type: 'lineup',
      payload: { 
        team, 
        lineup: newLineup,
        liberoSubstitution: {
          position,
          liberoNumber: liberoNumber,
          playerNumber: playerOut,
          liberoType: liberoType
        }
      },
      ts: timestamp
    })
    
    // Log the libero entry event
    await logEvent('libero_entry', { 
      team, 
      position, 
      playerOut, 
      liberoIn: liberoNumber,
      liberoType: liberoType
    })
    
    setLiberoReentryModal(null)
  }, [liberoReentryModal, data?.set, data?.events, matchId, logEvent])

  const cancelLiberoReentry = useCallback(() => {
    setLiberoReentryModal(null)
  }, [])

  // Handle libero out
  const handleLiberoOut = useCallback(async (side) => {
    if (rallyStatus !== 'idle') return
    
    const teamKey = mapSideToTeamKey(side)
    const liberoOnCourt = getLiberoOnCourt(teamKey)
    
    if (!liberoOnCourt) {
      alert('No libero is currently on court')
      return
    }
    
    // Check if there has been a point since last libero exchange
    if (!hasPointSinceLastLiberoExchange(teamKey)) {
      alert('A point must be awarded before removing the libero')
      return
    }
    
    // Get current lineup
    const lineupEvents = data.events.filter(e => 
      e.type === 'lineup' && 
      e.payload?.team === teamKey && 
      e.setIndex === data.set.index
    )
    const currentLineup = lineupEvents[lineupEvents.length - 1]?.payload?.lineup || {}
    
    // Determine the original player that should replace the libero
    let originalPlayerNumber = liberoOnCourt.playerNumber
    if (!originalPlayerNumber && lineupEvents.length > 0) {
      // Look through previous lineup events to find the most recent non-libero player at this position
      const sortedLineupEvents = [...lineupEvents].sort((a, b) => new Date(b.ts) - new Date(a.ts)) // Most recent first
      const teamPlayers = teamKey === 'home' ? data.homePlayers : data.awayPlayers
      for (const event of sortedLineupEvents) {
        const lineup = event.payload?.lineup
        if (!lineup) continue
        const playerNumberAtPosition = lineup[liberoOnCourt.position]
        if (!playerNumberAtPosition) continue
        if (String(playerNumberAtPosition) !== String(liberoOnCourt.liberoNumber)) {
          originalPlayerNumber = Number(playerNumberAtPosition)
          break
        }
        // If this event has libero substitution info, use the stored original player
        if (event.payload?.liberoSubstitution &&
            String(event.payload.liberoSubstitution.liberoNumber) === String(liberoOnCourt.liberoNumber) &&
            event.payload.liberoSubstitution.position === liberoOnCourt.position) {
          originalPlayerNumber = event.payload.liberoSubstitution.playerNumber
          break
        }
      }
    }
    
    if (!originalPlayerNumber) {
      console.warn('Could not determine original player for libero out action', { teamKey, liberoOnCourt })
      alert('Original player not found for this libero. Please update lineup manually.')
      return
    }
    
    // Restore the original player
    const newLineup = { ...currentLineup }
    newLineup[liberoOnCourt.position] = String(originalPlayerNumber)
    
    // Save the updated lineup (explicitly without libero substitution)
    const timestamp = new Date().toISOString()
    await db.events.add({
      matchId,
      setIndex: data.set.index,
      type: 'lineup',
      payload: { 
        team: teamKey, 
        lineup: newLineup,
        liberoSubstitution: null // Explicitly clear libero substitution
      },
      ts: timestamp
    })
    
    // Log the libero exit event
    await logEvent('libero_exit', {
      team: teamKey,
      position: liberoOnCourt.position,
      liberoOut: liberoOnCourt.liberoNumber,
      playerIn: originalPlayerNumber,
      liberoType: liberoOnCourt.liberoType
    })
  }, [rallyStatus, mapSideToTeamKey, getLiberoOnCourt, hasPointSinceLastLiberoExchange, data?.events, data?.set, matchId, logEvent, data?.homePlayers, data?.awayPlayers])

  // Handle exchange libero (L1 <-> L2)
  const handleExchangeLibero = useCallback(async (side) => {
    if (rallyStatus !== 'idle') return
    
    const teamKey = mapSideToTeamKey(side)
    const liberoOnCourt = getLiberoOnCourt(teamKey)
    
    if (!liberoOnCourt) {
      alert('No libero is currently on court')
      return
    }
    
    // Check if there has been a point since last libero exchange
    if (!hasPointSinceLastLiberoExchange(teamKey)) {
      alert('A point must be awarded before exchanging liberos')
      return
    }
    
    // Get the other libero
    const teamPlayers = teamKey === 'home' ? data.homePlayers : data.awayPlayers
    const otherLibero = teamPlayers?.find(p => 
      p.libero && 
      p.libero !== '' && 
      String(p.number) !== String(liberoOnCourt.liberoNumber) &&
      (liberoOnCourt.liberoType === 'libero1' ? p.libero === 'libero2' : p.libero === 'libero1')
    )
    
    if (!otherLibero) {
      alert('Other libero not found')
      return
    }
    
    // Get current lineup
    const lineupEvents = data.events.filter(e => 
      e.type === 'lineup' && 
      e.payload?.team === teamKey && 
      e.setIndex === data.set.index
    )
    const currentLineup = lineupEvents[lineupEvents.length - 1].payload?.lineup
    
    // Replace current libero with other libero
    const newLineup = { ...currentLineup }
    newLineup[liberoOnCourt.position] = String(otherLibero.number)
    
    // Save the updated lineup with libero substitution info
    const timestamp = new Date().toISOString()
    await db.events.add({
      matchId,
      setIndex: data.set.index,
      type: 'lineup',
      payload: { 
        team: teamKey, 
        lineup: newLineup,
        liberoSubstitution: {
          position: liberoOnCourt.position,
          liberoNumber: otherLibero.number,
          playerNumber: liberoOnCourt.playerNumber,
          liberoType: otherLibero.libero
        }
      },
      ts: timestamp
    })
    
    // Log the libero exchange event
    await logEvent('libero_exchange', {
      team: teamKey,
      position: liberoOnCourt.position,
      liberoOut: liberoOnCourt.liberoNumber,
      liberoIn: otherLibero.number,
      liberoOutType: liberoOnCourt.liberoType,
      liberoInType: otherLibero.libero,
      playerNumber: liberoOnCourt.playerNumber
    })
  }, [rallyStatus, mapSideToTeamKey, getLiberoOnCourt, hasPointSinceLastLiberoExchange, data?.events, data?.set, data?.homePlayers, data?.awayPlayers, matchId, logEvent])

  const sanctionButtonStyles = useMemo(() => ({
    improper: {
      flex: 1,
      fontSize: '10px',
      padding: '8px 4px',
      background: 'rgba(156, 163, 175, 0.25)',
      border: '1px solid rgba(156, 163, 175, 0.5)',
      color: '#d1d5db',
      fontWeight: 600,
      boxShadow: '0 0 0 1px rgba(255,255,255,0.05)'
    },
    delayWarning: {
      flex: 1,
      fontSize: '10px',
      padding: '8px 4px',
      background: 'rgba(234, 179, 8, 0.2)',
      border: '1px solid rgba(234, 179, 8, 0.4)',
      color: '#facc15',
      fontWeight: 600,
      boxShadow: '0 0 0 1px rgba(250, 204, 21, 0.15)'
    },
    delayPenalty: {
      flex: 1,
      fontSize: '10px',
      padding: '8px 4px',
      background: 'rgba(239, 68, 68, 0.2)',
      border: '1px solid rgba(239, 68, 68, 0.4)',
      color: '#f87171',
      fontWeight: 600,
      boxShadow: '0 0 0 1px rgba(248, 113, 113, 0.2)'
    }
  }), [])

  if (!data?.set) {
    return <p>Loading…</p>
  }

  const teamALabel = leftTeam.isTeamA ? 'A' : 'B'
  const teamBLabel = rightTeam.isTeamA ? 'A' : 'B'

  return (
    <div className="match-record">
      <div className="match-toolbar">
        <div className="toolbar-left">
          <button className="secondary" onClick={() => (onOpenSetup ? onOpenSetup() : null)}>
            Home
          </button>
          <div className="toolbar-divider" />
          <div className={`status-indicator status-${syncStatus}`}>
            <span className="status-dot" />
            <span>
              {syncStatus === 'offline' && 'Offline'}
              {syncStatus === 'online_no_supabase' && 'Online (No Supabase)'}
              {syncStatus === 'connecting' && 'Connecting...'}
              {syncStatus === 'syncing' && 'Syncing...'}
              {syncStatus === 'synced' && 'Synced'}
              {syncStatus === 'error' && 'Sync Error'}
            </span>
      </div>
          <div className="toolbar-divider" />
          <span className="toolbar-clock">{formatTimestamp(now)}</span>
        </div>
        <div className="toolbar-center">
          <div style={{ width: '100%' }}></div>
        </div>
        <div className="toolbar-actions">
          {onOpenMatchSetup && (
            <button className="secondary" onClick={onOpenMatchSetup}>
              Show match setup
            </button>
          )}
          {onOpenCoinToss && (
            <button className="secondary" onClick={onOpenCoinToss}>
              Show coin toss
            </button>
          )}
          <button className="secondary" onClick={() => setShowRosters(v => !v)}>
            {showRosters ? 'Hide rosters' : 'Show rosters'}
          </button>
        </div>
      </div>

      {showRosters && (() => {
        // Separate players and liberos
        const homePlayers = (data.homePlayers || []).filter(p => !p.libero).sort((a, b) => (a.number || 0) - (b.number || 0))
        const homeLiberos = (data.homePlayers || [])
          .filter(p => p.libero)
          .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0))
        const awayPlayers = (data.awayPlayers || []).filter(p => !p.libero).sort((a, b) => (a.number || 0) - (b.number || 0))
        const awayLiberos = (data.awayPlayers || [])
          .filter(p => p.libero)
          .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0))
        
        // Pad arrays to same length for alignment
        const maxPlayers = Math.max(homePlayers.length, awayPlayers.length)
        const maxLiberos = Math.max(homeLiberos.length, awayLiberos.length)
        
        const paddedHomePlayers = [...homePlayers, ...Array(maxPlayers - homePlayers.length).fill(null)]
        const paddedAwayPlayers = [...awayPlayers, ...Array(maxPlayers - awayPlayers.length).fill(null)]
        const paddedHomeLiberos = [...homeLiberos, ...Array(maxLiberos - homeLiberos.length).fill(null)]
        const paddedAwayLiberos = [...awayLiberos, ...Array(maxLiberos - awayLiberos.length).fill(null)]
        
        // Bench officials - sorted by hierarchy: C, AC1, AC2, P, M
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
        const homeBench = sortBenchByHierarchy((data?.match?.bench_home || []).filter(b => b.firstName || b.lastName || b.dob))
        const awayBench = sortBenchByHierarchy((data?.match?.bench_away || []).filter(b => b.firstName || b.lastName || b.dob))
        const maxBench = Math.max(homeBench.length, awayBench.length)
        const paddedHomeBench = [...homeBench, ...Array(maxBench - homeBench.length).fill(null)]
        const paddedAwayBench = [...awayBench, ...Array(maxBench - awayBench.length).fill(null)]

  return (
          <div className="roster-panel">
            {/* Players Section */}
            <div className="roster-tables">
              <div className="roster-table-wrapper">
                <h3>{data.homeTeam?.name || 'Home'} Players</h3>
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
                      <tr key={player?.id || `empty-${idx}`}>
                        {player ? (
                          <>
                            <td className="roster-number">
                              <span>{player.number ?? '—'}</span>
                              <span className="roster-role">
                                {player.isCaptain && <span className="roster-badge captain">C</span>}
                              </span>
                            </td>
                            <td className="roster-name">
                              {player.lastName || player.name} {player.firstName}
                            </td>
                            <td className="roster-dob">{player.dob || '—'}</td>
                          </>
                        ) : (
                          <td colSpan="3" style={{ height: '40px' }}></td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="roster-table-wrapper">
                <h3>{data.awayTeam?.name || 'Away'} Players</h3>
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
                      <tr key={player?.id || `empty-${idx}`}>
                        {player ? (
                          <>
                            <td className="roster-number">
                              <span>{player.number ?? '—'}</span>
                              <span className="roster-role">
                                {player.isCaptain && <span className="roster-badge captain">C</span>}
                              </span>
                            </td>
                            <td className="roster-name">
                              {player.lastName || player.name} {player.firstName}
                            </td>
                            <td className="roster-dob">{player.dob || '—'}</td>
                          </>
                        ) : (
                          <td colSpan="3" style={{ height: '40px' }}></td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            
            {/* Liberos Section */}
            {(maxLiberos > 0) && (
              <div className="roster-tables" style={{ marginTop: '24px' }}>
                <div className="roster-table-wrapper">
                  <h3>{data.homeTeam?.name || 'Home'} Liberos</h3>
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
                        <tr key={player?.id || `empty-libero-${idx}`}>
                          {player ? (
                            <>
                              <td className="roster-number">
                                <span>{player.number ?? '—'}</span>
                                <span className="roster-role">
                                  {player.libero === 'libero1' && <span className="roster-badge libero">L1</span>}
                                  {player.libero === 'libero2' && <span className="roster-badge libero">L2</span>}
                                  {player.isCaptain && <span className="roster-badge captain">C</span>}
                                </span>
                              </td>
                              <td className="roster-name">
                                {player.lastName || player.name} {player.firstName}
                              </td>
                              <td className="roster-dob">{player.dob || '—'}</td>
                            </>
                          ) : (
                            <td colSpan="3" style={{ height: '40px' }}></td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="roster-table-wrapper">
                  <h3>{data.awayTeam?.name || 'Away'} Liberos</h3>
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
                        <tr key={player?.id || `empty-libero-${idx}`}>
                          {player ? (
                            <>
                              <td className="roster-number">
                                <span>{player.number ?? '—'}</span>
                                <span className="roster-role">
                                  {player.libero === 'libero1' && <span className="roster-badge libero">L1</span>}
                                  {player.libero === 'libero2' && <span className="roster-badge libero">L2</span>}
                                  {player.isCaptain && <span className="roster-badge captain">C</span>}
                                </span>
                              </td>
                              <td className="roster-name">
                                {player.lastName || player.name} {player.firstName}
                              </td>
                              <td className="roster-dob">{player.dob || '—'}</td>
                            </>
                          ) : (
                            <td colSpan="3" style={{ height: '40px' }}></td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {/* Bench Officials Section */}
            <div className="bench-officials-section" style={{ marginTop: '32px', paddingTop: '24px', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
              <div className="roster-tables">
                <div className="roster-table-wrapper">
                  <h3>{data.homeTeam?.name || 'Home'} Bench Officials</h3>
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
                        <tr key={official ? `home-bench-${idx}` : `empty-bench-${idx}`}>
                          {official ? (
                            <>
                              <td style={{ textTransform: 'capitalize', fontWeight: 500 }}>{official.role || '—'}</td>
                              <td>{official.lastName || ''} {official.firstName || ''}</td>
                              <td>{official.dob || '—'}</td>
                            </>
                          ) : (
                            <td colSpan="3" style={{ height: '40px' }}></td>
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
                <div className="roster-table-wrapper">
                  <h3>{data.awayTeam?.name || 'Away'} Bench Officials</h3>
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
                        <tr key={official ? `away-bench-${idx}` : `empty-bench-${idx}`}>
                          {official ? (
                            <>
                              <td style={{ textTransform: 'capitalize', fontWeight: 500 }}>{official.role || '—'}</td>
                              <td>{official.lastName || ''} {official.firstName || ''}</td>
                              <td>{official.dob || '—'}</td>
                            </>
                          ) : (
                            <td colSpan="3" style={{ height: '40px' }}></td>
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
            {(data?.match?.officials && data.match.officials.length > 0) && (
              <div className="officials-section" style={{ marginTop: '32px', paddingTop: '24px', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                <h3 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 600, color: 'var(--text)' }}>Match Officials</h3>
                <table className="roster-table">
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Name</th>
                      <th>Country</th>
                      <th>DOB</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.match.officials.map((official, idx) => (
                      <tr key={idx}>
                        <td style={{ textTransform: 'capitalize', fontWeight: 500 }}>{official.role || '—'}</td>
                        <td>{official.lastName || ''} {official.firstName || ''}</td>
                        <td>{official.country || '—'}</td>
                        <td>{official.dob || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
    </div>
  )
      })()}

      <div className="match-content">
        <aside className="team-controls">
          <div className="team-info">
            <span
              className="team-badge"
              style={{
                background: leftTeam.color || '#ef4444',
                color: isBrightColor(leftTeam.color || '#ef4444') ? '#000' : '#fff'
              }}
            >
              {teamALabel}
            </span>
            <h3>{leftTeam.name}</h3>
          </div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <div style={{ 
              flex: 1, 
              background: 'rgba(255, 255, 255, 0.05)', 
              borderRadius: '8px', 
              padding: '12px',
              textAlign: 'center',
              border: '1px solid rgba(255, 255, 255, 0.1)'
            }}>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>TO</div>
              <div style={{ 
                fontSize: '24px', 
                fontWeight: 700,
                color: getTimeoutsUsed('left') >= 2 ? '#ef4444' : 'inherit'
              }}>{getTimeoutsUsed('left')}</div>
            </div>
            <div style={{ 
              flex: 1, 
              background: 'rgba(255, 255, 255, 0.05)', 
              borderRadius: '8px', 
              padding: '12px',
              textAlign: 'center',
              border: '1px solid rgba(255, 255, 255, 0.1)'
            }}>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>SUB</div>
              <div style={{ 
                fontSize: '24px', 
                fontWeight: 700,
                color: getSubstitutionsUsed('left') >= 6 ? '#ef4444' : getSubstitutionsUsed('left') >= 5 ? '#eab308' : 'inherit'
              }}>{getSubstitutionsUsed('left')}</div>
            </div>
          </div>
          <button
            onClick={() => handleTimeout('left')}
            disabled={getTimeoutsUsed('left') >= 2 || rallyStatus === 'in_play'}
            style={{ width: '100%', marginBottom: '8px' }}
          >
            Time-out
          </button>
          <button 
            onClick={() => handleLiberoOut('left')}
            disabled={rallyStatus === 'in_play' || !getLiberoOnCourt(leftIsHome ? 'home' : 'away') || !hasPointSinceLastLiberoExchange(leftIsHome ? 'home' : 'away')}
          >
            Libero out
          </button>
          <button 
            onClick={() => handleExchangeLibero('left')}
            disabled={(() => {
              const teamKey = leftIsHome ? 'home' : 'away'
              const teamPlayers = leftIsHome ? data?.homePlayers : data?.awayPlayers
              const liberos = teamPlayers?.filter(p => p.libero && p.libero !== '') || []
              return rallyStatus === 'in_play' || 
                     !getLiberoOnCourt(teamKey) || 
                     !hasPointSinceLastLiberoExchange(teamKey) ||
                     liberos.length < 2 // Disable if team has less than 2 liberos
            })()}
          >
            Exchange libero
          </button>
          
          {/* Sanctions: Improper Request, Delay Warning, Delay Penalty */}
          <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
            {!data?.match?.sanctions?.improperRequestLeft && (
              <button
                onClick={() => handleImproperRequest('left')}
                disabled={rallyStatus === 'in_play'}
                style={sanctionButtonStyles.improper}
              >
                Improper Request
              </button>
            )}
            {!data?.match?.sanctions?.delayWarningLeft ? (
              <button
                onClick={() => handleDelayWarning('left')}
                disabled={rallyStatus === 'in_play'}
                style={sanctionButtonStyles.delayWarning}
              >
                Delay Warning
              </button>
            ) : (
              <button
                onClick={() => handleDelayPenalty('left')}
                disabled={rallyStatus === 'in_play'}
                style={sanctionButtonStyles.delayPenalty}
              >
                Delay Penalty
              </button>
            )}
          </div>
          
          <button className="secondary" disabled>
            Injury
          </button>
          
          {/* Bench Players, Liberos, and Bench Officials */}
          <div style={{ marginTop: '24px', paddingTop: '24px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
            {/* Bench Players */}
            {leftTeamBench.benchPlayers.length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 600, color: 'var(--muted)' }}>Bench</h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {leftTeamBench.benchPlayers.map(player => {
                    const teamKey = leftIsHome ? 'home' : 'away'
                    const canComeBack = canPlayerComeBack(teamKey, player.number)
                    const hasComeBack = hasPlayerComeBack(teamKey, player.number)
                    const isSubstitutedByLibero = player.substitutedByLibero !== null
                    
                    // Check if player was substituted out but waiting for point to allow comeback
                    const substitutions = getSubstitutionHistory(teamKey)
                    const wasSubstitutedOut = substitutions.some(s => String(s.payload?.playerOut) === String(player.number))
                    const waitingForPoint = wasSubstitutedOut && !canComeBack && !hasComeBack
                    
                    return (
                      <div 
                        key={player.id} 
                        style={{ 
                          padding: '4px 8px', 
                          background: isSubstitutedByLibero ? '#FFF8E7' : (hasComeBack ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.05)'), 
                          borderRadius: '4px',
                          fontSize: '11px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          position: 'relative',
                          opacity: hasComeBack ? 0.4 : 1,
                          color: isSubstitutedByLibero ? '#000' : undefined
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{player.number}</span>
                        {player.isCaptain && (
                          <span style={{ color: isSubstitutedByLibero ? '#000' : 'var(--accent)', fontSize: '10px', fontWeight: 700 }}>C</span>
                        )}
                        {isSubstitutedByLibero && (
                          <span style={{ 
                            fontSize: '9px',
                            fontWeight: 700,
                            color: '#000',
                            background: 'rgba(255, 255, 255, 0.8)',
                            padding: '1px 3px',
                            borderRadius: '2px'
                          }}>
                            {player.substitutedByLibero.liberoType === 'libero1' ? 'L1' : 'L2'}
                          </span>
                        )}
                        {hasComeBack && (
                          <span 
                            style={{ 
                              fontSize: '9px',
                              lineHeight: '1',
                              background: 'rgba(15, 23, 42, 0.95)',
                              color: '#ef4444',
                              fontWeight: 700,
                              padding: '1px 3px',
                              borderRadius: '2px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              minWidth: '12px',
                              minHeight: '12px',
                              border: '1px solid rgba(255, 255, 255, 0.2)'
                            }}
                          >
                            ✕
                          </span>
                        )}
                        {(waitingForPoint || canComeBack) && !hasComeBack && (
                          <span 
                            style={{ 
                              fontSize: '7px',
                              lineHeight: '1',
                              display: 'flex',
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: '1px',
                              background: 'rgba(15, 23, 42, 0.95)',
                              padding: '1px 2px',
                              borderRadius: '2px',
                              minWidth: '14px',
                              minHeight: '12px',
                              justifyContent: 'center',
                              border: '1px solid rgba(255, 255, 255, 0.2)',
                              opacity: waitingForPoint ? 0.5 : 1
                            }}
                          >
                            <span style={{ color: '#22c55e', fontWeight: 900 }}>↑</span>
                            <span style={{ color: '#ef4444', fontWeight: 900 }}>↓</span>
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            
            {/* Liberos */}
            {leftTeamBench.liberos.length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 600, color: 'var(--muted)' }}>Liberos</h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {leftTeamBench.liberos.map(player => (
                    <div key={player.id} style={{ 
                      padding: '4px 8px', 
                      background: 'rgba(59, 130, 246, 0.2)', 
                      borderRadius: '4px',
                      fontSize: '11px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      border: '1px solid rgba(59, 130, 246, 0.3)'
                    }}>
                      <span style={{ fontWeight: 600 }}>{player.number}</span>
                      <span style={{ color: '#60a5fa', fontSize: '10px', fontWeight: 700 }}>
                        {player.libero === 'libero1' ? 'L1' : 'L2'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* Bench Officials */}
            {leftTeamBench.benchOfficials.length > 0 && (
              <div>
                <h4 style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 600, color: 'var(--muted)' }}>Bench Officials</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {leftTeamBench.benchOfficials.map((official, idx) => (
                    <div key={idx} style={{ 
                      padding: '4px 8px', 
                      background: 'rgba(255,255,255,0.05)', 
                      borderRadius: '4px',
                      fontSize: '11px'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: 600, color: 'var(--muted)', minWidth: '30px' }}>
                          {official.role === 'Coach' ? 'C' : 
                           official.role === 'Assistant Coach 1' ? 'AC1' :
                           official.role === 'Assistant Coach 2' ? 'AC2' :
                           official.role === 'Physiotherapist' ? 'P' :
                           official.role === 'Medic' ? 'M' : official.role}
                        </span>
                        <span>{official.lastName || ''} {official.firstName || ''}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>

        <section className="court-wrapper">
          <div className="set-summary">
            <div className="set-info">
              <h3 className="set-title">Set {data.set.index}</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', justifyContent: 'center', width: '100%' }}>
                {/* Previous set scores (only show if set > 1) */}
                {data.set.index > 1 && data.sets && (() => {
                  const previousSets = data.sets.filter(s => s.finished && s.index < data.set.index).sort((a, b) => b.index - a.index)
                  const leftTeamKey = leftIsHome ? 'home' : 'away'
                  const rightTeamKey = leftIsHome ? 'away' : 'home'
                  
                  return (
                    <>
                      {/* Left side previous sets */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-end', flex: '0 0 auto' }}>
                        {previousSets.map(set => {
                          const teamPoints = leftTeamKey === 'home' ? set.homePoints : set.awayPoints
                          const opponentPoints = leftTeamKey === 'home' ? set.awayPoints : set.homePoints
                          const won = teamPoints > opponentPoints
                          return (
                            <div key={set.id} style={{ 
                              fontSize: '12px', 
                              color: won ? '#3b82f6' : '#ef4444',
                              fontWeight: 600
                            }}>
                              Set {set.index} {teamPoints}:{opponentPoints}
                            </div>
                          )
                        })}
                      </div>
                      
                      {/* Current score - centered */}
                      {renderScoreDisplay({ flex: '0 0 auto' })}
                      
                      {/* Right side previous sets */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start', flex: '0 0 auto' }}>
                        {previousSets.map(set => {
                          const teamPoints = rightTeamKey === 'home' ? set.homePoints : set.awayPoints
                          const opponentPoints = rightTeamKey === 'home' ? set.awayPoints : set.homePoints
                          const won = teamPoints > opponentPoints
                          return (
                            <div key={set.id} style={{ 
                              fontSize: '12px', 
                              color: won ? '#3b82f6' : '#ef4444',
                              fontWeight: 600
                            }}>
                              Set {set.index} {teamPoints}:{opponentPoints}
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )
                })()}
                
                {/* If set 1, just show current score centered */}
                {data.set.index === 1 && renderScoreDisplay({ margin: '0 auto' })}
              </div>
            </div>
            <div>
              <span className="summary-label">Rally status:</span>
              <span className="summary-value" style={{ color: rallyStatus === 'in_play' ? '#4ade80' : '#fb923c' }}>
                {rallyStatus === 'in_play' ? 'In play' : 'Not in play'}
              </span>
            </div>
            {/* Last action */}
            {data?.events && data.events.length > 0 && (() => {
              // Find the last undoable event
              const allEvents = data.events.sort((a, b) => new Date(b.ts) - new Date(a.ts))
              const lastEvent = allEvents.find(e => {
                if (e.type === 'lineup') {
                  const hasInitial = e.payload?.isInitial === true
                  const hasSubstitution = e.payload?.fromSubstitution === true
                  return hasInitial || hasSubstitution
                }
                if (e.type === 'rally_start' || e.type === 'replay') return false
                return true
              })
              
              if (!lastEvent) return null
              
              const description = getActionDescription(lastEvent)
              if (!description || description === 'Unknown action') return null
              
              return (
                <div>
                  <span className="summary-label">Last action:</span>
                  <span className="summary-value" style={{ fontSize: '12px', color: 'var(--muted)' }}>
                    {description}
                  </span>
                </div>
              )
            })()}
          </div>

          <div className="court">
            <div className="court-attack-line court-attack-left" />
            <div className="court-attack-line court-attack-right" />
            {rallyStatus === 'idle' && isFirstRally && (
              <>
                {!leftTeamLineupSet && (
                  <button
                    className="lineup-button lineup-button-left"
                    onClick={() => setLineupModal({ team: leftIsHome ? 'home' : 'away', mode: 'initial' })}
                    style={{
                      position: 'absolute',
                      left: '25%',
                      top: '50%',
                      transform: 'translate(-50%, -50%)',
                      zIndex: 100,
                      width: '40%',
                      height: '80%',
                      padding: '0',
                      fontSize: 'clamp(20px, 4vw, 32px)',
                      fontWeight: 700,
                      background: 'var(--accent)',
                      color: '#000',
                      border: 'none',
                      borderRadius: '12px',
                      cursor: 'pointer',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                      animation: 'lineupFlash 1.5s ease-in-out infinite'
                    }}
                  >
                    Line-up
                  </button>
                )}
                {!rightTeamLineupSet && (
                  <button
                    className="lineup-button lineup-button-right"
                    onClick={() => setLineupModal({ team: leftIsHome ? 'away' : 'home', mode: 'initial' })}
                    style={{
                      position: 'absolute',
                      left: '75%',
                      top: '50%',
                      transform: 'translate(-50%, -50%)',
                      zIndex: 100,
                      width: '40%',
                      height: '80%',
                      padding: '0',
                      fontSize: 'clamp(20px, 4vw, 32px)',
                      fontWeight: 700,
                      background: 'var(--accent)',
                      color: '#000',
                      border: 'none',
                      borderRadius: '12px',
                      cursor: 'pointer',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                      animation: 'lineupFlash 1.5s ease-in-out infinite'
                    }}
                  >
                    Line-up
                  </button>
                )}
              </>
            )}
            <div className="court-side court-side-left">
              <div className="court-team court-team-left">
                <div className="court-row court-row-front">
                  {leftTeam.playersOnCourt.slice(0, 3).map(player => {
                    const teamKey = leftIsHome ? 'home' : 'away'
                    const teamSubstitutions = substitutionsUsed?.[teamKey] || 0
                    const canSubstitute = rallyStatus === 'idle' && leftTeamLineupSet && player.number && player.number !== '' && !player.isPlaceholder && teamSubstitutions < 6
                    return (
                      <div 
                        key={player.id} 
                        className="court-player"
                        onClick={(e) => canSubstitute && handlePlayerClick(teamKey, player.position, player.number, e)}
                        style={{ 
                          cursor: canSubstitute ? 'pointer' : 'default',
                          transition: 'transform 0.2s',
                          background: player.isLibero ? '#FFF8E7' : undefined,
                          color: player.isLibero ? '#000' : undefined,
                          position: 'relative'
                        }}
                        onMouseEnter={(e) => {
                          if (canSubstitute) {
                            e.currentTarget.style.transform = 'scale(1.05)'
                            e.currentTarget.style.boxShadow = '0 4px 12px rgba(255,255,255,0.2)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (canSubstitute) {
                            e.currentTarget.style.transform = 'scale(1)'
                            e.currentTarget.style.boxShadow = 'none'
                          }
                        }}
                      >
                        {player.substitutedPlayerNumber && (
                          <span style={{
                            position: 'absolute',
                            top: '-8px',
                            right: '-8px',
                            width: '18px',
                            height: '18px',
                            background: '#FFF8E7',
                            border: '2px solid rgba(0, 0, 0, 0.2)',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '10px',
                            fontWeight: 700,
                            color: '#000',
                            zIndex: 6
                          }}>
                            {player.substitutedPlayerNumber}
                          </span>
                        )}
                        <span className="court-player-position">{player.position}</span>
                        {player.isCaptain && (
                          <span className="court-player-captain">C</span>
                        )}
                        {player.number}
                      </div>
                    )
                  })}
                </div>
                <div className="court-row court-row-back">
                  {leftTeam.playersOnCourt.slice(3, 6).map(player => {
                    const leftTeamKey = leftIsHome ? 'home' : 'away'
                    const currentServe = getCurrentServe()
                    const leftTeamServes = currentServe === leftTeamKey
                    const shouldShowBall = player.position === 'I' && leftTeamServes
                    const teamSubstitutions = substitutionsUsed?.[leftTeamKey] || 0
                    const canSubstitute = rallyStatus === 'idle' && leftTeamLineupSet && player.number && player.number !== '' && !player.isPlaceholder && teamSubstitutions < 6
                    return (
                      <div 
                        key={player.id} 
                        className="court-player" 
                        style={{ 
                          position: 'relative',
                          cursor: canSubstitute ? 'pointer' : 'default',
                          transition: 'transform 0.2s',
                          background: player.isLibero ? '#FFF8E7' : undefined,
                          color: player.isLibero ? '#000' : undefined
                        }}
                        onClick={(e) => canSubstitute && handlePlayerClick(leftTeamKey, player.position, player.number, e)}
                        onMouseEnter={(e) => {
                          if (canSubstitute) {
                            e.currentTarget.style.transform = 'scale(1.05)'
                            e.currentTarget.style.boxShadow = '0 4px 12px rgba(255,255,255,0.2)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (canSubstitute) {
                            e.currentTarget.style.transform = 'scale(1)'
                            e.currentTarget.style.boxShadow = 'none'
                          }
                        }}
                      >
                        {shouldShowBall && (
                          <img 
                            src={mikasaVolleyball} 
                            alt="Volleyball" 
                            style={{
                              position: 'absolute',
                              left: '-40px',
                              top: '50%',
                              transform: 'translateY(-50%)',
                              width: '30px',
                              height: '30px',
                              zIndex: 5
                            }}
                          />
                        )}
                        {player.substitutedPlayerNumber && (
                          <span style={{
                            position: 'absolute',
                            top: '-8px',
                            right: '-8px',
                            width: '18px',
                            height: '18px',
                            background: '#FFF8E7',
                            border: '2px solid rgba(0, 0, 0, 0.2)',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '10px',
                            fontWeight: 700,
                            color: '#000',
                            zIndex: 6
                          }}>
                            {player.substitutedPlayerNumber}
                          </span>
                        )}
                        <span className="court-player-position">{player.position}</span>
                        {player.isCaptain && (
                          <span className="court-player-captain">C</span>
                        )}
                        {player.number}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
            <div className="court-net" />
            <div className="court-side court-side-right">
              <div className="court-team court-team-right">
                <div className="court-row court-row-front">
                  {rightTeam.playersOnCourt.slice(0, 3).map(player => {
                    const teamKey = leftIsHome ? 'away' : 'home'
                    const teamSubstitutions = substitutionsUsed?.[teamKey] || 0
                    const canSubstitute = rallyStatus === 'idle' && rightTeamLineupSet && player.number && player.number !== '' && !player.isPlaceholder && teamSubstitutions < 6
                    return (
                      <div 
                        key={player.id} 
                        className="court-player"
                        onClick={(e) => canSubstitute && handlePlayerClick(teamKey, player.position, player.number, e)}
                        style={{ 
                          cursor: canSubstitute ? 'pointer' : 'default',
                          transition: 'transform 0.2s',
                          background: player.isLibero ? '#FFF8E7' : undefined,
                          color: player.isLibero ? '#000' : undefined,
                          position: 'relative'
                        }}
                        onMouseEnter={(e) => {
                          if (canSubstitute) {
                            e.currentTarget.style.transform = 'scale(1.05)'
                            e.currentTarget.style.boxShadow = '0 4px 12px rgba(255,255,255,0.2)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (canSubstitute) {
                            e.currentTarget.style.transform = 'scale(1)'
                            e.currentTarget.style.boxShadow = 'none'
                          }
                        }}
                      >
                        {player.substitutedPlayerNumber && (
                          <span style={{
                            position: 'absolute',
                            top: '-8px',
                            right: '-8px',
                            width: '18px',
                            height: '18px',
                            background: '#FFF8E7',
                            border: '2px solid rgba(0, 0, 0, 0.2)',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '10px',
                            fontWeight: 700,
                            color: '#000',
                            zIndex: 6
                          }}>
                            {player.substitutedPlayerNumber}
                          </span>
                        )}
                        <span className="court-player-position">{player.position}</span>
                        {player.isCaptain && (
                          <span className="court-player-captain">C</span>
                        )}
                        {player.number}
                      </div>
                    )
                  })}
                </div>
                <div className="court-row court-row-back">
                  {rightTeam.playersOnCourt.slice(3, 6).map(player => {
                    const rightTeamKey = leftIsHome ? 'away' : 'home'
                    const currentServe = getCurrentServe()
                    const rightTeamServes = currentServe === rightTeamKey
                    const shouldShowBall = player.position === 'I' && rightTeamServes
                    const teamSubstitutions = substitutionsUsed?.[rightTeamKey] || 0
                    const canSubstitute = rallyStatus === 'idle' && rightTeamLineupSet && player.number && player.number !== '' && !player.isPlaceholder && teamSubstitutions < 6
                    return (
                      <div 
                        key={player.id} 
                        className="court-player" 
                        style={{ 
                          position: 'relative',
                          cursor: canSubstitute ? 'pointer' : 'default',
                          transition: 'transform 0.2s',
                          background: player.isLibero ? '#FFF8E7' : undefined,
                          color: player.isLibero ? '#000' : undefined
                        }}
                        onClick={(e) => canSubstitute && handlePlayerClick(rightTeamKey, player.position, player.number, e)}
                        onMouseEnter={(e) => {
                          if (canSubstitute) {
                            e.currentTarget.style.transform = 'scale(1.05)'
                            e.currentTarget.style.boxShadow = '0 4px 12px rgba(255,255,255,0.2)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (canSubstitute) {
                            e.currentTarget.style.transform = 'scale(1)'
                            e.currentTarget.style.boxShadow = 'none'
                          }
                        }}
                      >
                        {shouldShowBall && (
                          <img 
                            src={mikasaVolleyball} 
                            alt="Volleyball" 
                            style={{
                              position: 'absolute',
                              right: '-40px',
                              top: '50%',
                              transform: 'translateY(-50%)',
                              width: '30px',
                              height: '30px',
                              zIndex: 5
                            }}
                          />
                        )}
                        {player.substitutedPlayerNumber && (
                          <span style={{
                            position: 'absolute',
                            top: '-8px',
                            right: '-8px',
                            width: '18px',
                            height: '18px',
                            background: '#FFF8E7',
                            border: '2px solid rgba(0, 0, 0, 0.2)',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '10px',
                            fontWeight: 700,
                            color: '#000',
                            zIndex: 6
                          }}>
                            {player.substitutedPlayerNumber}
                          </span>
                        )}
                        <span className="court-player-position">{player.position}</span>
                        {player.isCaptain && (
                          <span className="court-player-captain">C</span>
                        )}
                        {player.number}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="rally-controls">
            {rallyStatus === 'idle' ? (
              <button 
                className="secondary" 
                onClick={handleStartRally}
                disabled={isFirstRally && (!leftTeamLineupSet || !rightTeamLineupSet)}
              >
                {isFirstRally ? 'Start set' : 'Start rally'}
              </button>
            ) : (
              <>
                <div className="rally-controls-row">
                  <button className="secondary" onClick={handleReplay}>
                    Replay rally
                  </button>
                </div>
                <div className="rally-controls-row">
                  <button className="rally-point-button" onClick={() => handlePoint('left')}>
                    Point A
                  </button>
                  <button className="rally-point-button" onClick={() => handlePoint('right')}>
                    Point B
                  </button>
                </div>
              </>
            )}
            <button
              className="danger"
              onClick={showUndoConfirm}
              disabled={!data?.events || data.events.length === 0}
            >
              Undo
            </button>
          </div>
        </section>

        <aside className="team-controls">
          <div className="team-info">
            <h3>{rightTeam.name}</h3>
            <span
              className="team-badge"
              style={{
                background: rightTeam.color || '#3b82f6',
                color: isBrightColor(rightTeam.color || '#3b82f6') ? '#000' : '#fff'
              }}
            >
              {teamBLabel}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <div style={{ 
              flex: 1, 
              background: 'rgba(255, 255, 255, 0.05)', 
              borderRadius: '8px', 
              padding: '12px',
              textAlign: 'center',
              border: '1px solid rgba(255, 255, 255, 0.1)'
            }}>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>TO</div>
              <div style={{ 
                fontSize: '24px', 
                fontWeight: 700,
                color: getTimeoutsUsed('right') >= 2 ? '#ef4444' : 'inherit'
              }}>{getTimeoutsUsed('right')}</div>
            </div>
            <div style={{ 
              flex: 1, 
              background: 'rgba(255, 255, 255, 0.05)', 
              borderRadius: '8px', 
              padding: '12px',
              textAlign: 'center',
              border: '1px solid rgba(255, 255, 255, 0.1)'
            }}>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>SUB</div>
              <div style={{ 
                fontSize: '24px', 
                fontWeight: 700,
                color: getSubstitutionsUsed('right') >= 6 ? '#ef4444' : getSubstitutionsUsed('right') >= 5 ? '#eab308' : 'inherit'
              }}>{getSubstitutionsUsed('right')}</div>
            </div>
          </div>
          <button
            onClick={() => handleTimeout('right')}
            disabled={getTimeoutsUsed('right') >= 2 || rallyStatus === 'in_play'}
            style={{ width: '100%', marginBottom: '8px' }}
          >
            Time-out
          </button>
          <button 
            onClick={() => handleLiberoOut('right')}
            disabled={rallyStatus === 'in_play' || !getLiberoOnCourt(leftIsHome ? 'away' : 'home') || !hasPointSinceLastLiberoExchange(leftIsHome ? 'away' : 'home')}
          >
            Libero out
          </button>
          <button 
            onClick={() => handleExchangeLibero('right')}
            disabled={(() => {
              const teamKey = leftIsHome ? 'away' : 'home'
              const teamPlayers = leftIsHome ? data?.awayPlayers : data?.homePlayers
              const liberos = teamPlayers?.filter(p => p.libero && p.libero !== '') || []
              return rallyStatus === 'in_play' || 
                     !getLiberoOnCourt(teamKey) || 
                     !hasPointSinceLastLiberoExchange(teamKey) ||
                     liberos.length < 2 // Disable if team has less than 2 liberos
            })()}
          >
            Exchange libero
          </button>
          
          {/* Sanctions: Improper Request, Delay Warning, Delay Penalty */}
          <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
            {!data?.match?.sanctions?.improperRequestRight && (
              <button
                onClick={() => handleImproperRequest('right')}
                disabled={rallyStatus === 'in_play'}
                style={sanctionButtonStyles.improper}
              >
                Improper Request
              </button>
            )}
            {!data?.match?.sanctions?.delayWarningRight ? (
              <button
                onClick={() => handleDelayWarning('right')}
                disabled={rallyStatus === 'in_play'}
                style={sanctionButtonStyles.delayWarning}
              >
                Delay Warning
              </button>
            ) : (
              <button
                onClick={() => handleDelayPenalty('right')}
                disabled={rallyStatus === 'in_play'}
                style={sanctionButtonStyles.delayPenalty}
              >
                Delay Penalty
              </button>
            )}
          </div>
          
          <button className="secondary" disabled>
            Injury
          </button>
          
          {/* Bench Players, Liberos, and Bench Officials */}
          <div style={{ marginTop: '24px', paddingTop: '24px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
            {/* Bench Players */}
            {rightTeamBench.benchPlayers.length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 600, color: 'var(--muted)' }}>Bench</h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {rightTeamBench.benchPlayers.map(player => {
                    const teamKey = leftIsHome ? 'away' : 'home'
                    const canComeBack = canPlayerComeBack(teamKey, player.number)
                    const hasComeBack = hasPlayerComeBack(teamKey, player.number)
                    const isSubstitutedByLibero = player.substitutedByLibero !== null
                    
                    // Check if player was substituted out but waiting for point to allow comeback
                    const substitutions = getSubstitutionHistory(teamKey)
                    const wasSubstitutedOut = substitutions.some(s => String(s.payload?.playerOut) === String(player.number))
                    const waitingForPoint = wasSubstitutedOut && !canComeBack && !hasComeBack
                    
                    return (
                      <div 
                        key={player.id} 
                        style={{ 
                          padding: '4px 8px', 
                          background: isSubstitutedByLibero ? '#FFF8E7' : (hasComeBack ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.05)'), 
                          borderRadius: '4px',
                          fontSize: '11px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          position: 'relative',
                          opacity: hasComeBack ? 0.4 : 1,
                          color: isSubstitutedByLibero ? '#000' : undefined
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{player.number}</span>
                        {player.isCaptain && (
                          <span style={{ color: isSubstitutedByLibero ? '#000' : 'var(--accent)', fontSize: '10px', fontWeight: 700 }}>C</span>
                        )}
                        {isSubstitutedByLibero && (
                          <span style={{ 
                            fontSize: '9px',
                            fontWeight: 700,
                            color: '#000',
                            background: 'rgba(255, 255, 255, 0.8)',
                            padding: '1px 3px',
                            borderRadius: '2px'
                          }}>
                            {player.substitutedByLibero.liberoType === 'libero1' ? 'L1' : 'L2'}
                          </span>
                        )}
                        {hasComeBack && (
                          <span 
                            style={{ 
                              fontSize: '9px',
                              lineHeight: '1',
                              background: 'rgba(15, 23, 42, 0.95)',
                              color: '#ef4444',
                              fontWeight: 700,
                              padding: '1px 3px',
                              borderRadius: '2px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              minWidth: '12px',
                              minHeight: '12px',
                              border: '1px solid rgba(255, 255, 255, 0.2)'
                            }}
                          >
                            ✕
                          </span>
                        )}
                        {(waitingForPoint || canComeBack) && !hasComeBack && (
                          <span 
                            style={{ 
                              fontSize: '7px',
                              lineHeight: '1',
                              display: 'flex',
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: '1px',
                              background: 'rgba(15, 23, 42, 0.95)',
                              padding: '1px 2px',
                              borderRadius: '2px',
                              minWidth: '14px',
                              minHeight: '12px',
                              justifyContent: 'center',
                              border: '1px solid rgba(255, 255, 255, 0.2)',
                              opacity: waitingForPoint ? 0.5 : 1
                            }}
                          >
                            <span style={{ color: '#22c55e', fontWeight: 900 }}>↑</span>
                            <span style={{ color: '#ef4444', fontWeight: 900 }}>↓</span>
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            
            {/* Liberos */}
            {rightTeamBench.liberos.length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 600, color: 'var(--muted)' }}>Liberos</h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {rightTeamBench.liberos.map(player => (
                    <div key={player.id} style={{ 
                      padding: '4px 8px', 
                      background: 'rgba(59, 130, 246, 0.2)', 
                      borderRadius: '4px',
                      fontSize: '11px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      border: '1px solid rgba(59, 130, 246, 0.3)'
                    }}>
                      <span style={{ fontWeight: 600 }}>{player.number}</span>
                      <span style={{ color: '#60a5fa', fontSize: '10px', fontWeight: 700 }}>
                        {player.libero === 'libero1' ? 'L1' : 'L2'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* Bench Officials */}
            {rightTeamBench.benchOfficials.length > 0 && (
              <div>
                <h4 style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 600, color: 'var(--muted)' }}>Bench Officials</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {rightTeamBench.benchOfficials.map((official, idx) => (
                    <div key={idx} style={{ 
                      padding: '4px 8px', 
                      background: 'rgba(255,255,255,0.05)', 
                      borderRadius: '4px',
                      fontSize: '11px'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: 600, color: 'var(--muted)', minWidth: '30px' }}>
                          {official.role === 'Coach' ? 'C' : 
                           official.role === 'Assistant Coach 1' ? 'AC1' :
                           official.role === 'Assistant Coach 2' ? 'AC2' :
                           official.role === 'Physiotherapist' ? 'P' :
                           official.role === 'Medic' ? 'M' : official.role}
                        </span>
                        <span>{official.lastName || ''} {official.firstName || ''}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      <div className="match-footer">
        <button className="secondary" onClick={() => setShowLogs(v => !v)}>
          {showLogs ? 'Hide logs' : 'Show logs'}
        </button>
        <button
          className="secondary"
          onClick={() => setShowManualPanel(v => !v)}
        >
          {showManualPanel ? 'Close manual changes' : 'Manual changes'}
        </button>
        <button className="secondary" onClick={() => setShowRemarks(v => !v)}>
          {showRemarks ? 'Close remarks' : 'Open remarks recording'}
        </button>
        <button className="secondary" onClick={() => setShowSanctions(v => !v)}>
          {showSanctions ? 'Close sanctions' : 'Show sanctions'}
        </button>
      </div>

      {(showLogs || showManualPanel || showRemarks || showSanctions) && (
        <div className="match-panels">
          {showLogs && (
            <section className="panel">
              <h3>Action log</h3>
              {(data.events || []).length === 0 ? (
                <p>No events recorded yet.</p>
              ) : (
                <ul className="log-list">
                  {(() => {
                    // Calculate score progression through events (forward in time) per set
                    const eventsBySet = {}
                    data.events.forEach(event => {
                      const setIdx = event.setIndex || 1
                      if (!eventsBySet[setIdx]) {
                        eventsBySet[setIdx] = []
                      }
                      eventsBySet[setIdx].push(event)
                    })
                    
                    // Calculate scores for each set
                    const eventsWithScore = data.events.map(event => {
                      const setIdx = event.setIndex || 1
                      const setEvents = eventsBySet[setIdx] || []
                      const eventIndex = setEvents.findIndex(e => e.id === event.id)
                      
                      // Calculate score up to this event in this set
                      let homeScore = 0
                      let awayScore = 0
                      for (let i = 0; i <= eventIndex; i++) {
                        const e = setEvents[i]
                        if (e.type === 'point') {
                          if (e.payload?.team === 'home') {
                            homeScore++
                          } else if (e.payload?.team === 'away') {
                            awayScore++
                          }
                        }
                      }
                      
                      return {
                        ...event,
                        scoreAtTime: { home: homeScore, away: awayScore }
                      }
                    })
                    
                    return eventsWithScore
                      .slice()
                      .reverse()
                      .filter(event => event.type !== 'lineup' || event.payload?.isInitial)
                      .map(event => {
                        const teamName = event.payload?.team === 'home' 
                          ? (data.homeTeam?.name || 'Home')
                          : event.payload?.team === 'away'
                          ? (data.awayTeam?.name || 'Away')
                          : null
                        
                        // Determine team labels (A or B)
                        const teamALabel = data?.match?.coinTossTeamA === 'home' ? 'A' : 'B'
                        const teamBLabel = data?.match?.coinTossTeamB === 'home' ? 'A' : 'B'
                        const homeLabel = data?.match?.coinTossTeamA === 'home' ? 'A' : (data?.match?.coinTossTeamB === 'home' ? 'B' : 'A')
                        const awayLabel = data?.match?.coinTossTeamA === 'away' ? 'A' : (data?.match?.coinTossTeamB === 'away' ? 'B' : 'B')
                        
                        let eventDescription = ''
                        if (event.type === 'point') {
                          eventDescription = `Point — ${teamName} (${homeLabel} ${event.scoreAtTime.home}:${event.scoreAtTime.away} ${awayLabel})`
                        } else if (event.type === 'timeout') {
                          eventDescription = `Timeout — ${teamName}`
                        } else if (event.type === 'substitution') {
                          const playerOut = event.payload?.playerOut || '?'
                          const playerIn = event.payload?.playerIn || '?'
                          eventDescription = `Substitution — ${teamName} (OUT: ${playerOut} IN: ${playerIn}) (${homeLabel} ${event.scoreAtTime.home}:${event.scoreAtTime.away} ${awayLabel})`
                        } else if (event.type === 'rally_start') {
                          eventDescription = 'Rally started'
                        } else if (event.type === 'replay') {
                          eventDescription = 'Replay'
                        } else if (event.type === 'lineup') {
                          // Only show initial lineups, manual overrides, or substitution-related lineups (skip rotation lineups)
                          const isInitial = event.payload?.isInitial === true
                          const hasSubstitution = event.payload?.fromSubstitution === true
                          const manualOverride = event.payload?.manualOverride === true
                          if (!isInitial && !hasSubstitution && !manualOverride) {
                            // This is a rotation lineup, skip it
                            return null
                          }
                          eventDescription = manualOverride
                            ? `Manual lineup override — ${teamName}`
                            : `Lineup — ${teamName}`
                        } else if (event.type === 'libero_entry') {
                          const liberoNumber = event.payload?.liberoIn || '?'
                          const liberoType = event.payload?.liberoType === 'libero1' ? 'L1' : 'L2'
                          eventDescription = `Libero entry — ${teamName} (${liberoType} #${liberoNumber} in for #${event.payload?.playerOut || '?'}) (${homeLabel} ${event.scoreAtTime.home}:${event.scoreAtTime.away} ${awayLabel})`
                        } else if (event.type === 'libero_exit') {
                          const liberoNumber = event.payload?.liberoOut || '?'
                          const liberoType = event.payload?.liberoType === 'libero1' ? 'L1' : 'L2'
                          const playerIn = event.payload?.playerIn || '?'
                          eventDescription = `Libero exit — ${teamName} (${liberoType} #${liberoNumber} out, #${playerIn} in) (${homeLabel} ${event.scoreAtTime.home}:${event.scoreAtTime.away} ${awayLabel})`
                        } else if (event.type === 'libero_exchange') {
                          const liberoOut = event.payload?.liberoOut || '?'
                          const liberoIn = event.payload?.liberoIn || '?'
                          const liberoOutType = event.payload?.liberoOutType === 'libero1' ? 'L1' : 'L2'
                          const liberoInType = event.payload?.liberoInType === 'libero1' ? 'L1' : 'L2'
                          eventDescription = `Libero exchange — ${teamName} (${liberoOutType} #${liberoOut} ↔ ${liberoInType} #${liberoIn}) (${homeLabel} ${event.scoreAtTime.home}:${event.scoreAtTime.away} ${awayLabel})`
                        } else if (event.type === 'set_end') {
                          const winnerLabel = event.payload?.teamLabel || '?'
                          const setIndex = event.payload?.setIndex || event.setIndex || '?'
                          eventDescription = `Team ${winnerLabel} won Set ${setIndex}`
                        } else {
                          eventDescription = event.type
                          if (teamName) {
                            eventDescription += ` — ${teamName}`
                          }
                        }
                        
                        return (
                          <li key={event.id}>
                            <span style={{ color: 'var(--muted)', fontSize: '12px' }}>
                              Set {event.setIndex || data.set?.index || '?'} | {new Date(event.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                            </span>
                            <br />
                            <strong>{eventDescription}</strong>
                          </li>
                        )
                      })
                  })()}
                </ul>
              )}
            </section>
          )}
          {showManualPanel && (
            <section className="panel">
              <h3>Manual changes</h3>
              <div className="manual-list">
                <div
                  className="manual-item"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    paddingBottom: '16px',
                    borderBottom: '1px solid rgba(255,255,255,0.08)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>Change current lineup</div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                        Override the on-court lineup if a mistake was recorded.
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        className="secondary"
                        disabled={!data?.set}
                        onClick={() => openManualLineup(leftIsHome ? 'home' : 'away')}
                        style={{
                          background: leftTeam.color || '#ef4444',
                          color: isBrightColor(leftTeam.color || '#ef4444') ? '#000' : '#fff'
                        }}
                      >
                        Edit Team {leftTeam.isTeamA ? 'A' : 'B'} (Left)
                      </button>
                      <button
                        className="secondary"
                        disabled={!data?.set}
                        onClick={() => openManualLineup(leftIsHome ? 'away' : 'home')}
                        style={{
                          background: rightTeam.color || '#3b82f6',
                          color: isBrightColor(rightTeam.color || '#3b82f6') ? '#000' : '#fff'
                        }}
                      >
                        Edit Team {rightTeam.isTeamA ? 'A' : 'B'} (Right)
                      </button>
                    </div>
                  </div>
                </div>
                <div style={{ marginTop: '16px', fontSize: '12px', color: 'var(--muted)' }}>
                  More manual adjustments will appear here soon.
                </div>
              </div>
            </section>
          )}
          {showRemarks && (
            <section className="panel">
              <h3>Remarks</h3>
              <textarea
                className="remarks-area"
                placeholder="Record match remarks…"
                value={data?.match?.remarks || ''}
                onChange={e => {
                  db.matches.update(matchId, { remarks: e.target.value })
                }}
              />
            </section>
          )}
          
          {showSanctions && (
            <section className="panel">
              <h3>Sanctions</h3>
              <div style={{ overflowX: 'auto' }}>
                {/* Improper Request Row */}
                <div style={{ marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div style={{ fontWeight: 600, fontSize: '14px', minWidth: '120px' }}>Improper Request:</div>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    {['A', 'B'].map(team => {
                      const teamKey = team === 'A' ? teamAKey : teamBKey
                      const sideKey = (team === 'A' && teamAKey === 'home' && leftIsHome) || (team === 'A' && teamAKey === 'away' && !leftIsHome) || (team === 'B' && teamBKey === 'home' && leftIsHome) || (team === 'B' && teamBKey === 'away' && !leftIsHome) ? 'Left' : 'Right'
                      const hasImproperRequest = data?.match?.sanctions?.[`improperRequest${sideKey}`]
                      
                      return (
                        <div key={team} style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          border: '2px solid rgba(255,255,255,0.3)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '14px',
                          fontWeight: 700,
                          position: 'relative'
                        }}>
                          {team}
                          {hasImproperRequest && (
                            <div style={{
                              position: 'absolute',
                              inset: 0,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '24px',
                              color: '#ef4444',
                              fontWeight: 900
                            }}>
                              ✕
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
                
                {/* Sanctions Table */}
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.2)' }}>
                      <th style={{ padding: '8px', textAlign: 'center', fontWeight: 600 }}>Warning</th>
                      <th style={{ padding: '8px', textAlign: 'center', fontWeight: 600 }}>Penalty</th>
                      <th style={{ padding: '8px', textAlign: 'center', fontWeight: 600 }}>Expulsion</th>
                      <th style={{ padding: '8px', textAlign: 'center', fontWeight: 600 }}>Disqualification</th>
                      <th style={{ padding: '8px', textAlign: 'center', fontWeight: 600 }}>Team</th>
                      <th style={{ padding: '8px', textAlign: 'center', fontWeight: 600 }}>Set</th>
                      <th style={{ padding: '8px', textAlign: 'center', fontWeight: 600 }}>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      // Get all sanction events
                      const sanctionEvents = (data?.events || []).filter(e => e.type === 'sanction')
                      
                      if (sanctionEvents.length === 0) {
                        return (
                          <tr>
                            <td colSpan="7" style={{ padding: '16px', textAlign: 'center', color: 'var(--muted)' }}>
                              No sanctions recorded
                            </td>
                          </tr>
                        )
                      }
                      
                      return sanctionEvents.map((event, idx) => {
                        const sanctionType = event.payload?.type
                        const team = event.payload?.team
                        const teamLabel = team === teamAKey ? 'A' : 'B'
                        const setIndex = event.setIndex || 1
                        
                        // Calculate score at time of sanction
                        const setEvents = (data?.events || []).filter(e => e.setIndex === setIndex)
                        const eventIndex = setEvents.findIndex(e => e.id === event.id)
                        let homeScore = 0
                        let awayScore = 0
                        for (let i = 0; i <= eventIndex; i++) {
                          const e = setEvents[i]
                          if (e.type === 'point') {
                            if (e.payload?.team === 'home') homeScore++
                            else if (e.payload?.team === 'away') awayScore++
                          }
                        }
                        
                        // Put sanctioned team's score on the left
                        const sanctionedTeamScore = team === 'home' ? homeScore : awayScore
                        const otherTeamScore = team === 'home' ? awayScore : homeScore
                        const scoreDisplay = `${sanctionedTeamScore}:${otherTeamScore}`
                        
                        return (
                          <tr key={event.id || idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                            <td style={{ padding: '8px', textAlign: 'center' }}>
                              {sanctionType === 'delay_warning' && 'D'}
                            </td>
                            <td style={{ padding: '8px', textAlign: 'center' }}>
                              {sanctionType === 'delay_penalty' && 'D'}
                            </td>
                            <td style={{ padding: '8px', textAlign: 'center' }}></td>
                            <td style={{ padding: '8px', textAlign: 'center' }}></td>
                            <td style={{ padding: '8px', textAlign: 'center', fontWeight: 600 }}>{teamLabel}</td>
                            <td style={{ padding: '8px', textAlign: 'center' }}>{setIndex}</td>
                            <td style={{ padding: '8px', textAlign: 'center' }}>{scoreDisplay}</td>
                          </tr>
                        )
                      })
                    })()}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      {timeoutModal && (
        <Modal
          title={`Time-out — ${timeoutModal.team === 'home' ? (data?.homeTeam?.name || 'Home') : (data?.awayTeam?.name || 'Away')}`}
          open={true}
          onClose={timeoutModal.started ? stopTimeout : cancelTimeout}
          width={400}
        >
          <div style={{ textAlign: 'center', padding: '24px' }}>
            {timeoutModal.started ? (
              <>
                <div style={{ fontSize: '64px', fontWeight: 800, marginBottom: '16px', color: 'var(--accent)' }}>
                  {timeoutModal.countdown}"
                </div>
                <p style={{ marginBottom: '24px', color: 'var(--muted)' }}>
                  Time-out in progress
                </p>
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                  <button className="secondary" onClick={stopTimeout}>
                    Stop time-out
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ marginBottom: '24px', color: 'var(--muted)' }}>
                  Confirm time-out request?
                </p>
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                  <button onClick={confirmTimeout}>
                    Confirm time-out
                  </button>
                  <button className="secondary" onClick={cancelTimeout}>
                    Cancel
                  </button>
                </div>
              </>
            )}
      </div>
        </Modal>
      )}

      {lineupModal && <LineupModal 
        team={lineupModal.team}
        teamData={
          lineupModal.team === 'home'
            ? data?.homeTeam
            : data?.awayTeam
        }
        players={
          lineupModal.team === 'home'
            ? data?.homePlayers
            : data?.awayPlayers
        }
        matchId={matchId}
        setIndex={data?.set?.index}
        mode={lineupModal.mode || 'initial'}
        lineup={lineupModal.lineup}
        teamAKey={teamAKey}
        teamBKey={teamBKey}
        onClose={() => setLineupModal(null)}
        onSave={() => {
          setLineupModal(null)
          // Force re-render by updating data
        }}
      />}
      
      {setEndModal && (
        <Modal
          title="Set End Confirmation"
          open={true}
          onClose={() => setSetEndModal(null)}
          width={400}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              Do you confirm the set is over?
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmSetEnd}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Yes
              </button>
              <button
                onClick={cancelSetEnd}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: '#ef4444',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Undo last action
              </button>
            </div>
          </div>
        </Modal>
      )}
      
      {substitutionDropdown && (() => {
        const teamKey = substitutionDropdown.team
        const teamData = teamKey === 'home' ? data?.homeTeam : data?.awayTeam
        
        // Get available substitutes based on substitution rules
        const availableSubstitutes = getAvailableSubstitutes(teamKey, substitutionDropdown.playerNumber)
        
        // Get element position - use stored coordinates if available, otherwise try to find element
        let dropdownStyle
        if (substitutionDropdown.x !== undefined && substitutionDropdown.y !== undefined) {
          dropdownStyle = {
            position: 'fixed',
            left: `${substitutionDropdown.x}px`,
            top: `${substitutionDropdown.y}px`,
            transform: 'translateX(-50%)',
            zIndex: 1000
          }
        } else {
          // Fallback: try to find element
          let element = substitutionDropdown.element
          if (!element || !element.getBoundingClientRect) {
            const playerElements = document.querySelectorAll(`.court-player`)
            element = Array.from(playerElements).find(el => {
              const position = el.querySelector('.court-player-position')?.textContent
              return position === substitutionDropdown.position
            })
          }
          const rect = element?.getBoundingClientRect?.()
          dropdownStyle = rect ? {
            position: 'fixed',
            left: `${rect.left + rect.width / 2}px`,
            top: `${rect.bottom + 8}px`,
            transform: 'translateX(-50%)',
            zIndex: 1000
          } : {
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1000
          }
        }
        
        // Check if libero dropdown is also open (side by side)
        const hasLiberoDropdown = liberoDropdown && liberoDropdown.team === teamKey && liberoDropdown.position === substitutionDropdown.position
        
        return (
          <>
            {/* Backdrop to close dropdown on click outside */}
            <div
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 999,
                background: 'transparent'
              }}
              onClick={() => {
                cancelSubstitution()
                cancelLibero()
              }}
            />
            {/* Dropdown */}
            <div
              data-substitution-dropdown
              style={{
                ...dropdownStyle,
                background: 'rgba(15, 23, 42, 0.95)',
                border: '2px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '8px',
                padding: '8px',
                minWidth: '80px',
                maxWidth: '100px',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
                animation: 'fadeIn 0.2s ease-out',
                ...(hasLiberoDropdown ? { transform: 'translateX(calc(-50% - 60px))' } : {})
              }}
            >
              <div style={{ marginBottom: '8px', fontSize: '12px', fontWeight: 600, color: 'var(--text)', textAlign: 'center', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', paddingBottom: '8px' }}>
                Substitution
              </div>
              <div style={{ marginBottom: '8px', fontSize: '11px', color: 'var(--muted)', textAlign: 'center' }}>
                Pos {substitutionDropdown.position}: # {substitutionDropdown.playerNumber} out
              </div>
              {availableSubstitutes.length === 0 ? (
                <div style={{ padding: '8px', textAlign: 'center', color: 'var(--muted)', fontSize: '11px' }}>
                  No substitutes
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {availableSubstitutes.map(player => (
                    <button
                      key={player.id}
                      onClick={() => showSubstitutionConfirm(player.number)}
                      style={{
                        padding: '4px 6px',
                        fontSize: '13px',
                        fontWeight: 700,
                        background: 'rgba(255, 255, 255, 0.05)',
                        color: 'var(--accent)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        textAlign: 'center',
                        transition: 'all 0.2s',
                        width: '100%',
                        minHeight: '28px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)'
                        e.currentTarget.style.transform = 'scale(1.05)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                        e.currentTarget.style.transform = 'scale(1)'
                      }}
                    >
                      # {player.number}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )
      })()}
      
      {liberoDropdown && (() => {
        const teamKey = liberoDropdown.team
        const teamPlayers = teamKey === 'home' ? data?.homePlayers : data?.awayPlayers
        const allLiberos = teamPlayers?.filter(p => p.libero && p.libero !== '') || []
        
        // Check if a libero is already on court
        const liberoOnCourt = getLiberoOnCourt(teamKey)
        // If a libero is already on court, filter out all liberos (can't have two liberos on court)
        const liberos = liberoOnCourt ? [] : allLiberos
        
        // Get element position - use stored coordinates if available, otherwise try to find element
        let dropdownStyle
        if (liberoDropdown.x !== undefined && liberoDropdown.y !== undefined) {
          dropdownStyle = {
            position: 'fixed',
            left: `${liberoDropdown.x}px`,
            top: `${liberoDropdown.y}px`,
            transform: 'translateX(-50%)',
            zIndex: 1000
          }
        } else {
          // Fallback: try to find element
          let element = liberoDropdown.element
          if (!element || !element.getBoundingClientRect) {
            const playerElements = document.querySelectorAll(`.court-player`)
            element = Array.from(playerElements).find(el => {
              const position = el.querySelector('.court-player-position')?.textContent
              return position === liberoDropdown.position
            })
          }
          const rect = element?.getBoundingClientRect?.()
          dropdownStyle = rect ? {
            position: 'fixed',
            left: `${rect.left + rect.width / 2}px`,
            top: `${rect.bottom + 8}px`,
            transform: 'translateX(-50%)',
            zIndex: 1000
          } : {
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 1000
          }
        }
        
        // Check if substitution dropdown is also open (side by side)
        const hasSubstitutionDropdown = substitutionDropdown && substitutionDropdown.team === teamKey && substitutionDropdown.position === liberoDropdown.position
        
        return (
          <>
            {/* Backdrop to close dropdown on click outside */}
            <div
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 999,
                background: 'transparent'
              }}
              onClick={() => {
                cancelSubstitution()
                cancelLibero()
              }}
            />
            {/* Dropdown */}
            <div
              data-libero-dropdown
              style={{
                ...dropdownStyle,
                background: '#FFF8E7',
                border: '2px solid rgba(0, 0, 0, 0.2)',
                borderRadius: '8px',
                padding: '8px',
                minWidth: '80px',
                maxWidth: '100px',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
                animation: 'fadeIn 0.2s ease-out',
                ...(hasSubstitutionDropdown ? { transform: 'translateX(calc(-50% + 60px))' } : {})
              }}
            >
              <div style={{ marginBottom: '8px', fontSize: '12px', fontWeight: 600, color: '#000', textAlign: 'center', borderBottom: '1px solid rgba(0, 0, 0, 0.1)', paddingBottom: '8px' }}>
                Libero
              </div>
              <div style={{ marginBottom: '8px', fontSize: '11px', color: '#666', textAlign: 'center' }}>
                Pos {liberoDropdown.position}: # {liberoDropdown.playerNumber} out
              </div>
              {liberos.length === 0 ? (
                <div style={{ padding: '8px', textAlign: 'center', color: '#666', fontSize: '11px' }}>
                  No liberos
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {liberos.map(player => (
                    <button
                      key={player.id}
                      onClick={() => showLiberoConfirm(player.libero)}
                      style={{
                        padding: '4px 6px',
                        fontSize: '13px',
                        fontWeight: 700,
                        background: 'rgba(0, 0, 0, 0.05)',
                        color: '#000',
                        border: '1px solid rgba(0, 0, 0, 0.1)',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        textAlign: 'center',
                        transition: 'all 0.2s',
                        width: '100%',
                        minHeight: '28px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '4px'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(0, 0, 0, 0.15)'
                        e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.3)'
                        e.currentTarget.style.transform = 'scale(1.05)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)'
                        e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.1)'
                        e.currentTarget.style.transform = 'scale(1)'
                      }}
                    >
                      {player.libero === 'libero1' ? 'L1' : 'L2'} # {player.number}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )
      })()}
      
      {substitutionConfirm && (
        <Modal
          title="Confirm Substitution"
          open={true}
          onClose={cancelSubstitutionConfirm}
          width="auto"
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '16px', fontSize: '14px', color: 'var(--muted)' }}>
              Position {substitutionConfirm.position}
            </p>
            <div style={{ marginBottom: '24px', fontSize: '16px', fontWeight: 600 }}>
              <div style={{ marginBottom: '8px', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <span>OUT: # {substitutionConfirm.playerOut}</span>
                <span style={{ fontSize: '24px', fontWeight: 700 }}>↓</span>
              </div>
              <div style={{ color: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <span>IN: # {substitutionConfirm.playerIn}</span>
                <span style={{ fontSize: '24px', fontWeight: 700 }}>↑</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmSubstitution}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Yes
              </button>
              <button
                onClick={cancelSubstitutionConfirm}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
      
      {liberoConfirm && (
        <Modal
          title="Confirm Libero Entry"
          open={true}
          onClose={cancelLiberoConfirm}
          width="auto"
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '16px', fontSize: '14px', color: 'var(--muted)' }}>
              Position {liberoConfirm.position}
            </p>
            <div style={{ marginBottom: '24px', fontSize: '16px', fontWeight: 600 }}>
              <div style={{ marginBottom: '8px', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <span>OUT: # {liberoConfirm.playerOut}</span>
                <span style={{ fontSize: '24px', fontWeight: 700 }}>↓</span>
              </div>
              <div style={{ color: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <span>IN: {liberoConfirm.liberoIn === 'libero1' ? 'L1' : 'L2'}</span>
                <span style={{ fontSize: '24px', fontWeight: 700 }}>↑</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmLibero}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Yes
              </button>
              <button
                onClick={cancelLiberoConfirm}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
      
      {liberoReentryModal && (
        <Modal
          title="Libero Re-entry"
          open={true}
          onClose={cancelLiberoReentry}
          width={400}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              Do you want to sub the libero in position I?
            </p>
            <p style={{ marginBottom: '16px', fontSize: '14px', color: 'var(--muted)' }}>
              Position {liberoReentryModal.position}: # {liberoReentryModal.playerNumber} out
            </p>
            <p style={{ marginBottom: '24px', fontSize: '14px', color: 'var(--muted)' }}>
              {liberoReentryModal.liberoType === 'libero1' ? 'L1' : 'L2'} # {liberoReentryModal.liberoNumber} in
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmLiberoReentry}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Yes
              </button>
              <button
                onClick={cancelLiberoReentry}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                No
              </button>
            </div>
          </div>
        </Modal>
      )}
      
      {liberoReminder && (
        <Modal
          title="Libero Reminder"
          open={true}
          onClose={() => {
            setLiberoReminder(null)
          }}
          width={400}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              Remember to insert the libero if available
            </p>
            {liberoReminder.teams.length > 1 && (
              <p style={{ marginBottom: '16px', fontSize: '14px', color: 'var(--muted)' }}>
                {liberoReminder.teams.map((team, idx) => {
                  const teamName = team === 'home' 
                    ? (data?.homeTeam?.name || 'Home')
                    : (data?.awayTeam?.name || 'Away')
                  return (
                    <span key={team}>
                      {teamName}
                      {idx < liberoReminder.teams.length - 1 ? ' and ' : ''}
                    </span>
                  )
                })}
              </p>
            )}
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => {
                  setLiberoReminder(null)
                }}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Back
              </button>
              <button
                onClick={async () => {
                  setLiberoReminder(null)
                  
                  // Show set start time confirmation
                  let defaultTime = new Date().toISOString()
                  
                  if (data?.set?.index === 1) {
                    // Use scheduled time from match
                    if (data?.match?.scheduledAt) {
                      defaultTime = data.match.scheduledAt
                    }
                  } else {
                    // Get previous set's end time
                    const allSets = await db.sets.where('matchId').equals(matchId).toArray()
                    const previousSet = allSets.find(s => s.index === (data.set.index - 1))
                    if (previousSet?.endTime) {
                      // Add 3 minutes to previous set end time
                      const prevEndTime = new Date(previousSet.endTime)
                      prevEndTime.setMinutes(prevEndTime.getMinutes() + 3)
                      defaultTime = prevEndTime.toISOString()
                    }
                  }
                  
                  setSetStartTimeModal({ setIndex: data?.set?.index, defaultTime })
                }}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Continue
              </button>
            </div>
          </div>
        </Modal>
      )}
      
      {setStartTimeModal && (
        <SetStartTimeModal
          setIndex={setStartTimeModal.setIndex}
          defaultTime={setStartTimeModal.defaultTime}
          onConfirm={confirmSetStartTime}
          onCancel={() => setSetStartTimeModal(null)}
        />
      )}
      
      {setEndTimeModal && (
        <SetEndTimeModal
          setIndex={setEndTimeModal.setIndex}
          winner={setEndTimeModal.winner}
          homePoints={setEndTimeModal.homePoints}
          awayPoints={setEndTimeModal.awayPoints}
          defaultTime={setEndTimeModal.defaultTime}
          teamAKey={teamAKey}
          onConfirm={confirmSetEndTime}
          onCancel={() => setSetEndTimeModal(null)}
        />
      )}
      
      {sanctionConfirm && (
        <Modal
          title="Confirm Sanction"
          open={true}
          onClose={() => setSanctionConfirm(null)}
          width={400}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              Apply {sanctionConfirm.type === 'improper_request' ? 'Improper Request' : 
                     sanctionConfirm.type === 'delay_warning' ? 'Delay Warning' : 
                     'Delay Penalty'} to Team {(() => {
                       const sideTeamKey = sanctionConfirm.side === 'left' ? (leftIsHome ? 'home' : 'away') : (leftIsHome ? 'away' : 'home')
                       return sideTeamKey === teamAKey ? 'A' : 'B'
                     })()}?
            </p>
            {sanctionConfirm.type === 'delay_penalty' && (
              <p style={{ marginBottom: '16px', fontSize: '14px', color: 'var(--muted)', fontStyle: 'italic' }}>
                This will award a point and service to the opponent team
              </p>
            )}
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmSanction}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Yes
              </button>
              <button
                onClick={() => setSanctionConfirm(null)}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                No
              </button>
            </div>
          </div>
        </Modal>
      )}
      
      {liberoRotationModal && (
        <Modal
          title="Libero Must Go Out"
          open={true}
          onClose={() => setLiberoRotationModal(null)}
          width={400}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              The libero rotated to position IV (front row) and must go out.
            </p>
            <p style={{ marginBottom: '24px', fontSize: '14px', color: 'var(--muted)' }}>
              {liberoRotationModal.liberoType === 'libero1' ? 'L1' : 'L2'} #{liberoRotationModal.liberoNumber} has been automatically replaced by player #{liberoRotationModal.playerNumber}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => setLiberoRotationModal(null)}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                OK
              </button>
            </div>
          </div>
        </Modal>
      )}
      
      {undoConfirm && (
        <Modal
          title="Confirm Undo"
          open={true}
          onClose={cancelUndo}
          width={400}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '16px', fontSize: '16px' }}>
              Do you want to undo action?
            </p>
            <p style={{ marginBottom: '24px', fontSize: '14px', color: 'var(--muted)', fontStyle: 'italic' }}>
              {undoConfirm.description}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={handleUndo}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Yes
              </button>
              <button
                onClick={cancelUndo}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function LineupModal({ team, teamData, players, matchId, setIndex, mode = 'initial', lineup: presetLineup = null, teamAKey, teamBKey, onClose, onSave }) {
  const [lineup, setLineup] = useState(() => {
    if (presetLineup) {
      const positionMapping = ['IV', 'III', 'II', 'V', 'VI', 'I']
      return positionMapping.map(pos => (presetLineup[pos] !== undefined ? String(presetLineup[pos] ?? '') : ''))
    }
    return ['', '', '', '', '', '']
  }) // [IV, III, II, V, VI, I]
  const [errors, setErrors] = useState([]) // Array of indices with errors
  const [confirmMessage, setConfirmMessage] = useState(null)

  const handleInputChange = (index, value) => {
    const numValue = value.replace(/[^0-9]/g, '')
    const newLineup = [...lineup]
    newLineup[index] = numValue
    setLineup(newLineup)
    setErrors([])
    setConfirmMessage(null)
  }

  const handleConfirm = () => {
    const newErrors = []
    const numbers = lineup.map(n => n ? Number(n) : null)
    
    // Check all fields are filled
    if (numbers.some(n => n === null || n === 0)) {
      lineup.forEach((n, i) => {
        if (!n || Number(n) === 0) newErrors.push(i)
      })
      setErrors(newErrors)
      return
    }

    // Check for duplicates
    const duplicates = []
    numbers.forEach((num, i) => {
      if (numbers.filter(n => n === num).length > 1) {
        duplicates.push(i)
      }
    })
    if (duplicates.length > 0) {
      setErrors(duplicates)
      return
    }

    // Check numbers exist and are not liberos
    const invalid = []
    numbers.forEach((num, i) => {
      const player = players?.find(p => p.number === num)
      if (!player) {
        invalid.push(i)
      } else if (player.libero && player.libero !== '') {
        invalid.push(i)
      }
    })
    if (invalid.length > 0) {
      setErrors(invalid)
      return
    }

    // Check if captain is in court
    const captain = players?.find(p => p.isCaptain)
    const captainInCourt = captain && numbers.includes(captain.number)
    
    // Save lineup: Map positions I->I, II->II, III->III, IV->IV, V->V, VI->VI
    // Lineup array indices: [0=IV, 1=III, 2=II, 3=V, 4=VI, 5=I]
    const positionMapping = ['IV', 'III', 'II', 'V', 'VI', 'I']
    const lineupData = {}
    positionMapping.forEach((pos, idx) => {
      lineupData[pos] = numbers[idx]
    })
    
    // Save lineup as an event (mark as initial lineup or manual override)
    if (matchId && setIndex) {
      db.events.add({
        matchId,
        setIndex,
        ts: new Date().toISOString(),
        type: 'lineup',
        payload: {
          team,
          lineup: lineupData,
          isInitial: mode === 'initial',
          manualOverride: mode === 'manual'
        }
      }).then(() => {
        setConfirmMessage(captainInCourt ? 'Captain on court' : 'Captain not on court')
        setErrors([])
        // Close modal after a short delay
        setTimeout(() => {
          onSave()
        }, 1500)
      }).catch(err => {
        console.error('Failed to save lineup', err)
        setErrors([0, 1, 2, 3, 4, 5]) // Show error on all fields
      })
    } else {
      setConfirmMessage(captainInCourt ? 'Captain on court' : 'Captain not on court')
      setErrors([])
    }
  }

  // Determine if this team is A or B
  const isTeamA = team === teamAKey
  const teamLabel = isTeamA ? 'A' : 'B'
  const teamColor = teamData?.color || (isTeamA ? '#ef4444' : '#3b82f6')
  
  // Helper function to determine if a color is bright
  const isBrightColor = (color) => {
    if (!color) return false
    const hex = color.replace('#', '')
    const r = parseInt(hex.substr(0, 2), 16)
    const g = parseInt(hex.substr(2, 2), 16)
    const b = parseInt(hex.substr(4, 2), 16)
    const brightness = (r * 299 + g * 587 + b * 114) / 1000
    return brightness > 155
  }

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span>{teamData?.name || (team === 'home' ? 'Home' : 'Away')}</span>
          <span
            style={{
              padding: '4px 12px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 700,
              background: teamColor,
              color: isBrightColor(teamColor) ? '#000' : '#fff'
            }}
          >
            {teamLabel}
          </span>
        </div>
      }
      open={true}
      onClose={onClose}
      width={500}
      hideCloseButton={true}
    >
      <div style={{ padding: '24px' }}>
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: '12px',
          marginBottom: '24px',
          position: 'relative'
        }}>
          {/* Net indicator */}
          <div style={{
            position: 'absolute',
            top: '-8px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '100%',
            height: '2px',
            background: 'var(--accent)',
            zIndex: 1
          }} />
          <div style={{
            position: 'absolute',
            top: '-20px',
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--accent)',
            zIndex: 2,
            background: 'var(--bg)',
            padding: '0 8px'
          }}>
          </div>

          {/* Top row (closer to net) */}
          {[
            { idx: 0, pos: 'IV' },
            { idx: 1, pos: 'III' },
            { idx: 2, pos: 'II' }
          ].map(({ idx, pos }) => (
            <div key={`top-${idx}`} style={{ position: 'relative' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '8px', 
                fontSize: '12px', 
                color: 'var(--muted)',
                textAlign: 'center'
              }}>
                {pos}
              </label>
              <input
                type="text"
                inputMode="numeric"
                min="1"
                max="99"
                value={lineup[idx]}
                onChange={e => {
                  const val = e.target.value.replace(/[^0-9]/g, '')
                  if (val === '' || (Number(val) >= 1 && Number(val) <= 99)) {
                    handleInputChange(idx, val)
                  }
                }}
                style={{
                  width: '60px',
                  height: '60px',
                  maxWidth: '100%',
                  padding: '0',
                  fontSize: '18px',
                  fontWeight: 700,
                  textAlign: 'center',
                  background: 'var(--bg-secondary)',
                  border: errors.includes(idx) ? '3px solid #ef4444' : '3px solid rgba(255,255,255,0.2)',
                  borderRadius: '50%',
                  color: 'var(--text)',
                  margin: '0 auto',
                  display: 'block'
                }}
              />
            </div>
          ))}

          {/* Bottom row (further from net) */}
          {[
            { idx: 3, pos: 'V' },
            { idx: 4, pos: 'VI' },
            { idx: 5, pos: 'I' }
          ].map(({ idx, pos }) => (
            <div 
              key={`bottom-${idx}`} 
              style={{ position: 'relative', marginTop: '24px' }}
            >
              <label style={{ 
                display: 'block', 
                marginBottom: '8px', 
                fontSize: '12px', 
                color: 'var(--muted)',
                textAlign: 'center'
              }}>
                {pos}
              </label>
              <input
                type="text"
                inputMode="numeric"
                min="1"
                max="99"
                value={lineup[idx]}
                onChange={e => {
                  const val = e.target.value.replace(/[^0-9]/g, '')
                  if (val === '' || (Number(val) >= 1 && Number(val) <= 99)) {
                    handleInputChange(idx, val)
                  }
                }}
                style={{
                  width: '60px',
                  height: '60px',
                  maxWidth: '100%',
                  padding: '0',
                  fontSize: '18px',
                  fontWeight: 700,
                  textAlign: 'center',
                  background: 'var(--bg-secondary)',
                  border: errors.includes(idx) ? '3px solid #ef4444' : '3px solid rgba(255,255,255,0.2)',
                  borderRadius: '50%',
                  color: 'var(--text)',
                  margin: '0 auto',
                  display: 'block'
                }}
              />
            </div>
          ))}
        </div>

        {/* Available players (excluding liberos) */}
        <div style={{
          marginBottom: '16px',
          padding: '12px',
          background: 'rgba(255, 255, 255, 0.05)',
          borderRadius: '8px'
        }}>
          <div style={{
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--muted)',
            marginBottom: '8px'
          }}>
            Available Players:
          </div>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px'
          }}>
            {players?.filter(p => !p.libero || p.libero === '').sort((a, b) => a.number - b.number).map(p => (
              <div
                key={p.number}
                style={{
                  position: 'relative',
                  width: '40px',
                  height: '40px',
                  borderRadius: '50%',
                  background: 'rgba(74, 222, 128, 0.2)',
                  border: '2px solid #4ade80',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '14px',
                  fontWeight: 700,
                  color: '#4ade80',
                  cursor: 'default'
                }}
              >
                {p.isCaptain && (
                  <span style={{
                    position: 'absolute',
                    top: '-4px',
                    right: '-4px',
                    width: '16px',
                    height: '16px',
                    borderRadius: '50%',
                    background: '#4ade80',
                    color: '#000',
                    fontSize: '10px',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none'
                  }}>
                    C
                  </span>
                )}
                {p.number}
              </div>
            ))}
          </div>
        </div>

        {errors.length > 0 && (
          <div style={{ 
            padding: '12px', 
            background: 'rgba(239, 68, 68, 0.1)', 
            border: '1px solid #ef4444',
            borderRadius: '8px',
            marginBottom: '16px',
            color: '#ef4444',
            fontSize: '14px'
          }}>
            Please check: All numbers must exist in roster, not be liberos, and not be duplicated.
          </div>
        )}

        {confirmMessage && (
          <div style={{ 
            padding: '12px', 
            background: confirmMessage === 'Captain on court' ? 'rgba(74, 222, 128, 0.1)' : 'rgba(251, 146, 60, 0.1)', 
            border: confirmMessage === 'Captain on court' ? '1px solid #4ade80' : '1px solid #fb923c',
            borderRadius: '8px',
            marginBottom: '16px',
            color: confirmMessage === 'Captain on court' ? '#4ade80' : '#fb923c',
            fontSize: '14px',
            fontWeight: 600,
            textAlign: 'center'
          }}>
            {confirmMessage}
          </div>
        )}

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          {confirmMessage === null && (
            <button onClick={handleConfirm}>
              Confirm
            </button>
          )}
          <button
            className={confirmMessage === null ? 'secondary' : ''}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}

function SetStartTimeModal({ setIndex, defaultTime, onConfirm, onCancel }) {
  const [time, setTime] = useState(() => {
    const date = new Date(defaultTime)
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
  })

  const handleConfirm = () => {
    // Convert time string to ISO string
    const now = new Date()
    const [hours, minutes] = time.split(':')
    now.setHours(parseInt(hours), parseInt(minutes), 0, 0)
    onConfirm(now.toISOString())
  }

  return (
    <Modal
      title={`Set ${setIndex} Start Time`}
      open={true}
      onClose={onCancel}
      width={400}
      hideCloseButton={true}
    >
      <div style={{ padding: '24px', textAlign: 'center' }}>
        <p style={{ marginBottom: '24px', fontSize: '16px' }}>
          Confirm the start time for Set {setIndex}:
        </p>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          style={{
            padding: '12px 16px',
            fontSize: '18px',
            fontWeight: 600,
            textAlign: 'center',
            background: 'var(--bg-secondary)',
            border: '2px solid rgba(255,255,255,0.2)',
            borderRadius: '8px',
            color: 'var(--text)',
            marginBottom: '24px',
            width: '150px'
          }}
        />
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button
            onClick={handleConfirm}
            style={{
              padding: '12px 24px',
              fontSize: '14px',
              fontWeight: 600,
              background: 'var(--accent)',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            Confirm
          </button>
          <button
            onClick={onCancel}
            style={{
              padding: '12px 24px',
              fontSize: '14px',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: 'var(--text)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  )
}

function SetEndTimeModal({ setIndex, winner, homePoints, awayPoints, defaultTime, teamAKey, onConfirm, onCancel }) {
  const [time, setTime] = useState(() => {
    const date = new Date(defaultTime)
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
  })

  const winnerLabel = winner === 'home' 
    ? (teamAKey === 'home' ? 'A' : 'B')
    : (teamAKey === 'away' ? 'A' : 'B')

  const handleConfirm = () => {
    // Convert time string to ISO string
    const now = new Date()
    const [hours, minutes] = time.split(':')
    now.setHours(parseInt(hours), parseInt(minutes), 0, 0)
    onConfirm(now.toISOString())
  }

  return (
    <Modal
      title={`Set ${setIndex} End`}
      open={true}
      onClose={onCancel}
      width={400}
      hideCloseButton={true}
    >
      <div style={{ padding: '24px', textAlign: 'center' }}>
        <p style={{ marginBottom: '16px', fontSize: '18px', fontWeight: 700 }}>
          Team {winnerLabel} won Set {setIndex}!
        </p>
        <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--muted)' }}>
          {homePoints} - {awayPoints}
        </p>
        <p style={{ marginBottom: '16px', fontSize: '16px' }}>
          Confirm the end time:
        </p>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          style={{
            padding: '12px 16px',
            fontSize: '18px',
            fontWeight: 600,
            textAlign: 'center',
            background: 'var(--bg-secondary)',
            border: '2px solid rgba(255,255,255,0.2)',
            borderRadius: '8px',
            color: 'var(--text)',
            marginBottom: '24px',
            width: '150px'
          }}
        />
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button
            onClick={handleConfirm}
            style={{
              padding: '12px 24px',
              fontSize: '14px',
              fontWeight: 600,
              background: 'var(--accent)',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            Confirm
          </button>
          <button
            onClick={onCancel}
            style={{
              padding: '12px 24px',
              fontSize: '14px',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: 'var(--text)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  )
}


