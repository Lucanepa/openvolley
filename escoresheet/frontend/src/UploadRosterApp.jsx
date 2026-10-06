import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { findMatchByGameNumber, getMatchData, updateMatchData, listAvailableMatches, getWebSocketStatus, validateUploadPinSupabase, uploadRosterToCloud } from './utils/serverDataSync'
import { listRosterUploadMatches } from './utils/rosterUploadMatches'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import { parseRosterPdf } from './utils/parseRosterPdf'
import Modal from './components/Modal'
import SimpleHeader from './components/SimpleHeader'
import UpdateBanner from './components/UpdateBanner'
import SignaturePad from './components/SignaturePad'
import { supabase } from './lib/supabaseClient'
import { CalendarX2, Check, ChevronRight, FileUp, Loader2, Plus } from 'lucide-react'
import { cn } from './ui/cn.js'
import { Button } from './ui/Button.jsx'
import { Card } from './ui/Card.jsx'
import { Field, FormError } from './ui/Field.jsx'
import { EmptyState } from './ui/EmptyState.jsx'
import { RowList } from './ui/Row.jsx'
import { SectionHeader } from './ui/SectionHeader.jsx'
import { SkeletonRows } from './ui/Skeleton.jsx'
import { PinInput, ListLabel, GameRow } from './components/dashboards/EntryKit.jsx'

