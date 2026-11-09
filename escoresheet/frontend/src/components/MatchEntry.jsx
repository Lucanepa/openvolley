import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { getMatchData, updateMatchData } from '../utils/serverDataSync'
import { useRealtimeConnection } from '../hooks/useRealtimeConnection'
import { db } from '../db/db'
import ballFallback from '../ball_fallback.png'

// Primary ball image (with a bundled copy as fallback)
// The bundled, content-hashed ball (brand/ball.svg): an unhashed /ball.png could
// stay cached (old green ball) after an update
const ballImage = ballFallback
import { Results } from '../../scoresheet_pdf/components/FooterSection'
import { setDurationMinutes } from '../../scoresheet_pdf/utils/matchTimes'
import TestModeControls from './TestModeControls'
import { ArrowLeft } from 'lucide-react'
import { Button } from '../ui/Button.jsx'
import { CardGlyph, topSanction, cardOfSanctionType } from './referee/SanctionCards.jsx'

// volleyui (RESTYLE-SPEC P3b). This is the bench's live view, laid out for a
// tablet held upright (owner 2026-11-09, "all tablets in portrait"): the
// score and set on top, TO / SUB large enough to read from the bench a few
// metres away beside the team's sanctions (the referee tablet's card glyphs,
// referee/SanctionCards.jsx), the team's half court as large as the screen
// allows (a square: 9 x 9 m), the bench players, liberos and officials under
// it. Landscape gets the same column, the court sized by the height left.
const SURFACE = {
  background: 'var(--ov-card)',
  border: '1px solid var(--ov-hairline-soft)',
  boxShadow: 'var(--ov-shadow-card)'
}
import { setsToWin } from '../utils/matchFormat'
import { getSideAForSet } from '../domain/rules'
import { sanctionTarget, compareBySeq } from '../domain/describe'
import { TEAM_COLOUR_MARK, matchDiscPaint, teamLiberoColour, markColourOn } from '../utils/teamColours'

// A player's sanction events as { warning, penalty, expulsion, disqualification } flags
const sanctionFlags = (events = []) => {
  const flags = {}
  for (const e of events) {
    const type = e?.payload?.type || e?.payload?.sanctionType
    if (type) flags[type] = true
  }
  return flags
}

// A bench chip (a player, a libero, an official): a 36 px touch-size row
const BENCH_CHIP = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minHeight: '36px',
  padding: '4px 10px',
  background: 'var(--panel-2)',
  borderRadius: '6px',
  fontSize: '16px',
  fontVariantNumeric: 'tabular-nums'
}

// Newest first in the order the scorer recorded the events (seq), not by
// their time: the scorer's clock set back mid-set made every event after the
// change look older than the last one before it (stress test 2026-10-25)
const newestFirst = (a, b) => compareBySeq(b, a)

