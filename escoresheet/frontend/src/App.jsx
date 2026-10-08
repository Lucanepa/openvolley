import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import { wipeMatchEvents } from './db/eventHistory'
import MatchSetup from './components/MatchSetup'
import Scoreboard from './components/Scoreboard'
import CoinToss from './components/CoinToss'
import MatchEnd from './components/MatchEnd'
import ManualAdjustments from './components/ManualAdjustments'
import Modal from './components/Modal'
import ContextualHelpPanel from './components/help/ContextualHelpPanel'
import SpotlightOverlay from './components/help/SpotlightOverlay'
import ConnectionStatus from './components/ConnectionStatus'
import StartupConnectivityModal from './components/StartupConnectivityModal'
import MainHeader from './components/MainHeader'
import BackupTable from './components/BackupTable'
import HomePage from './components/pages/HomePage'
import HomeOptionsModal from './components/options/HomeOptionsModal'
import ConnectTabletsModal from './components/connect/ConnectTabletsModal'
import { useSyncQueue, useUserMatchLink } from './hooks/useSyncQueue'
import SyncSignInBanner from './components/auth/SyncSignInBanner'
import useAutoBackup from './hooks/useAutoBackup'
import { pickNativeBackupFile } from './utils/nativeBackup'
import { useDashboardServer } from './hooks/useDashboardServer'
import ballFallback from './ball_fallback.png'

// Primary ball image (with a bundled copy as fallback)
// The bundled, content-hashed ball (brand/ball.svg): an unhashed /ball.png could
// stay cached (old green ball) after an update
const ballImage = ballFallback

import {
  TEST_REFEREE_SEED_DATA,
  TEST_SCORER_SEED_DATA,
  TEST_TEAM_SEED_DATA,
  newTestMatchSeedKey,
  isTestMatchSeedKey,
  testMatchSeedKeyFor,
  TEST_MATCH_EXTERNAL_ID,
  TEST_HOME_TEAM_EXTERNAL_ID,
  TEST_AWAY_TEAM_EXTERNAL_ID,
  TEST_MATCH_DEFAULTS,
  TEST_HOME_BENCH,
  TEST_AWAY_BENCH,
  getNextTestMatchStartTime,
  getTestHomeTeamShortName,
  getTestAwayTeamShortName,
  getTestTeamByExternalId
} from './constants/testSeeds'
import { apiFrom } from './lib/apiClient'
import { checkMatchSession, lockMatchSession, unlockMatchSession, verifyGamePin } from './utils/sessionManager'
import { fetchMatchByPin, importMatchFromSupabase, restoreMatchFromJson, selectBackupFile, listCloudBackups, fetchCloudBackup, listPocketBaseBackups, fetchPocketBaseMatch } from './utils/backupManager'
import UpdateBanner from './components/UpdateBanner'
import DesktopUpdateNotice from './components/DesktopUpdateNotice'
import { isMatchFinished as isMatchFinishedUtil, getNextSetIndex } from './utils/matchFormat'
import { getMatchWinner } from './domain/matchEnd'
import { setExtId } from './utils/syncIds'
import { PhoneIcon } from './components/icons'
import { Maximize } from 'lucide-react'
import { Button, cn, FormError, Input } from './ui'
import { getBackendOverride, getLocalServerStatusUrl, isCloudBlockedOnThisPort, isStaticHost } from './utils/backendConfig'
import { isViewportTooSmall } from './utils/formLayout'
import { installAppLifecycle, liveOf, setLiveMatch } from './utils/appLifecycle'
import { installAndroidUpdates, liveMatchKnown } from './utils/androidUpdate'
import AndroidUpdateNotice from './components/AndroidUpdateNotice'
import { detectAppPlatform } from './utils/openAppWindow'
import ManageConsole from './components/manage/ManageConsole'
import ManagerSiteLink from './components/ManagerSiteLink'
import { OPEN_MANAGE_EVENT, OPEN_RESTORE_EVENT, restorePrefill } from './utils/manageNav'
import { relayMatchKey, relayMatchPayload } from './utils/serverDataSync'
import { needsEventCheck, pickCurrentMatch } from './utils/currentMatch'
import { isRelayErrorFor, relayConnectionStatus, scorerLiveOrder, scorerRelay, scorerRelayUrl } from './utils/relayPublisher'
import { PHONE_MAX_WIDTH, phoneLayoutActive } from './components/scoreboard/phoneLayout'

function readStoredDisplayMode() {
  try {
    return localStorage.getItem('displayMode') || 'auto'
  } catch {
    return 'auto'
  }
}

function parseDateTime(dateTime) {
  const [datePart, timePart] = dateTime.split(' ')
  const [day, month, year] = datePart.split('.').map(Number)
  const [hours, minutes] = timePart.split(':').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hours, minutes))
  return date.toISOString()
}

