import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { findMatchByGameNumber, getMatchData, updateMatchData, listAvailableMatches, getWebSocketStatus, listAvailableMatchesSupabase } from './utils/serverDataSync'
import { getServerStatus } from './utils/networkInfo'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import { parseRosterPdf } from './utils/parseRosterPdf'
import Modal from './components/Modal'
import SimpleHeader from './components/SimpleHeader'
import UpdateBanner from './components/UpdateBanner'
import SignaturePad from './components/SignaturePad'
import { supabase } from './lib/supabaseClient'

// Connection modes
const CONNECTION_MODES = {
  AUTO: 'auto',
  SUPABASE: 'supabase',
  WEBSOCKET: 'websocket'
}

// Date conversion helpers
function formatDateToISO(dateStr) {
  if (!dateStr) return ''
  // If already in ISO format (YYYY-MM-DD), return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr
  // If in DD/MM/YYYY format, convert to YYYY-MM-DD
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) {
    const [day, month, year] = dateStr.split('/')
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
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

function formatDateToDDMMYYYY(dateStr) {
  if (!dateStr) return ''
  // If already in DD/MM/YYYY format, return as-is
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) return dateStr
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

export default function UploadRosterApp() {
  const { t } = useTranslation()
  const [gameNumber, setGameNumber] = useState('')
  const [team, setTeam] = useState('home') // 'home' or 'away'
  const [uploadPin, setUploadPin] = useState('')
  const [match, setMatch] = useState(null)
  const [matchId, setMatchId] = useState(null)
  const [homeTeam, setHomeTeam] = useState(null)
  const [awayTeam, setAwayTeam] = useState(null)
  const [validationError, setValidationError] = useState('')
  const [pdfFile, setPdfFile] = useState(null)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfError, setPdfError] = useState('')
  const [parsedData, setParsedData] = useState(null) // { players: [], bench: [] }
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [showSuccessModal, setShowSuccessModal] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [matchStatusCheck, setMatchStatusCheck] = useState(null) // 'checking', 'valid', 'invalid', null

  // Signature states
  const [coachSignature, setCoachSignature] = useState(null)
  const [captainSignature, setCaptainSignature] = useState(null)
  const [openSignature, setOpenSignature] = useState(null) // 'coach' | 'captain' | null
  const [availableMatches, setAvailableMatches] = useState([])
  const [loadingMatches, setLoadingMatches] = useState(false)
  const [selectedMatch, setSelectedMatch] = useState(null)
  const [connectionStatuses, setConnectionStatuses] = useState({
    server: 'disconnected',
    websocket: 'not_applicable',
    supabase: 'disconnected'
  })
  const [connectionDebugInfo, setConnectionDebugInfo] = useState({})
  const [connectionMode, setConnectionMode] = useState(() => {
    try {
      return localStorage.getItem('roster_connection_mode') || CONNECTION_MODES.AUTO
    } catch { return CONNECTION_MODES.AUTO }
  })
  const [activeConnection, setActiveConnection] = useState(null) // 'supabase' | 'websocket'
  const supabaseChannelRef = useRef(null)
  const fileInputRef = useRef(null)

  // Wake lock refs and state
  const wakeLockRef = useRef(null)
  const noSleepVideoRef = useRef(null)
  const [wakeLockActive, setWakeLockActive] = useState(false)

  // Test mode state
  const [testModeClicks, setTestModeClicks] = useState(0)
  const testModeTimeoutRef = useRef(null)

  // Request wake lock to prevent screen from sleeping
  useEffect(() => {
    const enableNoSleep = async () => {
      try {
        if ('wakeLock' in navigator) {
          if (wakeLockRef.current) { try { await wakeLockRef.current.release() } catch (e) {} }
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          console.log('[WakeLock] Screen wake lock acquired (UploadRoster)')
          setWakeLockActive(true)
          wakeLockRef.current.addEventListener('release', () => {
            console.log('[WakeLock] Screen wake lock released (UploadRoster)')
            if (!wakeLockRef.current) {
              setWakeLockActive(false)
            }
          })
        }
      } catch (err) { console.log('[WakeLock] Native wake lock failed:', err.message) }
      try {
        if (!noSleepVideoRef.current) {
          const video = document.createElement('video')
          video.setAttribute('playsinline', '')
          video.setAttribute('loop', '')
          video.setAttribute('muted', '')
          video.style.cssText = 'position:fixed;left:-1px;top:-1px;width:1px;height:1px;opacity:0.01;pointer-events:none;'
          video.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAAhmcmVlAAAACG1kYXQAAAAfAgAABQAJJMAAkMAAKQAAH0AAOMAAH0AAOAAAAB9GABtB'
          document.body.appendChild(video)
          noSleepVideoRef.current = video
        }
        await noSleepVideoRef.current.play()
        console.log('[NoSleep] Video playing for keep-awake (UploadRoster)')
      } catch (err) { console.log('[NoSleep] Video fallback failed:', err.message) }
    }
    const handleInteraction = async () => { await enableNoSleep() }
    enableNoSleep()
    document.addEventListener('click', handleInteraction, { once: true })
    document.addEventListener('touchstart', handleInteraction, { once: true })
    const handleVisibilityChange = async () => { if (document.visibilityState === 'visible') await enableNoSleep() }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      document.removeEventListener('click', handleInteraction)
      document.removeEventListener('touchstart', handleInteraction)
      if (wakeLockRef.current) { wakeLockRef.current.release().catch(() => {}); wakeLockRef.current = null }
      if (noSleepVideoRef.current) { noSleepVideoRef.current.pause(); noSleepVideoRef.current.remove(); noSleepVideoRef.current = null }
    }
  }, [])

  // Toggle wake lock manually
  const toggleWakeLock = useCallback(async () => {
    if (wakeLockActive) {
      // Disable wake lock
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release()
          wakeLockRef.current = null
        } catch (e) {}
      }
      if (noSleepVideoRef.current) {
        noSleepVideoRef.current.pause()
      }
      setWakeLockActive(false)
      console.log('[WakeLock] Manually disabled')
    } else {
      // Enable wake lock
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          setWakeLockActive(true)
          console.log('[WakeLock] Manually enabled')
        }
        if (noSleepVideoRef.current) {
          await noSleepVideoRef.current.play()
        }
      } catch (err) {
        console.log('[WakeLock] Failed to enable:', err.message)
        setWakeLockActive(true) // Visual feedback even if API failed
      }
    }
  }, [wakeLockActive])

  // Load available matches on mount and periodically
  useEffect(() => {
    const loadMatches = async () => {
      setLoadingMatches(true)
      try {
        // Try Supabase first if in AUTO or SUPABASE mode
        const useSupabase = connectionMode === CONNECTION_MODES.SUPABASE ||
          (connectionMode === CONNECTION_MODES.AUTO && supabase)

        if (useSupabase && supabase) {
          console.log('[Roster] Loading matches from Supabase')
          const result = await listAvailableMatchesSupabase()
          if (result.success && result.matches && result.matches.length > 0) {
            setAvailableMatches(result.matches)
            setConnectionStatuses(prev => ({ ...prev, supabase: 'connected' }))
            setActiveConnection('supabase')
            setLoadingMatches(false)
            return
          }
        }

        // Fall back to WebSocket/server
        console.log('[Roster] Loading matches from server')
        const result = await listAvailableMatches()
        if (result.success && result.matches) {
          setAvailableMatches(result.matches)
          setActiveConnection('websocket')
        }
      } catch (err) {
        console.error('Error loading matches:', err)
      } finally {
        setLoadingMatches(false)
      }
    }

    loadMatches()
    const interval = setInterval(loadMatches, 30000)

    return () => clearInterval(interval)
  }, [connectionMode])

  // Check connection status periodically
  useEffect(() => {
    // Check if we're on a static deployment (GitHub Pages, Cloudflare Pages, etc.)
    const isStaticDeployment = !import.meta.env.DEV && (
      window.location.hostname.includes('github.io') ||
      window.location.hostname === 'app.openvolley.app'
    )
    const hasBackendUrl = !!import.meta.env.VITE_BACKEND_URL

    // For static deployments without backend, show helpful message
    if (isStaticDeployment && !hasBackendUrl) {
      setConnectionStatuses({
        server: 'not_available',
        websocket: 'not_available'
      })
      return // Don't start polling
    }

    const checkConnections = async () => {
      try {
        const serverStatus = await getServerStatus()
        const wsStatus = matchId ? getWebSocketStatus(matchId) : 'not_applicable'

        setConnectionStatuses(prev => ({
          ...prev, // Preserve supabase status
          server: serverStatus?.running ? 'connected' : 'disconnected',
          websocket: wsStatus
        }))
      } catch (err) {
        setConnectionStatuses(prev => ({
          ...prev, // Preserve supabase status
          server: 'disconnected',
          websocket: 'not_applicable'
        }))
      }
    }

    checkConnections()
    const interval = setInterval(checkConnections, 5000)

    return () => clearInterval(interval)
  }, [matchId])

  // Handle match selection
  const handleMatchSelect = async (match) => {
    console.log('[UploadRoster] Match selected:', match)
    setSelectedMatch(match)
    setGameNumber(String(match.gameNumber || match.id))

    // Check match status directly from the match object (already from Supabase)
    setMatchStatusCheck('checking')

    // Check if match is finished
    if (match.status === 'final' || match.status === 'finished') {
      setMatchStatusCheck('invalid')
      setValidationError('This match has already ended')
      return
    }

    // Check if match has started (status is 'live' means it's in progress)
    if (match.status === 'live') {
      // For live matches, roster upload is still allowed until coin toss is confirmed
      // We'll allow it but warn the user
      console.log('[UploadRoster] Match is live, checking if roster can still be uploaded')
    }

    // Match is valid for roster upload (status is 'setup' or early 'live')
    setMatchStatusCheck('valid')
    setMatch(match)
    setMatchId(match.id)

    // Use team data from the match object
    if (match.homeTeamName) {
      setHomeTeam({ name: match.homeTeamName })
    }
    if (match.awayTeamName) {
      setAwayTeam({ name: match.awayTeamName })
    }
    setValidationError('')
  }

  // Handle back to game selection
  const handleBackToGames = () => {
    setSelectedMatch(null)
    setGameNumber('')
    setTeam('home')
    setUploadPin('')
    setMatch(null)
    setMatchId(null)
    setHomeTeam(null)
    setAwayTeam(null)
    setValidationError('')
    setMatchStatusCheck(null)
  }

  // Check if match exists and is in setup (not started or finished)
  const checkMatchStatus = async (gameNum) => {
    if (!gameNum || !gameNum.trim()) {
      setMatchStatusCheck(null)
      setMatch(null)
      setMatchId(null)
      setValidationError('')
      return
    }

    setMatchStatusCheck('checking')
    
    try {
      // Find match from server
      const foundMatch = await findMatchByGameNumber(gameNum.trim())
      
      if (!foundMatch) {
        setMatchStatusCheck('invalid')
        setMatch(null)
        setMatchId(null)
        setValidationError('Match not found with this game number. Make sure the main scoresheet is running.')
        return
      }

      // Get full match data to check sets and events
      const matchData = await getMatchData(foundMatch.id)
      if (!matchData.success) {
        setMatchStatusCheck('invalid')
        setMatch(null)
        setMatchId(null)
        setValidationError('Failed to load match data')
        return
      }

      const sets = matchData.sets || []
      const events = matchData.events || []
      
      // Check if match is finished
      const isFinished = foundMatch.status === 'final' || (sets.length > 0 && sets.every(s => s.finished))
      
      // Check if match has started (has active sets or events)
      const hasActiveSet = sets.some(set => {
        return Boolean(
          set.finished ||
          set.startTime ||
          set.homePoints > 0 ||
          set.awayPoints > 0
        )
      })
      
      const hasEventActivity = events.some(event =>
        ['set_start', 'rally_start', 'point'].includes(event.type)
      )

      if (isFinished) {
        setMatchStatusCheck('invalid')
        setMatch(null)
        setMatchId(null)
        setValidationError('This match has already ended')
        return
      }

      if (hasActiveSet || hasEventActivity) {
        setMatchStatusCheck('invalid')
        setMatch(null)
        setMatchId(null)
        setValidationError('This match has already started. Roster cannot be uploaded.')
        return
      }

      // Match is valid for roster upload
      setMatchStatusCheck('valid')
      setMatch(foundMatch)
      setMatchId(foundMatch.id)
      
      // Set teams from match data
      if (matchData.homeTeam) setHomeTeam(matchData.homeTeam)
      if (matchData.awayTeam) setAwayTeam(matchData.awayTeam)
      
      setValidationError('')
    } catch (error) {
      console.error('Error checking match status:', error)
      setMatchStatusCheck('invalid')
      setMatch(null)
      setMatchId(null)
      setValidationError('Error checking match status. Make sure the main scoresheet is running.')
    }
  }

  // Check match status when game number changes (with debounce)
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (gameNumber) {
        checkMatchStatus(gameNumber)
      } else {
        setMatchStatusCheck(null)
        setMatch(null)
        setMatchId(null)
        setValidationError('')
      }
    }, 500) // 500ms debounce

    return () => clearTimeout(timeoutId)
  }, [gameNumber])

  // Auto-validate PIN when it changes
  useEffect(() => {
    if (!match || !uploadPin || uploadPin.length !== 6) {
      if (uploadPin && uploadPin.length === 6 && match) {
        const correctPin = team === 'home' ? match.homeTeamUploadPin : match.awayTeamUploadPin
        if (correctPin && uploadPin !== correctPin) {
          setValidationError('Invalid upload PIN')
        } else if (correctPin && uploadPin === correctPin) {
          setValidationError('')
        }
      } else {
        setValidationError('')
      }
      return
    }

    const correctPin = team === 'home' ? match.homeTeamUploadPin : match.awayTeamUploadPin
    if (correctPin && uploadPin === correctPin) {
      setValidationError('')
    } else if (correctPin) {
      setValidationError('Invalid upload PIN')
    }
  }, [uploadPin, match, team])

  // Load teams when match is found (already loaded in checkMatchStatus)

  // Validate inputs
  const validateInputs = async () => {
    setValidationError('')
    
    if (!gameNumber.trim()) {
      setValidationError('Please enter a game number')
      return false
    }

    try {
      const foundMatch = await findMatchByGameNumber(gameNumber.trim())
      if (!foundMatch) {
        setValidationError('Match not found with this game number')
        return false
      }

      setMatch(foundMatch)
      setMatchId(foundMatch.id)

      const correctPin = team === 'home' ? foundMatch.homeTeamUploadPin : foundMatch.awayTeamUploadPin
      if (!uploadPin.trim()) {
        setValidationError('Please enter an upload PIN')
        return false
      }

      if (!correctPin || uploadPin.trim() !== correctPin) {
        setValidationError('Invalid upload PIN')
        return false
      }

      return true
    } catch (error) {
      setValidationError('Error validating inputs. Make sure the main scoresheet is running.')
      return false
    }
  }

  // Handle file selection
  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (file && file.type === 'application/pdf') {
      setPdfFile(file)
      setPdfError('')
      setParsedData(null)
    } else {
      setPdfError('Please select a valid PDF file')
      setPdfFile(null)
    }
  }

  // Handle PDF upload and parse
  const handleUpload = async () => {
    if (!pdfFile || !matchId) return

    setPdfLoading(true)
    setPdfError('')
    setParsedData(null)

    try {
      const data = await parseRosterPdf(pdfFile)

      // Prepare roster data
      const players = data.players.map(p => ({
        number: p.number || null,
        firstName: p.firstName || '',
        lastName: p.lastName || '',
        dob: p.dob || '',
        libero: '',
        isCaptain: false
      }))

      // Prepare bench officials
      const bench = []
      if (data.coach) {
        bench.push({
          role: 'Coach',
          firstName: data.coach.firstName || '',
          lastName: data.coach.lastName || '',
          dob: data.coach.dob || ''
        })
      }
      if (data.ac1) {
        bench.push({
          role: 'Assistant Coach 1',
          firstName: data.ac1.firstName || '',
          lastName: data.ac1.lastName || '',
          dob: data.ac1.dob || ''
        })
      }
      if (data.ac2) {
        bench.push({
          role: 'Assistant Coach 2',
          firstName: data.ac2.firstName || '',
          lastName: data.ac2.lastName || '',
          dob: data.ac2.dob || ''
        })
      }

      setParsedData({ players, bench })
      setPdfFile(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (err) {
      console.error('Error parsing PDF:', err)
      setPdfError(`Failed to parse PDF: ${err.message}`)
    } finally {
      setPdfLoading(false)
    }
  }

  // Handle player edit
  const handlePlayerChange = (index, field, value) => {
    if (!parsedData) return
    const updatedPlayers = [...parsedData.players]
    updatedPlayers[index] = { ...updatedPlayers[index], [field]: value }
    setParsedData({ ...parsedData, players: updatedPlayers })
  }

  // Handle bench official edit
  const handleBenchChange = (index, field, value) => {
    if (!parsedData) return
    const updatedBench = [...parsedData.bench]
    updatedBench[index] = { ...updatedBench[index], [field]: value }
    setParsedData({ ...parsedData, bench: updatedBench })
  }

  // Add player
  const handleAddPlayer = () => {
    if (!parsedData) return
    const newPlayer = {
      number: null,
      firstName: '',
      lastName: '',
      dob: '',
      libero: '',
      isCaptain: false
    }
    setParsedData({ ...parsedData, players: [...parsedData.players, newPlayer] })
  }

  // Delete player
  const handleDeletePlayer = (index) => {
    if (!parsedData) return
    const updatedPlayers = parsedData.players.filter((_, i) => i !== index)
    setParsedData({ ...parsedData, players: updatedPlayers })
  }

  // Add bench official
  const handleAddBench = () => {
    if (!parsedData) return
    const newBench = {
      role: 'Coach',
      firstName: '',
      lastName: '',
      dob: ''
    }
    setParsedData({ ...parsedData, bench: [...parsedData.bench, newBench] })
  }

  // Delete bench official
  const handleDeleteBench = (index) => {
    if (!parsedData) return
    const updatedBench = parsedData.bench.filter((_, i) => i !== index)
    setParsedData({ ...parsedData, bench: updatedBench })
  }

  // Handle confirm
  const handleConfirm = () => {
    if (!parsedData || !matchId) return
    setShowConfirmModal(true)
  }

  // Handle final confirmation - store in match and clear form
  const handleFinalConfirm = async () => {
    if (!parsedData || !matchId || uploading) return

    setUploading(true)
    try {
      // Store pending roster in match
      const pendingField = team === 'home' ? 'pending_home_roster' : 'pending_away_roster'
      const rosterData = {
        players: parsedData.players,
        bench: parsedData.bench,
        coachSignature: coachSignature || null,
        captainSignature: captainSignature || null,
        timestamp: new Date().toISOString()
      }

      // Try Supabase first if connected
      if (activeConnection === 'supabase' && supabase && selectedMatch?.external_id) {
        console.log('[Roster] Writing roster to Supabase for match:', selectedMatch.external_id)

        // Build update object with pending roster and signatures
        const coachSigKey = team === 'home' ? 'home_coach_signature' : 'away_coach_signature'
        const captainSigKey = team === 'home' ? 'home_captain_signature' : 'away_captain_signature'

        const supabaseUpdate = {
          [pendingField]: rosterData
        }

        // Also save signatures directly to main signature columns
        if (coachSignature) {
          supabaseUpdate[coachSigKey] = coachSignature
        }
        if (captainSignature) {
          supabaseUpdate[captainSigKey] = captainSignature
        }

        const { error } = await supabase
          .from('matches')
          .update(supabaseUpdate)
          .eq('external_id', selectedMatch.external_id)

        if (error) {
          console.error('[Roster] Supabase write error:', error)
          // Fall back to server
        } else {
          console.log('[Roster] Successfully wrote roster to Supabase with signatures:', { coachSigKey, captainSigKey })
        }
      }

      // Also try to update via server (for local sync and WebSocket updates)
      // This is optional - if Supabase worked, we still show success
      try {
        const serverPendingField = team === 'home' ? 'pendingHomeRoster' : 'pendingAwayRoster'
        await updateMatchData(matchId, {
          [serverPendingField]: rosterData
        })
        console.log('[Roster] Server update also succeeded')
      } catch (serverError) {
        console.warn('[Roster] Server update failed (non-blocking):', serverError)
        // Don't fail - Supabase already has the data
      }

      // Close confirm modal and show success modal
      setShowConfirmModal(false)
      setShowSuccessModal(true)
    } catch (error) {
      console.error('Error saving pending roster:', error)
      setShowConfirmModal(false)
      setValidationError('Failed to save roster. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  // Handle closing success modal and resetting form
  const handleSuccessClose = () => {
    setShowSuccessModal(false)

    // Clear all form data
    setGameNumber('')
    setTeam('home')
    setUploadPin('')
    setMatch(null)
    setMatchId(null)
    setHomeTeam(null)
    setAwayTeam(null)
    setValidationError('')
    setPdfFile(null)
    setPdfError('')
    setParsedData(null)
    setMatchStatusCheck(null)
    setSelectedMatch(null)

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const isValid = match && matchId && uploadPin && (team === 'home' ? match.homeTeamUploadPin : match.awayTeamUploadPin) === uploadPin

  // Handle connection mode change
  const handleConnectionModeChange = useCallback((mode) => {
    setConnectionMode(mode)
    try {
      localStorage.setItem('roster_connection_mode', mode)
    } catch (e) {
      console.warn('[Roster] Failed to save connection mode:', e)
    }
    // Force reconnection by clearing states
    if (supabaseChannelRef.current) {
      supabase?.removeChannel(supabaseChannelRef.current)
      supabaseChannelRef.current = null
    }
    setActiveConnection(null)
  }, [])

  // Handle test mode activation (6 clicks on "No active games found")
  const handleTestModeClick = useCallback(() => {
    if (testModeTimeoutRef.current) {
      clearTimeout(testModeTimeoutRef.current)
    }

    setTestModeClicks(prev => {
      const newCount = prev + 1
      if (newCount >= 6) {
        // Activate test mode with mock data
        const testMatch = {
          id: -1,
          gameNumber: 999,
          status: 'setup',
          homeTeamName: 'Test Home',
          awayTeamName: 'Test Away',
          homeTeamUploadPin: '123456',
          awayTeamUploadPin: '654321'
        }
        setSelectedMatch(testMatch)
        setGameNumber('999')
        setMatch(testMatch)
        setMatchId(-1)
        setHomeTeam({ name: 'Test Home', color: '#ef4444' })
        setAwayTeam({ name: 'Test Away', color: '#3b82f6' })
        setMatchStatusCheck('valid')
        setValidationError('')
        console.log('[Test Mode] Activated with mock data')
        return 0
      }
      return newCount
    })

    testModeTimeoutRef.current = setTimeout(() => {
      setTestModeClicks(0)
    }, 2000)
  }, [])

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      width: 'auto'
    }}>
      <UpdateBanner />

      <SimpleHeader
        title={t('uploadRoster.title')}
        wakeLockActive={wakeLockActive}
        toggleWakeLock={toggleWakeLock}
        connectionStatuses={connectionStatuses}
        connectionDebugInfo={connectionDebugInfo}
        connectionMode={connectionMode}
        activeConnection={activeConnection}
        onConnectionModeChange={handleConnectionModeChange}
        showConnectionOptions={true}
      />

      <div style={{
        flex: 1,
        padding: '20px'
      }}>
      <div style={{
        margin: '0 auto',
        background: 'var(--bg-secondary)',
        borderRadius: '12px',
        padding: '40px',
      width: 'auto'
      }}>
        <h1 style={{ fontSize: '28px', fontWeight: 700, marginBottom: '32px', textAlign: 'center' }}>
          {t('uploadRoster.title')}
        </h1>

        {/* Game Selection - Step 1 */}
        {!parsedData && !selectedMatch && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            marginBottom: '32px',
            alignItems: 'center',
            maxWidth: '100%',
            width: 'auto'
          }}>
            <p style={{
              fontSize: '16px',
              color: 'rgba(255, 255, 255, 0.7)',
              marginBottom: '16px',
              textAlign: 'center'
            }}>
              {t('uploadRoster.selectGame')}
            </p>

            {loadingMatches ? (
              <div style={{
                padding: '20px',
                color: 'rgba(255, 255, 255, 0.7)',
                fontSize: '16px'
              }}>
                {t('uploadRoster.loadingGames')}
              </div>
            ) : availableMatches.length > 0 ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                width: '100%',
                maxWidth: '400px'
              }}>
                {availableMatches.map((match) => (
                  <button
                    key={match.id}
                    onClick={() => handleMatchSelect(match)}
                    style={{
                      padding: '16px 20px',
                      background: 'rgba(255, 255, 255, 0.1)',
                      border: '2px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '12px',
                      color: '#fff',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      textAlign: 'left'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
                    }}
                  >
                    <div style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: 'var(--accent)',
                      marginBottom: '4px'
                    }}>
                      {t('uploadRoster.game')} {match.gameNumber || match.id}
                    </div>
                    <div style={{
                      fontSize: '16px',
                      fontWeight: 500
                    }}>
                      {match.homeTeamName || t('common.home')} {t('uploadRoster.vs')} {match.awayTeamName || t('common.away')}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div
                onClick={handleTestModeClick}
                style={{
                  padding: '20px',
                  color: 'rgba(255, 255, 255, 0.5)',
                  fontSize: '14px',
                  textAlign: 'center',
                  cursor: 'default',
                  userSelect: 'none'
                }}
              >
                {t('uploadRoster.noActiveGames')}
              </div>
            )}
          </div>
        )}

        {/* Team and PIN Selection - Step 2 */}
        {!parsedData && selectedMatch && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
              marginBottom: '32px',
              alignItems: 'center',
              maxWidth: '100%',
              width: 'auto'
            }}
          >
            <button
              onClick={handleBackToGames}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                background: 'rgba(255, 255, 255, 0.1)',
                color: 'var(--text)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                cursor: 'pointer',
                alignSelf: 'flex-start'
              }}
            >
              ← {t('uploadRoster.changeGame')}
            </button>

            <div style={{
              padding: '16px 24px',
              background: 'rgba(255, 255, 255, 0.05)',
              borderRadius: '8px',
              textAlign: 'center',
              marginBottom: '8px'
            }}>
              <div style={{ fontSize: '14px', color: 'var(--accent)', marginBottom: '4px' }}>
                {t('uploadRoster.game')} {selectedMatch.gameNumber || selectedMatch.id}
              </div>
              <div style={{ fontSize: '18px', fontWeight: 600 }}>
                {homeTeam?.name || t('common.home')} {t('uploadRoster.vs')} {awayTeam?.name || t('common.away')}
              </div>
            </div>

            {matchStatusCheck === 'checking' && (
              <p style={{ color: 'var(--accent)', fontSize: '14px', margin: 0, textAlign: 'center' }}>
                {t('uploadRoster.validating')}
              </p>
            )}

            {matchStatusCheck === 'invalid' && validationError && (
              <p style={{ color: '#ef4444', fontSize: '14px', margin: 0, textAlign: 'center', maxWidth: '300px' }}>
                {validationError}
              </p>
            )}

            {matchStatusCheck === 'valid' && (
              <>
                <div style={{ width: 320, maxWidth: '100%' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 600, textAlign: 'center' }}>
                    {t('uploadRoster.selectTeam')}
                  </label>
                  <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                    <button
                      type="button"
                      onClick={() => {
                        setTeam('home')
                        setValidationError('')
                        setUploadPin('')
                      }}
                      style={{
                        flex: 1,
                        padding: '12px',
                        fontSize: '16px',
                        fontWeight: 600,
                        background: team === 'home' ? 'var(--accent)' : 'rgba(255, 255, 255, 0.1)',
                        color: team === 'home' ? '#000' : 'var(--text)',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        width: 'auto',
                      }}
                    >
                      {t('uploadRoster.home')} {homeTeam?.name && `(${homeTeam.name})`}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTeam('away')
                        setValidationError('')
                        setUploadPin('')
                      }}
                      style={{
                        flex: 1,
                        padding: '12px',
                        fontSize: '16px',
                        fontWeight: 600,
                        background: team === 'away' ? 'var(--accent)' : 'rgba(255, 255, 255, 0.1)',
                        color: team === 'away' ? '#000' : 'var(--text)',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        width: 'auto',
                      }}
                    >
                      {t('uploadRoster.away')} {awayTeam?.name && `(${awayTeam.name})`}
                    </button>
                  </div>
                </div>

                <div style={{ width: 320, maxWidth: '100%' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 600, textAlign: 'center' }}>
                    {t('uploadRoster.uploadPin')}
                  </label>
                  <input
                    type="text"
                    value={uploadPin}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '').slice(0, 6)
                      setUploadPin(val)
                    }}
                    placeholder={t('uploadRoster.enterPin')}
                    style={{
                      width: '100%',
                      padding: '12px',
                      fontSize: '18px',
                      fontFamily: 'monospace',
                      textAlign: 'center',
                      background: 'rgba(255, 255, 255, 0.1)',
                      border: isValid
                        ? '1px solid #10b981'
                        : validationError && uploadPin.length === 6
                        ? '1px solid #ef4444'
                        : '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '6px',
                      color: 'var(--text)'
                    }}
                    maxLength={6}
                  />
                  {isValid && (
                    <p style={{ color: '#10b981', fontSize: '12px', margin: '4px 0 0 0', textAlign: 'center' }}>
                      ✓ {t('uploadRoster.validate')}
                    </p>
                  )}
                </div>

                {validationError && uploadPin.length === 6 && (
                  <p style={{ color: '#ef4444', fontSize: '14px', margin: 0, textAlign: 'center', width: 320, maxWidth: '100%' }}>
                    {validationError}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* Upload Section */}
        {isValid && !parsedData && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '32px', alignItems: 'center' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={pdfLoading}
              style={{
                padding: '12px 24px',
                fontSize: '16px',
                fontWeight: 600,
                background: 'rgba(255, 255, 255, 0.1)',
                color: 'var(--text)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                cursor: pdfLoading ? 'not-allowed' : 'pointer'
              }}
            >
              {t('uploadRoster.selectPdfFile')}
            </button>

            {pdfFile && (
              <>
                <div style={{
                  padding: '12px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  borderRadius: '6px',
                  fontSize: '14px',
                  textAlign: 'center'
                }}>
                  Selected: {pdfFile.name}
                </div>
                <button
                  type="button"
                  onClick={handleUpload}
                  disabled={pdfLoading}
                  style={{
                    padding: '12px 24px',
                    fontSize: '16px',
                    fontWeight: 600,
                    background: 'var(--accent)',
                    color: '#000',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: pdfLoading ? 'not-allowed' : 'pointer'
                  }}
                >
                  {pdfLoading ? t('uploadRoster.parsing') : t('uploadRoster.confirm')}
                </button>
              </>
            )}

            {pdfLoading && (
              <p style={{ fontSize: '14px', color: 'var(--accent)', margin: 0, textAlign: 'center' }}>
                {t('uploadRoster.parsing')}
              </p>
            )}

            {pdfError && (
              <p style={{ fontSize: '14px', color: '#ef4444', margin: 0, textAlign: 'center' }}>
                {pdfError}
              </p>
            )}
          </div>
        )}

        {/* Editable Roster */}
        {parsedData && (
          <div style={{ marginBottom: '32px', maxWidth: '60%', margin: '0 auto' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '20px' }}>{t('uploadRoster.parsedPlayers')}</h2>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
              {parsedData.players.map((player, index) => (
                <div key={index} style={{
                  padding: '16px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  borderRadius: '8px',
                  display: 'grid',
                  gridTemplateColumns: 'auto auto auto auto auto auto auto',
                  gap: '20px',
                  alignItems: 'center'
                }}>
                  <input
                    type="number"
                    value={player.number || ''}
                    onChange={(e) => handlePlayerChange(index, 'number', e.target.value ? Number(e.target.value) : null)}
                    placeholder="#"
                    style={{
                      padding: '8px',
                      fontSize: '14px',
                      background: 'rgba(26, 26, 46, 0.95)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)',
                      width: '20px',
                      textAlign: 'center'
                    }}
                  />
                  <input
                    type="text"
                    value={player.lastName}
                    onChange={(e) => handlePlayerChange(index, 'lastName', e.target.value)}
                    placeholder="Last Name"
                    style={{
                      padding: '8px',
                      fontSize: '14px',
                      background: 'rgba(26, 26, 46, 0.95)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)',
                      width: 'auto'
                    }}
                  />
                  <input
                    type="text"
                    value={player.firstName}
                    onChange={(e) => handlePlayerChange(index, 'firstName', e.target.value)}
                    placeholder="First Name"
                    style={{
                      padding: '8px',
                      fontSize: '14px',
                      background: 'rgba(26, 26, 46, 0.95)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)',
                      width: 'auto'
                    }}
                  />
                  <input
                    type="date"
                    value={player.dob ? formatDateToISO(player.dob) : ''}
                    onChange={(e) => handlePlayerChange(index, 'dob', e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')}
                    style={{
                      padding: '8px',
                      fontSize: '14px',
                      background: 'rgba(26, 26, 46, 0.95)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)',
                      width: 'auto'
                    }}
                  />
                  <select
                    value={player.libero}
                    onChange={(e) => handlePlayerChange(index, 'libero', e.target.value)}
                    style={{
                      padding: '8px',
                      fontSize: '14px',
                      background: 'rgba(26, 26, 46, 0.95)',  // much darker background
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)'
                    }}
                  >
                    <option value=""></option>
                    <option value="libero1">Libero 1</option>
                    <option value="libero2">Libero 2</option>
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      checked={player.isCaptain}
                      onChange={(e) => handlePlayerChange(index, 'isCaptain', e.target.checked)}
                    />
                    <span style={{ fontSize: '14px' }}>Captain</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => handleDeletePlayer(index)}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      background: '#ef4444',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={handleAddPlayer}
              style={{
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: 600,
                background: 'rgba(255, 255, 255, 0.1)',
                color: 'var(--text)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                cursor: 'pointer',
                marginBottom: '24px'
              }}
            >
              {t('roster.addPlayer')}
            </button>

            <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '20px' }}>{t('uploadRoster.parsedBench')}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>

              {parsedData.bench.map((official, index) => (
                <div key={index} style={{
                  padding: '16px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  borderRadius: '8px',
                  display: 'grid',
                  gridTemplateColumns: 'auto auto auto auto auto',
                  gap: '20px',
                  alignItems: 'center'
                }}>
                  <select
                    value={official.role}
                    onChange={(e) => handleBenchChange(index, 'role', e.target.value)}
                    style={{
                      padding: '8px',
                      fontSize: '14px',
                      background: 'rgba(26, 26, 46, 0.95)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)',
                      width: 'auto'
                    }}
                  >
                    <option value="Coach">Coach</option>
                    <option value="Assistant Coach 1">Assistant Coach 1</option>
                    <option value="Assistant Coach 2">Assistant Coach 2</option>
                    <option value="Physiotherapist">Physiotherapist</option>
                    <option value="Medic">Medic</option>
                  </select>
                  <input
                    type="text"
                    value={official.lastName}
                    onChange={(e) => handleBenchChange(index, 'lastName', e.target.value)}
                    placeholder="Last Name"
                    style={{
                      padding: '8px',
                      fontSize: '14px',
                      background: 'rgba(26, 26, 46, 0.95)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)',
                      width: 'auto'
                    }}
                  />
                  <input
                    type="text"
                    value={official.firstName}
                    onChange={(e) => handleBenchChange(index, 'firstName', e.target.value)}
                    placeholder="First Name"
                    style={{
                      padding: '8px',
                      fontSize: '14px',
                      background: 'rgba(26, 26, 46, 0.95)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)',
                      width: 'auto'
                    }}
                  />
                  <input
                    type="date"
                    value={official.dob ? formatDateToISO(official.dob) : ''}
                    onChange={(e) => handleBenchChange(index, 'dob', e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')}
                    style={{
                      padding: '8px',
                      fontSize: '14px',
                      background: 'rgba(26, 26, 46, 0.95)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)',
                      width: 'auto'
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => handleDeleteBench(index)}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      background: '#ef4444',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={handleAddBench}
              style={{
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: 600,
                background: 'rgba(255, 255, 255, 0.1)',
                color: 'var(--text)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                cursor: 'pointer',
                marginBottom: '24px'
              }}
            >
              + {t('roster.benchOfficials')}
            </button>

            {/* Signatures Section */}
            <div style={{
              marginTop: '32px',
              padding: '20px',
              background: 'rgba(255,255,255,0.05)',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.1)'
            }}>
              <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>
                {t('rosterSetup.signatures', 'Signatures')}
              </h2>
              <p style={{ fontSize: '14px', color: 'var(--muted)', marginBottom: '20px' }}>
                {t('rosterSetup.signaturesDescription', 'Optional: Coach and captain can sign the roster before submitting.')}
              </p>
              <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                {/* Coach Signature */}
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                    {t('rosterSetup.coachSignature', 'Coach Signature')}
                  </div>
                  <div
                    onClick={() => setOpenSignature('coach')}
                    style={{
                      width: '100%',
                      height: '100px',
                      background: coachSignature ? 'white' : 'rgba(255,255,255,0.05)',
                      border: coachSignature ? '2px solid #22c55e' : '2px dashed rgba(255,255,255,0.3)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden'
                    }}
                  >
                    {coachSignature ? (
                      <img src={coachSignature} alt="Coach signature" style={{ maxWidth: '100%', maxHeight: '100%' }} />
                    ) : (
                      <span style={{ color: 'var(--muted)', fontSize: '13px' }}>
                        {t('rosterSetup.tapToSign', 'Tap to sign')}
                      </span>
                    )}
                  </div>
                  {coachSignature && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setCoachSignature(null); }}
                      style={{
                        marginTop: '8px',
                        padding: '4px 12px',
                        fontSize: '12px',
                        background: 'rgba(239, 68, 68, 0.2)',
                        color: '#ef4444',
                        border: '1px solid #ef4444',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      {t('common.clear', 'Clear')}
                    </button>
                  )}
                </div>

                {/* Captain Signature */}
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>
                    {t('rosterSetup.captainSignature', 'Captain Signature')}
                  </div>
                  <div
                    onClick={() => setOpenSignature('captain')}
                    style={{
                      width: '100%',
                      height: '100px',
                      background: captainSignature ? 'white' : 'rgba(255,255,255,0.05)',
                      border: captainSignature ? '2px solid #22c55e' : '2px dashed rgba(255,255,255,0.3)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden'
                    }}
                  >
                    {captainSignature ? (
                      <img src={captainSignature} alt="Captain signature" style={{ maxWidth: '100%', maxHeight: '100%' }} />
                    ) : (
                      <span style={{ color: 'var(--muted)', fontSize: '13px' }}>
                        {t('rosterSetup.tapToSign', 'Tap to sign')}
                      </span>
                    )}
                  </div>
                  {captainSignature && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setCaptainSignature(null); }}
                      style={{
                        marginTop: '8px',
                        padding: '4px 12px',
                        fontSize: '12px',
                        background: 'rgba(239, 68, 68, 0.2)',
                        color: '#ef4444',
                        border: '1px solid #ef4444',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      {t('common.clear', 'Clear')}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '32px' }}>
              <button
                type="button"
                onClick={handleConfirm}
                style={{
                  padding: '14px 32px',
                  fontSize: '18px',
                  fontWeight: 700,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        )}

        {/* Confirmation Modal */}
        {showConfirmModal && (
          <Modal
            title={uploading ? t('uploadRoster.uploading') : t('uploadRoster.confirmTitle')}
            open={true}
            onClose={() => !uploading && setShowConfirmModal(false)}
            width={400}
          >
            <div style={{ padding: '24px' }}>
              {uploading ? (
                <div style={{ textAlign: 'center' }}>
                  <div style={{
                    width: '48px',
                    height: '48px',
                    border: '4px solid rgba(255,255,255,0.2)',
                    borderTop: '4px solid var(--accent)',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                    margin: '0 auto 16px'
                  }} />
                  <p style={{ fontSize: '16px', color: 'var(--text)' }}>
                    {t('uploadRoster.uploadingMessage')}
                  </p>
                </div>
              ) : (
                <>
                  <p style={{ marginBottom: '24px', fontSize: '16px', textAlign: 'center' }}>
                    {t('uploadRoster.confirmMessage')}
                  </p>
                  <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                    <button
                      onClick={() => setShowConfirmModal(false)}
                      style={{
                        padding: '12px 32px',
                        fontSize: '16px',
                        fontWeight: 600,
                        background: 'rgba(255, 255, 255, 0.1)',
                        color: 'var(--text)',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        borderRadius: '8px',
                        cursor: 'pointer'
                      }}
                    >
                      {t('common.no')}
                    </button>
                    <button
                      onClick={handleFinalConfirm}
                      style={{
                        padding: '12px 32px',
                        fontSize: '16px',
                        fontWeight: 600,
                        background: 'var(--accent)',
                        color: '#000',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: 'pointer'
                      }}
                    >
                      {t('common.yes')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </Modal>
        )}

        {/* Success Modal */}
        {showSuccessModal && (
          <Modal
            title={t('uploadRoster.uploadSuccess')}
            open={true}
            onClose={handleSuccessClose}
            width={400}
          >
            <div style={{ padding: '24px', textAlign: 'center' }}>
              <div style={{
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                background: 'rgba(34, 197, 94, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px',
                fontSize: '32px'
              }}>
                ✓
              </div>
              <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--text)' }}>
                {t('uploadRoster.rosterSentToScoresheet')}
              </p>
              <button
                onClick={handleSuccessClose}
                style={{
                  padding: '12px 32px',
                  fontSize: '16px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                {t('common.ok')}
              </button>
            </div>
          </Modal>
        )}

        {/* Signature Pad */}
        <SignaturePad
          open={openSignature !== null}
          onClose={() => setOpenSignature(null)}
          onSave={(signature) => {
            if (openSignature === 'coach') {
              setCoachSignature(signature)
            } else if (openSignature === 'captain') {
              setCaptainSignature(signature)
            }
            setOpenSignature(null)
          }}
          title={openSignature === 'coach'
            ? t('rosterSetup.coachSignature', 'Coach Signature')
            : t('rosterSetup.captainSignature', 'Captain Signature')}
        />
      </div>
      </div>
    </div>
  )
}