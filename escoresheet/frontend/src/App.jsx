import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import MatchSetup from './components/MatchSetup'
import Scoreboard from './components/Scoreboard'
import Modal from './components/Modal'
import { useSyncQueue } from './hooks/useSyncQueue'
import mikasaVolleyball from './mikasa_v200w.png'

const SAMPLE_GAMES = [
  { gamen: '382364', league: '3L B', date: '26.09.2025 20:00', home: 'KSC Wiedikon H3', away: 'VBC Wetzikon H2', hall: 'Kantonsschule Wiedikon C', city: 'Zürich' },
  { gamen: '382395', league: '3L B', date: '12.11.2025 20:00', home: 'KSC Wiedikon H3', away: 'VC Tornado Adliswil H1', hall: 'Kantonsschule Wiedikon (Halle A)', city: 'Zürich' },
  { gamen: '382376', league: '3L B', date: '10.12.2025 20:00', home: 'KSC Wiedikon H3', away: 'Volley Oerlikon H2', hall: 'Kantonsschule Wiedikon (Halle A)', city: 'Zürich' },
  { gamen: '382416', league: '3L B', date: '09.01.2026 20:00', home: 'KSC Wiedikon H3', away: 'VBC Rämi H2', hall: 'Kantonsschule Wiedikon (Halle A)', city: 'Zürich' },
  { gamen: '382372', league: '3L B', date: '23.01.2026 20:00', home: 'KSC Wiedikon H3', away: 'VBC Stäfa H1', hall: 'Kantonsschule Wiedikon (Halle B)', city: 'Zürich' },
  { gamen: '382403', league: '3L B', date: '30.01.2026 20:00', home: 'KSC Wiedikon H3', away: 'VBC Volewa Wald H1', hall: 'Kantonsschule Wiedikon (Halle A)', city: 'Zürich' },
  { gamen: '382427', league: '3L B', date: '06.02.2026 20:00', home: 'KSC Wiedikon H3', away: 'Volley Uster H2', hall: 'Kantonsschule Wiedikon (Halle A)', city: 'Zürich' },
  { gamen: '382384', league: '3L B', date: '27.02.2026 20:00', home: 'KSC Wiedikon H3', away: 'VBC Voléro Zürich 4', hall: 'Kantonsschule Wiedikon (Halle B)', city: 'Zürich' }
]

function parseDateTime(dateTime) {
  const [datePart, timePart] = dateTime.split(' ')
  const [day, month, year] = datePart.split('.').map(Number)
  const [hours, minutes] = timePart.split(':').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hours, minutes))
  return date.toISOString()
}

