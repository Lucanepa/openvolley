import { useState, useEffect, useRef, useCallback } from 'react'
import { findMatchByGameNumber, getMatchData, updateMatchData, listAvailableMatches, getWebSocketStatus } from './utils/serverDataSync'
import { getServerStatus } from './utils/networkInfo'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import { parseRosterPdf } from './utils/parseRosterPdf'
import Modal from './components/Modal'
import SimpleHeader from './components/SimpleHeader'
import UpdateBanner from './components/UpdateBanner'

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
  const [matchStatusCheck, setMatchStatusCheck] = useState(null) // 'checking', 'valid', 'invalid', null
  const [availableMatches, setAvailableMatches] = useState([])
  const [loadingMatches, setLoadingMatches] = useState(false)
  const [selectedMatch, setSelectedMatch] = useState(null)
  const [connectionStatuses, setConnectionStatuses] = useState({
    server: 'disconnected',
    websocket: 'not_applicable'
  })
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
        const result = await listAvailableMatches()
        if (result.success && result.matches) {
          setAvailableMatches(result.matches)
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
  }, [])

  // Check connection status periodically
  useEffect(() => {
    const checkConnections = async () => {
      try {
        const serverStatus = await getServerStatus()
        const wsStatus = matchId ? getWebSocketStatus(matchId) : 'not_applicable'

        setConnectionStatuses({
          server: serverStatus?.running ? 'connected' : 'disconnected',
          websocket: wsStatus
        })
      } catch (err) {
        setConnectionStatuses({
          server: 'disconnected',
          websocket: 'not_applicable'
        })
      }
    }

    checkConnections()
    const interval = setInterval(checkConnections, 5000)

    return () => clearInterval(interval)
  }, [matchId])

  // Handle match selection
  const handleMatchSelect = async (match) => {
    setSelectedMatch(match)
    setGameNumber(String(match.gameNumber || match.id))

    // Trigger the existing match status check
    setMatchStatusCheck('checking')
    try {
      const matchData = await getMatchData(match.id)
      if (matchData.success) {
        const sets = matchData.sets || []
        const events = matchData.events || []

        // Check if match is finished
        const isFinished = match.status === 'final' || (sets.length > 0 && sets.every(s => s.finished))

        // Check if match has started
        const hasActiveSet = sets.some(set => Boolean(
          set.finished || set.startTime || set.homePoints > 0 || set.awayPoints > 0
        ))
        const hasEventActivity = events.some(event =>
          ['set_start', 'rally_start', 'point'].includes(event.type)
        )

        if (isFinished) {
          setMatchStatusCheck('invalid')
          setValidationError('This match has already ended')
          return
        }

        if (hasActiveSet || hasEventActivity) {
          setMatchStatusCheck('invalid')
          setValidationError('This match has already started. Roster cannot be uploaded.')
          return
        }

        // Match is valid
        setMatchStatusCheck('valid')
        setMatch(match)
        setMatchId(match.id)
        if (matchData.homeTeam) setHomeTeam(matchData.homeTeam)
        if (matchData.awayTeam) setAwayTeam(matchData.awayTeam)
        setValidationError('')
      } else {
        setMatchStatusCheck('invalid')
        setValidationError('Failed to load match data')
      }
    } catch (error) {
      console.error('Error checking match:', error)
      setMatchStatusCheck('invalid')
      setValidationError('Error checking match status')
    }
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
    if (!parsedData || !matchId) return
    
    try {
      // Store pending roster in match via server
      const pendingField = team === 'home' ? 'pendingHomeRoster' : 'pendingAwayRoster'
      await updateMatchData(matchId, {
        [pendingField]: {
          players: parsedData.players,
          bench: parsedData.bench,
          timestamp: new Date().toISOString()
        }
      })
      
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
      setShowConfirmModal(false)
      
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (error) {
      console.error('Error saving pending roster:', error)
      setValidationError('Failed to save roster. Please try again.')
    }
  }

  const isValid = match && matchId && uploadPin && (team === 'home' ? match.homeTeamUploadPin : match.awayTeamUploadPin) === uploadPin

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
        title="Upload Roster"
        wakeLockActive={wakeLockActive}
        toggleWakeLock={toggleWakeLock}
        connectionStatuses={connectionStatuses}
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
          Upload Roster
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
              Select a game to upload roster
            </p>

            {loadingMatches ? (
              <div style={{
                padding: '20px',
                color: 'rgba(255, 255, 255, 0.7)',
                fontSize: '16px'
              }}>
                Loading available games...
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
                      Game {match.gameNumber || match.id}
                    </div>
                    <div style={{
                      fontSize: '16px',
                      fontWeight: 500
                    }}>
                      {match.homeTeamName || 'Home'} vs {match.awayTeamName || 'Away'}
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
                No active games found
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
              ← Back to Games
            </button>

            <div style={{
              padding: '16px 24px',
              background: 'rgba(255, 255, 255, 0.05)',
              borderRadius: '8px',
              textAlign: 'center',
              marginBottom: '8px'
            }}>
              <div style={{ fontSize: '14px', color: 'var(--accent)', marginBottom: '4px' }}>
                Game {selectedMatch.gameNumber || selectedMatch.id}
              </div>
              <div style={{ fontSize: '18px', fontWeight: 600 }}>
                {homeTeam?.name || 'Home'} vs {awayTeam?.name || 'Away'}
              </div>
            </div>

            {matchStatusCheck === 'checking' && (
              <p style={{ color: 'var(--accent)', fontSize: '14px', margin: 0, textAlign: 'center' }}>
                Checking match...
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
                    Team
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
                      Home {homeTeam?.name && `(${homeTeam.name})`}
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
                      Away {awayTeam?.name && `(${awayTeam.name})`}
                    </button>
                  </div>
                </div>

                <div style={{ width: 320, maxWidth: '100%' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 600, textAlign: 'center' }}>
                    Upload PIN
                  </label>
                  <input
                    type="text"
                    value={uploadPin}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '').slice(0, 6)
                      setUploadPin(val)
                    }}
                    placeholder="Enter 6-digit upload PIN"
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
                      ✓ PIN verified
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
              Choose PDF File
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
                  {pdfLoading ? 'Uploading...' : 'Upload & Parse PDF'}
                </button>
              </>
            )}

            {pdfLoading && (
              <p style={{ fontSize: '14px', color: 'var(--accent)', margin: 0, textAlign: 'center' }}>
                Parsing PDF and uploading data...
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
            <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '20px' }}>Players</h2>
            
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
                    Delete
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
              + Add Player
            </button>

            <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '20px' }}>Bench Officials</h2>
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
                    Delete
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
              + Add Bench Official
            </button>

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
                Confirm
              </button>
            </div>
          </div>
        )}

        {/* Confirmation Modal */}
        {showConfirmModal && (
          <Modal
            title="Confirm Roster Upload"
            open={true}
            onClose={() => setShowConfirmModal(false)}
            width={400}
          >
            <div style={{ padding: '24px' }}>
              <p style={{ marginBottom: '24px', fontSize: '16px', textAlign: 'center' }}>
                Upload this roster?
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
                  No
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
                  Yes
                </button>
              </div>
            </div>
          </Modal>
        )}
      </div>
      </div>
    </div>
  )
}