import { useState, useEffect, useMemo, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import SignaturePad from './SignaturePad'
import Modal from './Modal'
import RefereeSelector from './RefereeSelector'
import mikasaVolleyball from '../mikasa_v200w.png'
import { parseRosterPdf } from '../utils/parseRosterPdf'

export default function MatchSetup({ onStart, matchId, onReturn, onGoHome, showCoinToss = false, onCoinTossClose }) {
  const [home, setHome] = useState('Home')
  const [away, setAway] = useState('Away')

  // Match info fields
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
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
  const [currentView, setCurrentView] = useState('main') // 'main', 'info', 'officials', 'home', 'away', 'coin-toss'
  const [openSignature, setOpenSignature] = useState(null) // 'home-coach', 'home-captain', 'away-coach', 'away-captain'
  const [showRoster, setShowRoster] = useState({ home: false, away: false })
  const [colorPickerModal, setColorPickerModal] = useState(null) // { team: 'home'|'away', position: { x, y } } | null
  const [noticeModal, setNoticeModal] = useState(null) // { message: string } | null
  
  // Coin toss state
  const [teamA, setTeamA] = useState('home') // 'home' or 'away'
  const [teamB, setTeamB] = useState('away') // 'home' or 'away'
  const [serveA, setServeA] = useState(true) // true = serves, false = receives
  const [serveB, setServeB] = useState(false) // true = serves, false = receives
  const [pendingMatchId, setPendingMatchId] = useState(null) // Store match ID before coin toss
  const [showBothRosters, setShowBothRosters] = useState(false) // Show both rosters in match setup
  
  // Coin toss modals
  const [addPlayerModal, setAddPlayerModal] = useState(null) // 'teamA' | 'teamB' | null
  const [deletePlayerModal, setDeletePlayerModal] = useState(null) // { team: 'teamA'|'teamB', index: number } | null
  const [showCoinTossRoster, setShowCoinTossRoster] = useState(false) // Show/hide roster in coin toss
  
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

  // Referee JSON import state
  const [refereeJsonLoading, setRefereeJsonLoading] = useState(false)
  const [refereeJsonError, setRefereeJsonError] = useState('')
  
  // Referee selector state
  const [showRefereeSelector, setShowRefereeSelector] = useState(null) // 'ref1' | 'ref2' | null
  const [refereeSelectorPosition, setRefereeSelectorPosition] = useState({})
  const rosterLoadedRef = useRef(false) // Track if roster has been loaded to prevent overwriting user edits
  const homeTeamInputRef = useRef(null)
  const awayTeamInputRef = useRef(null)
  const homeTeamMeasureRef = useRef(null)
  const awayTeamMeasureRef = useRef(null)

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
        
        // Load match info
        if (match.scheduledAt) {
          const scheduledDate = new Date(match.scheduledAt)
          setDate(scheduledDate.toISOString().split('T')[0])
          const hours = String(scheduledDate.getHours()).padStart(2, '0')
          const minutes = String(scheduledDate.getMinutes()).padStart(2, '0')
          setTime(`${hours}:${minutes}`)
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
        
        // Load coin toss data if available
        if (match.coinTossTeamA && match.coinTossTeamB !== undefined) {
          // Load saved coin toss result
          setTeamA(match.coinTossTeamA)
          setTeamB(match.coinTossTeamB)
          setServeA(match.coinTossServeA !== undefined ? match.coinTossServeA : true)
          setServeB(match.coinTossServeB !== undefined ? match.coinTossServeB : false)
        } else if (match.firstServe) {
          // Fallback: use firstServe to determine serve (but not team assignment)
          // Default team assignment
          setTeamA('home')
          setTeamB('away')
          if (match.firstServe === 'home') {
            setServeA(true)
            setServeB(false)
          } else {
            setServeA(false)
            setServeB(true)
          }
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
  
  // Show coin toss view if requested
  useEffect(() => {
    if (showCoinToss && matchId) {
      // Check if team names and short names are set before showing coin toss
      if (!home || home.trim() === '' || home === 'Home' || !away || away.trim() === '' || away === 'Away') {
        setNoticeModal({ message: 'Please set both team names before proceeding to coin toss.' })
        return
      }
      if (!homeShortName || homeShortName.trim() === '' || !awayShortName || awayShortName.trim() === '') {
        setNoticeModal({ message: 'Please set both team short names before proceeding to coin toss.' })
        return
      }
      setCurrentView('coin-toss')
    }
  }, [showCoinToss, matchId, home, away, homeShortName, awayShortName])

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
        const scheduledAt = (() => {
          if (!date && !time) return match?.scheduledAt || new Date().toISOString()
          const iso = new Date(`${date}T${time || '00:00'}:00`).toISOString()
          return iso
        })()
        
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
            { role: 'assistant scorer', firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob }
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
        alert('Error saving data')
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

  // Date formatting helpers
  function formatDateToDDMMYYYY(dateStr) {
    if (!dateStr) return ''
    // If already in DD/MM/YYYY format, return as-is
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr
    // If in ISO format (YYYY-MM-DD), convert to DD/MM/YYYY
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [year, month, day] = dateStr.split('-')
      return `${day}/${month}/${year}`
    }
    // Try to parse as date
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
    // If already in ISO format (YYYY-MM-DD), return as-is
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr
    // If in DD/MM/YYYY format, convert to YYYY-MM-DD
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
      const [day, month, year] = dateStr.split('/')
      return `${year}-${month}-${day}`
    }
    // Try to parse as date
    const date = new Date(dateStr)
    if (!isNaN(date.getTime())) {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }
    return dateStr
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

    const scheduledAt = (() => {
      if (!date && !time) return new Date().toISOString()
      const iso = new Date(`${date}T${time || '00:00'}:00`).toISOString()
      return iso
    })()

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

    const matchId = await db.matches.add({
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
      gamePin: (() => {
        // Auto-generate gamePin for official matches
        const chars = '0123456789'
        let pin = ''
        for (let i = 0; i < 6; i++) {
          pin += chars.charAt(Math.floor(Math.random() * chars.length))
        }
        return pin
      })(), // Game PIN for official matches (not test matches)
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
        { role: 'assistant scorer', firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob }
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
          external_id: String(matchId),
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

    setPendingMatchId(matchId)
    setCurrentView('coin-toss')
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

  async function confirmCoinToss() {
    
    if (!homeCoachSignature || !homeCaptainSignature || !awayCoachSignature || !awayCaptainSignature) {
      setNoticeModal({ message: 'Please complete all signatures before confirming the coin toss.' })
      return
    }
    
    // Use matchId if pendingMatchId is not set
    const targetMatchId = pendingMatchId || matchId
    
    if (!targetMatchId) {
      console.error('[COIN TOSS] No match ID available')
      alert('Error: No match ID found')
      return
    }
    
    const matchData = await db.matches.get(targetMatchId)
    if (!matchData) {
      return
    }
    
    // Determine which team serves first
    const firstServeTeam = serveA ? teamA : teamB
    
    // Update match with signatures and rosters
    await db.transaction('rw', db.matches, db.players, db.sync_queue, db.events, async () => {
    // Update match with signatures, first serve, and coin toss result
    const updateResult = await db.matches.update(targetMatchId, {
      homeCoachSignature,
      homeCaptainSignature,
      awayCoachSignature,
      awayCaptainSignature,
      firstServe: firstServeTeam, // 'home' or 'away'
      coinTossTeamA: teamA, // 'home' or 'away'
      coinTossTeamB: teamB, // 'home' or 'away'
      coinTossServeA: serveA, // true or false
      coinTossServeB: serveB // true or false
      })
    
    // Check if coin toss event already exists
    const existingCoinTossEvent = await db.events
      .where('matchId').equals(targetMatchId)
      .and(e => e.type === 'coin_toss')
      .first()
    
    // Create coin_toss event with seq=1 if it doesn't exist
    if (!existingCoinTossEvent) {
      await db.events.add({
        matchId: targetMatchId,
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
    const updatedMatch = await db.matches.get(targetMatchId)
    if (updatedMatch) {
      await db.sync_queue.add({
        resource: 'match',
        action: 'update',
        payload: {
          id: String(targetMatchId),
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
    const firstSetId = await db.sets.add({ matchId: targetMatchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
    
    // Get match to check if it's a test match
    const matchForSet = await db.matches.get(targetMatchId)
    const isTest = matchForSet?.test || false
    
    // Add first set to sync queue
    await db.sync_queue.add({
      resource: 'set',
      action: 'insert',
      payload: {
        external_id: String(firstSetId),
        match_id: String(targetMatchId),
        index: 1,
        home_points: 0,
        away_points: 0,
        finished: false,
        test: isTest,
        created_at: new Date().toISOString()
      },
      ts: new Date().toISOString(),
      status: 'queued'
    })
    
    // Update match status to 'live' to indicate match has started
    await db.matches.update(targetMatchId, { status: 'live' })
    
    // Ensure all roster updates are committed before navigating
    // Force a small delay to ensure database updates are fully committed
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Start the match - directly navigate to scoreboard
    // onStart (continueMatch) will now allow test matches when status is 'live' and coin toss is confirmed
    onStart(targetMatchId)
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

  // Load and import referees from JSON
  const handleRefereeJsonImport = async () => {
    setRefereeJsonLoading(true)
    setRefereeJsonError('')

    try {
      const response = await fetch('/referees_svrz.json')
      if (!response.ok) {
        throw new Error(`Failed to load referees JSON: ${response.statusText}`)
      }

      const referees = await response.json()
      
      if (!Array.isArray(referees) || referees.length === 0) {
        throw new Error('JSON file appears to be empty or invalid')
      }

      // Import first referee from first entry
      const firstReferee = referees[0]
      if (firstReferee && firstReferee.lastname && firstReferee.firstname) {
        setRef1Last(firstReferee.lastname.trim())
        setRef1First(firstReferee.firstname.trim())
        setRef1Country('CHE')
        setRef1Dob('01.01.1900')
      }

      // Import second referee from second entry if available
      if (referees.length > 1) {
        const secondReferee = referees[1]
        if (secondReferee && secondReferee.lastname && secondReferee.firstname) {
          setRef2Last(secondReferee.lastname.trim())
          setRef2First(secondReferee.firstname.trim())
          setRef2Country('CHE')
          setRef2Dob('01.01.1900')
        }
      }

      setRefereeJsonLoading(false)
    } catch (error) {
      console.error('Error loading referee JSON:', error)
      setRefereeJsonError(`Failed to load referees: ${error.message}`)
      setRefereeJsonLoading(false)
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
      
      if (homeFileInputRef.current) {
        homeFileInputRef.current.value = ''
      }
    } catch (err) {
      console.error('Error parsing PDF:', err)
      setHomePdfError(`Failed to parse PDF: ${err.message}`)
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
      
      if (awayFileInputRef.current) {
        awayFileInputRef.current.value = ''
      }
    } catch (err) {
      console.error('Error parsing PDF:', err)
      setAwayPdfError(`Failed to parse PDF: ${err.message}`)
    } finally {
      setAwayPdfLoading(false)
    }
  }

  if (currentView === 'info') {
    return (
      <div className="setup">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={()=>setCurrentView('main')}>← Back</button>
          <h2>Match info</h2>
          {onGoHome ? (
            <button className="secondary" onClick={onGoHome}>Home</button>
          ) : (
          <div style={{ width: 80 }}></div>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px' }}>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Date & Time</h3>
            <div className="field"><label>Date</label><input className="w-dob" type="date" value={date} onChange={e=>setDate(e.target.value)} /></div>
            <div className="field"><label>Time</label><input className="w-90" type="time" value={time} onChange={e=>setTime(e.target.value)} /></div>
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
          <button onClick={() => setCurrentView('main')}>Confirm</button>
        </div>
      </div>
    )
  }

  if (currentView === 'officials') {
    return (
      <div className="setup">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={()=>setCurrentView('main')}>← Back</button>
          <h2>Match officials</h2>
          {onGoHome ? (
            <button className="secondary" onClick={onGoHome}>Home</button>
          ) : (
          <div style={{ width: 80 }}></div>
          )}
        </div>
        
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '16px',
            background: 'rgba(15, 23, 42, 0.2)'
          }}>
            <h4 style={{ 
              marginTop: 0, 
              marginBottom: '12px',
              padding: '8px 12px',
              background: 'rgba(255, 255, 255, 0.1)',
              borderRadius: '6px',
              fontSize: '16px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <span>1st Referee</span>
              <button
                type="button"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  setRefereeSelectorPosition({ element: e.currentTarget })
                  setShowRefereeSelector('ref1')
                }}
                style={{
                  padding: '4px 8px',
                  fontSize: '11px',
                  fontWeight: 500,
                  background: 'rgba(59, 130, 246, 0.2)',
                  color: '#60a5fa',
                  border: '1px solid rgba(59, 130, 246, 0.4)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(59, 130, 246, 0.3)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(59, 130, 246, 0.2)'
                }}
              >
                Choose from SVRZ database
              </button>
            </h4>
            <div className="row">
              <div className="field"><label>Last Name</label><input className="w-name capitalize" value={ref1Last} onChange={e=>setRef1Last(e.target.value)} /></div>
              <div className="field"><label>First Name</label><input className="w-name capitalize" value={ref1First} onChange={e=>setRef1First(e.target.value)} /></div>
              <div className="field"><label>Country</label><input className="w-90" value={ref1Country} onChange={e=>setRef1Country(e.target.value)} /></div>
              <div className="field"><label>Date of birth</label><input className="w-dob" type="date" value={ref1Dob ? formatDateToISO(ref1Dob) : ''} onChange={e=>setRef1Dob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
          </div>

          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '16px',
            background: 'rgba(15, 23, 42, 0.2)'
          }}>
            <h4 style={{ 
              marginTop: 0, 
              marginBottom: '12px',
              padding: '8px 12px',
              background: 'rgba(255, 255, 255, 0.1)',
              borderRadius: '6px',
              fontSize: '16px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <span>2nd Referee</span>
              <button
                type="button"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  setRefereeSelectorPosition({ element: e.currentTarget })
                  setShowRefereeSelector('ref2')
                }}
                style={{
                  padding: '4px 8px',
                  fontSize: '11px',
                  fontWeight: 500,
                  background: 'rgba(59, 130, 246, 0.2)',
                  color: '#60a5fa',
                  border: '1px solid rgba(59, 130, 246, 0.4)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(59, 130, 246, 0.3)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(59, 130, 246, 0.2)'
                }}
              >
                Choose from SVRZ database
              </button>
            </h4>
            <div className="row">
              <div className="field"><label>Last Name</label><input className="w-name capitalize" value={ref2Last} onChange={e=>setRef2Last(e.target.value)} /></div>
              <div className="field"><label>First Name</label><input className="w-name capitalize" value={ref2First} onChange={e=>setRef2First(e.target.value)} /></div>
              <div className="field"><label>Country</label><input className="w-90" value={ref2Country} onChange={e=>setRef2Country(e.target.value)} /></div>
              <div className="field"><label>Date of birth</label><input className="w-dob" type="date" value={ref2Dob ? formatDateToISO(ref2Dob) : ''} onChange={e=>setRef2Dob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
          </div>

          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '16px',
            background: 'rgba(15, 23, 42, 0.2)'
          }}>
            <h4 style={{ 
              marginTop: 0, 
              marginBottom: '12px',
              padding: '8px 12px',
              background: 'rgba(255, 255, 255, 0.1)',
              borderRadius: '6px',
              fontSize: '16px',
              fontWeight: 600
            }}>Scorer</h4>
            <div className="row">
              <div className="field"><label>Last Name</label><input className="w-name capitalize" value={scorerLast} onChange={e=>setScorerLast(e.target.value)} /></div>
              <div className="field"><label>First Name</label><input className="w-name capitalize" value={scorerFirst} onChange={e=>setScorerFirst(e.target.value)} /></div>
              <div className="field"><label>Country</label><input className="w-90" value={scorerCountry} onChange={e=>setScorerCountry(e.target.value)} /></div>
              <div className="field"><label>Date of birth</label><input className="w-dob" type="date" value={scorerDob ? formatDateToISO(scorerDob) : ''} onChange={e=>setScorerDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
          </div>

          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '16px',
            background: 'rgba(15, 23, 42, 0.2)'
          }}>
            <h4 style={{ 
              marginTop: 0, 
              marginBottom: '12px',
              padding: '8px 12px',
              background: 'rgba(255, 255, 255, 0.1)',
              borderRadius: '6px',
              fontSize: '16px',
              fontWeight: 600
            }}>Assistant Scorer</h4>
            <div className="row">
              <div className="field"><label>Last Name</label><input className="w-name capitalize" value={asstLast} onChange={e=>setAsstLast(e.target.value)} /></div>
              <div className="field"><label>First Name</label><input className="w-name capitalize" value={asstFirst} onChange={e=>setAsstFirst(e.target.value)} /></div>
              <div className="field"><label>Country</label><input className="w-90" value={asstCountry} onChange={e=>setAsstCountry(e.target.value)} /></div>
              <div className="field"><label>Date of birth</label><input className="w-dob" type="date" value={asstDob ? formatDateToISO(asstDob) : ''} onChange={e=>setAsstDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
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
                  { role: 'assistant scorer', firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob }
                ]
              })
            }
            setCurrentView('main')
          }}>Confirm</button>
        </div>
      </div>
    )
  }

  if (currentView === 'home') {
    return (
      <div className="setup">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={()=>setCurrentView('main')}>← Back</button>
          <h2>Home team</h2>
          {onGoHome ? (
            <button className="secondary" onClick={onGoHome}>Home</button>
          ) : (
          <div style={{ width: 80 }}></div>
          )}
        </div>
        <h1>Roster</h1>
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
        {/* Upload Methods for Home Team */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '12px',
          marginBottom: '12px'
        }}>
          {/* Local Upload */}
          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.2)'
          }}>
            <h4 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px', fontWeight: 600 }}>Local Upload</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
                disabled={homePdfLoading}
                style={{ padding: '8px 16px', fontSize: '14px', width: '100%' }}
              >
                Upload Einsatzliste PDF (DE / FR / IT)
              </button>
              {homePdfFile && (
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
              {homePdfError && (
                <span style={{ color: '#ef4444', fontSize: '12px' }}>
                  {homePdfError}
                </span>
              )}
            </div>
          </div>

          {/* Remote Upload */}
          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.2)'
          }}>
            <h4 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px', fontWeight: 600 }}>Remote Upload</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {homeRoster.map((p, i) => (
            <div key={`h-${i}`} className="row" style={{ alignItems: 'center' }}>
              <input 
                className="w-num" 
                placeholder="#" 
                type="number" 
                inputMode="numeric" 
                min="1"
                max="99"
                value={p.number ?? ''} 
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
                  // Sort roster by player number
                  updated.sort((a, b) => (a.number || 0) - (b.number || 0))
                  setHomeRoster(updated)
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
                  updated[i] = { ...updated[i], libero: e.target.value }
                  
                  // If L2 is selected but no L1 exists, automatically change L2 to L1
                  if (e.target.value === 'libero2') {
                    const hasL1 = updated.some((player, idx) => idx !== i && player.libero === 'libero1')
                    if (!hasL1) {
                      updated[i] = { ...updated[i], libero: 'libero1' }
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
          ))}
          </div>
        <h4>Bench — Home</h4>
        {sortBenchByHierarchy(benchHome).map((m, i) => {
          const originalIdx = benchHome.findIndex(b => b === m)
          return (
            <div key={`bh-${originalIdx}`} className="row bench-row" style={{ alignItems:'center' }}>
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
            }
            setCurrentView('main')
          }}>Confirm</button>
        </div>
      </div>
    )
  }

  if (currentView === 'away') {
    return (
      <div className="setup">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={()=>setCurrentView('main')}>← Back</button>
          <h2>Away team</h2>
          {onGoHome ? (
            <button className="secondary" onClick={onGoHome}>Home</button>
          ) : (
          <div style={{ width: 80 }}></div>
          )}
        </div>
        <h1>Roster</h1>
             
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
              <select className="w-120" value={awayLibero} onChange={e => {
                let newValue = e.target.value
                // If L2 is selected but no L1 exists, automatically change L2 to L1
                if (newValue === 'libero2' && !awayRoster.some(p => p.libero === 'libero1')) {
                  newValue = 'libero1'
                }
                setAwayLibero(newValue)
              }}>
                <option value=""></option>
                {!awayRoster.some(p => p.libero === 'libero1') && (
                <option value="libero1">libero 1</option>
                )}
                {!awayRoster.some(p => p.libero === 'libero2') && (
                <option value="libero2">libero 2</option>
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
        {/* Upload Methods for Away Team */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '12px',
          marginBottom: '12px'
        }}>
          {/* Local Upload */}
          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.2)'
          }}>
            <h4 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px', fontWeight: 600 }}>Local Upload</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
                disabled={awayPdfLoading}
                style={{ padding: '8px 16px', fontSize: '14px', width: '100%' }}
              >
                Upload Einsatzliste PDF (DE / FR / IT)
              </button>
              {awayPdfFile && (
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
              {awayPdfError && (
                <span style={{ color: '#ef4444', fontSize: '12px' }}>
                  {awayPdfError}
                </span>
              )}
            </div>
          </div>

          {/* Remote Upload */}
          <div style={{
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.2)'
          }}>
            <h4 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px', fontWeight: 600 }}>Remote Upload</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
          </div>
        </div>
   
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {awayRoster.map((p, i) => (
            <div key={`a-${i}`} className="row" style={{ alignItems: 'center' }}>
              <input 
                className="w-num" 
                placeholder="#" 
                type="number" 
                inputMode="numeric" 
                min="1"
                max="99"
                value={p.number ?? ''} 
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
                  // Sort roster by player number
                  updated.sort((a, b) => (a.number || 0) - (b.number || 0))
                  setAwayRoster(updated)
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
                  updated[i] = { ...updated[i], libero: e.target.value }
                  
                  // If L2 is selected but no L1 exists, automatically change L2 to L1
                  if (e.target.value === 'libero2') {
                    const hasL1 = updated.some((player, idx) => idx !== i && player.libero === 'libero1')
                    if (!hasL1) {
                      updated[i] = { ...updated[i], libero: 'libero1' }
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
          ))}
          </div>
        <h4>Bench — Away</h4>
        {sortBenchByHierarchy(benchAway).map((m, i) => {
          const originalIdx = benchAway.findIndex(b => b === m)
          return (
            <div key={`ba-${originalIdx}`} className="row bench-row" style={{ alignItems:'center' }}>
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
            }
            setCurrentView('main')
          }}>Confirm</button>
        </div>
      </div>
    )
  }

  if (currentView === 'coin-toss') {
    const teamAInfo = teamA === 'home' ? { name: home, color: homeColor, roster: homeRoster, bench: benchHome } : { name: away, color: awayColor, roster: awayRoster, bench: benchAway }
    const teamBInfo = teamB === 'home' ? { name: home, color: homeColor, roster: homeRoster, bench: benchHome } : { name: away, color: awayColor, roster: awayRoster, bench: benchAway }
    
    const teamACoachSig = teamA === 'home' ? homeCoachSignature : awayCoachSignature
    const teamACaptainSig = teamA === 'home' ? homeCaptainSignature : awayCaptainSignature
    const teamBCoachSig = teamB === 'home' ? homeCoachSignature : awayCoachSignature
    const teamBCaptainSig = teamB === 'home' ? homeCaptainSignature : awayCaptainSignature
    const sortRosterEntries = roster =>
      (roster || [])
        .map((player, index) => ({ player, index }))
        .sort((a, b) => {
          const an = Number(a.player?.number) || 0
          const bn = Number(b.player?.number) || 0
          return an - bn
        })
    const teamARosterEntries = sortRosterEntries(teamAInfo.roster)
    const teamBRosterEntries = sortRosterEntries(teamBInfo.roster)

    // Volleyball images - fixed size and responsive
    const imageSize = '64px'
    const volleyballImage = (
      <div style={{ 
        width: imageSize, 
        height: imageSize, 
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0
      }}>
        <img 
          src={mikasaVolleyball} 
          alt="Mikasa V200W Volleyball" 
          style={{ 
            maxWidth: '100%', 
            maxHeight: '100%', 
            width: 'auto',
            height: 'auto',
            objectFit: 'contain' 
          }}
        />
      </div>
    )
    const volleyballPlaceholder = (
      <div style={{ 
        width: imageSize, 
        height: imageSize, 
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background:'transparent',
        flexShrink: 0
      }}>
        <div style={{ 
          width: '32px', 
          height: '32px', 
          background: 'transparent'
        }} />
      </div>
    )

    return (
      <div className="setup">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={() => {
            setCurrentView('main')
            if (onCoinTossClose) onCoinTossClose()
          }}>← Back</button>
          <h1>Coin Toss</h1>
          {onGoHome ? (
            <button className="secondary" onClick={onGoHome}>Home</button>
          ) : (
          <div style={{ width: 80 }}></div>
          )}
        </div>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 24, marginBottom: 24, alignItems: 'start' }}>
          {/* Team A */}
          <div>
            <h1 style={{ margin: 2, fontSize: '24px', fontWeight: 700, textAlign: 'center' }}>Team A</h1>
            <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, height: '48px' }}>
              <button 
                type="button"
                style={{ 
                  background: teamAInfo.color, 
                  color: isBrightColor(teamAInfo.color) ? '#000' : '#fff', 
                  flex: 1,
                  padding: '12px',
                  fontSize: '14px',
                  fontWeight: 600,
                  border: 'none',
                  borderRadius: '8px'
                }}
              >
                {teamAInfo.name}
              </button>
            </div>
            
            <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center', height: '64px', alignItems: 'center', gap: 12 }}>
              {serveA ? volleyballImage : volleyballPlaceholder}
            </div>
            
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <h4 style={{ margin: 0, fontSize: '14px' }}>Roster</h4>
                  <button type="button" className="secondary" onClick={() => setShowCoinTossRoster(!showCoinTossRoster)} style={{ padding: '4px 8px', fontSize: '12px' }}>
                    {showCoinTossRoster ? 'Hide' : 'Show'}
              </button>
            </div>
                {showCoinTossRoster && (
                  <button type="button" className="secondary" onClick={() => setAddPlayerModal('teamA')} style={{ padding: '4px 8px', fontSize: '12px' }}>
                    Add Player
                  </button>
                )}
              </div>
              {showCoinTossRoster && (
              <table className="roster-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name</th>
                    <th style={{ width: '90px' }}>DOB</th>
                    <th>Role</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {teamARosterEntries.map(({ player: p, index: originalIdx }) => (
                    <tr key={`${teamA}-${originalIdx}`}>
                      <td className="coin-toss-number" style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <input 
                            type="number" 
                            inputMode="numeric" 
                            min="1"
                            max="99"
                            value={p.number ?? ''} 
                            onChange={e => {
                              const val = e.target.value ? Number(e.target.value) : null
                              if (val !== null && (val < 1 || val > 99)) return
                              if (teamA === 'home') {
                                const updated = [...homeRoster]
                                updated[originalIdx] = { ...updated[originalIdx], number: val }
                                setHomeRoster(updated)
                              } else {
                                const updated = [...awayRoster]
                                updated[originalIdx] = { ...updated[originalIdx], number: val }
                                setAwayRoster(updated)
                              }
                            }}
                            style={{ 
                              width: p.isCaptain ? '24px' : '28px',
                              height: p.isCaptain ? '24px' : 'auto',
                              padding: '0', 
                              margin: '0', 
                              background: 'transparent', 
                              border: p.isCaptain ? '2px solid var(--accent)' : 'none', 
                              borderRadius: p.isCaptain ? '50%' : '0',
                              color: 'var(--text)', 
                              textAlign: 'center', 
                              fontSize: '12px', 
                              lineHeight: 'normal', 
                              verticalAlign: 'baseline'
                            }}
                          />
                        {p.libero && (
                            <span style={{ 
                              color: 'var(--accent)', 
                              fontSize: '10px', 
                              fontWeight: 700,
                              lineHeight: '1'
                            }}>
                            {p.libero === 'libero1' ? 'L1' : 'L2'}
                          </span>
                        )}
                </div>
                      </td>
                      <td className="coin-toss-name" style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px', maxWidth: '150px' }}>
                        <input 
                          type="text" 
                          value={`${p.lastName || ''} ${p.firstName || ''}`.trim() || ''} 
                          onChange={e => {
                            const parts = e.target.value.split(' ').filter(p => p)
                            const lastName = parts.length > 0 ? parts[0] : ''
                            const firstName = parts.length > 1 ? parts.slice(1).join(' ') : ''
                            if (teamA === 'home') {
                              const updated = [...homeRoster]
                              updated[originalIdx] = { ...updated[originalIdx], lastName, firstName }
                              setHomeRoster(updated)
                            } else {
                              const updated = [...awayRoster]
                              updated[originalIdx] = { ...updated[originalIdx], lastName, firstName }
                              setAwayRoster(updated)
                            }
                          }}
                          style={{ width: '100%', padding: '0', margin: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', verticalAlign: 'baseline', borderRadius: '0' }}
                        />
                      </td>
                      <td className="coin-toss-dob" style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px', width: '90px' }}>
                        <input 
                          type="date" 
                          value={p.dob ? formatDateToISO(p.dob) : ''} 
                          onChange={e => {
                            const value = e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''
                            if (teamA === 'home') {
                              const updated = [...homeRoster]
                              updated[originalIdx] = { ...updated[originalIdx], dob: value }
                              setHomeRoster(updated)
                            } else {
                              const updated = [...awayRoster]
                              updated[originalIdx] = { ...updated[originalIdx], dob: value }
                              setAwayRoster(updated)
                            }
                          }}
                          className="coin-toss-date-input"
                          style={{ width: '100%', padding: '0', margin: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', verticalAlign: 'baseline', borderRadius: '0' }}
                        />
                      </td>
                      <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <select 
                            value={p.libero || ''} 
                            onChange={e => {
                              if (teamA === 'home') {
                                const updated = [...homeRoster]
                                updated[originalIdx] = { ...updated[originalIdx], libero: e.target.value }
                                
                                // If L2 is selected but no L1 exists, automatically change L2 to L1
                                if (e.target.value === 'libero2') {
                                  const hasL1 = updated.some((player, idx) => idx !== originalIdx && player.libero === 'libero1')
                                  if (!hasL1) {
                                    updated[originalIdx] = { ...updated[originalIdx], libero: 'libero1' }
                                  }
                                }
                                
                                setHomeRoster(updated)
                              } else {
                                const updated = [...awayRoster]
                                updated[originalIdx] = { ...updated[originalIdx], libero: e.target.value }
                                
                                // If L2 is selected but no L1 exists, automatically change L2 to L1
                                if (e.target.value === 'libero2') {
                                  const hasL1 = updated.some((player, idx) => idx !== originalIdx && player.libero === 'libero1')
                                  if (!hasL1) {
                                    updated[originalIdx] = { ...updated[originalIdx], libero: 'libero1' }
                                  }
                                }
                                
                                setAwayRoster(updated)
                              }
                            }}
                            style={{ padding: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', borderRadius: '0' }}
                            className="coin-toss-select"
                          >
                            <option value="" style={{ background: 'var(--bg)', color: 'var(--text)' }}></option>
                            {!(teamA === 'home' ? homeRoster : awayRoster).some((player, idx) => idx !== originalIdx && player.libero === 'libero1') && (
                              <option value="libero1" style={{ background: 'var(--bg)', color: 'var(--text)' }}>L1</option>
                            )}
                            {!(teamA === 'home' ? homeRoster : awayRoster).some((player, idx) => idx !== originalIdx && player.libero === 'libero2') && (
                              <option value="libero2" style={{ background: 'var(--bg)', color: 'var(--text)' }}>L2</option>
                            )}
                          </select>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            <input 
                              type="radio" 
                              name={`${teamA}-captain`}
                              checked={p.isCaptain || false} 
                              onChange={e => {
                                if (teamA === 'home') {
                                  const updated = homeRoster.map((player, idx) => ({
                                    ...player,
                                    isCaptain: idx === originalIdx ? e.target.checked : false
                                  }))
                                  setHomeRoster(updated)
                                } else {
                                  const updated = awayRoster.map((player, idx) => ({
                                    ...player,
                                    isCaptain: idx === originalIdx ? e.target.checked : false
                                  }))
                                  setAwayRoster(updated)
                                }
                              }} 
                            />
                            <span style={{ fontSize: '11px', fontWeight: 600 }}>C</span>
                          </label>
                </div>
                      </td>
                      <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                        <button 
                          type="button" 
                          className="secondary" 
                          onClick={() => setDeletePlayerModal({ team: 'teamA', index: originalIdx })}
                          style={{ padding: '2px', fontSize: '12px', minWidth: 'auto', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                          title="Delete player"
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                    ))}
                </tbody>
              </table>
              )}
                </div>
            
            {/* Bench Officials Section */}
            {showCoinTossRoster && (() => {
              const bench = teamA === 'home' ? benchHome : benchAway
              const sortedBench = sortBenchByHierarchy(bench)
              return (
                <div style={{ marginTop: 16, marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Bench Officials</h4>
                    {showCoinTossRoster && (
                      <button 
                        type="button" 
                        className="secondary" 
                        onClick={() => {
                          const newOfficial = initBench('Coach')
                          if (teamA === 'home') {
                            setBenchHome([...benchHome, newOfficial])
                          } else {
                            setBenchAway([...benchAway, newOfficial])
                          }
                        }}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        Add Official
                      </button>
                    )}
                  </div>
                  <table className="roster-table">
                    <thead>
                      <tr>
                        <th>Role</th>
                        <th>Name</th>
                        <th style={{ width: '90px' }}>DOB</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedBench.map((official, idx) => {
                        const originalIdx = bench.findIndex(b => b === official)
                        return (
                          <tr key={`${teamA}-bench-${originalIdx}`}>
                            <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                              <select
                                value={official.role || ''}
                                onChange={e => {
                                  if (teamA === 'home') {
                                    const updated = [...benchHome]
                                    updated[originalIdx] = { ...updated[originalIdx], role: e.target.value }
                                    setBenchHome(updated)
                                  } else {
                                    const updated = [...benchAway]
                                    updated[originalIdx] = { ...updated[originalIdx], role: e.target.value }
                                    setBenchAway(updated)
                                  }
                                }}
                                className="coin-toss-select"
                                style={{ padding: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', borderRadius: '0', width: '100%' }}
                              >
                                {BENCH_ROLES.map(role => (
                                  <option key={role.value} value={role.value} style={{ background: 'var(--bg)', color: 'var(--text)' }}>
                                    {role.label} - {role.fullLabel}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                              <input 
                                type="text" 
                                value={`${official.lastName || ''} ${official.firstName || ''}`.trim() || ''} 
                                onChange={e => {
                                  const parts = e.target.value.split(' ').filter(p => p)
                                  const lastName = parts.length > 0 ? parts[0] : ''
                                  const firstName = parts.length > 1 ? parts.slice(1).join(' ') : ''
                                  if (teamA === 'home') {
                                    const updated = [...benchHome]
                                    updated[originalIdx] = { ...updated[originalIdx], lastName, firstName }
                                    setBenchHome(updated)
                                  } else {
                                    const updated = [...benchAway]
                                    updated[originalIdx] = { ...updated[originalIdx], lastName, firstName }
                                    setBenchAway(updated)
                                  }
                                }}
                                style={{ width: '100%', padding: '0', margin: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', verticalAlign: 'baseline', borderRadius: '0' }}
                              />
                            </td>
                            <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px', width: '90px' }}>
                              <input 
                                type="date" 
                                value={official.dob ? formatDateToISO(official.dob) : ''} 
                                onChange={e => {
                                  const value = e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''
                                  if (teamA === 'home') {
                                    const updated = [...benchHome]
                                    updated[originalIdx] = { ...updated[originalIdx], dob: value }
                                    setBenchHome(updated)
                                  } else {
                                    const updated = [...benchAway]
                                    updated[originalIdx] = { ...updated[originalIdx], dob: value }
                                    setBenchAway(updated)
                                  }
                                }}
                                className="coin-toss-date-input"
                                style={{ width: '100%', padding: '0', margin: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', verticalAlign: 'baseline', borderRadius: '0' }}
                              />
                            </td>
                            <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                              <button 
                                type="button" 
                                className="secondary" 
                                onClick={() => {
                                  if (teamA === 'home') {
                                    setBenchHome(benchHome.filter((_, i) => i !== originalIdx))
                                  } else {
                                    setBenchAway(benchAway.filter((_, i) => i !== originalIdx))
                                  }
                                }}
                                style={{ padding: '2px', fontSize: '12px', minWidth: 'auto', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                title="Delete official"
                              >
                                🗑️
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
            </div>
          )
        })()}
            
            <div style={{ display: 'flex', flexDirection: 'row', gap: 16, marginTop: 24, paddingTop: 16, borderTop: showCoinTossRoster ? '2px solid rgba(255,255,255,0.1)' : 'none' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <button onClick={() => setOpenSignature(teamA === 'home' ? 'home-coach' : 'away-coach')} className={`sign ${teamACoachSig ? 'signed' : ''}`}>Coach A Signature</button>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <button onClick={() => setOpenSignature(teamA === 'home' ? 'home-captain' : 'away-captain')} className={`sign ${teamACaptainSig ? 'signed' : ''}`}>Captain A Signature</button>
              </div>
            </div>
          </div>
          
          {/* Middle buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', alignSelf: 'stretch' }}>
            <div style={{ height: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '30px' }}>
              <button className="secondary" onClick={switchTeams} style={{ padding: '8px 16px' }}>
                Switch Teams
              </button>
            </div>
            <div style={{ height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <button className="secondary" onClick={switchServe} style={{ padding: '8px 16px' }}>
                Switch Serve
              </button>
            </div>
          </div>
          
          {/* Team B */}
          <div>
            <h1 style={{ margin: 2, fontSize: '24px', fontWeight: 700, textAlign: 'center' }}>Team B</h1>
            <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, height: '48px' }}>
              <button 
                type="button"
                style={{ 
                  background: teamBInfo.color, 
                  color: isBrightColor(teamBInfo.color) ? '#000' : '#fff', 
                  flex: 1,
                  padding: '12px',
                  fontSize: '14px',
                  fontWeight: 600,
                  border: 'none',
                  borderRadius: '8px'
                }}
              >
                {teamBInfo.name}
              </button>
            </div>
            
            <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center', height: '64px', alignItems: 'center', gap: 12 }}>
              {serveB ? volleyballImage : volleyballPlaceholder}
            </div>
            
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <h4 style={{ margin: 0, fontSize: '14px' }}>Roster</h4>
                  <button type="button" className="secondary" onClick={() => setShowCoinTossRoster(!showCoinTossRoster)} style={{ padding: '4px 8px', fontSize: '12px' }}>
                    {showCoinTossRoster ? 'Hide' : 'Show'}
          </button>
        </div>
                {showCoinTossRoster && (
                  <button type="button" className="secondary" onClick={() => setAddPlayerModal('teamB')} style={{ padding: '4px 8px', fontSize: '12px' }}>
                    Add Player
                  </button>
                )}
              </div>
              {showCoinTossRoster && (
              <table className="roster-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name</th>
                    <th style={{ width: '90px' }}>DOB</th>
                    <th>Role</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {teamBRosterEntries.map(({ player: p, index: originalIdx }) => (
                    <tr key={`${teamB}-${originalIdx}`}>
                      <td className="coin-toss-number" style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <input 
                            type="number" 
                            inputMode="numeric" 
                            min="1"
                            max="99"
                            value={p.number ?? ''} 
                            onChange={e => {
                              const val = e.target.value ? Number(e.target.value) : null
                              if (val !== null && (val < 1 || val > 99)) return
                              if (teamB === 'home') {
                                const updated = [...homeRoster]
                                updated[originalIdx] = { ...updated[originalIdx], number: val }
                                setHomeRoster(updated)
                              } else {
                                const updated = [...awayRoster]
                                updated[originalIdx] = { ...updated[originalIdx], number: val }
                                setAwayRoster(updated)
                              }
                            }}
                            style={{ 
                              width: p.isCaptain ? '24px' : '28px',
                              height: p.isCaptain ? '24px' : 'auto',
                              padding: '0', 
                              margin: '0', 
                              background: 'transparent', 
                              border: p.isCaptain ? '2px solid var(--accent)' : 'none', 
                              borderRadius: p.isCaptain ? '50%' : '0',
                              color: 'var(--text)', 
                              textAlign: 'center', 
                              fontSize: '12px', 
                              lineHeight: 'normal', 
                              verticalAlign: 'baseline'
                            }}
                          />
                        {p.libero && (
                            <span style={{ 
                              color: 'var(--accent)', 
                              fontSize: '10px', 
                              fontWeight: 700,
                              lineHeight: '1'
                            }}>
                            {p.libero === 'libero1' ? 'L1' : 'L2'}
                          </span>
                        )}
                </div>
                      </td>
                      <td className="coin-toss-name" style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px', maxWidth: '150px' }}>
                        <input 
                          type="text" 
                          value={`${p.lastName || ''} ${p.firstName || ''}`.trim() || ''} 
                          onChange={e => {
                            const parts = e.target.value.split(' ').filter(p => p)
                            const lastName = parts.length > 0 ? parts[0] : ''
                            const firstName = parts.length > 1 ? parts.slice(1).join(' ') : ''
                            if (teamB === 'home') {
                              const updated = [...homeRoster]
                              updated[originalIdx] = { ...updated[originalIdx], lastName, firstName }
                              setHomeRoster(updated)
                            } else {
                              const updated = [...awayRoster]
                              updated[originalIdx] = { ...updated[originalIdx], lastName, firstName }
                              setAwayRoster(updated)
                            }
                          }}
                          style={{ width: '100%', padding: '0', margin: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', verticalAlign: 'baseline', borderRadius: '0' }}
                        />
                      </td>
                      <td className="coin-toss-dob" style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px', width: '90px' }}>
                        <input 
                          type="date" 
                          value={p.dob ? formatDateToISO(p.dob) : ''} 
                          onChange={e => {
                            const value = e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''
                            if (teamB === 'home') {
                              const updated = [...homeRoster]
                              updated[originalIdx] = { ...updated[originalIdx], dob: value }
                              setHomeRoster(updated)
                            } else {
                              const updated = [...awayRoster]
                              updated[originalIdx] = { ...updated[originalIdx], dob: value }
                              setAwayRoster(updated)
                            }
                          }}
                          className="coin-toss-date-input"
                          style={{ width: '100%', padding: '0', margin: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', verticalAlign: 'baseline', borderRadius: '0' }}
                        />
                      </td>
                      <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <select 
                            value={p.libero || ''} 
                            onChange={e => {
                              if (teamB === 'home') {
                                const updated = [...homeRoster]
                                updated[originalIdx] = { ...updated[originalIdx], libero: e.target.value }
                                
                                if (e.target.value === 'libero2') {
                                  const hasL1 = updated.some((player, idx) => idx !== originalIdx && player.libero === 'libero1')
                                  if (!hasL1) {
                                    updated[originalIdx] = { ...updated[originalIdx], libero: 'libero1' }
                                  }
                                }
                                
                                setHomeRoster(updated)
                              } else {
                                const updated = [...awayRoster]
                                updated[originalIdx] = { ...updated[originalIdx], libero: e.target.value }
                                
                                if (e.target.value === 'libero2') {
                                  const hasL1 = updated.some((player, idx) => idx !== originalIdx && player.libero === 'libero1')
                                  if (!hasL1) {
                                    updated[originalIdx] = { ...updated[originalIdx], libero: 'libero1' }
                                  }
                                }
                                
                                setAwayRoster(updated)
                              }
                            }}
                            style={{ padding: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', borderRadius: '0' }}
                            className="coin-toss-select"
                          >
                            <option value="" style={{ background: 'var(--bg)', color: 'var(--text)' }}></option>
                            {!(teamB === 'home' ? homeRoster : awayRoster).some((player, idx) => idx !== originalIdx && player.libero === 'libero1') && (
                              <option value="libero1" style={{ background: 'var(--bg)', color: 'var(--text)' }}>L1</option>
                            )}
                            {!(teamB === 'home' ? homeRoster : awayRoster).some((player, idx) => idx !== originalIdx && player.libero === 'libero2') && (
                              <option value="libero2" style={{ background: 'var(--bg)', color: 'var(--text)' }}>L2</option>
                            )}
                          </select>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                            <input 
                              type="radio" 
                              name={`${teamB}-captain`}
                              checked={p.isCaptain || false} 
                              onChange={e => {
                                if (teamB === 'home') {
                                  const updated = homeRoster.map((player, idx) => ({
                                    ...player,
                                    isCaptain: idx === originalIdx ? e.target.checked : false
                                  }))
                                  setHomeRoster(updated)
                                } else {
                                  const updated = awayRoster.map((player, idx) => ({
                                    ...player,
                                    isCaptain: idx === originalIdx ? e.target.checked : false
                                  }))
                                  setAwayRoster(updated)
                                }
                              }} 
                            />
                            <span style={{ fontSize: '11px', fontWeight: 600 }}>C</span>
                          </label>
                </div>
                      </td>
                      <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                        <button 
                          type="button" 
                          className="secondary" 
                          onClick={() => setDeletePlayerModal({ team: 'teamB', index: originalIdx })}
                          style={{ padding: '2px', fontSize: '12px', minWidth: 'auto', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                          title="Delete player"
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                    ))}
                </tbody>
              </table>
              )}
                </div>
            
            {/* Bench Officials Section */}
            {showCoinTossRoster && (() => {
              const bench = teamB === 'home' ? benchHome : benchAway
              const sortedBench = sortBenchByHierarchy(bench)
              return (
                <div style={{ marginTop: 16, marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Bench Officials</h4>
                    {showCoinTossRoster && (
                      <button 
                        type="button" 
                        className="secondary" 
                        onClick={() => {
                          const bench = teamB === 'home' ? benchHome : benchAway
                          // Find the first available role
                          const takenRoles = new Set(bench.map(b => b.role))
                          const availableRole = BENCH_ROLES.find(r => !takenRoles.has(r.value))
                          if (availableRole) {
                            const newOfficial = initBench(availableRole.value)
                            if (teamB === 'home') {
                              setBenchHome([...benchHome, newOfficial])
                            } else {
                              setBenchAway([...benchAway, newOfficial])
                            }
                          }
                        }}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        Add Official
                      </button>
                    )}
                  </div>
                  <table className="roster-table">
                    <thead>
                      <tr>
                        <th>Role</th>
                        <th>Name</th>
                        <th style={{ width: '90px' }}>DOB</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedBench.map((official, idx) => {
                        const originalIdx = bench.findIndex(b => b === official)
                        return (
                          <tr key={`${teamB}-bench-${originalIdx}`}>
                            <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                              <select
                                value={official.role || 'Coach'}
                                onChange={e => {
                                  const roleValue = e.target.value || 'Coach'
                                  if (teamB === 'home') {
                                    // Check if this role is already taken by another official
                                    const isRoleTaken = benchHome.some((b, idx) => idx !== originalIdx && b.role === roleValue)
                                    if (isRoleTaken) {
                                      // Don't allow duplicate roles
                                      return
                                    }
                                    const updated = [...benchHome]
                                    updated[originalIdx] = { ...updated[originalIdx], role: roleValue }
                                    setBenchHome(updated)
                                  } else {
                                    // Check if this role is already taken by another official
                                    const isRoleTaken = benchAway.some((b, idx) => idx !== originalIdx && b.role === roleValue)
                                    if (isRoleTaken) {
                                      // Don't allow duplicate roles
                                      return
                                    }
                                    const updated = [...benchAway]
                                    updated[originalIdx] = { ...updated[originalIdx], role: roleValue }
                                    setBenchAway(updated)
                                  }
                                }}
                                className="coin-toss-select"
                                style={{ padding: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', borderRadius: '0', width: '100%' }}
                              >
                                {BENCH_ROLES.map(role => {
                                  const isRoleTaken = (teamB === 'home' ? benchHome : benchAway).some((b, idx) => idx !== originalIdx && b.role === role.value)
                                  return (
                                    <option key={role.value} value={role.value} disabled={isRoleTaken} style={{ background: 'var(--bg)', color: isRoleTaken ? 'rgba(255, 255, 255, 0.3)' : 'var(--text)' }}>
                                      {role.label} - {role.fullLabel}{isRoleTaken ? ' (already assigned)' : ''}
                                    </option>
                                  )
                                })}
                              </select>
                            </td>
                            <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                              <input 
                                type="text" 
                                value={`${official.lastName || ''} ${official.firstName || ''}`.trim() || ''} 
                                onChange={e => {
                                  const parts = e.target.value.split(' ').filter(p => p)
                                  const lastName = parts.length > 0 ? parts[0] : ''
                                  const firstName = parts.length > 1 ? parts.slice(1).join(' ') : ''
                                  if (teamB === 'home') {
                                    const updated = [...benchHome]
                                    updated[originalIdx] = { ...updated[originalIdx], lastName, firstName }
                                    setBenchHome(updated)
                                  } else {
                                    const updated = [...benchAway]
                                    updated[originalIdx] = { ...updated[originalIdx], lastName, firstName }
                                    setBenchAway(updated)
                                  }
                                }}
                                style={{ width: '100%', padding: '0', margin: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', verticalAlign: 'baseline', borderRadius: '0' }}
                              />
                            </td>
                            <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px', width: '90px' }}>
                              <input 
                                type="date" 
                                value={official.dob ? formatDateToISO(official.dob) : ''} 
                                onChange={e => {
                                  const value = e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''
                                  if (teamB === 'home') {
                                    const updated = [...benchHome]
                                    updated[originalIdx] = { ...updated[originalIdx], dob: value }
                                    setBenchHome(updated)
                                  } else {
                                    const updated = [...benchAway]
                                    updated[originalIdx] = { ...updated[originalIdx], dob: value }
                                    setBenchAway(updated)
                                  }
                                }}
                                className="coin-toss-date-input"
                                style={{ width: '100%', padding: '0', margin: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', lineHeight: 'normal', verticalAlign: 'baseline', borderRadius: '0' }}
                              />
                            </td>
                            <td style={{ verticalAlign: 'middle', padding: '8px 8px 6px 8px' }}>
                              <button 
                                type="button" 
                                className="secondary" 
                                onClick={() => {
                                  if (teamB === 'home') {
                                    setBenchHome(benchHome.filter((_, i) => i !== originalIdx))
                                  } else {
                                    setBenchAway(benchAway.filter((_, i) => i !== originalIdx))
                                  }
                                }}
                                style={{ padding: '2px', fontSize: '12px', minWidth: 'auto', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                title="Delete official"
                              >
                                🗑️
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
            </div>
          )
        })()}
            
            <div style={{ display: 'flex', flexDirection: 'row', gap: 16, marginTop: 24, paddingTop: 16, borderTop: showCoinTossRoster ? '2px solid rgba(255,255,255,0.1)' : 'none' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <button onClick={() => setOpenSignature(teamB === 'home' ? 'home-coach' : 'away-coach')} className={`sign ${teamBCoachSig ? 'signed' : ''}`}>Coach B Signature</button>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <button onClick={() => setOpenSignature(teamB === 'home' ? 'home-captain' : 'away-captain')} className={`sign ${teamBCaptainSig ? 'signed' : ''}`}>Captain B Signature</button>
              </div>
            </div>
          </div>
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
          {isCoinTossConfirmed ? (
            <button onClick={async () => {
              // Save coin toss result and firstServe when returning to match
              if (matchId) {
                const firstServeTeam = serveA ? teamA : teamB
                await db.matches.update(matchId, {
                  firstServe: firstServeTeam,
                  coinTossTeamA: teamA,
                  coinTossTeamB: teamB,
                  coinTossServeA: serveA,
                  coinTossServeB: serveB
                })
                
                // Add match update to sync queue
                const match = await db.matches.get(matchId)
                if (match) {
                  await db.sync_queue.add({
                    resource: 'match',
                    action: 'update',
                    payload: {
                      id: String(matchId),
                      status: match.status || null,
                      hall: match.hall || null,
                      city: match.city || null,
                      league: match.league || null,
                      scheduled_at: match.scheduledAt || null
                    },
                    ts: new Date().toISOString(),
                    status: 'queued'
                  })
                }
              }
              onReturn()
            }} style={{ padding: '12px 24px', fontSize: '14px' }}>
              Return to match
            </button>
          ) : (
          <button onClick={confirmCoinToss} style={{ padding: '12px 24px', fontSize: '14px' }}>
            Confirm Coin Toss Result
          </button>
          )}
        </div>
        
        {/* Add Player Modal */}
        {addPlayerModal && (() => {
          const isTeamA = addPlayerModal === 'teamA'
          const currentTeam = isTeamA ? teamA : teamB
          const roster = currentTeam === 'home' ? homeRoster : awayRoster
          const num = currentTeam === 'home' ? homeNum : awayNum
          const first = currentTeam === 'home' ? homeFirst : awayFirst
          const last = currentTeam === 'home' ? homeLast : awayLast
          const dob = currentTeam === 'home' ? homeDob : awayDob
          const libero = currentTeam === 'home' ? homeLibero : awayLibero
          const captain = currentTeam === 'home' ? homeCaptain : awayCaptain
          
          return (
            <Modal
              title={`Add Player - ${isTeamA ? 'Team A' : 'Team B'}`}
              open={true}
              onClose={() => setAddPlayerModal(null)}
              width={500}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', marginBottom: 4 }}>Number</label>
                  <input 
                    type="number" 
                    inputMode="numeric" 
                    value={num} 
                    onChange={e => currentTeam === 'home' ? setHomeNum(e.target.value) : setAwayNum(e.target.value)}
                    style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 4 }}>Last Name</label>
                  <input 
                    type="text" 
                    className="capitalize"
                    value={last} 
                    onChange={e => currentTeam === 'home' ? setHomeLast(e.target.value) : setAwayLast(e.target.value)}
                    style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 4 }}>First Name</label>
                  <input 
                    type="text" 
                    className="capitalize"
                    value={first} 
                    onChange={e => currentTeam === 'home' ? setHomeFirst(e.target.value) : setAwayFirst(e.target.value)}
                    style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 4 }}>Date of Birth</label>
                  <input 
                    type="date" 
                    value={dob ? formatDateToISO(dob) : ''} 
                    onChange={e => {
                      const value = e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''
                      currentTeam === 'home' ? setHomeDob(value) : setAwayDob(value)
                    }}
                    style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 4 }}>Libero</label>
                  <select 
                    value={libero} 
                    onChange={e => {
                      let newValue = e.target.value
                      
                      // If L2 is selected but no L1 exists, automatically change L2 to L1
                      if (newValue === 'libero2') {
                        const hasL1 = roster.some(p => p.libero === 'libero1')
                        if (!hasL1) {
                          newValue = 'libero1'
                        }
                      }
                      
                      currentTeam === 'home' ? setHomeLibero(newValue) : setAwayLibero(newValue)
                    }}
                    style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                  >
                    <option value="">none</option>
                    {!roster.some(p => p.libero === 'libero1') && (
                      <option value="libero1">Libero 1</option>
                    )}
                    {!roster.some(p => p.libero === 'libero2') && (
                      <option value="libero2">Libero 2</option>
                    )}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input 
                      type="checkbox" 
                      checked={captain} 
                      onChange={e => currentTeam === 'home' ? setHomeCaptain(e.target.checked) : setAwayCaptain(e.target.checked)}
                    />
                    <span>Captain</span>
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                  <button className="secondary" onClick={() => setAddPlayerModal(null)}>Cancel</button>
                  <button onClick={() => {
                    if (!last || !first) {
                      alert('Please enter last name and first name')
                      return
                    }
                    const newPlayer = { number: num ? Number(num) : null, lastName: last, firstName: first, dob, libero, isCaptain: captain }
                    
                    if (currentTeam === 'home') {
                      setHomeRoster(list => {
                        const cleared = captain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                        const next = [...cleared, newPlayer].sort((a,b) => {
                          const an = a.number ?? 999
                          const bn = b.number ?? 999
                          return an - bn
                        })
                        return next
                      })
                      setHomeNum(''); setHomeFirst(''); setHomeLast(''); setHomeDob(''); setHomeLibero(''); setHomeCaptain(false)
                    } else {
                      setAwayRoster(list => {
                        const cleared = captain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                        const next = [...cleared, newPlayer].sort((a,b) => {
                          const an = a.number ?? 999
                          const bn = b.number ?? 999
                          return an - bn
                        })
                        return next
                      })
                      setAwayNum(''); setAwayFirst(''); setAwayLast(''); setAwayDob(''); setAwayLibero(''); setAwayCaptain(false)
                    }
                    setAddPlayerModal(null)
                  }}>Add Player</button>
                </div>
              </div>
            </Modal>
          )
        })()}
        
        {/* Delete Player Confirmation Modal */}
        {deletePlayerModal && (() => {
          const isTeamA = deletePlayerModal.team === 'teamA'
          const currentTeam = isTeamA ? teamA : teamB
          const roster = currentTeam === 'home' ? homeRoster : awayRoster
          const player = roster[deletePlayerModal.index]
          const playerName = player ? `${player.lastName || ''} ${player.firstName || ''}`.trim() || `Player #${player.number || '?'}` : 'Player'
          
          return (
            <Modal
              title="Delete Player"
              open={true}
              onClose={() => setDeletePlayerModal(null)}
              width={400}
            >
              <div style={{ padding: '16px 0' }}>
                <p style={{ marginBottom: 16 }}>
                  Are you sure you want to delete <strong>{playerName}</strong> from {isTeamA ? 'Team A' : 'Team B'}?
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="secondary" onClick={() => setDeletePlayerModal(null)}>Cancel</button>
                  <button onClick={() => {
                    if (currentTeam === 'home') {
                      setHomeRoster(list => list.filter((_, idx) => idx !== deletePlayerModal.index))
                    } else {
                      setAwayRoster(list => list.filter((_, idx) => idx !== deletePlayerModal.index))
                    }
                    setDeletePlayerModal(null)
                  }}>Delete</button>
                </div>
              </div>
            </Modal>
          )
        })()}
        
        {/* Notice Modal */}
        {noticeModal && (
          <Modal
            title="Notice"
            open={true}
            onClose={() => setNoticeModal(null)}
            width={400}
            hideCloseButton={true}
          >
            <div style={{ padding: '24px', textAlign: 'center' }}>
              <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--text)' }}>
                {noticeModal.message}
              </p>
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                <button
                  onClick={() => setNoticeModal(null)}
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
        
        <SignaturePad 
          open={openSignature !== null} 
          onClose={() => setOpenSignature(null)} 
          onSave={handleSignatureSave}
          title={openSignature === 'home-coach' ? 'Home Coach Signature' : 
                 openSignature === 'home-captain' ? 'Home Captain Signature' :
                 openSignature === 'away-coach' ? 'Away Coach Signature' :
                 openSignature === 'away-captain' ? 'Away Captain Signature' : 'Sign'}
          existingSignature={
            openSignature === 'home-coach' ? homeCoachSignature :
            openSignature === 'home-captain' ? homeCaptainSignature :
            openSignature === 'away-coach' ? awayCoachSignature :
            openSignature === 'away-captain' ? awayCaptainSignature : null
          }
        />
      </div>
    )
  }

  const StatusBadge = ({ ready }) => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: '50%',
        backgroundColor: ready ? '#22c55e' : '#f97316',
        color: '#0b1120',
        fontWeight: 700,
        fontSize: 12,
        marginRight: 8
      }}
      aria-label={ready ? 'Complete' : 'Incomplete'}
      title={ready ? 'Complete' : 'Incomplete'}
    >
      {ready ? '✓' : '!'}
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
    } catch (error) {
      console.error('Failed to update away team connection setting:', error)
    }
  }

  // Connection Banner Component
  const ConnectionBanner = ({ team, enabled, onToggle, pin, onEditPin }) => {
    return (
      <div style={{
        marginTop: 12,
        padding: '12px',
        background: 'rgba(255,255,255,0.05)',
        borderRadius: '8px',
        border: '1px solid rgba(255,255,255,0.1)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 500,
            whiteSpace: 'nowrap'
          }}>
            <span>Enable Dashboard</span>
            <div style={{
              position: 'relative',
              width: '44px',
              height: '24px',
              background: enabled ? '#22c55e' : '#6b7280',
              borderRadius: '12px',
              transition: 'background 0.2s',
              cursor: 'pointer',
              flexShrink: 0
            }}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(!enabled)
            }}
            >
              <div style={{
                position: 'absolute',
                top: '2px',
                left: enabled ? '22px' : '2px',
                width: '20px',
                height: '20px',
                background: '#fff',
                borderRadius: '50%',
                transition: 'left 0.2s',
                boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
              }} />
            </div>
          </label>
          {enabled && pin && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                {team === 'referee' ? 'Referee PIN:' : team === 'home' ? 'Home Bench PIN:' : 'Away Bench PIN:'}
              </span>
              <span style={{
                fontWeight: 700,
                fontSize: '14px',
                color: 'var(--accent)',
                letterSpacing: '2px',
                fontFamily: 'monospace'
              }}>
                {pin}
              </span>
              <button
                onClick={onEditPin}
                style={{
                  padding: '2px 8px',
                  fontSize: '11px',
                  fontWeight: 600,
                  background: 'rgba(255,255,255,0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                Edit
              </button>
            </div>
          )}
        </div>
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
    <div className="setup">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', gap: '16px' }}>
        <h2 style={{ margin: 0 }}>Match Setup</h2>
        
        
        {onGoHome && (
          <button className="secondary" onClick={onGoHome}>
            Home
          </button>
        )}
      </div>
      <div className="grid-4">
        <div className="card" style={{ order: 1 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <StatusBadge ready={matchInfoConfigured} />
                <h3 style={{ margin: 0 }}>Match info</h3>
              </div>
            </div>
            <div
              className="text-sm"
              style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 4, marginTop: 8 }}
            >
              <span>Date:</span>
              <span>{formatDisplayDate(date) || 'Not set'}</span>
              <span>Time:</span>
              <span>{formatDisplayTime(time) || 'Not set'}</span>
              <span>City:</span>
              <span>{city || 'Not set'}</span>
              <span>Hall:</span>
              <span>{hall || 'Not set'}</span>
              <span>Game #:</span>
              <span>{gameN || 'Not set'}</span>
              <span>League:</span>
              <span>{league || 'Not set'}</span>
            </div>
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setCurrentView('info')}>Edit</button></div>
        </div>
        <div className="card" style={{ order: 2 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <StatusBadge ready={officialsConfigured} />
                <h3 style={{ margin: 0 }}>Match officials</h3>
              </div>
            </div>
            <div className="text-sm" style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 4, marginTop: 8 }}>
              <span>1st referee:</span>
              <span>{formatOfficial(ref1Last, ref1First)}</span>
              <span>2nd referee:</span>
              <span>{formatOfficial(ref2Last, ref2First)}</span>
              <span>Scorer:</span>
              <span>{formatOfficial(scorerLast, scorerFirst)}</span>
              <span>Ass. Scorer:</span>
              <span>{formatOfficial(asstLast, asstFirst)}</span>
            </div>
            <ConnectionBanner
              team="referee"
              enabled={refereeConnectionEnabled}
              onToggle={handleRefereeConnectionToggle}
              pin={match?.refereePin}
              onEditPin={() => handleEditPin('referee')}
            />
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setCurrentView('officials')}>Edit</button></div>
        </div>
        <div className="card" style={{ order: 3 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <StatusBadge ready={homeConfigured} />
                <h3 style={{ margin: 0 }}>Home team</h3>
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, width: '100%', flexWrap: 'wrap' }}>
                {/* Team Name */}
                <div style={{ flex: 1, minWidth: '200px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.7)', fontWeight: 500 }}>Team Name</label>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <span
                      ref={homeTeamMeasureRef}
                      style={{
                        position: 'absolute',
                        visibility: 'hidden',
                        whiteSpace: 'pre',
                        fontSize: '16px',
                        fontWeight: 700,
                        letterSpacing: '0.01em',
                        padding: '0 12px'
                      }}
                    >
                      {home || 'Home team name'}
                    </span>
                    <input
                      ref={homeTeamInputRef}
                      type="text"
                      value={home}
                      onChange={e => {
                        setHome(e.target.value)
                        // Update width on change
                        if (homeTeamMeasureRef.current && homeTeamInputRef.current) {
                          homeTeamMeasureRef.current.textContent = e.target.value || 'Home team name'
                          const measuredWidth = homeTeamMeasureRef.current.offsetWidth
                          homeTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
                        }
                      }}
                      placeholder="Home team name"
                      style={{
                        minWidth: '80px',
                        width: 'auto',
                        padding: '8px 12px',
                        borderRadius: 8,
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        background: 'rgba(15, 23, 42, 0.35)',
                        color: 'var(--text)',
                        fontSize: '16px',
                        fontWeight: 700,
                        letterSpacing: '0.01em',
                        minHeight: 48,
                        boxSizing: 'border-box',
                        transition: 'width 0.1s ease'
                      }}
                      onFocus={() => {
                        if (homeTeamMeasureRef.current && homeTeamInputRef.current) {
                          homeTeamMeasureRef.current.textContent = home || 'Home team name'
                          const measuredWidth = homeTeamMeasureRef.current.offsetWidth
                          homeTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
                        }
                      }}
                    />
                  </div>
                </div>
                
                {/* Short Name */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '90px', flexShrink: 0 }}>
                  <label style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.7)', fontWeight: 500 }}>Short</label>
                  <input
                    type="text"
                    value={homeShortName}
                    onChange={e => setHomeShortName(e.target.value.toUpperCase())}
                    placeholder="Short name"
                    maxLength={8}
                    required
                    style={{
                      width: '100%',
                      padding: '8px 8px',
                      borderRadius: 8,
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      background: 'rgba(15, 23, 42, 0.35)',
                      color: 'var(--text)',
                      fontSize: '16px',
                      fontWeight: 500,
                      minHeight: 48,
                      boxSizing: 'border-box',
                      textAlign: 'center'
                    }}
                  />
                </div>
                
                {/* Color Selector */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
                  <label style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.7)', fontWeight: 500 }}>Click to select color</label>
                  <div 
                    className="shirt" 
                    style={{ background: homeColor, cursor: 'pointer' }}
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
                </div>
              </div>
            </div>
            {/* <ConnectionBanner
            //   team="home"
            //   enabled={homeTeamConnectionEnabled}
            //   onToggle={handleHomeTeamConnectionToggle}
            //   pin={match?.homeTeamPin}
            //   onEditPin={() => handleEditPin('benchHome')}
            // /> */}
            <div
              className="text-sm"
              style={{ display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 4, marginTop: 12 }}
            >
              <span>Players:</span>
              <span>{homeCounts.players}</span>
              <span>o/w Libero(s):</span>
              <span>{homeCounts.liberos}</span>
              <span>Bench staff:</span>
              <span>{homeCounts.bench}</span>
            </div>
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setCurrentView('home')}>Edit</button></div>
        </div>
        <div className="card" style={{ order: 4 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <StatusBadge ready={awayConfigured} />
                <h3 style={{ margin: 0 }}>Away team</h3>
              </div>
              
            </div>
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, width: '100%', flexWrap: 'wrap' }}>
                {/* Team Name */}
                <div style={{ flex: 1, minWidth: '200px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.7)', fontWeight: 500 }}>Team Name</label>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <span
                      ref={awayTeamMeasureRef}
                      style={{
                        position: 'absolute',
                        visibility: 'hidden',
                        whiteSpace: 'pre',
                        fontSize: '16px',
                        fontWeight: 700,
                        letterSpacing: '0.01em',
                        padding: '0 12px'
                      }}
                    >
                      {away || 'Away team name'}
                    </span>
                    <input
                      ref={awayTeamInputRef}
                      type="text"
                      value={away}
                      onChange={e => {
                        setAway(e.target.value)
                        // Update width on change
                        if (awayTeamMeasureRef.current && awayTeamInputRef.current) {
                          awayTeamMeasureRef.current.textContent = e.target.value || 'Away team name'
                          const measuredWidth = awayTeamMeasureRef.current.offsetWidth
                          awayTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
                        }
                      }}
                      placeholder="Away team name"
                      style={{
                        minWidth: '80px',
                        width: 'auto',
                        padding: '8px 12px',
                        borderRadius: 8,
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        background: 'rgba(15, 23, 42, 0.35)',
                        color: 'var(--text)',
                        fontSize: '16px',
                        fontWeight: 700,
                        letterSpacing: '0.01em',
                        minHeight: 48,
                        boxSizing: 'border-box',
                        transition: 'width 0.1s ease'
                      }}
                      onFocus={() => {
                        if (awayTeamMeasureRef.current && awayTeamInputRef.current) {
                          awayTeamMeasureRef.current.textContent = away || 'Away team name'
                          const measuredWidth = awayTeamMeasureRef.current.offsetWidth
                          awayTeamInputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
                        }
                      }}
                    />
                  </div>
                </div>
                
                {/* Short Name */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '90px', flexShrink: 0 }}>
                  <label style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.7)', fontWeight: 500 }}>Short</label>
                  <input
                    type="text"
                    value={awayShortName}
                    onChange={e => setAwayShortName(e.target.value.toUpperCase())}
                    placeholder="Short name"
                    maxLength={8}
                    required
                    style={{
                      width: '100%',
                      padding: '8px 8px',
                      borderRadius: 8,
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      background: 'rgba(15, 23, 42, 0.35)',
                      color: 'var(--text)',
                      fontSize: '16px',
                      fontWeight: 500,
                      minHeight: 48,
                      boxSizing: 'border-box',
                      textAlign: 'center'
                    }}
                  />
                </div>
                
                {/* Color Selector */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
                  <label style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.7)', fontWeight: 500 }}>Click to select color</label>
                  <div 
                    className="shirt" 
                    style={{ background: awayColor, cursor: 'pointer' }}
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
                </div>
              </div>
            </div>
            {/*<ConnectionBanner
              team="away"
              enabled={awayTeamConnectionEnabled}
              onToggle={handleAwayTeamConnectionToggle}
              pin={match?.awayTeamPin}
              onEditPin={() => handleEditPin('benchAway')}
            />*/}
            <div
              className="text-sm"
              style={{ display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 4, marginTop: 12 }}
            >
              <span>Players:</span>
              <span>{awayCounts.players}</span>
              <span>o/w Libero(s):</span>
              <span>{awayCounts.liberos}</span>
              <span>Bench staff:</span>
              <span>{awayCounts.bench}</span>
            </div>
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setCurrentView('away')}>Edit</button></div>
        </div>
        {typeof window !== 'undefined' && window.electronAPI?.server && (
        <div className="card" style={{ order: 5 }}>
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
                      <div style={{ wordBreak: 'break-all' }}>{serverStatus.urls?.refereeIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/referee.html`}</div>
                    </div>
                    <div>
                      <div style={{ color: 'rgba(255,255,255,0.6)' }}>Bench:</div>
                      <div style={{ wordBreak: 'break-all' }}>{serverStatus.urls?.benchIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/bench.html`}</div>
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

        {/* Match Options Card */}
        <div className="card" style={{ order: 6 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>Match Options</h3>
            </div>
            <div style={{ marginTop: 12 }}>
              {/* Manage Captain on Court Toggle */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '8px'
              }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '15px', marginBottom: '4px' }}>Manage Captain on Court</div>
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>
                    Track which player acts as captain when team captain is not on court
                  </div>
                </div>
                <button
                  onClick={() => {
                    const newValue = !manageCaptainOnCourt
                    setManageCaptainOnCourt(newValue)
                    localStorage.setItem('manageCaptainOnCourt', String(newValue))
                  }}
                  style={{
                    width: '52px',
                    height: '28px',
                    borderRadius: '14px',
                    border: 'none',
                    cursor: 'pointer',
                    background: manageCaptainOnCourt ? '#22c55e' : 'rgba(255, 255, 255, 0.2)',
                    position: 'relative',
                    transition: 'background 0.2s',
                    flexShrink: 0,
                    marginLeft: '16px'
                  }}
                >
                  <div style={{
                    width: '20px',
                    height: '20px',
                    borderRadius: '10px',
                    background: '#fff',
                    position: 'absolute',
                    top: '4px',
                    left: manageCaptainOnCourt ? '28px' : '4px',
                    transition: 'left 0.2s'
                  }} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display:'flex', justifyContent:'space-between', marginTop:12, alignItems:'center' }}>
        <button className="secondary" onClick={() => setShowBothRosters(!showBothRosters)}>
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
                // Update match with current data before going to coin toss
                const scheduledAt = (() => {
                  if (!date && !time) return new Date().toISOString()
                  const iso = new Date(`${date}T${time || '00:00'}:00`).toISOString()
                  return iso
                })()
                
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
                    { role: 'assistant scorer', firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob }
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
                
                // Check if team names and short names are set before going to coin toss
                if (!home || home.trim() === '' || home === 'Home' || !away || away.trim() === '' || away === 'Away') {
                  setNoticeModal({ message: 'Please set both team names before proceeding to coin toss.' })
                  return
                }

                if (!homeShortName || homeShortName.trim() === '' || !awayShortName || awayShortName.trim() === '') {
                  setNoticeModal({ message: 'Please set both team short names before proceeding to coin toss.' })
                  return
                }
                
                // Go to coin toss
                setPendingMatchId(matchId)
                setCurrentView('coin-toss')
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
                          <td colSpan="3" style={{ padding: '10px 8px', minHeight: '34px' }}></td>
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
                            <td colSpan="3" style={{ height: '2.5em', padding: '0.5em 0' }}></td>
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
                          <td colSpan="3" style={{ padding: '10px 8px', minHeight: '34px' }}></td>
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
                          <td colSpan="3" style={{ padding: '10px 8px', minHeight: '34px' }}></td>
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
                            <td colSpan="3" style={{ height: '2.5em', padding: '0.5em 0' }}></td>
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
                          <td colSpan="3" style={{ padding: '10px 8px', minHeight: '34px' }}></td>
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
          title="Notice"
          open={true}
          onClose={() => setNoticeModal(null)}
          width={400}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--text)' }}>
              {noticeModal.message}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => setNoticeModal(null)}
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
    </div>
  )
}