export default function App() {
  const [matchId, setMatchId] = useState(null)
  const [showMatchSetup, setShowMatchSetup] = useState(false)
  const [showCoinToss, setShowCoinToss] = useState(false)
  const [deleteMatchModal, setDeleteMatchModal] = useState(null)
  const [newMatchModal, setNewMatchModal] = useState(null)
  const { syncStatus, isOnline } = useSyncQueue()

  const activeMatch = useLiveQuery(async () => {
    try {
      return await db.matches
        .where('status')
        .equals('live')
        .first()
    } catch (error) {
      console.error('Unable to load active match', error)
      return null
    }
  }, [])

  // Get current match (most recent match that's not final)
  const currentMatch = useLiveQuery(async () => {
    try {
      // First try to get a live match
      const liveMatch = await db.matches.where('status').equals('live').first()
      if (liveMatch) return liveMatch

      // Otherwise get the most recent match that's not final
      const matches = await db.matches.orderBy('createdAt').reverse().toArray()
      const nonFinalMatch = matches.find(m => m.status !== 'final')
      return nonFinalMatch || null
    } catch (error) {
      console.error('Unable to load current match', error)
      return null
    }
  }, [])

  // Get match status and details
  const matchStatus = useLiveQuery(async () => {
    if (!currentMatch) return null

    const [homeTeam, awayTeam] = await Promise.all([
      currentMatch.homeTeamId ? db.teams.get(currentMatch.homeTeamId) : null,
      currentMatch.awayTeamId ? db.teams.get(currentMatch.awayTeamId) : null
    ])

    const sets = await db.sets.where('matchId').equals(currentMatch.id).toArray()
    const homePlayers = currentMatch.homeTeamId ? await db.players.where('teamId').equals(currentMatch.homeTeamId).count() : 0
    const awayPlayers = currentMatch.awayTeamId ? await db.players.where('teamId').equals(currentMatch.awayTeamId).count() : 0
    
    let status = 'No data'
    if (currentMatch.status === 'final' || (sets.length > 0 && sets.every(s => s.finished))) {
      status = 'Match ended'
    } else if (currentMatch.status === 'live' || (sets.length > 0 && sets.some(s => !s.finished))) {
      status = 'Match recording'
    } else if (homePlayers > 0 || awayPlayers > 0 || currentMatch.homeCoachSignature || currentMatch.awayCoachSignature) {
      // Has players or signatures but no sets started
      if (currentMatch.homeCoachSignature && currentMatch.awayCoachSignature && currentMatch.homeCaptainSignature && currentMatch.awayCaptainSignature) {
        status = 'Coin toss'
      } else {
        status = 'Setup'
      }
    }

    return {
      match: currentMatch,
      homeTeam,
      awayTeam,
      status
    }
  }, [currentMatch])

  const restoredRef = useRef(false)

  // Preload volleyball image when app loads
  useEffect(() => {
    // Preload the image
    const img = new Image()
    img.src = mikasaVolleyball
    
    // Also add a preload link to the document head for early loading
    const link = document.createElement('link')
    link.rel = 'preload'
    link.as = 'image'
    link.href = mikasaVolleyball
    document.head.appendChild(link)
    
    return () => {
      // Cleanup: remove preload link if component unmounts
      const existingLink = document.querySelector(`link[href="${mikasaVolleyball}"]`)
      if (existingLink) {
        document.head.removeChild(existingLink)
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const disableRefreshKeys = event => {
      const key = event.key?.toLowerCase?.()
      const isRefresh =
        key === 'f5' ||
        ((event.ctrlKey || event.metaKey) && key === 'r') ||
        ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'r') || // Ctrl+Shift+R
        (event.shiftKey && key === 'f5')

      if (isRefresh) {
        event.preventDefault()
        event.stopPropagation()
        return false
      }
    }

    const disableBackspaceNavigation = event => {
      // Prevent backspace from navigating back (but allow it in input fields)
      if (event.key === 'Backspace' || event.keyCode === 8) {
        const target = event.target || event.srcElement
        const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
        if (!isInput) {
          event.preventDefault()
          return false
        }
      }
    }

    const blockHistoryNavigation = event => {
      // Push a new state to prevent back/forward navigation
      history.pushState(null, '', window.location.href)
    }

    // Push initial state to prevent back navigation
    try {
      history.pushState(null, '', window.location.href)
    } catch (err) {
      // Ignore history errors (e.g., older browsers or restricted environments)
    }

    // Prevent browser back/forward buttons
    window.addEventListener('popstate', blockHistoryNavigation)
    
    // Prevent refresh keyboard shortcuts
    window.addEventListener('keydown', disableRefreshKeys, { passive: false })
    
    // Prevent backspace navigation (except in input fields)
    window.addEventListener('keydown', disableBackspaceNavigation, { passive: false })

    // Also prevent context menu refresh option (right-click refresh)
    window.addEventListener('contextmenu', event => {
      // Allow context menu but we can't prevent refresh from it directly
      // The keydown handler will catch Ctrl+R if user tries that
    })

    return () => {
      window.removeEventListener('keydown', disableRefreshKeys)
      window.removeEventListener('keydown', disableBackspaceNavigation)
      window.removeEventListener('popstate', blockHistoryNavigation)
    }
  }, [])


  useEffect(() => {
    if (activeMatch) {
      if (!restoredRef.current && !matchId) {
        setMatchId(activeMatch.id)
        restoredRef.current = true
      }
    } else {
      restoredRef.current = false
    }
  }, [activeMatch, matchId])

  async function finishSet(cur) {
    await db.sets.update(cur.id, { finished: true })
    const sets = await db.sets.where({ matchId: cur.matchId }).toArray()
    const finished = sets.filter(s => s.finished).length
    if (finished >= 5) {
      await db.matches.update(cur.matchId, { status: 'final' })
      
      // Add match update to sync queue
      await db.sync_queue.add({
        resource: 'match',
        action: 'update',
        payload: {
          id: String(cur.matchId),
          status: 'final'
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })
      
      setMatchId(null)
      return
    }
    const setId = await db.sets.add({ matchId: cur.matchId, index: cur.index + 1, homePoints: 0, awayPoints: 0, finished: false })
    
    // Add set to sync queue
    await db.sync_queue.add({
      resource: 'set',
      action: 'insert',
      payload: {
        external_id: String(setId),
        match_id: String(cur.matchId),
        index: cur.index + 1,
        home_points: 0,
        away_points: 0,
        finished: false,
        created_at: new Date().toISOString()
      },
      ts: new Date().toISOString(),
      status: 'queued'
    })
  }

  const openMatchSetup = () => setMatchId(null)
  
  const openMatchSetupView = () => setShowMatchSetup(true)
  
  const openCoinTossView = () => {
    setShowMatchSetup(true)
    setShowCoinToss(true)
  }
  
  const returnToMatch = () => setShowMatchSetup(false)
  
  const goHome = () => {
    setMatchId(null)
    setShowMatchSetup(false)
  }


  const firstNames = ['Max', 'Luca', 'Tom', 'Jonas', 'Felix', 'Noah', 'David', 'Simon', 'Daniel', 'Michael', 'Anna', 'Sarah', 'Lisa', 'Emma', 'Sophie', 'Laura', 'Julia', 'Maria', 'Nina', 'Sara']
  const lastNames = ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun']
  
  function generateRandomBenchOfficials() {
    // Coach is mandatory, others are optional
    const mandatoryRoles = ['Coach']
    const optionalRoles = ['Assistant Coach 1', 'Assistant Coach 2', 'Medic', 'Physiotherapist']
    
    const officials = mandatoryRoles.map(role => {
      const firstName = firstNames[Math.floor(Math.random() * firstNames.length)]
      const lastName = lastNames[Math.floor(Math.random() * lastNames.length)]
      const dob = randomDate('1970-01-01', '1995-12-31')
      return {
        role,
        firstName,
        lastName,
        dob
      }
    })
    
    // Add 0-3 optional roles randomly
    const optionalCount = Math.floor(Math.random() * 4)
    const selectedOptional = optionalRoles
      .sort(() => Math.random() - 0.5)
      .slice(0, optionalCount)
      .map(role => {
        const firstName = firstNames[Math.floor(Math.random() * firstNames.length)]
        const lastName = lastNames[Math.floor(Math.random() * lastNames.length)]
        const dob = randomDate('1970-01-01', '1995-12-31')
        return {
          role,
          firstName,
          lastName,
          dob
        }
      })
    
    return [...officials, ...selectedOptional]
  }

  function randomDate(start, end) {
    const startDate = new Date(start).getTime()
    const endDate = new Date(end).getTime()
    const randomTime = startDate + Math.random() * (endDate - startDate)
    const date = new Date(randomTime)
    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const year = date.getFullYear()
    return `${day}/${month}/${year}`
  }

  function generateRandomPlayers(teamId, config = {}) {
    // Config options: { totalPlayers: 12, liberoCount: 1 } or { totalPlayers: 11, liberoCount: 1 }
    // Valid combinations: 11+1, 12+0, 11+2, 12+2
    // At least 6 non-libero players required
    const { totalPlayers = 12, liberoCount = 1 } = config
    const nonLiberoCount = totalPlayers - liberoCount
    
    if (nonLiberoCount < 6) {
      throw new Error('At least 6 non-libero players required')
    }
    
    const numbers = Array.from({ length: totalPlayers }, (_, i) => i + 1)
    const shuffled = numbers.sort(() => Math.random() - 0.5)
    
    let captainAssigned = false
    
    return shuffled.slice(0, totalPlayers).map((number, idx) => {
      const firstName = firstNames[Math.floor(Math.random() * firstNames.length)]
      const lastName = lastNames[Math.floor(Math.random() * lastNames.length)]
      const dob = randomDate('1990-01-01', '2005-12-31')
      
      // Assign libero roles
      let libero = ''
      if (idx < liberoCount) {
        libero = idx === 0 ? 'libero1' : 'libero2'
      }
      
      // Assign captain to first non-libero player
      let isCaptain = false
      if (!captainAssigned && libero === '') {
        isCaptain = true
        captainAssigned = true
      }
      
      return {
        teamId,
        number,
        name: `${lastName} ${firstName}`,
        lastName,
        firstName,
        dob,
        libero,
        isCaptain,
        role: null,
        createdAt: new Date().toISOString()
      }
    })
  }

  async function showDeleteMatchModal() {
    if (!currentMatch) return

    const [homeTeam, awayTeam] = await Promise.all([
      currentMatch.homeTeamId ? db.teams.get(currentMatch.homeTeamId) : null,
      currentMatch.awayTeamId ? db.teams.get(currentMatch.awayTeamId) : null
    ])
    const matchName = `${homeTeam?.name || 'Home'} vs ${awayTeam?.name || 'Away'}`
    
    setDeleteMatchModal({
      matchName,
      matchId: currentMatch.id
    })
  }

  async function confirmDeleteMatch() {
    if (!deleteMatchModal) return

    await db.transaction('rw', db.matches, db.sets, db.events, db.players, db.teams, db.sync_queue, db.match_setup, async () => {
      // Delete sets
      const sets = await db.sets.where('matchId').equals(deleteMatchModal.matchId).toArray()
      if (sets.length > 0) {
        await db.sets.bulkDelete(sets.map(s => s.id))
      }
      
      // Delete events
      const events = await db.events.where('matchId').equals(deleteMatchModal.matchId).toArray()
      if (events.length > 0) {
        await db.events.bulkDelete(events.map(e => e.id))
      }
      
      // Get match to find team IDs
      const match = await db.matches.get(deleteMatchModal.matchId)
      
      // Delete players
      if (match?.homeTeamId) {
        await db.players.where('teamId').equals(match.homeTeamId).delete()
      }
      if (match?.awayTeamId) {
        await db.players.where('teamId').equals(match.awayTeamId).delete()
      }
      
      // Delete teams
      if (match?.homeTeamId) {
        await db.teams.delete(match.homeTeamId)
      }
      if (match?.awayTeamId) {
        await db.teams.delete(match.awayTeamId)
      }
      
      // Delete all sync queue items (since we can't filter by matchId easily)
      await db.sync_queue.clear()
      
      // Delete match setup draft
      await db.match_setup.clear()
      
      // Delete match
      await db.matches.delete(deleteMatchModal.matchId)
    })

    setDeleteMatchModal(null)
    setMatchId(null)
    setShowMatchSetup(false)
  }

  function cancelDeleteMatch() {
    setDeleteMatchModal(null)
  }

  async function createNewOfficialMatch() {
    // Check if match is ongoing
    if (matchStatus?.status === 'Match recording') {
      return // Don't allow creating new match when one is ongoing
    }

    // Delete current match if exists
    if (currentMatch) {
      setNewMatchModal({
        type: 'official',
        message: 'There is an existing match. Do you want to delete it and create a new official match?'
      })
      return
    }

    // Create new blank match
    const newMatchId = await db.matches.add({
      status: 'scheduled',
      createdAt: new Date().toISOString()
    })

    setMatchId(newMatchId)
    setShowMatchSetup(true)
    setShowCoinToss(false) // Ensure we go to match setup, not coin toss
  }

  async function confirmNewMatch() {
    if (!newMatchModal) return

    // Delete current match first
    if (currentMatch) {
      await db.transaction('rw', db.matches, db.sets, db.events, db.players, db.teams, db.sync_queue, db.match_setup, async () => {
        // Delete sets
        const sets = await db.sets.where('matchId').equals(currentMatch.id).toArray()
        if (sets.length > 0) {
          await db.sets.bulkDelete(sets.map(s => s.id))
        }
        
        // Delete events
        const events = await db.events.where('matchId').equals(currentMatch.id).toArray()
        if (events.length > 0) {
          await db.events.bulkDelete(events.map(e => e.id))
        }
        
        // Delete players
        if (currentMatch.homeTeamId) {
          await db.players.where('teamId').equals(currentMatch.homeTeamId).delete()
        }
        if (currentMatch.awayTeamId) {
          await db.players.where('teamId').equals(currentMatch.awayTeamId).delete()
        }
        
        // Delete teams
        if (currentMatch.homeTeamId) {
          await db.teams.delete(currentMatch.homeTeamId)
        }
        if (currentMatch.awayTeamId) {
          await db.teams.delete(currentMatch.awayTeamId)
        }
        
        // Delete all sync queue items
        await db.sync_queue.clear()
        
        // Delete match setup draft
        await db.match_setup.clear()
        
        // Delete match
        await db.matches.delete(currentMatch.id)
      })
    }

    setNewMatchModal(null)

    if (newMatchModal.type === 'official') {
      // Create new blank match
      const newMatchId = await db.matches.add({
        status: 'scheduled',
        createdAt: new Date().toISOString()
      })
      setMatchId(newMatchId)
      setShowMatchSetup(true)
      setShowCoinToss(false) // Ensure we go to match setup, not coin toss
    } else if (newMatchModal.type === 'test') {
      // Create test match (reuse the existing createNewTestMatch logic)
      await createTestMatchData()
      setShowCoinToss(false) // Ensure we go to match setup, not coin toss
    }
  }

  function cancelNewMatch() {
    setNewMatchModal(null)
  }

  async function createTestMatchData() {
    // Random team names
    const teamNamePrefixes = ['VBC', 'VC', 'KSC', 'Volley', 'SV', 'TSV', 'USC', 'SC']
    const teamNameSuffixes = ['Wiedikon', 'Wetzikon', 'Oerlikon', 'Adliswil', 'Rämi', 'Stäfa', 'Wald', 'Uster', 'Zürich', 'Basel', 'Bern', 'Luzern', 'Genf', 'Lausanne']
    const teamLevels = ['H1', 'H2', 'H3', 'H4', '1', '2', '3', '4']
    
    const homeTeamName = `${teamNamePrefixes[Math.floor(Math.random() * teamNamePrefixes.length)]} ${teamNameSuffixes[Math.floor(Math.random() * teamNameSuffixes.length)]} ${teamLevels[Math.floor(Math.random() * teamLevels.length)]}`
    const awayTeamName = `${teamNamePrefixes[Math.floor(Math.random() * teamNamePrefixes.length)]} ${teamNameSuffixes[Math.floor(Math.random() * teamNameSuffixes.length)]} ${teamLevels[Math.floor(Math.random() * teamLevels.length)]}`

    // Random team colors
    const colors = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4', '#84cc16', '#f97316']
    const homeColor = colors[Math.floor(Math.random() * colors.length)]
    let awayColor = colors[Math.floor(Math.random() * colors.length)]
    // Ensure away color is different from home color
    while (awayColor === homeColor) {
      awayColor = colors[Math.floor(Math.random() * colors.length)]
    }

    // Random match info
    const halls = ['Kantonsschule Wiedikon (Halle A)', 'Kantonsschule Wiedikon (Halle B)', 'Kantonsschule Wiedikon C', 'Sporthalle Zürich', 'Hallenstadion', 'Sporthalle Basel', 'Sporthalle Bern']
    const cities = ['Zürich', 'Basel', 'Bern', 'Luzern', 'Genf', 'Lausanne', 'St. Gallen', 'Winterthur']
    const leagues = ['3L A', '3L B', '2L A', '2L B', '1L', 'NLA', 'NLB']
    
    const hall = halls[Math.floor(Math.random() * halls.length)]
    const city = cities[Math.floor(Math.random() * cities.length)]
    const league = leagues[Math.floor(Math.random() * leagues.length)]
    
    // Random scheduled date (within next 3 months)
    const now = new Date()
    const futureDate = new Date(now.getTime() + Math.random() * 90 * 24 * 60 * 60 * 1000)
    const scheduledAt = futureDate.toISOString()

    // Create new match with test data
    await db.transaction('rw', db.matches, db.teams, db.players, db.sync_queue, async () => {
      // Create teams
      const homeTeamId = await db.teams.add({
        name: homeTeamName,
        color: homeColor,
        createdAt: new Date().toISOString()
      })
      const awayTeamId = await db.teams.add({
        name: awayTeamName,
        color: awayColor,
        createdAt: new Date().toISOString()
      })

      // Add teams to sync queue (test match, so test: true)
      await db.sync_queue.add({
        resource: 'team',
        action: 'insert',
        payload: {
          external_id: String(homeTeamId),
          name: homeTeamName,
          color: homeColor,
          test: true,
          created_at: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })
      await db.sync_queue.add({
        resource: 'team',
        action: 'insert',
        payload: {
          external_id: String(awayTeamId),
          name: awayTeamName,
          color: awayColor,
          test: true,
          created_at: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })

      // Generate random players with valid configurations
      // Options: 11+1 libero, 12+0 liberos, 11+2 liberos, 12+2 liberos
      const configs = [
        { totalPlayers: 11, liberoCount: 1 },
        { totalPlayers: 12, liberoCount: 0 },
        { totalPlayers: 11, liberoCount: 2 },
        { totalPlayers: 12, liberoCount: 2 }
      ]
      const homeConfig = configs[Math.floor(Math.random() * configs.length)]
      const awayConfig = configs[Math.floor(Math.random() * configs.length)]
      
      const homePlayersData = generateRandomPlayers(homeTeamId, homeConfig)
      const awayPlayersData = generateRandomPlayers(awayTeamId, awayConfig)
      const allPlayers = await db.players.bulkAdd([...homePlayersData, ...awayPlayersData])
      
      // Add players to sync queue (test match, so test: true)
      for (let i = 0; i < allPlayers.length; i++) {
        const player = i < homePlayersData.length ? homePlayersData[i] : awayPlayersData[i - homePlayersData.length]
        const teamId = i < homePlayersData.length ? homeTeamId : awayTeamId
        await db.sync_queue.add({
          resource: 'player',
          action: 'insert',
          payload: {
            external_id: String(allPlayers[i]),
            team_id: String(teamId), // Use external_id of team
            number: player.number,
            name: player.name,
            first_name: player.firstName,
            last_name: player.lastName,
            dob: player.dob || null,
            libero: player.libero || null,
            is_captain: player.isCaptain || false,
            role: player.role || null,
            test: true,
            created_at: player.createdAt
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }

      // Generate random bench officials
      const benchHome = generateRandomBenchOfficials()
      const benchAway = generateRandomBenchOfficials()
      
      // Generate random match officials
      const officials = [
        {
          role: '1st referee',
          firstName: firstNames[Math.floor(Math.random() * firstNames.length)],
          lastName: lastNames[Math.floor(Math.random() * lastNames.length)],
          country: 'CH',
          dob: randomDate('1970-01-01', '1990-12-31')
        },
        {
          role: '2nd referee',
          firstName: firstNames[Math.floor(Math.random() * firstNames.length)],
          lastName: lastNames[Math.floor(Math.random() * lastNames.length)],
          country: 'CH',
          dob: randomDate('1970-01-01', '1990-12-31')
        },
        {
          role: 'scorer',
          firstName: firstNames[Math.floor(Math.random() * firstNames.length)],
          lastName: lastNames[Math.floor(Math.random() * lastNames.length)],
          country: 'CH',
          dob: randomDate('1970-01-01', '1990-12-31')
        },
        {
          role: 'assistant scorer',
          firstName: firstNames[Math.floor(Math.random() * firstNames.length)],
          lastName: lastNames[Math.floor(Math.random() * lastNames.length)],
          country: 'CH',
          dob: randomDate('1970-01-01', '1990-12-31')
        }
      ]

      const newMatchId = await db.matches.add({
        status: 'scheduled',
        homeTeamId,
        awayTeamId,
        hall,
        city,
        league,
        scheduledAt,
        bench_home: benchHome,
        bench_away: benchAway,
        officials,
        createdAt: new Date().toISOString()
      })

      // Add match to sync queue (test match, so test: true)
      await db.sync_queue.add({
        resource: 'match',
        action: 'insert',
        payload: {
          external_id: String(newMatchId),
          home_team_id: String(homeTeamId), // Use external_id of team
          away_team_id: String(awayTeamId), // Use external_id of team
          status: 'scheduled',
          hall: hall || null,
          city: city || null,
          league: league || null,
          scheduled_at: scheduledAt || null,
          test: true,
          created_at: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })

      setMatchId(newMatchId)
      setShowMatchSetup(true)
      setShowCoinToss(false) // Ensure we go to match setup, not coin toss
    })
  }

  async function createNewTestMatch() {
    // Check if match is ongoing
    if (matchStatus?.status === 'Match recording') {
      return // Don't allow creating new match when one is ongoing
    }

    // Delete current match if exists
    if (currentMatch) {
      setNewMatchModal({
        type: 'test',
        message: 'There is an existing match. Do you want to delete it and create a new test match?'
      })
      return
    }

    // Create test match
    await createTestMatchData()
  }

  function continueMatch(matchIdParam) {
    const targetMatchId = matchIdParam || currentMatch?.id
    if (!targetMatchId) return
    
    // Get the match to check its status
    db.matches.get(targetMatchId).then(match => {
      if (!match) return
      
      // Determine where to continue based on status
      if (match.status === 'live' || match.status === 'final') {
        // Go directly to scoreboard
        setMatchId(targetMatchId)
        setShowMatchSetup(false)
        setShowCoinToss(false)
      } else {
        // Go to match setup
        setMatchId(targetMatchId)
        setShowMatchSetup(true)
      }
    })
  }


  return (
    <div className="container">
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h1 style={{ margin: 0 }}>Openvolley eScoresheet</h1>
        <div className={`status-indicator status-${syncStatus}`} style={{ fontSize: '11px' }}>
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
      </div>
      
      {!matchId && matchStatus && (
        <div className="match-status-banner">
          <div className="match-status-content">
            <span className="match-status-label">Current Match:</span>
            <span className="match-status-teams">
              {matchStatus.homeTeam?.name || 'Home'} vs {matchStatus.awayTeam?.name || 'Away'}
            </span>
            <span className="match-status-value">{matchStatus.status}</span>
          </div>
        </div>
      )}

      <div className="panel">
        {showMatchSetup && matchId ? (
          <MatchSetup matchId={matchId} onStart={continueMatch} onReturn={returnToMatch} onGoHome={goHome} showCoinToss={showCoinToss} onCoinTossClose={() => setShowCoinToss(false)} />
        ) : !matchId ? (
          <div className="home-view">
            <div className="home-actions">
              <button 
                onClick={createNewOfficialMatch}
                disabled={matchStatus?.status === 'Match recording'}
                className={matchStatus?.status === 'Match recording' ? 'disabled' : ''}
              >
                New official match
              </button>
              <button 
                onClick={createNewTestMatch}
                disabled={matchStatus?.status === 'Match recording'}
                className={matchStatus?.status === 'Match recording' ? 'disabled' : ''}
              >
                New test match
              </button>
              <button 
                onClick={showDeleteMatchModal}
                disabled={!currentMatch}
                className={!currentMatch ? 'disabled' : ''}
              >
                Delete match
              </button>
              <button 
                onClick={continueMatch}
                disabled={!currentMatch}
                className={!currentMatch ? 'disabled' : ''}
              >
                Continue match
              </button>
            </div>
          </div>
        ) : (
          <Scoreboard matchId={matchId} onFinishSet={finishSet} onOpenSetup={openMatchSetup} onOpenMatchSetup={openMatchSetupView} onOpenCoinToss={openCoinTossView} />
        )}
      </div>
      <p>Offline-first PWA. Data is saved locally and syncs when online.</p>

      {/* Delete Match Modal */}
      {deleteMatchModal && (
        <Modal
          title="Delete Match"
          open={true}
          onClose={cancelDeleteMatch}
          width={400}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              Are you sure you want to delete all data for: <strong>{deleteMatchModal.matchName}</strong>?
            </p>
            <p style={{ marginBottom: '24px', fontSize: '14px', color: 'var(--muted)' }}>
              This will delete all sets, events, players, and team data for this match.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmDeleteMatch}
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
                Delete
              </button>
              <button
                onClick={cancelDeleteMatch}
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

      {/* New Match Modal */}
      {newMatchModal && (
        <Modal
          title="Create New Match"
          open={true}
          onClose={cancelNewMatch}
          width={400}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px' }}>
              {newMatchModal.message}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={confirmNewMatch}
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
                onClick={cancelNewMatch}
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