export default function MatchEntry({ matchId, team, onBack, embedded = false }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Send heartbeat to indicate bench connection is active (only if connection is enabled)
  useEffect(() => {
    if (!matchId || !team || matchId === -1) return // Skip in test mode

    const checkAndStartHeartbeat = async () => {
      const match = await db.matches.get(matchId)
      if (!match) return null
      const connectionEnabled = team === 'home'
        ? match.homeTeamConnectionEnabled === true
        : match.awayTeamConnectionEnabled === true
      if (connectionEnabled === false) return null
      
      const updateHeartbeat = async () => {
        try {
          const heartbeatField = team === 'home' 
            ? 'lastHomeTeamHeartbeat' 
            : 'lastAwayTeamHeartbeat'
          await db.matches.update(matchId, {
            [heartbeatField]: new Date().toISOString()
          })
        } catch (error) {
          console.error('Failed to update bench heartbeat:', error)
        }
      }
      
      // Initial heartbeat
      updateHeartbeat()
      
      // Update heartbeat every 5 seconds
      return setInterval(updateHeartbeat, 5000)
    }
    
    let interval = null
    checkAndStartHeartbeat().then(id => { interval = id })
    
    return () => {
      if (interval) clearInterval(interval)
      // Clear heartbeat on unmount (skip in test mode)
      // Use local DB instead of server API since this runs in bench context
      if (matchId !== -1) {
        const heartbeatField = team === 'home'
          ? 'lastHomeTeamHeartbeat'
          : 'lastAwayTeamHeartbeat'
        db.matches.update(matchId, { [heartbeatField]: null })
          .catch(() => {}) // Silently fail - not critical
      }
    }
  }, [matchId, team])

  // Load match data from server
  const [data, setData] = useState(null)

  // Helper to update state from match data result
  const updateFromMatchData = useCallback((result) => {
    if (!result || !result.success) return

    const allSets = (result.sets || []).sort((a, b) => a.index - b.index)
    const currentSet = allSets.find(s => !s.finished) || null
    const events = (result.events || []).sort(compareBySeq)

    setData({
      match: result.match,
      homeTeam: result.homeTeam,
      awayTeam: result.awayTeam,
      set: currentSet,
      allSets,
      events,
      homePlayers: (result.homePlayers || []).sort((a, b) => (a.number || 0) - (b.number || 0)),
      awayPlayers: (result.awayPlayers || []).sort((a, b) => (a.number || 0) - (b.number || 0))
    })
  }, [])

  // Handle match deletion - navigate back
  const handleMatchDeleted = useCallback(() => {
    console.log('[MatchEntry] Match deleted, navigating back')
    if (onBack) {
      onBack()
    }
  }, [onBack])

  // Use Supabase Realtime as primary connection, WebSocket as fallback
  useRealtimeConnection({
    matchId: matchId !== -1 ? matchId : null, // Disable for test mode
    onData: updateFromMatchData,
    onDeleted: handleMatchDeleted,
    enabled: matchId && matchId !== -1
  })

  // Load initial data and handle test mode
  useEffect(() => {
    if (!matchId) {
      setData(null)
      return
    }

    // Test mode: use mock data
    if (matchId === -1) {
      setData({
        match: {
          id: -1,
          gameNumber: 999,
          status: 'live',
          firstServe: 'home',
          coinTossTeamA: 'home',
          coinTossTeamB: 'away'
        },
        homeTeam: { name: 'Test Home', color: '#ef4444' },
        awayTeam: { name: 'Test Away', color: '#3b82f6' },
        set: { index: 1, homePoints: 12, awayPoints: 10, finished: false },
        allSets: [{ index: 1, homePoints: 12, awayPoints: 10, finished: false }],
        events: [],
        homePlayers: [
          { id: 1, number: 1, firstName: 'Test', lastName: 'Player 1' },
          { id: 2, number: 5, firstName: 'Test', lastName: 'Player 2' },
          { id: 3, number: 7, firstName: 'Test', lastName: 'Player 3' },
          { id: 4, number: 10, firstName: 'Test', lastName: 'Player 4' },
          { id: 5, number: 12, firstName: 'Test', lastName: 'Player 5' },
          { id: 6, number: 15, firstName: 'Test', lastName: 'Player 6' }
        ],
        awayPlayers: [
          { id: 7, number: 2, firstName: 'Test', lastName: 'Away 1' },
          { id: 8, number: 4, firstName: 'Test', lastName: 'Away 2' },
          { id: 9, number: 8, firstName: 'Test', lastName: 'Away 3' },
          { id: 10, number: 11, firstName: 'Test', lastName: 'Away 4' },
          { id: 11, number: 13, firstName: 'Test', lastName: 'Away 5' },
          { id: 12, number: 16, firstName: 'Test', lastName: 'Away 6' }
        ]
      })
      return
    }

    // Fetch initial match data
    const fetchData = async () => {
      try {
        const result = await getMatchData(matchId)
        updateFromMatchData(result)
      } catch (err) {
        console.error('Error fetching match data:', err)
      }
    }

    fetchData()
  }, [matchId, updateFromMatchData])

  // Which side the team is on: the scorer's court's own rule (getSideAForSet:
  // a set's override, odd sets A left / even sets A right, set 5 its coin toss
  // and the change of courts at 8). It had A on the right in every set from 2
  // to 4 (set 3 is A's left) and read no override.
  const teamSide = useMemo(() => {
    if (!data?.set || !data?.match) return 'left'
    const teamAKey = data.match.coinTossTeamA || 'home'
    const sideA = getSideAForSet(data.set.index, data.match)
    const isTeamA = team === teamAKey
    return isTeamA ? sideA : (sideA === 'left' ? 'right' : 'left')
  }, [data?.set, data?.match, team])

  // Get team info
  const teamInfo = useMemo(() => {
    if (!data) return null
    const isHome = team === 'home'
    return {
      name: isHome ? data.homeTeam?.name : data.awayTeam?.name,
      color: isHome ? data.homeTeam?.color : data.awayTeam?.color,
      players: isHome ? data.homePlayers : data.awayPlayers,
      bench: isHome ? (data.match?.bench_home || []) : (data.match?.bench_away || [])
    }
  }, [data, team])

  // Get opponent team info
  const opponentInfo = useMemo(() => {
    if (!data) return null
    const isHome = team === 'home'
    return {
      name: isHome ? data.awayTeam?.name : data.homeTeam?.name,
      color: isHome ? data.awayTeam?.color : data.homeTeam?.color,
      players: isHome ? data.awayPlayers : data.homePlayers,
      bench: isHome ? (data.match?.bench_away || []) : (data.match?.bench_home || [])
    }
  }, [data, team])

  // Player discs in the team's shirt colour, the libero in the colour that
  // stands out most from both teams, picked together with the other team's
  // libero so the two never match, as on the scoring and referee courts
  // (null without a team colour: the discs keep the neutral look)
  const discPaint = useMemo(() => {
    if (!data) return null
    const paint = matchDiscPaint(data.homeTeam?.color, data.awayTeam?.color, {
      homeLibero: teamLiberoColour(data.homeTeam),
      awayLibero: teamLiberoColour(data.awayTeam)
    })
    return team === 'home' ? paint.home : paint.away
  }, [data, team])

  const discStyle = (isLibero) => {
    const paint = discPaint?.[isLibero ? 'libero' : 'player']
    if (!paint) return { background: isLibero ? '#FFF8E7' : undefined, color: isLibero ? '#000' : undefined }
    return {
      background: paint.background,
      color: paint.color,
      textShadow: paint.textShadow,
      borderColor: paint.ring || undefined,
      ...TEAM_COLOUR_MARK
    }
  }
  const liberoMarkOn = (isLibero) => markColourOn(discStyle(isLibero).background, '#3b82f6', '#0f172a')

  // Get current set points
  const points = useMemo(() => {
    if (!data?.set) return { team: 0, opponent: 0 }
    if (team === 'home') {
      return { team: data.set.homePoints, opponent: data.set.awayPoints }
    } else {
      return { team: data.set.awayPoints, opponent: data.set.homePoints }
    }
  }, [data?.set, team])

  // Get sets won by each team
  const setsWon = useMemo(() => {
    if (!data?.allSets) return { team: 0, opponent: 0 }
    let teamWins = 0
    let opponentWins = 0
    for (const set of data.allSets) {
      if (set.finished) {
        if (team === 'home') {
          if (set.homePoints > set.awayPoints) teamWins++
          else if (set.awayPoints > set.homePoints) opponentWins++
        } else {
          if (set.awayPoints > set.homePoints) teamWins++
          else if (set.homePoints > set.awayPoints) opponentWins++
        }
      }
    }
    return { team: teamWins, opponent: opponentWins }
  }, [data?.allSets, team])

  // Check if match is finished
  const matchBestOf = data?.match?.bestOf ?? 5
  const isMatchFinished = useMemo(() => {
    const needed = setsToWin(matchBestOf)
    return setsWon.team >= needed || setsWon.opponent >= needed
  }, [setsWon, matchBestOf])

  // Calculate set results for Results component
  const calculateSetResults = useMemo(() => {
    if (!data) return []

    const { match, allSets, events } = data
    const localTeamAKey = match?.coinTossTeamA || 'home'
    const localTeamBKey = localTeamAKey === 'home' ? 'away' : 'home'

    const results = []
    for (let setNum = 1; setNum <= 5; setNum++) {
      const setInfo = allSets?.find(s => s.index === setNum)
      const setEvents = events?.filter(e => e.setIndex === setNum) || []

      const isSetFinished = setInfo?.finished === true

      const teamAPoints = isSetFinished
        ? (localTeamAKey === 'home' ? (setInfo?.homePoints || 0) : (setInfo?.awayPoints || 0))
        : null
      const teamBPoints = isSetFinished
        ? (localTeamBKey === 'home' ? (setInfo?.homePoints || 0) : (setInfo?.awayPoints || 0))
        : null

      const teamATimeouts = isSetFinished
        ? setEvents.filter(e => e.type === 'timeout' && e.payload?.team === localTeamAKey).length
        : null
      const teamBTimeouts = isSetFinished
        ? setEvents.filter(e => e.type === 'timeout' && e.payload?.team === localTeamBKey).length
        : null

      const teamASubstitutions = isSetFinished
        ? setEvents.filter(e => e.type === 'substitution' && e.payload?.team === localTeamAKey).length
        : null
      const teamBSubstitutions = isSetFinished
        ? setEvents.filter(e => e.type === 'substitution' && e.payload?.team === localTeamBKey).length
        : null

      const teamAWon = isSetFinished && teamAPoints !== null && teamBPoints !== null
        ? (teamAPoints > teamBPoints ? 1 : 0)
        : null
      const teamBWon = isSetFinished && teamAPoints !== null && teamBPoints !== null
        ? (teamBPoints > teamAPoints ? 1 : 0)
        : null

      // end - the set's actual start (its first rally), as on the sheet (never the schedule)
      const minutes = isSetFinished ? setDurationMinutes(setInfo, setEvents) : null
      const duration = minutes !== null && minutes > 0 ? `${minutes}'` : ''

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

  // Match finished info
  const matchWinner = useMemo(() => {
    if (!isMatchFinished || !data) return ''
    const teamWon = setsWon.team > setsWon.opponent
    return teamWon ? teamInfo.name : opponentInfo.name
  }, [isMatchFinished, data, setsWon, teamInfo, opponentInfo])

  const matchResult = useMemo(() => {
    if (!isMatchFinished) return ''
    return `${setsToWin(matchBestOf)}:${Math.min(setsWon.team, setsWon.opponent)}`
  }, [isMatchFinished, setsWon, matchBestOf])

  // Get timeouts used in current set
  const timeoutsUsed = useMemo(() => {
    if (!data?.events || !data?.set) return 0
    return data.events.filter(
      event => event.type === 'timeout' && 
      event.setIndex === data.set.index && 
      event.payload?.team === team
    ).length
  }, [data?.events, data?.set, team])

  // Get substitutions used in current set
  const substitutionsUsed = useMemo(() => {
    if (!data?.events || !data?.set) return 0
    return data.events.filter(
      event => event.type === 'substitution' && 
      event.setIndex === data.set.index && 
      event.payload?.team === team
    ).length
  }, [data?.events, data?.set, team])

  // Get who is serving
  const isServing = useMemo(() => {
    if (!data?.events || !data?.set) return false
    // Find the last serve event in current set
    const serveEvents = data.events
      .filter(e => e.type === 'point' && e.setIndex === data.set.index)
      .sort(newestFirst)
    
    if (serveEvents.length === 0) {
      // Check first serve from match
      const firstServe = data.match?.firstServe
      return firstServe === team
    }
    
    const lastPoint = serveEvents[0]
    return lastPoint.payload?.team === team
  }, [data?.events, data?.set, data?.match, team])

  // Get players on court
  const playersOnCourt = useMemo(() => {
    if (!data?.events || !data?.set) {
      // Return empty placeholders if no set data
      return ['I', 'II', 'III', 'IV', 'V', 'VI'].map(pos => ({
        number: null,
        position: pos,
        isCaptain: false,
        isLibero: false,
        liberoType: null
      }))
    }
    
    // Get lineup events for current set
    const lineupEvents = data.events
      .filter(e => e.type === 'lineup' && e.setIndex === data.set.index && e.payload?.team === team)
      .sort(newestFirst)
    
    const positions = ['I', 'II', 'III', 'IV', 'V', 'VI']
    
    // If no lineup events, return empty placeholders
    if (lineupEvents.length === 0) {
      return positions.map(pos => ({
        number: null,
        position: pos,
        isCaptain: false,
        isLibero: false,
        liberoType: null
      }))
    }
    
    const latestLineupEvent = lineupEvents[0]
    const latestLineup = latestLineupEvent?.payload?.lineup
    
    // Lineup is stored as an object { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
    // Convert to array in correct order: I, II, III (front), IV, V, VI (back)
    if (!latestLineup || typeof latestLineup !== 'object') {
      return positions.map(pos => ({
        number: null,
        position: pos,
        isCaptain: false,
        isLibero: false,
        liberoType: null,
        substitutedPlayerNumber: null
      }))
    }
    
    const players = positions.map((pos) => {
      const posData = latestLineup[pos]
      // Handle both rich format (posData is object with number) and legacy format (posData is number)
      const playerNum = posData && typeof posData === 'object' && posData.number !== undefined
        ? posData.number
        : posData
      if (!playerNum) {
        return {
          number: null,
          position: pos,
          isCaptain: false,
          isLibero: false,
          liberoType: null,
          substitutedPlayerNumber: null
        }
      }

      const player = teamInfo?.players?.find(p => String(p.number) === String(playerNum))

      // Check for libero substitution - first from rich format, then from liberoSubstitution payload
      let substitutedPlayerNumber = null
      if (posData && typeof posData === 'object' && posData.isLibero && posData.replacedNumber) {
        // Rich format has replacedNumber directly
        substitutedPlayerNumber = posData.replacedNumber
      } else {
        // Legacy format - check liberoSubstitution in payload
        const liberoSub = latestLineupEvent?.payload?.liberoSubstitution
        substitutedPlayerNumber = liberoSub &&
          String(liberoSub.liberoNumber) === String(playerNum) &&
          liberoSub.position === pos
          ? liberoSub.playerNumber
          : null
      }

      return {
        number: playerNum,
        position: pos,
        isCaptain: player?.isCaptain || false,
        isLibero: player?.libero === 'libero1' || player?.libero === 'libero2',
        liberoType: player?.libero,
        substitutedPlayerNumber: substitutedPlayerNumber
      }
    })
    
    return players
  }, [data?.events, data?.set, team, teamInfo])

  // Get player sanctions. The scorer stores the number as text ("7", from
  // the court disc), the roster and the line-up as a number: compare as text,
  // or the bench showed no sanction at all (full-match test 2026-11-09)
  const getPlayerSanctions = useCallback((playerNumber) => {
    if (!data?.events || playerNumber == null || playerNumber === '') return []
    return data.events.filter(
      e => e.type === 'sanction' &&
      e.payload?.team === team &&
      e.payload?.playerNumber != null &&
      String(e.payload.playerNumber) === String(playerNumber)
    )
  }, [data?.events, team])

  // Get official sanctions (by role)
  const getOfficialSanctions = useCallback((role) => {
    if (!data?.events) return []
    return data.events.filter(
      e => e.type === 'sanction' && 
      e.payload?.team === team && 
      e.payload?.role === role &&
      !e.payload?.playerNumber // Only team/official sanctions, not player sanctions
    )
  }, [data?.events, team])

  // Get bench players (players not on court, excluding liberos)
  const benchPlayersWithSanctions = useMemo(() => {
    if (!teamInfo?.players || !data?.events || !data?.set) return []
    
    // Get players currently on court
    const lineupEvents = data.events
      .filter(e => e.type === 'lineup' && e.setIndex === data.set.index && e.payload?.team === team)
      .sort(newestFirst)
    
    const playersOnCourtSet = new Set()
    if (lineupEvents.length > 0) {
      const latestLineup = lineupEvents[0].payload?.lineup
      if (latestLineup && typeof latestLineup === 'object') {
        Object.values(latestLineup).forEach(posData => {
          // Handle both rich format (object with number) and legacy format (just number)
          const num = posData && typeof posData === 'object' && posData.number !== undefined
            ? posData.number
            : posData
          if (num) playersOnCourtSet.add(Number(num))
        })
      }
    }

    // Get bench players: all players not on court, excluding liberos
    const benchPlayers = teamInfo.players
      .filter(p => {
        const playerNumber = Number(p.number)
        if (Number.isNaN(playerNumber)) return false
        if (playersOnCourtSet.has(playerNumber)) return false
        if (p.libero && p.libero !== '') return false // Exclude liberos
        
        // Filter out players who were exceptionally substituted
        const wasExceptionallySubstituted = data.events?.some(e =>
          e.type === 'substitution' &&
          e.payload?.team === team &&
          String(e.payload?.playerOut) === String(playerNumber) &&
          e.payload?.isExceptional === true
        )
        if (wasExceptionallySubstituted) return false
        
        return true
      })
      .map(p => {
        const sanctions = getPlayerSanctions(p.number)
        return {
          number: p.number,
          firstName: p.firstName || '',
          lastName: p.lastName || p.name || '',
          dob: p.dob || '',
          sanctions,
          type: 'player'
        }
      })
      .sort((a, b) => (a.number || 0) - (b.number || 0))
    
    return benchPlayers
  }, [teamInfo, data?.events, data?.set, team, getPlayerSanctions])

  // Get liberos (not currently on court)
  const benchLiberos = useMemo(() => {
    if (!teamInfo?.players || !data?.events || !data?.set) return []

    // Get players currently on court
    const lineupEvents = data.events
      .filter(e => e.type === 'lineup' && e.setIndex === data.set.index && e.payload?.team === team)
      .sort(newestFirst)

    const playersOnCourtSet = new Set()
    if (lineupEvents.length > 0) {
      const latestLineup = lineupEvents[0].payload?.lineup
      if (latestLineup && typeof latestLineup === 'object') {
        Object.values(latestLineup).forEach(posData => {
          // Handle both rich format (object with number) and legacy format (just number)
          const num = posData && typeof posData === 'object' && posData.number !== undefined
            ? posData.number
            : posData
          if (num) playersOnCourtSet.add(Number(num))
        })
      }
    }

    // Get liberos not on court
    const liberos = teamInfo.players
      .filter(p => {
        const playerNumber = Number(p.number)
        if (Number.isNaN(playerNumber)) return false
        if (!p.libero || p.libero === '') return false
        if (playersOnCourtSet.has(playerNumber)) return false
        return true
      })
      .map(p => {
        const sanctions = getPlayerSanctions(p.number)
        return {
          number: p.number,
          firstName: p.firstName || '',
          lastName: p.lastName || p.name || '',
          dob: p.dob || '',
          libero: p.libero,
          isCaptain: p.isCaptain || p.captain || false,
          sanctions,
          type: 'libero'
        }
      })
      .sort((a, b) => {
        // Sort by libero type first (L1 before L2), then by number
        if (a.libero !== b.libero) {
          return (a.libero === 'libero1' ? 0 : 1) - (b.libero === 'libero1' ? 0 : 1)
        }
        return (a.number || 0) - (b.number || 0)
      })
    
    return liberos
  }, [teamInfo, data?.events, data?.set, team, getPlayerSanctions])

  // Get bench officials
  const benchOfficials = useMemo(() => {
    if (!teamInfo?.bench) return []
    return teamInfo.bench
      .filter(b => b.firstName || b.lastName || b.role)
      .map(bench => {
        const sanctions = getOfficialSanctions(bench.role || '')
        return {
          role: bench.role || '',
          firstName: bench.firstName || '',
          lastName: bench.lastName || '',
          dob: bench.dob || '',
          sanctions,
          type: 'official'
        }
      })
  }, [teamInfo, getOfficialSanctions])

  // Get overall team sanctions
  const overallSanctions = useMemo(() => {
    if (!data?.events) return []
    return data.events.filter(
      e => e.type === 'sanction' &&
      e.payload?.team === team &&
      (!e.payload?.playerNumber || e.payload?.role)
    )
  }, [data?.events, team])

  // Collect all sanctions for display - MUST be before any early returns to maintain consistent hook order
  const allSanctionsForDisplay = useMemo(() => {
    const sanctions = []

    // Player sanctions (on court)
    playersOnCourt.forEach(player => {
      if (player.number) {
        const playerSanctions = getPlayerSanctions(player.number)
        playerSanctions.forEach(s => {
          sanctions.push({
            type: 'player',
            number: player.number,
            sanctionType: s.payload?.type || 'warning'
          })
        })
      }
    })

    // Bench player sanctions
    benchPlayersWithSanctions.forEach(player => {
      player.sanctions.forEach(s => {
        sanctions.push({
          type: 'bench',
          number: player.number,
          sanctionType: s.payload?.type || 'warning'
        })
      })
    })

    // Libero sanctions
    benchLiberos.forEach(libero => {
      libero.sanctions.forEach(s => {
        sanctions.push({
          type: 'libero',
          number: libero.number,
          sanctionType: s.payload?.type || 'warning'
        })
      })
    })

    // Official sanctions
    benchOfficials.forEach(official => {
      if (official.sanctions) {
        official.sanctions.forEach(s => {
          sanctions.push({
            type: 'official',
            role: official.role,
            sanctionType: s.payload?.type || 'warning'
          })
        })
      }
    })

    // Overall team sanctions
    overallSanctions.forEach(s => {
      sanctions.push({
        type: 'team',
        role: s.payload?.role || 'Team',
        sanctionType: s.payload?.type || 'warning'
      })
    })

    return sanctions
  }, [playersOnCourt, benchPlayersWithSanctions, benchLiberos, benchOfficials, overallSanctions, getPlayerSanctions])

  if (!data || !teamInfo) {
    if (embedded) {
      return (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}>
          <div>{t('matchEntry.loading', 'Loading...')}</div>
        </div>
      )
    }
    return (
      <div style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}>
        <div>Loading...</div>
      </div>
    )
  }

  // Reorder players based on team side
  // Left team: Front row (IV, III, II), Back row (V, VI, I)
  // Right team: Front row (II, III, IV), Back row (I, VI, V) - mirrored
  const frontRow = playersOnCourt.filter(p => ['II', 'III', 'IV'].includes(p.position))
    .sort((a, b) => {
      if (teamSide === 'right') {
        // Right team: II, III, IV
        const order = { 'II': 0, 'III': 1, 'IV': 2 }
        return (order[a.position] || 0) - (order[b.position] || 0)
      } else {
        // Left team: IV, III, II
        const order = { 'IV': 0, 'III': 1, 'II': 2 }
        return (order[a.position] || 0) - (order[b.position] || 0)
      }
    })
  const backRow = playersOnCourt.filter(p => ['I', 'VI', 'V'].includes(p.position))
    .sort((a, b) => {
      if (teamSide === 'right') {
        // Right team: I, VI, V
        const order = { 'I': 0, 'VI': 1, 'V': 2 }
        return (order[a.position] || 0) - (order[b.position] || 0)
      } else {
        // Left team: V, VI, I
        const order = { 'V': 0, 'VI': 1, 'I': 2 }
        return (order[a.position] || 0) - (order[b.position] || 0)
      }
    })
  const position1Player = playersOnCourt.find(p => p.position === 'I')
  const showBall = isServing && position1Player

  // The most severe of a list of sanction events, as a small card glyph (a bench chip)
  const chipCard = (events) => {
    const kind = topSanction(sanctionFlags(events))
    return kind ? <CardGlyph kind={kind} height="16px" /> : null
  }

  // One player on the half court. Every size is a share of the court's height
  // (cqh: .court is the size container), so the disc, its number, its marks
  // and the serve ball grow together with the court.
  const renderDisc = (player, key) => {
    const sanctions = player.number ? getPlayerSanctions(player.number) : []
    const mark = topSanction(sanctionFlags(sanctions))
    const shouldShowBall = showBall && player.position === 'I'
    const teamPlayers = teamInfo?.players || []
    const liberoCount = teamPlayers.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
    const liberoLabel = liberoCount === 1 ? 'L' : (player.liberoType === 'libero1' ? 'L1' : 'L2')
    return (
      <div
        key={key}
        className="court-player"
        style={{
          ...discStyle(player.isLibero),
          position: 'relative',
          aspectRatio: '1 / 1',
          // half the disc (.court-player is 22cqh), as on the referee discs
          // (discSizing DISC.number)
          fontSize: '11cqh'
        }}
      >
        {shouldShowBall && (
          // on the end-line side, a clear gap from the disc (owner 2026-11-09)
          <img src={ballImage} onError={(e) => e.target.src = ballFallback} alt="Serve" style={{
            position: 'absolute',
            left: teamSide === 'left' ? 'calc(-9cqh - 2.6cqh)' : 'auto',
            right: teamSide === 'left' ? 'auto' : 'calc(-9cqh - 2.6cqh)',
            top: '50%',
            transform: 'translateY(-50%)',
            width: '9cqh',
            height: '9cqh',
            zIndex: 5,
            filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))'
          }} />
        )}
        {player.substitutedPlayerNumber && (
          <span style={{
            position: 'absolute', top: '-1.5cqh', right: '-1.5cqh',
            minWidth: '5.5cqh', height: '5.5cqh', padding: '0 0.6cqh', boxSizing: 'border-box', background: '#FFF8E7',
            border: '2px solid rgba(0,0,0,0.2)', borderRadius: '1cqh',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '3.2cqh', fontWeight: 700, color: '#000', zIndex: 6
          }}>{player.substitutedPlayerNumber}</span>
        )}
        <span className="court-player-position">{player.position}</span>
        {player.isCaptain && (
          <span className="court-player-captain" style={player.isLibero ? { background: '#fff', color: '#10b981', borderColor: '#10b981' } : {}}>C</span>
        )}
        {player.isLibero && !player.isCaptain && (
          <span style={{
            position: 'absolute', bottom: '-1.5cqh', left: '-1.5cqh',
            minWidth: '6.5cqh', height: '5cqh', padding: '0 0.6cqh', boxSizing: 'border-box', background: liberoMarkOn(true),
            border: '2px solid rgba(255,255,255,0.4)', borderRadius: '1cqh',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '3cqh', fontWeight: 700, color: '#fff', zIndex: 5
          }}>{liberoLabel}</span>
        )}
        {player.number || '—'}
        {mark && (
          <div data-disc-sanction={mark} style={{ position: 'absolute', bottom: '-1cqh', right: '-1cqh', zIndex: 10, display: 'flex' }}>
            <CardGlyph kind={mark} height="6.5cqh" />
          </div>
        )}
      </div>
    )
  }

  // Show results when match is finished
  if (isMatchFinished) {
    const teamAShortName = data?.match?.coinTossTeamA === 'home'
      ? (data?.match?.homeShortName || data?.homeTeam?.shortName || data?.homeTeam?.name || t('common.home'))
      : (data?.match?.awayShortName || data?.awayTeam?.shortName || data?.awayTeam?.name || t('common.away'))
    const teamBShortName = data?.match?.coinTossTeamA === 'home'
      ? (data?.match?.awayShortName || data?.awayTeam?.shortName || data?.awayTeam?.name || t('common.away'))
      : (data?.match?.homeShortName || data?.homeTeam?.shortName || data?.homeTeam?.name || t('common.home'))

    return (
      <div style={{
        minHeight: embedded ? 'auto' : '100vh',
        height: embedded ? '100%' : 'auto',
        background: embedded ? 'transparent' : 'var(--bg)',
        color: 'var(--text)',
        padding: embedded ? '12px' : '20px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '24px'
      }}>
        {/* Match Ended Banner */}
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
          {t('matchEntry.matchHasEnded', 'The match has ended')}
        </div>

        {/* Winner and Result */}
        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontSize: '32px',
            fontWeight: 700,
            marginBottom: '8px'
          }}>
            {matchWinner}
          </div>
          <div style={{
            fontSize: '48px',
            fontWeight: 800,
            color: 'var(--accent)'
          }}>
            {matchResult}
          </div>
        </div>

        {/* Results Table (.ov-legacy-results: frozen print block, RESTYLE-SPEC R5) */}
        <div className="ov-legacy-results" style={{
          width: '100%',
          maxWidth: '500px',
          background: 'white',
          borderRadius: '12px',
          overflow: 'hidden'
        }}>
          <Results
            teamAShortName={teamAShortName}
            teamBShortName={teamBShortName}
            setResults={calculateSetResults}
            winner={matchWinner}
            result={matchResult}
          />
        </div>

        {!embedded && (
          <div className="ov-kit" style={{ marginTop: '16px' }}>
            <Button variant="secondary" size="xl" icon={ArrowLeft} className="font-medium" onClick={onBack}>
              {t('matchEntry.back', 'Back')}
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div data-bench-live="" style={{
      // at least the screen (the court slot takes what the rest leaves),
      // longer when the screen is too short: the bench page scrolls
      minHeight: embedded ? 0 : '100vh',
      background: embedded ? 'transparent' : 'var(--bg)',
      color: 'var(--text)',
      padding: embedded ? 'clamp(8px, 1.5vw, 12px)' : '12px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      display: 'flex',
      flexDirection: 'column',
      flex: embedded ? '1 0 auto' : 'none',
      gap: 'clamp(8px, 1.5vw, 12px)'
    }}>
      {/* Header with Back button - only show when not embedded */}
      {!embedded && (
        // 1fr auto 1fr: the team name stays centred whatever the Back width.
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '4px'
        }}>
          <div className="ov-kit" style={{ justifySelf: 'start' }}>
            <Button variant="toolbar" size="xl" className="font-medium" onClick={onBack}>
              {t('matchEntry.backArrow', '← Back')}
            </Button>
          </div>
          <h1 className="tracking-tight text-stone-900" style={{ fontSize: '18px', fontWeight: 700, margin: 0, textAlign: 'center' }}>
            {teamInfo.name}
          </h1>
          <div />
        </div>
      )}

      {/* SECTION 1: the score and the set */}
      <div data-bench-score="" style={{
        ...SURFACE,
        borderRadius: '14px',
        padding: 'clamp(6px, 1.5vw, 12px) 12px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '2px',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'clamp(8px, 2vw, 18px)', lineHeight: 1 }}>
          <span style={{ fontSize: 'clamp(48px, 13vw, 112px)', fontWeight: 800, color: '#22c55e', fontVariantNumeric: 'tabular-nums' }}>{points.team}</span>
          <span style={{ fontSize: 'clamp(28px, 7vw, 60px)', fontWeight: 600, color: 'var(--muted)' }}>:</span>
          <span style={{ fontSize: 'clamp(34px, 9vw, 80px)', fontWeight: 600, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{points.opponent}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', fontSize: 'clamp(15px, 2.6vw, 22px)' }}>
          <span style={{ color: 'var(--muted)' }}>{t('common.setIndex', { index: data?.set?.index || 1 })}</span>
          <span style={{ fontWeight: 700, color: '#22c55e', fontSize: '1.25em', fontVariantNumeric: 'tabular-nums' }}>{setsWon.team}</span>
          <span style={{ color: 'var(--muted)' }}>-</span>
          <span style={{ fontWeight: 600, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{setsWon.opponent}</span>
        </div>
      </div>

      {/* SECTION 2: TO | SUB | Sanctions. The counters' digits are read from
          the bench: large, with the limit beside them (2 time-outs, 6
          substitutions a set). minmax(0, 1fr): the sanctions take the rest
          and wrap, never off the screen. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'auto auto minmax(0, 1fr)',
        gap: 'clamp(6px, 1.5vw, 12px)',
        alignItems: 'stretch',
        flexShrink: 0
      }}>
        {[
          { key: 'to', label: t('matchEntry.to', 'TO'), value: timeoutsUsed, limit: 2, tone: timeoutsUsed >= 2 ? 'max' : null },
          { key: 'sub', label: t('matchEntry.sub', 'SUB'), value: substitutionsUsed, limit: 6, tone: substitutionsUsed >= 6 ? 'max' : substitutionsUsed >= 5 ? 'near' : null }
        ].map((c) => (
          <div key={c.key} data-bench-counter={c.key} style={{
            ...SURFACE,
            background: c.tone === 'max' ? 'rgba(239, 68, 68, 0.12)' : c.tone === 'near' ? 'rgba(234, 179, 8, 0.14)' : 'var(--ov-card)',
            border: c.tone === 'max' ? '2px solid #ef4444' : c.tone === 'near' ? '2px solid #eab308' : '1px solid var(--ov-hairline-soft)',
            borderRadius: '14px',
            padding: '6px clamp(8px, 2vw, 16px)',
            minWidth: 'clamp(76px, 18vw, 150px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <div style={{ fontSize: 'clamp(13px, 2.2vw, 18px)', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--muted)' }}>{c.label}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px', lineHeight: 1 }}>
              <span style={{ fontSize: 'clamp(44px, 10vw, 88px)', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: c.tone === 'max' ? '#ef4444' : c.tone === 'near' ? '#ca8a04' : 'var(--text)' }}>{c.value}</span>
              <span style={{ fontSize: 'clamp(14px, 2.4vw, 22px)', fontWeight: 600, color: 'var(--muted)' }}>/{c.limit}</span>
            </div>
          </div>
        ))}

        {/* The team's sanctions: the cards the referee showed, and to whom */}
        <div data-bench-sanctions="" style={{
          ...SURFACE,
          borderRadius: '14px',
          padding: '8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          minWidth: 0,
          overflow: 'auto'
        }}>
          <div style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{t('matchEntry.sanctions', 'SANCTIONS')}</div>
          {allSanctionsForDisplay.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: '14px' }}>{t('matchEntry.none', 'None')}</div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: '8px 14px', alignItems: 'center' }}>
              {allSanctionsForDisplay.map((s, idx) => {
                const card = cardOfSanctionType(s.sanctionType)
                const who = s.type === 'player' || s.type === 'bench' || s.type === 'libero'
                  ? `#${s.number}`
                  : card?.delay ? 'D' : card?.improperRequest ? t('scoreboard.sanctions.improperRequest', 'Improper request') : s.role
                return (
                  <li key={idx} data-bench-sanction={s.sanctionType} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {card?.kind && <CardGlyph kind={card.kind} height="clamp(20px, 3.2vw, 28px)" />}
                    <span style={{ fontWeight: 700, fontSize: card?.improperRequest ? '13px' : 'clamp(16px, 2.6vw, 22px)', fontVariantNumeric: 'tabular-nums' }}>{who}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {/* SECTION 3: the team's half court, a square as large as the space
          left allows (the slot is a size container: min(100cqw, 100cqh)).
          It never gets smaller than 240 px: on a phone on its side the page
          scrolls instead (a 55 px strip with 11 px discs, emulator 2026-10-14). */}
      <div data-bench-court-slot="" style={{
        flex: '1 1 0',
        minHeight: '240px',
        containerType: 'size',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <div style={{
          width: 'min(100cqw, 100cqh)',
          height: 'min(100cqw, 100cqh)',
          position: 'relative'
        }}>
          {/* One team's half: a single grid column. The scoreboard's .court is a
              two-column grid (95% wide), which gave this side only half the box
              and cut the front row (and the away bench's II/III/IV labels) off
              at the middle. */}
          <div className="court" style={{
            width: '100%',
            maxWidth: '100%',
            height: '100%',
            position: 'relative',
            gridTemplateColumns: '1fr'
          }}>
            {/* 3m line */}
            <div className="court-attack-line" style={{
              left: teamSide === 'left' ? 'calc(100% - 40.33%)' : '40.33%',
              right: teamSide === 'left' ? '0' : 'auto'
            }} />

            {/* Net */}
            <div className="court-net" style={{
              left: teamSide === 'left' ? 'auto' : '0',
              right: teamSide === 'left' ? '0' : 'auto',
              transform: 'none',
              width: '6px'
            }} />

            {/* Single side court */}
            <div className={`court-side court-side-${teamSide}`} style={{ width: '100%' }}>
              <div className={`court-team court-team-${teamSide}`} style={{ width: '100%', height: '100%' }}>
                <div className="court-row court-row-front">
                  {frontRow.map((player, idx) => renderDisc(player, `front-${player.position}-${idx}`))}
                </div>
                <div className="court-row court-row-back">
                  {backRow.map((player, idx) => renderDisc(player, `back-${player.position}-${idx}`))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 4: Bench - Players, Liberos, Officials (N and Codes only) */}
      <div style={{
        ...SURFACE,
        borderRadius: '14px',
        padding: '10px 12px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        alignItems: 'center',
        flexShrink: 0
      }}>
        {/* Bench Players */}
        {benchPlayersWithSanctions.map((player, idx) => (
          <div key={`bp-${idx}`} style={{ ...BENCH_CHIP }}>
            <span style={{ fontWeight: 700 }}>#{player.number}</span>
            {chipCard(player.sanctions)}
          </div>
        ))}

        {/* Separator if both players and liberos exist */}
        {benchPlayersWithSanctions.length > 0 && benchLiberos.length > 0 && (
          <div style={{ width: '1px', height: '24px', background: 'var(--border)' }}></div>
        )}

        {/* Liberos */}
        {benchLiberos.map((libero, idx) => {
          const liberoCount = teamInfo?.players?.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length || 0
          const liberoLabel = liberoCount === 1 ? 'L' : (libero.libero === 'libero1' ? 'L1' : 'L2')
          return (
            <div key={`lib-${idx}`} style={{
              ...BENCH_CHIP,
              background: 'rgba(59, 130, 246, 0.15)',
              border: '1px solid rgba(59, 130, 246, 0.3)'
            }}>
              <span style={{
                background: '#3b82f6',
                color: '#fff',
                padding: '1px 5px',
                borderRadius: '3px',
                fontSize: '11px',
                fontWeight: 700
              }}>{liberoLabel}</span>
              <span style={{ fontWeight: 700 }}>#{libero.number}</span>
              {libero.isCaptain && (
                <span style={{
                  background: '#fff',
                  color: '#10b981',
                  border: '1px solid #10b981',
                  borderRadius: '3px',
                  padding: '0 4px',
                  fontSize: '11px',
                  fontWeight: 700
                }}>C</span>
              )}
              {chipCard(libero.sanctions)}
            </div>
          )
        })}

        {/* Separator if liberos/players and officials exist */}
        {(benchPlayersWithSanctions.length > 0 || benchLiberos.length > 0) && benchOfficials.length > 0 && (
          <div style={{ width: '1px', height: '24px', background: 'var(--border)' }}></div>
        )}

        {/* Officials - show role codes */}
        {benchOfficials.map((official, idx) => {
          // The paper's role code (C, AC1, AC2, P, M), as the scorer's
          // bench list shows it: the first letter made both assistant coaches
          // "A" (emulator 2026-10-14)
          const target = official.role ? sanctionTarget({ playerType: 'official', role: official.role }, t) : null
          const roleCode = target && !target.incomplete ? target.code : (official.role?.charAt(0)?.toUpperCase() || '?')
          return (
            <div key={`off-${idx}`} title={target && !target.incomplete ? target.label : official.role || undefined} style={{ ...BENCH_CHIP }}>
              <span style={{ fontWeight: 700, fontSize: '13px' }}>{roleCode}</span>
              {chipCard(official.sanctions)}
            </div>
          )
        })}

        {/* Empty state */}
        {benchPlayersWithSanctions.length === 0 && benchLiberos.length === 0 && benchOfficials.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: '13px' }}>
            {t('matchEntry.noBenchData', 'No bench data')}
          </div>
        )}
      </div>

      {/* Test Mode Controls - only shown in test mode */}
      {(matchId === -1 || data?.match?.test === true) && (
        <TestModeControls
          matchId={matchId}
          onRefresh={() => {
            if (matchId && matchId !== -1) {
              getMatchData(matchId).then(result => {
                if (result.success) {
                  setData(result)
                }
              })
            }
          }}
        />
      )}
    </div>
  )
}