function generateRefereePin() {
  const chars = '0123456789'
  let pin = ''
  for (let i = 0; i < 6; i++) {
    pin += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return pin
}

export default function App() {
  const { t } = useTranslation()
  const [matchId, setMatchId] = useState(null)
  const [showMatchSetup, setShowMatchSetup] = useState(false)
  const [showCoinToss, setShowCoinToss] = useState(false)
  const [showMatchEnd, setShowMatchEnd] = useState(false)
  const [showManualAdjustments, setShowManualAdjustments] = useState(false)
  const [deleteMatchModal, setDeleteMatchModal] = useState(null)
  const [deletePinInput, setDeletePinInput] = useState('')
  const [deletePinError, setDeletePinError] = useState('')
  const [newMatchModal, setNewMatchModal] = useState(null)
  const [restoreMatchModal, setRestoreMatchModal] = useState(false)
  const [restoreMatchIdInput, setRestoreMatchIdInput] = useState('')
  // Manage console (admins, competition managers): the open tab, or null
  const [manageTab, setManageTab] = useState(null)
  const [restorePin, setRestorePin] = useState('')
  const [restoreError, setRestoreError] = useState('')
  const [restoreLoading, setRestoreLoading] = useState(false)
  const [cloudBackups, setCloudBackups] = useState([])
  const [cloudBackupPin, setCloudBackupPin] = useState('')
  const [cloudBackupGameN, setCloudBackupGameN] = useState('')
  const [cloudBackupLoading, setCloudBackupLoading] = useState(false)
  const [cloudBackupError, setCloudBackupError] = useState('')
  const [restorePreviewData, setRestorePreviewData] = useState(null) // { data, source: 'database'|'cloud'|'local' }
  // utils/manageNav: the user menu opens the console; sync notices and
  // MatchSetup open "restore a match" with the game number filled in (join
  // an official game with its game PIN). The console never opens over a
  // match in progress.
  useEffect(() => {
    const onManage = (e) => {
      if (matchId) return
      setManageTab(e?.detail?.tab || 'accounts')
    }
    const onRestore = (e) => {
      // The dialog's game number field is cloudBackupGameN (restoreMatchIdInput is not shown)
      const fill = restorePrefill(e?.detail)
      setManageTab(null)
      setCloudBackupGameN(fill.cloudBackupGameN)
      setCloudBackupPin(fill.cloudBackupPin)
      setCloudBackupError(fill.cloudBackupError)
      setCloudBackups([])
      setRestoreMatchModal(true)
    }
    window.addEventListener(OPEN_MANAGE_EVENT, onManage)
    window.addEventListener(OPEN_RESTORE_EVENT, onRestore)
    return () => {
      window.removeEventListener(OPEN_MANAGE_EVENT, onManage)
      window.removeEventListener(OPEN_RESTORE_EVENT, onRestore)
    }
  }, [matchId])
  const [testMatchLoading, setTestMatchLoading] = useState(false)
  const [alertModal, setAlertModal] = useState(null) // { message: string }
  const [confirmModal, setConfirmModal] = useState(null) // { message: string, onConfirm: function, onCancel: function }
  const [newMatchMenuOpen, setNewMatchMenuOpen] = useState(false)
  const [homeOptionsModal, setHomeOptionsModal] = useState(false)
  const [helpPanelOpen, setHelpPanelOpen] = useState(false)
  const [spotlightTarget, setSpotlightTarget] = useState(null)
  const [connectionSetupModal, setConnectionSetupModal] = useState(false)
  const { syncStatus, retryErrors, isOnline } = useSyncQueue()
  // The sync indicator reads the queue counts itself (a live query there, so a
  // queue write does not re-render the whole app); it only needs to know
  // whether the cloud is waiting for a sign-in.
  const queueStats = useMemo(() => ({ authRequired: syncStatus === 'auth_required' }), [syncStatus])
  const backup = useAutoBackup(matchId)
  // Backup file for a restore: the desktop app opens its own dialog in the
  // backup folder; elsewhere the browser file picker.
  const pickBackupFile = useCallback(async () => {
    const native = await pickNativeBackupFile()
    return native === undefined ? selectBackupFile() : native
  }, [])
  // Options > Backup > Restore from a backup file: same preview + restore path
  // as the Restore match dialog.
  const restoreFromBackupFile = useCallback(async () => {
    try {
      const jsonData = await pickBackupFile()
      if (!jsonData) return // cancelled
      setHomeOptionsModal(false)
      setRestorePreviewData({ data: jsonData, source: 'local' })
    } catch (err) {
      setAlertModal(err?.message || t('home.modals.failedToRestoreFromFile'))
    }
  }, [pickBackupFile, t])
  // My Matches: link the signed-in account to the match open here (sync queue)
  useUserMatchLink(matchId)

  // Compute current page for contextual help
  const currentPage = useMemo(() => {
    if (showManualAdjustments && matchId) return 'manualAdjustments'
    if (showMatchEnd && matchId) return 'matchEnd'
    if (showCoinToss && matchId) return 'coinToss'
    if (showMatchSetup && matchId) return 'matchSetup'
    if (matchId) return 'scoreboard'
    return 'home'
  }, [matchId, showMatchSetup, showCoinToss, showMatchEnd, showManualAdjustments])

  // Dashboard Server state (only available in Electron desktop app)
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI
  const [dashboardServerEnabled, setDashboardServerEnabled] = useState(
    () => localStorage.getItem('dashboardServerEnabled') === 'true'
  )
  const dashboardServerData = useDashboardServer({
    enabled: isElectron && dashboardServerEnabled,
    matchId: matchId
  })
  const [serverStatus, setServerStatus] = useState(null)
  const [showConnectionMenu, setShowConnectionMenu] = useState(false)
  const [connectionStatuses, setConnectionStatuses] = useState({
    api: 'unknown',
    server: 'unknown',
    websocket: 'unknown',
    scoreboard: 'unknown',
    match: 'unknown',
    db: 'unknown',
    supabase: 'unknown'
  })
  const [connectionDebugInfo, setConnectionDebugInfo] = useState({})
  const [scorerAttentionTrigger, setScorerAttentionTrigger] = useState(null)
  const [showDebugMenu, setShowDebugMenu] = useState(null) // Which connection type to show debug for
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [viewportSize, setViewportSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [matchInfoMenuOpen, setMatchInfoMenuOpen] = useState(false)
  const [offlineMode, setOfflineMode] = useState(() => {
    const saved = localStorage.getItem('offlineMode')
    return saved === 'true'
  })
  const [showStartupConnectivity, setShowStartupConnectivity] = useState(() => {
    return localStorage.getItem('offlineMode') !== 'true'
  })
  // Display mode: 'desktop' | 'tablet' | 'auto'
  const [displayMode, setDisplayMode] = useState(() => {
    const saved = localStorage.getItem('displayMode')
    return saved || 'auto' // default to auto-detect
  })
  const [detectedDisplayMode, setDetectedDisplayMode] = useState('desktop') // What mode was auto-detected
  const [checkAccidentalRallyStart, setCheckAccidentalRallyStart] = useState(() => {
    const saved = localStorage.getItem('checkAccidentalRallyStart')
    return saved === 'true' // default false
  })
  const [accidentalRallyStartDuration, setAccidentalRallyStartDuration] = useState(() => {
    const saved = localStorage.getItem('accidentalRallyStartDuration')
    return saved ? parseInt(saved, 10) : 3 // default 3 seconds
  })
  const [checkAccidentalPointAward, setCheckAccidentalPointAward] = useState(() => {
    const saved = localStorage.getItem('checkAccidentalPointAward')
    return saved === 'true' // default false
  })
  const [accidentalPointAwardDuration, setAccidentalPointAwardDuration] = useState(() => {
    const saved = localStorage.getItem('accidentalPointAwardDuration')
    return saved ? parseInt(saved, 10) : 3 // default 3 seconds
  })
  const [manageCaptainOnCourt, setManageCaptainOnCourt] = useState(() => {
    const saved = localStorage.getItem('manageCaptainOnCourt')
    return saved === 'true' // default false
  })
  const [liberoExitConfirmation, setLiberoExitConfirmation] = useState(() => {
    const saved = localStorage.getItem('liberoExitConfirmation')
    return saved !== 'false' // default true
  })
  const [liberoEntrySuggestion, setLiberoEntrySuggestion] = useState(() => {
    const saved = localStorage.getItem('liberoEntrySuggestion')
    return saved !== 'false' // default true
  })
  const [setIntervalDuration, setSetIntervalDuration] = useState(() => {
    const saved = localStorage.getItem('setIntervalDuration')
    return saved ? parseInt(saved, 10) : 180 // default 3 minutes = 180 seconds
  })
  const [keybindingsEnabled, setKeybindingsEnabled] = useState(() => {
    const saved = localStorage.getItem('keybindingsEnabled')
    return saved === 'true' // default false
  })
  const [lfpTrackingEnabled, setLfpTrackingEnabled] = useState(() => {
    return localStorage.getItem('lfpTrackingEnabled') === 'true' // default false
  })
  const [lfpMinimumOnCourt, setLfpMinimumOnCourt] = useState(() => {
    const saved = localStorage.getItem('lfpMinimumOnCourt')
    return saved ? parseInt(saved, 10) : 3 // default 3
  })

  // Wake lock refs and state
  const wakeLockRef = useRef(null)
  const noSleepVideoRef = useRef(null)
  const [wakeLockActive, setWakeLockActive] = useState(false)

  // Request wake lock to prevent screen from sleeping
  useEffect(() => {
    const enableNoSleep = async () => {
      try {
        if ('wakeLock' in navigator) {
          if (wakeLockRef.current) { try { await wakeLockRef.current.release() } catch (e) { } }
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          setWakeLockActive(true)
          wakeLockRef.current.addEventListener('release', () => {
            if (!wakeLockRef.current) setWakeLockActive(false)
          })
        }
      } catch (err) { /* WakeLock failed, ignore */ }
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
      } catch (err) { /* NoSleep video failed, ignore */ }
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
      if (wakeLockRef.current) { wakeLockRef.current.release().catch(() => { }); wakeLockRef.current = null }
      if (noSleepVideoRef.current) { noSleepVideoRef.current.pause(); noSleepVideoRef.current.remove(); noSleepVideoRef.current = null }
    }
  }, [])

  const reEnableWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        if (wakeLockRef.current) { try { await wakeLockRef.current.release() } catch (e) { } }
        wakeLockRef.current = await navigator.wakeLock.request('screen')
        setWakeLockActive(true)
        wakeLockRef.current.addEventListener('release', () => { })
        return true
      }
    } catch (err) { /* Failed to re-acquire, ignore */ }
    return false
  }, [])

  const toggleWakeLock = useCallback(async () => {
    if (wakeLockActive) {
      if (wakeLockRef.current) { try { await wakeLockRef.current.release(); wakeLockRef.current = null } catch (e) { } }
      setWakeLockActive(false)
    } else {
      const success = await reEnableWakeLock()
      if (!success) setWakeLockActive(true)
    }
  }, [wakeLockActive, reEnableWakeLock])

  // Preload assets that are used later (e.g., coin toss volleyball image)
  useEffect(() => {
    const assetsToPreload = [
      ballImage,
      ballFallback
    ]

    assetsToPreload.forEach(src => {
      const img = new Image()
      img.src = src
    })
  }, [])

  // Fetch server status periodically
  useEffect(() => {
    // Only the dev server and a local server (Pi, desktop app) have one: a
    // static deployment (*.openvolley.app, *.pages.dev) answers with its SPA
    const statusUrl = getLocalServerStatusUrl()
    if (!statusUrl) return

    const fetchServerStatus = async () => {
      try {
        const response = await fetch(statusUrl)
        if (response.ok && (response.headers?.get?.('content-type') || '').includes('json')) {
          const status = await response.json()
          setServerStatus(status)
        }
      } catch (err) {
        // Server might not be running, that's okay
        if (import.meta.env.DEV) {
          console.log('[App] Server status not available:', err.message)
        }
      }
    }

    fetchServerStatus()
    const interval = setInterval(fetchServerStatus, 10000) // Check every 10 seconds
    return () => clearInterval(interval)
  }, [])

  // Screen size detection for display mode
  // portrait under 600px = phone, <= 1024px = tablet, > 1024px = desktop
  useEffect(() => {
    const checkScreenSize = () => {
      const width = window.innerWidth
      const height = window.innerHeight
      let detected = 'desktop'

      if (height > width && width < PHONE_MAX_WIDTH) {
        detected = 'phone'
      } else if (width <= 1024) {
        detected = 'tablet'
      }
      // > 1024px = desktop (default)

      setDetectedDisplayMode(detected)
      setViewportSize({ width, height })
    }

    // Check on mount
    checkScreenSize()

    // Check on resize
    window.addEventListener('resize', checkScreenSize)
    return () => window.removeEventListener('resize', checkScreenSize)
  }, [])

  // Fullscreen for tablet mode
  const enterDisplayMode = useCallback((mode) => {
    // Request fullscreen
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(err => {
        console.log('Fullscreen request failed:', err)
      })
    }

    // Note: Orientation locking is now handled by Scoreboard and Scoresheet components
    // so other screens (MatchSetup, CoinToss, etc.) can work in portrait mode

    // Set the display mode
    setDisplayMode(mode)
    localStorage.setItem('displayMode', mode)
  }, [])

  // Exit fullscreen and reset to desktop mode
  const exitDisplayMode = useCallback(() => {
    if (document.exitFullscreen && document.fullscreenElement) {
      document.exitFullscreen().catch(err => {
        console.log('Exit fullscreen failed:', err)
      })
    }

    setDisplayMode('desktop')
    localStorage.setItem('displayMode', 'desktop')
  }, [])

  // Get the active display mode
  const activeDisplayMode = displayMode === 'auto' ? detectedDisplayMode : displayMode

  // Toggle no-scroll class on body when on home page
  useEffect(() => {
    if (!matchId && !showMatchSetup && !showMatchEnd) {
      document.body.classList.add('no-scroll')
    } else {
      document.body.classList.remove('no-scroll')
    }
    return () => {
      document.body.classList.remove('no-scroll')
    }
  }, [matchId, showMatchSetup, showMatchEnd])

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

  // Closing / quitting the app: the desktop app hides to the tray and asks
  // before it quits, Android's Back asks before it exits, a browser asks
  // before it leaves a live match (utils/appLifecycle.js)
  useEffect(() => installAppLifecycle(), [])
  // Android app: who installed it, the opt-in update check (utils/androidUpdate.js)
  useEffect(() => installAndroidUpdates(), [])
  const activeMatchStatus = activeMatch?.status
  const activeMatchIsTest = !!activeMatch?.test
  // undefined until the live query has answered: before that "no live match"
  // is only a guess, and the Android update check must not run on a guess
  const activeMatchLoaded = activeMatch !== undefined
  useEffect(() => {
    setLiveMatch(liveOf(activeMatchStatus ? { status: activeMatchStatus, test: activeMatchIsTest } : null))
    if (activeMatchLoaded) liveMatchKnown()
  }, [activeMatchStatus, activeMatchIsTest, activeMatchLoaded])

  // Current match: the newest unfinished one by createdAt, never one created,
  // edited and scheduled more than 7 days ago without a single event
  // (abandoned: it was offered to
  // the hall's tablets as "Home – Away" for months). utils/currentMatch.js.
  // Only those old matches' events are read, so scoring the current match
  // does not re-run this query.
  const currentMatch = useLiveQuery(async () => {
    try {
      const now = Date.now()
      const matches = (await db.matches.toArray()).filter(m => m.status !== 'final')
      const withEvents = new Set()
      for (const m of matches) {
        if (needsEventCheck(m, now) && await db.events.where('matchId').equals(m.id).count() > 0) withEvents.add(m.id)
      }
      return pickCurrentMatch(matches, { now, hasEvents: (id) => withEvents.has(id) })
    } catch (error) {
      console.error('Unable to load current match', error)
      return null
    }
  }, [])

  const currentOfficialMatch = useLiveQuery(async () => {
    try {
      const matches = await db.matches.orderBy('createdAt').reverse().toArray()
      // Only consider matches that have been confirmed (matchInfoConfirmedAt set)
      // This prevents showing Continue/Delete for matches where user hasn't clicked "Create Match"
      return matches.find(m => m.test !== true && m.status !== 'final' && m.matchInfoConfirmedAt) || null
    } catch (error) {
      console.error('Unable to load official match', error)
      return null
    }
  }, [])

  // Fullscreen functionality
  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
        setIsFullscreen(true)
      } else {
        await document.exitFullscreen()
        setIsFullscreen(false)
      }
    } catch (error) {
      console.error('Error toggling fullscreen:', error)
      // Fallback: try alternative fullscreen methods
      const doc = document.documentElement
      if (doc.webkitRequestFullscreen) {
        doc.webkitRequestFullscreen()
        setIsFullscreen(true)
      } else if (doc.msRequestFullscreen) {
        doc.msRequestFullscreen()
        setIsFullscreen(true)
      } else if (doc.mozRequestFullScreen) {
        doc.mozRequestFullScreen()
        setIsFullscreen(true)
      }
    }
  }, [])

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    document.addEventListener('msfullscreenchange', handleFullscreenChange)
    document.addEventListener('mozfullscreenchange', handleFullscreenChange)

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
      document.removeEventListener('msfullscreenchange', handleFullscreenChange)
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange)
    }
  }, [])

  // One connection status entry; no re-render when it did not change
  const updateConnectionStatus = useCallback((key, status, debug) => {
    setConnectionStatuses(prev => (prev[key] === status ? prev : { ...prev, [key]: status }))
    setConnectionDebugInfo(prev => {
      const old = prev[key]
      if (old && old.status === debug?.status && old.message === debug?.message && old.details === debug?.details) return prev
      return { ...prev, [key]: debug }
    })
  }, [])

  // Match and cloud sync statuses come from state this component already has:
  // set on change, without the network checks below (a match write or a
  // syncing/synced flip must not re-run those).
  const hasCurrentMatch = !!currentMatch
  const currentMatchStatus = currentMatch?.status
  const currentMatchIsTest = !!currentMatch?.test
  useEffect(() => {
    const updateStatus = updateConnectionStatus

    // --- Match status ---
    if (hasCurrentMatch) {
      const matchStatus = currentMatchStatus === 'live' ? 'live' : currentMatchStatus === 'scheduled' ? 'scheduled' : currentMatchStatus === 'final' ? 'final' : 'unknown'
      updateStatus('match', matchStatus, { status: matchStatus, message: `Match status: ${matchStatus} (${currentMatchIsTest ? 'Test' : 'Official'} match)` })
    } else {
      updateStatus('match', 'no_match', { status: 'no_match', message: 'No match found. Create a new match to start.' })
    }

    // --- Cloud sync status (from syncStatus) ---
    // (status key 'supabase' kept for the UI; the cloud is the OpenVolley backend now)
    if (syncStatus === 'synced' || syncStatus === 'syncing') {
      updateStatus('supabase', 'connected', { status: 'connected', message: 'Cloud backend is connected and syncing' })
    } else if (syncStatus === 'auth_required') {
      // The backend is reachable; writes wait for a sign-in (banner + indicator say so)
      updateStatus('supabase', 'connected', {
        status: 'connected',
        message: 'Cloud backend is reachable. Sign in to sync this device\'s matches.'
      })
    } else if (syncStatus === 'online_no_supabase' && isCloudBlockedOnThisPort()) {
      const port = window.location.port
      updateStatus('supabase', 'not_configured', {
        status: 'not_configured',
        message: `Cloud sync unavailable on port ${port}`,
        details: `The cloud accepts the desktop app only on port 5173; this window runs on port ${port} (OPENVOLLEY_HTTP_PORT). Free port 5173 and start the app without OPENVOLLEY_HTTP_PORT to sync. Matches stay on this computer and the tablets keep working through the relay.`
      })
    } else if (syncStatus === 'online_no_supabase') {
      updateStatus('supabase', 'not_configured', {
        status: 'not_configured',
        message: 'Offline: no cloud backend here',
        details: 'This server is an offline LAN relay (desktop app or venue server) or the build has no backend URL. Matches are kept on this device and on the local server; tablets connect through the relay.'
      })
    } else if (syncStatus === 'connecting') {
      updateStatus('supabase', 'connecting', { status: 'connecting', message: 'Connecting to the cloud backend...' })
    } else if (syncStatus === 'error') {
      updateStatus('supabase', 'error', {
        status: 'error',
        message: 'Cloud backend error',
        details: 'The backend answered with an error. Sync keeps retrying in the background.'
      })
    } else if (syncStatus === 'offline') {
      updateStatus('supabase', 'offline', { status: 'offline', message: 'Device is offline or the cloud backend is unreachable' })
    } else {
      updateStatus('supabase', 'unknown', { status: 'unknown', message: 'Cloud backend status unknown' })
    }
  }, [hasCurrentMatch, currentMatchStatus, currentMatchIsTest, syncStatus, updateConnectionStatus])

  // The relay's WS port (Electron server status); the port, not serverStatus,
  // which is a new object every 10 s
  const relayWsPort = serverStatus?.wsPort ?? null

  // Network checks (IndexedDB, API/server, relay): every 30 s and on demand,
  // each status set as its check resolves
  const checkConnectionStatuses = useCallback(async () => {
    const updateStatus = updateConnectionStatus

    // Check if we're on a static deployment (GitHub Pages, Cloudflare Pages, etc.)
    // (backendConfig.isStaticHost: *.openvolley.app, *.pages.dev, *.github.io)
    const isStaticDeployment = !import.meta.env.DEV && isStaticHost(window.location.hostname)

    // Check if we have a configured backend URL (cloud backend), or the venue
    // LAN relay the Android app was pointed at (NativeServerSection)
    const configuredBackendUrl = getBackendOverride() || import.meta.env.VITE_BACKEND_URL
    const hasBackendUrl = !!configuredBackendUrl

    // --- Run async checks in parallel ---
    const asyncChecks = []

    // DB check (IndexedDB — fast)
    asyncChecks.push(
      db.matches.count()
        .then(() => updateStatus('db', 'connected', { status: 'connected', message: 'IndexedDB is accessible' }))
        .catch(err => updateStatus('db', 'disconnected', { status: 'disconnected', message: `IndexedDB error: ${err.message || 'Database not accessible'}` }))
    )

    // API/Server + Scoreboard check
    const checkApiServer = async () => {
      if (isStaticDeployment && !hasBackendUrl) {
        updateStatus('api', 'not_available', { status: 'not_available', message: 'API not available in static deployment (using local database only)' })
        updateStatus('server', 'not_available', { status: 'not_available', message: 'Server not available in static deployment (using local database only)' })
        updateStatus('scoreboard', 'not_available', { status: 'not_available', message: 'Server not available in static deployment (using local database only)' })
      } else if (hasBackendUrl) {
        try {
          const backendUrl = configuredBackendUrl
          const controller = new AbortController()
          const fetchTimeout = setTimeout(() => controller.abort(), 5000)
          const response = await fetch(`${backendUrl}/health`, { signal: controller.signal })
          clearTimeout(fetchTimeout)
          if (response.ok) {
            const data = await response.json()
            const apiDebug = { status: 'connected', message: `Cloud backend responding (${data.mode} mode)` }
            const serverDebug = { status: 'connected', message: `Backend healthy, ${data.connections} connections, ${data.activeRooms} active rooms` }
            updateStatus('api', 'connected', apiDebug)
            updateStatus('server', 'connected', serverDebug)
            updateStatus('scoreboard', 'connected', serverDebug)
          } else {
            const debug = { status: 'disconnected', message: `Backend returned status ${response.status}` }
            updateStatus('api', 'disconnected', debug)
            updateStatus('server', 'disconnected', debug)
            updateStatus('scoreboard', 'disconnected', debug)
          }
        } catch (err) {
          const message = err.name === 'AbortError' ? 'Backend request timed out (5s)' : `Backend unreachable: ${err.message}`
          const debug = { status: 'disconnected', message }
          updateStatus('api', 'disconnected', debug)
          updateStatus('server', 'disconnected', debug)
          updateStatus('scoreboard', 'disconnected', debug)
        }
      } else {
        try {
          const controller = new AbortController()
          const fetchTimeout = setTimeout(() => controller.abort(), 5000)
          // A health check: /api/server/status (every relay has it), not the
          // match list, which grows with every published match
          const response = await fetch('/api/server/status', { signal: controller.signal })
          clearTimeout(fetchTimeout)
          if (response.ok) {
            updateStatus('api', 'connected', { status: 'connected', message: 'API endpoint responding' })
            updateStatus('server', 'connected', { status: 'connected', message: 'Server is reachable' })
            updateStatus('scoreboard', 'connected', { status: 'connected', message: 'Server is reachable' })
          } else {
            const debug = { status: 'disconnected', message: `API returned status ${response.status}: ${response.statusText}` }
            updateStatus('api', 'disconnected', debug)
            updateStatus('server', 'disconnected', debug)
            updateStatus('scoreboard', 'disconnected', debug)
          }
        } catch (err) {
          const errMsg = err.name === 'AbortError'
            ? 'Server request timed out (5s)'
            : import.meta.env.DEV
              ? `Network error: ${err.message || 'Failed to connect to API'}`
              : 'Server not available (running in standalone mode)'
          const debug = { status: 'disconnected', message: errMsg }
          updateStatus('api', 'disconnected', debug)
          updateStatus('server', 'disconnected', debug)
          updateStatus('scoreboard', 'disconnected', debug)
        }
      }
    }
    asyncChecks.push(checkApiServer())

    // Relay check: the app's own relay socket when it is open, else an HTTP
    // GET /api/server/status (as RefereeApp/BenchApp do); no probe socket
    const checkWebSocket = async () => {
      // The url the shared scorer connection uses (scorerRelayUrl)
      const wsUrl = scorerRelayUrl({ wsPort: relayWsPort })
      const debug = await relayConnectionStatus({ wsUrl, ws: scorerRelay.socket })
      updateStatus('websocket', debug.status, debug)
    }
    asyncChecks.push(checkWebSocket())

    await Promise.all(asyncChecks)
  }, [updateConnectionStatus, relayWsPort])

  // Periodically check connection statuses
  useEffect(() => {
    checkConnectionStatuses()
    const interval = setInterval(checkConnectionStatuses, 30000) // Check every 30 seconds
    return () => clearInterval(interval)
  }, [checkConnectionStatuses])

  // Show startup connectivity popup when toggling from offline to online
  const prevOfflineModeRef = useRef(offlineMode)
  useEffect(() => {
    if (prevOfflineModeRef.current === true && offlineMode === false) {
      setShowStartupConnectivity(true)
      checkConnectionStatuses()
    }
    prevOfflineModeRef.current = offlineMode
  }, [offlineMode, checkConnectionStatuses])

  const handleStartupGoOffline = useCallback(() => {
    setOfflineMode(true)
    localStorage.setItem('offlineMode', 'true')
    setShowStartupConnectivity(false)
  }, [])

  const handleStartupDismiss = useCallback(() => {
    setShowStartupConnectivity(false)
  }, [])

  const currentTestMatch = useLiveQuery(async () => {
    try {
      const matches = await db.matches.orderBy('createdAt').reverse().toArray()
      const testMatch = matches.find(m => m.test === true && m.status !== 'final')
      // Return test match if it exists, regardless of setup status
      return testMatch || null
    } catch (error) {
      console.error('Unable to load test match', error)
      return null
    }
  }, [])

  // Get match status and details
  const matchStatus = useLiveQuery(async () => {
    if (!currentMatch) return null

    // For test matches that have been restarted (no signatures, only initial set, no events), don't show status
    if (currentMatch.test === true) {
      const hasSignatures = currentMatch.homeCoachSignature ||
        currentMatch.homeCaptainSignature ||
        currentMatch.awayCoachSignature ||
        currentMatch.awayCaptainSignature

      if (!hasSignatures) {
        const sets = await db.sets.where('matchId').equals(currentMatch.id).toArray()
        const events = await db.events.where('matchId').equals(currentMatch.id).toArray()
        // If only initial set exists and no events, it's been restarted - don't show status
        if (sets.length === 1 && events.length === 0) {
          return null
        }
      }
    }

    const homeTeamPromise = currentMatch.homeTeamId ? db.teams.get(currentMatch.homeTeamId) : Promise.resolve(null)
    const awayTeamPromise = currentMatch.awayTeamId ? db.teams.get(currentMatch.awayTeamId) : Promise.resolve(null)

    const setsPromise = db.sets.where('matchId').equals(currentMatch.id).toArray()
    const eventsPromise = db.events.where('matchId').equals(currentMatch.id).toArray()
    const homePlayersPromise = currentMatch.homeTeamId
      ? db.players.where('teamId').equals(currentMatch.homeTeamId).count()
      : Promise.resolve(0)
    const awayPlayersPromise = currentMatch.awayTeamId
      ? db.players.where('teamId').equals(currentMatch.awayTeamId).count()
      : Promise.resolve(0)

    const [homeTeam, awayTeam, sets, events, homePlayers, awayPlayers] = await Promise.all([
      homeTeamPromise,
      awayTeamPromise,
      setsPromise,
      eventsPromise,
      homePlayersPromise,
      awayPlayersPromise
    ])

    const signaturesComplete = Boolean(
      currentMatch.homeCoachSignature &&
      currentMatch.homeCaptainSignature &&
      currentMatch.awayCoachSignature &&
      currentMatch.awayCaptainSignature
    )

    const infoConfigured = Boolean(
      (currentMatch.scheduledAt && String(currentMatch.scheduledAt).trim() !== '') ||
      (currentMatch.city && String(currentMatch.city).trim() !== '') ||
      (currentMatch.hall && String(currentMatch.hall).trim() !== '') ||
      (currentMatch.league && String(currentMatch.league).trim() !== '')
    )

    const rostersReady = homePlayers >= 6 && awayPlayers >= 6
    const matchReadyForPlay = infoConfigured && signaturesComplete && rostersReady

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

    let status = 'No data'
    if (currentMatch.status === 'final' || (sets.length > 0 && sets.every(s => s.finished))) {
      status = 'Match ended'
    } else if ((currentMatch.status === 'live' || hasActiveSet || hasEventActivity) && matchReadyForPlay) {
      status = 'Match recording'
    } else if (homePlayers > 0 || awayPlayers > 0 || currentMatch.homeCoachSignature || currentMatch.awayCoachSignature) {
      if (signaturesComplete) {
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

  // Query for match info menu (teams for active match or home view)
  const matchInfoData = useLiveQuery(async () => {
    // For active match
    if (matchId && currentMatch) {
      const homeTeamPromise = currentMatch.homeTeamId ? db.teams.get(currentMatch.homeTeamId) : Promise.resolve(null)
      const awayTeamPromise = currentMatch.awayTeamId ? db.teams.get(currentMatch.awayTeamId) : Promise.resolve(null)
      const [homeTeam, awayTeam] = await Promise.all([homeTeamPromise, awayTeamPromise])
      return {
        homeTeam,
        awayTeam,
        match: currentMatch
      }
    }

    // For home view (use currentOfficialMatch or currentTestMatch)
    if (!matchId) {
      const matchToUse = currentOfficialMatch || currentTestMatch
      if (matchToUse) {
        const homeTeamPromise = matchToUse.homeTeamId ? db.teams.get(matchToUse.homeTeamId) : Promise.resolve(null)
        const awayTeamPromise = matchToUse.awayTeamId ? db.teams.get(matchToUse.awayTeamId) : Promise.resolve(null)
        const [homeTeam, awayTeam] = await Promise.all([homeTeamPromise, awayTeamPromise])
        return {
          homeTeam,
          awayTeam,
          match: matchToUse
        }
      }
    }

    return null
  }, [matchId, currentMatch, currentOfficialMatch, currentTestMatch])

  const restoredRef = useRef(false)

  // Preload the ball images when app loads
  useEffect(() => {
    const imagesToPreload = [ballImage, ballFallback]

    imagesToPreload.forEach(src => {
      // Preload the image
      const img = new Image()
      img.src = src

      // Also add a preload link to the document head for early loading
      const link = document.createElement('link')
      link.rel = 'preload'
      link.as = 'image'
      link.href = src
      document.head.appendChild(link)
    })

    return () => {
      // Cleanup: remove preload links if component unmounts
      imagesToPreload.forEach(src => {
        const existingLink = document.querySelector(`link[href="${src}"]`)
        if (existingLink) {
          document.head.removeChild(existingLink)
        }
      })
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

    // Android app: the Back button is MainActivity's (it goes back in real
    // history, e.g. out of the scoresheet's in-app view, and on the first
    // page asks "Exit OpenVolley?", utils/appLifecycle.js). An entry pushed
    // here would make WebView.canGoBack() true, and Back then only replayed
    // this block instead of asking.
    const blockHistory = detectAppPlatform() !== 'capacitor'

    // Push initial state to prevent back navigation
    if (blockHistory) {
      try {
        history.pushState(null, '', window.location.href)
      } catch (err) {
        // Ignore history errors (e.g., older browsers or restricted environments)
      }

      // Prevent browser back/forward buttons
      window.addEventListener('popstate', blockHistoryNavigation)
    }

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

  // Check for pending roster upload on mount
  useEffect(() => {
    if (!currentMatch) return

    // Check if there are pending rosters
    const hasPendingHomeRoster = currentMatch.pendingHomeRoster !== null && currentMatch.pendingHomeRoster !== undefined
    const hasPendingAwayRoster = currentMatch.pendingAwayRoster !== null && currentMatch.pendingAwayRoster !== undefined

    // If there are pending rosters and we're not already in match setup, open it
    if ((hasPendingHomeRoster || hasPendingAwayRoster) && !showMatchSetup) {
      setMatchId(currentMatch.id)
      setShowMatchSetup(true)
    }
  }, [currentMatch, matchId, showMatchSetup])

  // Update document title based on match type
  useEffect(() => {
    if (!currentMatch) {
      document.title = 'OpenVolley eScoresheet'
      return
    }

    const isTestMatch = currentMatch.test === true

    if (isTestMatch) {
      // Test matches don't have a game number - just show base title
      document.title = 'OpenVolley eScoresheet'
    } else {
      // Official match - show game number only
      const gameNumber = currentMatch.externalId || 'Official match'
      document.title = `OpenVolley eScoresheet - ${gameNumber}`
    }
  }, [currentMatch])

  // The match on the relay (referee / bench / livescore follow it there), from
  // any view. One relay connection per scorer, shared with the Scoreboard
  // (utils/relayPublisher scorerRelay): one socket owns the match, so the two
  // no longer refuse each other. Refs keep the socket from being rebuilt.
  const syncIntervalRef = useRef(null)
  const currentMatchIdRef = useRef(null)
  const currentMatchRef = useRef(null)
  // The relay key this device last published its current match under
  const publishedRelayKeyRef = useRef(null)
  // The effect's sync, to publish at once when the match gets its seed key
  const relaySyncRef = useRef(null)

  // Update currentMatch ref whenever it changes
  useEffect(() => {
    currentMatchRef.current = currentMatch
  }, [currentMatch])

  // A blank match is not published (no seed key, see relayMatchKey): publish
  // it as soon as Create Match gives it one, not after the 30 s backup sync.
  const currentRelayKey = relayMatchKey(currentMatch)
  useEffect(() => {
    if (currentRelayKey && relaySyncRef.current) relaySyncRef.current()
  }, [currentRelayKey])

  // A role let in or out (Connect tablets, Match setup) or a new PIN: tell
  // the relay at once, not after the 30 s backup sync. The relay checks the
  // PINs itself, so until then a tablet just let in was told its right PIN
  // is wrong (and each retry counted toward the per-minute PIN limit), and
  // one just switched off could still get in. An open Scoreboard syncs on
  // these changes itself; a second sync of the same data is harmless.
  const relayAccessSignature = currentMatch
    ? [
        currentMatch.refereeConnectionEnabled, currentMatch.homeTeamConnectionEnabled, currentMatch.awayTeamConnectionEnabled,
        currentMatch.refereePin, currentMatch.homeTeamPin, currentMatch.awayTeamPin
      ].map(v => String(v ?? '')).join('|')
    : null
  useEffect(() => {
    if (relayAccessSignature != null && relaySyncRef.current) relaySyncRef.current()
  }, [relayAccessSignature])

  useEffect(() => {
    // Keep the match on the relay even on the home screen (for dashboards).
    // Use matchId or fall back to currentMatch?.id for background sync
    const activeMatchId = matchId || currentMatch?.id
    if (!activeMatchId || !currentMatch) {
      currentMatchIdRef.current = null
      return
    }
    currentMatchIdRef.current = activeMatchId

    // The relay the Scoreboard and the tablets use (backendConfig)
    const wsUrl = scorerRelayUrl({ wsPort: serverStatus?.wsPort })
    if (!wsUrl) return // page opened from disk: no relay

    // Relay room key of the current match (its seed key; null before it has one)
    const relayKeyOfCurrent = () => relayMatchKey(currentMatchRef.current)

    // The match for the relay: never game_pin / connection_pins. `mark`: the
    // live-state order marked before the IndexedDB reads (applyNewerLiveState)
    const relayMatchOf = (match, mark) => relayMatchPayload(match, null, { mark }).match

    // What an unauthenticated caller may learn about the match (no PINs)
    const publicMatchSummary = (m) => ({
      id: m.id,
      seed_key: m.seed_key,
      gameNumber: m.gameNumber,
      game_n: m.game_n,
      status: m.status,
      scheduledAt: m.scheduledAt,
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
      refereeConnectionEnabled: m.refereeConnectionEnabled,
      homeTeamConnectionEnabled: m.homeTeamConnectionEnabled,
      awayTeamConnectionEnabled: m.awayTeamConnectionEnabled
    })

    const syncMatchData = async () => {
      // Use current values from refs
      const ws = scorerRelay.socket
      const currentActiveMatchId = currentMatchIdRef.current
      const currentMatchData = currentMatchRef.current // Use ref to get latest value

      if (!ws || ws.readyState !== WebSocket.OPEN || !currentMatchData || currentActiveMatchId !== activeMatchId) {
        return
      }
      // No seed key yet (blank match before Create Match): nothing a tablet
      // could join, and a Dexie id is no room key (see relayMatchKey)
      const relayKey = relayMatchKey(currentMatchData)
      if (!relayKey) return

      try {
        // Before the reads: a live state numbered after this mark is newer
        // than what this sync carries (applyNewerLiveState on the tablets)
        const syncMark = scorerLiveOrder.mark()
        // Load full match data
        const [homeTeam, awayTeam, sets, events, homePlayers, awayPlayers] = await Promise.all([
          currentMatchData.homeTeamId ? db.teams.get(currentMatchData.homeTeamId) : null,
          currentMatchData.awayTeamId ? db.teams.get(currentMatchData.awayTeamId) : null,
          db.sets.where('matchId').equals(currentActiveMatchId).sortBy('index'),
          db.events.where('matchId').equals(currentActiveMatchId).toArray(),
          currentMatchData.homeTeamId ? db.players.where('teamId').equals(currentMatchData.homeTeamId).sortBy('number') : [],
          currentMatchData.awayTeamId ? db.players.where('teamId').equals(currentMatchData.awayTeamId).sortBy('number') : []
        ])

        if (scorerRelay.socket !== ws || relayMatchKey(currentMatchRef.current) !== relayKey) return

        // Another match than the one published before (the scorer switched
        // matches): take that one off the relay, this socket owns it
        const previousKey = publishedRelayKeyRef.current
        if (previousKey && previousKey !== relayKey) {
          scorerRelay.send({ type: 'delete-match', matchId: previousKey })
        }

        // Full match object - scoreboard is source of truth, always overwrite.
        // PINs only on this connection's first sync of the key and when one
        // changed; never game_pin / connection_pins (see relayMatchPayload).
        const { match: fullMatch, commit: commitPins } = scorerRelay.pins.payloadFor(ws, currentMatchData, relayKey, syncMark)

        // Sync full match data to server - this ALWAYS overwrites existing data (scoreboard is source of truth)
        // The relay keys the room by the seed_key (what the tablets know).
        const syncPayload = {
          type: 'sync-match-data',
          matchId: relayKey,
          match: fullMatch,
          homeTeam,
          awayTeam,
          homePlayers,
          awayPlayers,
          sets,
          events
        }

        // Periodic sync - don't log every time to reduce noise

        ws.send(JSON.stringify(syncPayload))
        commitPins()
        publishedRelayKeyRef.current = relayKey
      } catch (err) {
        console.error('[App WebSocket] Error syncing match data:', err)
      }
    }

    const handlePinValidationRequest = async (request) => {
      const ws = scorerRelay.socket
      const currentActiveMatchId = currentMatchIdRef.current
      const currentMatchData = currentMatchRef.current // Use ref to get latest value

      if (!ws || ws.readyState !== WebSocket.OPEN || !currentMatchData) return

      try {
        const { pin, pinType, requestId } = request
        const pinStr = String(pin).trim()

        let matchPin = null
        let connectionEnabled = false

        if (pinType === 'referee') {
          matchPin = currentMatchData.refereePin
          connectionEnabled = currentMatchData.refereeConnectionEnabled === true
        } else if (pinType === 'homeTeam') {
          matchPin = currentMatchData.homeTeamPin
          connectionEnabled = currentMatchData.homeTeamConnectionEnabled === true
        } else if (pinType === 'awayTeam') {
          matchPin = currentMatchData.awayTeamPin
          connectionEnabled = currentMatchData.awayTeamConnectionEnabled === true
        }

        if (matchPin && String(matchPin).trim() === pinStr && connectionEnabled && currentMatchData.status !== 'final') {
          // Current relays validate PINs themselves and never ask. An older one
          // relays this to whoever typed ONE PIN: a PIN-free summary only.
          ws.send(JSON.stringify({
            type: 'pin-validation-response',
            requestId,
            success: true,
            match: publicMatchSummary(currentMatchData)
          }))
        } else {
          ws.send(JSON.stringify({
            type: 'pin-validation-response',
            requestId,
            success: false,
            error: connectionEnabled === false ? 'Connection is disabled' : 'Invalid PIN code'
          }))
        }
      } catch (err) {
        console.error('[App WebSocket] Error handling PIN validation:', err)
      }
    }

    const handleMatchDataRequest = async (request) => {
      const ws = scorerRelay.socket
      const currentActiveMatchId = currentMatchIdRef.current
      const currentMatchData = currentMatchRef.current // Use ref to get latest value

      if (!ws || ws.readyState !== WebSocket.OPEN || !currentMatchData) return

      try {
        const { requestId, matchId: requestedMatchId } = request

        // Only by the relay room key (seed_key): a Dexie id is not unique
        // across scorers, answering it would open a second, frozen room.
        const relayKey = relayMatchKey(currentMatchData)
        if (!relayKey || String(requestedMatchId) !== relayKey) {
          ws.send(JSON.stringify({
            type: 'match-data-response',
            requestId,
            matchId: requestedMatchId,
            success: false,
            error: 'Match ID mismatch'
          }))
          return
        }

        const syncMark = scorerLiveOrder.mark()
        const [homeTeam, awayTeam, sets, events, homePlayers, awayPlayers] = await Promise.all([
          currentMatchData.homeTeamId ? db.teams.get(currentMatchData.homeTeamId) : null,
          currentMatchData.awayTeamId ? db.teams.get(currentMatchData.awayTeamId) : null,
          db.sets.where('matchId').equals(currentActiveMatchId).sortBy('index'),
          db.events.where('matchId').equals(currentActiveMatchId).toArray(),
          currentMatchData.homeTeamId ? db.players.where('teamId').equals(currentMatchData.homeTeamId).sortBy('number') : [],
          currentMatchData.awayTeamId ? db.players.where('teamId').equals(currentMatchData.awayTeamId).sortBy('number') : []
        ])

        ws.send(JSON.stringify({
          type: 'match-data-response',
          requestId,
          matchId: relayKey,
          success: true,
          matchData: {
            match: relayMatchOf(currentMatchData, syncMark),
            homeTeam,
            awayTeam,
            homePlayers,
            awayPlayers,
            sets,
            events
          }
        }))
      } catch (err) {
        console.error('[App WebSocket] Error handling match data request:', err)
      }
    }

    const handleGameNumberRequest = async (request) => {
      const ws = scorerRelay.socket
      const currentMatchData = currentMatchRef.current // Use ref to get latest value

      if (!ws || ws.readyState !== WebSocket.OPEN || !currentMatchData) return

      try {
        const { requestId, gameNumber } = request
        const gameNumStr = String(gameNumber).trim()
        const matchGameNumber = String(currentMatchData.gameNumber || '')
        const matchGameN = String(currentMatchData.game_n || '')
        const matchIdStr = String(currentMatchData.id || '')
        const relayKey = relayMatchKey(currentMatchData)

        if (relayKey && (matchGameNumber === gameNumStr || matchGameN === gameNumStr || matchIdStr === gameNumStr)) {
          // PIN-free summary: the relay hands this to an unauthenticated caller.
          // matchId is the room key the relay stores the match under.
          ws.send(JSON.stringify({
            type: 'game-number-response',
            requestId,
            success: true,
            match: publicMatchSummary(currentMatchData),
            matchId: relayKey
          }))
        } else {
          ws.send(JSON.stringify({
            type: 'game-number-response',
            requestId,
            success: false,
            error: 'Match not found'
          }))
        }
      } catch (err) {
        console.error('[App WebSocket] Error handling game number request:', err)
      }
    }

    // Removed handleMatchUpdateRequest - using sync-match-data instead

    // (No 'clear-all-matches' on open or on cleanup: a fresh socket owns
    // nothing, and the one socket also carries the Scoreboard's match.)
    const detachRelay = scorerRelay.attach(wsUrl, {
      onOpen: () => {
        syncMatchData()
        // Periodic sync as backup only (every 30 seconds), without PINs
        // unless one changed. Primary sync happens in the Scoreboard: while it
        // is open (attached too) it syncs every action itself.
        if (syncIntervalRef.current) clearInterval(syncIntervalRef.current)
        syncIntervalRef.current = setInterval(() => {
          if (scorerRelay.userCount === 1) syncMatchData()
        }, 30000)
      },
      onMessage: (message) => {
        if (message.type === 'pin-validation-request') {
          handlePinValidationRequest(message)
        } else if (message.type === 'match-data-request') {
          handleMatchDataRequest(message)
        } else if (message.type === 'game-number-request') {
          handleGameNumberRequest(message)
        } else if (isRelayErrorFor(message, [relayKeyOfCurrent()])) {
          // The relay refused or lost this match: the next sync carries the PINs
          scorerRelay.pins.reset()
          // (an open Scoreboard resyncs itself)
          if (message.code === 'pins-required' && scorerRelay.userCount === 1) syncMatchData()
        }
      }
    })
    relaySyncRef.current = syncMatchData

    return () => {
      relaySyncRef.current = null
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
        syncIntervalRef.current = null
      }
      detachRelay()
    }
  }, [matchId, currentMatch?.id, serverStatus?.wsPort]) // Only depend on matchId and wsPort, not the full objects

  async function finishSet(cur) {
    const matchRecord = await db.matches.get(cur.matchId)
    const isTestMatch = matchRecord?.test === true

    // Calculate current set scores
    const sets = await db.sets.where({ matchId: cur.matchId }).toArray()
    const finishedSets = sets.filter(s => s.finished)
    const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
    const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length

    // Match end: a team has won enough sets, OR the scoreboard already ended the
    // match (forfeit / impossibility to resume set status 'ended' without the
    // sets being won). Either way no further set may be created.
    const isMatchEnd = isMatchFinishedUtil(homeSetsWon, awaySetsWon, matchRecord?.bestOf) ||
      matchRecord?.status === 'ended'

    if (isMatchEnd) {
      // IMPORTANT: When match ends, preserve ALL data in database:
      // - All sets remain in db.sets
      // - All events remain in db.events
      // - All players remain in db.players
      // - All teams remain in db.teams
      // - Set status to 'ended' - MatchEnd component will set to 'approved' after approval
      // Status flow: live -> ended -> approved

      // Unlock session when match ends
      try {
        await unlockMatchSession(cur.matchId)
      } catch (error) {
        console.error('Error unlocking session:', error)
      }

      // Update local match status to 'ended' (may already be set by Scoreboard)
      await db.matches.update(cur.matchId, { status: 'ended' })

      // Only sync official matches with seed_key
      if (!isTestMatch && matchRecord?.seed_key) {
        // Build set results array
        const setResults = finishedSets
          .sort((a, b) => a.index - b.index)
          .map(s => ({ set: s.index, home: s.homePoints, away: s.awayPoints }))

        // Determine winner (null for a match stopped without a winner)
        const winner = getMatchWinner(sets, matchRecord?.bestOf, { forfeitTeam: matchRecord?.forfeitTeam })
        const finalScore = `${homeSetsWon}-${awaySetsWon}`

        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: matchRecord.seed_key, // Use seed_key (external_id) for Supabase lookup
            status: 'ended', // Match ended, awaiting approval
            set_results: setResults,
            winner,
            final_score: finalScore,
            sanctions: matchRecord?.sanctions || null
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }

      // The match stays on the relay: the referee and bench keep showing the
      // result. (The 'delete-match' sent here named the Dexie id, which is no
      // relay key: the relay refused it as not this socket's match.)

      // Show match end screen
      setShowMatchEnd(true)
      return
    }

    // Continue to next set (legacy logic - shouldn't reach here with new logic;
    // the Scoreboard creates the next set itself). Never duplicate a set, and keep
    // the best-of-3 2 -> 5 jump.
    const nextIndex = getNextSetIndex(cur.index, homeSetsWon, awaySetsWon, matchRecord?.bestOf)
    if (sets.some(s => s.index === nextIndex)) return
    const setId = await db.sets.add({ matchId: cur.matchId, index: nextIndex, homePoints: 0, awayPoints: 0, finished: false })

    // Only sync official matches with seed_key
    if (!isTestMatch && matchRecord?.seed_key) {
      await db.sync_queue.add({
        resource: 'set',
        action: 'insert',
        payload: {
          external_id: setExtId(matchRecord.seed_key, setId),
          match_id: matchRecord.seed_key, // Use seed_key (external_id) for Supabase lookup
          index: nextIndex,
          home_points: 0,
          away_points: 0,
          finished: false,
          start_time: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })
    }
  }

  const openMatchSetup = () => {
    setMatchId(null)
    setShowManualAdjustments(false)
  }

  const openMatchSetupView = () => setShowMatchSetup(true)

  const openCoinTossView = () => {
    setShowMatchSetup(false)
    setShowCoinToss(true)
  }

  const returnToMatch = () => setShowMatchSetup(false)

  const goHome = async () => {
    // Unlock session if match was open
    if (matchId) {
      try {
        await unlockMatchSession(matchId)
      } catch (error) {
        console.error('Error unlocking session:', error)
      }
    }
    setMatchId(null)
    setShowMatchSetup(false)
    setShowManualAdjustments(false)
  }

  async function clearLocalTestData() {
    await db.transaction('rw', db.events, db.event_history, db.sets, db.matches, db.players, db.teams, async () => {
      const testMatches = await db.matches
        .filter(m => m.test === true || m.externalId === TEST_MATCH_EXTERNAL_ID)
        .toArray()
      for (const match of testMatches) {
        // a wipe, not an undo: no event history (db/eventHistory)
        await wipeMatchEvents(db, match.id, { dropHistory: true })
        await db.sets.where('matchId').equals(match.id).delete()
        await db.matches.delete(match.id)
      }

      const testTeams = await db.teams
        .filter(
          t =>
            t.externalId === TEST_HOME_TEAM_EXTERNAL_ID ||
            t.externalId === TEST_AWAY_TEAM_EXTERNAL_ID ||
            (t.seedKey && t.seedKey.startsWith('test-'))
        )
        .toArray()

      for (const team of testTeams) {
        await db.players.where('teamId').equals(team.id).delete()
        await db.teams.delete(team.id)
      }
    })

  }

  async function resetSupabaseTestMatch() {
    const { data: matchRecord, error: matchLookupError } = await apiFrom('matches')
      .select('id')
      .eq('external_id', TEST_MATCH_EXTERNAL_ID)
      .single()

    if (matchLookupError) {
      throw new Error(matchLookupError.message)
    }
    if (!matchRecord) {
      throw new Error('Test match not found on Supabase.')
    }

    const matchUuid = matchRecord.id

    const { error: deleteEventsError } = await apiFrom('events')
      .delete()
      .eq('match_id', matchUuid)
    if (deleteEventsError) {
      throw new Error(deleteEventsError.message)
    }

    const { error: deleteSetsError } = await apiFrom('sets')
      .delete()
      .eq('match_id', matchUuid)
    if (deleteSetsError) {
      throw new Error(deleteSetsError.message)
    }

    const newScheduled = getNextTestMatchStartTime()
    const { error: updateMatchError } = await apiFrom('matches')
      .update({
        status: 'scheduled',
        scheduled_at: newScheduled,
        updated_at: new Date().toISOString()
      })
      .eq('id', matchUuid)

    if (updateMatchError) {
      throw new Error(updateMatchError.message)
    }
  }

  async function loadTestMatchFromSupabase({ resetRemote = false, targetView = 'setup' } = {}) {
    if (resetRemote) {
      await resetSupabaseTestMatch()
    }

    const { data: matchData, error: matchError } = await apiFrom('matches')
      .select('*')
      .eq('external_id', TEST_MATCH_EXTERNAL_ID)
      .single()

    if (matchError) {
      throw new Error(matchError.message)
    }
    if (!matchData) {
      throw new Error('Test match not found on Supabase.')
    }


    const [homeTeamRes, awayTeamRes] = await Promise.all([
      apiFrom('teams').select('*').eq('id', matchData.home_team_id).single(),
      apiFrom('teams').select('*').eq('id', matchData.away_team_id).single()
    ])

    if (homeTeamRes.error) {
      throw new Error(homeTeamRes.error.message)
    }
    if (awayTeamRes.error) {
      throw new Error(awayTeamRes.error.message)
    }

    const homeTeamData = homeTeamRes.data
    const awayTeamData = awayTeamRes.data


    const { data: playersData, error: playersError } = await apiFrom('players')
      .select('*')
      .in('team_id', [matchData.home_team_id, matchData.away_team_id])

    if (playersError) {
      throw new Error(playersError.message)
    }

    const { data: setsData, error: setsError } = await apiFrom('sets')
      .select('*')
      .eq('match_id', matchData.id)
      .order('index')

    if (setsError) {
      throw new Error(setsError.message)
    }

    const { data: eventsData, error: eventsError } = await apiFrom('events')
      .select('*')
      .eq('match_id', matchData.id)
      .order('ts')

    if (eventsError) {
      throw new Error(eventsError.message)
    }

    await clearLocalTestData()

    const normalizeBenchMember = member => ({
      role: member?.role || '',
      firstName: member?.firstName || member?.first_name || '',
      lastName: member?.lastName || member?.last_name || '',
      dob: member?.dob || member?.date_of_birth || member?.dateOfBirth || ''
    })

    const homeBenchRaw = Array.isArray(homeTeamData?.bench_staff)
      ? homeTeamData.bench_staff
      : Array.isArray(matchData.bench_home)
        ? matchData.bench_home
        : TEST_HOME_BENCH

    const awayBenchRaw = Array.isArray(awayTeamData?.bench_staff)
      ? awayTeamData.bench_staff
      : Array.isArray(matchData.bench_away)
        ? matchData.bench_away
        : TEST_AWAY_BENCH

    const homeBench = (() => {
      const normalized = homeBenchRaw.map(normalizeBenchMember)
      const hasNamedMember = normalized.some(member => member.firstName || member.lastName)
      return hasNamedMember ? normalized : TEST_HOME_BENCH.map(normalizeBenchMember)
    })()

    const awayBench = (() => {
      const normalized = awayBenchRaw.map(normalizeBenchMember)
      const hasNamedMember = normalized.some(member => member.firstName || member.lastName)
      return hasNamedMember ? normalized : TEST_AWAY_BENCH.map(normalizeBenchMember)
    })()

    const homeTeamId = await db.teams.add({
      name: homeTeamData?.name || 'Home',
      shortName: homeTeamData?.short_name || getTestHomeTeamShortName(),
      color: homeTeamData?.color || '#3b82f6',
      seedKey: homeTeamData?.seed_key || TEST_HOME_TEAM_EXTERNAL_ID,
      externalId: homeTeamData?.external_id || TEST_HOME_TEAM_EXTERNAL_ID,
      benchStaff: homeBench,
      test: true,
      createdAt: homeTeamData?.created_at || new Date().toISOString()
    })

    const awayTeamId = await db.teams.add({
      name: awayTeamData?.name || 'Away',
      shortName: awayTeamData?.short_name || getTestAwayTeamShortName(),
      color: awayTeamData?.color || '#ef4444',
      seedKey: awayTeamData?.seed_key || TEST_AWAY_TEAM_EXTERNAL_ID,
      externalId: awayTeamData?.external_id || TEST_AWAY_TEAM_EXTERNAL_ID,
      benchStaff: awayBench,
      test: true,
      createdAt: awayTeamData?.created_at || new Date().toISOString()
    })

    const normalizePlayer = (player, teamId) => ({
      teamId,
      number: player.number,
      name: `${player.last_name || ''} ${player.first_name || ''}`.trim(),
      lastName: player.last_name || '',
      firstName: player.first_name || '',
      dob: player.dob || '',
      libero: player.libero || '',
      isCaptain: player.is_captain || false,
      functions: Array.isArray(player.functions) && player.functions.length > 0 ? player.functions : ['player'],
      test: player.test ?? true,
      createdAt: player.created_at || new Date().toISOString(),
      externalId: player.external_id
    })

    const buildFallbackPlayers = (externalId) => {
      const teamSeed = getTestTeamByExternalId(externalId)
      if (!teamSeed) return []
      return teamSeed.players.map(player => ({
        team_id: null,
        number: player.number,
        first_name: player.firstName,
        last_name: player.lastName,
        dob: player.dob,
        libero: player.libero || '',
        is_captain: player.isCaptain || false,
        is_lfp: player.isLfp || false,
        functions: player.functions || (player.libero ? ['player'] : ['player'])
      }))
    }

    let homePlayersData = (playersData || []).filter(p => p.team_id === matchData.home_team_id)
    if (!homePlayersData.length) {
      homePlayersData = buildFallbackPlayers(TEST_HOME_TEAM_EXTERNAL_ID)
      console.warn('[TestMatch] Supabase returned no home players, using fallback seed roster')
    }

    let awayPlayersData = (playersData || []).filter(p => p.team_id === matchData.away_team_id)
    if (!awayPlayersData.length) {
      awayPlayersData = buildFallbackPlayers(TEST_AWAY_TEAM_EXTERNAL_ID)
      console.warn('[TestMatch] Supabase returned no away players, using fallback seed roster')
    }

    const fetchOfficialByExternalId = async (table, externalId) => {
      if (!externalId) return null
      const { data, error } = await apiFrom(table).select('first_name,last_name,country,dob').eq('external_id', externalId).maybeSingle()
      if (error) {
        console.warn(`Unable to load ${table} ${externalId}:`, error.message)
        return null
      }
      return data
    }

    const resolvedOfficials = async () => {
      const officialTemplates = [
        {
          role: '1st referee',
          table: 'referees',
          defaultExternalId: 'test-referee-alpha',
          fallback: TEST_REFEREE_SEED_DATA[0] || {}
        },
        {
          role: '2nd referee',
          table: 'referees',
          defaultExternalId: 'test-referee-bravo',
          fallback: TEST_REFEREE_SEED_DATA[1] || TEST_REFEREE_SEED_DATA[0] || {}
        },
        {
          role: 'scorer',
          table: 'scorers',
          defaultExternalId: 'test-scorer-alpha',
          fallback: TEST_SCORER_SEED_DATA[0] || {}
        },
        {
          role: 'assistant scorer',
          table: 'scorers',
          defaultExternalId: 'test-scorer-bravo',
          fallback: TEST_SCORER_SEED_DATA[1] || TEST_SCORER_SEED_DATA[0] || {}
        }
      ]

      const sourceOfficials = Array.isArray(matchData.officials) ? matchData.officials : []

      const normalizeOfficialEntry = async (template) => {
        const record = sourceOfficials.find(o => o.role === template.role) || {}
        const externalId = record.external_id || record.externalId || template.defaultExternalId

        let fetched = null
        if (externalId && (!record.firstName && !record.lastName) && (!record.first_name && !record.last_name)) {
          fetched = await fetchOfficialByExternalId(template.table, externalId)
        }

        const firstName = record.firstName || record.first_name || fetched?.first_name || template.fallback.firstName || ''
        const lastName = record.lastName || record.last_name || fetched?.last_name || template.fallback.lastName || ''
        const country = record.country || fetched?.country || template.fallback.country || 'CHE'
        const dob = record.dob || fetched?.dob || template.fallback.dob || '01.01.1900'

        return {
          role: template.role,
          firstName,
          lastName,
          country,
          dob,
          externalId
        }
      }

      const results = await Promise.all(officialTemplates.map(normalizeOfficialEntry))
      const missingNames = results.filter(o => !o.firstName || !o.lastName)

      if (missingNames.length === 0) {
        return results
      }

      // As a safety fallback, merge with seed data for any remaining blanks
      return results.map(entry => {
        if (entry.firstName && entry.lastName) return entry
        const fallback = officialTemplates.find(t => t.role === entry.role)?.fallback || {}
        return {
          ...entry,
          firstName: entry.firstName || fallback.firstName || '',
          lastName: entry.lastName || fallback.lastName || '',
          country: entry.country || fallback.country || 'CHE',
          dob: entry.dob || fallback.dob || '01.01.1900'
        }
      })
    }

    const officials = await resolvedOfficials()

    if (homePlayersData.length) {
      await db.players.bulkAdd(homePlayersData.map(p => normalizePlayer(p, homeTeamId)))
    }
    if (awayPlayersData.length) {
      await db.players.bulkAdd(awayPlayersData.map(p => normalizePlayer(p, awayTeamId)))
    }

    // Extract JSONB data with fallback to legacy columns
    const matchInfo = matchData.match_info || {}
    const coinToss = matchData.coin_toss || {}
    const signatures = matchData.signatures || {}
    const connections = matchData.connections || {}
    const connectionPins = matchData.connection_pins || {}

    const matchDexieId = await db.matches.add({
      status: matchData.status || 'scheduled',
      scheduledAt: matchData.scheduled_at,
      // Match info: prefer JSONB, fallback to legacy
      hall: matchInfo.hall || matchData.hall || TEST_MATCH_DEFAULTS.hall,
      city: matchInfo.city || matchData.city || TEST_MATCH_DEFAULTS.city,
      league: matchInfo.league || matchData.league || TEST_MATCH_DEFAULTS.league,
      gameNumber: matchData.game_number || TEST_MATCH_DEFAULTS.gameNumber,
      // Connection PINs: prefer JSONB, fallback to legacy
      refereePin: connectionPins.referee || matchData.referee_pin || generateRefereePin(),
      homeTeamPin: connectionPins.bench_home || matchData.bench_home_pin || null,
      awayTeamPin: connectionPins.bench_away || matchData.bench_away_pin || null,
      homeTeamUploadPin: connectionPins.upload_home || matchData.home_team_upload_pin || null,
      awayTeamUploadPin: connectionPins.upload_away || matchData.away_team_upload_pin || null,
      homeTeamId,
      awayTeamId,
      // the set boxes, rosters and the PDF's file name read them from the match
      homeShortName: homeTeamData?.short_name || getTestHomeTeamShortName(),
      awayShortName: awayTeamData?.short_name || getTestAwayTeamShortName(),
      bench_home: homeBench,
      bench_away: awayBench,
      officials,
      test: matchData.test ?? true,
      createdAt: matchData.created_at || new Date().toISOString(),
      updatedAt: matchData.updated_at || new Date().toISOString(),
      externalId: matchData.external_id,
      seedKey: newTestMatchSeedKey(),
      supabaseId: matchData.id,
      // Signatures: prefer JSONB, fallback to legacy
      homeCoachSignature: signatures.home_coach || matchData.home_coach_signature || null,
      homeCaptainSignature: signatures.home_captain || matchData.home_captain_signature || null,
      awayCoachSignature: signatures.away_coach || matchData.away_coach_signature || null,
      awayCaptainSignature: signatures.away_captain || matchData.away_captain_signature || null,
      // Coin toss: prefer JSONB, fallback to legacy
      coinTossTeamA: coinToss.team_a || matchData.coin_toss_team_a || null,
      coinTossTeamB: coinToss.team_b || matchData.coin_toss_team_b || null,
      coinTossServeA: coinToss.serve_a !== undefined ? coinToss.serve_a : (matchData.coin_toss_serve_a ?? null),
      coinTossServeB: matchData.coin_toss_serve_b ?? null,
      coinTossConfirmed: coinToss.confirmed !== undefined ? coinToss.confirmed : (matchData.coin_toss_confirmed ?? false),
      // Connection enables: prefer JSONB, fallback to legacy
      refereeConnectionEnabled: connections.referee_enabled !== undefined ? connections.referee_enabled : matchData.referee_connection_enabled,
      homeTeamConnectionEnabled: connections.home_bench_enabled !== undefined ? connections.home_bench_enabled : matchData.home_team_connection_enabled,
      awayTeamConnectionEnabled: connections.away_bench_enabled !== undefined ? connections.away_bench_enabled : matchData.away_team_connection_enabled
    })

    if (Array.isArray(setsData) && setsData.length > 0) {
      await db.sets.bulkAdd(setsData.map(set => ({
        matchId: matchDexieId,
        index: set.index ?? set.set_index ?? 1,
        homePoints: set.home_points ?? 0,
        awayPoints: set.away_points ?? 0,
        finished: set.finished ?? false,
        startTime: set.start_time || null,
        endTime: set.end_time || null,
        externalId: set.external_id,
        createdAt: set.created_at,
        updatedAt: set.updated_at
      })))
    } else {
      await db.sets.add({
        matchId: matchDexieId,
        index: 1,
        homePoints: 0,
        awayPoints: 0,
        finished: false
      })
    }

    if (Array.isArray(eventsData) && eventsData.length > 0) {
      await db.events.bulkAdd(eventsData.map(event => ({
        matchId: matchDexieId,
        setIndex: event.set_index ?? 1,
        type: event.type,
        payload: event.payload || {},
        ts: event.ts || new Date().toISOString()
      })))
    }

    setMatchId(matchDexieId)
    setShowCoinToss(false)
    setShowMatchSetup(targetView === 'setup')
  }


  const firstNames = ['Max', 'Luca', 'Tom', 'Jonas', 'Felix', 'Noah', 'David', 'Simon', 'Daniel', 'Michael', 'Anna', 'Sarah', 'Lisa', 'Emma', 'Sophie', 'Laura', 'Julia', 'Maria', 'Nina', 'Sara']
  const lastNames = ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun']

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

  function formatISODateToDisplay(dateString) {
    if (!dateString) return null
    const date = new Date(dateString)
    if (Number.isNaN(date.getTime())) {
      return dateString
    }
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
    const matchToDelete = currentOfficialMatch || currentMatch
    if (!matchToDelete) return

    const [homeTeam, awayTeam] = await Promise.all([
      matchToDelete.homeTeamId ? db.teams.get(matchToDelete.homeTeamId) : null,
      matchToDelete.awayTeamId ? db.teams.get(matchToDelete.awayTeamId) : null
    ])
    const matchName = `${homeTeam?.name || 'Home'} vs ${awayTeam?.name || 'Away'}`

    setDeletePinInput('')
    setDeletePinError('')
    setDeleteMatchModal({
      matchName,
      matchId: matchToDelete.id,
      gamePin: matchToDelete.gamePin || null
    })
  }

  async function confirmDeleteMatch() {
    if (!deleteMatchModal) return

    // Require PIN confirmation if match has a gamePin
    if (deleteMatchModal.gamePin) {
      if (!deletePinInput.trim()) {
        setDeletePinError('Please enter the game PIN to confirm deletion')
        return
      }
      if (deletePinInput.trim() !== deleteMatchModal.gamePin) {
        setDeletePinError('Incorrect PIN. Please enter the correct game PIN.')
        return
      }
    }

    const matchIdToDelete = deleteMatchModal.matchId

    // Get match before deleting to check status and seed_key
    const matchToDelete = await db.matches.get(matchIdToDelete)
    const shouldDeleteFromSupabase = matchToDelete && matchToDelete.status !== 'final' && matchToDelete.seed_key
    console.log('[Delete Match] 🗑️ Preparing to delete match:', {
      matchId: matchIdToDelete,
      status: matchToDelete?.status,
      seed_key: matchToDelete?.seed_key,
      shouldDeleteFromSupabase
    })

    await db.transaction('rw', db.matches, db.sets, db.events, db.event_history, db.players, db.teams, db.sync_queue, db.match_setup, async () => {
      console.log('[Delete Match] Starting local deletion of match:', matchIdToDelete)

      // Delete sets
      const sets = await db.sets.where('matchId').equals(matchIdToDelete).toArray()
      console.log('[Delete Match] Found', sets.length, 'sets to delete')
      if (sets.length > 0) {
        await db.sets.bulkDelete(sets.map(s => s.id))
      }

      // Delete events - use direct delete instead of bulkDelete for better reliability
      const eventsCount = await db.events.where('matchId').equals(matchIdToDelete).count()
      console.log('[Delete Match] Found', eventsCount, 'events to delete')
      // a wipe, not an undo: no event history (db/eventHistory)
      await wipeMatchEvents(db, matchIdToDelete, { dropHistory: true })

      // Get match to find team IDs
      const match = await db.matches.get(matchIdToDelete)

      // Delete players
      if (match?.homeTeamId) {
        const homePlayersCount = await db.players.where('teamId').equals(match.homeTeamId).count()
        console.log('[Delete Match] Deleting', homePlayersCount, 'home players')
        await db.players.where('teamId').equals(match.homeTeamId).delete()
      }
      if (match?.awayTeamId) {
        const awayPlayersCount = await db.players.where('teamId').equals(match.awayTeamId).count()
        console.log('[Delete Match] Deleting', awayPlayersCount, 'away players')
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
      const syncQueueCount = await db.sync_queue.count()
      console.log('[Delete Match] Clearing', syncQueueCount, 'sync queue items')
      await db.sync_queue.clear()

      // Delete match setup draft
      await db.match_setup.clear()

      // Delete match
      await db.matches.delete(matchIdToDelete)
      console.log('[Delete Match] Match deleted successfully')
    })

    // Take the match off the relay, by its room key (the seed key)
    const deletedRelayKey = relayMatchKey(matchToDelete)
    if (deletedRelayKey) {
      scorerRelay.send({ type: 'delete-match', matchId: deletedRelayKey })
      if (publishedRelayKeyRef.current === deletedRelayKey) publishedRelayKeyRef.current = null
    }

    // Delete from Supabase if match hasn't ended (not 'final')
    // This prevents clutter from test matches while preserving completed match history
    if (shouldDeleteFromSupabase) {
      try {
        await db.sync_queue.add({
          resource: 'match',
          action: 'delete',
          payload: {
            id: matchToDelete.seed_key
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
        console.log('[Delete Match] ✅ Queued Supabase delete for seed_key:', matchToDelete.seed_key)
      } catch (err) {
        console.error('[App] Error queuing Supabase match deletion:', err)
      }
    } else {
      console.log('[Delete Match] ⏭️ Skipping Supabase delete (final status or no seed_key)')
    }

    setDeleteMatchModal(null)
    setMatchId(null)
    setShowMatchSetup(false)
    setShowManualAdjustments(false)
  }

  function cancelDeleteMatch() {
    setDeleteMatchModal(null)
    setDeletePinInput('')
    setDeletePinError('')
  }

  async function createNewOfficialMatch() {
    // Check if match is ongoing
    if (matchStatus?.status === 'Match recording') {
      return // Don't allow creating new match when one is ongoing
    }

    // Check if there's a CONFIRMED match (has matchInfoConfirmedAt)
    // Unconfirmed matches (user started but didn't click "Create Match") should be silently deleted
    if (currentMatch) {
      if (currentMatch.matchInfoConfirmedAt) {
        // This is a real confirmed match - warn the user
        setNewMatchModal({
          type: 'official',
          message: t('home.modals.existingMatchWarning')
        })
        return
      } else {
        // This is an unconfirmed match - delete it silently
        console.log('[New Match] Deleting unconfirmed match:', currentMatch.id)
        await db.matches.delete(currentMatch.id)
      }
    }

    // Clear any stray draft data from previous sessions
    await db.match_setup.clear()

    // Create new blank match
    const newMatchId = await db.matches.add({
      status: 'scheduled',
      refereePin: generateRefereePin(),
      coinTossConfirmed: false,
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
      await db.transaction('rw', db.matches, db.sets, db.events, db.event_history, db.players, db.teams, db.sync_queue, db.match_setup, async () => {
        console.log('[New Match] Deleting existing match:', currentMatch.id)

        // Delete sets
        await db.sets.where('matchId').equals(currentMatch.id).delete()

        // Delete events - use direct delete for reliability
        await wipeMatchEvents(db, currentMatch.id, { dropHistory: true })

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
        console.log('[New Match] Existing match deleted')
      })
    }

    setNewMatchModal(null)

    if (newMatchModal.type === 'official') {
      // Create new blank match
      const newMatchId = await db.matches.add({
        status: 'scheduled',
        refereePin: generateRefereePin(),
        coinTossConfirmed: false,
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

  useEffect(() => {
    ensureSeedTestTeams().catch(error => {
      console.error('Failed to ensure seeded test teams:', error)
    })
    ensureSeedTestOfficials().catch(error => {
      console.error('Failed to ensure seeded officials:', error)
    })
  }, [])

  async function ensureSeedTestTeams() {
    const seededTeams = []

    await db.transaction('rw', db.teams, db.players, db.sync_queue, async () => {
      for (const definition of TEST_TEAM_SEED_DATA) {
        let team = await db.teams.filter(t => t.seedKey === definition.seedKey).first()
        const isTestSeed = definition.seedKey?.startsWith('test-')

        if (!team) {
          const timestamp = new Date().toISOString()
          const teamId = await db.teams.add({
            name: definition.name,
            shortName: definition.shortName,
            color: definition.color,
            seedKey: definition.seedKey,
            test: true,
            createdAt: timestamp
          })

          // Don't sync test seed data to Supabase - it comes from the seed script

          const playersToCreate = definition.players.map(player => ({
            teamId,
            number: player.number,
            name: `${player.lastName} ${player.firstName}`,
            lastName: player.lastName,
            firstName: player.firstName,
            dob: player.dob,
            libero: player.libero || '',
            isCaptain: player.isCaptain,
            isLfp: player.isLfp || false,
            role: null,
            test: true,
            createdAt: timestamp
          }))

          await db.players.bulkAdd(playersToCreate, undefined, { allKeys: true })
          // Don't sync test seed players to Supabase - they come from the seed script

          team = {
            id: teamId,
            name: definition.name,
            shortName: definition.shortName,
            color: definition.color,
            seedKey: definition.seedKey,
            test: true,
            createdAt: timestamp
          }
        } else {
          // Update shortName if it doesn't match the seed definition
          if (team.shortName !== definition.shortName) {
            await db.teams.update(team.id, { shortName: definition.shortName })
            team = { ...team, shortName: definition.shortName }
          }
          const playerCount = await db.players.where('teamId').equals(team.id).count()
          if (playerCount === 0) {
            const timestamp = new Date().toISOString()
            const playersToCreate = definition.players.map(player => ({
              teamId: team.id,
              number: player.number,
              name: `${player.lastName} ${player.firstName}`,
              lastName: player.lastName,
              firstName: player.firstName,
              dob: player.dob,
              libero: player.libero || '',
              isCaptain: player.isCaptain,
              isLfp: player.isLfp || false,
              role: null,
              test: true,
              createdAt: timestamp
            }))

            await db.players.bulkAdd(playersToCreate)
          }
        }

        seededTeams.push(team)
      }
    })

    return seededTeams
  }

  async function ensureSeedTestOfficials() {
    const seededReferees = []
    const seededScorers = []

    // Local Dexie records only - no Supabase sync (officials stored as JSONB in match)
    await db.transaction('rw', db.referees, db.scorers, async () => {
      for (const definition of TEST_REFEREE_SEED_DATA) {
        let referee = await db.referees.filter(r => r.seedKey === definition.seedKey).first()

        if (!referee) {
          const timestamp = new Date().toISOString()
          const baseRecord = {
            seedKey: definition.seedKey,
            firstName: definition.firstName,
            lastName: definition.lastName,
            country: definition.country,
            dob: definition.dob,
            test: true,
            createdAt: timestamp
          }
          const refereeId = await db.referees.add(baseRecord)
          referee = { id: refereeId, ...baseRecord }
        } else {
          const definitionChanged =
            referee.firstName !== definition.firstName ||
            referee.lastName !== definition.lastName ||
            referee.country !== definition.country ||
            referee.dob !== definition.dob

          if (definitionChanged) {
            await db.referees.update(referee.id, {
              firstName: definition.firstName,
              lastName: definition.lastName,
              country: definition.country,
              dob: definition.dob
            })
            referee = {
              ...referee,
              firstName: definition.firstName,
              lastName: definition.lastName,
              country: definition.country,
              dob: definition.dob
            }
          }
        }

        seededReferees.push(referee)
      }

      for (const definition of TEST_SCORER_SEED_DATA) {
        let scorer = await db.scorers.filter(s => s.seedKey === definition.seedKey).first()

        if (!scorer) {
          const timestamp = new Date().toISOString()
          const baseRecord = {
            seedKey: definition.seedKey,
            firstName: definition.firstName,
            lastName: definition.lastName,
            country: definition.country || 'CHE',
            dob: definition.dob,
            test: true,
            createdAt: timestamp
          }
          const scorerId = await db.scorers.add(baseRecord)
          scorer = { id: scorerId, ...baseRecord }
        } else {
          const definitionChanged =
            scorer.firstName !== definition.firstName ||
            scorer.lastName !== definition.lastName ||
            (scorer.country || 'CHE') !== (definition.country || 'CHE') ||
            scorer.dob !== definition.dob

          if (definitionChanged) {
            await db.scorers.update(scorer.id, {
              firstName: definition.firstName,
              lastName: definition.lastName,
              country: definition.country || 'CHE',
              dob: definition.dob
            })
            scorer = {
              ...scorer,
              firstName: definition.firstName,
              lastName: definition.lastName,
              country: definition.country || 'CHE',
              dob: definition.dob
            }
          }
        }

        seededScorers.push(scorer)
      }
    })

    return { referees: seededReferees, scorers: seededScorers }
  }

  async function createTestMatchData() {
    // Clear any stray draft data from previous sessions
    await db.match_setup.clear()

    const seededTeams = await ensureSeedTestTeams()
    const { referees, scorers } = await ensureSeedTestOfficials()
    if (seededTeams.length < 2) {
      console.error('Not enough seeded test teams available.')
      return
    }

    const [homeTeam, awayTeam] = seededTeams
    const scheduledAt = getNextTestMatchStartTime()
    const timestamp = new Date().toISOString()

    const findSeededRecord = (collection, seed) => {
      if (!seed) return null
      if (!collection?.length) return seed
      const seeded = collection.find(item => item.seedKey === seed.seedKey)
      return seeded || collection[0] || seed
    }

    const firstRef = findSeededRecord(referees, TEST_REFEREE_SEED_DATA[0])
    const secondRef = findSeededRecord(referees, TEST_REFEREE_SEED_DATA[1] || TEST_REFEREE_SEED_DATA[0])
    const primaryScorer = findSeededRecord(scorers, TEST_SCORER_SEED_DATA[0])
    const assistantScorer = findSeededRecord(scorers, TEST_SCORER_SEED_DATA[1] || TEST_SCORER_SEED_DATA[0])

    const officials = [
      {
        role: '1st referee',
        firstName: firstRef?.firstName || 'Claudia',
        lastName: firstRef?.lastName || 'Moser',
        country: firstRef?.country || 'CHE',
        dob: firstRef?.dob ? formatISODateToDisplay(firstRef.dob) : formatISODateToDisplay('1982-04-19')
      },
      {
        role: '2nd referee',
        firstName: secondRef?.firstName || 'Martin',
        lastName: secondRef?.lastName || 'Kunz',
        country: secondRef?.country || 'CHE',
        dob: secondRef?.dob ? formatISODateToDisplay(secondRef.dob) : formatISODateToDisplay('1979-09-02')
      },
      {
        role: 'scorer',
        firstName: primaryScorer?.firstName || 'Petra',
        lastName: primaryScorer?.lastName || 'Schneider',
        country: primaryScorer?.country || 'CHE',
        dob: primaryScorer?.dob ? formatISODateToDisplay(primaryScorer.dob) : formatISODateToDisplay('1990-01-15')
      },
      {
        role: 'assistant scorer',
        firstName: assistantScorer?.firstName || 'Lukas',
        lastName: assistantScorer?.lastName || 'Baumann',
        country: assistantScorer?.country || 'CHE',
        dob: assistantScorer?.dob ? formatISODateToDisplay(assistantScorer.dob) : formatISODateToDisplay('1988-06-27')
      },
      { role: 'line judge 1', name: 'Andrea Müller' },
      { role: 'line judge 2', name: 'Thomas Fischer' }
    ]

    let createdMatchId = null

    await db.transaction('rw', db.matches, db.sets, db.events, db.sync_queue, async () => {
      let existingMatch =
        (await db.matches.filter(m => isTestMatchSeedKey(m.seedKey)).first()) ||
        (await db.matches.filter(m => m.test === true && !m.seedKey).first())

      // This device's own relay room (testMatchSeedKeyFor), kept across restarts
      const testSeedKey = testMatchSeedKeyFor(existingMatch?.seedKey)
      if (existingMatch && existingMatch.seedKey !== testSeedKey) {
        await db.matches.update(existingMatch.id, { seedKey: testSeedKey })
        existingMatch = await db.matches.get(existingMatch.id)
      }

      const baseMatchData = {
        status: 'scheduled',
        homeTeamId: homeTeam.id,
        awayTeamId: awayTeam.id,
        homeShortName: homeTeam.shortName,
        awayShortName: awayTeam.shortName,
        hall: TEST_MATCH_DEFAULTS.hall,
        city: TEST_MATCH_DEFAULTS.city,
        league: TEST_MATCH_DEFAULTS.league,
        gameNumber: TEST_MATCH_DEFAULTS.gameNumber,
        scheduledAt,
        refereePin: generateRefereePin(),
        bench_home: TEST_HOME_BENCH,
        bench_away: TEST_AWAY_BENCH,
        officials,
        homeCoachSignature: null,
        homeCaptainSignature: null,
        awayCoachSignature: null,
        awayCaptainSignature: null,
        coinTossConfirmed: false,
        test: true,
        seedKey: testSeedKey,
        externalId: TEST_MATCH_EXTERNAL_ID,
        matchInfoConfirmedAt: timestamp // Test matches are pre-configured
      }

      if (existingMatch) {
        await wipeMatchEvents(db, existingMatch.id)
        await db.sets.where('matchId').equals(existingMatch.id).delete()

        await db.matches.update(existingMatch.id, {
          ...baseMatchData,
          // Preserve existing refereePin if it exists
          refereePin: existingMatch.refereePin || baseMatchData.refereePin,
          createdAt: existingMatch.createdAt || timestamp,
          updatedAt: timestamp
        })

        createdMatchId = existingMatch.id
        // Don't sync test match metadata to Supabase - it comes from the seed script
      } else {
        const newMatchId = await db.matches.add({
          ...baseMatchData,
          createdAt: timestamp,
          updatedAt: timestamp
        })

        createdMatchId = newMatchId
        // Don't sync test match metadata to Supabase - it comes from the seed script
      }
    })

    if (createdMatchId) {
      setMatchId(createdMatchId)
      setShowMatchSetup(true)
      setShowCoinToss(false)
    }
  }

  async function createNewTestMatch() {
    if (testMatchLoading) return

    const officialMatchRecording = matchStatus?.status === 'Match recording' && currentOfficialMatch
    if (officialMatchRecording) {
      setConfirmModal({
        message: t('home.modals.testMatchOverwriteWarning'),
        onConfirm: async () => {
          setConfirmModal(null)
          setTestMatchLoading(true)
          try {
            await clearLocalTestData()
            await createTestMatchData()
          } catch (error) {
            console.error('Failed to prepare test match:', error)
            setAlertModal(t('home.modals.unableToPrepareTestMatch', { error: error.message || error }))
          } finally {
            setTestMatchLoading(false)
          }
        },
        onCancel: () => {
          setConfirmModal(null)
        }
      })
      return
    }

    setTestMatchLoading(true)

    try {
      // Clear previous test match locally
      await clearLocalTestData()

      // Create test match locally only - no Supabase interaction
      await createTestMatchData()
    } catch (error) {
      console.error('Failed to prepare test match:', error)
      setAlertModal(t('home.modals.unableToPrepareTestMatch', { error: error.message || error }))
    } finally {
      setTestMatchLoading(false)
    }
  }

  async function continueTestMatch() {
    if (testMatchLoading) return

    // Use toArray and filter to avoid index requirement
    const matches = await db.matches.orderBy('createdAt').reverse().toArray()
    const existing = matches.find(m => m.test === true && m.status !== 'final')
    if (existing) {
      // Check if coin toss is confirmed
      const isCoinTossConfirmed = existing.coinTossTeamA !== null &&
        existing.coinTossTeamA !== undefined &&
        existing.coinTossTeamB !== null &&
        existing.coinTossTeamB !== undefined &&
        existing.coinTossServeA !== null &&
        existing.coinTossServeA !== undefined &&
        existing.coinTossServeB !== null &&
        existing.coinTossServeB !== undefined

      // PIN check removed - no longer required

      // Check match state to determine where to continue
      const isMatchSetupComplete = existing.homeCoachSignature &&
        existing.homeCaptainSignature &&
        existing.awayCoachSignature &&
        existing.awayCaptainSignature

      setMatchId(existing.id)

      // Determine where to continue based on status
      // Note: status flow is live -> ended -> final (after approval)
      if (existing.status === 'live' || existing.status === 'ended' || existing.status === 'final') {
        // Check if match is finished (one team has won 3 sets) - go to MatchEnd
        const sets = await db.sets.where('matchId').equals(existing.id).toArray()
        const finishedSets = sets.filter(s => s.finished)
        const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
        const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length
        const isMatchFinished = isMatchFinishedUtil(homeSetsWon, awaySetsWon, existing?.bestOf)

        setShowMatchSetup(false)
        setShowCoinToss(false)

        // 'ended' without the sets won = forfeit or stopped match: also Match End
        if (((existing.status === 'live' && isMatchFinished) || existing.status === 'ended') && !existing.approved) {
          // Match finished but not yet approved - go to MatchEnd
          setShowMatchEnd(true)
        } else {
          // Match in progress - go to scoreboard
          setShowMatchEnd(false)
        }
      } else if (isMatchSetupComplete && isCoinTossConfirmed) {
        // Match setup and coin toss complete - go to scoreboard
        setShowMatchSetup(false)
        setShowCoinToss(false)
      } else if (isMatchSetupComplete) {
        // Match setup complete but coin toss not done - go to coin toss
        setShowMatchSetup(false)
        setShowCoinToss(true)
      } else {
        // Match setup not complete - go to match setup
        setShowMatchSetup(true)
        setShowCoinToss(false)
      }
    } else {
      setAlertModal(t('home.modals.noTestMatchFound'))
    }
  }

  async function restartTestMatch() {
    if (testMatchLoading) return

    // Set loading state immediately to disable buttons
    setTestMatchLoading(true)

    setConfirmModal({
      message: t('home.modals.deleteTestMatchConfirm'),
      onConfirm: async () => {
        setConfirmModal(null)
        try {
          // Find the test match - use toArray and filter to avoid index requirement
          const matches = await db.matches.orderBy('createdAt').reverse().toArray()
          const testMatch = matches.find(m => m.test === true && m.status !== 'final')
          if (!testMatch) {
            setAlertModal(t('home.modals.noTestMatchFound'))
            setTestMatchLoading(false)
            return
          }

          // Delete all test match data
          await clearLocalTestData()

          // Clear matchId to return to home view
          setMatchId(null)
          setShowMatchSetup(false)
          setShowCoinToss(false)
          setShowManualAdjustments(false)

          setAlertModal(t('home.modals.testMatchDeleted'))
        } catch (error) {
          console.error('Failed to delete test match:', error)
          setAlertModal(t('home.modals.unableToDeleteTestMatch', { error: error.message || error }))
        } finally {
          setTestMatchLoading(false)
        }
      },
      onCancel: () => {
        setConfirmModal(null)
        setTestMatchLoading(false)
      }
    })
  }

  async function continueMatch(matchIdParam) {
    const targetMatchId = matchIdParam || currentOfficialMatch?.id
    if (!targetMatchId) return

    try {
      // Get the match to check its status
      const match = await db.matches.get(targetMatchId)
      if (!match) return

      // Check session lock (only for non-test matches)
      if (!match.test) {
        const sessionCheck = await checkMatchSession(targetMatchId)

        if (sessionCheck.locked && !sessionCheck.isCurrentSession) {
          // Match is locked by another session - just take over (no PIN required)
          await lockMatchSession(targetMatchId)
        } else if (!sessionCheck.locked) {
          // Match is not locked - lock it for this session
          await lockMatchSession(targetMatchId)
        }
        // If isCurrentSession is true, we already own it - no need to lock again
      }

      // PIN check removed - no longer required

      // Check if coin toss is confirmed (for navigation logic)
      const isCoinTossConfirmed = match.coinTossTeamA !== null &&
        match.coinTossTeamA !== undefined &&
        match.coinTossTeamB !== null &&
        match.coinTossTeamB !== undefined &&
        match.coinTossServeA !== null &&
        match.coinTossServeA !== undefined &&
        match.coinTossServeB !== null &&
        match.coinTossServeB !== undefined

      // If coin toss is confirmed and match is live, allow test matches to go to scoreboard
      // (This handles the case when coin toss is just confirmed)
      if (match.test === true && match.status === 'live' && isCoinTossConfirmed) {
        // Go directly to scoreboard for test matches after coin toss confirmation
        setMatchId(targetMatchId)
        setShowMatchSetup(false)
        setShowCoinToss(false)
        return
      }

      // Reject test matches for other cases
      if (match.test === true) {
        setAlertModal(t('home.modals.isTestMatchWarning'))
        return
      }

      // Determine where to continue based on status
      // Note: status flow is live -> ended -> final (after approval)
      if (match.status === 'live' || match.status === 'ended' || match.status === 'final') {
        // Check if match is finished - go to MatchEnd
        const match = await db.matches.get(targetMatchId)
        const sets = await db.sets.where('matchId').equals(targetMatchId).toArray()
        const finishedSets = sets.filter(s => s.finished)
        const homeSetsWon = finishedSets.filter(s => s.homePoints > s.awayPoints).length
        const awaySetsWon = finishedSets.filter(s => s.awayPoints > s.homePoints).length
        const isMatchFinished = isMatchFinishedUtil(homeSetsWon, awaySetsWon, match?.bestOf)

        setMatchId(targetMatchId)
        setShowMatchSetup(false)
        setShowCoinToss(false)

        // 'ended' without the sets won = forfeit or stopped match: also Match End
        if (((match.status === 'live' && isMatchFinished) || match.status === 'ended') && !match.approved) {
          // Match finished but not yet approved - go to MatchEnd
          setShowMatchEnd(true)
        } else {
          // Match in progress or already approved - go to scoreboard
          setShowMatchEnd(false)
        }
      } else {
        // Go to match setup
        setMatchId(targetMatchId)
        setShowMatchSetup(true)
      }
    } catch (error) {
      console.error('Error continuing match:', error)
      setAlertModal(t('home.modals.errorOpeningMatch'))
    }
  }

  // The scoring screen in its phone layout (the display mode as the
  // Scoreboard reads it: its options write localStorage), and the match end
  // it leads to (signatures, approval): both get past the size gate on a phone
  const phoneLayoutOn = phoneLayoutActive(readStoredDisplayMode(), viewportSize)
  const phoneScoringShown = phoneLayoutOn && !!matchId && !showCoinToss && !showMatchSetup && !showMatchEnd && !showManualAdjustments
  const phoneMatchEndShown = phoneLayoutOn && !!matchId && showMatchEnd && !showManualAdjustments

  return (
    <div className="app-root" onClick={(e) => {
      // Close connection menu and debug menu when clicking outside
      if (showConnectionMenu && !e.target.closest('[data-connection-menu]')) {
        setShowConnectionMenu(false)
      }
      if (showDebugMenu && !e.target.closest('[data-debug-menu]')) {
        setShowDebugMenu(null)
      }
      // Close match info menu when clicking outside
      if (matchInfoMenuOpen && !e.target.closest('[data-match-info-menu]')) {
        setMatchInfoMenuOpen(false)
      }
    }}>
      {/* Minimum screen size warning - block phones/small screens */}
      {/* Allow if at least one dimension >= 800 (tablet in any orientation), but enforce min 500 on both */}
      {/* Skip warning in fullscreen mode - trust user has adequate screen space */}
      {/* The scoring screen is let through when it shows its phone layout (PhoneScoreboard), and its match end */}
      {!isFullscreen && !phoneScoringShown && !phoneMatchEndShown && isViewportTooSmall(viewportSize.width, viewportSize.height) ? (
        <div className="ov-kit flex flex-1 flex-col items-center justify-center bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 p-4">
          <div className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-stone-200/70 bg-white p-8 text-center shadow-card-lg">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-stone-100 text-stone-500">
              <PhoneIcon size={28} />
            </div>
            <p className="text-lg font-bold leading-snug text-stone-900">
              To use this application, please use a tablet or larger screen (minimum 800×600).
            </p>
            <p className="mt-2 text-sm tabular-nums text-stone-500">
              Current: {viewportSize.width} × {viewportSize.height}px
            </p>
            <p className="mt-3 text-sm text-stone-600">
              Try rotating your device or entering fullscreen mode.
            </p>
            <Button variant="dark" size="xl" block icon={Maximize} onClick={toggleFullscreen} className="mt-6">
              Enter fullscreen
            </Button>
            <p className="mt-3 text-xs text-stone-500">
              Fullscreen removes browser headers to maximize screen space.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Global Header */}
          <MainHeader
            connectionStatuses={connectionStatuses}
            connectionDebugInfo={connectionDebugInfo}
            showMatchSetup={showMatchSetup}
            matchId={matchId}
            currentMatch={currentMatch}
            matchInfoMenuOpen={matchInfoMenuOpen}
            setMatchInfoMenuOpen={setMatchInfoMenuOpen}
            matchInfoData={matchInfoData}
            matchStatus={matchStatus}
            currentOfficialMatch={currentOfficialMatch}
            currentTestMatch={currentTestMatch}
            isFullscreen={isFullscreen}
            toggleFullscreen={toggleFullscreen}
            offlineMode={offlineMode}
            setOfflineMode={(val) => {
              setOfflineMode(val)
              localStorage.setItem('offlineMode', val.toString())
            }}
            onOpenSetup={openMatchSetup}
            queueStats={queueStats}
            onRetryErrors={retryErrors}
            dashboardServer={isElectron && dashboardServerEnabled ? {
              enabled: dashboardServerEnabled,
              dashboardCount: dashboardServerData.dashboardCount,
              refereePin: currentMatch?.refereePin,
              onOpenOptions: () => setHomeOptionsModal(true),
              serverIP: dashboardServerData.serverIP,
              serverPort: dashboardServerData.serverPort,
              wsPort: dashboardServerData.wsPort,
              connectionUrl: dashboardServerData.connectionUrl,
              wsConnectionUrl: dashboardServerData.wsConnectionUrl,
              serverRunning: dashboardServerData.serverRunning,
              refereeCount: dashboardServerData.refereeCount,
              benchCount: dashboardServerData.benchCount
            } : null}
            collapsible={!!(matchId && !showCoinToss && !showMatchSetup && !showMatchEnd)}
            startCollapsed={phoneScoringShown}
            onTriggerAlarm={async () => {
              if (!matchId || !currentMatch) return

              // Identify the UUID for Supabase
              let supabaseMatchId = null
              const externalId = currentMatch.externalId
              // Check if externalId is already a UUID
              if (externalId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(externalId)) {
                supabaseMatchId = externalId
              } else {
                // Fallback: look up standard ID from matches table using the match seed key
                const seedKey = currentMatch.seed_key || String(matchId)
                const { data: matchData } = await apiFrom('matches')
                  .select('id')
                  .eq('external_id', seedKey)
                  .maybeSingle()
                if (matchData) supabaseMatchId = matchData.id
              }

              if (!supabaseMatchId) {
                console.warn('[Alarm] Could not resolve Supabase UUID for match', matchId)
                return
              }

              const trigger = new Date().toISOString()
              setScorerAttentionTrigger(trigger)
              try {
                // updated_at too: the realtime hub orders match_live_state by
                // updated_at and drops a row older than the last relayed one.
                const { error } = await apiFrom('match_live_state')
                  .update({ scorer_attention_trigger: trigger, updated_at: trigger })
                  .eq('match_id', supabaseMatchId)
                if (error) throw error
                if (typeof navigator !== 'undefined' && navigator.vibrate) {
                  navigator.vibrate(100)
                }
              } catch (err) {
                console.error('Failed to trigger alarm:', err)
              }
            }}
            alarmEnabled={currentMatch?.refereeConnectionEnabled === true}
            currentPage={currentPage}
            onToggleHelp={() => setHelpPanelOpen(prev => !prev)}
            helpPanelOpen={helpPanelOpen}
          />
          <div className="container" style={{
            minHeight: 0,
            flex: '1 1 auto',
            width: (showMatchSetup || (matchId && !showCoinToss && !showMatchSetup && !showMatchEnd)) ? '100%' : 'auto',
            height: 'auto',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            alignItems: (showMatchSetup || (matchId && !showCoinToss && !showMatchSetup && !showMatchEnd)) ? 'stretch' : 'center',
            margin: '0 auto',
            padding: (matchId && !showCoinToss && !showMatchSetup && !showMatchEnd) ? '0' : '5px',
            overflowX: 'hidden',
            overflowY: (matchId && !showCoinToss && !showMatchSetup && !showMatchEnd) ? 'hidden' : 'auto'
          }}>
            <div className="panel" style={{
              flex: '1 1 auto',
              minHeight: 0,
              height: 'auto',
              overflowY: 'auto',
              overflowX: 'hidden',
              width: (showMatchSetup || (matchId && !showCoinToss && !showMatchSetup && !showMatchEnd)) ? '100%' : 'auto',
              maxWidth: '100%',
              padding: (matchId && !showCoinToss && !showMatchSetup && !showMatchEnd) ? '10px' : '10px',
              // Vertical centering for CoinToss, MatchEnd, and HomePage screens (not MatchSetup - it fills the space)
              ...(!matchId || showCoinToss || showMatchEnd ? {
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center'
              } : {}),
              // MatchSetup fills available space
              ...(showMatchSetup ? {
                display: 'flex',
                flexDirection: 'column',
                padding: '10px',
                overflowY: 'hidden',
                height: '0px',
                flexGrow: 1
              } : {}),
              // Scoreboard active: flex column so match-record height: 100% resolves correctly
              ...(matchId && !showCoinToss && !showMatchSetup && !showMatchEnd ? {
                display: 'flex',
                flexDirection: 'column',
                overflowY: 'hidden',
                padding: '0'
              } : {})
            }}>
              {showCoinToss && matchId ? (
                <CoinToss
                  matchId={matchId}
                  onConfirm={() => {
                    setShowCoinToss(false)
                    // Match status is set to 'live' by CoinToss component
                  }}
                  onBack={() => {
                    setShowCoinToss(false)
                    setShowMatchSetup(true)
                  }}
                  lfpTrackingEnabled={lfpTrackingEnabled}
                />
              ) : showMatchSetup && matchId ? (
                <MatchSetup
                  matchId={matchId}
                  onStart={continueMatch}
                  onReturn={returnToMatch}
                  onOpenOptions={() => setHomeOptionsModal(true)}
                  onOpenCoinToss={() => {
                    setShowMatchSetup(false)
                    setShowCoinToss(true)
                  }}
                  offlineMode={offlineMode}
                  lfpTrackingEnabled={lfpTrackingEnabled}
                />
              ) : showManualAdjustments && matchId ? (
                <ManualAdjustments
                  matchId={matchId}
                  onClose={() => {
                    setShowManualAdjustments(false)
                    setShowMatchEnd(true)
                  }}
                  onSave={() => {
                    setShowManualAdjustments(false)
                    setShowMatchEnd(true)
                  }}
                />
              ) : showMatchEnd && matchId ? (
                <MatchEnd
                  matchId={matchId}
                  onGoHome={() => {
                    setMatchId(null)
                    setShowMatchEnd(false)
                    setShowManualAdjustments(false)
                  }}
                  onReopenLastSet={() => {
                    // Just hide MatchEnd - Scoreboard will show for the same matchId
                    setShowMatchEnd(false)
                    setShowManualAdjustments(false)
                  }}
                  onManualAdjustments={() => {
                    setShowMatchEnd(false)
                    setShowManualAdjustments(true)
                  }}
                />
              ) : !matchId ? (
                <>
                  {/* the Android app's update notice (utils/androidUpdate.js): home screen only */}
                  <AndroidUpdateNotice />
                  <UpdateBanner showClearDataOption={true} />
                  {/* the desktop app's own update (updater.rs): home screen only */}
                  <DesktopUpdateNotice />
                  <HomePage
                    newMatchMenuOpen={newMatchMenuOpen}
                    setNewMatchMenuOpen={setNewMatchMenuOpen}
                    createNewOfficialMatch={createNewOfficialMatch}
                    createNewTestMatch={createNewTestMatch}
                    testMatchLoading={testMatchLoading}
                    currentOfficialMatch={currentOfficialMatch}
                    currentTestMatch={currentTestMatch}
                    continueMatch={continueMatch}
                    continueTestMatch={continueTestMatch}
                    showDeleteMatchModal={showDeleteMatchModal}
                    restartTestMatch={restartTestMatch}
                    onOpenSettings={() => setHomeOptionsModal(true)}
                    onRestoreMatch={() => setRestoreMatchModal(true)}
                  />
                </>
              ) : (
                <Scoreboard
                  matchId={matchId}
                  scorerAttentionTrigger={scorerAttentionTrigger}
                  onFinishSet={finishSet}
                  onOpenSetup={openMatchSetup}
                  onOpenMatchSetup={openMatchSetupView}
                  onOpenCoinToss={openCoinTossView}
                  onTriggerEventBackup={backup.triggerEventBackup}
                />
              )}
            </div>

            {/* Delete Match Modal */}
            {deleteMatchModal && (
              <Modal
                title="Delete match"
                open={true}
                onClose={cancelDeleteMatch}
                width={420}
              >
                <div className="ov-kit p-2 sm:p-4">
                  <p className="text-base text-stone-800">
                    Are you sure you want to delete all data for: <strong className="font-semibold text-stone-900">{deleteMatchModal.matchName}</strong>?
                  </p>
                  <p className="mt-2 text-sm text-stone-600">
                    This will delete all sets, events, players, and team data for this match from local storage and from the cloud database.
                  </p>

                  {/* PIN confirmation for matches with gamePin */}
                  {deleteMatchModal.gamePin && (
                    <div className="mt-5">
                      <label htmlFor="delete-match-pin" className="mb-1.5 block text-sm font-medium text-stone-700">
                        Enter game PIN to confirm deletion:
                      </label>
                      <Input
                        id="delete-match-pin"
                        size="lg"
                        type="text"
                        value={deletePinInput}
                        onChange={(e) => {
                          setDeletePinInput(e.target.value)
                          setDeletePinError('')
                        }}
                        placeholder="Game PIN"
                        aria-label="Game PIN"
                        invalid={!!deletePinError}
                        className="max-w-[200px] text-center font-mono text-lg font-semibold tracking-[0.3em]"
                      />
                      {deletePinError && (
                        <p role="alert" className="mt-1.5 text-xs font-medium text-red-600">
                          {deletePinError}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="mt-6 flex justify-end gap-2">
                    <Button variant="secondary" size="xl" onClick={cancelDeleteMatch} className="rounded-lg font-medium">
                      {t('deleteMatch.cancel')}
                    </Button>
                    <Button variant="danger" size="xl" onClick={confirmDeleteMatch} className="rounded-lg">
                      {t('deleteMatch.delete')}
                    </Button>
                  </div>
                </div>
              </Modal>
            )}

            {/* Restore Match Modal */}
            {restoreMatchModal && (
              <Modal
                title={t('settings.backup.restoreMatch')}
                open={true}
                onClose={() => {
                  setRestoreMatchModal(false)
                  setRestoreMatchIdInput('')
                  setRestorePin('')
                  setRestoreError('')
                  setCloudBackups([])
                  setCloudBackupPin('')
                  setCloudBackupGameN('')
                  setCloudBackupError('')
                }}
                width={500}
              >
                <div className="ov-kit p-2 sm:p-4">
                  {/* Restore from Cloud Backup */}
                  {!offlineMode && (
                    <div className="mb-6">
                      <h3 className="text-sm font-semibold text-stone-800">
                        {t('settings.backup.restoreFromCloudBackup')}
                      </h3>
                      <p className="mt-1 mb-3 text-xs text-stone-500">
                        {t('settings.backup.restoreFromCloudDesc')}
                      </p>
                      <div className="mb-3 flex gap-3">
                        <div className="flex-1 min-w-0">
                          <label htmlFor="restore-cloud-gamen" className="mb-1.5 block text-sm font-medium text-stone-700">
                            {t('settings.backup.gameN')}:
                          </label>
                          <input
                            id="restore-cloud-gamen"
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={cloudBackupGameN}
                            onChange={(e) => {
                              const value = e.target.value.replace(/\D/g, '')
                              setCloudBackupGameN(value)
                            }}
                            placeholder="123456"
                            aria-label={t('settings.backup.gameN')}
                            className="w-full h-11 px-3 rounded-xl border border-stone-200 bg-white text-center font-mono text-lg font-bold tabular-nums text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-700/20 focus:border-red-700/40"
                          />
                        </div>
                        <div className="flex-[1.5] min-w-0">
                          <label htmlFor="restore-cloud-pin" className="mb-1.5 block text-sm font-medium text-stone-700">
                            {t('settings.backup.gamePin')}:
                          </label>
                          <input
                            id="restore-cloud-pin"
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={cloudBackupPin}
                            onChange={(e) => {
                              const value = e.target.value.replace(/\D/g, '')
                              if (value.length <= 6) {
                                setCloudBackupPin(value)
                              }
                            }}
                            placeholder="000000"
                            maxLength={6}
                            aria-label={t('settings.backup.gamePin')}
                            className="w-full h-11 px-3 rounded-xl border border-stone-200 bg-white text-center font-mono text-lg font-bold tracking-[0.3em] tabular-nums text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-700/20 focus:border-red-700/40"
                          />
                        </div>
                      </div>
                      <button
                        onClick={async () => {
                          if (cloudBackupPin.length !== 6) {
                            setCloudBackupError('Please enter a 6-digit PIN')
                            return
                          }
                          setCloudBackupLoading(true)
                          setCloudBackupError('')
                          try {
                            const gameN = parseInt(cloudBackupGameN) || 1
                            // Fetch the cloud backups, PocketBase and the cloud match itself in parallel.
                            // Backups are per account: a replacement tablet signed in with another
                            // account lists none, but game number + game PIN still find the match
                            // (restore-by-pin; signed in, it also makes this account an editor).
                            const [cloudResults, pbResults, dbMatch] = await Promise.all([
                              listCloudBackups(cloudBackupPin, gameN).catch(() => []),
                              listPocketBaseBackups(gameN).catch(() => []),
                              fetchMatchByPin(cloudBackupPin, gameN).catch(() => null)
                            ])
                            // Tag cloud results with source
                            const taggedCloud = cloudResults.map(b => ({ ...b, source: b.source || 'cloud' }))
                            const dbEntries = dbMatch?.match ? [{
                              name: `database_g${gameN}`,
                              source: 'database',
                              gameN,
                              status: dbMatch.match.status,
                              updated_at: dbMatch.match.updated_at || dbMatch.match.created_at,
                              cloudData: dbMatch
                            }] : []
                            // Merge and sort by most recent first
                            const merged = [...dbEntries, ...taggedCloud, ...pbResults].sort((a, b) => {
                              const dateA = a.created || a.updated_at || ''
                              const dateB = b.created || b.updated_at || ''
                              return dateB.localeCompare(dateA)
                            })
                            setCloudBackups(merged)
                            if (merged.length === 0) {
                              setCloudBackupError('No backups found for this game number')
                            }
                          } catch (err) {
                            setCloudBackupError(err.message || 'Failed to list backups')
                          } finally {
                            setCloudBackupLoading(false)
                          }
                        }}
                        disabled={cloudBackupLoading || cloudBackupPin.length !== 6}
                        aria-busy={cloudBackupLoading || undefined}
                        className="inline-flex w-full h-11 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
                      >
                        {cloudBackupLoading ? t('common.loading') : t('settings.backup.searchCloudBackups')}
                      </button>
                      {cloudBackupError && (
                        <FormError className="mt-2">{cloudBackupError}</FormError>
                      )}
                      {cloudBackups.length > 0 && (
                        <div className="mt-2 max-h-[300px] overflow-y-auto rounded-lg border border-stone-200">
                          <BackupTable
                            backups={cloudBackups}
                            onBackupSelect={async (backup) => {
                              setRestoreLoading(true)
                              setRestoreError('')
                              try {
                                if (backup.source === 'database') {
                                  setRestorePreviewData({ data: backup.cloudData, source: 'database' })
                                  return
                                }
                                let cloudData
                                if (backup.source === 'pocketbase') {
                                  cloudData = await fetchPocketBaseMatch(backup.match_id, cloudBackupPin)
                                } else {
                                  cloudData = await fetchCloudBackup(backup.path)
                                }
                                if (!cloudData) {
                                  setRestoreError('Failed to fetch backup data')
                                  setRestoreLoading(false)
                                  return
                                }
                                setRestorePreviewData({ data: cloudData, source: backup.source || 'cloud', backupName: backup.name })
                              } catch (err) {
                                setRestoreError(err.message || 'Failed to load backup')
                              } finally {
                                setRestoreLoading(false)
                              }
                            }}
                            loading={restoreLoading}
                            mode="button"
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Divider before local backup */}
                  <div className="mb-6 flex items-center gap-4">
                    <div className="h-px flex-1 bg-stone-200" />
                    <span className="text-xs text-stone-500">{t('settings.backup.or')}</span>
                    <div className="h-px flex-1 bg-stone-200" />
                  </div>

                  {/* Offline/File restore */}
                  <div>
                    <h3 className="mb-3 text-sm font-semibold text-stone-800">
                      {t('settings.backup.restoreFromLocal')}
                    </h3>
                    <button
                      onClick={async () => {
                        setRestoreLoading(true)
                        setRestoreError('')
                        try {
                          const jsonData = await pickBackupFile()
                          if (!jsonData) {
                            setRestoreLoading(false)
                            return // User cancelled
                          }
                          // Show preview instead of immediately restoring
                          setRestorePreviewData({ data: jsonData, source: 'local' })
                        } catch (err) {
                          setRestoreError(err.message || t('home.modals.failedToRestoreFromFile'))
                        } finally {
                          setRestoreLoading(false)
                        }
                      }}
                      disabled={restoreLoading}
                      aria-busy={restoreLoading || undefined}
                      className="inline-flex w-full h-11 items-center justify-center gap-2 rounded-xl border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-700 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
                    >
                      {restoreLoading ? t('common.loading') : t('settings.backup.selectBackupFile')}
                    </button>
                  </div>
                </div>
              </Modal>
            )}

            {/* Restore Preview Modal */}
            {restorePreviewData && (
              <Modal
                title={t('settings.backup.restorePreview')}
                open={true}
                onClose={() => setRestorePreviewData(null)}
                width={700}
              >
                <div className="ov-kit max-h-[80vh] overflow-y-auto p-2 sm:p-4 text-sm text-stone-800">
                  {(() => {
                    // Normalize data from different sources
                    const d = restorePreviewData.data
                    const isDbFormat = d.match?.home_team || d.liveState

                    const homeTeamName = isDbFormat
                      ? (d.match?.home_team?.name || d.match?.homeTeamName || 'Home')
                      : (d.homeTeam?.name || d.match?.homeTeamName || 'Home')
                    const awayTeamName = isDbFormat
                      ? (d.match?.away_team?.name || d.match?.awayTeamName || 'Away')
                      : (d.awayTeam?.name || d.match?.awayTeamName || 'Away')

                    const events = d.events || []
                    const sets = d.sets || []

                    // Get latest set
                    const latestSet = [...sets].sort((a, b) => (b.index || 0) - (a.index || 0))[0]
                    const currentSetIndex = latestSet?.index || d.liveState?.current_set || 1
                    const homePoints = latestSet?.homePoints ?? latestSet?.home_points ?? d.liveState?.points_a ?? 0
                    const awayPoints = latestSet?.awayPoints ?? latestSet?.away_points ?? d.liveState?.points_b ?? 0

                    // Get lineups (from events or liveState)
                    const lineupEvents = events.filter(e => e.type === 'lineup')
                    const homeLineup = lineupEvents.find(e => e.payload?.team === 'home')?.payload?.lineup ||
                      (isDbFormat ? d.liveState?.lineup_a : null)
                    const awayLineup = lineupEvents.find(e => e.payload?.team === 'away')?.payload?.lineup ||
                      (isDbFormat ? d.liveState?.lineup_b : null)

                    // Get timeouts for current set
                    const timeoutEvents = events.filter(e => e.type === 'timeout' && e.setIndex === currentSetIndex)
                    const homeTimeouts = timeoutEvents.filter(e => e.payload?.team === 'home').length
                    const awayTimeouts = timeoutEvents.filter(e => e.payload?.team === 'away').length

                    // Get substitutions for current set
                    const subEvents = events.filter(e => e.type === 'substitution' && e.setIndex === currentSetIndex)
                    const homeSubs = subEvents.filter(e => e.payload?.team === 'home')
                    const awaySubs = subEvents.filter(e => e.payload?.team === 'away')

                    // Get sanctions
                    const sanctionEvents = events.filter(e => e.type === 'sanction')

                    // Get serving team
                    const pointEvents = events.filter(e => e.type === 'point').sort((a, b) => (b.seq || 0) - (a.seq || 0))
                    const lastPoint = pointEvents[0]
                    const servingTeam = lastPoint?.payload?.scoringTeam || d.liveState?.serving_team || 'home'

                    // Helper to render lineup
                    const renderLineup = (lineup, teamName) => {
                      if (!lineup) return <span className="text-xs text-stone-500">No lineup data</span>
                      const positions = ['I', 'II', 'III', 'IV', 'V', 'VI']
                      return (
                        <div className="grid grid-cols-3 gap-1">
                          {positions.map(pos => {
                            const posData = lineup[pos]
                            const num = typeof posData === 'object' ? posData?.number : posData
                            const isServing = typeof posData === 'object' && posData?.isServing
                            const isLibero = typeof posData === 'object' && posData?.isLibero
                            return (
                              <div key={pos} className={cn(
                                'rounded-md border px-2 py-1.5 text-center text-[13px]',
                                isServing ? 'border-green-200 bg-green-50' : isLibero ? 'border-orange-200 bg-orange-50' : 'border-stone-200/70 bg-stone-50'
                              )}>
                                <span className="text-[11px] text-stone-500">{pos}</span>
                                <br />
                                <span className="font-semibold tabular-nums text-stone-900">{num || '-'}</span>
                                {isServing && <span style={{ color: '#22c55e', marginLeft: '4px' }}>●</span>}
                              </div>
                            )
                          })}
                        </div>
                      )
                    }

                    return (
                      <>
                        {/* Source indicator */}
                        <div className="mb-4 flex flex-wrap justify-center gap-2">
                          <span className={cn(
                            'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium',
                            restorePreviewData.source === 'database' ? 'bg-sky-100 text-sky-800' :
                              restorePreviewData.source === 'pocketbase' ? 'bg-emerald-100 text-emerald-800' :
                              restorePreviewData.source === 'cloud' ? 'bg-violet-100 text-violet-800' : 'bg-amber-100 text-amber-800'
                          )}>
                            {restorePreviewData.source === 'database' ? t('settings.backup.fromDatabase', 'From database') :
                              restorePreviewData.source === 'pocketbase' ? 'PocketBase backup' :
                              restorePreviewData.source === 'cloud' ? t('settings.backup.restoreFromCloudBackup') : t('settings.backup.fromLocalFile')}
                          </span>
                          {restorePreviewData.backupName && (
                            <span className="inline-flex items-center rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[11px] text-stone-600">
                              {restorePreviewData.backupName.replace('.json', '')}
                            </span>
                          )}
                        </div>

                        {/* Teams header */}
                        <div className="mb-4 flex items-center justify-between rounded-xl border border-stone-200/70 bg-stone-50/60 p-4">
                          <div className="flex-1 text-center">
                            <div className="text-base font-bold text-stone-900">{homeTeamName}</div>
                            <div className="text-xs text-stone-500">Home</div>
                          </div>
                          <div className="px-4 text-center">
                            <div className="text-2xl font-bold tabular-nums text-stone-900">{homePoints} - {awayPoints}</div>
                            <div className="text-xs text-stone-500">Set {currentSetIndex}</div>
                          </div>
                          <div className="flex-1 text-center">
                            <div className="text-base font-bold text-stone-900">{awayTeamName}</div>
                            <div className="text-xs text-stone-500">Away</div>
                          </div>
                        </div>

                        {/* Serving indicator */}
                        <div className="mb-4 text-center text-sm text-stone-700">
                          <span style={{ color: '#22c55e' }}>● </span>
                          Serving: <strong>{servingTeam === 'home' ? homeTeamName : awayTeamName}</strong>
                        </div>

                        {/* Lineups */}
                        <div className="mb-4 grid grid-cols-2 gap-4">
                          <div>
                            <h4 className="mb-2 text-sm font-semibold text-stone-700">
                              {homeTeamName} Lineup
                            </h4>
                            {renderLineup(homeLineup)}
                          </div>
                          <div>
                            <h4 className="mb-2 text-sm font-semibold text-stone-700">
                              {awayTeamName} Lineup
                            </h4>
                            {renderLineup(awayLineup)}
                          </div>
                        </div>

                        {/* Timeouts */}
                        <div className="mb-4 grid grid-cols-2 gap-4">
                          <div className="rounded-xl border border-stone-200/70 bg-stone-50/60 p-3 text-center">
                            <div className="mb-1 text-xs text-stone-500">Timeouts</div>
                            <div className="text-xl font-bold tabular-nums text-stone-900">{homeTimeouts}/2</div>
                          </div>
                          <div className="rounded-xl border border-stone-200/70 bg-stone-50/60 p-3 text-center">
                            <div className="mb-1 text-xs text-stone-500">Timeouts</div>
                            <div className="text-xl font-bold tabular-nums text-stone-900">{awayTimeouts}/2</div>
                          </div>
                        </div>

                        {/* Substitutions */}
                        {(homeSubs.length > 0 || awaySubs.length > 0) && (
                          <div className="mb-4 grid grid-cols-2 gap-4">
                            <div>
                              <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-stone-500">
                                Substitutions ({homeSubs.length})
                              </h4>
                              {homeSubs.length === 0 ? (
                                <span className="text-xs text-stone-500">None</span>
                              ) : (
                                homeSubs.map((sub, i) => (
                                  <div key={i} className="mb-1 rounded-md border border-stone-200/70 bg-stone-50 px-2 py-1 text-xs tabular-nums text-stone-700">
                                    #{sub.payload?.playerIn} ← #{sub.payload?.playerOut}
                                    <span className="ml-2 text-stone-500">
                                      @{sub.payload?.homeScore || 0}-{sub.payload?.awayScore || 0}
                                    </span>
                                  </div>
                                ))
                              )}
                            </div>
                            <div>
                              <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-stone-500">
                                Substitutions ({awaySubs.length})
                              </h4>
                              {awaySubs.length === 0 ? (
                                <span className="text-xs text-stone-500">None</span>
                              ) : (
                                awaySubs.map((sub, i) => (
                                  <div key={i} className="mb-1 rounded-md border border-stone-200/70 bg-stone-50 px-2 py-1 text-xs tabular-nums text-stone-700">
                                    #{sub.payload?.playerIn} ← #{sub.payload?.playerOut}
                                    <span className="ml-2 text-stone-500">
                                      @{sub.payload?.homeScore || 0}-{sub.payload?.awayScore || 0}
                                    </span>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        )}

                        {/* Sanctions */}
                        {sanctionEvents.length > 0 && (
                          <div className="mb-4">
                            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-stone-500">
                              Sanctions ({sanctionEvents.length})
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {sanctionEvents.map((s, i) => (
                                <div key={i} className={cn(
                                  'rounded border px-1.5 py-1 text-xs',
                                  s.payload?.type === 'red' ? 'border-red-200 bg-red-100 text-red-800' :
                                    s.payload?.type === 'yellow' ? 'border-yellow-200 bg-yellow-100 text-yellow-900' : 'border-stone-200 bg-white text-stone-700'
                                )}>
                                  {s.payload?.team === 'home' ? homeTeamName : awayTeamName}{s.payload?.playerNumber ? ` #${s.payload.playerNumber}` : ''} - {s.payload?.type || 'sanction'}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Set scores summary */}
                        {sets.length > 0 && (
                          <div className="mb-6">
                            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-stone-500">
                              Set scores
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {[...sets].sort((a, b) => (a.index || 0) - (b.index || 0)).map(s => (
                                <div key={s.index} className={cn(
                                  'rounded-lg border px-3 py-2 text-center',
                                  s.finished ? 'border-stone-200 bg-white' : 'border-sky-200 bg-sky-50'
                                )}>
                                  <div className="text-[11px] text-stone-500">Set {s.index}</div>
                                  <div className="text-sm font-semibold tabular-nums text-stone-900">
                                    {s.homePoints ?? s.home_points ?? 0} - {s.awayPoints ?? s.away_points ?? 0}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex flex-wrap justify-end gap-2 border-t border-stone-100 pt-4">
                          <button
                            onClick={() => {
                              setRestorePreviewData(null)
                              setRestoreMatchModal(false)
                              setRestoreMatchIdInput('')
                              setRestorePin('')
                              setCloudBackups([])
                              setCloudBackupPin('')
                              setCloudBackupGameN('')
                              setCloudBackupError('')
                            }}
                            disabled={restoreLoading}
                            className="mr-auto inline-flex h-11 items-center justify-center rounded-lg px-3 text-sm font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => setRestorePreviewData(null)}
                            disabled={restoreLoading}
                            className="inline-flex h-11 items-center justify-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
                          >
                            Select another
                          </button>
                          <button
                            onClick={async () => {
                              setRestoreLoading(true)
                              try {
                                const cloudData = restorePreviewData.data
                                let newMatchId

                                if (restorePreviewData.source === 'database') {
                                  newMatchId = await importMatchFromSupabase(cloudData)
                                } else {
                                  newMatchId = await restoreMatchFromJson(cloudData)
                                }

                                // Close modals
                                setRestorePreviewData(null)
                                setRestoreMatchModal(false)
                                setRestoreMatchIdInput('')
                                setRestorePin('')
                                setCloudBackups([])
                                setCloudBackupPin('')
                                setCloudBackupGameN('')
                                setCloudBackupError('')
                                setMatchId(newMatchId)

                                // Determine where to go based on match state
                                const matchStatus = cloudData.match?.status
                                const hasEvents = cloudData.events && cloudData.events.length > 0
                                const hasSets = cloudData.sets && cloudData.sets.length > 0
                                const finishedSets = (cloudData.sets || []).filter(s => s.finished)
                                const homeSetsWon = finishedSets.filter(s => (s.homePoints ?? s.home_points ?? 0) > (s.awayPoints ?? s.away_points ?? 0)).length
                                const awaySetsWon = finishedSets.filter(s => (s.awayPoints ?? s.away_points ?? 0) > (s.homePoints ?? s.home_points ?? 0)).length
                                const isMatchFinished = isMatchFinishedUtil(homeSetsWon, awaySetsWon, cloudData.match?.bestOf ?? cloudData.match?.best_of)

                                // Priority: finished match → MatchEnd, live with activity → Scoreboard, else → Setup
                                if (isMatchFinished) {
                                  // Match is complete - go directly to MatchEnd
                                  setShowMatchSetup(false)
                                  setShowMatchEnd(true)
                                } else if ((matchStatus === 'live' || hasEvents || hasSets) && (hasEvents || hasSets)) {
                                  // Match in progress with activity - go to Scoreboard
                                  setShowMatchSetup(false)
                                } else {
                                  // New or setup-phase match - go to MatchSetup
                                  setShowMatchSetup(true)
                                }
                              } catch (err) {
                                setRestoreError(err.message || 'Failed to restore match')
                              } finally {
                                setRestoreLoading(false)
                              }
                            }}
                            disabled={restoreLoading}
                            aria-busy={restoreLoading || undefined}
                            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-5 text-sm font-semibold text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
                          >
                            {restoreLoading ? 'Restoring...' : 'Confirm restore'}
                          </button>
                        </div>
                      </>
                    )
                  })()}
                </div>
              </Modal>
            )}

            {/* New Match Modal */}
            {newMatchModal && (
              <Modal
                title="Create new match"
                open={true}
                onClose={cancelNewMatch}
                width={400}
              >
                <div className="ov-kit p-2 sm:p-4">
                  <p className="text-base text-stone-700">
                    {newMatchModal.message}
                  </p>
                  <div className="mt-6 flex justify-end gap-2">
                    <Button variant="secondary" size="xl" onClick={cancelNewMatch} className="rounded-lg font-medium">
                      Cancel
                    </Button>
                    <Button variant="dark" size="xl" onClick={confirmNewMatch} className="rounded-lg">
                      Yes
                    </Button>
                  </div>
                </div>
              </Modal>
            )}

            {/* Alert Modal */}
            {alertModal && (
              <Modal
                title={t('alert.info', 'Alert')}
                open={true}
                onClose={() => setAlertModal(null)}
                width={400}
                hideCloseButton={true}
              >
                <div className="ov-kit p-2 sm:p-4">
                  <p className="text-base text-stone-700">
                    {alertModal}
                  </p>
                  <div className="mt-6 flex justify-end gap-2">
                    <Button variant="dark" size="xl" onClick={() => setAlertModal(null)} className="min-w-24 rounded-lg">
                      {t('common.ok', 'OK')}
                    </Button>
                  </div>
                </div>
              </Modal>
            )}

            {/* Confirm Modal */}
            {confirmModal && (
              <Modal
                title={t('common.confirm', 'Confirm')}
                open={true}
                onClose={confirmModal.onCancel}
                width={400}
                hideCloseButton={true}
              >
                <div className="ov-kit p-2 sm:p-4">
                  <p className="text-base text-stone-700">
                    {confirmModal.message}
                  </p>
                  <div className="mt-6 flex justify-end gap-2">
                    <Button variant="secondary" size="xl" onClick={confirmModal.onCancel} className="rounded-lg font-medium">
                      {t('common.cancel', 'Cancel')}
                    </Button>
                    <Button variant="dark" size="xl" onClick={confirmModal.onConfirm} className="rounded-lg">
                      {t('common.yes', 'Yes')}
                    </Button>
                  </div>
                </div>
              </Modal>
            )}

            {/* Home Options Modal */}
            <HomeOptionsModal
              open={homeOptionsModal}
              onClose={() => setHomeOptionsModal(false)}
              onOpenConnectionSetup={() => setConnectionSetupModal(true)}
              matchOptions={{
                checkAccidentalRallyStart,
                setCheckAccidentalRallyStart,
                accidentalRallyStartDuration,
                setAccidentalRallyStartDuration,
                checkAccidentalPointAward,
                setCheckAccidentalPointAward,
                accidentalPointAwardDuration,
                setAccidentalPointAwardDuration,
                manageCaptainOnCourt,
                setManageCaptainOnCourt,
                liberoExitConfirmation,
                setLiberoExitConfirmation,
                liberoEntrySuggestion,
                setLiberoEntrySuggestion,
                setIntervalDuration,
                setSetIntervalDuration,
                keybindingsEnabled,
                setKeybindingsEnabled,
                lfpTrackingEnabled,
                setLfpTrackingEnabled,
                lfpMinimumOnCourt,
                setLfpMinimumOnCourt
              }}
              displayOptions={{
                displayMode,
                setDisplayMode,
                detectedDisplayMode,
                activeDisplayMode,
                enterDisplayMode,
                exitDisplayMode
              }}
              wakeLock={{
                wakeLockActive,
                toggleWakeLock
              }}
              backup={backup}
              onRestoreFromFile={restoreFromBackupFile}
              dashboardServer={isElectron ? {
                enabled: dashboardServerEnabled,
                onToggle: () => {
                  const newValue = !dashboardServerEnabled
                  setDashboardServerEnabled(newValue)
                  localStorage.setItem('dashboardServerEnabled', String(newValue))
                },
                serverRunning: dashboardServerData.serverRunning,
                connectionUrl: dashboardServerData.connectionUrl,
                refereePin: currentMatch?.refereePin,
                dashboardCount: dashboardServerData.dashboardCount,
                refereeCount: dashboardServerData.refereeCount,
                benchCount: dashboardServerData.benchCount,
                connectedDashboards: dashboardServerData.connectedDashboards
              } : null}
            />

            {/* Contextual Help Panel */}
            <ContextualHelpPanel
              open={helpPanelOpen}
              onClose={() => setHelpPanelOpen(false)}
              currentPage={currentPage}
              onShowMe={(helpId, tooltipKey) => {
                setHelpPanelOpen(false)
                setSpotlightTarget({ helpId, tooltipKey })
              }}
            />
            {spotlightTarget && (
              <SpotlightOverlay
                targetHelpId={spotlightTarget.helpId}
                tooltipKey={spotlightTarget.tooltipKey}
                onDismiss={() => setSpotlightTarget(null)}
              />
            )}

            {/* Connect tablets (Options > Connections) */}
            {connectionSetupModal && (
              <ConnectTabletsModal
                open
                onClose={() => setConnectionSetupModal(false)}
                match={currentMatch || null}
              />
            )}

            <StartupConnectivityModal
              open={showStartupConnectivity && !offlineMode}
              connectionStatuses={connectionStatuses}
              onDismiss={handleStartupDismiss}
              onGoOffline={handleStartupGoOffline}
            />

            {/* Not signed in while the cloud needs an account: non-blocking */}
            {!offlineMode && <SyncSignInBanner syncStatus={syncStatus} compact={currentPage === 'scoreboard'} />}

          </div>
        </>
      )}

      {/* Manage console (admins and competition managers), full screen */}
      {manageTab && !matchId && (
        <ManageConsole tab={manageTab} onTab={setManageTab} onClose={() => setManageTab(null)} headerActions={<ManagerSiteLink />} />
      )}
    </div>
  )
}