// Roster editor grid (a dense desktop form: h-9 fields are allowed here).
const FIELD = 'h-9 w-full px-2.5 text-sm rounded-lg border border-stone-300 bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-500'
const ROSTER_HEAD = 'grid items-center gap-3 px-1 py-2 text-[11px] font-bold uppercase tracking-wide text-stone-500 border-b border-stone-200'
const ROSTER_ROW = 'grid items-center gap-3 px-1 py-2'

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
  const { t, i18n } = useTranslation()
  const [gameNumber, setGameNumber] = useState('')
  const [team, setTeam] = useState('home') // 'home' or 'away'
  const [uploadPin, setUploadPin] = useState('')
  const [match, setMatch] = useState(null)
  const [matchId, setMatchId] = useState(null)
  const [homeTeam, setHomeTeam] = useState(null)
  const [awayTeam, setAwayTeam] = useState(null)
  const [validationError, setValidationError] = useState('')
  const [saveError, setSaveError] = useState('') // final roster save failed
  const [pdfFile, setPdfFile] = useState(null)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfError, setPdfError] = useState('')
  const [parsedData, setParsedData] = useState(null) // { players: [], bench: [] }
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [showSuccessModal, setShowSuccessModal] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [matchStatusCheck, setMatchStatusCheck] = useState(null) // 'checking', 'valid', 'invalid', null
  const [manuallyValidated, setManuallyValidated] = useState(false) // For when no PIN is required
  // Supabase mode: upload PINs are validated server-side (never sent to client).
  // Fail-closed: upload stays blocked until the server confirms the PIN.
  const [serverPinValidated, setServerPinValidated] = useState(false)

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
      console.log('[Roster DEBUG] ========== LOADING MATCHES ==========')
      console.log('[Roster DEBUG] Connection mode:', connectionMode)
      console.log('[Roster DEBUG] apiFrom available: true')

      try {
        // Try Supabase first if in AUTO or SUPABASE mode
        const useSupabase = connectionMode === CONNECTION_MODES.SUPABASE ||
          connectionMode === CONNECTION_MODES.AUTO

        console.log('[Roster DEBUG] Will try Supabase:', useSupabase)

        if (useSupabase) {
          console.log('[Roster DEBUG] Attempting Supabase connection...')
          try {
            // Matches still in setup (rosters open), not only those with the
            // referee connection on (that comes after the coin toss)
            const result = await listRosterUploadMatches()
            console.log('[Roster DEBUG] Supabase result:', JSON.stringify(result, null, 2))

            if (result.success && result.matches && result.matches.length > 0) {
              console.log('[Roster DEBUG] Supabase SUCCESS - found', result.matches.length, 'matches')
              setAvailableMatches(result.matches)
              setConnectionStatuses(prev => {
                const newStatus = { ...prev, supabase: 'connected' }
                console.log('[Roster DEBUG] New connection statuses:', newStatus)
                return newStatus
              })
              setActiveConnection('supabase')
              setLoadingMatches(false)
              return
            } else {
              console.log('[Roster DEBUG] Supabase returned no matches or failed:', result)
            }
          } catch (supabaseErr) {
            console.error('[Roster DEBUG] Supabase error:', supabaseErr)
            console.error('[Roster DEBUG] Supabase error details:', supabaseErr.message, supabaseErr.stack)
          }
        }

        // Fall back to WebSocket/server
        console.log('[Roster DEBUG] Falling back to WebSocket/server...')
        try {
          const result = await listAvailableMatches()
          console.log('[Roster DEBUG] WebSocket/server result:', JSON.stringify(result, null, 2))

          if (result.success && result.matches) {
            console.log('[Roster DEBUG] WebSocket SUCCESS - found', result.matches.length, 'matches')
            setAvailableMatches(result.matches)
            setActiveConnection('websocket')
          } else {
            console.log('[Roster DEBUG] WebSocket returned no matches or failed')
          }
        } catch (wsErr) {
          console.error('[Roster DEBUG] WebSocket/server error:', wsErr)
          console.error('[Roster DEBUG] WebSocket error details:', wsErr.message, wsErr.stack)
        }
      } catch (err) {
        console.error('[Roster DEBUG] General error loading matches:', err)
        console.error('[Roster DEBUG] Error stack:', err.stack)
      } finally {
        setLoadingMatches(false)
        console.log('[Roster DEBUG] ========== DONE LOADING MATCHES ==========')
      }
    }

    loadMatches()
    const interval = setInterval(loadMatches, 30000)

    return () => clearInterval(interval)
  }, [connectionMode])

  // Check connection status periodically
  useEffect(() => {
    // Check if we're on a static deployment (GitHub Pages, Cloudflare Pages, etc.)
    // Static deployments don't have a backend server - they rely on Supabase only
    const isStaticDeployment = !import.meta.env.DEV && (
      window.location.hostname.includes('github.io') ||
      window.location.hostname.endsWith('.openvolley.app') // All openvolley.app subdomains are static
    )
    const hasBackendUrl = !!import.meta.env.VITE_BACKEND_URL

    console.log('[Roster DEBUG] Connection status check setup:')
    console.log('[Roster DEBUG]   - hostname:', window.location.hostname)
    console.log('[Roster DEBUG]   - isStaticDeployment:', isStaticDeployment)
    console.log('[Roster DEBUG]   - hasBackendUrl:', hasBackendUrl)
    console.log('[Roster DEBUG]   - VITE_BACKEND_URL:', import.meta.env.VITE_BACKEND_URL)
    console.log('[Roster DEBUG]   - DEV mode:', import.meta.env.DEV)
    console.log('[Roster DEBUG]   - connectionMode:', connectionMode)

    // For static deployments without a backend URL, server/WS are not available
    // The Upload Roster app uses Supabase for cloud, but can use WebSocket if backend is configured
    if (isStaticDeployment && !hasBackendUrl) {
      console.log('[Roster DEBUG] Static deployment without backend - server/WS not available')
      setConnectionStatuses(prev => ({
        ...prev, // Preserve supabase status
        server: 'not_available',
        websocket: 'not_available'
      }))
      setConnectionDebugInfo({
        server: {
          status: 'not_available',
          message: 'Server/WebSocket requires backend configuration',
          details: 'This deployment uses Supabase for data sync. Server/WebSocket connections are only available with a configured backend URL or on local network.'
        }
      })
      return // Don't start polling
    }

    // For static deployments WITH backend URL or local dev, check connection based on mode
    // In Supabase mode, we don't need server/WS polling - connection is already tracked in loadMatches
    if (connectionMode === CONNECTION_MODES.SUPABASE) {
      console.log('[Roster DEBUG] Supabase mode - server/WS not needed')
      setConnectionStatuses(prev => ({
        ...prev,
        server: 'not_applicable',
        websocket: 'not_applicable'
      }))
      return
    }

    // For AUTO or WEBSOCKET mode, check server status using listAvailableMatches
    // This is more reliable than getServerStatus() as it tests actual API functionality
    const checkConnections = async () => {
      try {
        console.log('[Roster DEBUG] Checking server status via listAvailableMatches...')
        const result = await listAvailableMatches()
        console.log('[Roster DEBUG] listAvailableMatches result:', result?.success)

        const serverConnected = result?.success
        const wsStatus = matchId ? getWebSocketStatus(matchId) : 'not_applicable'
        console.log('[Roster DEBUG] WebSocket status for matchId', matchId, ':', wsStatus)

        setConnectionStatuses(prev => {
          const newStatus = {
            ...prev, // Preserve supabase status
            server: serverConnected ? 'connected' : 'disconnected',
            websocket: wsStatus
          }
          console.log('[Roster DEBUG] Updated connection statuses:', newStatus)
          return newStatus
        })

        // Build debug info for disconnected services
        if (!serverConnected) {
          setConnectionDebugInfo(prev => ({
            ...prev,
            server: {
              status: 'disconnected',
              message: 'Cannot reach the server API',
              details: 'Make sure the backend server is running and accessible.'
            }
          }))
        }
      } catch (err) {
        console.error('[Roster DEBUG] Error checking connections:', err)
        setConnectionStatuses(prev => ({
          ...prev, // Preserve supabase status
          server: 'disconnected',
          websocket: 'not_applicable'
        }))
        setConnectionDebugInfo(prev => ({
          ...prev,
          server: {
            status: 'error',
            message: 'Failed to check server status',
            details: err.message || 'Network error occurred while checking connection.'
          }
        }))
      }
    }

    checkConnections()
    const interval = setInterval(checkConnections, 10000) // Check every 10s (reduced from 5s)

    return () => clearInterval(interval)
  }, [matchId, connectionMode])

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
    setManuallyValidated(false)
    setServerPinValidated(false)
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
  // Skip if we already have a selectedMatch from Supabase - it's already validated
  useEffect(() => {
    // If we have a selected match from Supabase, don't run server-based validation
    if (selectedMatch && activeConnection === 'supabase') {
      return
    }

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
  }, [gameNumber, selectedMatch, activeConnection])

  // Auto-validate PIN when it changes
  useEffect(() => {
    if (!match) {
      setValidationError('')
      setServerPinValidated(false)
      return
    }

    // Supabase mode: the upload PIN is never sent to the client, so validate it
    // server-side. Fail-closed — serverPinValidated stays false until confirmed.
    if (activeConnection === 'supabase') {
      setServerPinValidated(false)
      if (uploadPin && uploadPin.length === 6) {
        let cancelled = false
        // Bound to the match the roster will be written to
        const matchKey = selectedMatch?.external_id || match?.external_id || null
        if (!matchKey) {
          setValidationError('Select the match first')
          return
        }
        validateUploadPinSupabase(team, uploadPin, matchKey).then(res => {
          if (cancelled) return
          if (res.success) {
            setServerPinValidated(true)
            setValidationError('')
          } else {
            setServerPinValidated(false)
            setValidationError(res.error || 'Invalid upload PIN')
          }
        })
        return () => { cancelled = true }
      }
      setValidationError('')
      return
    }

    // Local / WebSocket mode: the match carries the PIN locally (LAN), compare it.
    const correctPin = team === 'home'
      ? (match.homeTeamUploadPin || match.home_team_upload_pin)
      : (match.awayTeamUploadPin || match.away_team_upload_pin)
    const pinIsRequired = correctPin != null && correctPin !== ''

    // If no PIN is required, clear any errors
    if (!pinIsRequired) {
      setValidationError('')
      return
    }

    // PIN is required - validate it
    if (uploadPin && uploadPin.length === 6) {
      if (uploadPin === correctPin) {
        setValidationError('')
      } else {
        setValidationError('Invalid upload PIN')
      }
    } else {
      setValidationError('')
    }
  }, [uploadPin, match, selectedMatch, team, activeConnection])

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

      // Supabase mode: validate the upload PIN server-side (never sent to client).
      if (activeConnection === 'supabase') {
        if (!uploadPin.trim()) {
          setValidationError('Please enter an upload PIN')
          return false
        }
        const matchKey = selectedMatch?.external_id || foundMatch?.external_id || null
        if (!matchKey) {
          setServerPinValidated(false)
          setValidationError('Select the match first')
          return false
        }
        const res = await validateUploadPinSupabase(team, uploadPin.trim(), matchKey)
        if (!res.success) {
          setServerPinValidated(false)
          setValidationError(res.error || 'Invalid upload PIN')
          return false
        }
        setServerPinValidated(true)
      } else {
      // Local / WebSocket mode: match carries the PIN locally (LAN), compare it.
      const correctPin = team === 'home'
        ? (foundMatch.homeTeamUploadPin || foundMatch.home_team_upload_pin)
        : (foundMatch.awayTeamUploadPin || foundMatch.away_team_upload_pin)
      const pinIsRequired = correctPin != null && correctPin !== ''

      if (pinIsRequired) {
        if (!uploadPin.trim()) {
          setValidationError('Please enter an upload PIN')
          return false
        }

        if (uploadPin.trim() !== correctPin) {
          setValidationError('Invalid upload PIN')
          return false
        }
      }
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
    setSaveError('')
    // Success is only reported if at least one write actually stored the roster
    let saved = false
    let cloudError = null
    try {
      // Store pending roster in match
      const rosterData = {
        players: parsedData.players,
        bench: parsedData.bench,
        coachSignature: coachSignature || null,
        captainSignature: captainSignature || null,
        timestamp: new Date().toISOString()
      }

      // Cloud first if connected: the backend checks the team's upload PIN of
      // this match and stores the pending roster + signatures (no account
      // needed; only the match's scorer may write the match itself).
      if (activeConnection === 'supabase' && selectedMatch?.external_id) {
        console.log('[Roster] Writing roster to the cloud for match:', selectedMatch.external_id)
        const result = await uploadRosterToCloud(selectedMatch.external_id, team, uploadPin, rosterData)
        if (!result.success) {
          console.error('[Roster] Cloud write error:', result.status, result.error)
          cloudError = result
          // Fall back to server
        } else {
          saved = true
          console.log('[Roster] Successfully wrote roster to the cloud')
        }
      }

      // Also try to update via server (for local sync and WebSocket updates)
      // Optional when the cloud write worked; otherwise it is the only copy
      try {
        const serverPendingField = team === 'home' ? 'pendingHomeRoster' : 'pendingAwayRoster'
        await updateMatchData(matchId, {
          [serverPendingField]: rosterData
        })
        saved = true
        console.log('[Roster] Server update also succeeded')
      } catch (serverError) {
        console.warn(`[Roster] Server update failed${saved ? ' (non-blocking, cloud has the roster)' : ''}:`, serverError)
      }

      setShowConfirmModal(false)
      if (!saved) {
        // Nothing stored the roster: say so instead of showing success
        setSaveError(cloudError?.status === 403 || cloudError?.status === 409
          ? `Roster was NOT saved: the cloud rejected the upload (${cloudError.error}). Please give the roster to the scorer.`
          : 'Roster was NOT saved: the scoresheet could not be reached. Please try again or give the roster to the scorer.')
        return
      }

      // Show success modal
      setShowSuccessModal(true)
    } catch (error) {
      console.error('Error saving pending roster:', error)
      setShowConfirmModal(false)
      setSaveError('Failed to save roster. Please try again.')
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
    setManuallyValidated(false)
    setServerPinValidated(false)

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // Check if PIN is required (only if a PIN is set in the match)
  // Handle both camelCase (local) and snake_case (Supabase) field names
  const teamUploadPin = team === 'home'
    ? (match?.homeTeamUploadPin || match?.home_team_upload_pin)
    : (match?.awayTeamUploadPin || match?.away_team_upload_pin)
  // Supabase mode: PIN is validated server-side (never sent to client), so a
  // synced match always requires a server-confirmed PIN (fail-closed).
  const isPinRequired = activeConnection === 'supabase'
    ? true
    : (teamUploadPin != null && teamUploadPin !== '')
  // When PIN is required, validate with PIN. When no PIN required, require manual validation click.
  const isValid = match && matchId && (
    activeConnection === 'supabase'
      ? serverPinValidated
      : (isPinRequired ? (uploadPin && teamUploadPin === uploadPin) : manuallyValidated)
  )

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
      minHeight: '100dvh',
      background: 'var(--bg)',
      color: 'var(--text)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      width: 'auto'
    }}>
      <UpdateBanner />

      <SimpleHeader
        title={t('uploadRoster.title')}
        subtitle={selectedMatch ? `${t('uploadRoster.game')} ${selectedMatch.gameNumber || selectedMatch.id}` : null}
        wakeLockActive={wakeLockActive}
        toggleWakeLock={toggleWakeLock}
        connectionStatuses={connectionStatuses}
        connectionDebugInfo={connectionDebugInfo}
        connectionMode={connectionMode}
        activeConnection={activeConnection}
        onConnectionModeChange={handleConnectionModeChange}
        showConnectionOptions={true}
        onBack={selectedMatch ? handleBackToGames : null}
        backLabel={t('uploadRoster.changeGame', 'Change Game')}
      />

      <div className="ov-kit flex-1 bg-gradient-to-b from-stone-50 to-stone-100 px-4 py-6 sm:py-8">
      <Card className="mx-auto">
        <h1 className="mb-6 text-center text-xl font-bold tracking-tight text-stone-900 sm:text-2xl">
          {t('uploadRoster.title')}
        </h1>

        {/* Game Selection - Step 1 */}
        {!parsedData && !selectedMatch && (
          <div className="mx-auto mb-6 w-full max-w-lg">
            <ListLabel>{t('uploadRoster.selectGame')}</ListLabel>

            {loadingMatches ? (
              <div role="status">
                <span className="sr-only">{t('uploadRoster.loadingGames')}</span>
                <SkeletonRows rows={3} pill={false} />
              </div>
            ) : availableMatches.length > 0 ? (
              <RowList soft>
                {availableMatches.map((match) => (
                  <GameRow
                    key={match.id}
                    match={match}
                    lang={i18n.language}
                    home={match.homeTeamName || t('common.home')}
                    away={match.awayTeamName || t('common.away')}
                    gameLabel={`${t('uploadRoster.game')} ${match.gameNumber || match.id}`}
                    onOpen={() => handleMatchSelect(match)}
                    status={<ChevronRight size={16} className="text-stone-400" aria-hidden />}
                  />
                ))}
              </RowList>
            ) : (
              <div onClick={handleTestModeClick} className="cursor-default select-none">
                <EmptyState icon={CalendarX2}>{t('uploadRoster.noActiveGames')}</EmptyState>
              </div>
            )}
          </div>
        )}

        {/* Team and PIN Selection - Step 2 */}
        {!parsedData && selectedMatch && (
          <div className="mx-auto mb-6 flex w-full max-w-sm flex-col items-stretch gap-5">
            {/* Match info */}
            <div className="text-center">
              <p className="text-base font-semibold text-stone-900">{homeTeam?.name || t('common.home')}</p>
              <p className="text-xs text-stone-500">{t('uploadRoster.vs')}</p>
              <p className="text-base font-semibold text-stone-900">{awayTeam?.name || t('common.away')}</p>
            </div>

            {matchStatusCheck === 'checking' && (
              <p role="status" className="flex items-center justify-center gap-2 text-sm text-stone-500">
                <Loader2 size={15} className="animate-spin" aria-hidden />
                {t('uploadRoster.validating')}
              </p>
            )}

            {matchStatusCheck === 'invalid' && validationError && (
              <FormError size="md" className="text-center">{validationError}</FormError>
            )}

            {matchStatusCheck === 'valid' && (
              <>
                <div>
                  <p className="mb-1.5 text-sm font-medium text-stone-700">{t('uploadRoster.selectTeam')}</p>
                  <div role="group" aria-label={t('uploadRoster.selectTeam')} className="flex gap-2">
                    {['home', 'away'].map((side) => (
                      <Button
                        key={side}
                        variant={team === side ? 'dark' : 'secondary'}
                        size="xl"
                        aria-pressed={team === side}
                        className="h-auto min-h-11 flex-1 py-2 font-medium whitespace-normal"
                        onClick={() => {
                          setTeam(side)
                          setValidationError('')
                          setUploadPin('')
                          setManuallyValidated(false)
                          setServerPinValidated(false)
                        }}
                      >
                        {side === 'home'
                          ? <>{t('uploadRoster.home')} {homeTeam?.name && `(${homeTeam.name})`}</>
                          : <>{t('uploadRoster.away')} {awayTeam?.name && `(${awayTeam.name})`}</>}
                      </Button>
                    ))}
                  </div>
                </div>

                {isPinRequired ? (
                  <Field label={t('uploadRoster.uploadPin')}>
                    <PinInput
                      value={uploadPin}
                      onChange={(e) => {
                        const val = e.target.value.replace(/\D/g, '').slice(0, 6)
                        setUploadPin(val)
                      }}
                      placeholder={t('uploadRoster.enterPin')}
                      aria-label={t('uploadRoster.uploadPin')}
                      maxLength={6}
                      invalid={!!(validationError && uploadPin.length === 6)}
                      className={cn('placeholder:font-sans placeholder:text-base placeholder:font-normal placeholder:tracking-normal', isValid && 'border-emerald-500')}
                    />
                  </Field>
                ) : (
                  <div className="text-center">
                    {manuallyValidated ? (
                      <p role="status" className="text-sm font-medium text-emerald-700">
                        ✓ {t('uploadRoster.validated', 'Validated')}
                      </p>
                    ) : (
                      <>
                        <p className="mb-3 text-sm text-stone-500">
                          {t('uploadRoster.noPinRequired', 'No PIN required')}
                        </p>
                        <Button variant="positive" size="xl" onClick={() => setManuallyValidated(true)}>
                          {t('uploadRoster.validate', 'Validate')}
                        </Button>
                      </>
                    )}
                  </div>
                )}

                {isPinRequired && isValid && (
                  <p role="status" className="-mt-3 text-center text-xs font-medium text-emerald-700">
                    ✓ {t('uploadRoster.validate')}
                  </p>
                )}

                {validationError && uploadPin.length === 6 && isPinRequired && (
                  <FormError size="md" className="text-center">{validationError}</FormError>
                )}
              </>
            )}
          </div>
        )}

        {/* Upload Section */}
        {isValid && !parsedData && (
          <div className="mx-auto mb-6 flex w-full max-w-sm flex-col items-stretch gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleFileSelect}
              aria-label={t('uploadRoster.selectPdfFile')}
              style={{ display: 'none' }}
            />
            <Button
              variant="secondary"
              size="xl"
              block
              icon={FileUp}
              onClick={() => fileInputRef.current?.click()}
              disabled={pdfLoading}
            >
              {t('uploadRoster.selectPdfFile')}
            </Button>

            {pdfFile && (
              <>
                <p className="truncate rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-center text-sm text-stone-700">
                  Selected: {pdfFile.name}
                </p>
                <Button size="xl" block onClick={handleUpload} disabled={pdfLoading} loading={pdfLoading}>
                  {pdfLoading ? t('uploadRoster.parsing') : t('uploadRoster.confirm')}
                </Button>
              </>
            )}

            {pdfLoading && (
              <p role="status" className="text-center text-sm text-stone-500">
                {t('uploadRoster.parsing')}
              </p>
            )}

            <FormError size="md" className="text-center">{pdfError}</FormError>
          </div>
        )}

        {/* Editable Roster */}
        {parsedData && (
          <div className="mx-auto w-full max-w-5xl space-y-6">
            <section>
              <SectionHeader as="h2" title={t('uploadRoster.parsedPlayers')} count={parsedData.players.length} />
              <div className="overflow-x-auto">
                <div className="min-w-[760px]">
                  {/* Column headers for players */}
                  <div className={cn(ROSTER_HEAD, 'grid-cols-[60px_1fr_1fr_140px_100px_100px_70px]')}>
                    <span>{t('rosterSetup.number', '#')}</span>
                    <span>{t('rosterSetup.lastName', 'Last Name')}</span>
                    <span>{t('rosterSetup.firstName', 'First Name')}</span>
                    <span>{t('rosterSetup.dob', 'DOB')}</span>
                    <span>{t('rosterSetup.libero', 'Libero')}</span>
                    <span className="text-center">C</span>
                    <span></span>
                  </div>

                  <div className="divide-y divide-stone-100">
                    {parsedData.players.map((player, index) => (
                      <div key={index} className={cn(ROSTER_ROW, 'grid-cols-[60px_1fr_1fr_140px_100px_100px_70px]')}>
                        <input
                          type="number"
                          value={player.number || ''}
                          onChange={(e) => handlePlayerChange(index, 'number', e.target.value ? Number(e.target.value) : null)}
                          placeholder="#"
                          aria-label={t('rosterSetup.number', 'Number')}
                          className={cn(FIELD, 'text-center tabular-nums')}
                        />
                        <input
                          type="text"
                          value={player.lastName}
                          onChange={(e) => handlePlayerChange(index, 'lastName', e.target.value)}
                          placeholder={t('rosterSetup.lastName', 'Last Name')}
                          aria-label={t('rosterSetup.lastName', 'Last Name')}
                          className={FIELD}
                        />
                        <input
                          type="text"
                          value={player.firstName}
                          onChange={(e) => handlePlayerChange(index, 'firstName', e.target.value)}
                          placeholder={t('rosterSetup.firstName', 'First Name')}
                          aria-label={t('rosterSetup.firstName', 'First Name')}
                          className={FIELD}
                        />
                        <input
                          type="date"
                          value={player.dob ? formatDateToISO(player.dob) : ''}
                          onChange={(e) => handlePlayerChange(index, 'dob', e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')}
                          aria-label={t('rosterSetup.dob', 'DOB')}
                          className={FIELD}
                        />
                        <select
                          value={player.libero}
                          onChange={(e) => handlePlayerChange(index, 'libero', e.target.value)}
                          aria-label={t('rosterSetup.libero', 'Libero')}
                          className={FIELD}
                        >
                          <option value=""></option>
                          <option value="libero1">{t('rosterSetup.libero', 'Libero')} 1</option>
                          <option value="libero2">{t('rosterSetup.libero', 'Libero')} 2</option>
                        </select>
                        <div
                          onClick={() => handlePlayerChange(index, 'isCaptain', !player.isCaptain)}
                          style={{
                            width: '24px',
                            height: '24px',
                            borderRadius: '4px',
                            border: player.isCaptain ? '2px solid #22c55e' : '2px solid var(--border)',
                            background: player.isCaptain ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: 700,
                            color: player.isCaptain ? '#22c55e' : 'var(--muted)',
                            userSelect: 'none',
                            margin: '0 auto'
                          }}
                        >C</div>
                        <Button variant="danger-outline" size="sm" block onClick={() => handleDeletePlayer(index)}>
                          {t('common.delete')}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <Button variant="secondary" className="mt-3" onClick={handleAddPlayer}>
                {t('roster.addPlayer')}
              </Button>
            </section>

            <section>
              <SectionHeader as="h2" title={t('uploadRoster.parsedBench')} count={parsedData.bench.length} />
              <div className="overflow-x-auto">
                <div className="min-w-[640px]">
                  {/* Column headers for bench officials */}
                  <div className={cn(ROSTER_HEAD, 'grid-cols-[180px_1fr_1fr_140px_70px]')}>
                    <span>{t('rosterSetup.role', 'Role')}</span>
                    <span>{t('rosterSetup.lastName', 'Last Name')}</span>
                    <span>{t('rosterSetup.firstName', 'First Name')}</span>
                    <span>{t('rosterSetup.dob', 'DOB')}</span>
                    <span></span>
                  </div>

                  <div className="divide-y divide-stone-100">
                    {parsedData.bench.map((official, index) => (
                      <div key={index} className={cn(ROSTER_ROW, 'grid-cols-[180px_1fr_1fr_140px_70px]')}>
                        <select
                          value={official.role}
                          onChange={(e) => handleBenchChange(index, 'role', e.target.value)}
                          aria-label={t('rosterSetup.role', 'Role')}
                          className={FIELD}
                        >
                          <option value="Coach">{t('benchRoles.coach', 'Coach')}</option>
                          <option value="Assistant Coach 1">{t('benchRoles.assistantCoach1', 'Assistant Coach 1')}</option>
                          <option value="Assistant Coach 2">{t('benchRoles.assistantCoach2', 'Assistant Coach 2')}</option>
                          <option value="Physiotherapist">{t('benchRoles.physiotherapist', 'Physiotherapist')}</option>
                          <option value="Medic">{t('benchRoles.medic', 'Medic')}</option>
                        </select>
                        <input
                          type="text"
                          value={official.lastName}
                          onChange={(e) => handleBenchChange(index, 'lastName', e.target.value)}
                          placeholder={t('rosterSetup.lastName', 'Last Name')}
                          aria-label={t('rosterSetup.lastName', 'Last Name')}
                          className={FIELD}
                        />
                        <input
                          type="text"
                          value={official.firstName}
                          onChange={(e) => handleBenchChange(index, 'firstName', e.target.value)}
                          placeholder={t('rosterSetup.firstName', 'First Name')}
                          aria-label={t('rosterSetup.firstName', 'First Name')}
                          className={FIELD}
                        />
                        <input
                          type="date"
                          value={official.dob ? formatDateToISO(official.dob) : ''}
                          onChange={(e) => handleBenchChange(index, 'dob', e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')}
                          aria-label={t('rosterSetup.dob', 'DOB')}
                          className={FIELD}
                        />
                        <Button variant="danger-outline" size="sm" block onClick={() => handleDeleteBench(index)}>
                          {t('common.delete')}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <Button variant="secondary" icon={Plus} className="mt-3" onClick={handleAddBench}>
                {t('roster.benchOfficials')}
              </Button>
            </section>

            {/* Signatures Section */}
            <section>
              <SectionHeader as="h2" title={t('rosterSetup.signatures', 'Signatures')} />
              <p className="mt-1.5 mb-4 text-xs text-stone-500">
                {t('rosterSetup.signaturesDescription', 'Optional: Coach and captain can sign the roster before the coin toss.')}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  { key: 'coach', label: t('rosterSetup.coachSignature', 'Coach Signature'), value: coachSignature, clear: () => setCoachSignature(null), alt: 'Coach signature' },
                  { key: 'captain', label: t('rosterSetup.captainSignature', 'Captain Signature'), value: captainSignature, clear: () => setCaptainSignature(null), alt: 'Captain signature' }
                ].map((sig) => (
                  <div key={sig.key} className="min-w-0">
                    <p className="mb-1.5 text-sm font-medium text-stone-700">{sig.label}</p>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setOpenSignature(sig.key)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenSignature(sig.key) } }}
                      className={cn(
                        'flex h-[100px] w-full cursor-pointer items-center justify-center overflow-hidden rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60',
                        sig.value ? 'border-2 border-emerald-500 bg-white' : 'border-2 border-dashed border-stone-300 bg-stone-50 text-stone-500 hover:bg-stone-100'
                      )}
                    >
                      {sig.value ? (
                        <img src={sig.value} alt={sig.alt} className="max-h-full max-w-full" />
                      ) : (
                        <span className="text-sm">{t('rosterSetup.tapToSign', 'Tap to sign')}</span>
                      )}
                    </div>
                    {sig.value && (
                      <Button
                        variant="danger-outline"
                        size="sm"
                        className="mt-2"
                        onClick={(e) => { e.stopPropagation(); sig.clear() }}
                      >
                        {t('common.clear', 'Clear')}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <FormError size="md" className="text-center">{saveError}</FormError>
            <div className="flex justify-center pt-2">
              <Button size="xl" className="min-w-48" onClick={handleConfirm}>
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        )}
      </Card>

        {/* Confirmation Modal */}
        {showConfirmModal && (
          <Modal
            title={uploading ? t('uploadRoster.uploading') : t('uploadRoster.confirmTitle')}
            open={true}
            onClose={() => !uploading && setShowConfirmModal(false)}
            width={400}
          >
            <div className="ov-kit p-2 sm:p-4">
              {uploading ? (
                <div role="status" className="flex flex-col items-center gap-3 py-4 text-center">
                  <Loader2 size={32} className="animate-spin text-stone-400" aria-hidden />
                  <p className="text-sm text-stone-600">
                    {t('uploadRoster.uploadingMessage')}
                  </p>
                </div>
              ) : (
                <>
                  <p className="mb-6 text-center text-sm text-stone-600">
                    {t('uploadRoster.confirmMessage')}
                  </p>
                  <div className="flex gap-2">
                    <Button variant="secondary" size="xl" className="flex-1" onClick={() => setShowConfirmModal(false)}>
                      {t('common.no')}
                    </Button>
                    <Button variant="positive" size="xl" className="flex-1" onClick={handleFinalConfirm}>
                      {t('common.yes')}
                    </Button>
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
            <div className="ov-kit p-2 text-center sm:p-4">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <Check size={28} aria-hidden />
              </div>
              <p className="mb-6 text-sm text-stone-600">
                {t('uploadRoster.rosterSentToScoresheet')}
              </p>
              <Button variant="dark" size="xl" block onClick={handleSuccessClose}>
                {t('common.ok')}
              </Button>
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
  )
}